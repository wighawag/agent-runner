/**
 * **Reap a stopped agent's whole PROCESS TREE, and VERIFY it is gone** (spec
 * `graceful-pre-timeout-wip-checkpoint`, observation
 * `checkpoint-releases-lock-while-predecessor-agent-still-writes`).
 *
 * ## The gap this closes
 *
 * The deadline checkpoint used to `child.kill('SIGTERM')` the agent process and
 * treat the signal as if it were the outcome: the moment pi's own `exit` fired,
 * the runner saved the WIP, RELEASED the item lock, and let the next tick
 * dispatch a CONTINUATION agent into the SAME worktree. But `child.kill` signals
 * exactly ONE pid, and a modern agent is a TREE (subagent processes, MCP servers,
 * model proxies, tool subshells). Those descendants survive the parent's SIGTERM,
 * and once pi exits they are re-parented to init — so they can no longer even be
 * FOUND by walking `ppid`, while they keep writing into the worktree.
 *
 * Observed on a real run: the checkpoint saved WIP at 02:13, a continuation agent
 * onboarded into the same worktree at ~02:15, and the predecessor's session log
 * kept being written until 02:19:29 — four minutes INTO the successor's run,
 * whose opening `git status` had already read the tree as clean. Nothing was lost
 * only because the two happened to touch different files. The shape is the
 * defect: one lock, one working tree, two live writers. A write landing after the
 * successor's `git status` is invisible to it; a write landing during its edits
 * can be clobbered either way; and the successor can commit the predecessor's
 * half-finished edits as its own, under a message describing something else.
 *
 * ## Why the PROCESS GROUP is the handle
 *
 * A pid-tree walk cannot work here: the descendants we must reap are precisely
 * the ones that OUTLIVE the parent, and an orphan's `ppid` is gone. A process
 * GROUP id, by contrast, is inherited by every descendant and is NOT changed by
 * re-parenting. So if the agent is spawned as a group LEADER (`detached: true`,
 * making its pgid equal its pid), `kill(-pgid, …)` reaches the entire tree,
 * orphans included — which is why {@link reapProcessGroup} takes a pgid and why
 * `pi-harness.ts` spawns the deadline-capable async launch detached.
 *
 * ## Signal, then VERIFY — never assume
 *
 * The point of the whole module is that sending a signal is not evidence that
 * anything died. So: SIGTERM the group, POLL until it is actually gone, escalate
 * to SIGKILL after a grace, keep polling, and if it STILL will not die, say so
 * LOUDLY and let the caller refuse to release the lock. A checkpoint that cannot
 * prove the predecessor is dead must not hand the worktree to a successor.
 */

/** Poll interval while waiting for a signalled group to actually exit. */
const REAP_POLL_MS = 50;

/**
 * How long to wait after SIGTERM before escalating to SIGKILL. Matches
 * `pi-harness.ts`'s `DEADLINE_SIGKILL_GRACE_MS` intent: enough for an agent to
 * flush its session log and exit cleanly, short enough not to stall a CI leg.
 */
export const REAP_SIGTERM_GRACE_MS = 10_000;

/** How long to keep waiting after SIGKILL before declaring the reap FAILED. */
export const REAP_SIGKILL_TIMEOUT_MS = 5_000;

/** The outcome of a {@link reapProcessGroup} attempt. */
export interface ReapResult {
	/**
	 * True iff the group is VERIFIED gone (observed non-existent, not merely
	 * signalled). Only a `true` here licenses releasing the item lock and
	 * dispatching a successor into the same worktree.
	 */
	reaped: boolean;
	/** True iff SIGKILL was needed (the tree ignored SIGTERM) — worth reporting. */
	escalatedToSigkill: boolean;
	/** Total wall-clock ms spent waiting for the tree to die. */
	waitedMs: number;
	/** A human-readable account, always populated (the LOUD failure text). */
	detail: string;
}

/** Sleep helper (injectable clock is not needed: callers inject `wait` in tests). */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

/**
 * Is any process still alive in process group `pgid`?
 *
 * `process.kill(-pgid, 0)` is the liveness probe: signal 0 performs the
 * permission/existence check WITHOUT delivering a signal (the same technique
 * `harness.ts`'s {@link pidAlive} uses for a single pid, widened to the group).
 *
 *  - It THROWS `ESRCH` when no process in the group exists ⇒ the group is gone.
 *  - It THROWS `EPERM` when the group exists but we may not signal it. That is
 *    still "alive", and reporting it as dead would be the very assumption this
 *    module exists to remove — so `EPERM` reads as ALIVE.
 *  - It succeeds ⇒ alive.
 */
export function processGroupAlive(pgid: number): boolean {
	if (!Number.isInteger(pgid) || pgid <= 1) {
		// pgid 0/1 (or a bogus value) would mean "our own group" / init — signalling
		// those would be catastrophic, so never claim they are ours to reap.
		return false;
	}
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'EPERM') {
			return true; // exists, just not signallable by us.
		}
		return false; // ESRCH (or anything else): treat as gone.
	}
}

/** Signal a whole process group, tolerating an already-dead group. */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch {
		// ESRCH: already gone — the wait loop below observes that and succeeds.
	}
}

/**
 * SIGTERM process group `pgid`, wait for it to ACTUALLY exit, escalate to
 * SIGKILL after {@link REAP_SIGTERM_GRACE_MS}, and report whether the tree is
 * VERIFIED gone.
 *
 * Bounded by construction: at worst `sigtermGraceMs + sigkillTimeoutMs` before it
 * returns `reaped: false` with a loud `detail`. It never waits indefinitely, so
 * it cannot reintroduce the runner-hang the async launch's resolve-on-`exit`
 * discipline exists to avoid.
 */
export async function reapProcessGroup(params: {
	/** The process GROUP id to reap (the group leader's pid). */
	pgid: number;
	sigtermGraceMs?: number;
	sigkillTimeoutMs?: number;
	/** Injectable sleep so tests need not burn real seconds. */
	wait?: (ms: number) => Promise<void>;
	/**
	 * Injectable liveness probe (default {@link processGroupAlive}). Exists so the
	 * REFUSAL path — a tree that survives SIGTERM *and* SIGKILL — can be tested
	 * deterministically. There is no portable way to create a genuinely unkillable
	 * process, and the alternative (a group we truly cannot signal) would risk the
	 * test process itself, so the probe is the seam.
	 */
	alive?: (pgid: number) => boolean;
}): Promise<ReapResult> {
	const {
		pgid,
		sigtermGraceMs = REAP_SIGTERM_GRACE_MS,
		sigkillTimeoutMs = REAP_SIGKILL_TIMEOUT_MS,
		wait = sleep,
		alive = processGroupAlive,
	} = params;
	const started = Date.now();

	if (!alive(pgid)) {
		return {
			reaped: true,
			escalatedToSigkill: false,
			waitedMs: 0,
			detail: `agent process group ${pgid} was already gone (nothing to reap).`,
		};
	}

	// 1. SOFT: ask the whole tree to stop, then WAIT for it to be observably gone.
	signalGroup(pgid, 'SIGTERM');
	while (Date.now() - started < sigtermGraceMs) {
		if (!alive(pgid)) {
			const waitedMs = Date.now() - started;
			return {
				reaped: true,
				escalatedToSigkill: false,
				waitedMs,
				detail:
					`agent process group ${pgid} exited on SIGTERM after ${waitedMs}ms ` +
					'(verified gone).',
			};
		}
		await wait(REAP_POLL_MS);
	}

	// 2. HARD: the tree ignored SIGTERM through the grace. SIGKILL it and keep
	//    verifying — a wedged agent still holding the worktree must not survive
	//    into the successor's run.
	signalGroup(pgid, 'SIGKILL');
	const killDeadline = Date.now() + sigkillTimeoutMs;
	while (Date.now() < killDeadline) {
		if (!alive(pgid)) {
			const waitedMs = Date.now() - started;
			return {
				reaped: true,
				escalatedToSigkill: true,
				waitedMs,
				detail:
					`agent process group ${pgid} ignored SIGTERM and was SIGKILLed; ` +
					`exited after ${waitedMs}ms (verified gone).`,
			};
		}
		await wait(REAP_POLL_MS);
	}

	// 3. LOUD FAILURE: we cannot prove the predecessor is dead. Say exactly that,
	//    and exactly what the caller must not do as a result.
	const waitedMs = Date.now() - started;
	return {
		reaped: false,
		escalatedToSigkill: true,
		waitedMs,
		detail:
			`REFUSING TO PROCEED: agent process group ${pgid} is STILL ALIVE ${waitedMs}ms ` +
			'after SIGTERM and SIGKILL (an unkillable/uninterruptible descendant — e.g. a ' +
			'process wedged in a kernel call, or one we lack permission to signal). It may ' +
			'still be WRITING to the worktree, so the item lock must NOT be released and no ' +
			'successor agent may onboard here: two live writers in one working tree can ' +
			'silently clobber each other and let a successor commit the predecessor’s ' +
			`half-finished edits. Inspect and kill it by hand (\`ps -g ${pgid}\`, ` +
			`\`kill -9 -${pgid}\`) before re-running this item.`,
	};
}
