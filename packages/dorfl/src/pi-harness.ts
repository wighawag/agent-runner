import {spawn, spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {
	NullHarness,
	pidAlive,
	registerHarness,
	type Harness,
	type HarnessRecord,
	type InteractiveLaunchInput,
	type InteractiveLaunchResult,
	type LaunchInput,
	type LaunchResult,
} from './harness.js';
import {generateSessionPath} from './session-path.js';
import {lastAssistantText} from './watch-session.js';
import {reapProcessGroup} from './reap-agent-tree.js';
import type {HarnessAdapter} from './config.js';

/**
 * The **pi** harness adapter (ADR §5) — the first real agent harness
 * `dorfl` drives. It fulfils the harness seam introduced by
 * `agent-workspaces` (`./harness.ts`): launch a job's work-agent command in its
 * worktree, and report liveness from **pi-native signals**.
 *
 * Two design commitments from the task + ADR §5, both encoded here:
 *
 *  1. **Invocation** is the standard work-agent prompt (the constant wrapper +
 *     the task's `## Prompt`, assembled by `./prompt.ts`) fed to the pi CLI on
 *     stdin, running non-interactively (`--print`) inside the job worktree.
 *  2. **Liveness** is reported from the **PID** (process alive?) PLUS a pointer
 *     to the pi **session file** (real activity + an audit trail) — explicitly
 *     **NOT filesystem mtime**: a live agent can think for minutes without
 *     writing any files, so mtime would mistake a thinking agent for a dead one.
 *
 * ## Session location: `--session <full-path>` (task `session-path-pi-default`)
 *
 * The adapter passes a **deterministic FULL session-FILE path** as `--session
 * <path>` (NOT `--session-dir <dir>`). The caller GENERATES that path once
 * (before launch, so `do --watch` can tail the known path) via {@link
 * generateSessionPath} and threads it in as `LaunchInput.session`; when omitted,
 * the adapter generates a default for its own cwd. pi creates+writes the session
 * at exactly that path (it CREATES a non-existent `--session` file) and
 * `--session` takes precedence over `--session-dir` (verified vs pinned pi
 * source). The default lands under pi's per-cwd sessions folder, so the
 * pi-remote dashboard sees the session and the in-place checkout stays clean.
 * The arg is ABSOLUTE and ends `.jsonl` — required, else pi treats it as a
 * session-ID lookup and exits 1 (see {@link generateSessionPath}).
 *
 * pi specifics stay BEHIND this adapter; the core (`run`, `status`, `do`) talks
 * only to the `Harness` interface. Where running real pi in CI is impractical,
 * the pi CLI is stubbed (see `pi-harness.test.ts`) via the injectable `piBin`.
 *
 * ## Seam contract (what an adapter promises the core)
 *
 *  - `launch(input)` runs the work-agent command for ONE job in `input.dir`
 *    (the worktree), feeding `input.prompt` to the agent. It returns
 *    `{ok, record, detail?}`: `ok` iff the agent completed successfully, and a
 *    `record` to persist in `.dorfl-job.json` carrying the **liveness
 *    anchor** (`pid`) plus the pi `session` FILE path. The core treats the call
 *    as blocking (it runs the test gate immediately after).
 *  - `isAlive(record)` answers liveness FROM THE RECORD'S ANCHOR (PID/session),
 *    never mtime, so a separate `status`/`do` process can re-derive liveness
 *    from a fresh process WITHOUT re-launching the agent.
 */

/** The default pi CLI binary name (resolved on `PATH`). */
export const DEFAULT_PI_BIN = 'pi';

/**
 * The grace period between a deadline SIGTERM and the follow-up SIGKILL in
 * {@link PiHarness.launchAsync} (spec `graceful-pre-timeout-wip-checkpoint`).
 * Ten seconds gives pi enough time to flush its session `.jsonl` and exit
 * cleanly; a wedged/frozen child that ignores SIGTERM still gets reaped in a
 * bounded time so the promise settles and the caller's checkpoint routing runs.
 */
export const DEADLINE_SIGKILL_GRACE_MS = 10_000;

export interface PiHarnessOptions {
	/**
	 * The pi CLI binary (default `pi` on `PATH`). Tests inject a stub script here
	 * so the seam can be exercised without a real model call / network.
	 */
	piBin?: string;
	/**
	 * Extra arguments inserted before the `--print` invocation (e.g. a pinned
	 * `--model`). The adapter always supplies `--print` + `--session <path>`;
	 * these layer on top for operator control.
	 */
	extraArgs?: string[];
}

/**
 * The pi harness block persisted in a job record. It extends the base
 * {@link HarnessRecord} with pi's concrete liveness pointer — the **session
 * file** — alongside the PID. `gc`/`status` re-derive liveness from these without
 * re-launching pi.
 */
export interface PiHarnessRecord extends HarnessRecord {
	adapter: 'pi';
	/** Absolute path to the pi session `.jsonl` file (the activity + audit pointer). */
	session?: string;
}

/**
 * The pi adapter. Invocation: `pi [--model <model>] --print --session
 * <full-path>.jsonl [extra]` run in the worktree with the work-agent prompt on
 * stdin. The model is passed NATIVELY as `--model <model>` when set (ADR §13 —
 * the routing intent dorfl controls); auth/keys stay pi's job, never
 * dorfl's. Liveness: the PID is the authoritative "is it running?"
 * signal; the recorded `session` file is the activity + audit pointer surfaced
 * alongside it. NEVER mtime (ADR §5).
 */
export class PiHarness implements Harness {
	readonly adapter = 'pi';
	private readonly piBin: string;
	private readonly extraArgs: string[];

	constructor(options: PiHarnessOptions = {}) {
		this.piBin = options.piBin ?? DEFAULT_PI_BIN;
		this.extraArgs = options.extraArgs ?? [];
	}

	/**
	 * Resolve the full session-FILE path for a launch. The CALLER normally
	 * generates this (via {@link generateSessionPath}) and passes it in
	 * `input.session` so the watcher knows it BEFORE launch; when omitted (e.g. a
	 * direct adapter call), generate a default under pi's per-cwd folder from the
	 * launch dir. Either way the result is absolute and ends `.jsonl`.
	 */
	private resolveSessionFile(input: LaunchInput): string {
		return (
			input.session ?? generateSessionPath({cwd: input.dir, id: input.slug})
		);
	}

	/** Build the pi argv: `[--model m] [extra] --print --session <file>`. */
	private buildArgs(input: LaunchInput, sessionFile: string): string[] {
		// The model ROUTING intent (ADR §13): when set, pass it NATIVELY as
		// `--model <model>`. dorfl only chooses the model; pi owns auth/keys.
		const modelArgs =
			input.model !== undefined && input.model !== ''
				? ['--model', input.model]
				: [];
		// Non-interactive (`--print`): pi processes the prompt and exits. We pass
		// the FULL session FILE path (`--session`, never `--session-dir`): pi
		// creates+writes it there, it is visible to the dashboard, and nothing
		// lands in the checkout. The operator's `extraArgs` still layer on.
		return [
			...modelArgs,
			...this.extraArgs,
			'--print',
			'--session',
			sessionFile,
		];
	}

	launch(input: LaunchInput): LaunchResult {
		const sessionFile = this.resolveSessionFile(input);
		const args = this.buildArgs(input, sessionFile);
		const result = spawnSync(this.piBin, args, {
			// Spawn pi with cwd = the repo/worktree dir so the NEW session's header
			// `cwd` groups it correctly in the dashboard (invariant #3) — the folder
			// does NOT imply the repo.
			cwd: input.dir,
			encoding: 'utf8',
			input: input.prompt,
			env: input.env ?? process.env,
			maxBuffer: 64 * 1024 * 1024,
		});
		if (result.error) {
			throw new Error(
				`failed to spawn pi (${this.piBin}): ${result.error.message}`,
			);
		}
		// Record the pi child's PID (the liveness anchor) + the exact session FILE
		// path pi used (the pi-native activity + audit trail). Liveness later reads
		// these — NOT a filesystem mtime (ADR §5).
		const record: PiHarnessRecord = {
			adapter: 'pi',
			pid: result.pid,
			command: [this.piBin, ...args].join(' '),
			session: sessionFile,
		};
		const status = result.status ?? -1;
		return {
			ok: status === 0,
			record,
			detail: status === 0 ? undefined : (result.stderr ?? '').trim(),
			// The agent's ANSWER (task `harness-agent-output`): the LAST assistant
			// turn's text read from the session `.jsonl` pi just wrote — NOT piped
			// stdout (which is drained). Shares `watch-session.ts`'s reader.
			output: readLastAssistantText(sessionFile),
		};
	}

	/**
	 * The ASYNC twin of {@link launch} — IDENTICAL semantics (same `--print
	 * --session <file>` invocation, same prompt on stdin, output still CAPTURED,
	 * same `LaunchResult` shape: PID anchor + session pointer + ok/detail), but
	 * launched NON-BLOCKING with `spawn` instead of the synchronous `spawnSync`.
	 * This is the one structural carve-out the `do --watch` observer needs (task
	 * `do-watch`): `spawnSync` blocks the event loop until pi exits, so NOTHING
	 * could tail the growing session `.jsonl` concurrently. `launchAsync` runs pi
	 * alongside the tailer; the WHOLE launch delta is `spawnSync` → `spawn`. The
	 * prompt is still fed on stdin and stdout/stderr are still captured; we read
	 * the `.jsonl` LOG, never piped stdout.
	 *
	 * ## Resolve on `exit`, NOT `close` (runner-hang fix)
	 *
	 * The promise resolves on the child's **`exit`** event (pi itself terminated),
	 * NOT `close`. `close` fires only once EVERY stdio pipe of the child is closed
	 * — which includes pipes INHERITED by any grandchild pi spawned (an MCP server,
	 * a model proxy, a subshell). If such a grandchild OUTLIVES pi holding the
	 * inherited stdout/stderr write end, `close` never fires and this promise never
	 * resolves — the `advance --watch` surface/triage/apply leg then finishes its
	 * work but its awaited launch hangs forever, burning a CI runner (and one of the
	 * `max-parallel` slots) until cancelled. `exit` fires the instant pi exits, so
	 * we key completion off pi's OWN death, not its descendants'. We still read the
	 * agent's answer from the `.jsonl` (final once pi exited, independent of
	 * stdout), then DESTROY our end of the stdio pipes so a leaked grandchild's
	 * inherited FDs release what they can. A lingering grandchild may still hold an
	 * OS pipe end open (keeping the event loop non-empty); the CLI verbs that call
	 * this path `process.exit(code)` after the awaited result, which is the
	 * belt-and-suspenders backstop bounding any such residual leak.
	 */
	launchAsync(input: LaunchInput): Promise<LaunchResult> {
		const sessionFile = this.resolveSessionFile(input);
		const args = this.buildArgs(input, sessionFile);
		const record: PiHarnessRecord = {
			adapter: 'pi',
			command: [this.piBin, ...args].join(' '),
			session: sessionFile,
		};
		return new Promise<LaunchResult>((resolve, reject) => {
			const child = spawn(this.piBin, args, {
				// Same as `launch`: spawn in the repo/worktree dir so the session
				// header `cwd` groups the dashboard correctly (invariant #3).
				cwd: input.dir,
				env: input.env ?? process.env,
				stdio: ['pipe', 'pipe', 'pipe'],
				// PROCESS-GROUP LEADER (observation
				// `checkpoint-releases-lock-while-predecessor-agent-still-writes`): pi's
				// pgid becomes its own pid, so the deadline stop can signal the WHOLE
				// agent tree with `kill(-pgid)` and VERIFY it is gone. Without this,
				// `child.kill()` reached exactly one pid: subagents / MCP servers / tool
				// subshells survived, were re-parented to init (so no ppid walk could even
				// find them), and kept writing into the worktree while a SUCCESSOR agent
				// was already editing it. A pgid is inherited by every descendant and is
				// unaffected by re-parenting, which is why it is the only usable handle.
				// We deliberately do NOT `unref()` here: the parent keeps supervising the
				// child (and forwards its own termination to the group, below).
				detached: true,
			});
			record.pid = child.pid; // the liveness anchor, recorded like spawnSync.
			// The group id equals the leader's pid because we spawned `detached`.
			const pgid = child.pid;
			// `detached: true` takes pi OUT of our terminal's foreground process group,
			// so a Ctrl-C / `kill` aimed at the runner would no longer reach it — which
			// would WIDEN the very "aborting `do` does not kill the spawned agent tree"
			// gap this change is closing. Forward our own termination to the group for
			// as long as the child is live, so detaching strictly improves reachability
			// instead of trading one orphan class for another.
			const forwardSignal = (signal: NodeJS.Signals) => (): void => {
				if (pgid === undefined) {
					return;
				}
				try {
					process.kill(-pgid, signal);
				} catch {
					// Already gone; nothing to forward to.
				}
			};
			const onSigint = forwardSignal('SIGINT');
			const onSigterm = forwardSignal('SIGTERM');
			process.on('SIGINT', onSigint);
			process.on('SIGTERM', onSigterm);
			const stopForwarding = (): void => {
				process.off('SIGINT', onSigint);
				process.off('SIGTERM', onSigterm);
			};
			let stderr = '';
			child.stderr?.on('data', (chunk: Buffer) => {
				stderr += chunk.toString('utf8');
			});
			// Output is CAPTURED (not piped through) — `--watch` reads the .jsonl log,
			// not stdout. We drain stdout so the pipe never fills and stalls pi.
			child.stdout?.on('data', () => {});
			// Guard so `exit` and a late `error` never double-settle the promise.
			let settled = false;
			let timedOut = false;
			// DEADLINE RACE (spec `graceful-pre-timeout-wip-checkpoint`): when the
			// caller threads a `deadlineMs` (absolute wall-clock epoch-ms), arm a
			// SOFT SIGTERM at that time, then a HARD SIGKILL after a ~10s grace. The
			// child's own `exit` handler below still resolves the promise (with
			// `timedOut: true`), so we preserve the settle-once + FD-release
			// discipline and never double-settle. A run that finishes BEFORE the
			// deadline clears both timers (see the `exit` handler) — byte-for-byte
			// unchanged from the pre-task behaviour.
			let softTimer: NodeJS.Timeout | undefined;
			let hardTimer: NodeJS.Timeout | undefined;
			const clearDeadlineTimers = (): void => {
				if (softTimer !== undefined) {
					clearTimeout(softTimer);
					softTimer = undefined;
				}
				if (hardTimer !== undefined) {
					clearTimeout(hardTimer);
					hardTimer = undefined;
				}
			};
			if (input.deadlineMs !== undefined) {
				const softMs = Math.max(0, input.deadlineMs - Date.now());
				softTimer = setTimeout(() => {
					if (settled) {
						return;
					}
					timedOut = true;
					// Signal the whole GROUP, not just pi: the descendants are exactly the
					// processes that outlive it and keep writing to the worktree.
					try {
						if (pgid !== undefined) {
							process.kill(-pgid, 'SIGTERM');
						} else {
							child.kill('SIGTERM');
						}
					} catch {
						// Best-effort: an already-exited group throws ESRCH; the `exit`
						// handler will still settle the promise, and the post-exit reap below
						// is what actually VERIFIES the tree is gone.
					}
					hardTimer = setTimeout(() => {
						if (settled) {
							return;
						}
						try {
							if (pgid !== undefined) {
								process.kill(-pgid, 'SIGKILL');
							} else {
								child.kill('SIGKILL');
							}
						} catch {
							// Best-effort: see above.
						}
					}, DEADLINE_SIGKILL_GRACE_MS);
					hardTimer.unref?.();
				}, softMs);
				softTimer.unref?.();
			}
			child.on('error', (err) => {
				if (settled) {
					return;
				}
				settled = true;
				clearDeadlineTimers();
				stopForwarding();
				reject(new Error(`failed to spawn pi (${this.piBin}): ${err.message}`));
			});
			// Resolve on `exit` (pi itself terminated), NOT `close`: `close` waits for
			// EVERY child stdio pipe to close, including any INHERITED by a grandchild
			// pi spawned that outlives it — which would hang this promise forever (see
			// the doc-comment above). Then destroy our stdio ends to release the pipes.
			child.on('exit', (code) => {
				if (settled) {
					return;
				}
				settled = true;
				clearDeadlineTimers();
				stopForwarding();
				// Release our end of the stdio pipes so a leaked grandchild's inherited
				// FDs stop keeping our streams referenced; `unref` the child handle too.
				child.stdout?.destroy();
				child.stderr?.destroy();
				child.stdin?.destroy();
				child.unref?.();
				const status = code ?? -1;
				const settleWith = (reap?: LaunchResult['reap']): void => {
					resolve({
						ok: status === 0 && !timedOut,
						record,
						detail:
							status === 0 && !timedOut
								? undefined
								: stderr.trim() || undefined,
						timedOut: timedOut ? true : undefined,
						...(reap ? {reap} : {}),
						// Read the agent's ANSWER from the `.jsonl` at `exit` — the same
						// last-assistant-text read `launch` does at return (task
						// `harness-agent-output`); the process has exited so the log is final.
						output: readLastAssistantText(sessionFile),
					});
				};
				if (!timedOut || pgid === undefined) {
					// Normal exit: we signalled nothing, so there is nothing to prove and
					// nothing to kill. Byte-for-byte the pre-existing behaviour — in
					// particular we do NOT reap a group the agent may have deliberately left
					// running behind a successful run.
					settleWith();
					return;
				}
				// DEADLINE STOP: pi's own exit says NOTHING about its descendants — that
				// assumption is the defect. Before this promise resolves (which is the
				// runner's cue to save WIP, release the lock and dispatch a SUCCESSOR into
				// this same worktree), reap the group and VERIFY it is gone. Bounded by
				// construction, so this cannot reintroduce the resolve-on-`exit` hang the
				// doc-comment above guards against: a tree that will not die resolves with
				// `reaped: false` and the caller refuses to release the lock.
				void reapProcessGroup({pgid})
					.then((result) => {
						settleWith({
							reaped: result.reaped,
							pgid,
							escalatedToSigkill: result.escalatedToSigkill,
							detail: result.detail,
						});
					})
					.catch((err: unknown) => {
						// A throw here means we could not even RUN the verification, which is
						// indistinguishable from "might still be alive" — report it as an
						// unproven reap rather than silently claiming success.
						settleWith({
							reaped: false,
							pgid,
							detail:
								`could not verify that the agent process group ${pgid} exited ` +
								`(${err instanceof Error ? err.message : String(err)}); treating ` +
								'the predecessor as possibly still writing to the worktree.',
						});
					});
			});
			// Feed the same prepared prompt on stdin, then close it (pi reads to EOF).
			if (input.prompt !== undefined) {
				child.stdin?.write(input.prompt);
			}
			child.stdin?.end();
		});
	}

	/**
	 * Launch pi INTERACTIVELY (task `agent-interactive-launch`, decision #2): a
	 * FOREGROUND human session in `input.dir`. The whole delta from {@link launch}
	 * is the stdio contract:
	 *
	 *  - **NO `--print`** — a real interactive session the human types into (the
	 *    autonomous form is `pi --print …`, prompt on stdin, captured).
	 *  - **`stdio: 'inherit'`** — the human's terminal IS pi's terminal (foreground).
	 *  - **NO piped prompt** — the human drives; nothing is fed on stdin.
	 *  - **`--model <model>`** still flows in when set (ADR §13: the resolved
	 *    routing pins the human's starting model; they may switch inside pi).
	 *  - **`--session <path>`** is STILL passed so the human session is recorded /
	 *    dashboard-visible (audit trail), exactly as the autonomous path records it.
	 *
	 * It BLOCKS in the foreground until the human exits (`spawnSync` + inherited
	 * stdio), then returns their exit code. It is NOT a tracked job (decision #3):
	 * no `.dorfl-job.json`, no PID/liveness record, no gate — there is
	 * nothing to capture, so it returns only the exit code.
	 */
	launchInteractive(input: InteractiveLaunchInput): InteractiveLaunchResult {
		const sessionFile = this.resolveSessionFile({
			dir: input.dir,
			slug: input.slug,
			command: '',
			session: input.session,
		});
		// The model ROUTING intent (ADR §13): when set, pass it NATIVELY as
		// `--model <model>`. dorfl only chooses the model; pi owns auth/keys.
		const modelArgs =
			input.model !== undefined && input.model !== ''
				? ['--model', input.model]
				: [];
		// NO `--print` (a real foreground session), but STILL `--session <path>` so
		// the human session is recorded + dashboard-visible. The operator's
		// `extraArgs` still layer on.
		const args = [...modelArgs, ...this.extraArgs, '--session', sessionFile];
		const result = spawnSync(this.piBin, args, {
			// Run in the onboarded working tree so the session header `cwd` groups it
			// correctly in the dashboard (invariant #3) and the human starts there.
			cwd: input.dir,
			// INHERIT the human's stdio: their terminal IS pi's terminal (foreground,
			// interactive) — the opposite of the captured autonomous launch.
			stdio: 'inherit',
			env: input.env ?? process.env,
		});
		if (result.error) {
			throw new Error(
				`failed to spawn pi (${this.piBin}): ${result.error.message}`,
			);
		}
		return {exitCode: result.status ?? -1};
	}

	isAlive(record: HarnessRecord): boolean {
		return pidAlive(record.pid);
	}

	/**
	 * The recorded pi session-FILE pointer for a job — the pi-native activity +
	 * audit trail surfaced alongside PID liveness. `undefined` when the record has
	 * no session pointer (e.g. a non-pi or legacy record). Existence on disk is
	 * reported separately so callers can distinguish "recorded but gone" from
	 * "never recorded".
	 */
	sessionPointer(record: HarnessRecord): string | undefined {
		return record.session;
	}
}

/**
 * Does a job record carry a live pi session file on disk? Combines the recorded
 * pointer with an `existsSync` check. This is the pi-native "is there an audit
 * trail to look at?" signal — distinct from PID liveness, and STILL not mtime
 * (we check existence, never modification time).
 *
 * Studied (task `pi-harness-polish`, finding
 * `work/notes/findings/pi-harness-channels.md`): the recorded `--session <path>`
 * file remains the right audit pointer even against pi's other output surfaces
 * (`--mode json` stdout stream, `--mode rpc`, in-process SDK) — those are
 * transient stdio channels that do not survive the process, whereas the session
 * file is the versioned, dashboard-visible activity trail pi itself treats as
 * the audit artefact. PID stays the liveness anchor alongside it.
 */
export function piSessionExists(record: HarnessRecord): boolean {
	return record.session !== undefined && existsSync(record.session);
}

/**
 * Read the LAST assistant message's text from the pi session `.jsonl` at
 * `sessionFile` — the agent's final ANSWER, surfaced as `LaunchResult.output`
 * (task `harness-agent-output`). Called by BOTH `launch` (at return) and
 * `launchAsync` (at `close`), AFTER pi has exited so the log is complete.
 *
 * It REUSES `watch-session.ts`'s {@link lastAssistantText} (one `.jsonl` parser,
 * not two). An absent file (pi never wrote it) yields `undefined`, as does a log
 * with no assistant text — a read error is never thrown back into the launch.
 *
 * Studied (task `pi-harness-polish`, finding
 * `work/notes/findings/pi-harness-channels.md`, pinned against pi 0.73.1 +
 * session format v3): the session `.jsonl` is the right channel for output
 * because it is the only one that is BOTH post-mortem readable AND explicitly
 * versioned + migrated (`docs/session-format.md`). The `--mode json` STDOUT
 * event stream is not versioned and is transient; `--mode rpc` and the
 * in-process SDK cost more without solving anything the file does not. The
 * cross-harness `LaunchResult.output` seam (Option C) is a bare `string | undefined`,
 * so a future stream/HTTP-shaped harness (opencode-style) still fits: the file
 * shape lives BEHIND this reader and is not observable through the seam.
 */
function readLastAssistantText(sessionFile: string): string | undefined {
	let jsonl: string;
	try {
		jsonl = readFileSync(sessionFile, 'utf8');
	} catch {
		return undefined; // no session log on disk — no answer to surface.
	}
	return lastAssistantText(jsonl);
}

// Register the pi adapter so `status`/`do`/`gc` resolve liveness for `pi` jobs
// to THIS adapter (PID + session pointer) rather than the null fallback. A
// default-configured instance is sufficient for liveness (the binary/extra args
// only matter for `launch`, which the core does via an explicit instance).
registerHarness(new PiHarness());

/**
 * Build the harness that LAUNCHES jobs for a run, from config (ADR §5): `pi`
 * ⇒ the pi adapter (invoking `config.piBin`); anything else ⇒ the null adapter
 * (shelling out to `agentCmd`). This is the single place the core turns the
 * declared `harness` selector into a concrete adapter, keeping pi specifics
 * behind the seam.
 */
export function createHarness(options: {
	harness?: HarnessAdapter;
	piBin?: string;
}): Harness {
	if (options.harness === 'pi') {
		return new PiHarness({piBin: options.piBin});
	}
	return new NullHarness();
}
