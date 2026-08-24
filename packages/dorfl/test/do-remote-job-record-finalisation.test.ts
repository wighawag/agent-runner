import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {existsSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {performDoRemote} from '../src/do.js';
import {jobWorktreePath, readJobRecord} from '../src/workspace.js';
import type {
	Harness,
	HarnessRecord,
	InteractiveLaunchInput,
	InteractiveLaunchResult,
	LaunchInput,
	LaunchResult,
} from '../src/harness.js';
import {
	makeScratch,
	isolatePiAgentDir,
	seedRepoWithArbiter,
	gitEnv,
	gitIn,
	type Scratch,
} from './helpers/gitRepo.js';

/**
 * **A `do` job's record must say what actually ran and how the run ended**
 * (the live residue of observation
 * `deadline-reap-lets-node-exit-0-before-the-checkpoint-runs`).
 *
 * Before this fix the whole `do` path never called `updateJobRecord` at all:
 * `createJob` wrote the placeholder `{adapter: 'null'}` + `state: 'running'`,
 * and those were the record's only values FOREVER, healthy run or not. In the
 * field that record was read as "no agent was attached" (a pi agent had in fact
 * run for the full 90 minutes) and as "the job is still in flight" (the run had
 * reached a terminal decision and exited). Only `run` finalised the record; the
 * `do` path now mirrors that discipline:
 *
 *  - the launch's REAL harness record is written the moment the launch settles
 *    (adapter + pid/session liveness anchor — what `status`/`gc` read), and
 *  - the terminal outcome lands on the record (`done` / `needs-attention` plus
 *    the pipeline's own message as the reason), so a retained tree stops
 *    reading as a crashed-but-running job.
 *
 * The tests drive the REAL `performDoRemote` against a stub `Harness`, with the
 * arbiter taken OFFLINE mid-run (the do-remote "offline arbiter" pattern), so
 * the worktree + record are RETAINED and readable afterwards. Asserting on the
 * retained record is the point: before the fix it said `adapter: "null"` /
 * `state: "running"` in exactly this shape.
 */

let scratch: Scratch;
let restorePiAgentDir: () => void;
beforeEach(() => {
	scratch = makeScratch('dorfl-do-record-');
	restorePiAgentDir = isolatePiAgentDir(scratch.root);
});
afterEach(() => {
	restorePiAgentDir();
	scratch.cleanup();
});

const PASS = 'exit 0';

/** The temp agents' execution area for a run (the worktrees + mirrors live here). */
function workspacesDir(): string {
	return join(scratch.root, 'agents-area');
}

/** The `file://` URL of a seeded `--bare` arbiter (the registered remote). */
function remoteUrlOf(arbiter: string): string {
	return `file://${arbiter}`;
}

/** The record `createJob` wrote, read back from the RETAINED worktree's sibling. */
function recordOf(workspacesDirRoot: string, remoteUrl: string, slug: string) {
	const dir = jobWorktreePath(workspacesDirRoot, remoteUrl, slug);
	// Sanity: the tree was RETAINED (not reaped) — otherwise the record's
	// post-exit state is unobservable and this test asserts nothing.
	expect(existsSync(dir)).toBe(true);
	const record = readJobRecord(dir);
	expect(record).toBeDefined();
	return record!;
}

/**
 * A stub harness whose `launch` plays the agent: it edits a file in the
 * worktree (a real source change), optionally takes the arbiter offline from
 * inside the run (breaking the worktree's `origin`, the do-remote offline
 * pattern), and reports a LaunchResult carrying an honest adapter record.
 */
function stubHarness(options: {
	offline: boolean;
	ok: boolean;
	detail?: string;
}): Harness {
	return {
		adapter: 'stub-agent',
		launch(input: LaunchInput): LaunchResult {
			writeFileSync(join(input.dir, 'agent-output.txt'), 'work done\n');
			if (options.offline) {
				// Inside the run, the arbiter goes away: every later push/fetch
				// fails, so the needs-attention surface cannot land and the §4
				// teardown RETAINS the worktree (never lose work).
				gitIn(
					['remote', 'set-url', 'origin', 'file:///nonexistent/arbiter.git'],
					input.dir,
				);
			}
			return {
				ok: options.ok,
				record: {
					adapter: 'stub-agent',
					pid: 4242,
					session: join(scratch.root, 'sessions', 'stub.jsonl'),
				} satisfies HarnessRecord,
				detail: options.ok ? undefined : (options.detail ?? 'the stub failed'),
			};
		},
		launchInteractive(_input: InteractiveLaunchInput): InteractiveLaunchResult {
			throw new Error('not used on the autonomous path');
		},
		isAlive: () => false,
	};
}

describe('the do job record finalises with the real launch and the real outcome', () => {
	it('records the harness the agent ACTUALLY ran under, not the placeholder', async () => {
		const {arbiter} = seedRepoWithArbiter(scratch.root, ['alpha']);
		const ws = workspacesDir();
		const remote = remoteUrlOf(arbiter);

		const result = await performDoRemote({
			arg: 'alpha',
			remote,
			workspacesDir: ws,
			integration: 'merge',
			verify: PASS,
			// The arbiter goes offline inside the launch; the agent SUCCEEDS, so the
			// run reaches the integration tail (prepare/gate/done-move), which then
			// cannot reach the arbiter → routed, tree retained.
			harness: stubHarness({offline: true, ok: true}),
			env: gitEnv(),
		});

		// The run could not land its work on the arbiter — a NON-success terminal
		// decision (the exact wording of the outcome is the integrate tail's, not
		// this test's concern).
		expect(result.outcome).not.toBe('completed');
		expect(result.exitCode).not.toBe(0);

		const record = recordOf(ws, remote, 'alpha');
		// THE REGRESSION: before the fix this read `{adapter: 'null'}` no matter
		// what actually ran.
		expect(record.harness.adapter).toBe('stub-agent');
		expect(record.harness.pid).toBe(4242);
		expect(record.harness.session).toContain('stub.jsonl');
		// And the run DID reach a decision — the record must not say `running`.
		expect(record.state).toBe('needs-attention');
		expect(record.reason).toBeTypeOf('string');
	}, 60_000);

	it('a failed agent is finalised too: real adapter + needs-attention + reason', async () => {
		const {arbiter} = seedRepoWithArbiter(scratch.root, ['bravo']);
		const ws = workspacesDir();
		const remote = remoteUrlOf(arbiter);

		const result = await performDoRemote({
			arg: 'bravo',
			remote,
			workspacesDir: ws,
			integration: 'merge',
			verify: PASS,
			harness: stubHarness({
				offline: true,
				ok: false,
				detail: 'synthetic agent failure',
			}),
			env: gitEnv(),
		});

		expect(result.outcome).not.toBe('completed');

		const record = recordOf(ws, remote, 'bravo');
		expect(record.harness.adapter).toBe('stub-agent');
		expect(record.state).toBe('needs-attention');
		expect(record.reason).toMatch(/synthetic agent failure/);
	}, 60_000);

	it('a deadline route names itself on the record (not a bare `running`)', async () => {
		const {arbiter} = seedRepoWithArbiter(scratch.root, ['charlie']);
		const ws = workspacesDir();
		const remote = remoteUrlOf(arbiter);

		const result = await performDoRemote({
			arg: 'charlie',
			remote,
			workspacesDir: ws,
			integration: 'merge',
			verify: PASS,
			// A DEADLINE stop. The stub makes REAL progress (an edit) AND takes the
			// arbiter offline inside the launch, so the checkpoint's save push and
			// the auto-continue's lock release both fail → the route falls through
			// to SURFACE, the branch tip is not reachable on the arbiter, and the
			// worktree (+ record) is retained. (A no-progress stub would leave the
			// branch tip AT main, which §4 readably reaps — nothing to assert on.)
			harness: {
				...stubHarness({offline: false, ok: false}),
				launch(input: LaunchInput): LaunchResult {
					writeFileSync(join(input.dir, 'agent-output.txt'), 'partial\n');
					gitIn(
						['remote', 'set-url', 'origin', 'file:///nonexistent/arbiter.git'],
						input.dir,
					);
					return {
						ok: false,
						timedOut: true,
						record: {
							adapter: 'stub-agent',
							pid: 4243,
							session: join(scratch.root, 'sessions', 'stub.jsonl'),
						},
					};
				},
			},
			env: gitEnv(),
			maxAutoCheckpoints: 5,
		});

		expect(result.outcome).toBe('deadline-surfaced');
		const record = recordOf(ws, remote, 'charlie');
		expect(record.harness.adapter).toBe('stub-agent');
		expect(record.state).toBe('needs-attention');
		expect(record.reason).toMatch(/deadline checkpoint/);
	}, 60_000);
});
