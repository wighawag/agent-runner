import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {join} from 'node:path';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {performTask, type TaskDorfl} from '../src/tasking.js';
import {
	type AcquireTaskingLockResult,
	type ReleaseTaskingLockResult,
} from '../src/tasking-lock.js';
import {readItemLock} from '../src/item-lock.js';
import {
	makeScratch,
	seedRepoWithArbiter,
	gitEnv,
	isolatePiAgentDir,
	type Scratch,
} from './helpers/gitRepo.js';
import {run} from '../src/git.js';
import type {
	TaskReviewGate,
	TaskReviewVerdict,
} from '../src/tasker-review-loop.js';
import {
	ReviewOutputCappedError,
	ReviewParseError,
} from '../src/review-verdict.js';

/**
 * `do prd:<slug>` tasking-path tests (`performTask`, task `autoslice-command`).
 *
 * House style: a throwaway checkout + a local `--bare` arbiter + a STUBBED agent
 * (the injected `dorfl` writes task files directly, never a real harness).
 * The real-git tests drive the lock CAS + write `main`, so this file is in the
 * NON-PARALLEL vitest project (see vitest.config.ts); the gate-refusal tests stub
 * the lock entirely so they stay pure.
 */

const ARBITER = 'arbiter';

let scratch: Scratch;
let restorePiAgentDir: () => void;
beforeEach(() => {
	scratch = makeScratch('dorfl-tasking-');
	// Test-isolation (shared-write rule): point pi's session storage at scratch so
	// no task-file/session write touches the real ~/.pi/agent/sessions/.
	restorePiAgentDir = isolatePiAgentDir(scratch.root);
});
afterEach(() => {
	restorePiAgentDir();
	scratch.cleanup();
});

/** Seed a `work/specs/ready/<slug>.md` (committed onto the arbiter) with frontmatter. */
function seedPrd(
	repo: string,
	slug: string,
	fm: {
		humanOnly?: boolean;
		needsAnswers?: boolean;
		taskedAfter?: string[];
		/**
		 * Emit an INERT `tasked:` line (the marker was removed in
		 * remove-tasked-marker-step-b — the parser ignores it). Only used to PROVE a
		 * leftover marker does NOT count toward tasked-ness (residence does).
		 */
		tasked?: string;
		/** Seed into `work/specs/tasked/` (the tasked resting state) instead of `prd/`. */
		inPrdTasked?: boolean;
	} = {},
): void {
	const dir = join(repo, 'work', 'specs', fm.inPrdTasked ? 'tasked' : 'ready');
	mkdirSync(dir, {recursive: true});
	const lines = ['---', `title: ${slug}`, `slug: ${slug}`];
	if (fm.humanOnly) lines.push('humanOnly: true');
	if (fm.needsAnswers) lines.push('needsAnswers: true');
	if (fm.taskedAfter && fm.taskedAfter.length > 0) {
		lines.push(`taskedAfter: [${fm.taskedAfter.join(', ')}]`);
	}
	if (fm.tasked) lines.push(`tasked: ${fm.tasked}`);
	lines.push(
		'---',
		'',
		'## Problem Statement',
		'',
		`PRD body for ${slug}.`,
		'',
	);
	writeFileSync(join(dir, `${slug}.md`), lines.join('\n'));
	run('git', ['add', '-A'], repo, {env: gitEnv()});
	run('git', ['commit', '-q', '-m', `prd: ${slug}`], repo, {env: gitEnv()});
	run('git', ['push', '-q', ARBITER, 'main'], repo, {env: gitEnv()});
}

/** An agent that writes one STAGED task file under `work/tasks/backlog/` (no git). */
function taskingAgent(file = 'child', extra?: () => void): TaskDorfl {
	return ({cwd}) => {
		const dir = join(cwd, 'work', 'tasks', 'backlog');
		mkdirSync(dir, {recursive: true});
		writeFileSync(
			join(dir, `${file}.md`),
			[
				'---',
				`title: ${file}`,
				`slug: ${file}`,
				'prd: it',
				'---',
				'',
				'## Prompt',
				'',
				'> build it',
				'',
			].join('\n'),
		);
		extra?.();
		return {ok: true};
	};
}

const onArbiter = (repo: string, path: string): boolean => {
	run('git', ['fetch', '-q', ARBITER], repo, {env: gitEnv()});
	return (
		run('git', ['cat-file', '-e', `${ARBITER}/main:${path}`], repo, {
			env: gitEnv(),
		}).status === 0
	);
};
const showArbiter = (repo: string, path: string): string =>
	run('git', ['show', `${ARBITER}/main:${path}`], repo, {env: gitEnv()}).stdout;

// --- Gate refusal (agent path) — stub the lock so these stay pure ----------

describe('performTask — agent gate refusal (honest, names why it skipped)', () => {
	/** A lock seam that must NOT be touched (the gate refuses before the lock). */
	const noLock = {
		acquire(): Promise<AcquireTaskingLockResult> {
			throw new Error('lock acquire must not be reached on a gate refusal');
		},
		release(): Promise<ReleaseTaskingLockResult> {
			throw new Error('lock release must not be reached on a gate refusal');
		},
	};

	it('refuses a humanOnly PRD (names humanOnly), no agent, no lock', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it', {humanOnly: true});
		let agentRan = false;
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			lock: noLock,
			dorfl: () => {
				agentRan = true;
				return {ok: true};
			},
			env: gitEnv(),
		});
		expect(result.exitCode).toBe(1);
		expect(result.outcome).toBe('gate-refused');
		expect(result.message).toMatch(/humanOnly/);
		expect(agentRan).toBe(false);
	});

	it('refuses a needsAnswers PRD (names needsAnswers)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it', {needsAnswers: true});
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			lock: noLock,
			dorfl: taskingAgent(),
			env: gitEnv(),
		});
		expect(result.outcome).toBe('gate-refused');
		expect(result.message).toMatch(/needsAnswers/);
	});

	it('refuses when autoTask is off on the AUTO-PICK pool path (names autoTask)', async () => {
		// The NON-explicit (pool) dispatch: `explicit` unset ⇒ the `autoTask` POLICY
		// still gates. (The pool itself never selects such a prd; this asserts the
		// per-invocation gate's policy term survives for the pool path.)
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it');
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: false,
			lock: noLock,
			dorfl: taskingAgent(),
			env: gitEnv(),
		});
		expect(result.outcome).toBe('gate-refused');
		expect(result.message).toMatch(/autoTask/);
	});

	it('an EXPLICITLY-named PRD tasks with autoTask OFF (no config, no env) — naming IS the authorization', async () => {
		// The task-path mirror of `do <task>` building regardless of `autoBuild`:
		// `explicit: true` (the `do prd:<slug>` dispatch) drops the `autoTask` POLICY
		// term, so an explicit task-now proceeds to the lock/agent with the policy
		// unset. (A real lock is taken here — the gate does NOT refuse, so the noLock
		// stub would throw; we let the real CAS run and assert it tasked.)
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it');
		let agentRan = false;
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			// autoTask deliberately OMITTED (defaults off) — explicit alone authorizes.
			explicit: true,
			integration: 'merge',
			dorfl: taskingAgent('it-explicit', () => {
				agentRan = true;
			}),
			env: gitEnv(),
		});
		expect(result.outcome).toBe('tasked');
		expect(agentRan).toBe(true);
		expect(onArbiter(repo, 'work/tasks/backlog/it-explicit.md')).toBe(true);
	});

	it('EXPLICIT still refuses a humanOnly PRD (the readiness axis binds regardless of explicit)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it', {humanOnly: true});
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			explicit: true,
			lock: noLock,
			dorfl: taskingAgent(),
			env: gitEnv(),
		});
		expect(result.outcome).toBe('gate-refused');
		expect(result.message).toMatch(/humanOnly/);
	});

	it('EXPLICIT still refuses a needsAnswers PRD (the readiness axis binds regardless of explicit)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it', {needsAnswers: true});
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			explicit: true,
			lock: noLock,
			dorfl: taskingAgent(),
			env: gitEnv(),
		});
		expect(result.outcome).toBe('gate-refused');
		expect(result.message).toMatch(/needsAnswers/);
	});

	it('EXPLICIT still refuses an unsatisfied taskedAfter (ordering binds regardless of explicit)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'dep');
		seedPrd(repo, 'it', {taskedAfter: ['dep']});
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			explicit: true,
			lock: noLock,
			dorfl: taskingAgent(),
			env: gitEnv(),
		});
		expect(result.outcome).toBe('gate-refused');
		expect(result.message).toMatch(/dep/);
		expect(result.message).toMatch(/taskedAfter/);
		// The autoTask policy is NEVER the named reason on the explicit path.
		expect(result.message).not.toMatch(/autoTask/);
	});

	it('refuses when a taskedAfter PRD is not yet tasked (names it)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		// `dep` exists but is NOT tasked; `it` taskedAfter: [dep].
		seedPrd(repo, 'dep');
		seedPrd(repo, 'it', {taskedAfter: ['dep']});
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			lock: noLock,
			dorfl: taskingAgent(),
			env: gitEnv(),
		});
		expect(result.outcome).toBe('gate-refused');
		expect(result.message).toMatch(/dep/);
		expect(result.message).toMatch(/taskedAfter/);
	});

	it('passes the gate once the taskedAfter PRD IS tasked', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		// `dep` is TASKED — it RESIDES in work/specs/tasked/ (the source of truth), not
		// a `tasked:` marker in work/specs/ready/. `it`'s taskedAfter resolves against that
		// folder residence (mirroring blockedBy -> done/).
		seedPrd(repo, 'dep', {inPrdTasked: true});
		seedPrd(repo, 'it', {taskedAfter: ['dep']});
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			dorfl: taskingAgent(),
			env: gitEnv(),
		});
		expect(result.outcome).toBe('tasked');
	});

	it('STILL refuses when the taskedAfter PRD only carries an INERT `tasked:` line in prd/ (folder, not marker)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		// `dep` sits in work/specs/ready/ with a leftover (INERT) `tasked:` line but is NOT in
		// prd-tasked/. Folder residence is the SOLE source of truth — the marker was
		// removed in remove-tasked-marker-step-b, so the line is ignored and does NOT
		// satisfy taskedAfter.
		seedPrd(repo, 'dep', {tasked: '2026-06-01'});
		seedPrd(repo, 'it', {taskedAfter: ['dep']});
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			lock: noLock,
			dorfl: taskingAgent(),
			env: gitEnv(),
		});
		expect(result.outcome).toBe('gate-refused');
		expect(result.message).toMatch(/dep/);
	});

	it('the HUMAN path is unbound by the gate (tasks a humanOnly PRD, no lock)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it', {humanOnly: true});
		let acquired = false;
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			doer: 'human',
			lock: {
				acquire() {
					acquired = true;
					throw new Error('human-no-contention must not take the lock');
				},
				release() {
					throw new Error('human-no-contention must not release the lock');
				},
			},
			dorfl: taskingAgent(),
			env: gitEnv(),
		});
		expect(result.outcome).toBe('tasked');
		// The human path tasks WITHOUT the lock.
		expect(acquired).toBe(false);
	});
});

// --- The completing transition (real git, lock taken/released) -------------

describe('performTask — tasks + commits the runner-owned transition', () => {
	it('takes the lock, runs the agent, lands tasks in pre-backlog/ (STAGED), rests PRD in prd-tasked/', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it');
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			// `--merge`: land the produced tasks on the arbiter main (the output now
			// integrates through the shared core; propose would open a PR instead).
			integration: 'merge',
			dorfl: taskingAgent('it-first'),
			env: gitEnv(),
		});
		expect(result.exitCode).toBe(0);
		expect(result.outcome).toBe('tasked');
		expect(result.emitted).toEqual(['work/tasks/backlog/it-first.md']);

		// The produced task landed STAGED on the arbiter (work/tasks/backlog/ — the
		// agent-eligible pool work/tasks/ready/ is the runner-owned promotion target,
		// task `pre-backlog-staging-folder-and-promote-step-a`).
		expect(onArbiter(repo, 'work/tasks/backlog/it-first.md')).toBe(true);
		expect(onArbiter(repo, 'work/tasks/ready/it-first.md')).toBe(false);
		// The lock was released into the TASKED resting state: the prd now resides in
		// work/specs/tasked/ (the source of truth, like done/), NOT back in prd/; tasking/
		// is empty.
		expect(onArbiter(repo, 'work/specs/tasked/it.md')).toBe(true);
		expect(onArbiter(repo, 'work/specs/ready/it.md')).toBe(false);
		expect(onArbiter(repo, 'work/tasking/it.md')).toBe(false);
		// Tasked-ness is RESIDENCE in prd-tasked/ (asserted above). The `tasked:` marker
		// was removed in remove-tasked-marker-step-b, so the resting prd carries NO
		// tasked: line.
		expect(showArbiter(repo, 'work/specs/tasked/it.md')).not.toMatch(
			/^tasked:/m,
		);
	});

	it('the RUNNER (not the agent) authored the commits/moves', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it');
		// An agent that ASSERTS it does no git: the tree must NOT already be
		// committed by it — it only writes the file; the runner commits.
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			integration: 'merge',
			dorfl: ({cwd}) => {
				// The lock already moved the prd to tasking/ on the arbiter; the agent
				// must not have committed anything itself.
				const dir = join(cwd, 'work', 'tasks', 'backlog');
				mkdirSync(dir, {recursive: true});
				writeFileSync(
					join(dir, 'it-a.md'),
					'---\nslug: it-a\nprd: it\n---\n\n## Prompt\n\n> x\n',
				);
				return {ok: true};
			},
			env: gitEnv(),
		});
		expect(result.outcome).toBe('tasked');

		// The completing commit on the arbiter is the runner's tasking INTEGRATE
		// commit (it carries BOTH the backlog task AND the tasking→prd-tasked move),
		// now landed through the shared core (`tasking(<slug>): …; tasked`).
		const subject = run(
			'git',
			['log', '-1', '--format=%s', `${ARBITER}/main`],
			repo,
			{env: gitEnv()},
		).stdout.trim();
		expect(subject).toMatch(/^tasking\(it\):/);
		expect(subject).toMatch(/; tasked$/);
		// The completing commit carries BOTH the emitted backlog task AND the
		// tasking→prd-tasked move (a rename), in ONE runner-owned commit (rename
		// detection shows the move as `work/specs/tasked/it.md`; tasking/ verified empty).
		const files = run(
			'git',
			['show', '--name-status', '--format=', `${ARBITER}/main`],
			repo,
			{env: gitEnv()},
		).stdout;
		expect(files).toMatch(/work\/tasks\/backlog\/it-a\.md/);
		expect(files).toMatch(/work\/specs\/tasked\/it\.md/);
		// The prd is no longer held in tasking/ (the lock was released in this commit)
		// and now rests in prd-tasked/ (the source of truth), NOT back in prd/.
		expect(onArbiter(repo, 'work/tasking/it.md')).toBe(false);
		expect(onArbiter(repo, 'work/specs/tasked/it.md')).toBe(true);
		expect(onArbiter(repo, 'work/specs/ready/it.md')).toBe(false);
	});

	it('REGRESSION (`do prd:` titlePath read): the commit subject carries the PRD `title:` (read from titlePath, NOT the generic fallback)', async () => {
		// The intake lone-task fix threads its drafted title EXPLICITLY (its output
		// file does not exist at title-read time). The `do prd:` TASKING path is
		// UNCHANGED: its `titlePath` is the already-existing held prd, so the core still
		// READS the title from the file. This guards that read path keeps deriving the
		// subject from the prd `title:` (never degrading to `complete work task`).
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		// A DISTINCT multi-word title (not just the slug) so the subject is provably
		// derived from the prd title, not a generic fallback.
		const dir = join(repo, 'work', 'specs', 'ready');
		mkdirSync(dir, {recursive: true});
		writeFileSync(
			join(dir, 'it.md'),
			[
				'---',
				'title: Quiet and verbose output modes for the CLI',
				'slug: it',
				'---',
				'',
				'## Problem Statement',
				'',
				'PRD body.',
				'',
			].join('\n'),
		);
		run('git', ['add', '-A'], repo, {env: gitEnv()});
		run('git', ['commit', '-q', '-m', 'prd: it'], repo, {env: gitEnv()});
		run('git', ['push', '-q', ARBITER, 'main'], repo, {env: gitEnv()});

		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			integration: 'merge',
			dorfl: ({cwd}) => {
				const out = join(cwd, 'work', 'tasks', 'backlog');
				mkdirSync(out, {recursive: true});
				writeFileSync(
					join(out, 'it-a.md'),
					'---\nslug: it-a\nprd: it\n---\n\n## Prompt\n\n> x\n',
				);
				return {ok: true};
			},
			env: gitEnv(),
		});
		expect(result.outcome).toBe('tasked');

		const subject = run(
			'git',
			['log', '-1', '--format=%s', `${ARBITER}/main`],
			repo,
			{env: gitEnv()},
		).stdout.trim();
		expect(subject).toBe(
			'tasking(it): Quiet and verbose output modes for the CLI; tasked',
		);
		expect(subject).not.toContain('complete work task');
	});

	it('the content-identity stale check fires on a concurrent edit of the held PRD', async () => {
		// The OUTPUT now integrates through the shared core (not the lock release), so
		// the read-stability backstop is owned at the integrate seam. An agent that
		// EDITS the held work/tasking/<slug>.md body on the arbiter (a concurrent
		// writer, under the lock) must make the tasking STALE — fail loud, touch
		// NOTHING (the lock stays held; no tasks land).
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it');
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			integration: 'merge',
			dorfl: ({cwd}) => {
				// Write a task (as normal)…
				taskingAgent('child')({cwd, prompt: '', slug: 'it'});
				// …then, from a throwaway clone, EDIT the held prd body on the arbiter
				// while the lock is held (the concurrent-edit the backstop must catch).
				editHeldPrdOnArbiter(scratch.root, 'it');
				return {ok: true};
			},
			env: gitEnv(),
		});
		expect(result.exitCode).toBe(4);
		expect(result.outcome).toBe('stale');
		// The arbiter was NOT modified by the tasking: the prd body stays in prd/ (the
		// lock is still held on the ref), and no backlog task landed on main. The prd
		// did NOT move to prd-tasked/.
		expect(onArbiter(repo, 'work/specs/ready/it.md')).toBe(true);
		expect(onArbiter(repo, 'work/specs/tasked/it.md')).toBe(false);
		expect(onArbiter(repo, 'work/tasks/backlog/child.md')).toBe(false);
	});

	it('RE-TASK round-trip: prd-tasked/ -> prd/ reopens a tasked PRD into the task pool', async () => {
		// Task `it` ONCE: it lands in work/specs/tasked/ (the tasked resting state).
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it');
		const first = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			integration: 'merge',
			dorfl: taskingAgent('it-first'),
			env: gitEnv(),
		});
		expect(first.outcome).toBe('tasked');
		expect(onArbiter(repo, 'work/specs/tasked/it.md')).toBe(true);

		// REOPEN-TO-READY: git mv work/specs/tasked/it.md -> work/specs/ready/it.md (mirroring
		// done/ -> backlog/), so the reshaped prd re-enters the task pool with no
		// special case. Do it on a throwaway clone + push (the runner owns git; this is
		// a test's own throwaway repo).
		reopenTaskedPrd(scratch.root, 'it');
		expect(onArbiter(repo, 'work/specs/ready/it.md')).toBe(true);
		expect(onArbiter(repo, 'work/specs/tasked/it.md')).toBe(false);
		// Sync the local checkout to the reopened arbiter main so its working tree has
		// work/specs/ready/it.md (the to-task source `performTask` reads at step 0).
		run('git', ['fetch', '-q', ARBITER], repo, {env: gitEnv()});
		run('git', ['reset', '-q', '--hard', `${ARBITER}/main`], repo, {
			env: gitEnv(),
		});

		// Task it AGAIN: it is back in the pool (the gate sees it in prd/), so the
		// agent path tasks it once more, landing it back in prd-tasked/.
		const second = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			integration: 'merge',
			dorfl: taskingAgent('it-second'),
			env: gitEnv(),
		});
		expect(second.outcome).toBe('tasked');
		expect(onArbiter(repo, 'work/tasks/backlog/it-second.md')).toBe(true);
		expect(onArbiter(repo, 'work/specs/tasked/it.md')).toBe(true);
		expect(onArbiter(repo, 'work/specs/ready/it.md')).toBe(false);
	});
});

/**
 * REOPEN a tasked prd to ready: from a throwaway clone of the arbiter,
 * `git mv work/specs/tasked/<slug>.md -> work/specs/ready/<slug>.md` and push it to `main`
 * (the re-task / reopen-to-ready move, mirroring done/ -> backlog/).
 */
function reopenTaskedPrd(root: string, slug: string): void {
	const dest = join(root, `reopen-${slug}`);
	run(
		'git',
		['clone', '-q', `file://${join(root, 'project-work.git')}`, dest],
		root,
		{env: gitEnv()},
	);
	run('git', ['fetch', '-q', 'origin'], dest, {env: gitEnv()});
	run('git', ['checkout', '-q', '-B', 'reopen', 'origin/main'], dest, {
		env: gitEnv(),
	});
	mkdirSync(join(dest, 'work', 'specs', 'ready'), {recursive: true});
	run(
		'git',
		['mv', `work/specs/tasked/${slug}.md`, `work/specs/ready/${slug}.md`],
		dest,
		{env: gitEnv()},
	);
	run('git', ['commit', '-q', '-m', `reopen ${slug} to ready`], dest, {
		env: gitEnv(),
	});
	run('git', ['push', '-q', 'origin', 'reopen:main'], dest, {env: gitEnv()});
}

/**
 * From a throwaway clone of the arbiter, EDIT the held `work/specs/ready/<slug>.md` body
 * and push it to `main` — simulating a concurrent writer editing the prd under the
 * tasking lock (the body stays in `work/specs/ready/` now; the read-stability backstop must
 * detect the changed blob and fail the integrate as `stale`).
 */
function editHeldPrdOnArbiter(root: string, slug: string): void {
	const dest = join(root, `concurrent-edit-${slug}`);
	run(
		'git',
		['clone', '-q', `file://${join(root, 'project-work.git')}`, dest],
		root,
		{env: gitEnv()},
	);
	run('git', ['fetch', '-q', 'origin'], dest, {env: gitEnv()});
	run('git', ['checkout', '-q', '-B', 'edit', 'origin/main'], dest, {
		env: gitEnv(),
	});
	const held = join(dest, 'work', 'specs', 'ready', `${slug}.md`);
	writeFileSync(
		held,
		readFileSync(held, 'utf8') + '\nCONCURRENT EDIT under the lock.\n',
	);
	run('git', ['add', '-A'], dest, {env: gitEnv()});
	run('git', ['commit', '-q', '-m', 'concurrent edit'], dest, {env: gitEnv()});
	run('git', ['push', '-q', 'origin', 'edit:main'], dest, {env: gitEnv()});
}

// --- Lock contention + agent failure ---------------------------------------

describe('performTask — lock lost / agent failed', () => {
	it('a lost lock is reported (lock-lost), the agent never runs', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it');
		let agentRan = false;
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			lock: {
				acquire: async () => ({
					exitCode: 2,
					outcome: 'lost',
					message: 'someone holds the tasking lock',
				}),
				release: () => {
					throw new Error('release must not run when acquire lost');
				},
			},
			dorfl: () => {
				agentRan = true;
				return {ok: true};
			},
			env: gitEnv(),
		});
		expect(result.exitCode).toBe(2);
		expect(result.outcome).toBe('lock-lost');
		expect(agentRan).toBe(false);
	});

	it('an agent failure is reported (agent-failed); the lock is NOT released', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it');
		let released = false;
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			lock: {
				acquire: async () => ({
					exitCode: 0,
					outcome: 'acquired',
					message: 'locked',
					lockedBlob: 'a'.repeat(40),
				}),
				release: async () => {
					released = true;
					return {exitCode: 0, outcome: 'released', message: 'released'};
				},
			},
			dorfl: () => ({ok: false, detail: 'boom'}),
			env: gitEnv(),
		});
		expect(result.exitCode).toBe(1);
		expect(result.outcome).toBe('agent-failed');
		expect(result.message).toMatch(/boom/);
		// The runner did NOT release the lock on a failed task (recoverable/re-run).
		expect(released).toBe(false);
	});
});

// --- The tasker review→edit→converge LOOP (tasker-review-edit-loop) -----------

describe('performTask — the tasker review→edit→converge loop', () => {
	/** A loop gate returning a scripted sequence of verdicts (one per pass). */
	function loopGate(verdicts: TaskReviewVerdict[]): TaskReviewGate {
		let i = 0;
		return async () => {
			const v = verdicts[Math.min(i, verdicts.length - 1)];
			i++;
			return v;
		};
	}

	it('a converging loop (findings → edits → clean) LANDS the IMPROVED tasks', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it');
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			integration: 'merge',
			dorfl: taskingAgent('child'),
			reviewLoop: loopGate([
				// Pass 1: block + improve the candidate task in place.
				{
					verdict: 'block',
					findings: [{severity: 'blocking', question: 'thin prompt'}],
					edits: [
						{
							path: 'work/tasks/backlog/child.md',
							content:
								'---\nslug: child\nprd: it\n---\n\n## Prompt\n\n> IMPROVED by the loop\n',
						},
					],
				},
				// Pass 2: converged.
				{verdict: 'approve', findings: []},
			]),
			taskerLoopMax: 3,
			env: gitEnv(),
		});
		expect(result.outcome).toBe('tasked');
		expect(result.loop).toBe('converged');
		// The IMPROVED task landed STAGED on the arbiter (not the pre-loop draft).
		expect(onArbiter(repo, 'work/tasks/backlog/child.md')).toBe(true);
		expect(showArbiter(repo, 'work/tasks/backlog/child.md')).toMatch(
			/IMPROVED by the loop/,
		);
		// The lock was released + the prd now rests in prd-tasked/ (residence = the SOLE
		// tasked-ness signal; the `tasked:` marker was removed in
		// remove-tasked-marker-step-b).
		expect(onArbiter(repo, 'work/tasking/it.md')).toBe(false);
		expect(onArbiter(repo, 'work/specs/tasked/it.md')).toBe(true);
	});

	it('a persistent block hits taskerLoopMax → emits the uncertain task needsAnswers + questions', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it');
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			integration: 'merge',
			dorfl: taskingAgent('child'),
			reviewLoop: loopGate([
				{
					verdict: 'block',
					findings: [{severity: 'blocking', question: 'unresolved seam'}],
					uncertainTasks: [
						{
							path: 'work/tasks/backlog/child.md',
							questions: ['which seam does this reuse?'],
						},
					],
				},
			]),
			taskerLoopMax: 2,
			env: gitEnv(),
		});
		expect(result.outcome).toBe('tasked');
		expect(result.loop).toBe('uncertain-tasks');
		// The task landed STAGED BUT is flagged needsAnswers with the questions in its body.
		const body = showArbiter(repo, 'work/tasks/backlog/child.md');
		expect(body).toMatch(/needsAnswers: true/);
		expect(body).toMatch(/which seam does this reuse\?/);
		expect(body).toMatch(/## Open questions/);
	});

	it('decomposition-unclear → routes the PRD to needs-attention, emits NO tasks', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it');
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			dorfl: taskingAgent('child'),
			reviewLoop: loopGate([
				{
					verdict: 'block',
					findings: [{severity: 'blocking', question: 'wrong shape'}],
					decompositionUnclear: {
						questions: ['should this be split across two PRDs?'],
					},
				},
			]),
			taskerLoopMax: 2,
			env: gitEnv(),
		});
		expect(result.outcome).toBe('needs-attention');
		// A clean park-for-human (surface the open questions, no guessed tasks) is a
		// SUCCESS terminal of the loop contract — exit 0 (green CI leg), not a failure
		// (fix `tasking-review-block-surfaces-needs-attention-but-exits-nonzero`).
		expect(result.exitCode).toBe(0);
		// The needs-attention surface parks the spec as a `needsAnswers:true` body +
		// a question sidecar on main (the lock is RELEASED, not held); the prd body
		// STAYS in work/specs/ready/, and NO needs-attention/ or tasking/ folder file
		// is written.
		expect(onArbiter(repo, 'work/specs/ready/it.md')).toBe(true);
		expect(onArbiter(repo, 'work/needs-attention/it.md')).toBe(false);
		expect(onArbiter(repo, 'work/specs/tasked/it.md')).toBe(false);
		expect(onArbiter(repo, 'work/tasking/it.md')).toBe(false);
		// No guessed tasks emitted (neither staged nor in the pool).
		expect(onArbiter(repo, 'work/tasks/backlog/child.md')).toBe(false);
		expect(onArbiter(repo, 'work/tasks/ready/child.md')).toBe(false);
		// PR-2b (spec `surface-stuck-as-questions-and-retire-stuck-lock-state`): the
		// tasking bounce SURFACES the spec on `<arbiter>/main` (stuck-kind sidecar
		// + `needsAnswers:true` on the spec body in ONE commit) THEN RELEASES the
		// tasking lock. The reason + questions live on the sidecar.
		const entry = await readItemLock({
			item: 'spec:it',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(entry).toBeUndefined();
		run('git', ['fetch', '-q', ARBITER], repo, {env: gitEnv()});
		const sidecar = run(
			'git',
			['show', `${ARBITER}/main:work/questions/spec-it.md`],
			repo,
			{env: gitEnv()},
		).stdout;
		expect(sidecar).toMatch(/should this be split across two PRDs\?/);
	});

	it('M>1 runs the loop in fresh contexts (the loop seam is invoked per execution)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it');
		const executions: number[] = [];
		const gate: TaskReviewGate = async (input) => {
			executions.push(input.execution);
			// Execution 1 never converges; execution 2 converges on pass 1.
			if (input.execution === 1) {
				return {
					verdict: 'block',
					findings: [{severity: 'blocking', question: 'try again fresh'}],
				};
			}
			return {verdict: 'approve', findings: []};
		};
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			dorfl: taskingAgent('child'),
			reviewLoop: gate,
			taskerLoopMax: 2,
			reviewExecutions: 3,
			env: gitEnv(),
		});
		expect(result.outcome).toBe('tasked');
		expect(result.loop).toBe('converged');
		// Execution 1 ran twice (taskerLoopMax), execution 2 once (converged), 3 never.
		expect(executions).toEqual([1, 1, 2]);
	});

	it('the HUMAN path is UNAFFECTED by the loop (no loop runs even when a gate is wired)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it', {humanOnly: true});
		let loopRan = false;
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			doer: 'human',
			dorfl: taskingAgent('child'),
			reviewLoop: async () => {
				loopRan = true;
				return {verdict: 'approve', findings: []};
			},
			taskerLoopMax: 3,
			env: gitEnv(),
		});
		expect(result.outcome).toBe('tasked');
		expect(result.loop).toBeUndefined();
		// The loop seam was never invoked on the human path.
		expect(loopRan).toBe(false);
	});

	it('no loop seam wired ⇒ the candidate tasks land as-is (pre-loop behaviour)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it');
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			integration: 'merge',
			dorfl: taskingAgent('child'),
			env: gitEnv(),
		});
		expect(result.outcome).toBe('tasked');
		expect(result.loop).toBeUndefined();
		expect(onArbiter(repo, 'work/tasks/backlog/child.md')).toBe(true);
	});

	it('on a POPULATED pool, the loop’s edit attempts to a pool task are FENCED OUT (the loop only touches pre-backlog/)', async () => {
		// The requeue fix (regression): seed a POPULATED backlog — a pre-existing,
		// already-LANDED task committed on the arbiter — then task. The loop must
		// review/edit/flag ONLY the task THIS run produced; the pre-existing task
		// must be left completely alone (not edited, not needsAnswers-flagged, not
		// re-committed into the runner-owned tasking release).
		const {repo} = seedRepoWithArbiter(scratch.root, ['landed']);
		const landedBefore = showArbiter(repo, 'work/tasks/ready/landed.md');
		seedPrd(repo, 'it');
		const seenByGate: string[][] = [];
		// A loop gate that, given the chance, would HIJACK + flag a landed POOL
		// task — only the pre-backlog/ prefix fence stops it. The agent's own task
		// is in pre-backlog/, so that edit IS in scope and lands.
		const gate: TaskReviewGate = async (input) => {
			seenByGate.push(input.candidateTasks);
			return {
				verdict: 'block',
				findings: [{severity: 'blocking', question: 'rewrite everything'}],
				edits: [
					// Try to overwrite the pre-existing POOL task (must be REFUSED
					// — outside the pre-backlog/ fence)…
					{path: 'work/tasks/ready/landed.md', content: 'HIJACKED landed'},
					// …and improve the run's own task (allowed), keeping valid frontmatter.
					...input.candidateTasks.map((path) => ({
						path,
						content:
							'---\nslug: child\nprd: it\n---\n\n## Prompt\n\n> IMPROVED by the loop\n',
					})),
				],
				// Also try to flag the pre-existing task directly by name.
				uncertainTasks: [
					{path: 'work/tasks/ready/landed.md', questions: ['hijack flag']},
					...input.candidateTasks.map((path) => ({
						path,
						questions: ['own flag'],
					})),
				],
			};
		};
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			integration: 'merge',
			dorfl: taskingAgent('child'),
			reviewLoop: gate,
			taskerLoopMax: 1,
			env: gitEnv(),
		});
		expect(result.outcome).toBe('tasked');
		expect(result.loop).toBe('uncertain-tasks');
		// The gate was only ever shown THIS run's own produced STAGED task.
		for (const seen of seenByGate) {
			expect(seen).toEqual(['work/tasks/backlog/child.md']);
		}
		// The pre-existing landed task on the arbiter is BYTE-FOR-BYTE unchanged:
		// not hijacked, not needsAnswers-flagged, not re-committed.
		expect(showArbiter(repo, 'work/tasks/ready/landed.md')).toBe(landedBefore);
		expect(showArbiter(repo, 'work/tasks/ready/landed.md')).not.toMatch(
			/HIJACKED/,
		);
		expect(showArbiter(repo, 'work/tasks/ready/landed.md')).not.toMatch(
			/needsAnswers/,
		);
		// THIS run's own STAGED task WAS the one flagged needsAnswers (cap hit).
		const child = showArbiter(repo, 'work/tasks/backlog/child.md');
		expect(child).toMatch(/needsAnswers: true/);
		expect(child).toMatch(/own flag/);
	});
});

// --- The review-LEG-FAILURE bounce (observation tasker-review-edits-payload-caps-the-verdict-response) ---

describe('performTask — the review leg failure bounce (cap-truncation + parse failure)', () => {
	it('a cap-truncated review verdict RELEASES the lock, writes a sidecar naming the cap, and PERSISTS the candidate tasks (does not crash + leave the lock held)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it');
		// The review gate throws the NAMED cap-truncation error (what
		// harnessTaskReviewGate throws on a response truncated at the output cap).
		const gate: TaskReviewGate = async () => {
			throw new ReviewOutputCappedError(16384);
		};
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			integration: 'merge',
			dorfl: taskingAgent('child'),
			reviewLoop: gate,
			taskerLoopMax: 3,
			env: gitEnv(),
		});
		// A clean park-for-human is a SUCCESS terminal (exit 0), not a crash.
		expect(result.exitCode).toBe(0);
		expect(result.outcome).toBe('needs-attention');
		// The NAMED failure: the message identifies the cap + token count, NOT a
		// generic "produced no parseable result".
		expect(result.message).toMatch(/hit the model output cap \(16384 tokens\)/);
		expect(result.message).not.toMatch(/no parseable/);
		// The lock was RELEASED (the documented bounce), not left held — the
		// pre-fix bug needed a hand `dorfl release-lock` to clear it.
		const entry = await readItemLock({
			item: 'spec:it',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(entry).toBeUndefined();
		// The question sidecar was WRITTEN on <arbiter>/main (the documented bounce;
		// the pre-fix path wrote none) and NAMES the cap-truncation.
		run('git', ['fetch', '-q', ARBITER], repo, {env: gitEnv()});
		const sidecar = run(
			'git',
			['show', `${ARBITER}/main:work/questions/spec-it.md`],
			repo,
			{env: gitEnv()},
		).stdout;
		expect(sidecar).toMatch(/hit the model output cap \(16384 tokens\)/);
		expect(sidecar).toMatch(/STRUCTURAL cap-truncation/);
		// No guessed tasks were landed (the spec is parked, not tasked).
		expect(onArbiter(repo, 'work/specs/tasked/it.md')).toBe(false);
		expect(onArbiter(repo, 'work/specs/ready/it.md')).toBe(true);
		// The candidate tasks the tasker PRODUCED were PERSISTED (not discarded) —
		// committed on the local work branch for recovery (the bounce is treeless,
		// so the run is still on `work/spec-it`).
		const candidateOnBranch = run(
			'git',
			['show', 'work/spec-it:work/tasks/backlog/child.md'],
			repo,
			{env: gitEnv()},
		);
		expect(candidateOnBranch.status).toBe(0);
		expect(candidateOnBranch.stdout).toMatch(/## Prompt/);
		// And the sidecar notes the candidate tasks are saved for recovery.
		expect(sidecar).toMatch(/saved on the work branch/);
	});

	it('a GENERIC parse failure (no cap signal) still bounces + names it as a parse failure (never a silent approve)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it');
		const gate: TaskReviewGate = async () => {
			throw new ReviewParseError(
				'review agent produced no parseable {verdict, findings} result',
			);
		};
		const result = await performTask({
			slug: 'it',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			dorfl: taskingAgent('child'),
			reviewLoop: gate,
			taskerLoopMax: 3,
			env: gitEnv(),
		});
		expect(result.exitCode).toBe(0);
		expect(result.outcome).toBe('needs-attention');
		// Named as a parse failure, NOT a cap (no false cap claim without a signal).
		expect(result.message).toMatch(/no parseable/);
		expect(result.message).not.toMatch(/output cap/);
		// Lock released + sidecar written.
		const entry = await readItemLock({
			item: 'spec:it',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(entry).toBeUndefined();
		run('git', ['fetch', '-q', ARBITER], repo, {env: gitEnv()});
		const sidecar = run(
			'git',
			['show', `${ARBITER}/main:work/questions/spec-it.md`],
			repo,
			{env: gitEnv()},
		).stdout;
		expect(sidecar).toMatch(/no parseable/);
	});

	it('a NON-review throw (a genuine wiring error) is RE-THROWN, not silently bounced', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		seedPrd(repo, 'it');
		const gate: TaskReviewGate = async () => {
			throw new Error('genuine wiring blow-up');
		};
		await expect(
			performTask({
				slug: 'it',
				cwd: repo,
				arbiter: ARBITER,
				autoTask: true,
				dorfl: taskingAgent('child'),
				reviewLoop: gate,
				taskerLoopMax: 3,
				env: gitEnv(),
			}),
		).rejects.toThrow('genuine wiring blow-up');
	});
});

describe('performTask — usage', () => {
	it('errors when the spec does not exist', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, []);
		const result = await performTask({
			slug: 'nope',
			cwd: repo,
			arbiter: ARBITER,
			autoTask: true,
			dorfl: taskingAgent(),
			env: gitEnv(),
		});
		expect(result.exitCode).toBe(1);
		expect(result.outcome).toBe('usage-error');
		expect(result.message).toMatch(/no spec/);
	});
});
