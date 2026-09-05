import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {performComplete} from '../src/complete.js';
import {performClaim} from '../src/claim-cas.js';
import {
	acquireItemLock,
	itemLockRef,
	listItemLockEntries,
	reconcileTerminalItemLocks,
} from '../src/item-lock.js';
import {resolveCwdSection} from '../src/cwd-section.js';
import {status, formatStatus} from '../src/status.js';
import {run} from '../src/git.js';
import {
	makeScratch,
	seedRepoWithArbiter,
	existsOnArbiterMain,
	gitEnv,
	gitIn,
	type Scratch,
	fixtureFolderRel,
	rmrf,
	registerMirrorWithWork,
	mirrorSrc,
} from './helpers/gitRepo.js';
import {mergeConfig} from '../src/config.js';

const ARBITER = 'arbiter';
const PASS = 'exit 0';

let scratch: Scratch;
beforeEach(() => {
	scratch = makeScratch('dorfl-propose-merge-reconcile-');
});
afterEach(() => {
	scratch.cleanup();
});

function config() {
	return mergeConfig({
		workspacesDir: join(scratch.root, '.dorfl'),
		autoBuild: true,
	});
}

/** Does the arbiter currently HOLD the per-item lock ref for `entry`? */
function lockRefOnArbiter(arbiter: string, entry: string): boolean {
	const r = run(
		'git',
		['ls-remote', `file://${arbiter}`, itemLockRef(entry)],
		scratch.root,
		{env: gitEnv()},
	);
	return r.status === 0 && r.stdout.trim() !== '';
}

/** Claim `slug` and put the human on the work branch (the pre-`complete` state).
 * `others` seed additional tasks that stay in the ready pool, a repo always has
 * other work, and it keeps the checkout a PARTICIPATING repo (the cwd section's
 * fetch-free pre-gate reads the pools in the WORKING TREE) once `slug` itself has
 * moved on to `done`. */
async function claimAndBranch(slug: string, others: string[] = []) {
	const seeded = seedRepoWithArbiter(scratch.root, [slug, ...others]);
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
	return {seeded, repo, arbiter: seeded.arbiter};
}

/**
 * Simulate THE EVENT DORFL CANNOT OBSERVE: a human squash-merges the propose PR
 * on GitHub. The net effect on the arbiter's `main` is exactly the done-move the
 * PR branch carried, the body leaves the ready pool and comes to rest in its
 * TERMINAL folder (`work/tasks/done/<slug>.md`). No dorfl process runs at this
 * moment, which is precisely why the deferred lock release never fired.
 */
function mergeProposePR(arbiter: string, slug: string): void {
	const dest = join(scratch.root, `merge-pr-${slug}`);
	const env = gitEnv();
	run('git', ['clone', '-q', `file://${arbiter}`, dest], scratch.root, {env});
	run('git', ['checkout', '-q', '-B', `merge/${slug}`, 'origin/main'], dest, {
		env,
	});
	const from = join('work', fixtureFolderRel('backlog'), `${slug}.md`);
	const to = join('work', fixtureFolderRel('done'), `${slug}.md`);
	mkdirSync(join(dest, 'work', fixtureFolderRel('done')), {recursive: true});
	const mv = run('git', ['mv', from, to], dest, {env});
	expect(mv.status).toBe(0);
	run('git', ['commit', '-q', '-m', `merge PR: ${slug} -> done`], dest, {env});
	run('git', ['push', '-q', 'origin', `merge/${slug}:main`], dest, {env});
	rmrf(dest);
}

/** Drive a task through claim → propose-complete, leaving the PR open and the
 * per-item lock DELIBERATELY held (the documented propose behaviour). */
async function proposeAndKeepLockHeld(slug: string, others: string[] = []) {
	const {repo, arbiter} = await claimAndBranch(slug, others);
	writeFileSync(join(repo, `${slug}.txt`), 'the work\n');
	const result = await performComplete({
		slug,
		cwd: repo,
		arbiter: ARBITER,
		integration: 'propose',
		noPR: true,
		noSwitch: true,
		verify: PASS,
		env: gitEnv(),
	});
	expect(result.exitCode).toBe(0);
	expect(result.outcome).toBe('completed');
	// The precondition this whole bug rests on: propose keeps the lock HELD, and
	// the body still rests in the ready pool on `main`.
	expect(lockRefOnArbiter(arbiter, `task-${slug}`)).toBe(true);
	expect(existsOnArbiterMain(repo, 'done', slug)).toBe(false);
	return {repo, arbiter};
}

/** Put the checkout back where an operator's repo actually sits between runs: on
 * `main`, synced to the arbiter. This is the state `status` is run from. */
function backToMain(repo: string): void {
	gitIn(['fetch', '-q', ARBITER], repo);
	gitIn(['switch', '-q', '-C', 'main', `${ARBITER}/main`], repo);
}

/**
 * REGRESSION for the propose-path lock leak (observation
 * `every-completed-task-leaves-its-lock-ref-reporting-in-progress`): a completed,
 * MERGED, propose-mode item must stop reporting as in-progress.
 *
 * `complete --propose` deliberately keeps the per-item lock HELD and promises
 * "It is released when the PR merges (reconciled against main)". Nothing ever
 * performed that reconciliation on an ordinary path: `reconcileItemLockAgainstMain`
 * existed but was reachable ONLY from the opt-in `gc --ledger --reap-stale-locks`
 * sweep, so every propose build leaked its lock ref forever (26 of them on the
 * etherfold arbiter, every one naming a task resting in `tasks/done/`).
 */
describe('propose + merged PR, the held lock reconciles against main on READ', () => {
	it('releases the lock once the merged item is TERMINAL on main (the leak this fixes)', async () => {
		const {repo, arbiter} = await proposeAndKeepLockHeld('alpha');

		// The human merges the PR on GitHub. No dorfl process observes this.
		mergeProposePR(arbiter, 'alpha');
		expect(existsOnArbiterMain(repo, 'done', 'alpha')).toBe(true);
		// BEFORE reconciliation the lock is still held, this is the leak.
		expect(lockRefOnArbiter(arbiter, 'task-alpha')).toBe(true);

		const rec = await reconcileTerminalItemLocks(repo, ARBITER, gitEnv());

		expect(rec.released).toEqual(['task-alpha']);
		expect(rec.kept).toEqual([]);
		// THE FIX: the ref is GONE on the arbiter.
		expect(lockRefOnArbiter(arbiter, 'task-alpha')).toBe(false);
		// ...and the item no longer reports in-flight.
		const entries = await listItemLockEntries(repo, ARBITER, gitEnv());
		expect(entries.map((e) => e.entry)).not.toContain('task-alpha');
	});

	it('KEEPS the lock of an item whose body is still in the ready pool (open PR = in flight)', async () => {
		// THE NEGATIVE ASSERTION, and the invariant that must never be relaxed:
		// releasing a lock whose item is NOT terminal would let two claimants build
		// the same item. An open propose PR is exactly this case, the done-move
		// lives on the PR branch, `main` still shows the body in the pool.
		const {repo, arbiter} = await proposeAndKeepLockHeld('beta');

		const rec = await reconcileTerminalItemLocks(repo, ARBITER, gitEnv());

		expect(rec.released).toEqual([]);
		expect(rec.kept).toEqual(['task-beta']);
		expect(lockRefOnArbiter(arbiter, 'task-beta')).toBe(true);
		const entries = await listItemLockEntries(repo, ARBITER, gitEnv());
		expect(entries.map((e) => e.entry)).toContain('task-beta');
	});

	it('reconciles the MERGED one and keeps the IN-FLIGHT one in the same sweep', async () => {
		// The real corpus shape: many locks, mixed. The sweep must be per-item, not
		// all-or-nothing.
		const seeded = seedRepoWithArbiter(scratch.root, ['merged', 'inflight']);
		const {repo, arbiter} = seeded;
		for (const slug of ['merged', 'inflight']) {
			const claim = await performClaim({
				slug,
				cwd: repo,
				arbiter: ARBITER,
				env: gitEnv(),
			});
			expect(claim.exitCode).toBe(0);
		}
		expect(lockRefOnArbiter(arbiter, 'task-merged')).toBe(true);
		expect(lockRefOnArbiter(arbiter, 'task-inflight')).toBe(true);

		mergeProposePR(arbiter, 'merged');

		const rec = await reconcileTerminalItemLocks(repo, ARBITER, gitEnv());

		expect(rec.released).toEqual(['task-merged']);
		expect(rec.kept).toEqual(['task-inflight']);
		expect(lockRefOnArbiter(arbiter, 'task-merged')).toBe(false);
		expect(lockRefOnArbiter(arbiter, 'task-inflight')).toBe(true);
	});

	it('is idempotent, a second reconcile over an already-reconciled arbiter is a clean no-op', async () => {
		const {repo, arbiter} = await proposeAndKeepLockHeld('gamma');
		mergeProposePR(arbiter, 'gamma');

		const first = await reconcileTerminalItemLocks(repo, ARBITER, gitEnv());
		expect(first.released).toEqual(['task-gamma']);

		const second = await reconcileTerminalItemLocks(repo, ARBITER, gitEnv());
		expect(second.released).toEqual([]);
		expect(second.kept).toEqual([]);
		expect(second.errors).toEqual([]);
		expect(lockRefOnArbiter(arbiter, 'task-gamma')).toBe(false);
	});
});

describe('status, READ-ONLY: it reclassifies merged work, and writes only under --reconcile-locks', () => {
	it('`status` stops listing a merged propose item under "In progress", WITHOUT touching the arbiter', async () => {
		// THE USER-VISIBLE SYMPTOM was that `dorfl status` reported every finished task
		// as in-progress for ever. Fixing the REPORT does not require `status` to
		// mutate anything: `status` is documented read-only and stays so. It
		// reclassifies the lock as finished work, and leaves the ref alone.
		const {repo, arbiter} = await proposeAndKeepLockHeld('delta', ['keeper']);
		mergeProposePR(arbiter, 'delta');
		backToMain(repo);

		const section = await resolveCwdSection({
			cwd: repo,
			config: config(),
			arbiterRemote: ARBITER,
			lockArbiterRemote: ARBITER,
			env: gitEnv(),
		});

		// No longer reported in flight, the symptom is fixed...
		expect(section.repo?.lockHeld ?? []).toEqual([]);
		expect(section.staleLocks).toEqual(['task-delta']);
		// ...and NOTHING was written: the ref is still on the arbiter.
		expect(lockRefOnArbiter(arbiter, 'task-delta')).toBe(true);
		expect(section.reconciledLocks ?? []).toEqual([]);
	});

	it('`status --reconcile-locks` DOES release it (the explicit opt-in write)', async () => {
		const {repo, arbiter} = await proposeAndKeepLockHeld('zeta', ['keeper']);
		mergeProposePR(arbiter, 'zeta');
		backToMain(repo);

		const section = await resolveCwdSection({
			cwd: repo,
			config: config(),
			arbiterRemote: ARBITER,
			lockArbiterRemote: ARBITER,
			reconcileLocks: true,
			env: gitEnv(),
		});

		expect(lockRefOnArbiter(arbiter, 'task-zeta')).toBe(false);
		expect(section.reconciledLocks).toEqual(['task-zeta']);
		expect(section.repo?.lockHeld ?? []).toEqual([]);
	});

	it('`status --reconcile-locks` still REFUSES to release a non-terminal item', async () => {
		// The invariant survives the opt-in: the flag authorises the sweep, it does
		// NOT widen what counts as releasable.
		const {repo, arbiter} = await proposeAndKeepLockHeld('eta', ['keeper']);
		backToMain(repo);

		const section = await resolveCwdSection({
			cwd: repo,
			config: config(),
			arbiterRemote: ARBITER,
			lockArbiterRemote: ARBITER,
			reconcileLocks: true,
			env: gitEnv(),
		});

		expect(lockRefOnArbiter(arbiter, 'task-eta')).toBe(true);
		expect(section.reconciledLocks ?? []).toEqual([]);
		expect(section.repo?.lockHeld?.map((e) => e.entry)).toEqual(['task-eta']);
	});

	it('`status` still reports a genuinely in-flight item as in-progress', async () => {
		const {repo, arbiter} = await proposeAndKeepLockHeld('epsilon', ['keeper']);
		backToMain(repo);

		const section = await resolveCwdSection({
			cwd: repo,
			config: config(),
			arbiterRemote: ARBITER,
			lockArbiterRemote: ARBITER,
			env: gitEnv(),
		});

		expect(lockRefOnArbiter(arbiter, 'task-epsilon')).toBe(true);
		expect(section.repo?.lockHeld?.map((e) => e.entry)).toEqual([
			'task-epsilon',
		]);
		expect(section.staleLocks ?? []).toEqual([]);
		expect(section.reconciledLocks ?? []).toEqual([]);
	});
});

describe('the CLAIM path drains the leaked locks automatically (no flag, no verb)', () => {
	it('a later claim releases an EARLIER merged item\u2019s stale lock', async () => {
		// THE ACTUAL FIX. The release has to be automatic on a command that really
		// runs, and `claim` is a write path that already fetches `main` and already
		// mutates the arbiter, on every unit of work. So the leaked set drains as a
		// side effect of ordinary use, no human is ever asked to run a clean-up verb,
		// which is what failed before (`gc --ledger` had been printing the
		// `release-lock` command all along and nobody was routed to it).
		const {repo, arbiter} = await proposeAndKeepLockHeld('theta', ['next']);
		mergeProposePR(arbiter, 'theta');
		backToMain(repo);
		expect(lockRefOnArbiter(arbiter, 'task-theta')).toBe(true);

		// Ordinary next unit of work, an UNRELATED item.
		const claim = await performClaim({
			slug: 'next',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(claim.exitCode).toBe(0);

		// The earlier item's stale lock is gone...
		expect(lockRefOnArbiter(arbiter, 'task-theta')).toBe(false);
		// ...and the lock this claim just took is untouched.
		expect(lockRefOnArbiter(arbiter, 'task-next')).toBe(true);
	});

	it('a claim does NOT release an in-flight peer\u2019s lock', async () => {
		const seeded = seedRepoWithArbiter(scratch.root, ['mine', 'peer']);
		const {repo, arbiter} = seeded;
		// A peer holds `peer`, still in the pool on main (a live build).
		expect(
			(
				await performClaim({
					slug: 'peer',
					cwd: repo,
					arbiter: ARBITER,
					env: gitEnv(),
				})
			).exitCode,
		).toBe(0);

		expect(
			(
				await performClaim({
					slug: 'mine',
					cwd: repo,
					arbiter: ARBITER,
					env: gitEnv(),
				})
			).exitCode,
		).toBe(0);

		// The peer's lock MUST survive, releasing it would let two claimants build
		// the same item, the failure this fix must never introduce.
		expect(lockRefOnArbiter(arbiter, 'task-peer')).toBe(true);
		expect(lockRefOnArbiter(arbiter, 'task-mine')).toBe(true);
	});
});

/**
 * REGRESSION for the BARE-MIRROR blind spot found in review. `status`/`scan` read
 * a registered hub mirror, which is a `git clone --bare` with NO
 * `remote.origin.fetch` refspec and therefore NO `refs/remotes/*` namespace at
 * all. Probing `origin/main:<path>` there fails with `invalid object name`, which
 * is indistinguishable from "the item is not terminal" - so every lock classified
 * as in-flight and the whole feature was a silent permanent no-op on exactly the
 * surface the bug was reported from. The mirror's copy of the arbiter's main is
 * the plain `main` ref, which is what every other mirror reader already uses.
 */
describe('registered hub mirrors (bare clones) classify against the right main ref', () => {
	it('reports a merged item as STALE, not in-flight, on the mirror path', async () => {
		const ws = join(scratch.root, '.dorfl');
		// `done` puts the body in its TERMINAL folder on the mirror's main; `backlog`
		// keeps a genuinely in-flight peer alongside it.
		const {mirrorPath} = registerMirrorWithWork(ws, 'project', {
			done: {'merged.md': 'x'},
			backlog: {'live.md': 'y'},
		});
		await seedMirrorLock(ws, 'project', 'merged');
		await seedMirrorLock(ws, 'project', 'live');

		const report = await status({workspacesDir: ws, mirrorPaths: [mirrorPath]});

		// The merged one is STALE (finished work), the live one is still in flight.
		expect(report.staleLocks?.[0]?.entries).toEqual(['task-merged']);
		expect(report.lockHeld?.[0]?.entries.map((e) => e.entry)).toEqual([
			'task-live',
		]);
		// And the human output says so, in its own block, not under "In-flight".
		const out = formatStatus(report);
		expect(out).toMatch(/Completed, lock not yet released/);
		// The merged entry must appear ONLY inside the stale block, i.e. after that
		// header and after the in-flight block that precedes it.
		const inflightAt = out.indexOf('In-flight locks');
		const staleAt = out.indexOf('Completed, lock not yet released');
		const mergedAt = out.indexOf('task-merged');
		expect(inflightAt).toBeGreaterThanOrEqual(0);
		expect(mergedAt).toBeGreaterThan(staleAt);
		// The in-flight block (between its header and the stale header) names only
		// the live item.
		const inflightBlock = out.slice(inflightAt, staleAt);
		expect(inflightBlock).toMatch(/task-live/);
		expect(inflightBlock).not.toMatch(/task-merged/);
	});

	it('a mirror whose ONLY locks are stale still renders them (never "work area is empty")', async () => {
		// Without a renderer the stale entries would be filtered out of the
		// in-flight block and appear NOWHERE, turning a wrong report into a missing
		// one. This pins that they are still surfaced.
		const ws = join(scratch.root, '.dorfl');
		const {mirrorPath} = registerMirrorWithWork(ws, 'solo', {
			done: {'onlymerged.md': 'x'},
		});
		await seedMirrorLock(ws, 'solo', 'onlymerged');

		const report = await status({workspacesDir: ws, mirrorPaths: [mirrorPath]});
		const out = formatStatus(report);

		expect(out).not.toMatch(/work area is empty/);
		expect(out).toMatch(/Completed, lock not yet released/);
		expect(out).toMatch(/task-onlymerged/);
	});

	it('`--reconcile-locks` releases it on the mirror path too', async () => {
		const ws = join(scratch.root, '.dorfl');
		const {mirrorPath, originUrl} = registerMirrorWithWork(ws, 'sweep', {
			done: {'gone.md': 'x'},
			backlog: {'stay.md': 'y'},
		});
		await seedMirrorLock(ws, 'sweep', 'gone');
		await seedMirrorLock(ws, 'sweep', 'stay');

		const report = await status({
			workspacesDir: ws,
			mirrorPaths: [mirrorPath],
			reconcileLocks: true,
		});

		// Released on the real arbiter behind the mirror...
		const refs = run('git', ['ls-remote', originUrl, 'refs/dorfl/lock/*'], ws, {
			env: gitEnv(),
		}).stdout;
		expect(refs).not.toMatch(/task-gone/);
		// ...and the in-flight peer is untouched.
		expect(refs).toMatch(/task-stay/);
		expect(report.lockHeld?.[0]?.entries.map((e) => e.entry)).toEqual([
			'task-stay',
		]);
	});
});

/** Acquire a real per-item lock on the source repo a registered bare mirror was
 * cloned from, so the mirror's `origin` read path sees it. */
async function seedMirrorLock(
	ws: string,
	name: string,
	slug: string,
): Promise<void> {
	const src = mirrorSrc(ws, name);
	const clone = join(scratch.root, `seed-${name}-${slug}`);
	run('git', ['clone', '-q', `file://${src}`, clone], scratch.root, {
		env: gitEnv(),
	});
	run('git', ['remote', 'add', 'arbiter', `file://${src}`], clone, {
		env: gitEnv(),
	});
	const acq = await acquireItemLock({
		item: `task:${slug}`,
		action: 'implement',
		cwd: clone,
		arbiter: 'arbiter',
		env: gitEnv(),
	});
	expect(acq.outcome).toBe('acquired');
}
