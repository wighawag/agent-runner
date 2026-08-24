import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {chmodSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeScratch, gitEnv, type Scratch} from './helpers/gitRepo.js';

/**
 * **The runner must not exit between the agent and its outcome** (observation
 * `deadline-reap-lets-node-exit-0-before-the-checkpoint-runs`).
 *
 * Field shape: a 90-minute task hit `agentDeadlineMinutes`, the harness SIGTERMed
 * the agent's process group, and the runner then vanished with exit code 0 after
 * printing only its claim/onboard preamble. No WIP commit, no branch push, no
 * lock release, no writer-sentinel release, no job-record update — and a success
 * status, so nothing upstream could notice. It happened twice on the same task
 * while ten shorter tasks in the same session were fine, because only a run that
 * reaches the deadline takes this path at all.
 *
 * Mechanism: an `await` is not a handle. On the deadline path the harness drops
 * every handle it owns (destroys the stdio pipes, `unref`s the child) and keeps
 * the promise pending across {@link reapProcessGroup}, whose poll timer was
 * `unref`'d. When any group member is still alive at the first probe (a tool
 * subshell, a test runner, an MCP server), the loop had NOTHING referenced left
 * and node exited normally, abandoning the suspended pipeline.
 *
 * These tests therefore run a BARE runner process (`helpers/deadline-launch-runner.ts`):
 * inside vitest the defect is invisible, because the test runner's own handles
 * keep the loop alive. The in-process deadline/reap suite
 * (`checkpoint-reaps-agent-tree.test.ts`) passes both before and after the fix,
 * which is precisely why this one lives in its own process.
 */

let scratch: Scratch;
beforeEach(() => {
	scratch = makeScratch('dorfl-deadline-alive-');
});
afterEach(() => {
	scratch.cleanup();
});

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX_BIN = join(HERE, '..', 'node_modules', '.bin', 'tsx');
const RUNNER = join(HERE, 'helpers', 'deadline-launch-runner.ts');

/**
 * A stub `pi` whose process GROUP outlives it: a descendant that traps and
 * IGNORES SIGTERM, so the reap has to poll (and, in the field, that poll is
 * where the runner disappeared). pi itself exits promptly when signalled.
 */
function writeAgentStubWithStubbornDescendant(name: string): string {
	const bin = join(scratch.root, name);
	writeFileSync(
		bin,
		[
			'#!/usr/bin/env bash',
			'session_file=""',
			'prev=""',
			'for a in "$@"; do',
			'  if [ "$prev" = "--session" ]; then session_file="$a"; fi',
			'  prev="$a"',
			'done',
			'if [ -n "$session_file" ]; then mkdir -p "$(dirname "$session_file")"; : > "$session_file"; fi',
			'cat > /dev/null',
			// The tool subprocess that does not die on the group SIGTERM.
			"( trap '' TERM; sleep 6 ) &",
			"trap 'exit 0' TERM",
			'while true; do sleep 0.05; done',
			'',
		].join('\n'),
	);
	chmodSync(bin, 0o755);
	return bin;
}

interface RunnerOutcome {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

function runBareRunner(
	piBin: string,
	deadlineInMs: number,
): Promise<RunnerOutcome> {
	return new Promise((resolve) => {
		const child = spawn(
			TSX_BIN,
			[
				RUNNER,
				piBin,
				join(scratch.root, 'sessions', 'runner.jsonl'),
				String(deadlineInMs),
			],
			{
				cwd: scratch.root,
				env: {...process.env, ...gitEnv()},
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
		child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
		child.on('close', (exitCode, signal) =>
			resolve({exitCode, signal, stdout, stderr}),
		);
	});
}

describe('the runner survives its own deadline reap', () => {
	it('returns from the awaited launch instead of exiting 0 mid-reap', async () => {
		const bin = writeAgentStubWithStubbornDescendant('pi-stubborn-tree.sh');
		const outcome = await runBareRunner(bin, 400);

		// The preamble always printed, in the field too. What was missing is
		// everything AFTER the await.
		expect(outcome.stdout).toContain('PREAMBLE');

		// THE REGRESSION: before the fix the process exited 0 right here, so the
		// deadline checkpoint (and the `finally` that releases the worktree writer
		// sentinel) never ran.
		expect(outcome.stdout).toContain('AFTER_AWAIT');
		expect(outcome.stdout).toContain('FINALLY');

		// And it still reports the deadline stop with PROOF the tree is gone —
		// the guarantee `checkpoint-reaps-agent-tree` pins, re-asserted here from
		// a process that could actually have died instead.
		expect(outcome.stdout).toContain('timedOut=true');
		expect(outcome.stdout).toContain('reaped=true');

		expect(outcome.signal).toBeNull();
		expect(outcome.exitCode).toBe(0);
	}, 60_000);

	it('never reports success when it does exit with a launch in flight', async () => {
		// The independent backstop: whatever else may one day end a process
		// mid-launch, it must be LOUD and non-zero rather than a silent success.
		// Driven by killing the runner's own event loop the only way a caller
		// can — an explicit `process.exit(0)` while the launch is unsettled.
		const bin = writeAgentStubWithStubbornDescendant('pi-guard.sh');
		const runner = join(scratch.root, 'exit-mid-launch.ts');
		writeFileSync(
			runner,
			[
				`import {PiHarness} from ${JSON.stringify(join(HERE, '..', 'src', 'pi-harness.js'))};`,
				`const harness = new PiHarness({piBin: ${JSON.stringify(bin)}});`,
				'void harness.launchAsync({',
				`  dir: ${JSON.stringify(scratch.root)}, slug: 'guard', command: '', prompt: 'x',`,
				`  session: ${JSON.stringify(join(scratch.root, 'sessions', 'guard.jsonl'))},`,
				'  deadlineMs: Date.now() + 60_000,',
				'});',
				'setTimeout(() => process.exit(0), 300);',
				'',
			].join('\n'),
		);
		const outcome = await new Promise<RunnerOutcome>((resolve) => {
			const child = spawn(TSX_BIN, [runner], {
				cwd: scratch.root,
				env: {...process.env, ...gitEnv()},
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
			child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
			child.on('close', (exitCode, signal) =>
				resolve({exitCode, signal, stdout, stderr}),
			);
		});

		expect(outcome.stderr).toContain('still in flight');
		expect(outcome.stderr).toContain('requeue');
		// NEVER 0: a CI leg or driving loop that only checks the status must see
		// a failure, which is what would have surfaced the field incident on day one.
		expect(outcome.exitCode).not.toBe(0);
	}, 60_000);
});
