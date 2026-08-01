import {spawnSync} from 'node:child_process';

/**
 * The **harness seam** (ADR §5): how a job's command is launched and how its
 * liveness is observed is pluggable behind an adapter; the core never hard-codes
 * a specific tool.
 *
 * Crucially, **liveness is reported by the harness, NOT inferred from filesystem
 * mtime**: a live agent can think for minutes without writing any files, so
 * mtime would mistake a thinking agent for a dead one. Adapters answer liveness
 * from the real signal (the PID, a session handle, …) — never mtime.
 *
 * This task ships the **null adapter** (records a PID, runs a configured
 * command) so the substrate is testable standalone. The first real target (the
 * `pi` adapter: liveness via PID + a pointer to the pi session dir/log,
 * invocation via the pi CLI) is its own task.
 */

/**
 * The persisted harness block in a job's `.dorfl-job.json` record. It
 * captures which adapter launched the job + the liveness pointer the adapter
 * needs to answer `isAlive` later (so `gc`/`status` can re-derive liveness from
 * a fresh process without re-launching). Adapter-specific fields are optional.
 */
export interface HarnessRecord {
	/** Which harness adapter owns this job (`null`, later `pi`, …). */
	adapter: string;
	/** OS process id of the launched command (the liveness anchor). */
	pid?: number;
	/** The command the adapter ran (for audit / re-launch). */
	command?: string;
	/** Adapter-specific session pointer (e.g. the pi session dir/log path). */
	session?: string;
}

/** What a harness needs to launch one job's command. */
export interface LaunchInput {
	/** The job's working directory (the worktree) — the command runs here. */
	dir: string;
	/** The slug being processed (for adapters that name/log per slug). */
	slug: string;
	/** The command to run (e.g. the configured `agentCmd`). */
	command: string;
	/** Optional prompt fed on the command's stdin. */
	prompt?: string;
	/**
	 * The model the agent should run on (the harness-agnostic routing intent, ADR
	 * §13). `undefined` ⇒ dorfl forces no model. The ADAPTER decides HOW
	 * this reaches its tool: the pi adapter passes `--model <model>` natively; the
	 * null/shell adapter substitutes a `{model}` placeholder in `command` (see
	 * {@link substituteModel}). auth/keys are NEVER carried here — they stay the
	 * harness's job.
	 */
	model?: string;
	/**
	 * The full pi session-FILE path the adapter passes as `--session <path>` (the
	 * caller generates it ONCE — before launch, so the `do --watch` tailer can tail
	 * the KNOWN path — via {@link generateSessionPath} from the resolved
	 * `sessionsDir` + cwd). Adapter-agnostic: the pi adapter uses it verbatim and
	 * records it in `PiHarnessRecord.session`; the null/shell adapter ignores it.
	 * `undefined` ⇒ the pi adapter falls back to a generated default for its cwd.
	 */
	session?: string;
	/**
	 * **Optional agent-session DEADLINE** (absolute epoch-ms wall-clock timestamp)
	 * for the ASYNC {@link Harness} launch (spec
	 * `graceful-pre-timeout-wip-checkpoint`). When set AND the future arrives
	 * before the child exits, the harness sends SIGTERM (a ~10s grace, then
	 * SIGKILL) and resolves the {@link LaunchResult} with `timedOut: true` — so
	 * the caller can route the run as a CHECKPOINT (save WIP + auto-continue /
	 * surface) rather than a generic agent-failure. Ignored on the synchronous
	 * {@link Harness.launch} path (`spawnSync` cannot be interrupted from the
	 * same event loop; the async path is where CI's `--watch` legs run and where
	 * the checkpoint discipline lives). Absent ⇒ no deadline (byte-for-byte the
	 * pre-task behaviour: a run finishing before its deadline is unchanged; on
	 * `exit` the timer is cleared).
	 */
	deadlineMs?: number;
	env?: NodeJS.ProcessEnv;
}

/**
 * What a harness needs to launch one item's harness INTERACTIVELY (task
 * `agent-interactive-launch`): a FOREGROUND human session in `dir`, inherited
 * stdio, NO prepared prompt. This is the OPPOSITE shape to {@link LaunchInput}
 * (which feeds a prompt on stdin and captures output for the autonomous path):
 * here the human drives the agent, so there is nothing to feed and nothing to
 * capture. A NEW seam intent, NOT a flag on {@link Harness.launch} (decision #1):
 * `launch` is fundamentally spawnSync + prompt-on-stdin + capture-output, and a
 * boolean would make its `LaunchResult` lie.
 */
export interface InteractiveLaunchInput {
	/** The onboarded working tree to start the session in (the command runs here). */
	dir: string;
	/** The slug being worked on (for adapters that name/log per slug). */
	slug: string;
	/**
	 * The resolved model the human starts pinned to (ADR §13 routing: flag > env
	 * > per-repo > global). `undefined` ⇒ no model forced. The pi adapter passes
	 * `--model <model>`; the human may still switch models inside the session.
	 */
	model?: string;
	/**
	 * The full pi session-FILE path passed as `--session <path>` so the human
	 * session is still recorded/visible (audit trail + the pi dashboard, decision
	 * #2). `undefined` ⇒ the pi adapter generates a default for `dir`.
	 */
	session?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * The result of an interactive launch — there is NOTHING to capture (the human
 * drove a foreground session; no prepared prompt, no piped output, no PID record
 * to persist; it is NOT a tracked job, decision #3). The only useful signal is
 * the harness's exit code, returned here. Callers may ignore it.
 */
export interface InteractiveLaunchResult {
	/** The harness process's exit code (0 = clean exit). */
	exitCode: number;
}

/**
 * What the human-face verbs (`start`/`work-on`) hand a launcher: just the
 * onboarded WORKING TREE + the slug + env. The model + the pi `--session` path
 * are resolved at the CLI boundary (where config lives) and BOUND INTO the
 * injected closure, so the git-logic modules stay decoupled from `createHarness`
 * / config resolution. The CLI's closure calls
 * {@link Harness.launchInteractive} with the resolved model/session.
 */
export interface InteractiveLaunchSite {
	/** The slug being worked on. */
	slug: string;
	/** The onboarded working tree to start the foreground session in. */
	dir: string;
	/** Environment for the launched harness process. */
	env?: NodeJS.ProcessEnv;
}

/**
 * The injectable interactive launcher the human-face verbs call AFTER
 * onboarding. The CLI binds the resolved harness + model + sessions-dir into it;
 * tests inject a spy. A thin seam so `start.ts`/`work-on.ts` never import
 * `createHarness` or resolve config.
 */
export type InteractiveLauncher = (site: InteractiveLaunchSite) => void;

/** The `{model}` placeholder the null/shell adapter substitutes in `agentCmd`. */
export const MODEL_PLACEHOLDER = '{model}';

/**
 * Inject the model ROUTING intent (ADR §13) into a shell `command` for the
 * null/shell adapter, with three degradation rules so model routing is OFFERED,
 * never FORCED:
 *
 *  1. `{model}` present + `model` set ⇒ substitute every occurrence.
 *  2. `{model}` present + `model` unset ⇒ a clear config error (we never emit a
 *     literal `{model}` to the shell — that would silently misroute).
 *  3. `{model}` absent ⇒ return `command` as-is (a user who bakes the model into
 *     `agentCmd`, or relies on the harness's own default, is untouched).
 *
 * dorfl only moves the model INTENT; auth/keys stay the harness's job.
 */
export function substituteModel(
	command: string,
	model: string | undefined,
): string {
	if (!command.includes(MODEL_PLACEHOLDER)) {
		return command; // rule 3: no placeholder ⇒ run as-is.
	}
	if (model === undefined || model === '') {
		throw new Error(
			`agentCmd contains a ${MODEL_PLACEHOLDER} placeholder but no model is ` +
				`configured. Set a model (--model, DORFL_MODEL, per-repo, or ` +
				`global config) or remove ${MODEL_PLACEHOLDER} from agentCmd.`,
		);
	}
	return command.split(MODEL_PLACEHOLDER).join(model); // rule 1: substitute.
}

export interface LaunchResult {
	/** True iff the launched command completed successfully. */
	ok: boolean;
	/** The harness block to persist in the job record (PID, command, …). */
	record: HarnessRecord;
	/** Failure detail when `ok` is false (the stderr/failure channel). */
	detail?: string;
	/**
	 * **True iff the launch was stopped by the dorfl-internal DEADLINE**
	 * ({@link LaunchInput.deadlineMs}) rather than exiting on its own (spec
	 * `graceful-pre-timeout-wip-checkpoint`). Distinct from `ok` (a deadline
	 * stop is neither a success nor a generic failure — it is a CHECKPOINT the
	 * caller routes through the save+auto-continue/surface path). Absent/false
	 * when the child exited before the deadline, so a run that finishes
	 * normally is byte-for-byte unchanged.
	 */
	timedOut?: boolean;
	/**
	 * The agent's final ANSWER (task `harness-agent-output`): the concatenated
	 * `text` of the LAST assistant turn the invocation produced. This is the
	 * channel for the agent's OUTPUT on success — DISTINCT from {@link detail},
	 * which is the failure/`stderr` channel. `undefined` when the invocation
	 * produced no parseable assistant text.
	 *
	 * Per-adapter EXTRACTION from each tool's native channel (Option C, decided
	 * 2026-06-06): pi reads the last assistant message from the session `.jsonl`
	 * it wrote (via `watch-session.ts`'s shared reader); the null/shell adapter
	 * returns its captured (synchronous) command stdout. The forward-contract for
	 * an opencode adapter (not built yet) is to take the last assistant `text`
	 * part from its `--format json` stream — the SAME `output` field.
	 */
	output?: string;
	/**
	 * **The verified outcome of reaping the agent's process TREE** after a deadline
	 * stop (observation
	 * `checkpoint-releases-lock-while-predecessor-agent-still-writes`).
	 *
	 * Only present when {@link timedOut} is set — i.e. when the harness itself
	 * signalled the agent and therefore owes the caller PROOF that it is gone
	 * rather than merely signalled. `reaped: false` means a descendant may still be
	 * writing to the worktree, so the caller MUST NOT release the item lock or let
	 * a successor agent onboard there (see `do.ts`'s deadline routing).
	 *
	 * Absent on a normal exit (nothing was signalled, so there is nothing to prove)
	 * and on adapters that do not spawn a killable process group.
	 */
	reap?: AgentTreeReap;
}

/**
 * The harness-reported result of reaping a stopped agent's process tree — the
 * adapter-agnostic projection of `reap-agent-tree.ts`'s `ReapResult`.
 */
export interface AgentTreeReap {
	/** True iff the tree is VERIFIED gone (observed, not merely signalled). */
	reaped: boolean;
	/** The process group that was reaped (the agent's group-leader pid). */
	pgid?: number;
	/** True iff SIGKILL was needed because the tree ignored SIGTERM. */
	escalatedToSigkill?: boolean;
	/** Human-readable account — the LOUD text when `reaped` is false. */
	detail: string;
}

/**
 * The harness seam. `launch` starts the job's command + returns the record (with
 * the liveness anchor); `isAlive` answers liveness FROM THE HARNESS (PID/session
 * — never mtime, ADR §5).
 */
export interface Harness {
	/** A stable adapter name (`null`, `pi`, …) stamped into the record. */
	readonly adapter: string;
	/** Launch the job's command; record the PID + liveness pointer. */
	launch(input: LaunchInput): LaunchResult;
	/**
	 * Launch the harness INTERACTIVELY (task `agent-interactive-launch`): a
	 * FOREGROUND human session in `input.dir` with INHERITED stdio and NO prepared
	 * prompt — the human drives it, and control returns when they exit. This is
	 * the human-facing counterpart to the autonomous {@link launch}; it is NOT a
	 * tracked job (no `.dorfl-job.json`, no PID/liveness record, no gate,
	 * decision #3), so it returns only an exit code. pi-only: the null adapter
	 * throws a clear pi-only error (decision #2).
	 */
	launchInteractive(input: InteractiveLaunchInput): InteractiveLaunchResult;
	/** Is the job still alive? Answered from the record's anchor, NOT mtime. */
	isAlive(record: HarnessRecord): boolean;
}

/**
 * Is this `spawnSync.error` a BENIGN failure of the prompt write, safe to
 * ignore? The null/shell adapter feeds `input.prompt` to the child on stdin
 * (`spawnSync('bash', …, {input})`). When the prompt is EMPTY — the autonomous
 * review/arbiter launches that just shell out and capture stdout — a child that
 * closes its stdin before the parent's (zero-byte) write surfaces as `EPIPE`
 * under concurrent test load. That write failing is harmless: there was nothing
 * to deliver, and the child's stdout/exit status are still captured normally.
 * So we treat ONLY `EPIPE` as benign and let every OTHER spawn error (`ENOENT`,
 * `EACCES`, buffer overflow, …) throw — those are real launch failures.
 */
export function isBenignPromptWriteError(error: Error): boolean {
	return (error as NodeJS.ErrnoException).code === 'EPIPE';
}

/**
 * The **null adapter**: runs the configured command synchronously to completion
 * in the job dir, recording the PID. Liveness is `process.kill(pid, 0)` against
 * the recorded PID (the OS process table) — explicitly NOT a file mtime. Because
 * it runs synchronously, the process has already exited by the time `launch`
 * returns, so a finished job reads as not-alive (which is correct).
 */
export class NullHarness implements Harness {
	readonly adapter = 'null';

	launch(input: LaunchInput): LaunchResult {
		// BACKSTOP (config error, NOT a spawn failure): an empty/whitespace command
		// resolves the null adapter to `bash -c ''`, which exits 0 with no output — a
		// "successful" build that ran NOTHING. The `do`/`run`/`--remote` CLI sites
		// already refuse this up-front (doNeedsAgentCmd), but THIS seam can be reached
		// by other callers (tests, embeddings, future paths), so it must refuse too.
		// Distinct from the `result.error` spawn-failure throw below: this names the
		// config cause + the fix, in the voice of `launchInteractive`/`substituteModel`.
		if (input.command.trim() === '') {
			throw new Error(
				'no command to run: the null/shell adapter was launched with an empty ' +
					'agentCmd — nothing would run. Set `agentCmd` (--agent-cmd, per-repo, or ' +
					'global config) or configure `harness: pi`.',
			);
		}
		// Inject the model routing intent into the shell command via the `{model}`
		// placeholder (ADR §13) — offered, never forced (see substituteModel).
		const command = substituteModel(input.command, input.model);
		const result = spawnSync('bash', ['-c', command], {
			cwd: input.dir,
			encoding: 'utf8',
			input: input.prompt,
			env: input.env ?? process.env,
			maxBuffer: 64 * 1024 * 1024,
		});
		if (result.error && !isBenignPromptWriteError(result.error)) {
			throw new Error(
				`failed to spawn harness command: ${result.error.message}`,
			);
		}
		// Record the CHILD's PID (the liveness anchor) — not the runner's. The null
		// adapter runs synchronously, so by the time we return the child has
		// exited, and `isAlive` correctly reads it as not-alive (from the PID
		// table, NOT a file mtime).
		const record: HarnessRecord = {
			adapter: this.adapter,
			pid: result.pid,
			command,
		};
		const status = result.status ?? -1;
		// The null/shell adapter's OUTPUT is its captured stdout (trimmed): a
		// synchronous spawn, so there is no stream-fragility caveat — the command's
		// stdout IS its answer. `undefined` when empty (no answer to surface).
		const stdout = (result.stdout ?? '').trim();
		return {
			ok: status === 0,
			record,
			detail: status === 0 ? undefined : (result.stderr ?? '').trim(),
			output: stdout === '' ? undefined : stdout,
		};
	}

	/**
	 * Interactive launch is NOT supported by the null/shell adapter (decision #2):
	 * its `agentCmd` is shaped for the captured, prompt-fed AUTONOMOUS path, so
	 * "interactive" has no clean meaning here. Throw a CLEAR pi-only error
	 * (mirroring `do --watch`'s fail-on-null decision) rather than silently
	 * shelling out the wrong way.
	 */
	launchInteractive(_input: InteractiveLaunchInput): InteractiveLaunchResult {
		throw new Error(
			'interactive launch requires the pi harness; configure `harness: pi` ' +
				'(the null/shell adapter only supports the captured autonomous launch).',
		);
	}

	isAlive(record: HarnessRecord): boolean {
		return pidAlive(record.pid);
	}
}

/**
 * Resolve the harness adapter that OWNS a given job record, keyed off the
 * record's `adapter` field. The core (`status`, `watch`, `gc`) reads liveness
 * for a heterogeneous set of jobs (some null, some pi) from their persisted
 * records, so it must ask the RIGHT adapter per job — a pi job's liveness is the
 * pi adapter's responsibility (PID + session pointer), not the null adapter's.
 *
 * Adapters register here lazily via {@link registerHarness}; an unknown adapter
 * falls back to the null adapter (PID-only liveness — never mtime), which is a
 * safe superset for any PID-anchored record.
 */
export function resolveHarness(record: HarnessRecord): Harness {
	return HARNESS_REGISTRY.get(record.adapter) ?? FALLBACK_HARNESS;
}

/**
 * Register a harness adapter under its `adapter` name so {@link resolveHarness}
 * can dispatch liveness to it. Idempotent (last registration wins). The pi
 * adapter registers itself on import; tests may register stubs.
 */
export function registerHarness(harness: Harness): void {
	HARNESS_REGISTRY.set(harness.adapter, harness);
}

const FALLBACK_HARNESS = new NullHarness();
const HARNESS_REGISTRY = new Map<string, Harness>([
	[FALLBACK_HARNESS.adapter, FALLBACK_HARNESS],
]);

/**
 * Is `pid` a live process? Uses signal 0 (`process.kill(pid, 0)`), which checks
 * for existence/permission WITHOUT delivering a signal — the OS process table,
 * never a filesystem mtime. Unknown/undefined PID ⇒ not alive.
 */
export function pidAlive(pid: number | undefined): boolean {
	if (pid === undefined || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but we may not signal it ⇒ still alive.
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}
