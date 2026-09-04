import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {join} from 'node:path';
import {mkdirSync, writeFileSync} from 'node:fs';
import {performTask, type TaskDorfl} from '../src/tasking.js';
import {
	acquireItemLock,
	readItemLock,
	itemLockRef,
	lockEntryFor,
} from '../src/item-lock.js';
import {returnToBacklog} from '../src/needs-attention.js';
import {
	makeScratch,
	seedRepoWithArbiter,
	gitEnv,
	isolatePiAgentDir,
	type Scratch,
} from './helpers/gitRepo.js';
import {run} from '../src/git.js';

/**
 * A crashed `do spec:<slug>` MUST NOT strand its tasking lock (observation
 * `crashed-do-spec-strands-a-tasking-lock-no-verb-releases`).
 *
 * THE FIELD INCIDENT. `do spec:<slug>` takes `refs/dorfl/lock/spec-<slug>`
 * (`action: task`, `state: active`) and then invokes the tasking agent. When that
 * agent died from a model-API fault (`Connection error.`, `overloaded_error`,
 * `api_error` — three times), `performTask` returned `agent-failed` while LEAVING
 * THE LOCK HELD, on the stated grounds that "surfacing it is the review/edit
 * loop's job". That loop lives at step 3.5, strictly AFTER the agent-failure
 * return, so it never ran: the lock outlived every process that knew about it and
 * each retry lost the create-only CAS to a holder that no longer existed.
 *
 * The escalation ladder then dead-ended: `requeue <slug>` resolves the TASK
 * namespace (`task-<slug>`) and answered "no held per-item lock — nothing to
 * requeue"; `gc` (without `--ledger`) reaps worktrees and reported `0 reaped`,
 * because a tasking run that died before integrating leaves no worktree. The
 * operator fell back to `git push origin :refs/dorfl/lock/spec-<slug>`.
 *
 * WHY RELEASING IS SAFE. The tasking work branch is created with a LOCAL `git
 * switch -C` (`switchToWorkBranch`) and is never pushed before the integrate
 * band, and the durable `specs/ready → specs/tasked` move also happens only at
 * integrate. A run that died at the agent step therefore published NOTHING to the
 * arbiter, so releasing its lock discards nothing. The recovery is deliberately no
 * more cautious than that risk warrants: a PLAIN release back into the taskable
 * pool, NOT a `needsAnswers:true` + question-sidecar surface (which is reserved
 * for a review VERDICT — a judgement a human must resolve — and would otherwise
 * turn a retryable transport blip into mandatory human paperwork).
 *
 * These tests assert both halves:
 *   1. FIX (primary): the agent-failure path releases the lock ITSELF, so a
 *      simple re-run of `do spec:<slug>` succeeds with no human step at all.
 *   2. BACKSTOP: when the runner is killed BETWEEN acquire and release (so fix 1
 *      never gets to run), the stranded lock is still releasable through the
 *      existing named verb `release-lock spec:<slug>` — no manual ref surgery —
 *      and the dead-end messages now NAME that verb.
 */

const ARBITER = 'arbiter';

let scratch: Scratch;
let restorePiAgentDir: () => void;
beforeEach(() => {
	scratch = makeScratch('dorfl-tasking-crash-lock-');
	restorePiAgentDir = isolatePiAgentDir(scratch.root);
});
afterEach(() => {
	restorePiAgentDir();
	scratch.cleanup();
});

/** Seed a taskable `work/specs/ready/<slug>.md` onto the arbiter. */
function seedSpec(repo: string, slug: string): void {
	const dir = join(repo, 'work', 'specs', 'ready');
	mkdirSync(dir, {recursive: true});
	writeFileSync(
		join(dir, `${slug}.md`),
		[
			'---',
			`title: ${slug}`,
			`slug: ${slug}`,
			'---',
			'',
			'## Problem Statement',
			'',
			`Spec body for ${slug}.`,
			'',
		].join('\n'),
	);
	run('git', ['add', '-A'], repo, {env: gitEnv()});
	run('git', ['commit', '-q', '-m', `spec: ${slug}`], repo, {env: gitEnv()});
	run('git', ['push', '-q', ARBITER, 'main'], repo, {env: gitEnv()});
}

/** Is the spec lock ref present on the arbiter? (Reads the ARBITER, not a local copy.) */
function specLockOnArbiter(arbiter: string, slug: string): boolean {
	const r = run(
		'git',
		[
			'ls-remote',
			`file://${arbiter}`,
			itemLockRef(lockEntryFor(`spec:${slug}`)),
		],
		scratch.root,
		{env: gitEnv()},
	);
	return r.status === 0 && r.stdout.trim() !== '';
}

/** An agent that CRASHES exactly the way the field incident did (a thrown model-API fault). */
const crashingAgent = (detail = 'Connection error.'): TaskDorfl => {
	return () => {
		throw new Error(detail);
	};
};

/** An agent that reports failure WITHOUT throwing (the `{ok:false}` return shape). */
const failingAgent = (detail = 'overloaded_error'): TaskDorfl => {
	return () => ({ok: false, detail});
};

/** An agent that succeeds, writing one staged task file (no git). */
const workingAgent = (file = 'child'): TaskDorfl => {
	return ({cwd}) => {
		const dir = join(cwd, 'work', 'tasks', 'backlog');
		mkdirSync(dir, {recursive: true});
		writeFileSync(
			join(dir, `${file}.md`),
			[
				'---',
				`title: ${file}`,
				`slug: ${file}`,
				'spec: crashy',
				'---',
				'',
				'## Prompt',
				'',
				'> build it',
				'',
			].join('\n'),
		);
		return {ok: true};
	};
};

describe('a crashed tasking agent RELEASES its own spec lock (fix 2)', () => {
	it('a THROWN model-API fault leaves NO stranded lock on the arbiter', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, []);
		seedSpec(repo, 'crashy');

		const result = await performTask({
			slug: 'crashy',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			explicit: true,
			dorfl: crashingAgent('Connection error.'),
			env: gitEnv(),
		});

		// The agent failure is still reported faithfully — the release does not
		// launder a crash into a success.
		expect(result.exitCode).toBe(1);
		expect(result.outcome).toBe('agent-failed');
		expect(result.message).toMatch(/Connection error\./);

		// ...and the lock it took is GONE from the arbiter, with no human step.
		expect(specLockOnArbiter(arbiter, 'crashy')).toBe(false);
		expect(
			await readItemLock({
				item: 'spec:crashy',
				cwd: repo,
				arbiter: ARBITER,
				env: gitEnv(),
			}),
		).toBeUndefined();
	});

	it('a NON-throwing {ok:false} agent failure also releases the lock', async () => {
		// The two failure shapes converge on the same `!agent.ok` branch; assert the
		// non-throwing one explicitly so a future refactor cannot fix only the throw.
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, []);
		seedSpec(repo, 'crashy');

		const result = await performTask({
			slug: 'crashy',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			explicit: true,
			dorfl: failingAgent('overloaded_error'),
			env: gitEnv(),
		});

		expect(result.outcome).toBe('agent-failed');
		expect(result.message).toMatch(/overloaded_error/);
		expect(specLockOnArbiter(arbiter, 'crashy')).toBe(false);
	});

	it('the failure message TELLS the operator the spec is retryable (no ref surgery)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedSpec(repo, 'crashy');

		const result = await performTask({
			slug: 'crashy',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			explicit: true,
			dorfl: crashingAgent('api_error'),
			env: gitEnv(),
		});

		expect(result.message).toMatch(/[Rr]eleased the tasking lock/);
		expect(result.message).toMatch(/do spec:crashy/);
		// It must NOT send anyone to hand-delete a ref.
		expect(result.message).not.toMatch(/git push .*:refs\/dorfl\/lock/);
	});

	it('THE POINT: a retry after the crash SUCCEEDS instead of losing the CAS', async () => {
		// This is the regression the whole fix exists to prevent: pre-fix, this
		// second `performTask` returned `lock-lost` against a dead holder, three
		// times in the field.
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, []);
		seedSpec(repo, 'crashy');

		const crashed = await performTask({
			slug: 'crashy',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			explicit: true,
			dorfl: crashingAgent(),
			env: gitEnv(),
		});
		expect(crashed.outcome).toBe('agent-failed');

		const retry = await performTask({
			slug: 'crashy',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			explicit: true,
			dorfl: workingAgent(),
			env: gitEnv(),
		});

		expect(retry.outcome).not.toBe('lock-lost');
		expect(retry.message).not.toMatch(/already locked/);
		expect(retry.exitCode).toBe(0);
		expect(retry.outcome).toBe('tasked');
		// NOTE: the retry ends with the lock HELD, and that is CORRECT — not a leak.
		// The default tasking mode is `--propose`, which opens a PR carrying the
		// transition and deliberately KEEPS the hold until that PR merges (releasing
		// at PR-open time is the `propose-tasking-releases-lock-so-spec-is-retasked-
		// and-pr-force-pushed-every-tick` bug). The contrast with the crash path is
		// exactly the point of this fix: a SUCCESSFUL run has published something and
		// keeps its hold; a CRASHED run published nothing and must not.
		expect(specLockOnArbiter(arbiter, 'crashy')).toBe(true);
	});

	it('a crashed tasking run publishes NOTHING, so the release discards nothing', async () => {
		// The safety premise of the plain release, asserted rather than assumed: the
		// spec is still in `specs/ready/` (not moved to `specs/tasked/`) and no
		// `work/spec-<slug>` branch reached the arbiter.
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, []);
		seedSpec(repo, 'crashy');

		await performTask({
			slug: 'crashy',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			explicit: true,
			dorfl: crashingAgent(),
			env: gitEnv(),
		});

		run('git', ['fetch', '-q', ARBITER], repo, {env: gitEnv()});
		const stillReady = run(
			'git',
			['cat-file', '-e', `${ARBITER}/main:work/specs/ready/crashy.md`],
			repo,
			{env: gitEnv()},
		);
		expect(stillReady.status).toBe(0);

		const branches = run(
			'git',
			['ls-remote', `file://${arbiter}`, 'refs/heads/work/*'],
			scratch.root,
			{
				env: gitEnv(),
			},
		);
		expect(branches.stdout.trim()).toBe('');
	});
});

describe('BACKSTOP: a lock stranded by a killed RUNNER is releasable without ref surgery (fix 1)', () => {
	/**
	 * Fix 2 cannot help when the runner itself is killed between acquire and
	 * release. That residual case is covered by the EXISTING named verb
	 * `release-lock spec:<slug>` (CLI) / `releaseItemLock` (API) — which is why we
	 * did NOT fork a second release mechanism into `requeue`. These tests pin that
	 * the backstop genuinely works on a `spec-` entry and that the messages an
	 * operator actually hits now NAME it.
	 */
	it('releaseItemLock clears a stranded spec lock (the `release-lock spec:<slug>` path)', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, []);
		seedSpec(repo, 'orphan');

		// Simulate the killed runner: take the lock exactly as `do spec:` does, then
		// never release it.
		const took = await acquireItemLock({
			item: 'spec:orphan',
			action: 'task',
			cwd: repo,
			arbiter: ARBITER,
			holder: 'dead-runner',
			env: gitEnv(),
		});
		expect(took.outcome).toBe('acquired');
		expect(specLockOnArbiter(arbiter, 'orphan')).toBe(true);

		const {releaseItemLock} = await import('../src/item-lock.js');
		const released = await releaseItemLock({
			item: 'spec:orphan',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});

		expect(released.outcome).toBe('released');
		expect(released.entry).toBe('spec-orphan');
		expect(specLockOnArbiter(arbiter, 'orphan')).toBe(false);
	});

	it('the CONTENTION refusal names the recovery verb instead of dead-ending', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedSpec(repo, 'orphan');

		await acquireItemLock({
			item: 'spec:orphan',
			action: 'task',
			cwd: repo,
			arbiter: ARBITER,
			holder: 'dead-runner',
			env: gitEnv(),
		});
		const second = await acquireItemLock({
			item: 'spec:orphan',
			action: 'task',
			cwd: repo,
			arbiter: ARBITER,
			holder: 'retry',
			env: gitEnv(),
		});

		expect(second.outcome).toBe('lost');
		// Back off stays the DEFAULT (live contention is the common case)...
		expect(second.message).toMatch(/Back off/);
		// ...but the dead-holder escape is now discoverable, copy-pasteable, and
		// conditioned on the operator asserting the holder is dead.
		expect(second.message).toMatch(/dorfl release-lock spec:orphan/);
		expect(second.message).toMatch(/gc --ledger/);
		expect(second.message).toMatch(/DEAD/);
	});

	it('requeue on the bare slug POINTS AT the stranded spec lock instead of denying it exists', async () => {
		// The precise misdirection from the incident: `requeue <slug>` said "no held
		// per-item lock ... wrong slug?" while `refs/dorfl/lock/spec-<slug>` was
		// sitting on the arbiter.
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedSpec(repo, 'orphan');

		await acquireItemLock({
			item: 'spec:orphan',
			action: 'task',
			cwd: repo,
			arbiter: ARBITER,
			holder: 'dead-runner',
			env: gitEnv(),
		});

		const result = await returnToBacklog({
			slug: 'orphan',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});

		expect(result.moved).toBe(false);
		const reason = result.reasonNotMoved ?? '';
		// It still refuses (requeue does not act on specs)...
		expect(reason).toMatch(/no held per-item lock/);
		// ...but it no longer leaves the operator hunting: it names the held spec
		// lock, its holder, and the verb that owns it.
		expect(reason).toMatch(/SPEC lock IS held/);
		expect(reason).toMatch(/refs\/dorfl\/lock\/spec-orphan/);
		expect(reason).toMatch(/dead-runner/);
		expect(reason).toMatch(/dorfl release-lock spec:orphan/);
	});

	it('requeue on a genuinely unknown slug still gives the PLAIN refusal (no phantom hint)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedSpec(repo, 'orphan');

		const result = await returnToBacklog({
			slug: 'nosuchthing',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});

		expect(result.moved).toBe(false);
		const reason = result.reasonNotMoved ?? '';
		expect(reason).toMatch(/no held per-item lock/);
		expect(reason).not.toMatch(/SPEC lock IS held/);
	});
});
