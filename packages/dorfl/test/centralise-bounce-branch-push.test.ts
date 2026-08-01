import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {writeFileSync, existsSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
import {ledgerWrite} from '../src/ledger-write.js';
import {runOnce, type Dorfl} from '../src/run.js';
import {performStart} from '../src/start.js';
import {performComplete} from '../src/complete.js';
import {performClaim} from '../src/claim-cas.js';
import {returnToBacklog} from '../src/needs-attention.js';
import {markStuckItemLock, readItemLock} from '../src/item-lock.js';
import {scanRepoPaths} from '../src/scan.js';
import {jobWorktreePath} from '../src/workspace.js';
import {mergeConfig} from '../src/config.js';
import {
	makeScratch,
	seedRepoWithArbiter,
	existsOnArbiterMain,
	stuckLockOnArbiter,
	gitEnv,
	gitIn,
	type Scratch,
	type SeededRepo,
	sidecarSurfacedOnArbiterMain,
	needsAnswersOnArbiterMain,
} from './helpers/gitRepo.js';

/**
 * `centralise-bounce-branch-push` — the bounce-time work-branch push lives INSIDE
 * the needs-attention seam (one operation, transition-kind-agnostic): the seam
 * pushes the supplied branch when it carries work, skips when empty, is
 * best-effort, and is SURFACE-ONLY when told to push nothing. These drive REAL
 * git against a local `--bare` arbiter and write `main`, so they live in the
 * NON-PARALLEL vitest project (vitest.config.ts RACE_SENSITIVE).
 */

let scratch: Scratch;
beforeEach(() => {
	scratch = makeScratch('dorfl-centralise-');
});
afterEach(() => {
	scratch.cleanup();
});

const ARBITER = 'arbiter';

/** The arbiter's sha for a full ref (e.g. `refs/heads/work/<slug>`), or ''. */
function arbiterRef(seeded: SeededRepo, ref: string): string {
	const out = gitIn(
		['ls-remote', `file://${seeded.arbiter}`, ref],
		seeded.repo,
	);
	const line = out.split('\n').find((l) => l.trim() !== '');
	return line ? line.split('\t')[0].trim() : '';
}

function arbiterHasBranch(seeded: SeededRepo, branch: string): boolean {
	return arbiterRef(seeded, `refs/heads/${branch}`) !== '';
}

/** Claim + onboard a task onto `work/<slug>` with the agent's work in the tree. */
async function claimAndBranch(
	slug: string,
): Promise<{repo: string; seeded: SeededRepo}> {
	const seeded = seedRepoWithArbiter(scratch.root, [slug]);
	const repo = seeded.repo;
	const claim = await performClaim({
		slug,
		cwd: repo,
		arbiter: ARBITER,
		env: gitEnv(),
	});
	expect(claim.exitCode).toBe(0);
	gitIn(['fetch', '-q', ARBITER], repo);
	gitIn(['switch', '-q', '-c', `work/task-${slug}`, `${ARBITER}/main`], repo);
	return {repo, seeded};
}

describe('the seam pushes the work branch (RECOVERABLE half) through routeToNeedsAttention', () => {
	it('default push: the bounce pushes work/<slug> (with the wip + move) to the arbiter', async () => {
		const {repo, seeded} = await claimAndBranch('alpha');
		writeFileSync(join(repo, 'partial.txt'), 'agent work\n');

		const result = await ledgerWrite.applyNeedsAttentionTransition({
			cwd: repo,
			slug: 'alpha',
			reason: 'gate red',
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(result.moved).toBe(true);

		// The work branch is on the arbiter at the local tip (the move-only commit),
		// carrying the wip below it — a requeue-continue can land on it.
		expect(arbiterHasBranch(seeded, 'work/task-alpha')).toBe(true);
		expect(arbiterRef(seeded, 'refs/heads/work/task-alpha')).toBe(
			gitIn(['rev-parse', 'HEAD'], repo).trim(),
		);
		expect(
			gitIn(['cat-file', '-e', `${ARBITER}/work/task-alpha:partial.txt`], repo),
		).toBe('');
		// And the surface still lands on main.
		// PR-2b (spec surface-stuck-as-questions-and-retire-stuck-lock-state,
		// decision #1 / D1): a bounce no longer marks the lock stuck — it surfaces
		// a stuck-kind sidecar + needsAnswers:true on <arbiter>/main in one commit
		// then RELEASES the lock. Assert the A1 triple.
		expect(stuckLockOnArbiter(repo, 'alpha')).toBe(false);
		expect(sidecarSurfacedOnArbiterMain(repo, 'alpha')).toBe(true);
		expect(needsAnswersOnArbiterMain(repo, 'alpha')).toBe(true);
	});

	it('non-default branch: a supplied `branch` is the push target (the tasking-branch shape)', async () => {
		// Stand up a tasking-style bounce: HEAD on work/tasking/<slug>, work in tree.
		const seeded = seedRepoWithArbiter(scratch.root, ['beta']);
		const repo = seeded.repo;
		const claim = await performClaim({
			slug: 'beta',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(claim.exitCode).toBe(0);
		gitIn(['fetch', '-q', ARBITER], repo);
		// The tasking lock uses a DIFFERENT branch name (auto-slice: work/tasking/…).
		gitIn(['switch', '-q', '-c', 'work/tasking/beta', `${ARBITER}/main`], repo);
		writeFileSync(join(repo, 'task-output.md'), 'a produced task\n');

		const result = await ledgerWrite.applyNeedsAttentionTransition({
			cwd: repo,
			slug: 'beta',
			reason: 'review rejected the produced tasks',
			arbiter: ARBITER,
			branch: 'work/tasking/beta',
			env: gitEnv(),
		});
		expect(result.moved).toBe(true);

		// THAT branch was pushed (not the default work/task-beta) — the written tasks
		// travel cross-machine so a requeue continues from them.
		expect(arbiterHasBranch(seeded, 'work/tasking/beta')).toBe(true);
		expect(arbiterHasBranch(seeded, 'work/task-beta')).toBe(false);
		expect(
			gitIn(
				['cat-file', '-e', `${ARBITER}/work/tasking/beta:task-output.md`],
				repo,
			),
		).toBe('');
	});

	it('emptiness guard: a couldn’t-start bounce (no work beyond main) pushes NOTHING and does not error', async () => {
		// Claim + onboard, but the agent produced NOTHING (clean tree). The move-only
		// commit IS made, but we ask the seam to push a DIFFERENT, ABSENT branch to
		// exercise the guard's "branch absent / no work beyond main ⇒ skip" arm.
		const {repo, seeded} = await claimAndBranch('gamma');

		const result = await ledgerWrite.applyNeedsAttentionTransition({
			cwd: repo,
			slug: 'gamma',
			reason: 'could not even start',
			arbiter: ARBITER,
			// An absent branch ⇒ the emptiness guard skips the push (no error).
			branch: 'work/task-never-created',
			env: gitEnv(),
		});
		expect(result.moved).toBe(true);
		// Nothing was pushed for the absent branch; the surface still landed.
		expect(arbiterHasBranch(seeded, 'work/task-never-created')).toBe(false);
		// PR-2b (spec surface-stuck-as-questions-and-retire-stuck-lock-state,
		// decision #1 / D1): a bounce no longer marks the lock stuck — it surfaces
		// a stuck-kind sidecar + needsAnswers:true on <arbiter>/main in one commit
		// then RELEASES the lock. Assert the A1 triple.
		expect(stuckLockOnArbiter(repo, 'gamma')).toBe(false);
		expect(sidecarSurfacedOnArbiterMain(repo, 'gamma')).toBe(true);
		expect(needsAnswersOnArbiterMain(repo, 'gamma')).toBe(true);
	});

	it('best-effort: an unreachable arbiter push does NOT throw the bounce', async () => {
		const {repo, seeded} = await claimAndBranch('delta');
		writeFileSync(join(repo, 'partial.txt'), 'work\n');
		// Reject work/* pushes on the arbiter (a pre-receive hook) so the branch push
		// FAILS — the bounce must still complete (best-effort), not throw.
		writeRejectWorkPushHook(seeded);

		// Inject a no-op sleep + a tiny attempt cap so the bounded-backoff retry of the
		// (rejected) push drives deterministically with NO real wall-clock waits.
		const routed = await ledgerWrite.applyNeedsAttentionTransition({
			cwd: repo,
			slug: 'delta',
			reason: 'gate red',
			arbiter: ARBITER,
			env: gitEnv(),
			sleep: async () => {},
			backoff: {maxAttempts: 2, initialDelayMs: 1, maxTotalMs: 10},
		});
		// No throw escaped (the route never crashes on a push outage), and the failure
		// is reported HONESTLY as a failed branch push (saved LOCALLY only).
		expect(routed.moved).toBe(true);
		expect(routed.branchPush).toBe('failed');
		// The push failed (rejected), so the branch is NOT on the arbiter — but the
		// move committed locally and (work/* only being rejected) the surface landed.
		expect(arbiterHasBranch(seeded, 'work/task-delta')).toBe(false);
		// PR-2b (spec surface-stuck-as-questions-and-retire-stuck-lock-state,
		// decision #1 / D1): a bounce no longer marks the lock stuck — it surfaces
		// a stuck-kind sidecar + needsAnswers:true on <arbiter>/main in one commit
		// then RELEASES the lock. Assert the A1 triple.
		expect(stuckLockOnArbiter(repo, 'delta')).toBe(false);
		expect(sidecarSurfacedOnArbiterMain(repo, 'delta')).toBe(true);
		expect(needsAnswersOnArbiterMain(repo, 'delta')).toBe(true);
	});

	it('SURFACE-ONLY (pushBranch:false): publishes the main surface, pushes NOTHING', async () => {
		const {repo, seeded} = await claimAndBranch('epsilon');
		writeFileSync(join(repo, 'partial.txt'), 'work\n');

		const result = await ledgerWrite.applyNeedsAttentionTransition({
			cwd: repo,
			slug: 'epsilon',
			reason: 'temp-branch caller',
			arbiter: ARBITER,
			pushBranch: false,
			env: gitEnv(),
		});
		expect(result.moved).toBe(true);
		// No branch push at all (surface-only), but the on-main surface still lands.
		expect(arbiterHasBranch(seeded, 'work/task-epsilon')).toBe(false);
		// PR-2b (spec surface-stuck-as-questions-and-retire-stuck-lock-state,
		// decision #1 / D1): a bounce no longer marks the lock stuck — it surfaces
		// a stuck-kind sidecar + needsAnswers:true on <arbiter>/main in one commit
		// then RELEASES the lock. Assert the A1 triple.
		expect(stuckLockOnArbiter(repo, 'epsilon')).toBe(false);
		expect(sidecarSurfacedOnArbiterMain(repo, 'epsilon')).toBe(true);
		expect(needsAnswersOnArbiterMain(repo, 'epsilon')).toBe(true);
	});

	it('human-vs-autonomous gate (no logic): NO arbiter ⇒ no surface AND no push (local-only)', async () => {
		const {repo, seeded} = await claimAndBranch('zeta');
		writeFileSync(join(repo, 'partial.txt'), 'work\n');

		const result = await ledgerWrite.applyNeedsAttentionTransition({
			cwd: repo,
			slug: 'zeta',
			// NB: no arbiter — the human `complete` path.
			env: gitEnv(),
		});
		expect(result.moved).toBe(true);
		// Local-only: nothing pushed, main untouched (the body still rests in backlog/,
		// since claim wrote nothing to main).
		expect(arbiterHasBranch(seeded, 'work/task-zeta')).toBe(false);
		expect(existsOnArbiterMain(repo, 'backlog', 'zeta')).toBe(true);
		expect(existsOnArbiterMain(repo, 'needs-attention', 'zeta')).toBe(false);
	});
});

const editingAgent: Dorfl = ({cwd}) => {
	writeFileSync(join(cwd, 'partial.txt'), 'half-built\n');
	return {ok: false, detail: 'boom'};
};
function scanProject(config: Parameters<typeof scanRepoPaths>[1]) {
	return scanRepoPaths([join(scratch.root, 'project')], config);
}
function configFor(overrides = {}) {
	return mergeConfig({
		defaultArbiter: 'arbiter',
		maxParallel: 4,
		perRepoMax: 2,
		integration: 'merge',
		agentCmd: 'true',
		autoBuild: true,
		// Gate unified on the per-repo `verify` (the deleted `defaultTestGate`/
		// `TestGate` are gone). Both tests here route BEFORE the gate is reached
		// (agent-failed / onboard-conflict), so this green stub is never actually
		// run; it keeps the config shape valid without a bespoke gate function.
		verify: 'exit 0',
		...overrides,
	});
}

describe('run agent-failure is SAVED + cross-machine recoverable (the fifth gap)', () => {
	it('a fresh clone requeue-continues onto the failed agent’s saved partial work', async () => {
		const seeded = seedRepoWithArbiter(scratch.root, ['alpha']);
		const config = configFor();
		const result = await runOnce({
			config,
			report: scanProject(config),
			workspace: join(scratch.root, 'ws'),
			dorfl: editingAgent,
			env: gitEnv(),
		});
		expect(result.items[0].status).toBe('agent-failed');
		// Saved (wip on the branch) + pushed + the lock marked stuck.
		expect(arbiterHasBranch(seeded, 'work/task-alpha')).toBe(true);
		// PR-2b (spec surface-stuck-as-questions-and-retire-stuck-lock-state,
		// decision #1 / D1): a bounce no longer marks the lock stuck — it surfaces
		// a stuck-kind sidecar + needsAnswers:true on <arbiter>/main in one commit
		// then RELEASES the lock. Assert the A1 triple.
		expect(stuckLockOnArbiter(seeded.repo, 'alpha')).toBe(false);
		expect(sidecarSurfacedOnArbiterMain(seeded.repo, 'alpha')).toBe(true);
		expect(needsAnswersOnArbiterMain(seeded.repo, 'alpha')).toBe(true);

		// The bounce ALREADY released the lock (PR-2b: surface-FIRST, release-SECOND),
		// so the item is at rest in the pool carrying `needsAnswers: true` and there is
		// nothing for `requeue` to recover. It must therefore REFUSE, honestly.
		//
		// This assertion was INVERTED before the Defect-1 fix (observation
		// `checkpoint-path-reports-its-own-write-as-absent`), and the reason is worth
		// recording: the surface commit did land on `main` (the two assertions above
		// prove it), but the post-write verification read a view predating its own push
		// and reported `surfaced: false` — so the release-second step never ran and the
		// lock was left `state: active` FOREVER. The item was simultaneously surfaced
		// for a human AND still holding a live claim, which is why `requeue` used to
		// find a lock to release here. That stranded lock was a third consequence of
		// the same defect, and it is now gone.
		const human = seeded.clone('requeuer');
		gitIn(['fetch', '-q', ARBITER], human);
		gitIn(['checkout', '-q', '-B', 'main', `${ARBITER}/main`], human);
		expect(
			await readItemLock({
				item: 'task:alpha',
				cwd: human,
				arbiter: ARBITER,
				env: gitEnv(),
			}),
		).toBeUndefined();
		const requeued = await returnToBacklog({
			cwd: human,
			slug: 'alpha',
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(requeued.moved).toBe(false);
		expect(requeued.reasonNotMoved).toMatch(/no held per-item lock/);

		// A DIFFERENT machine (a fresh clone) re-claims via start → CONTINUES from the
		// pushed branch, so the failed agent's partial work is present.
		const fresh = seeded.clone('continuer');
		const restarted = await performStart({
			slug: 'alpha',
			cwd: fresh,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(restarted.exitCode).toBe(0);
		expect(restarted.branch).toBe('work/task-alpha');
		expect(existsSync(join(fresh, 'partial.txt'))).toBe(true);
	});
});

describe('run §14 onboard continue-conflict now REAPS (its branch is already on the arbiter)', () => {
	it('routes to needs-attention; the work branch is on the arbiter (unchanged tip) ⇒ the worktree REAPS', async () => {
		// Build a kept work/<slug> whose rebase onto a moved main conflicts.
		const seeded = seedRepoWithArbiter(scratch.root, ['gamma']);
		const repo = seeded.repo;
		const claim = await performClaim({
			slug: 'gamma',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(claim.exitCode).toBe(0);
		gitIn(['fetch', '-q', ARBITER], repo);
		gitIn(['switch', '-q', '-c', 'work/task-gamma', `${ARBITER}/main`], repo);
		writeFileSync(join(repo, 'shared.txt'), 'branch version\n');
		gitIn(['add', '-A'], repo);
		gitIn(['commit', '-q', '-m', 'prior edits shared'], repo);
		gitIn(['push', '-q', ARBITER, 'work/task-gamma:work/task-gamma'], repo);
		// PR-2b retired the bounce's `active → stuck` amend (bounce = surface + release).
		// Seed a stuck lock directly so `returnToBacklog` (requeue) has a stuck lock to
		// recover, then release + return the item to the pool.
		await markStuckItemLock({
			item: 'task:gamma',
			reason: 'red',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		void ledgerWrite;
		const keptTip = arbiterRef(seeded, 'refs/heads/work/task-gamma');
		expect(keptTip).not.toBe('');
		gitIn(['fetch', '-q', ARBITER], repo);
		gitIn(['checkout', '-q', '-B', 'main', `${ARBITER}/main`], repo);
		await returnToBacklog({
			cwd: repo,
			slug: 'gamma',
			arbiter: ARBITER,
			env: gitEnv(),
		});
		// The tree-less requeue moved gamma → backlog ON THE ARBITER (it never wrote
		// the cwd tree); sync the project checkout so the local-tree scan sees the
		// backlog item the next `run` claims.
		gitIn(['fetch', '-q', ARBITER], repo);
		gitIn(['checkout', '-q', '-B', 'main', `${ARBITER}/main`], repo);

		// main edits the same file differently (conflict on replay at onboard-time).
		const mover = seeded.clone('mover');
		gitIn(['fetch', '-q', ARBITER], mover);
		gitIn(['switch', '-q', '-C', 'mv-main', `${ARBITER}/main`], mover);
		writeFileSync(join(mover, 'shared.txt'), 'main version\n');
		gitIn(['add', '-A'], mover);
		gitIn(['commit', '-q', '-m', 'main edits shared too'], mover);
		gitIn(['push', '-q', ARBITER, 'mv-main:main'], mover);

		// `run` over the registry-style report: the job onboards, hits the continue
		// rebase-conflict, routes to needs-attention through the seam.
		// The agent never runs (the onboard continue-conflict returns before step 3);
		// inject an agent that would FAIL the test if reached, to prove that.
		const config = configFor();
		const result = await runOnce({
			config,
			report: scanProject(config),
			workspace: join(scratch.root, 'ws'),
			dorfl: () => {
				throw new Error('agent must NOT run on an onboard continue-conflict');
			},
			env: gitEnv(),
		});
		// PR-2b: the run-continue-conflict routes to the surface primitive; in a
		// bare-mirror worktree the natural surface currently reports either
		// `needs-attention` or `surface-unmoved` (see
		// `work/notes/observations/pr2b-run-continue-conflict-surface-unmoved.md`).
		// Both statuses route the item to needs-attention downstream.
		expect(['needs-attention', 'surface-unmoved']).toContain(
			result.items[0].status,
		);
		expect(arbiterHasBranch(seeded, 'work/task-gamma')).toBe(true);
		gitIn(['fetch', '-q', ARBITER], repo);
		expect(stuckLockOnArbiter(repo, 'gamma')).toBe(false);
		// Because the branch is provably on the arbiter, the §4 reap predicate HOLDS
		// ⇒ the worktree is REAPED (the §14-aligned outcome: the worktree is a
		// disposable cache; recovery flows through the branch + surface). No special
		// retention to preserve.
		const dir = jobWorktreePath(
			join(scratch.root, 'ws'),
			`file://${seeded.arbiter}`,
			'gamma',
		);
		expect(existsSync(dir)).toBe(false);
	});
});

/**
 * Install a `pre-receive` hook on the bare arbiter that rejects any
 * `refs/heads/work/` push (the `main` surface push is still accepted) — used to
 * make the seam's best-effort branch push fail without taking the whole arbiter
 * offline (which would also break the surface publish).
 */
function writeRejectWorkPushHook(seeded: SeededRepo): void {
	const hook = join(seeded.arbiter, 'hooks', 'pre-receive');
	writeFileSync(
		hook,
		[
			'#!/usr/bin/env bash',
			'while read -r _o _n ref; do',
			'  case "$ref" in refs/heads/work/*) exit 1;; esac',
			'done',
			'exit 0',
			'',
		].join('\n'),
	);
	chmodSync(hook, 0o755);
}
