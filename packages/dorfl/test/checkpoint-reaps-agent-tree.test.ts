import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {chmodSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {PiHarness} from '../src/pi-harness.js';
import {processGroupAlive, reapProcessGroup} from '../src/reap-agent-tree.js';
import {
	acquireWorktreeWriterLock,
	readWorktreeWriter,
	writerSentinelPath,
} from '../src/worktree-writer-lock.js';
import {performDo, type DoDorfl} from '../src/do.js';
import {
	makeScratch,
	isolatePiAgentDir,
	seedRepoWithArbiter,
	stuckLockOnArbiter,
	sidecarSurfacedOnArbiterMain,
	gitEnv,
	gitIn,
	type Scratch,
} from './helpers/gitRepo.js';
import {run} from '../src/git.js';

/**
 * DEFECT 2 (observation
 * `checkpoint-releases-lock-while-predecessor-agent-still-writes`): after a
 * deadline checkpoint, TWO agents were alive in the same worktree at once.
 *
 * The checkpoint saved WIP, released the item lock, and let the next tick
 * dispatch a CONTINUATION agent into the same worktree — while the previous
 * agent was still running. Its session log kept being written for four more
 * minutes, and its final act was to append to a file the successor had already
 * read as clean in its opening `git status`. One lock, one working tree, two
 * live writers.
 *
 * The root cause is the same as Defect 1's: the checkpoint acted without
 * confirming its own side effect. `child.kill('SIGTERM')` signals exactly ONE
 * pid, and the harness treated pi's own `exit` as proof the AGENT was gone — but
 * a modern agent is a tree (subagents, MCP servers, tool subshells), and those
 * descendants both survive the parent's SIGTERM and become un-findable by ppid
 * once they are re-parented to init.
 *
 * These tests use a stub `pi` that spawns a descendant which OUTLIVES it and
 * keeps writing to the worktree — the exact observed shape — and assert the
 * launch does not resolve (i.e. the runner is not told the agent is done, and so
 * cannot release the lock or dispatch a successor) until the whole tree is
 * VERIFIED gone.
 */

let scratch: Scratch;
let restorePiAgentDir: () => void;
beforeEach(() => {
	scratch = makeScratch('dorfl-reap-tree-');
	restorePiAgentDir = isolatePiAgentDir(scratch.root);
});
afterEach(() => {
	restorePiAgentDir();
	scratch.cleanup();
});

/**
 * A stub `pi` that models the observed failure shape: it spawns a BACKGROUND
 * DESCENDANT which keeps appending to `writesTo` every 50ms, then the pi process
 * itself exits promptly on SIGTERM. The descendant does NOT die with its parent
 * and does NOT install a SIGTERM handler of its own — it only dies because the
 * whole process GROUP is signalled.
 *
 * `descendantIgnoresSigterm` makes the descendant trap and IGNORE SIGTERM, so the
 * reap has to escalate to SIGKILL to prove the tree gone.
 */
function writeSlowAgentStub(opts: {
	writesTo: string;
	descendantIgnoresSigterm?: boolean;
}): string {
	const bin = join(scratch.root, 'pi-slow-agent.sh');
	const trap = opts.descendantIgnoresSigterm
		? "trap '' TERM"
		: '# descendant takes the default SIGTERM disposition';
	const script = [
		'#!/usr/bin/env bash',
		// Honour `--session <file>` the way the real adapter expects (create it).
		'session_file=""',
		'prev=""',
		'for a in "$@"; do',
		'  if [ "$prev" = "--session" ]; then session_file="$a"; fi',
		'  prev="$a"',
		'done',
		'if [ -n "$session_file" ]; then mkdir -p "$(dirname "$session_file")"; : > "$session_file"; fi',
		'cat > /dev/null', // drain the prompt on stdin
		// The DESCENDANT: keeps writing into the worktree indefinitely.
		'(',
		`  ${trap}`,
		'  while true; do',
		`    echo "descendant write $(date +%s%N)" >> ${JSON.stringify(opts.writesTo)}`,
		'    sleep 0.05',
		'  done',
		') &',
		// pi itself exits promptly when signalled, leaving the descendant behind.
		"trap 'exit 0' TERM",
		'while true; do sleep 0.05; done',
		'',
	].join('\n');
	writeFileSync(bin, script);
	chmodSync(bin, 0o755);
	return bin;
}

/** How many lines the descendant has written so far (0 when it never ran). */
function writeCount(path: string): number {
	if (!existsSync(path)) {
		return 0;
	}
	return readFileSync(path, 'utf8')
		.split('\n')
		.filter((l) => l.trim() !== '').length;
}

describe('deadline stop reaps the agent PROCESS TREE and verifies it is gone', () => {
	it('does not resolve the launch until a descendant that outlives pi has exited', async () => {
		const dir = join(scratch.root, 'worktree');
		run('mkdir', ['-p', dir], scratch.root, {env: gitEnv()});
		const writesTo = join(dir, 'predecessor-writes.txt');
		const bin = writeSlowAgentStub({writesTo});
		const harness = new PiHarness({piBin: bin});

		const result = await harness.launchAsync({
			dir,
			slug: 'reap-me',
			command: '',
			prompt: 'build it',
			session: join(scratch.root, 'sessions', 'reap-me.jsonl'),
			// Fire the deadline almost immediately.
			deadlineMs: Date.now() + 400,
			env: gitEnv(),
		});

		// The harness must report the deadline stop...
		expect(result.timedOut).toBe(true);
		// ...AND must carry PROOF about the tree, not merely a signal sent.
		expect(result.reap).toBeDefined();
		expect(result.reap!.reaped).toBe(true);
		expect(result.reap!.pgid).toBeTypeOf('number');

		// The whole group is verifiably gone at the moment the promise resolved.
		expect(processGroupAlive(result.reap!.pgid!)).toBe(false);

		// THE SUCCESSOR'S VIEW IS STABLE: whatever the predecessor had written by
		// the time we were told it was done is all it will EVER write. In the field
		// this was false — writes kept landing for four minutes after this point,
		// including onto a file the successor had already read as clean.
		const atResolve = writeCount(writesTo);
		await new Promise((r) => setTimeout(r, 400));
		expect(writeCount(writesTo)).toBe(atResolve);
	}, 20_000);

	it('escalates to SIGKILL when the tree ignores SIGTERM, and still proves it gone', async () => {
		const dir = join(scratch.root, 'worktree-stubborn');
		run('mkdir', ['-p', dir], scratch.root, {env: gitEnv()});
		const writesTo = join(dir, 'stubborn-writes.txt');
		const bin = writeSlowAgentStub({writesTo, descendantIgnoresSigterm: true});
		const harness = new PiHarness({piBin: bin});

		const result = await harness.launchAsync({
			dir,
			slug: 'stubborn',
			command: '',
			prompt: 'build it',
			session: join(scratch.root, 'sessions', 'stubborn.jsonl'),
			deadlineMs: Date.now() + 400,
			env: gitEnv(),
		});

		expect(result.timedOut).toBe(true);
		expect(result.reap!.reaped).toBe(true);
		expect(result.reap!.escalatedToSigkill).toBe(true);
		expect(processGroupAlive(result.reap!.pgid!)).toBe(false);

		const atResolve = writeCount(writesTo);
		await new Promise((r) => setTimeout(r, 400));
		expect(writeCount(writesTo)).toBe(atResolve);
	}, 30_000);

	it('a normal (non-deadline) exit reports no reap — nothing was signalled', async () => {
		// Regression guard on the untouched path: we must not start killing process
		// groups behind a run that finished on its own.
		const dir = join(scratch.root, 'worktree-clean');
		run('mkdir', ['-p', dir], scratch.root, {env: gitEnv()});
		const bin = join(scratch.root, 'pi-quick.sh');
		writeFileSync(
			bin,
			['#!/usr/bin/env bash', 'cat > /dev/null', 'exit 0', ''].join('\n'),
		);
		chmodSync(bin, 0o755);
		const harness = new PiHarness({piBin: bin});

		const result = await harness.launchAsync({
			dir,
			slug: 'quick',
			command: '',
			prompt: 'x',
			session: join(scratch.root, 'sessions', 'quick.jsonl'),
			env: gitEnv(),
		});
		expect(result.timedOut).toBeUndefined();
		expect(result.reap).toBeUndefined();
	}, 15_000);
});

describe('reapProcessGroup: signal, then VERIFY', () => {
	it('reports an already-dead group as reaped without signalling anything', async () => {
		// pid 1 / 0 must never be treated as ours to signal.
		const result = await reapProcessGroup({pgid: 1});
		expect(result.reaped).toBe(true);
		expect(result.waitedMs).toBe(0);
	});

	it('REFUSES loudly when the tree survives both SIGTERM and SIGKILL', async () => {
		// The whole point of the module: sending a signal is not evidence anything
		// died. A tree that will not die must produce `reaped: false` with a message
		// naming exactly what the caller must not do — never a quiet success.
		const result = await reapProcessGroup({
			pgid: 999_001,
			sigtermGraceMs: 5,
			sigkillTimeoutMs: 5,
			wait: async () => {},
			alive: () => true, // an unkillable descendant.
		});
		expect(result.reaped).toBe(false);
		expect(result.escalatedToSigkill).toBe(true);
		expect(result.detail).toMatch(/REFUSING TO PROCEED/);
		expect(result.detail).toMatch(/must NOT be released/);
		expect(result.detail).toMatch(/no successor agent may onboard/);
	});

	it('only reports reaped off an OBSERVATION that the group is gone', async () => {
		// The mirror of the above: it flips to reaped the moment the probe observes
		// the group gone, and reports how it went.
		let probes = 0;
		const result = await reapProcessGroup({
			pgid: 999_002,
			sigtermGraceMs: 1_000,
			sigkillTimeoutMs: 1_000,
			wait: async () => {},
			alive: () => ++probes < 3, // dies on the third probe.
		});
		expect(result.reaped).toBe(true);
		expect(result.escalatedToSigkill).toBe(false);
		expect(result.detail).toMatch(/verified gone/);
	});
});

describe('checkpoint refuses to hand over the worktree without proof', () => {
	it('SURFACES instead of releasing the lock when the agent is not verifiably dead', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, ['unreaped']);
		// A deadline stop whose reap FAILED: the predecessor may still be writing.
		const timeoutAgent: DoDorfl = ({cwd}) => {
			writeFileSync(join(cwd, 'checkpoint-work.txt'), 'partial work\n');
			return {
				ok: false,
				timedOut: true,
				reap: {
					reaped: false,
					pgid: 424242,
					detail:
						'REFUSING TO PROCEED: agent process group 424242 is STILL ALIVE',
				},
			};
		};

		const result = await performDo({
			arg: 'unreaped',
			cwd: repo,
			arbiter: 'arbiter',
			integration: 'merge',
			verify: 'exit 0',
			dorfl: timeoutAgent,
			env: gitEnv(),
			// Well under the ceiling and WITH progress: without the reap gate this
			// would have auto-continued and released the lock.
			maxAutoCheckpoints: 5,
		});

		// It must NOT auto-continue (which releases the lock and lets the next tick
		// dispatch a successor into this same worktree).
		expect(result.outcome).not.toBe('deadline-auto-continued');
		expect(result.outcome).toBe('deadline-surfaced');
		// The reason must SAY why, in the operator's terms.
		expect(result.message).toMatch(
			/NOT verifiably stopped|could not be verified/i,
		);
		// And the item is surfaced for a human rather than silently re-queued.
		expect(sidecarSurfacedOnArbiterMain(repo, 'unreaped')).toBe(true);

		// The work is still SAVED + pushed (never lose work): only the hand-off is
		// withheld.
		run('git', ['fetch', '-q', 'arbiter'], repo, {env: gitEnv()});
		const tip = gitIn(
			[
				'rev-parse',
				'--verify',
				'--quiet',
				'arbiter/work/task-unreaped^{commit}',
			],
			repo,
		).trim();
		expect(tip).not.toBe('');
	}, 20_000);

	it('AUTO-CONTINUES normally when the reap is verified', async () => {
		// The control: the same run with a successful reap keeps today's behaviour.
		const {repo} = seedRepoWithArbiter(scratch.root, ['reaped']);
		const timeoutAgent: DoDorfl = ({cwd}) => {
			writeFileSync(join(cwd, 'checkpoint-work.txt'), 'partial work\n');
			return {
				ok: false,
				timedOut: true,
				reap: {reaped: true, pgid: 4242, detail: 'exited on SIGTERM'},
			};
		};
		const result = await performDo({
			arg: 'reaped',
			cwd: repo,
			arbiter: 'arbiter',
			integration: 'merge',
			verify: 'exit 0',
			dorfl: timeoutAgent,
			env: gitEnv(),
			maxAutoCheckpoints: 5,
		});
		expect(result.outcome).toBe('deadline-auto-continued');
		expect(stuckLockOnArbiter(repo, 'reaped')).toBe(false);
	}, 20_000);
});

describe('per-worktree writer sentinel: the WORKING TREE guard', () => {
	function worktree(label: string): string {
		const dir = join(scratch.root, label);
		run('mkdir', ['-p', dir], scratch.root, {env: gitEnv()});
		gitIn(['init', '-q', '-b', 'main'], dir);
		writeFileSync(join(dir, 'README.md'), '# x\n');
		gitIn(['add', '-A'], dir);
		gitIn(['commit', '-q', '-m', 'seed'], dir);
		return dir;
	}

	it('lives in the private git dir, so it can never show up in `git status`', () => {
		const dir = worktree('sentinel-hidden');
		const lock = acquireWorktreeWriterLock({dir, slug: 'a', env: gitEnv()});
		expect(lock.acquired).toBe(true);
		const path = writerSentinelPath(dir, gitEnv());
		expect(path).toBeTruthy();
		expect(existsSync(path!)).toBe(true);
		// Nothing in the working tree changed: no new exclusion is needed in the
		// empty-diff backstop or gc's cleanliness predicate.
		const status = run('git', ['status', '--porcelain'], dir, {env: gitEnv()});
		expect(status.stdout.trim()).toBe('');
		if (lock.acquired) {
			lock.release();
		}
		expect(existsSync(path!)).toBe(false);
	});

	it('REFUSES a second writer while the first is live, keyed on the TREE not the item', () => {
		const dir = worktree('sentinel-refuses');
		const env = gitEnv();
		// A GENUINELY LIVE foreign holder: spawn a real long-lived process and record
		// its pid. Deriving a "probably alive" pid arithmetically is not deterministic
		// (and flaked under parallel load), so hold a real one for the test's duration.
		const holder = spawn('sleep', ['30'], {stdio: 'ignore'});
		try {
			expect(holder.pid).toBeTypeOf('number');
			const sentinel = writerSentinelPath(dir, env)!;
			writeFileSync(
				sentinel,
				JSON.stringify({
					pid: holder.pid,
					slug: 'first-item',
					startedAt: new Date().toISOString(),
				}),
			);

			// A DIFFERENT item in the SAME tree must still be refused: the TREE is the
			// guarded resource, not the item (which is what the item lock guards).
			const second = acquireWorktreeWriterLock({
				dir,
				slug: 'second-item',
				env,
			});
			expect(second.acquired).toBe(false);
			if (!second.acquired) {
				expect(second.holder?.slug).toBe('first-item');
				expect(second.reason).toMatch(/LIVE agent writer/);
				expect(second.reason).toMatch(/two live agents in one tree/i);
			}
		} finally {
			holder.kill('SIGKILL');
		}
	});

	it('takes over a STALE sentinel so a killed runner cannot poison the worktree', () => {
		const dir = worktree('sentinel-stale');
		const env = gitEnv();
		const sentinel = writerSentinelPath(dir, env)!;
		// A holder that is definitely dead (pid 2^22 is beyond any live pid here,
		// and no pgid recorded).
		writeFileSync(
			sentinel,
			JSON.stringify({
				pid: 4_194_303,
				slug: 'crashed-run',
				startedAt: new Date(0).toISOString(),
			}),
		);
		const taken = acquireWorktreeWriterLock({dir, slug: 'fresh', env});
		expect(taken.acquired).toBe(true);
		expect(readWorktreeWriter(dir, env)?.slug).toBe('fresh');
	});

	it('treats a corrupt sentinel as absent (self-healing, never wedged)', () => {
		const dir = worktree('sentinel-corrupt');
		const env = gitEnv();
		writeFileSync(writerSentinelPath(dir, env)!, 'not json at all');
		const taken = acquireWorktreeWriterLock({dir, slug: 'fresh', env});
		expect(taken.acquired).toBe(true);
	});

	it('is a no-op outside a git worktree rather than a new failure mode', () => {
		const dir = join(scratch.root, 'not-a-repo');
		run('mkdir', ['-p', dir], scratch.root, {env: gitEnv()});
		const lock = acquireWorktreeWriterLock({dir, slug: 'x', env: gitEnv()});
		expect(lock.acquired).toBe(true);
	});
});
