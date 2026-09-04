import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	type WorkFolderKey,
	workFolderPrefix,
	workFolderRel,
	workItemRel,
	isWorkItemFile,
} from './work-layout.js';
import {run, runAsync, type RunResult} from './git.js';
import {
	branchAheadOf,
	rebaseContinuedBranchOntoMain,
} from './continue-branch.js';
import {
	acquireItemLock,
	releaseItemLock,
	readItemLock,
	itemLockRef,
	lockEntryFor,
	parseLockEntry,
	type LockEntry,
} from './item-lock.js';
import {ledgerWrite, type LedgerTransitionKind} from './ledger-write.js';
import {workBranchRef} from './slug-namespace.js';
import {refreshArbiterRefs, resolveArbiterBranch} from './arbiter-refs.js';
import {
	appendQuestions,
	isEntryAnswered,
	newSidecar,
	parseSidecar,
	resolveSidecarIdentity,
	serialiseSidecar,
	sidecarPathFor,
	type NewQuestion,
	type SidecarType,
} from './sidecar.js';
import {parseFrontmatter, setNeedsAnswersMarker} from './frontmatter.js';
import {
	retryWithBackoff,
	realSleep,
	type BackoffOptions,
	type Sleep,
} from './retry-backoff.js';

/**
 * The **needs-attention mechanism** (ADR `ledger-status-on-per-item-lock-refs`;
 * spec `ledger-status-per-item-lock-refs`; ADR §12 for the original folder model).
 * Every "couldn't finish, a human must look" outcome (a failed acceptance gate
 * (red `verify`), a rebase/merge conflict (ADR §10), a task the agent reported
 * too ambiguous to build, a timeout, or a rejected review) resolves to ONE
 * observable move: the RUNNER AMENDS the claimed item's HELD per-item lock
 * `active → stuck` (`refs/dorfl/lock/<entry>`), writing the reason (+ any
 * agent-surfaced questions) into the lock-entry BODY. There is NO `git mv` to a
 * `work/needs-attention/` folder and NO on-`main` surface (the lock cut-over,
 * task `cutover-needs-attention-becomes-lock-stuck-recovery-surface`): so a
 * protected-`main` bounce succeeds, and a work branch cut from `main` inherits no
 * stuck record. The RECOVERABLE half is the kept `work/<slug>` branch.
 *
 * This is the conflict-safe form of "surfacing": the surface is the lock
 * `state: stuck`, read by `scan`/`status`/`gc --ledger` reading the lock refs (a
 * COMMAND a human runs, not an `ls` of a folder). There is **no status/label
 * field** on `main` (honours WORK-CONTRACT rule 3). The reason is prose in the
 * lock-entry body, never a source-of-truth frontmatter field.
 *
 * Ownership: this module OWNS the mechanism (the move helper + the surface
 * reader + the return path). Consumers (`complete.ts`'s gate-failed/rebase-
 * conflict abort paths, the runner's stuck routing in `run.ts`, the human
 * `return` command) drive these through the ledger write seam's NEEDS-ATTENTION
 * transition (`ledgerWrite.applyNeedsAttentionTransition` /
 * `applyReturnToBacklogTransition` in `ledger-write.ts`), whose sole strategy
 * delegates to `routeToNeedsAttention` / `returnToBacklog` here UNCHANGED — so
 * the later cherry-pick-to-`main` surfacing is built AGAINST the seam, not
 * bolted onto this move code. The build agent NEVER does this — agents do no git
 * (ADR §12).
 */

/** Marker that opens the appended reason block in a needs-attention item body. */
const REASON_HEADING = '## Needs attention';

export interface RouteToNeedsAttentionOptions {
	/** The working clone / job worktree the `work/<slug>` branch lives in. */
	cwd: string;
	/** The slug of the in-progress item to bounce. */
	slug: string;
	/** Why the item is stuck (red gate, rebase conflict, ambiguity, timeout, …). */
	reason: string;
	/** Any questions the agent surfaced for the human, recorded under the reason. */
	questions?: string[];
	/**
	 * The arbiter remote to push the transition to (like the done-move). When
	 * omitted, the move is committed locally only (the caller pushes the branch as
	 * part of its own flow, e.g. the runner's integration step).
	 */
	arbiter?: string;
	/**
	 * The work branch to push to the arbiter (the RECOVERABLE half — see the seam
	 * docstring). DEFAULT `work/<slug>`: the build-bounce branch the wip/move
	 * commits landed on. A tasking bounce passes its own branch (`work/specs/
	 * ready-<slug>`). The supplied branch MUST be the one HEAD is on (the branch the
	 * wip/move commits landed on) — NEVER a default that differs from HEAD; a
	 * caller NOT checked out on the work branch (e.g. a temp branch off main) must
	 * be SURFACE-ONLY ({@link pushBranch} `false`) so no wrong-branch ref is
	 * pushed. Only consulted when {@link arbiter} is given and {@link pushBranch}
	 * is not `false`.
	 */
	branch?: string;
	/**
	 * SURFACE-ONLY when `false`: publish the ledger surface (when an `arbiter` is
	 * given) but push NO work branch. For a caller that is NOT checked out on the
	 * work branch (a throwaway temp branch off main — e.g. `start.ts`'s
	 * `routeContinueConflict`, whose real `work/<slug>` is already on the arbiter
	 * from the prior requeue). Defaults to pushing (the build-bounce common case).
	 */
	pushBranch?: boolean;
	/** Environment for child git processes (identity etc.). */
	env?: NodeJS.ProcessEnv;
	/** Sink for human-readable progress notes. */
	note?: (message: string) => void;
	/**
	 * Bounded-backoff bounds for the RECOVERABLE branch push (the OUTAGE-retry,
	 * NOT the instant-contention loop). Defaults to {@link DEFAULT_BACKOFF}.
	 */
	backoff?: BackoffOptions;
	/**
	 * Injectable sleep for the backoff (tests drive the retry timeline with NO
	 * real waits — the `run.ts` `sleep`/`realSleep` seam). Defaults to a real
	 * `setTimeout`. Threaded into {@link backoff} when the latter omits its own.
	 */
	sleep?: Sleep;
}

/** The outcome of the RECOVERABLE branch push (the per-op honest report). */
export type BranchPushOutcome =
	/** Pushed to the arbiter (cross-machine recoverable). */
	| 'pushed'
	/** Skipped by the emptiness guard — nothing beyond main to recover YET. */
	| 'skipped-empty'
	/** Retried with backoff, then gave up — saved LOCALLY only. */
	| 'failed'
	/** No arbiter / surface-only — no push was attempted. */
	| 'not-attempted';

export interface RouteToNeedsAttentionResult {
	/** True iff the item was moved + committed. */
	moved: boolean;
	/** When `moved`, the committed transition message (of the MOVE-ONLY commit). */
	commitMessage?: string;
	/**
	 * The per-op outcome of the RECOVERABLE branch push (honest reporting — the
	 * message reads THIS, never assumes "pushed" off the local move). Absent when
	 * the item did not move.
	 */
	branchPush?: BranchPushOutcome;
	/** When the branch push FAILED after retries, the last git error (for the report). */
	pushError?: string;
	/**
	 * When `moved`, the sha of the `work/<slug>` tip after the RECOVERABLE-half
	 * save. Post lock-cutover this is the **wip** commit holding the aborted agent
	 * work (`git add -A`); there is no separate `git mv → needs-attention/`
	 * move-only commit anymore (that folder is retired). The OBSERVABLE stuck
	 * state rides on the per-item lock amend (`state: stuck` + reason), not on this
	 * commit.
	 */
	moveCommit?: string;
	/** When NOT moved, why (e.g. the slug was not in-progress). */
	reasonNotMoved?: string;
}

export interface ReturnToBacklogOptions {
	/** The working clone the `work/` tree lives in. */
	cwd: string;
	/**
	 * The slug of the stuck item to re-queue — recovered via its per-item lock on
	 * the arbiter (post lock-cutover the body never moves into a status folder; it
	 * rests in `backlog/` and stuck is the lock `state: stuck`).
	 */
	slug: string;
	/** The arbiter remote to push the transition to. Optional (see above). */
	arbiter?: string;
	/**
	 * `requeue --reset` (the destructive opt-out): DISCARD the kept work, so the
	 * NEXT claim starts FRESH. At requeue-time — BEFORE the backlog move — delete
	 * the remote `work/<slug>` branch on `arbiter`
	 * (`git push <arbiter> --delete work/<slug>`, plain provider-agnostic git that
	 * works against a local `--bare` arbiter) and drop any stale LOCAL `work/<slug>`.
	 * Delete-before-move closes the claim-race window (no backlog item exists while
	 * the to-be-discarded branch still does). A FAILED delete ABORTS the requeue
	 * (no backlog move) — the item stays in needs-attention rather than become
	 * claimable while continuing from a branch you meant to throw away. Requires
	 * `arbiter`. Explicit/guarded — a deliberate departure from the loud "never
	 * delete the remote branch" invariant; never on the default (keep+continue)
	 * path.
	 */
	reset?: boolean;
	/**
	 * `requeue --reconcile` (the NON-DESTRUCTIVE recovery verb — the middle rung
	 * of the escalation ladder between the default keep+continue and the
	 * destructive `--reset`). When the item's per-item lock is held stuck AND the
	 * arbiter's `work/<slug>` branch EXISTS and is ahead of main, re-sync the
	 * mirror to the arbiter (a prune-fetch that clears the stale-ref residue that
	 * historically silently resurrected a supposedly-`--reset`-ed branch) and
	 * RETRY the rebase of the kept branch onto latest `<arbiter>/main` in a
	 * SCRATCH worktree (never touching the caller's tree, `--force-with-lease`
	 * only, NEVER a bare force). On a clean rebase, the reconciled tip is
	 * pushed back to the arbiter with a lease + the reconcile completes as a
	 * standard keep+continue requeue (lock released, branch preserved). On a
	 * genuine content conflict after the clean mirror re-sync, the lock is LEFT
	 * HELD (item stays stuck), the branch is LEFT UNTOUCHED on the arbiter
	 * (NEVER deleted), and the caller is told the retry happened + pointed at the
	 * deferred mirror-side resolve follow-on + `--reset` as the destructive last
	 * resort. If the branch is ABSENT (never pushed, or a prior `--reset` already
	 * deleted it), reconcile falls through to the default keep+continue path
	 * (which itself degrades gracefully to a fresh-claim move). Incompatible
	 * with `--reset` (destructive vs non-destructive are exclusive verbs on the
	 * same escalation).
	 */
	reconcile?: boolean;
	/**
	 * `requeue -m "<note>"` (the handoff note): an optional human steer for the
	 * NEXT agent. APPENDED (never overwritten) as a dated `## Requeue YYYY-MM-DD`
	 * section to the item BODY before the move — the ledger file is the durable,
	 * conflict-safe, cross-machine home (same place the needs-attention reason
	 * lives). Repeated requeues ACCUMULATE a handoff log. Applies to BOTH modes
	 * (a steer is relevant even on `--reset`).
	 */
	message?: string;
	/** Environment for child git processes. */
	env?: NodeJS.ProcessEnv;
	/** Sink for human-readable progress notes. */
	note?: (message: string) => void;
}

export interface ReturnToBacklogResult {
	/** True iff the item was moved back + committed. */
	moved: boolean;
	/** When `moved`, the committed transition message. */
	commitMessage?: string;
	/** True iff `--reset` deleted the remote `work/<slug>` branch on the arbiter. */
	deletedRemoteBranch?: boolean;
	/**
	 * True iff `--reconcile` re-synced the mirror + rebased the kept branch onto
	 * latest `<arbiter>/main` and pushed the reconciled tip back to the arbiter
	 * (before the lock release). Absent on the default path / on `--reset` / on
	 * a reconcile that fell through (branch absent) — for those, the ordinary
	 * keep+continue path ran with no rebase.
	 */
	reconciled?: boolean;
	/** When NOT moved, why (e.g. the slug held no recoverable per-item lock on the arbiter, or a failed --reset delete). */
	reasonNotMoved?: string;
	/**
	 * **The ONE resolved continue-branch state** this requeue decided from — so a
	 * CALLER reports the same reality the requeue acted on instead of running its
	 * own second probe (observation
	 * `checkpoint-path-reports-its-own-write-as-absent`).
	 *
	 * The deadline checkpoint used to print two lines from two independent probes
	 * that disagreed inside the same second: `returnToBacklog` said "'<slug>' has no
	 * work branch on origin — nothing to continue from", and the caller then said
	 * "the next tick continues from work/task-<slug>". Both cannot be true, and
	 * acting on the first one discards the branch's work. Publishing the resolved
	 * state here removes the second probe entirely: there is one answer, and every
	 * message is derived from it.
	 *
	 * Absent only when no continue-branch question was asked (the `--reset` path,
	 * which discards the branch by design, or an early refusal).
	 */
	continueBranch?: ResolvedContinueBranch;
}

/**
 * The resolved state of the kept `work/<slug>` continue-branch on the arbiter, as
 * decided ONCE by {@link returnToBacklog} (see
 * {@link ReturnToBacklogResult.continueBranch}).
 */
export interface ResolvedContinueBranch {
	/** The unqualified branch name (e.g. `work/task-<slug>`). */
	branch: string;
	/** True iff the arbiter HAS this branch (arbiter-authoritative `ls-remote`). */
	present: boolean;
	/** Its tip sha on the arbiter, when present. */
	sha?: string;
	/**
	 * True iff the branch is present AND carries commits `<arbiter>/main` lacks —
	 * i.e. there IS work to continue from. False when absent, or present but fully
	 * merged (nothing to resume).
	 */
	aheadOfMain: boolean;
	/**
	 * False when the arbiter could not be reached, so {@link present} is a
	 * stale-capable local read. A caller MUST NOT report "nothing to continue from"
	 * off an untrustworthy read — that is exactly the defect.
	 */
	trustworthy: boolean;
}

export interface SurfaceToNeedsAttentionOptions {
	/**
	 * The working clone the move is ORIGINATED from — purely the ORIGIN SOURCE
	 * (it resolves the arbiter remote + holds the object store the plumbing writes
	 * into), NEVER a write TARGET. Tree-less: the cwd index/HEAD/working tree are
	 * never touched (parity with {@link returnToBacklog}).
	 */
	cwd: string;
	/** The slug of the in-progress item to surface to needs-attention. */
	slug: string;
	/** Why the item is stuck (terminal continue-push failure, rebase conflict, …). */
	reason: string;
	/** Any questions the agent surfaced for the human, recorded under the reason. */
	questions?: string[];
	/**
	 * The arbiter remote the surface move is CAS-published to. REQUIRED — like
	 * {@link returnToBacklog}, the move is a tree-less compare-and-swap to the
	 * arbiter ref, so there is no local-only mode.
	 */
	arbiter: string;
	/** Environment for child git processes (identity etc.). */
	env?: NodeJS.ProcessEnv;
	/** Sink for human-readable progress notes. */
	note?: (message: string) => void;
}

export interface SurfaceToNeedsAttentionResult {
	/** True iff the item was surfaced (moved + CAS-published) on the arbiter. */
	moved: boolean;
	/** When `moved`, the committed transition message. */
	commitMessage?: string;
	/** When NOT moved, why (no arbiter, item not on the arbiter, contention exhausted). */
	reasonNotMoved?: string;
}

/**
 * Save the RECOVERABLE half of a stuck-item bounce (ADR §12). The RUNNER calls
 * this; the build agent never does.
 *
 * **Post `ledger-status-per-item-lock-refs` cut-over (tasks 9a–9d, decision i+):**
 * a bounce is now a PURE LOCK AMEND — the seam (`bounceToStuckLock` →
 * `markStuckItemLock`) marks the per-item lock `state: stuck` and records the
 * reason/questions ON THE LOCK ENTRY. There is NO `git mv` to a
 * `needs-attention/` folder and NO on-`main` surface commit. The item body never
 * moves (it rests in `backlog/` since claim stopped moving it, task 9a). So what
 * REMAINS here is purely the never-lose-work half:
 *
 *   1. A **wip** commit on the `work/<slug>` branch tip holding whatever the agent
 *      left uncommitted (`git add -A`). Skipped when the tree is already clean
 *      (no aborted work to save). No bookkeeping trailer — after the cut-over NO
 *      transient-status move-only commit lands on a branch, so a branch rebases
 *      PLAINLY with nothing to drop (`drop-bookkeeping-rebase` is deleted, 9d).
 *   2. Optionally PUSH the work branch to the arbiter so the saved wip travels
 *      cross-machine and a `requeue` continues from the branch tip. BEST-EFFORT
 *      (an unreachable arbiter leaves the local branch standing — recovery
 *      degrades, never crashes the bounce; retried with bounded backoff on an
 *      outage), BRANCH-PARAMETERISED (default `work/<slug>`; an explicit `branch`
 *      overrides — the tasking bounce passes `work/specs/ready-<slug>`; `pushBranch: false`
 *      ⇒ push NOTHING), and EMPTINESS-GUARDED (a branch with no commits beyond
 *      main, or an absent branch, is skipped). The branch MUST be the one HEAD is
 *      on. The work-branch push is NOT a `main` write.
 *
 * The stuck STATE itself (the `state: stuck` + reason/questions) is owned by the
 * lock amend in the seam, not by this function. NEVER throws for the expected
 * case — returns `{moved, ...}` so consumers can branch cleanly; genuine git
 * plumbing failures still throw (they are unexpected).
 */
export async function routeToNeedsAttention(
	options: RouteToNeedsAttentionOptions,
): Promise<RouteToNeedsAttentionResult> {
	const note = options.note ?? (() => {});
	const {cwd, slug, env} = options;

	// TASK `cutover-needs-attention-becomes-lock-stuck-recovery-surface`
	// (decision i+): the bounce is now a PURE lock amend (done by the seam) — there
	// is NO `git mv` to `needs-attention/` and NO on-`main` surface. What REMAINS
	// here is the RECOVERABLE half: SAVE the agent's uncommitted work as a wip
	// commit on the `work/<slug>` branch tip and PUSH the branch to the arbiter, so
	// the partial work travels cross-machine and a `requeue` continues from the
	// branch tip. The reason/questions ride on the lock entry (the seam amends it),
	// NOT a moved `.md`. The work branch push is NOT a `main` write.

	// 1. WIP commit: save whatever the agent left uncommitted to the work branch
	//    tip. Skip when the tree is clean (no aborted work to save). NOTE this no
	//    longer needs a folder source — the body rests in `backlog/` (task 9a) and
	//    never moves on a bounce.
	gitHard(['add', '-A'], cwd, env);
	const hadWip = !nothingStaged(cwd, env);
	if (hadWip) {
		// Save the agent's uncommitted work as a plain wip commit on the work-branch
		// tip (the RECOVERABLE half — a `requeue` continues from it). No bookkeeping
		// trailer: after the per-item-lock cut-over (tasks 9a–9d) NO transient status
		// (no `needs-attention/` move-only commit) lands on a branch, so a branch cut
		// from `main` rebases PLAINLY with nothing to drop — the `drop-bookkeeping-rebase`
		// machinery and its `Dorfl-Bookkeeping` trailer are gone (9d).
		const wipBody = `chore(${slug}): save aborted work (wip)`;
		gitHard(['commit', '-q', '-m', wipBody], cwd, env);
	}
	const commitMessage = `chore(${slug}): bounce to stuck; ${options.reason}`;
	const moveCommit = hadWip ? revParseHead(cwd, env) : undefined;
	note(`Bounced '${slug}' to stuck (lock): ${options.reason}`);

	// 2. Push the work branch to the arbiter — the RECOVERABLE half of the bounce
	//    (so the saved wip travels cross-machine and a requeue continues from the
	//    branch tip). Three behaviours: SURFACE-ONLY (no push) when
	//    `pushBranch === false`; an explicit `branch` target; else the default
	//    `work/<slug>`. BEST-EFFORT (no throw on a failed/unreachable push), RETRIED
	//    with bounded backoff on an OUTAGE, and EMPTINESS-GUARDED (a branch with no
	//    work beyond main / an absent branch is skipped). The OUTCOME is CAPTURED +
	//    RETURNED (`branchPush`) so the caller reports what ACTUALLY landed.
	let branchPush: BranchPushOutcome = 'not-attempted';
	let pushError: string | undefined;
	if (options.arbiter && options.pushBranch !== false) {
		// DEFAULT to the task-namespaced build-bounce branch; a non-task caller
		// (the tasking bounce) passes its own `work/specs/ready-<slug>` via `branch`.
		const branch = options.branch ?? workBranchRef('task', slug);
		if (branchAheadOf(cwd, branch, 'main', env)) {
			const arbiter = options.arbiter;
			const result = await retryWithBackoff(
				async () => {
					const r = gitSoftRun(
						['push', arbiter, `${branch}:${branch}`],
						cwd,
						env,
					);
					return r.status === 0
						? {ok: true as const, value: undefined}
						: {ok: false as const, error: r.stderr.trim()};
				},
				{sleep: options.sleep ?? realSleep, ...options.backoff},
			);
			if (result.ok) {
				branchPush = 'pushed';
			} else {
				branchPush = 'failed';
				pushError = result.lastError;
				note(
					`Could not push ${branch} to ${arbiter} after ${result.attempts} ` +
						`attempt(s) (${pushError ?? 'unknown error'}) — the work is saved ` +
						'LOCALLY only; push the branch when online, then `requeue`.',
				);
			}
		} else {
			branchPush = 'skipped-empty';
			note(
				`Skipped pushing ${branch} (no work beyond main / branch absent) — ` +
					'nothing to recover.',
			);
		}
	}

	return {moved: true, commitMessage, moveCommit, branchPush, pushError};
}

/**
 * The clean re-queue (ADR §12 / WORK-CONTRACT return path): once the human has
 * resolved the cause, move the stuck item back to `work/tasks/ready/<slug>.md` and
 * commit it so the item can be re-claimed (it must not rot stuck). It recovers a
 * task stuck in EITHER `work/needs-attention/<slug>.md` (the resolved-surface
 * path) OR `work/in-progress/<slug>.md` (a claim that never surfaced — an
 * un-surfaced abort, a killed run, or an in-place requeue note; defect 2, story
 * 4): the slug's ACTUAL current folder is resolved on the arbiter and moved to
 * `backlog/` via the SAME tree-less CAS. Any recorded reason/handoff block stays
 * in the body as a durable note of what happened; the resolution itself is the
 * human's.
 *
 * The `requeue` verb's THREE behaviours (ADR §14 / task
 * `requeue-continue-and-reset`) are realised here:
 *   - **default = KEEP + CONTINUE.** The `work/<slug>` branch is left UNTOUCHED;
 *     it is the durable artifact the next claim CONTINUES from (the continue-
 *     detection in `continue-branch.ts` feeds both onboarding paths). This
 *     function only does the ledger move.
 *   - **`--reconcile` = NON-DESTRUCTIVE RECOVERY (middle rung).** When
 *     `reconcile` is set AND the arbiter's `work/<slug>` exists + is ahead of
 *     main, re-sync the hub mirror to the arbiter (a prune-fetch that clears
 *     the stale-ref residue that historically resurrected a supposedly
 *     `--reset`-ed branch) and RETRY the rebase of the kept branch onto latest
 *     `<arbiter>/main` in a SCRATCH worktree (never touching the caller's
 *     tree, `--force-with-lease` only, NEVER a bare force). Clean rebase =>
 *     push the reconciled tip back to the arbiter and fall through to the
 *     standard keep+continue path (lock released, branch preserved). Genuine
 *     content conflict AFTER the clean mirror re-sync => item stays stuck,
 *     branch UNTOUCHED (NEVER deleted), message references the deferred
 *     mirror-side resolve follow-on and mentions `--reset` LAST as the
 *     destructive last resort. Branch absent / not-ahead => fall through to
 *     the default keep+continue path (which handles the fresh-claim case).
 *   - **`--reset` = DISCARD + FRESH (destructive last resort).** When `reset`
 *     is set, DELETE the remote `work/<slug>` branch on `arbiter` FIRST (+ drop
 *     any stale local branch), THEN the backlog move. Delete-before-move
 *     closes the claim-race window; a FAILED delete ABORTS (no backlog move)
 *     so the item stays in needs-attention. The next claim then finds NO
 *     arbiter branch and cuts fresh — no special claim-time logic.
 *   - **`-m "<note>"` = HANDOFF NOTE.** When `message` is set, APPEND a dated
 *     `## Requeue YYYY-MM-DD` section to the item BODY (append-only; accumulates
 *     over repeated requeues) for the next agent. Applies to BOTH modes.
 *
 * Like the move, NEVER throws for the expected "not in needs-attention" case.
 */
/**
 * Read the item's lock entry from the LOCAL lock ref (no fetch) — the resilient
 * fall-back for {@link returnToBacklog} when an arbiter fetch fails (e.g. a
 * `--reset` against a moved-away arbiter). The up-front soft fetch already
 * refreshed the local refs, so reading them locally is the best-effort truth
 * without throwing.
 */
async function readLocalItemLock(
	slug: string,
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<LockEntry | undefined> {
	const ref = itemLockRef(lockEntryFor(`task:${slug}`));
	const show = await gitSoftAsync(['show', `${ref}:lock.md`], cwd, env);
	if (show.status !== 0) {
		return undefined;
	}
	return parseLockEntry(show.stdout);
}

/**
 * Options the shared {@link deleteRemoteWorkBranchIfPresent} primitive consumes.
 */
export interface DeleteRemoteWorkBranchOptions {
	/** Working clone whose remote `arbiter` points at the real arbiter. */
	cwd: string;
	/** The arbiter remote NAME in `cwd`. */
	arbiter: string;
	/** Bare slug (the branch is `work/task-<slug>`). */
	slug: string;
	/** Environment for child git processes. */
	env?: NodeJS.ProcessEnv;
}

/** The three terminal states {@link deleteRemoteWorkBranchIfPresent} can report. */
export type DeleteRemoteWorkBranchStatus =
	/** The push --delete succeeded; the arbiter branch is gone. */
	| 'deleted'
	/**
	 * The branch was already absent from the arbiter (`remote ref does not
	 * exist` / `unable to delete`). Local refs may still have been cleaned up.
	 * SEMANTICALLY equivalent to `deleted` for callers who only care that the
	 * branch is not on the arbiter afterwards — idempotent no-op.
	 */
	| 'already-gone'
	/** The push --delete failed for a reason OTHER than already-gone; caller decides. */
	| 'failed';

/** The outcome {@link deleteRemoteWorkBranchIfPresent} reports. */
export interface DeleteRemoteWorkBranchResult {
	/** The `work/<type>-<slug>` branch ref name that was targeted. */
	branch: string;
	/** See {@link DeleteRemoteWorkBranchStatus}. */
	status: DeleteRemoteWorkBranchStatus;
	/** The stderr from the failed `push --delete` (`''` on success/already-gone). */
	stderr: string;
}

/**
 * Delete the remote `work/task-<slug>` branch on the arbiter using the SAME
 * write-through ordering the `requeue --reset` recovery verb uses:
 *
 *   1. Delete the LOCAL tracking ref (`refs/remotes/<arbiter>/work/<...>`)
 *      — the ref the continue-detection path READS; if we skip this the
 *      staleness silently resurrects a supposedly-discarded branch (verified in
 *      `work/notes/observations/requeue-reset-does-not-prune-hub-mirror-stale-branch-ref.md`).
 *   2. Delete any LOCAL head `work/<...>` (best-effort).
 *   3. `git push <arbiter> --delete work/<...>` — the ARBITER delete, the
 *      source of truth. A `remote ref does not exist` / `unable to delete`
 *      stderr is TOLERATED as `already-gone` so the primitive is IDEMPOTENT
 *      and safely callable on an item with no work branch (an observation, or
 *      a task never built).
 *
 * Extracted from {@link returnToBacklog}'s `--reset` path so the apply-rung
 * `kind: 'stuck'` answered `reset` verb (task
 * `apply-resolve-reset-flag-discards-work-branch`) can dispatch through the
 * SAME primitive without re-implementing branch deletion — the two callers
 * MUST stay behaviourally identical (delete-before-move / delete-before-clear;
 * local-first write-through; already-gone tolerance).
 */
export async function deleteRemoteWorkBranchIfPresent(
	options: DeleteRemoteWorkBranchOptions,
): Promise<DeleteRemoteWorkBranchResult> {
	const {cwd, arbiter, slug, env} = options;
	const branch = workBranchRef('task', slug);
	await gitSoftAsync(
		['update-ref', '-d', `refs/remotes/${arbiter}/${branch}`],
		cwd,
		env,
	);
	await gitSoftAsync(['branch', '-D', branch], cwd, env);
	const del = await gitSoftAsync(
		['push', arbiter, '--delete', branch],
		cwd,
		env,
	);
	if (del.status === 0) {
		return {branch, status: 'deleted', stderr: ''};
	}
	const stderr = del.stderr.trim();
	if (/remote ref does not exist|unable to delete/i.test(stderr)) {
		return {branch, status: 'already-gone', stderr};
	}
	return {branch, status: 'failed', stderr};
}

export async function returnToBacklog(
	options: ReturnToBacklogOptions,
): Promise<ReturnToBacklogResult> {
	const note = options.note ?? (() => {});
	const {cwd, slug, env} = options;

	// Tree-less CAS, EXACTLY like `claim` (`performClaim`): the move is published
	// to the arbiter ref via the shared `ledger-write` write seam — it NEVER stages
	// or commits in the cwd working tree (so a `requeue` in a shared checkout can no
	// longer sweep up a concurrent writer's uncommitted files — the `8c92f63`
	// incident, see
	// `work/notes/observations/drive-backlog-skill-assumes-in-place-do-not-remote.md`).
	// `--cwd` is purely the ORIGIN SOURCE (it resolves the arbiter remote + holds
	// the object store the plumbing writes into), never a write TARGET. A tree-less
	// CAS needs a ref to push to, so an `arbiter` is REQUIRED (parity with `claim`).
	if (!options.arbiter) {
		return {
			moved: false,
			reasonNotMoved:
				`requeue for '${slug}' needs an --arbiter: the move is published as a ` +
				'tree-less compare-and-swap to the arbiter ref (like claim), so there ' +
				'is no local-only mode — pass --arbiter.',
		};
	}
	const arbiter = options.arbiter;

	if (
		(await gitSoftAsync(['remote', 'get-url', arbiter], cwd, env)).status !== 0
	) {
		return {
			moved: false,
			reasonNotMoved: `no git remote named '${arbiter}' (set one, or pass --arbiter).`,
		};
	}

	// Refresh the remote-tracking refs so every check below (the item's residence,
	// the continue-branch guard, the CAS base) sees the arbiter's TRUTH, not a stale
	// local copy. This is a fetch, not a checkout — the working tree is untouched.
	//
	// This used to be a PLAIN `git fetch <arbiter>`, which is precisely how the
	// deadline checkpoint came to announce "no work branch on origin" over a branch
	// holding an hour of work: in the bare-hub-mirror job worktree an `--isolated`
	// run uses, that fetch does not populate `refs/remotes/<arbiter>/*` (the mirror
	// refspec maps `+refs/heads/*:refs/heads/*`) and in fact FAILS outright
	// (`refusing to fetch into branch 'refs/heads/work/<slug>' checked out at …`),
	// so it refreshed nothing and the guard below read a ref that never existed.
	// The shared helper prune-fetches per branch with the EXPLICIT destination
	// refspec, tolerating that one refusal instead of being defeated by it.
	const continueBranchName = workBranchRef('task', slug);
	await refreshArbiterRefs({
		cwd,
		arbiter,
		branches: ['main', continueBranchName],
		env,
	});

	// Is the item LOCK-HELD on the arbiter? (task
	// `cutover-needs-attention-becomes-lock-stuck-recovery-surface`, decision i+:
	// stuck-state is the per-item lock `state: stuck`, NOT a `needs-attention/`
	// folder file). `requeue` recovers a STUCK hold (the resolved-recovery path) and
	// tolerates an ACTIVE hold (a killed run that never surfaced) — both legitimate
	// in-flight states the human's recovery verb returns to the pool. We read the
	// LOCK ref (arbiter-is-truth), NOT a folder. No held lock ⇒ nothing to requeue
	// (the item is already at rest — unclaimed in `backlog/`, or terminal).
	// Read the held lock TOLERANTLY: a broken/unreachable arbiter (e.g. a
	// `--reset` against a moved-away arbiter) must NOT throw out of requeue — the
	// up-front soft fetch above already refreshed the local lock refs, so on a
	// fetch fault we fall back to the local lock ref (best-effort) rather than
	// crashing. A genuinely absent lock still refuses below.
	let held: Awaited<ReturnType<typeof readItemLock>>;
	try {
		held = await readItemLock({item: `task:${slug}`, cwd, arbiter, env});
	} catch {
		held = await readLocalItemLock(slug, cwd, env);
	}
	if (!held) {
		// CROSS-NAMESPACE HINT (observation
		// `crashed-do-spec-strands-a-tasking-lock-no-verb-releases`). `requeue` is a
		// TASK-only verb, so a bare `<slug>` resolves to `task:<slug>` and finds no
		// lock when what is ACTUALLY stranded is the SPEC lock a crashed `do
		// spec:<slug>` left behind. The blunt "wrong slug, or already at rest?"
		// refusal then actively MISLEADS: it asserts nothing is held while
		// `refs/dorfl/lock/spec-<slug>` sits right there on the arbiter, sending the
		// operator to look for a typo instead of at the lock they are holding.
		//
		// So before refusing, probe the SPEC namespace for the same slug and, on a
		// hit, name the verb that DOES own that lock. We do NOT release it here:
		// `requeue`'s contract is keep/continue/rebase/reset/reconcile of a WORK
		// BRANCH, and a tasking run has no work branch to continue — releasing a
		// spec lock from a task verb would fork a second release mechanism for the
		// ref `release-lock` already owns. A pointer, not a second implementation.
		//
		// Best-effort and non-fatal: the probe is one extra ref read on a path that
		// is already terminal, and any fault leaves the original refusal intact.
		let specHint = '';
		try {
			const specHeld = await readItemLock({
				item: `spec:${slug}`,
				cwd,
				arbiter,
				env,
			});
			if (specHeld) {
				specHint =
					` NOTE: a SPEC lock IS held for this slug ` +
					`(refs/dorfl/lock/spec-${slug}, ${specHeld.action}/${specHeld.state}` +
					`${specHeld.holder ? `, holder: ${specHeld.holder}` : ''}` +
					`${specHeld.since ? `, since: ${specHeld.since}` : ''}) — left by a ` +
					`\`do spec:${slug}\` run. requeue does not act on specs; if that run ` +
					`is DEAD, clear it with \`dorfl release-lock spec:${slug}\` (a crashed ` +
					`tasking run publishes no work branch, so releasing discards nothing).`;
			}
		} catch {
			// Best-effort hint only: fall through to the plain refusal.
		}
		return {
			moved: false,
			reasonNotMoved:
				`'${slug}' has no held per-item lock on ${arbiter} — nothing to requeue ` +
				'(wrong slug, or already at rest in backlog/done?). requeue recovers a ' +
				'task whose lock is held stuck (needs-attention) or active (a killed ' +
				'in-progress run).' +
				specHint,
		};
	}

	// `--reconcile`: the NON-DESTRUCTIVE recovery rung (task
	// `requeue-reconcile-nondestructive-recovery-verb`, parent observation
	// `rebase-conflict-on-continue-needs-nondestructive-recovery-not-reset`).
	// When the kept `work/<slug>` exists + is ahead of `<arbiter>/main`, re-sync
	// the mirror (prune-fetch — the exact step whose absence let
	// `requeue-reset-does-not-prune-hub-mirror-stale-branch-ref` silently
	// resurrect a stale branch) and RETRY the rebase in a SCRATCH worktree. Clean
	// rebase => push the reconciled tip back (`--force-with-lease`, never bare
	// force, WORK branch only — ADR §11) and fall through to the standard
	// keep+continue path. Genuine content conflict AFTER the clean re-sync =>
	// return with a message that LEADS with what happened, references the
	// deferred mirror-side resolve path, and mentions `--reset` LAST as the
	// destructive last resort. Branch absent / not-ahead => fall through to the
	// default keep+continue path (which handles the fresh-claim case). NEVER
	// deletes the remote branch — this verb's contract is "keep the work".
	let reconciled: boolean | undefined;
	if (options.reconcile) {
		if (options.reset) {
			return {
				moved: false,
				reasonNotMoved:
					`requeue for '${slug}': --reconcile and --reset are mutually ` +
					'exclusive (non-destructive recovery vs destructive last resort). ' +
					'Pick one.',
			};
		}
		const attempt = await attemptReconcile({
			cwd,
			slug,
			arbiter,
			env,
			note,
		});
		if (attempt.kind === 'conflict') {
			const branch = workBranchRef('task', slug);
			const message =
				`requeue --reconcile for '${slug}': re-synced the ${arbiter} mirror ` +
				`and RETRIED the rebase of ${branch} onto latest ${arbiter}/main, but ` +
				`the rebase still conflicts on genuine content (${attempt.detail}). The ` +
				'kept branch is left UNTOUCHED on the arbiter (nothing deleted) and the ' +
				'item is left stuck. A supported mirror-side "resolve against latest ' +
				'main" command that fetches the kept branch into a scratch worktree, ' +
				'rebases, and re-pushes is planned but not yet built (see observation ' +
				'`rebase-conflict-on-continue-needs-nondestructive-recovery-not-reset`, ' +
				'point 2 of its LIVE residue). LAST RESORT: `requeue --reset` ' +
				'DESTRUCTIVELY discards the branch and starts fresh.';
			note(message);
			return {moved: false, reasonNotMoved: message};
		}
		if (attempt.kind === 'reconciled') {
			reconciled = true;
			note(
				`Reconciled '${slug}': re-synced the ${arbiter} mirror, rebased the ` +
					`kept ${workBranchRef('task', slug)} onto latest ${arbiter}/main, and ` +
					'pushed the reconciled tip back (non-destructive; branch preserved).',
			);
		}
		// 'no-branch' => fall through to the default keep+continue path (branch
		// absent / not ahead — the existing default guard handles both cases).
	}

	// `--reset`: DELETE the remote work branch (before the backlog move). The
	// deletion is WRITE-THROUGH: the LOCAL refs that drive continue-detection
	// (`refs/remotes/<arbiter>/work/<slug>` AND any local head `work/<slug>`) are
	// deleted FIRST, THEN the arbiter `git push --delete`. The asymmetry is the
	// point: the arbiter is the source of truth and the local ref is derived, so
	// inverting today's arbiter-first ordering converts a dangerous failure mode
	// (local AHEAD of arbiter — a permanent stale-continue) into a self-healing
	// one (local BEHIND — the next fetch restores it from the arbiter). A FAILED
	// arbiter delete still ABORTS the requeue (no backlog move); the local
	// behind-state is recoverable by a subsequent fetch and CANNOT drive a wrong
	// continue. Delete-before-move also closes the claim-race window.
	let deletedRemoteBranch = false;
	if (options.reset) {
		const dropped = await deleteRemoteWorkBranchIfPresent({
			cwd,
			arbiter,
			slug,
			env,
		});
		if (dropped.status === 'failed') {
			const stderr = dropped.stderr;
			const message =
				`requeue --reset for '${slug}': failed to delete the remote branch ` +
				`${dropped.branch} on ${arbiter} (${stderr || 'unknown error'}); ` +
				'aborting the requeue — item left in needs-attention (no backlog move). ' +
				'The local tracking ref was already cleared (write-through ordering); ' +
				'a subsequent fetch will restore it from the arbiter — the local store ' +
				'is BEHIND the arbiter (self-healing), never AHEAD (which would drive a ' +
				'stale continue).';
			note(message);
			return {moved: false, reasonNotMoved: message};
		}
		deletedRemoteBranch = true;
		note(
			`Deleted the remote branch ${dropped.branch} on ${arbiter} (--reset).`,
		);
	}

	// DEFAULT (keep+continue) REQUEUE-SAFETY GUARD: a claimable item's continue-
	// branch MUST be reachable by ANY worker, so before releasing the lock verify
	// the ARBITER branch `<arbiter>/work/<slug>` exists + is ahead of main — the
	// EXACT "is the continue-branch on the arbiter?" question the continue-path asks
	// in `isolation.ts`. We check the ARBITER ref (already fetched above), NOT the
	// local `work/<slug>` (which SURVIVES a failed push). NOT on `--reset` (which
	// discards the branch by design).
	let continueBranch: ResolvedContinueBranch | undefined;
	if (!options.reset) {
		const branch = continueBranchName;
		// Resolve the continue-branch state EXACTLY ONCE, ARBITER-AUTHORITATIVELY, and
		// reuse that single answer for the guard decision, the note, AND the caller's
		// report (`result.continueBranch`). Previously this read the local tracking ref
		// `<arbiter>/work/<slug>` — a ref the bare-mirror job worktree never has — so
		// it answered "absent" for a branch that was sitting on the arbiter, and the
		// caller's own separate probe then contradicted it in the very next line.
		const resolved = await resolveArbiterBranch({cwd, arbiter, branch, env});
		const present = resolved.sha !== undefined;
		// AHEAD-of-main only makes sense when the branch is present. `refreshArbiterRefs`
		// above put the objects + tracking ref in place, so the comparison is local;
		// fall back to the arbiter-reported sha when the tracking ref is still missing
		// (e.g. the refspec git refused because the branch is checked out HERE — in
		// which case the local head of the same name IS the branch).
		const aheadOfMain = present
			? branchAheadOf(cwd, `${arbiter}/${branch}`, `${arbiter}/main`, env) ||
				branchAheadOf(cwd, resolved.sha!, `${arbiter}/main`, env)
			: false;
		continueBranch = {
			branch,
			present,
			...(resolved.sha !== undefined ? {sha: resolved.sha} : {}),
			aheadOfMain,
			trustworthy: resolved.trustworthy,
		};

		// Split the guard into TWO cases (task
		// `default-requeue-succeeds-when-no-work-branch-exists`):
		//   (a) the arbiter branch does NOT EXIST at all (never pushed, or a prior
		//       `--reset` already deleted it) — there is NO continue-branch a future
		//       worker would resume from, so the guard's precondition is vacuously
		//       satisfied. Degrade gracefully to the same effective outcome as
		//       `--reset` (nothing to discard) and proceed with the keep+continue
		//       backlog move: no arbiter delete (there is nothing to delete), no
		//       forcing the caller into the destructive `--reset` verb.
		//   (b) the arbiter branch EXISTS but is NOT ahead of `<arbiter>/main` — a
		//       real anomaly (the continue-branch would resume from a state already
		//       reachable from main). Preserve today's refusal so the case surfaces.
		if (!present) {
			// Say "nothing to continue from" ONLY off a read the arbiter actually
			// answered. On an unreachable arbiter we cannot know, and claiming a branch
			// is absent is the dangerous direction (an operator or wrapper acting on it
			// re-drives the task from scratch and discards the saved work).
			note(
				resolved.trustworthy
					? `'${slug}' has no work branch on ${arbiter} — requeueing to backlog ` +
							'for a FRESH claim (nothing to continue from; no --reset needed).'
					: `'${slug}': could not read ${arbiter} to tell whether a work branch ` +
							`exists (${resolved.unreachableDetail ?? 'arbiter unreachable'}) — ` +
							'requeueing to backlog WITHOUT asserting there is nothing to ' +
							'continue from. Do NOT re-drive from scratch until the branch has ' +
							'been checked.',
			);
		} else if (!aheadOfMain) {
			const message =
				`the work branch ${branch} isn't on ${arbiter} (the continue ` +
				`branch a cross-machine worker would resume from) — push it first, or ` +
				'`requeue --reset` to discard and start fresh. Item left stuck (lock not ' +
				'released).';
			note(message);
			return {moved: false, reasonNotMoved: message, continueBranch};
		}
	}

	const commitMessage = `chore(${slug}): return to backlog for re-claiming`;
	const handoff =
		options.message && options.message.trim() !== ''
			? options.message.trim()
			: undefined;
	// The body rests EITHER in the pool (`tasks-ready`) OR — for a staged item driven
	// with `--allow-backlog` — in staging (`tasks-backlog`). Probe in the SAME
	// precedence `resolveTask`/`--allow-backlog` uses (ready first, then backlog), so
	// the handoff note finds a staged body too (obs
	// `requeue-dash-m-fails-and-strands-lock-for-staged-backlog-item`).
	const bodyResidenceCandidates: readonly WorkFolderKey[] = [
		'tasks-ready',
		'tasks-backlog',
	];

	// `-m "<note>"` (the handoff steer): APPEND a dated `## Requeue YYYY-MM-DD`
	// section to the item BODY where it already rests (pool or staging), via the SAME
	// tree-less CAS move (same-folder rewrite with the body transform) — it NEVER
	// stages/commits in the cwd tree. The handoff is OPTIONAL and NON-FATAL: a failed
	// append degrades to a WARNING and the lock release below STILL runs, because the
	// lock release is the load-bearing recovery and must never be stranded by an
	// optional note (obs `requeue-dash-m-fails-and-strands-lock-for-staged-backlog-item`).
	if (handoff !== undefined) {
		const noted = await runTreelessLedgerMove({
			cwd,
			slug,
			arbiter,
			kind: 'requeue',
			onContended: 'requeue',
			explicitMainRefspec: false,
			env,
			note,
			plan: (base) => {
				const bodyRel = bodyResidenceCandidates
					.map((folder) => workItemRel(folder, `${slug}.md`))
					.find((rel) => pathInCommit(base, rel, cwd, env));
				if (bodyRel === undefined) {
					// The body is in neither tasks/ready/ nor tasks/backlog/ on this base —
					// nothing to annotate (the durable move that placed it must land first).
					return 'missing';
				}
				return prepareTreelessMoveCommit({
					cwd,
					slug,
					base,
					sourceRel: bodyRel,
					destRel: bodyRel,
					transformBody: (body) => appendRequeueNoteText(body, handoff),
					commitMessage: `chore(${slug}): requeue handoff note`,
					refNamespace: 'requeue',
					env,
				});
			},
		});
		if (!noted) {
			// NON-FATAL: warn and fall through to the lock release. We do NOT strand the
			// lock for a failed OPTIONAL note (the previous behaviour, which left a
			// half-applied state: branch deleted on --reset, lock still held).
			note(
				`requeue for '${slug}': could not append the -m handoff note (the body ` +
					`is in neither tasks/ready/ nor tasks/backlog/ on ${arbiter}/main, or ` +
					'main kept moving). Releasing the lock anyway — the requeue still ' +
					'recovers the item; only the note was skipped.',
			);
		}
	}

	// RELEASE the held lock (`stuck → released` / give up the hold): the item
	// returns to the claimable pool (its body already rests in `backlog/`). Use the
	// tolerant {@link releaseItemLock} (idempotent) so requeue recovers BOTH a
	// `stuck` hold (the resolved-recovery path) and an `active` hold (a killed run
	// that never surfaced) — the human asserting "put it back".
	const released = await releaseItemLock({
		item: `task:${slug}`,
		cwd,
		arbiter,
		env,
	});
	if (released.outcome === 'error') {
		const message =
			`requeue for '${slug}': could not release the per-item lock ` +
			`(${released.message}). The item is left stuck. Try again shortly.`;
		note(message);
		return {moved: false, reasonNotMoved: message, continueBranch};
	}
	// Derive the closing line from the SAME resolved state the guard used, so this
	// note can never contradict the one above it.
	note(
		`Returned '${slug}' to backlog (released the lock; body rests in pool)` +
			(continueBranch?.aheadOfMain === true
				? `; the next claim continues from ${continueBranch.branch}.`
				: '.'),
	);
	return {
		moved: true,
		commitMessage,
		deletedRemoteBranch,
		reconciled,
		continueBranch,
	};
}

/**
 * The outcome of an in-progress `--reconcile` attempt (task
 * `requeue-reconcile-nondestructive-recovery-verb`):
 *   - `'reconciled'` — mirror re-synced, rebase onto latest `<arbiter>/main`
 *     was clean AND the reconciled tip was pushed back to the arbiter. The
 *     caller falls through to the default keep+continue path.
 *   - `'no-branch'` — the arbiter's `work/<slug>` is absent or not ahead of
 *     main after the re-sync. Nothing to reconcile; the caller falls through
 *     to the default keep+continue path (which itself handles the fresh-claim
 *     case gracefully).
 *   - `'conflict'` — the rebase after the CLEAN mirror re-sync still
 *     conflicted on genuine content, or the reconciled-tip push failed. The
 *     branch is left untouched on the arbiter; the caller returns a stuck
 *     message that leads with what was tried and mentions `--reset` LAST.
 */
type ReconcileAttempt =
	| {kind: 'reconciled'}
	| {kind: 'no-branch'}
	| {kind: 'conflict'; detail: string};

/**
 * The `--reconcile` recovery attempt — the non-destructive middle rung of the
 * `requeue` escalation ladder. Runs in a SCRATCH worktree so the caller's cwd
 * tree/HEAD/index is NEVER touched (parity with the tree-less move machinery):
 *
 *   1. **Re-sync the mirror.** `git fetch --prune <arbiter>` on the caller's
 *      cwd — the exact prune step whose absence let
 *      `requeue-reset-does-not-prune-hub-mirror-stale-branch-ref` silently
 *      resurrect a supposedly-`--reset`-ed branch. This clears the stale
 *      remote-tracking residue that historically fooled the retry.
 *   2. **Guard.** The arbiter's `work/<slug>` must EXIST + be ahead of main
 *      (via {@link branchAheadOf} on the freshly-fetched
 *      `<arbiter>/work/<slug>` vs `<arbiter>/main`). Absent / not-ahead =>
 *      `'no-branch'` and the caller falls through to the default keep+continue
 *      path.
 *   3. **Rebase in a scratch worktree.** `git worktree add --detach <scratch>
 *      <arbiter>/work/<slug>` and run {@link rebaseContinuedBranchOntoMain}
 *      against `<arbiter>/main`. A CLEAN rebase is a full non-destructive fix;
 *      a CONFLICT is `--abort`ed (never auto-resolved) => `'conflict'`.
 *   4. **Push the reconciled tip back.** `git push <arbiter> HEAD:work/<slug>
 *      --force-with-lease=work/<slug>:<observed-arbiter-tip>` from the scratch
 *      worktree. `--force-with-lease` ONLY, NEVER bare `--force`, NEVER
 *      `:main`, the WORK branch ONLY (ADR §11). A rejected push (stale lease
 *      or otherwise) => `'conflict'` — non-destructive by construction, the
 *      user can retry.
 *
 * Cleanup of the scratch worktree is best-effort in a `finally` (never fails
 * the reconcile on cleanup).
 */
async function attemptReconcile(params: {
	cwd: string;
	slug: string;
	arbiter: string;
	env: NodeJS.ProcessEnv | undefined;
	note: (message: string) => void;
}): Promise<ReconcileAttempt> {
	const {cwd, slug, arbiter, env, note} = params;
	const branch = workBranchRef('task', slug);
	const arbBranchRef = `refs/remotes/${arbiter}/${branch}`;
	const arbMainRef = `refs/remotes/${arbiter}/main`;

	// 1. Re-sync the mirror to the arbiter (prune-fetch clears stale refs).
	await gitSoftAsync(['fetch', '--prune', '--quiet', arbiter], cwd, env);

	// 2. Guard: branch must exist + be ahead of main.
	if (!branchAheadOf(cwd, arbBranchRef, arbMainRef, env)) {
		return {kind: 'no-branch'};
	}

	// 3. Scratch worktree — the caller's tree is NEVER touched.
	const worktree = join(
		tmpdir(),
		`dorfl-reconcile-${slug}-${process.pid}-${Date.now()}`,
	);
	const wtCreate = gitSoftRun(
		['worktree', 'add', '--quiet', '--detach', worktree, arbBranchRef],
		cwd,
		env,
	);
	if (wtCreate.status !== 0) {
		return {
			kind: 'conflict',
			detail: `could not create scratch worktree (${wtCreate.stderr.trim() || `exit ${wtCreate.status}`})`,
		};
	}
	try {
		const rebase = rebaseContinuedBranchOntoMain(worktree, arbMainRef, env);
		if (rebase.kind === 'conflict') {
			return {kind: 'conflict', detail: 'rebase conflicted after re-sync'};
		}
		// 4. Push the reconciled tip back (`--force-with-lease`, WORK branch only).
		const observedTip = gitSoftRun(
			['rev-parse', '--verify', '--quiet', `${arbBranchRef}^{commit}`],
			cwd,
			env,
		).stdout.trim();
		const lease =
			observedTip === '' ? `${branch}:` : `${branch}:${observedTip}`;
		const push = gitSoftRun(
			[
				'push',
				arbiter,
				`HEAD:refs/heads/${branch}`,
				`--force-with-lease=${lease}`,
			],
			worktree,
			env,
		);
		if (push.status !== 0) {
			return {
				kind: 'conflict',
				detail: `push of reconciled tip rejected (${push.stderr.trim() || `exit ${push.status}`})`,
			};
		}
		// Advance the local remote-tracking ref so subsequent reads see the truth.
		await gitSoftAsync(['fetch', '--quiet', arbiter], cwd, env);
		void note;
		return {kind: 'reconciled'};
	} finally {
		await gitSoftAsync(['worktree', 'remove', '--force', worktree], cwd, env);
	}
}

/**
 * **Promote a STAGED task into the agent-eligible pool** (spec
 * `staging-pool-position-gate-and-trust-model`, task
 * `pre-backlog-staging-folder-and-promote-step-a`, governing ADR
 * `placement-is-runner-deterministic-humanonly-is-agent-judgement`). Moves
 * `work/tasks/backlog/<slug>.md → work/tasks/ready/<slug>.md` as a durable `main`
 * move, the same category as {@link returnToBacklog} (tree-less CAS via
 * {@link runTreelessLedgerMove}). After this transition the task is in the
 * pool and claimable.
 *
 * **RUNNER/human-owned.** There is no agent-facing path that performs this:
 * the agent's tasking output lands STAGED in `work/tasks/backlog/` (the runner's
 * deterministic placement decision), and only a runner/human invocation moves
 * it into the pool. The agent does no git here, as everywhere.
 *
 * Storage-agnostic: it names the slug + the arbiter, NOT *where* the move
 * lands; the sole strategy publishes to `<arbiter>/main`. Like
 * {@link returnToBacklog} the tree-less CAS needs a ref to push to, so an
 * `arbiter` is REQUIRED. NEVER throws for the expected
 * "not in tasks/backlog/" / contention-exhausted cases — it returns
 * `{moved: false, reasonNotMoved}` so callers can branch cleanly.
 */
export interface PromoteFromPreBacklogOptions {
	/**
	 * The working clone the move is ORIGINATED from — purely the ORIGIN SOURCE
	 * (it resolves the arbiter remote + holds the object store the plumbing
	 * writes into), NEVER a write TARGET. Tree-less: the cwd index/HEAD/working
	 * tree are never touched (parity with {@link returnToBacklog}).
	 */
	cwd: string;
	/** The slug of the staged task to promote into the pool. */
	slug: string;
	/**
	 * The arbiter remote the promotion is CAS-published to. REQUIRED — the
	 * tree-less CAS needs a ref to push to (parity with `requeue`/`claim`).
	 */
	arbiter: string;
	/** Environment for child git processes (identity etc.). */
	env?: NodeJS.ProcessEnv;
	/** Sink for human-readable progress notes. */
	note?: (message: string) => void;
}

export interface PromoteFromPreBacklogResult {
	/** True iff the staged task was moved into the pool + committed. */
	moved: boolean;
	/** When `moved`, the committed transition message. */
	commitMessage?: string;
	/** When NOT moved, why (no such staged item, already in the pool, contention). */
	reasonNotMoved?: string;
}

export async function promoteFromPreBacklog(
	options: PromoteFromPreBacklogOptions,
): Promise<PromoteFromPreBacklogResult> {
	const note = options.note ?? (() => {});
	const {cwd, slug, env} = options;

	if (!options.arbiter) {
		return {
			moved: false,
			reasonNotMoved:
				`promote for '${slug}' needs an --arbiter: the move is published as a ` +
				'tree-less compare-and-swap to the arbiter ref (like requeue/claim), so ' +
				'there is no local-only mode — pass --arbiter.',
		};
	}
	const arbiter = options.arbiter;

	if (
		(await gitSoftAsync(['remote', 'get-url', arbiter], cwd, env)).status !== 0
	) {
		return {
			moved: false,
			reasonNotMoved: `no git remote named '${arbiter}' (set one, or pass --arbiter).`,
		};
	}

	// Refresh `<arbiter>/main` so the residence probe + the CAS base see the
	// arbiter's TRUTH. A fetch, not a checkout — the working tree is untouched.
	await gitSoftAsync(['fetch', '--quiet', arbiter], cwd, env);

	// UNIFIED PER-ITEM LOCK around the CAS window (spec
	// `staging-surface-and-apply-promote-safety`, task
	// `f3b-promote-takes-per-item-advancing-lock`): promote and apply BOTH key onto
	// the item's `refs/dorfl/lock/<entry>` ref with `action: advance` (the
	// SAME action `apply` takes via `advancing-lock.ts`), so an apply mid-flight
	// and a promote attempt on the SAME item are mutually exclusive BY
	// CONSTRUCTION (the second acquirer loses the create-only ref CAS). Reusing
	// the existing `advance` action value (rather than introducing a distinct
	// `'promote'` axis) is deliberate — the lock entry is keyed on the item
	// identity, and what matters is that ALL three transitions of one item
	// (implement/task/advance) serialise on ONE ref. A lock `lost` exits CLEAN
	// (no partial state on `main`, mirroring claim-cas loss semantics); on success
	// or failure we release the lock in `finally`. Crash-safe release mirrors the
	// apply rung: a crashed promote leaves an `advance`-active lock that the
	// existing `release-lock` / `gc --ledger` recovery surface clears.
	const item = `task:${slug}`;
	const acquired = await acquireItemLock({
		item,
		action: 'advance',
		cwd,
		arbiter,
		env,
	});
	if (acquired.outcome !== 'acquired') {
		const message =
			acquired.outcome === 'lost'
				? `promote for '${slug}' lost the per-item lock race (another implement/task/advance hold is in flight). No move on ${arbiter}/main. Try again shortly.`
				: `promote for '${slug}': could not acquire the per-item lock (${acquired.message}).`;
		note(message);
		return {moved: false, reasonNotMoved: message};
	}
	try {
		const sourceRel = workItemRel('tasks-backlog', `${slug}.md`);
		const destRel = workItemRel('tasks-ready', `${slug}.md`);

		// Early-exit message: if NEITHER staged nor already-in-pool, there is
		// nothing to promote (the per-attempt `plan` is the authoritative
		// resolution against the live base).
		const hasSource =
			(
				await gitSoftAsync(
					['cat-file', '-e', `${arbiter}/main:${sourceRel}`],
					cwd,
					env,
				)
			).status === 0;
		const hasDest =
			(
				await gitSoftAsync(
					['cat-file', '-e', `${arbiter}/main:${destRel}`],
					cwd,
					env,
				)
			).status === 0;
		if (!hasSource && !hasDest) {
			const message =
				`'${slug}' is not staged in ${workFolderPrefix('tasks-backlog')} on ${arbiter}/main ` +
				`(and not already in ${workFolderPrefix('tasks-ready')}) — nothing to promote ` +
				'(wrong slug, or never staged?).';
			note(message);
			return {moved: false, reasonNotMoved: message};
		}

		const commitMessage = `chore(${slug}): promote ${workFolderPrefix(
			'tasks-backlog',
		)} -> ${workFolderPrefix('tasks-ready')}`;
		const moved = await runTreelessLedgerMove({
			cwd,
			slug,
			arbiter,
			kind: 'promote',
			onContended: 'promote',
			// The surface direction's main-only refspec works here too: this runs in
			// the project checkout, but we only need `<arbiter>/main` resolved, and
			// the explicit refspec is the safer default (mirrors `surface`).
			explicitMainRefspec: true,
			env,
			note,
			plan: (base) => {
				// If already in the pool on this base, a prior attempt landed
				// (idempotent).
				if (pathInCommit(base, destRel, cwd, env)) {
					return 'already-done';
				}
				if (!pathInCommit(base, sourceRel, cwd, env)) {
					return 'missing';
				}
				return prepareTreelessMoveCommit({
					cwd,
					slug,
					base,
					sourceRel,
					destRel,
					// The body is carried byte-for-byte from tasks/backlog into the
					// pool — promotion is a placement decision, not a content transform.
					transformBody: (body) => body,
					commitMessage,
					refNamespace: 'promote',
					env,
				});
			},
		});
		if (moved) {
			note(`Promoted '${slug}' from tasks/backlog to tasks/ready (claimable).`);
			return {moved: true, commitMessage};
		}

		const message =
			`promote for '${slug}': the arbiter's main kept moving (contended) after ` +
			`${TREELESS_CONTENTION_ATTEMPTS} attempts — item left in tasks/backlog ` +
			'(no move). Try again shortly.';
		note(message);
		return {moved: false, reasonNotMoved: message};
	} finally {
		await releaseItemLock({item, cwd, arbiter, env});
	}
}

/**
 * **Promote a STAGED spec into the auto-task pool** (spec
 * `staging-pool-position-gate-and-trust-model`, task
 * `pre-prd-staging-pool-split-and-untrusted-prd-placement`, governing ADR
 * `placement-is-runner-deterministic-humanonly-is-agent-judgement`). The spec
 * twin of {@link promoteFromPreBacklog}: moves
 * `work/specs/proposed/<slug>.md → work/specs/ready/<slug>.md` as a durable `main` move
 * (tree-less CAS via {@link runTreelessLedgerMove}). After this transition
 * the spec is in the auto-task POOL and eligible to be auto-tasked (subject
 * to the existing `autoTask`/`humanOnly`/`needsAnswers`/`taskedAfter` gates,
 * which are UNCHANGED — the staging/pool split changes only WHICH folder is
 * the auto-task pool, not the gates).
 *
 * **RUNNER/human-owned.** There is no agent-facing path that performs this:
 * `intake`'s `spec` dispatch lands the spec STAGED in `work/specs/proposed/` (the
 * runner's deterministic placement decision), and only a runner/human
 * invocation moves it into the pool. The agent does no git here, as
 * everywhere; this function is not reachable from any agent surface.
 *
 * Storage-agnostic + tree-less, exactly like {@link promoteFromPreBacklog}:
 * cwd index/HEAD/working tree are never touched, an arbiter remote is
 * REQUIRED, and "not in specs/proposed/" / contention-exhausted cases are returned
 * (NEVER thrown) via `{moved: false, reasonNotMoved}` so callers branch
 * cleanly. Idempotent: re-running after the move LANDED is a no-op success.
 */
export interface PromoteFromPreSpecOptions {
	/** The working clone the move is originated from (origin source only; never written). */
	cwd: string;
	/** The slug of the staged spec to promote into the pool. */
	slug: string;
	/** The arbiter remote the promotion is CAS-published to. REQUIRED. */
	arbiter: string;
	/** Environment for child git processes (identity etc.). */
	env?: NodeJS.ProcessEnv;
	/** Sink for human-readable progress notes. */
	note?: (message: string) => void;
}

export interface PromoteFromPreSpecResult {
	/** True iff the staged spec was moved into the pool + committed. */
	moved: boolean;
	/** When `moved`, the committed transition message. */
	commitMessage?: string;
	/** When NOT moved, why (no such specs/proposed item, already in specs/ready/, contention). */
	reasonNotMoved?: string;
}

export async function promoteFromPreSpec(
	options: PromoteFromPreSpecOptions,
): Promise<PromoteFromPreSpecResult> {
	const note = options.note ?? (() => {});
	const {cwd, slug, env} = options;

	if (!options.arbiter) {
		return {
			moved: false,
			reasonNotMoved:
				`promote for '${slug}' needs an --arbiter: the move is published as ` +
				'a tree-less compare-and-swap to the arbiter ref (like requeue/claim), so ' +
				'there is no local-only mode — pass --arbiter.',
		};
	}
	const arbiter = options.arbiter;

	if (
		(await gitSoftAsync(['remote', 'get-url', arbiter], cwd, env)).status !== 0
	) {
		return {
			moved: false,
			reasonNotMoved: `no git remote named '${arbiter}' (set one, or pass --arbiter).`,
		};
	}

	// Refresh `<arbiter>/main` so the residence probe + the CAS base see the
	// arbiter's TRUTH. A fetch, not a checkout — the working tree is untouched.
	await gitSoftAsync(['fetch', '--quiet', arbiter], cwd, env);

	// UNIFIED PER-ITEM LOCK around the CAS window — symmetric with
	// {@link promoteFromPreBacklog} (spec `staging-surface-and-apply-promote-safety`,
	// task `f3b-promote-takes-per-item-advancing-lock`, decisive spec q4 answer:
	// specs share the apply×promote mutual-exclusion fix with tasks). The lock
	// keys on `spec:${slug}` (a distinct ref from a task with the same slug, via
	// {@link lockEntryFor}'s `<type>-<slug>` encoding), with `action: advance` —
	// the SAME action an apply for a spec would take — so spec promote and spec
	// apply on the same item are mutually exclusive by construction. MIGRATE step
	// (spec `prd-to-spec-vocabulary-cutover-and-migration-command`): the lock
	// identity is `spec:${slug}` to match the `spec-<slug>` entry the tasking/apply
	// path now acquires (`tasking.ts` releases under `spec:${slug}`); a stale
	// ''prd:${slug}'' here would key a DIFFERENT ref and break the mutual exclusion.
	// Loss / crash semantics mirror the task case.
	const item = `spec:${slug}`;
	const acquired = await acquireItemLock({
		item,
		action: 'advance',
		cwd,
		arbiter,
		env,
	});
	if (acquired.outcome !== 'acquired') {
		const message =
			acquired.outcome === 'lost'
				? `promote for '${slug}' lost the per-item lock race (another implement/task/advance hold is in flight). No move on ${arbiter}/main. Try again shortly.`
				: `promote for '${slug}': could not acquire the per-item lock (${acquired.message}).`;
		note(message);
		return {moved: false, reasonNotMoved: message};
	}
	try {
		const sourceRel = workItemRel('specs-proposed', `${slug}.md`);
		const destRel = workItemRel('specs-ready', `${slug}.md`);

		const hasSource =
			(
				await gitSoftAsync(
					['cat-file', '-e', `${arbiter}/main:${sourceRel}`],
					cwd,
					env,
				)
			).status === 0;
		const hasDest =
			(
				await gitSoftAsync(
					['cat-file', '-e', `${arbiter}/main:${destRel}`],
					cwd,
					env,
				)
			).status === 0;
		if (!hasSource && !hasDest) {
			const message =
				`'${slug}' is not staged in ${workFolderPrefix('specs-proposed')} on ${arbiter}/main ` +
				`(and not already in ${workFolderPrefix('specs-ready')}) — nothing to promote ` +
				'(wrong slug, or never staged?).';
			note(message);
			return {moved: false, reasonNotMoved: message};
		}

		const commitMessage = `chore(${slug}): promote ${workFolderPrefix(
			'specs-proposed',
		)} -> ${workFolderPrefix('specs-ready')}`;
		const moved = await runTreelessLedgerMove({
			cwd,
			slug,
			arbiter,
			kind: 'promote',
			onContended: 'promote',
			explicitMainRefspec: true,
			env,
			note,
			plan: (base) => {
				if (pathInCommit(base, destRel, cwd, env)) {
					return 'already-done';
				}
				if (!pathInCommit(base, sourceRel, cwd, env)) {
					return 'missing';
				}
				return prepareTreelessMoveCommit({
					cwd,
					slug,
					base,
					sourceRel,
					destRel,
					// The body is carried byte-for-byte from specs/proposed into the pool —
					// promotion is a placement decision, not a content transform.
					transformBody: (body) => body,
					commitMessage,
					refNamespace: 'promote',
					env,
				});
			},
		});
		if (moved) {
			note(
				`Promoted spec '${slug}' from specs/proposed to specs/ready (auto-taskable).`,
			);
			return {moved: true, commitMessage};
		}

		const message =
			`promote for '${slug}': the arbiter's main kept moving (contended) ` +
			`after ${TREELESS_CONTENTION_ATTEMPTS} attempts — item left in specs/proposed ` +
			'(no move). Try again shortly.';
		note(message);
		return {moved: false, reasonNotMoved: message};
	} finally {
		await releaseItemLock({item, cwd, arbiter, env});
	}
}

/** One staged item awaiting promotion (a task in `tasks/backlog/` or a spec in `specs/proposed/`). */
export interface PromotableItem {
	/** `'task'` (staged in `work/tasks/backlog/`) or `'spec'` (staged in `work/specs/proposed/`). */
	namespace: 'task' | 'spec';
	/** The slug (filename minus `.md`). */
	slug: string;
}

export interface ListPromotableOptions {
	/** The working clone the arbiter remote is resolved FROM (origin source only). */
	cwd: string;
	/** The arbiter remote whose `main` the staging folders are read from. REQUIRED. */
	arbiter: string;
	/** Environment for child git processes. */
	env?: NodeJS.ProcessEnv;
}

export interface ListPromotableResult {
	/** Every staged item awaiting promotion, tasks then prds, each sorted by slug. */
	items: PromotableItem[];
	/** When the listing could not run (no such remote), why. */
	error?: string;
}

/**
 * LIST every staged item awaiting a runner/human promotion — the tasks in
 * `work/tasks/backlog/` and the prds in `work/specs/proposed/` on `<arbiter>/main` (the
 * discovery half of the `promote` verb, so `promote` with no argument answers
 * "what is staged waiting for me?"). It reads the ARBITER's truth (a fetch + a
 * tree read), NOT the local working tree (which may be stale) — the same source
 * the promotion functions act against, so the list and the move never disagree.
 * Read-only: it never fetches a checkout, never moves anything.
 */
export async function listPromotable(
	options: ListPromotableOptions,
): Promise<ListPromotableResult> {
	const {cwd, arbiter, env} = options;
	if (
		(await gitSoftAsync(['remote', 'get-url', arbiter], cwd, env)).status !== 0
	) {
		return {
			items: [],
			error: `no git remote named '${arbiter}' (set one, or pass --arbiter).`,
		};
	}
	// Refresh `<arbiter>/main` so the listing sees the arbiter's TRUTH (a fetch,
	// not a checkout — the working tree is untouched), exactly as the promote
	// functions do before their residence probe.
	await gitSoftAsync(['fetch', '--quiet', arbiter], cwd, env);
	const tasks = await listMarkdownSlugsInTree(
		`${arbiter}/main:${workFolderRel('tasks-backlog')}`,
		cwd,
		env,
	);
	const specs = await listMarkdownSlugsInTree(
		`${arbiter}/main:${workFolderRel('specs-proposed')}`,
		cwd,
		env,
	);
	return {
		items: [
			...tasks.map((slug) => ({namespace: 'task' as const, slug})),
			...specs.map((slug) => ({namespace: 'spec' as const, slug})),
		],
	};
}

/**
 * `git ls-tree --name-only <base>` → the `.md` filenames' SLUGS (filename minus
 * `.md`), sorted. An absent folder on the ref reads as empty (the staging folder
 * may not exist yet). The bare-repo-safe read (`ls-tree`, no working tree), the
 * SAME mechanism the ledger read seam uses.
 */
async function listMarkdownSlugsInTree(
	base: string,
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<string[]> {
	const tree = await gitSoftAsync(['ls-tree', '--name-only', base], cwd, env);
	if (tree.status !== 0) {
		return [];
	}
	return tree.stdout
		.split('\n')
		.map((s) => s.trim())
		.filter((name) => isWorkItemFile(name))
		.map((name) => name.replace(/\.md$/i, ''))
		.sort();
}

/** The contention-retry cap shared by the tree-less requeue + surface moves. */
const TREELESS_CONTENTION_ATTEMPTS = 5;

/**
 * The plan for ONE attempt of a tree-less move, computed FRESH against the
 * current (re-fetched) base so a retry never reuses a stale source/blob:
 *  - `{ref, commit}` — a prepared move commit on a throwaway ref, ready to CAS.
 *  - `'already-done'` — the item is ALREADY at the destination on this base (an
 *    idempotent re-surface, or a prior attempt that actually landed but whose CAS
 *    verify reported rejected) — treat as success, no push needed.
 *  - `'missing'` — the item is in NEITHER the source nor the destination folder on
 *    this base — nothing to move.
 */
type TreelessAttemptPlan =
	| {ref: string; commit: string}
	| 'already-done'
	| 'missing';

/**
 * The SHARED tree-less ledger-move core (ONE mechanism for BOTH directions — the
 * requeue `needs-attention|in-progress → backlog` and the surface `in-progress →
 * needs-attention`). It runs the contention-retry loop: fetch `<arbiter>/main`,
 * resolve `expectedBase`, ask the caller's `plan(base)` to build the one-file move
 * on a SCRATCH INDEX via {@link prepareTreelessMoveCommit} (so the caller's
 * index/HEAD/working tree are NEVER touched), CAS-publish it THROUGH the shared
 * write seam (`ledgerWrite.applyTransition`, the very push+lease+verify `claim`
 * uses), drop the throwaway ref, and on a CONTENTION rejection refetch + REPLAN
 * against the advanced base and retry. Re-planning per attempt is what makes the
 * retry safe when the item itself moved under us (e.g. a prior attempt landed but
 * the CAS verify reported rejected): the next plan sees it `already-done`.
 */
async function runTreelessLedgerMove(params: {
	cwd: string;
	slug: string;
	arbiter: string;
	kind: LedgerTransitionKind;
	/** Build (or short-circuit) the move against the current base. Called per attempt. */
	plan: (base: string) => TreelessAttemptPlan;
	/** A label for the contention-progress note (the verb the caller surfaces). */
	onContended: string;
	/**
	 * Fetch the arbiter's `main` with an EXPLICIT refspec
	 * (`+refs/heads/main:refs/remotes/<arbiter>/main`) instead of a plain
	 * `fetch <arbiter>`. The surface direction sets this `true` because it runs from
	 * a JOB WORKTREE whose remote's default fetch refspec may NOT map `main →
	 * refs/remotes/<arbiter>/main` (a bare-mirror worktree), so the plain fetch can
	 * leave `<arbiter>/main` unresolved. The requeue direction leaves it `false`: it
	 * needs ALL refs (the continue-branch guard reads `<arbiter>/work/<slug>`), so a
	 * main-only refspec would be too narrow there.
	 */
	explicitMainRefspec: boolean;
	env: NodeJS.ProcessEnv | undefined;
	note: (message: string) => void;
}): Promise<boolean> {
	const {
		cwd,
		arbiter,
		kind,
		plan,
		onContended,
		explicitMainRefspec,
		env,
		note,
	} = params;
	// `explicitMainRefspec` is now VESTIGIAL: the shared refresh below always uses
	// the explicit per-branch refspec, because the plain `git fetch <arbiter>` the
	// `false` case used is exactly what made the surface path read a view PREDATING
	// its own write (and, in a bare-mirror job worktree, fail outright) — see
	// `arbiter-refs.ts` and observation
	// `checkpoint-path-reports-its-own-write-as-absent`. It is kept in the signature
	// only so the two call sites stay explicit about which direction they are; the
	// requeue direction refreshes its OTHER refs (the continue-branch guard) itself.
	void explicitMainRefspec;
	const refreshMain = async (): Promise<void> => {
		await refreshArbiterRefs({cwd, arbiter, branches: ['main'], env});
	};

	for (let i = 0; i < TREELESS_CONTENTION_ATTEMPTS; i++) {
		if (i > 0) {
			await refreshMain();
		}
		const base = (
			await gitHardAsync(['rev-parse', `${arbiter}/main`], cwd, env)
		).stdout.trim();

		// Plan the move FRESH against this (possibly re-fetched) base. The item may
		// already be at the destination (idempotent / a prior landed-but-reported-
		// rejected attempt) or absent — both are terminal, no push.
		const prepared = plan(base);
		if (prepared === 'already-done') {
			return true;
		}
		if (prepared === 'missing') {
			return false;
		}

		// COMMIT-LEVEL IDEMPOTENCE (observation
		// `checkpoint-path-reports-its-own-write-as-absent`): if the planned commit's
		// TREE is identical to the base's, this transition has NOTHING to write —
		// whatever it wanted to say is already on `main`. Publishing it anyway appends
		// an empty commit, which is how one bounce turned into five identical commits
		// (the retry budget, not anything real, set the commit count). An empty diff is
		// the DESIRED end state, so report landed and push nothing.
		const baseTree = (
			await gitHardAsync(['rev-parse', `${base}^{tree}`], cwd, env)
		).stdout.trim();
		const preparedTree = (
			await gitHardAsync(['rev-parse', `${prepared.commit}^{tree}`], cwd, env)
		).stdout.trim();
		if (preparedTree === baseTree) {
			await gitSoftAsync(['update-ref', '-d', prepared.ref], cwd, env);
			return true;
		}

		// Publish THROUGH the shared seam (the same `:main` push + force-with-lease +
		// verify `claim` uses). The transition's WHO stays the caller's ambient env
		// (threaded by `commit-tree` above) — tree-less is orthogonal to attribution.
		const result = await ledgerWrite.applyTransition({
			kind,
			arbiter,
			localBranch: prepared.ref,
			expectedBase: base,
			head: prepared.commit,
			cwd,
			env,
			note,
		});
		// Drop the throwaway ref either way (it served only as the push source).
		await gitSoftAsync(['update-ref', '-d', prepared.ref], cwd, env);

		if (result.kind === 'published') {
			// Advance the LOCAL remote-tracking `<arbiter>/main` so it INCLUDES the
			// move (the push only moved the arbiter's main). Best-effort.
			await refreshMain();
			return true;
		}
		// rejected: main moved under us — refetch + REPLAN against the new base.
		note(
			`main advanced under us — ${onContended} refetch and retry (${i + 1}/${TREELESS_CONTENTION_ATTEMPTS})...`,
		);
	}
	return false;
}

/** True iff `path` exists in the given commit's tree (a soft cat-file probe). */
function pathInCommit(
	commit: string,
	path: string,
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): boolean {
	return (
		run('git', ['cat-file', '-e', `${commit}:${path}`], cwd, {env}).status === 0
	);
}

/**
 * Build a one-file ledger MOVE as a commit off the arbiter's `main`, using
 * PLUMBING on a SCRATCH INDEX — it never touches the caller's index, HEAD, or
 * working tree (so a concurrent writer's uncommitted cwd files can never be swept
 * in). It loads `base`'s tree into a throwaway index, relocates ONLY this slug's
 * ledger file from `sourceRel` to `destRel` (applying `transformBody` to its body
 * first — read from the blob on `main`, NOT from any cwd file: the requeue note,
 * or the needs-attention reason), writes the tree, commits it parented on `base`,
 * and points a throwaway local ref at the commit. Returns that ref + the commit
 * sha for the seam's CAS push. The SHARED prep for BOTH tree-less directions.
 */
function prepareTreelessMoveCommit(params: {
	cwd: string;
	slug: string;
	base: string;
	sourceRel: string;
	destRel: string;
	transformBody: (body: string) => string;
	commitMessage: string;
	refNamespace: string;
	env: NodeJS.ProcessEnv | undefined;
}): {ref: string; commit: string} {
	const {
		cwd,
		slug,
		base,
		sourceRel,
		destRel,
		transformBody,
		commitMessage,
		refNamespace,
		env,
	} = params;

	// The item's body on `main`, with the caller's body transform applied.
	const original = catBlob(`${base}:${sourceRel}`, cwd, env);
	const content = transformBody(original);
	// Hash the (possibly transformed) blob INTO the cwd's object store. A blob
	// write does not touch the working tree.
	const blob = hashObject(content, cwd, env);

	// A scratch index so read-tree/update-index never disturb the caller's index.
	const scratchIndex = join(
		tmpdir(),
		`dorfl-${refNamespace}-${process.pid}-${Date.now()}.index`,
	);
	const withIndex: NodeJS.ProcessEnv = {
		...(env ?? process.env),
		GIT_INDEX_FILE: scratchIndex,
	};
	try {
		gitHard(['read-tree', base], cwd, withIndex);
		// Remove the item from its source folder, add it under the dest folder. When
		// source === dest (an idempotent re-surface), force-remove + re-add the same
		// path is a no-op move that still carries any body change. One file changes.
		gitHard(['update-index', '--force-remove', sourceRel], cwd, withIndex);
		gitHard(
			['update-index', '--add', '--cacheinfo', `100644,${blob},${destRel}`],
			cwd,
			withIndex,
		);
		const tree = runHard(['write-tree'], cwd, withIndex).stdout.trim();
		// commit-tree threads the caller's ambient identity (env) — tree-less only
		// changed the WHERE-it-writes (the arbiter ref, not the cwd tree), not the WHO.
		const commit = runHard(
			['commit-tree', tree, '-p', base, '-m', commitMessage],
			cwd,
			env,
		).stdout.trim();
		// A throwaway local ref the seam's push uses as its source (`<ref>:main`).
		const ref = `refs/dorfl/${refNamespace}/${slug}`;
		gitHard(['update-ref', ref, commit], cwd, env);
		return {ref, commit};
	} finally {
		rmSync(scratchIndex, {force: true});
	}
}

/**
 * Build the ENGINE-AUTHORED envelope entry for a bounce — the one entry every
 * bounce always surfaces, so a reason-only bounce still leaves exactly one
 * human-answerable question.
 *
 * Callers may OVERRIDE it (e.g. the empty-diff path swaps in a dispose-defaulted
 * question); the override still defaults `kind` to `stuck` and `context` to the
 * bounce reason when it leaves them unset (so a caller can restate the reason in
 * the envelope prose without duplicating it in `context`).
 *
 * Extracted from {@link prepareTreelessSurfaceCommit} so the idempotence probe
 * ({@link bounceAlreadySurfaced}) compares against the EXACT entry the surface
 * would write. If the two ever derived the envelope independently they could
 * drift, and the de-duplication would silently stop de-duplicating — which is
 * the whole defect it exists to prevent.
 */
function buildBounceEnvelope(params: {
	item: string;
	reason: string;
	envelope?: NewQuestion;
}): NewQuestion {
	const {item, reason, envelope: override} = params;
	if (override) {
		return {
			kind: override.kind ?? 'stuck',
			question: override.question,
			context: override.context ?? reason,
			...(override.default !== undefined ? {default: override.default} : {}),
		};
	}
	return {
		question: `'${item}' was bounced — how should we proceed?`,
		context: reason,
		kind: 'stuck',
	};
}

/**
 * Is this EXACT bounce already surfaced (and still awaiting a human) on `base`?
 *
 * The surface-level half of the idempotence fix (observation
 * `checkpoint-path-reports-its-own-write-as-absent`): the generic empty-tree
 * short-circuit in {@link runTreelessLedgerMove} cannot catch a re-surface,
 * because {@link appendQuestions} always mints a NEW entry id — so re-running a
 * surface that already landed produced a genuinely different tree, and therefore
 * an additional commit. Five retries ⇒ five commits, i.e. the commit count scaled
 * with the retry budget rather than with anything real.
 *
 * "Already surfaced" is defined narrowly and precisely: the item body already
 * carries `needsAnswers: true` AND **every** entry this surface would append (the
 * engine envelope plus any agent-surfaced questions) is ALREADY present as an
 * UNANSWERED entry with the same `question` + `context`. Each clause matters:
 *
 *   - Requiring `needsAnswers: true` keeps the `needsAnswers ⟺ sidecar` invariant
 *     intact: if the flag is somehow missing, we still write (and repair it).
 *   - Requiring EVERY addition to be present means a bounce carrying NEW
 *     agent-surfaced questions is never swallowed just because its envelope
 *     matches. Partial overlap writes; only a TOTAL match is a no-op.
 *   - Requiring the matching entries to be UNANSWERED keeps this a
 *     de-duplication rather than a swallow. A human who ANSWERED this exact
 *     question and let the work resume MUST be told again when the same failure
 *     recurs — that is a NEW bounce, and it surfaces normally. Only identical,
 *     still-pending questions are suppressed, and a duplicate of a question
 *     nobody has answered yet adds noise, never information.
 */
function bounceAlreadySurfaced(params: {
	base: string;
	itemPath: string;
	sidecarPath: string;
	/** Every entry the surface would append (envelope first, then agent questions). */
	additions: readonly NewQuestion[];
	cwd: string;
	env: NodeJS.ProcessEnv | undefined;
}): boolean {
	const {base, itemPath, sidecarPath, additions, cwd, env} = params;
	if (!pathInCommit(base, sidecarPath, cwd, env)) {
		return false;
	}
	try {
		const body = catBlob(`${base}:${itemPath}`, cwd, env);
		if (parseFrontmatter(body).needsAnswers !== true) {
			return false;
		}
		const model = parseSidecar(catBlob(`${base}:${sidecarPath}`, cwd, env));
		const pending = model.entries.filter((entry) => !isEntryAnswered(entry));
		return additions.every((addition) =>
			pending.some(
				(entry) =>
					entry.question === addition.question &&
					entry.context === (addition.context ?? ''),
			),
		);
	} catch {
		// Unreadable body/sidecar ⇒ do NOT claim it is already surfaced; fall through
		// and let the normal surface path run (the safe direction: record the bounce).
		return false;
	}
}

/** The heading that opens an appended requeue handoff note in the item body. */
const REQUEUE_HEADING_PREFIX = '## Requeue';

// --- Tree-less SURFACE primitive (PR-1, spec
// `surface-stuck-as-questions-and-retire-stuck-lock-state`, task
// `bounce-surfaces-stuck-sidecar-and-releases-lock`) --------------------

/**
 * PR-1 ADDITIVE primitive (task `bounce-surfaces-stuck-sidecar-and-releases-lock`).
 * The 2-file SIBLING of {@link prepareTreelessMoveCommit}: pure git plumbing
 * (`hash-object` / scratch-index `update-index` / `write-tree` /
 * `commit-tree`, NEVER touches the caller's index/HEAD/working tree) that in
 * ONE commit off {@link base} both
 *
 *   1. writes or appends to the item's `work/questions/<type>-<slug>.md`
 *      sidecar (see {@link sidecarPathFor}) a `stuck`-kind entry carrying the
 *      bounce {@link reason} plus any agent-surfaced {@link questions}, and
 *   2. sets `needsAnswers: true` on the item body at {@link itemPath} (via
 *      {@link setNeedsAnswersMarker}).
 *
 * The current sidecar (if any) and the current item body are read as BLOBS off
 * `<arbiter>/main` (via {@link catBlob}) — no working tree required and no
 * dependency on the cwd's `HEAD` matching `main`. That is what makes this the
 * tree-less path's surface primitive: a `applyTreelessNeedsAttentionTransition`
 * caller (`continue-push-failure` / rebase-conflict) has NO writable-`main`
 * checkout, so `persistSurfacedQuestions` (working-tree bound) cannot be reused;
 * the pure CONTENT builders (`newSidecar` / `appendQuestions` /
 * `serialiseSidecar` / `setNeedsAnswersMarker`) ARE reused, only the commit
 * mechanism differs (spec decision #7).
 *
 * Returns the throwaway ref + commit sha, exactly like {@link
 * prepareTreelessMoveCommit}, so the SAME {@link runTreelessLedgerMove} CAS loop
 * publishes the surface commit through the shared write seam. The
 * surface-first / release-second ordering + `main`-authoritative crash-safety
 * (spec decision #4) come FREE from routing through that loop — the caller wires
 * the release into a `finally` AFTER a successful publish (see the harness
 * {@link surfaceStuckToNeedsAttention}).
 *
 * DECISION — sidecar entry shape for a reason-only bounce (build-time, PR-1):
 * every bounce always appends ONE engine-authored `stuck`-kind envelope entry
 * whose `question` names the item and whose `context` is the {@link reason}
 * prose, THEN any {@link questions} the agent surfaced. So a reason-only bounce
 * (no agent questions) still surfaces exactly ONE entry a human can answer, and
 * the agent's own questions (when present) are appended AFTER it, verbatim. The
 * envelope entry is what turns a raw exit reason into a human-drainable
 * question; the extra entries are the LLM prose the spec's decision #2 keeps
 * untouched. Alternative considered — treating an empty `questions` array as a
 * NO-OP surface — REJECTED because that is the spec's `stuck` retirement
 * problem all over again (a bounced item with no on-`main` outcome).
 * Alternative considered — dropping the envelope when agent questions are given
 * — REJECTED because the reason is engine-authored ground truth; the agent's
 * questions are advisory prose ABOVE it, not a replacement for it.
 *
 * PR-1 boundary: this primitive is EXERCISED BY TESTS ONLY; it is NOT yet
 * called from any bounce seam. Wiring `applyNeedsAttentionTransition` /
 * `applyTreelessNeedsAttentionTransition` to it — and migrating the existing
 * `stuckLockOnArbiter(...).toBe(true)` assertions — is the follow-up PR-2 task
 * `bounce-atomic-cutover-retire-stuck-lock`.
 */
export function prepareTreelessSurfaceCommit(params: {
	/** The origin cwd whose object store the plumbing writes into (never a target). */
	cwd: string;
	/** The slug (used only to name the throwaway ref). */
	slug: string;
	/** The namespaced item identity (e.g. `task:foo`); drives the sidecar path. */
	item: string;
	/** The item body's on-`main` path (e.g. `work/tasks/ready/foo.md`). */
	itemPath: string;
	/** The base commit (`<arbiter>/main`) the surface commit parents on. */
	base: string;
	/** The bounce reason (envelope entry's context). */
	reason: string;
	/** Any agent-surfaced questions to append after the envelope. */
	questions?: NewQuestion[];
	/**
	 * OPTIONAL engine-authored envelope entry OVERRIDE. When provided, replaces
	 * the built-in generic `"<item> was bounced — how should we proceed?"`
	 * envelope with a caller-supplied one — the seam the empty-diff bounce path
	 * uses to guarantee a DISPOSE-DEFAULTED disposition question exists on the
	 * surfaced sidecar (spec `surface-stuck-as-questions-and-retire-stuck-lock-state`
	 * resolved decision #2, task
	 * `empty-diff-bounce-surfaces-dispose-defaulted-question`). The override still
	 * defaults its `kind` to `'stuck'` when unset. `reason` (envelope context)
	 * remains the caller-owned prose; the override lets the caller set the
	 * envelope's `question` + `default` so the human sees a one-glance
	 * dispose/cancel prompt instead of the generic "how should we proceed?"
	 * catch-all. When absent, the built-in envelope is used (the reason-only
	 * bounce shape).
	 */
	envelope?: NewQuestion;
	/** The commit subject for the surface commit. */
	commitMessage: string;
	/** The throwaway ref namespace (`refs/dorfl/<refNamespace>/<slug>`). */
	refNamespace: string;
	env: NodeJS.ProcessEnv | undefined;
}): {ref: string; commit: string} {
	const {
		cwd,
		slug,
		item,
		itemPath,
		base,
		reason,
		questions,
		envelope: envelopeOverride,
		commitMessage,
		refNamespace,
		env,
	} = params;

	const sidecarPath = sidecarPathFor(item);

	// Read the item body off `main` as a BLOB — never off the cwd working tree,
	// which the tree-less caller does not have on `main`. `catBlob` throws when
	// the path is not tracked, which is the honest signal: the tree-less bounce
	// only fires against an item whose body already rests on `main` (the caller's
	// plan should short-circuit `missing` beforehand).
	const itemBody = catBlob(`${base}:${itemPath}`, cwd, env);
	const flagged = setNeedsAnswersMarker(itemBody, true);

	// Defense-in-depth (the `sidecar-without-needsAnswers` guard, mirrored from
	// `persistSurfacedQuestions`): if the marker did not actually parse back as
	// `true`, refuse to write the sidecar rather than tear the
	// `needsAnswers ⟺ sidecar` invariant.
	if (parseFrontmatter(flagged).needsAnswers !== true) {
		throw new Error(
			`prepareTreelessSurfaceCommit: could not set needsAnswers:true on '${itemPath}' ` +
				`for '${item}' — refusing to surface without the flag.`,
		);
	}

	// Compose the entries: an engine-authored envelope carrying the reason, then
	// any agent-surfaced questions (stamped `stuck`-kind if the caller left the
	// kind unset — this IS the stuck-surface path).
	const envelope = buildBounceEnvelope({
		item,
		reason,
		envelope: envelopeOverride,
	});
	const surfaced: NewQuestion[] = (questions ?? []).map((q) => ({
		...q,
		kind: q.kind ?? 'stuck',
	}));
	const additions: NewQuestion[] = [envelope, ...surfaced];

	// APPEND to an existing sidecar on `main` (never overwrite) or CREATE it
	// first-pass — the same append-never-overwrite rule the working-tree surface
	// path enforces. Read the current sidecar off `main` as a BLOB.
	const sidecarExists = pathInCommit(base, sidecarPath, cwd, env);
	const model = sidecarExists
		? appendQuestions(
				parseSidecar(catBlob(`${base}:${sidecarPath}`, cwd, env)),
				additions,
			)
		: newSidecar(item, additions);
	const sidecarContent = serialiseSidecar(model);

	// Hash both blobs INTO the cwd's object store (no working tree write).
	const itemBlob = hashObject(flagged, cwd, env);
	const sidecarBlob = hashObject(sidecarContent, cwd, env);

	// A scratch index so `read-tree` / `update-index` never touch the caller's
	// index. `--add --cacheinfo` both ADDS a new entry and REPLACES an existing
	// one (so a re-surface that rewrites the sidecar path is a no-op replace).
	const scratchIndex = join(
		tmpdir(),
		`dorfl-${refNamespace}-${process.pid}-${Date.now()}.index`,
	);
	const withIndex: NodeJS.ProcessEnv = {
		...(env ?? process.env),
		GIT_INDEX_FILE: scratchIndex,
	};
	try {
		gitHard(['read-tree', base], cwd, withIndex);
		gitHard(
			[
				'update-index',
				'--add',
				'--cacheinfo',
				`100644,${itemBlob},${itemPath}`,
			],
			cwd,
			withIndex,
		);
		gitHard(
			[
				'update-index',
				'--add',
				'--cacheinfo',
				`100644,${sidecarBlob},${sidecarPath}`,
			],
			cwd,
			withIndex,
		);
		const tree = runHard(['write-tree'], cwd, withIndex).stdout.trim();
		const commit = runHard(
			['commit-tree', tree, '-p', base, '-m', commitMessage],
			cwd,
			env,
		).stdout.trim();
		const ref = `refs/dorfl/${refNamespace}/${slug}`;
		gitHard(['update-ref', ref, commit], cwd, env);
		return {ref, commit};
	} finally {
		rmSync(scratchIndex, {force: true});
	}
}

export interface SurfaceStuckToNeedsAttentionOptions {
	/**
	 * The working clone the move is ORIGINATED from — purely the ORIGIN SOURCE
	 * (it resolves the arbiter remote + holds the object store the plumbing
	 * writes into), NEVER a write TARGET. Tree-less: the cwd index/HEAD/working
	 * tree are never touched.
	 */
	cwd: string;
	/** The slug of the item to surface as a stuck question. */
	slug: string;
	/**
	 * The item body's on-`main` path (e.g. `work/tasks/ready/foo.md`). Provided
	 * by the caller (parity with `persistSurfacedQuestions`). PR-2a made this
	 * OPTIONAL: when absent the harness invokes {@link resolveBounceItemBodyPathOnMain}
	 * to PROBE `<arbiter>/main` in the D1 order for the item's namespace
	 * (task/spec/observation). A body-absent probe (item body never landed on
	 * `main` — e.g. a claim that lost/raced) is a CLEAN NO-OP surface that STILL
	 * RELEASES the lock: never throw, never leave a held lock, never drop the
	 * bounce silently to a dead end.
	 */
	itemPath?: string;
	/** The namespaced item identity. Defaults to `task:${slug}`. */
	item?: string;
	/** Why the item is stuck (bounce reason — envelope entry's context). */
	reason: string;
	/** Any questions the agent surfaced (appended after the envelope). */
	questions?: NewQuestion[];
	/**
	 * OPTIONAL engine-authored envelope override, forwarded to
	 * {@link prepareTreelessSurfaceCommit}. The empty-diff bounce path uses this
	 * to guarantee the first surfaced entry is a DISPOSE-DEFAULTED disposition
	 * question (task `empty-diff-bounce-surfaces-dispose-defaulted-question`,
	 * spec resolved decision #2). Absent ⇒ the built-in generic
	 * "how should we proceed?" envelope (a reason-only bounce).
	 */
	envelope?: NewQuestion;
	/** The arbiter remote the surface commit is CAS-published to. REQUIRED. */
	arbiter: string;
	env?: NodeJS.ProcessEnv;
	note?: (message: string) => void;
}

export interface SurfaceStuckToNeedsAttentionResult {
	/** True iff the surface commit landed on `<arbiter>/main`. */
	surfaced: boolean;
	/** True iff the per-item lock ref was released. On a body-absent probe
	 * (see {@link bodyAbsent}) the lock is STILL released — the bounce cannot
	 * silently strand a held lock over an item with no `main` body. */
	released: boolean;
	/** When NOT surfaced, why (missing item, contention exhausted, body-absent probe). */
	reasonNotSurfaced?: string;
	/** True iff the D1 probe found no body on `<arbiter>/main` for this item
	 * (task: `tasks/ready` then `tasks/backlog`; spec: `specs/ready` then
	 * `specs/proposed`; observation: `notes/observations`). In this case
	 * {@link surfaced} is false but {@link released} is true — the lock is
	 * always released to prevent a dead-end held lock. */
	bodyAbsent?: boolean;
}

/**
 * The PR-1 thin HARNESS around {@link prepareTreelessSurfaceCommit}: run it
 * through the EXISTING {@link runTreelessLedgerMove} CAS loop, then release the
 * per-item lock. Ordering is LOAD-BEARING and INHERITED from that harness —
 * the surface commit lands on `<arbiter>/main` FIRST, and the lock release only
 * fires on a successful publish. `main` is authoritative on crash recovery
 * (spec decision #4).
 *
 * PR-1 boundary: this is EXERCISED BY TESTS ONLY. Wiring the seams to call it
 * is the PR-2 task `bounce-atomic-cutover-retire-stuck-lock`.
 */
export async function surfaceStuckToNeedsAttention(
	options: SurfaceStuckToNeedsAttentionOptions,
): Promise<SurfaceStuckToNeedsAttentionResult> {
	const note = options.note ?? (() => {});
	// Merge of #364 (envelope) + PR-2a (itemPath is re-declared as `let` below for
	// the D1 probe fallback, so it must NOT be in this const destructure).
	const {cwd, slug, reason, questions, envelope, arbiter, env} = options;
	const item = options.item ?? `task:${slug}`;

	// PR-2a D1 body-path probe: when the caller does not name an on-`main`
	// body path, PROBE `<arbiter>/main` in a fixed order per namespace
	// (task/spec/observation). A body-absent probe is a CLEAN NO-OP surface
	// that STILL releases the lock — never leave a bounce as a dead-end held
	// lock.
	let itemPath = options.itemPath;
	if (itemPath === undefined) {
		const probed = await resolveBounceItemBodyPathOnMain({
			cwd,
			item,
			arbiter,
			env,
		});
		if (probed === undefined) {
			// Body-absent: skip the surface commit entirely and STILL release the
			// lock (idempotent). Signal the distinction on the result so a caller
			// can tell a body-absent no-op apart from a `missing` plan on a
			// caller-provided itemPath.
			const rel = await releaseItemLock({item, cwd, arbiter, env});
			const released = rel.outcome === 'released' || rel.outcome === 'not-held';
			return {
				surfaced: false,
				released,
				bodyAbsent: true,
				reasonNotSurfaced:
					`no body for '${item}' on ${arbiter}/main (probed the D1 ` +
					'candidates in order) — surface skipped as a clean no-op; the ' +
					'lock was still released to avoid a dead-end held lock.',
			};
		}
		itemPath = probed;
	}

	const resolvedItemPath = itemPath;
	const surfaced = await runTreelessLedgerMove({
		cwd,
		slug,
		arbiter,
		kind: 'needs-attention',
		onContended: 'surface',
		explicitMainRefspec: true,
		env,
		note,
		plan: (base) => {
			if (!pathInCommit(base, resolvedItemPath, cwd, env)) {
				return 'missing';
			}
			// IDEMPOTENCE: this exact bounce may ALREADY be surfaced on this base —
			// either a genuine re-bounce for an identical, still-pending reason, or a
			// retry of an attempt that landed but was mis-read as rejected. Either way
			// there is nothing to add, so land no commit (see
			// {@link bounceAlreadySurfaced}).
			if (
				bounceAlreadySurfaced({
					base,
					itemPath: resolvedItemPath,
					sidecarPath: sidecarPathFor(item),
					additions: [
						buildBounceEnvelope({item, reason, envelope}),
						...(questions ?? []),
					],
					cwd,
					env,
				})
			) {
				return 'already-done';
			}
			return prepareTreelessSurfaceCommit({
				cwd,
				slug,
				item,
				itemPath: resolvedItemPath,
				base,
				reason,
				questions,
				envelope,
				commitMessage: `surface ${item} (stuck): ${reason}`,
				refNamespace: 'surface-stuck',
				env,
			});
		},
	});

	if (!surfaced) {
		return {
			surfaced: false,
			released: false,
			reasonNotSurfaced:
				`surface for '${item}' did not land on ${arbiter}/main ` +
				'(item missing on main, or contention exhausted after retries).',
		};
	}

	// Surface-first / release-second: only reach here on a successful publish.
	const rel = await releaseItemLock({item, cwd, arbiter, env});
	const released = rel.outcome === 'released' || rel.outcome === 'not-held';
	return {surfaced: true, released};
}

/**
 * The D1 body-path probe (PR-2a task `bounce-atomic-cutover-retire-stuck-lock`,
 * spec `surface-stuck-as-questions-and-retire-stuck-lock-state`, decision D1):
 * resolve the item's on-`main` body path by probing `<arbiter>/main` in a
 * FIXED order per namespace:
 *   - task: `work/tasks/ready/<slug>.md` then `work/tasks/backlog/<slug>.md`.
 *   - spec: `work/specs/ready/<slug>.md` then `work/specs/proposed/<slug>.md`.
 *   - observation: `work/notes/observations/<slug>.md`.
 *
 * Returns the first candidate that EXISTS on `<arbiter>/main`, or `undefined`
 * when no candidate exists (a bounce for an item whose body never landed on
 * `main`). The caller MUST handle `undefined` by STILL releasing the lock —
 * never leave a held lock over a body-absent item.
 *
 * The probe fetches `<arbiter>/main` with an EXPLICIT refspec (the
 * `runTreelessLedgerMove` pattern) so a job-worktree with a narrower default
 * fetch refspec still resolves `<arbiter>/main` reliably.
 */
export async function resolveBounceItemBodyPathOnMain(params: {
	cwd: string;
	item: string;
	arbiter: string;
	env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
	const {cwd, item, arbiter, env} = params;
	const {type, slug} = resolveSidecarIdentity(item);
	await gitSoftAsync(
		[
			'fetch',
			'--quiet',
			arbiter,
			`+refs/heads/main:refs/remotes/${arbiter}/main`,
		],
		cwd,
		env,
	);
	const base = `${arbiter}/main`;
	const folders = BOUNCE_BODY_PROBE_ORDER[type];
	for (const folder of folders) {
		const rel = workItemRel(folder, `${slug}.md`);
		if (pathInCommit(base, rel, cwd, env)) {
			return rel;
		}
	}
	return undefined;
}

/** The FIXED per-namespace probe order for {@link resolveBounceItemBodyPathOnMain}
 * (D1): the FIRST candidate that exists on `<arbiter>/main` is the item's body
 * path. The ordering encodes the working assumption that a claimed/in-flight
 * item is in `ready/` and a not-yet-promoted item is in `backlog/`
 * (spec-tasked/proposed for a spec); an observation has one location.
 * Callers with an explicit `itemPath` bypass this probe entirely. */
const BOUNCE_BODY_PROBE_ORDER: Record<SidecarType, readonly WorkFolderKey[]> = {
	task: ['tasks-ready', 'tasks-backlog'],
	spec: ['specs-ready', 'specs-proposed'],
	observation: ['observations'],
};

/**
 * Append a dated `## Requeue YYYY-MM-DD` handoff section to an item body's TEXT
 * (append-only — never overwrites; repeated requeues accumulate a handoff log).
 * Body prose only (never a frontmatter field — WORK-CONTRACT rule 3). The date is
 * UTC `YYYY-MM-DD`; multiple notes on the same day are distinct appended blocks.
 *
 * A PURE string transform (it operates on the body CONTENT, not a file path) so
 * the tree-less requeue can apply it to the blob read from `<arbiter>/main`
 * without touching the cwd working tree.
 */
function appendRequeueNoteText(content: string, message: string): string {
	const date = new Date().toISOString().slice(0, 10);
	const base = content.replace(/\s*$/, '');
	return [base, '', `${REQUEUE_HEADING_PREFIX} ${date}`, '', message, ''].join(
		'\n',
	);
}

/**
 * Extract the prose written under the `## Needs attention` heading from an item
 * body. Returns the first non-empty line(s) of the block as a single line
 * (stops at the next `## ` heading); '' when no block is present. The
 * needs-attention REASON is now recorded on the per-item lock entry (task
 * `cutover-needs-attention-becomes-lock-stuck-recovery-surface`, decision i+),
 * NOT in the body, but this extractor stays for any historical body text that
 * still carries the heading (a tolerant best-effort read).
 */
export function extractReason(content: string): string {
	const normalized = content.replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');
	const start = lines.findIndex((l) => l.trim() === REASON_HEADING);
	if (start === -1) {
		return '';
	}
	const collected: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^##\s/.test(line)) {
			break;
		}
		if (/^###\s/.test(line)) {
			// The questions sub-section starts here; the reason itself is above it.
			break;
		}
		if (line.trim() === '') {
			if (collected.length > 0) {
				// Stop at the first blank line AFTER we captured the reason text.
				break;
			}
			continue;
		}
		collected.push(line.trim());
	}
	return collected.join(' ').trim();
}

/** Run git; throw on non-zero (genuinely unexpected plumbing failures). */
function gitHard(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): void {
	runHard(args, cwd, env);
}

/** Like {@link gitHard} but returns the raw result (for plumbing that emits stdout). */
function runHard(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): RunResult {
	const result = run('git', args, cwd, {env});
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr.trim()}`,
		);
	}
	return result;
}

/** Async soft git (no throw) — for the tree-less requeue's remote checks. */
function gitSoftAsync(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<RunResult> {
	return runAsync('git', args, cwd, {env});
}

/** Async git; throw on non-zero (unexpected plumbing failures). */
async function gitHardAsync(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<RunResult> {
	const result = await runAsync('git', args, cwd, {env});
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr.trim()}`,
		);
	}
	return result;
}

/** Read an object's content (`git cat-file -p <object>`) from the cwd's store. */
function catBlob(
	object: string,
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): string {
	return runHard(['cat-file', '-p', object], cwd, env).stdout;
}

/** Write a blob into the cwd's object store (`git hash-object -w`), return its sha. */
function hashObject(
	content: string,
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): string {
	const result = run('git', ['hash-object', '-w', '--stdin'], cwd, {
		env,
		input: content,
	});
	if (result.status !== 0) {
		throw new Error(
			`git hash-object failed (exit ${result.status}): ${result.stderr.trim()}`,
		);
	}
	return result.stdout.trim();
}

/**
 * Run git, returning the raw result (no throw) — for soft checks like the
 * `--reset` remote-branch delete, whose non-zero exit is a meaningful outcome
 * (the requeue aborts) rather than an unexpected plumbing failure.
 */
function gitSoftRun(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): {status: number; stdout: string; stderr: string} {
	return run('git', args, cwd, {env});
}

/** True when the index has no staged changes against HEAD (nothing to commit). */
function nothingStaged(
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): boolean {
	// `diff --cached --quiet` exits 0 when NOTHING is staged, 1 when there is.
	return run('git', ['diff', '--cached', '--quiet'], cwd, {env}).status === 0;
}

/** The current HEAD commit sha (the just-made commit's tip). */
function revParseHead(cwd: string, env: NodeJS.ProcessEnv | undefined): string {
	const result = run('git', ['rev-parse', 'HEAD'], cwd, {env});
	if (result.status !== 0) {
		throw new Error(
			`git rev-parse HEAD failed (exit ${result.status}): ${result.stderr.trim()}`,
		);
	}
	return result.stdout.trim();
}
