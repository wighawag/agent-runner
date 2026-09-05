import {existsSync, readdirSync, type Dirent} from 'node:fs';
import {basename, join} from 'node:path';
import {workItemPath, WORK_ROOT} from './work-layout.js';
import type {VerifyConfig} from './verify.js';
import type {ReviewGate} from './review-gate.js';
import {
	performIntegration,
	IntegrationNothingStaged,
	synthesiseProposeTitle,
	composeProposeBody,
	PR_TITLE_MAX,
} from './integration-core.js';
import {ledgerWrite} from './ledger-write.js';
import {releaseItemLock} from './item-lock.js';
import {workBranchRef, parseWorkBranchRef} from './slug-namespace.js';
import {isProvablyMergedForReap} from './gc.js';
import type {SidecarType} from './sidecar.js';
import type {ReviewProvider} from './integrator.js';
import type {IntegrationMode} from './config.js';
import {runAsync, localMainAheadCount, type RunResult} from './git.js';
import {hasUncommittedSourceChanges} from './agent-stop.js';
import {formatProposeNextStep, shouldUseColor} from './output.js';
import {
	checkGatePreconditions,
	detectLockfileOnDisk,
} from './gate-readiness.js';

// Re-export the propose-mode title/body helpers from their new home (the shared
// integration core) so existing importers (`test/propose-pr-body.test.ts`) keep
// working unchanged after the gate→integrate band moved out of this file.
export {synthesiseProposeTitle, composeProposeBody, PR_TITLE_MAX};

/**
 * `dorfl complete [<slug>] [--skip-verify] [--type <t>] [--message <s>]
 * [--arbiter <remote>]` — the human "finish this" command that runs the same
 * back-half the autonomous runner runs: gate → mark done → commit → integrate.
 *
 * It runs on a `work/<slug>` branch (slug inferred from the branch if omitted).
 * The build agent leaves its work UNCOMMITTED (it does no git), so `complete`
 * `git add -A`s the agent's work AND the done-move into ONE atomic commit. This
 * is the same finish/integration logic `run-once`/`watch` reuse; here it is
 * human-driven and so allows a `--skip-verify` escape hatch the autonomous
 * runner never uses (ADR §8).
 *
 * The item's SOURCE folder is normally `work/tasks/ready/` (the pool — claim
 * leaves the body there, task
 * `cutover-claim-body-stays-and-complete-sources-from-backlog`). A RUNNER-OWNED
 * RECOVERY of a SPURIOUSLY-stuck item (env-polluted gate, transient flake,
 * since-fixed cause) sources from the SAME pool location: the per-item-lock
 * cutover (`cutover-needs-attention-becomes-lock-stuck-recovery-surface`)
 * retired the `work/needs-attention/` folder — stuck is the lock `state: stuck`
 * and the body stays in `tasks/ready/` while claimed, so a recovery `complete`
 * is structurally a normal build. The gate is RE-RUN and authoritative (only a
 * GREEN re-gate completes; a still-red item stays stuck on the lock).
 * `--skip-verify` stays the only, human-only, loud override.
 *
 * The integration step is split by mode (config `integration`, ADR §6):
 *   merge   — push the rebased branch to `<arbiter>/main`, then sync the LOCAL
 *             clone to that new main (the push is authoritative; the local sync
 *             is the ergonomic finish so the user ends on an up-to-date main).
 *   propose — push the `work/<slug>` branch (the safety-bearing step) and report
 *             the next step. Full provider-driven PR/MR creation lands with the
 *             integration seam; until then `complete` pushes + tells the human.
 *
 * In BOTH modes `complete` lands the human back on local `main` by default
 * ("finish, ready for the next thing") — but the move differs because the work's
 * location differs: `merge` switches to `main` AND fast-forwards it to the just-
 * pushed `<arbiter>/main` (the work landed there); `propose` ONLY `git switch
 * main` (arbiter main has not moved, so there is nothing to ff). `--no-switch`
 * opts out in either mode (stay on `work/<slug>` to keep iterating).
 *
 * After landing on `main`, the LOCAL `work/<slug>` branch is deleted iff its work
 * is provably on the arbiter (the SAME predicate as worktree deletion, ADR §4,
 * mode-agnostic): its tip is an ancestor of `<arbiter>/main` (merged) OR
 * `<arbiter>/work/<slug>` exists with its tip == the local tip (pushed & up-to-
 * date). Otherwise the branch is KEPT (unmerged / unpushed / a diverged un-pushed
 * amend = not safe). The REMOTE branch is NEVER deleted (a propose PR is built
 * from it). `--no-switch` keeps the branch too.
 *
 * Before integrating, the work branch is rebased onto the latest `<arbiter>/main`
 * (ADR §10): a clean rebase continues; a conflicting rebase is `--abort`ed and
 * surfaced as needs-attention — `complete` NEVER auto-resolves. It NEVER
 * `--force`es to main.
 *
 * Exit codes:
 *   0  completed (done-move + commit + integrate succeeded)
 *   1  usage/environment error, or a refusal (gate failed, nothing to commit,
 *      not on a work branch, rebase conflict needs the human)
 *
 * On the two FAILURE paths the human can't paper over — a red gate (without
 * `--skip-verify`) and a rebase conflict (ADR §10) — `complete` no longer leaves
 * the item dangling. Instead it routes the item through the shared
 * `needs-attention` mechanism (ADR §12): record the reason on the per-item lock
 * entry (`state: stuck`, post-cutover task
 * `cutover-needs-attention-becomes-lock-stuck-recovery-surface`) so the stuck
 * item is surfaced by `status` and returnable to `backlog/`. The success and
 * `--skip-verify` paths are unchanged. The exit code stays 1 (the work did NOT
 * complete); the outcome still names WHY (gate-failed / rebase-conflict) and
 * `routedToNeedsAttention` records that the lock amend happened.
 */

export type CompleteOutcome =
	| 'completed' // gated, moved, committed, integrated
	| 'already-integrated' // stranded-done auto-recover: tip already on <arbiter>/main → clean no-op (no re-push, no double-integrate)
	| 'prepare-failed' // the env-prep step (prepare) was red — env not ready, verify not run
	| 'gate-failed' // the acceptance gate was red (and not skipped)
	| 'review-blocked' // Gate 2 (PR/code review) returned `block` (or exhausted rounds)
	| 'review-unparseable' // Gate 2 ran but its verdict JSON was malformed/unparseable — work-preserving route, classified `transient-infra` (NOT a reviewer block)
	| 'rebase-conflict' // rebase onto arbiter/main conflicted (aborted; human resolves)
	| 'sidecar-violation' // a co-located <slug>/ sidecar sits beside a flowing task/spec item (WORK-CONTRACT rule 8) — routed to needs-attention before the durable move
	| 'invariant-violation' // one-slug-one-folder would break (slug in two folders on the arbiter)
	| 'strand-surfaced' // autonomous source-strand refusal (or empty-staged) surfaced to needs-attention on the arbiter (parity with run's never-strand-in-in-progress posture)
	| 'surface-unmoved' // autonomous source-strand surface tried but did NOT land on the arbiter — the item is HONESTLY still in-progress (CAS contention / no arbiter); never a fake success
	| 'refused' // nothing to complete (nothing to commit, wrong folder, …)
	| 'usage-error'; // usage / environment problem

export interface CompleteOptions {
	/** The slug to complete. If omitted, inferred from a `work/<slug>` branch. */
	slug?: string;
	/** The working clone/checkout the work branch lives in. */
	cwd: string;
	/** Name of the arbiter git remote. Defaults to `origin`. */
	arbiter?: string;
	/** Integration mode: `propose` (default) or `merge`. */
	integration?: IntegrationMode;
	/**
	 * **The explicit `--merge` override** for the untrusted-origin build-propose rule
	 * (task `untrusted-origin-forces-build-propose`). `true` iff the operator
	 * EXPLICITLY typed `--merge` on this invocation (vs `merge` resolved from
	 * config). Forwarded to {@link performIntegration}'s `explicitMerge`: an explicit
	 * `--merge` OVERRIDES the untrusted-origin build-propose rule (the operator is
	 * present; CLI always wins). Unset on the autonomous path ⇒ an untrusted-origin
	 * task reliably forces `propose`.
	 */
	explicitMerge?: boolean;
	/**
	 * Override the pre-flight DIVERGENCE guard (`--ignore-diverged-main`, mirroring
	 * `--ignore-not-ready`): proceed even when local `main` is ahead of
	 * `<arbiter>/main` (has unpushed commits). MERGE MODE ONLY (only merge mode ff's
	 * local `main`). When overridden and the divergence persists, the now-NON-FATAL
	 * {@link syncLocalMain} reports it honestly (work on the arbiter; local `main`
	 * left to rebase). Loud, never the default.
	 */
	ignoreDivergedMain?: boolean;
	/**
	 * Leave the human ON the `work/<slug>` branch (and KEEP it) in either mode,
	 * instead of switching back to `main` + deleting the provably-landed branch.
	 * For "I'll keep iterating on this branch" (e.g. addressing review feedback).
	 */
	noSwitch?: boolean;
	/** The declared per-repo ENV-PREP step (string | list), run ONCE before the
	 * first `verify` to make the env ready. Unset ⇒ a no-op (NO default install). */
	prepare?: VerifyConfig;
	/** The declared per-repo gate (string | list). Unset ⇒ the default command. */
	verify?: VerifyConfig;
	/**
	 * Run the acceptance gate (`prepare` then `verify`) against the REBASED tip
	 * in a CLEAN throwaway worktree (the tree that integrates) when `true` (the
	 * default), rather than the current checkout (the pre-rebase tree) when
	 * `false`. `complete` is a SINGLE-JOB path, so this is the resolved flag
	 * passed UNCONDITIONALLY (no `run`-fleet downgrade). Forwarded verbatim to
	 * {@link performIntegration}.
	 */
	freshWorktreeGate?: boolean;
	/**
	 * **The cross-job merge-serialiser CAS-retry cap** (config `mergeRetries`, spec
	 * `land-time-reverify-and-parallel-merge-ceiling` Story 5 / Applied Answer q1
	 * (a)). Threaded verbatim into {@link performIntegration} as `mergeRetries` so
	 * the resolved per-repo value controls how many re-rebase-and-retry attempts
	 * the merge-mode `${branch}:main` push makes before a contender bounces to
	 * needs-attention. Resolved ONCE per `performComplete` call — the same
	 * per-item resolution as `freshWorktreeGate` / `reviewMaxRounds`.
	 */
	mergeRetries?: number;
	/** Skip the acceptance gate (human-only escape hatch; never used unattended). */
	skipVerify?: boolean;
	/**
	 * **`--allow-backlog`** (spec
	 * `do-allow-backlog-drive-staged-tasks-without-promotion`): TREAT a
	 * `tasks/backlog/`-resident body (staging) as a VALID build source, so a
	 * staged task driven in place done-moves `tasks/backlog/ → tasks/done/`
	 * directly. GATED on the explicit flag: WITHOUT it, a body resting in
	 * `tasks/backlog/` is NOT a sanctioned completion position (a corrupt/wip
	 * strand) and `complete` still REFUSES honestly — only the deliberate drive
	 * promotes from staging. Default off ⇒ today's refusal-on-staging behaviour.
	 * Threaded only by the `do … --allow-backlog` task-build path; no autonomous
	 * caller sets it.
	 */
	allowBacklog?: boolean;
	/**
	 * **Gate 2 — the PR/code review gate** (GATES spec `work/specs/tasked/review.md`). When
	 * `true`, after the green `verify` and BEFORE the done-move, run the `review`
	 * SKILL as a FRESH-CONTEXT agent (its own harness launch) and route its verdict:
	 * `approve` → proceed to done-move/commit/integrate; `block` → route to
	 * needs-attention (NEVER merge). `verify` is the non-skippable floor; review is
	 * a JUDGEMENT gate ON TOP (ADR §8), never a replacement. Default OFF.
	 */
	review?: boolean;
	/**
	 * The model the REVIEW agent runs on (de-correlation from the builder). Flows
	 * to the review-agent launch through the EXISTING harness seam
	 * (`LaunchInput.model` / `substituteModel`). Unset ⇒ no forced review model.
	 */
	reviewModel?: string;
	/**
	 * Bound the revise↔review loop (Gate 2). On exhaustion the gate ERRORS OUT and
	 * forces needs-attention (never silently merges or loops). Defaults to 2.
	 */
	reviewMaxRounds?: number;
	/**
	 * The review-gate SEAM (injectable, like `do`'s `dorfl`): a fresh-context
	 * review that returns a parsed `{verdict, findings}`. Tests inject a canned
	 * verdict (no real model); production wires the harness-backed gate
	 * (`harnessReviewGate`). Required when `review` is on (a missing gate with
	 * `review` on is a usage error — the floor must not be silently skipped).
	 */
	reviewGate?: ReviewGate;
	/**
	 * `--watch`: tail the Gate-2 REVIEW agent's pi session `.jsonl` live, the SAME
	 * way `do --watch` tails the build agent's (task `watch-review-session`).
	 * Threaded into the `reviewGate` invocation below so the production gate
	 * (`harnessReviewGate`) routes its launch through the shared
	 * `launchWithOptionalWatch` helper. OFF (the default) ⇒ the review path is
	 * byte-for-byte unchanged (sync launch, no tailer). Observability only — it
	 * never changes the verdict/routing.
	 */
	watch?: boolean;
	/** Where the tailed review lines are written (defaults to stderr). */
	watchSink?: (line: string) => void;
	/**
	 * The HOST-ONLY sessions root the review session FILE is generated under
	 * (resolved `config.sessionsDir`). Threaded to the review-agent launch so its
	 * (distinct `<slug>-review`) session lands under the same root as the build's.
	 */
	sessionsDir?: string;
	/** Conventional-commit type for the completion commit. Defaults to `feat`. */
	type?: string;
	/** Commit summary. Defaults to the task `title` minus a leading `slug — `. */
	message?: string;
	/**
	 * Optional review-request BODY (propose mode) — the PR/MR DESCRIPTION, DISTINCT
	 * from {@link message} (which is the COMMIT summary). Advisory prose that gates
	 * nothing. The autonomous `do` path passes the build agent's final summary
	 * (`LaunchResult.output`); a human `complete --propose` may pass one via a NEW
	 * `--body` flag (NOT `--message`). The runner scaffolds a deterministic header
	 * (a pointer to `work/done/<slug>.md`) above it. Absent ⇒ today's `gh pr create
	 * --fill` empty/commit-derived body (no regression). Ignored in `merge` mode.
	 */
	body?: string;
	/** Optional injectable PR opener (e.g. `gh pr create`); used in `propose` mode. */
	openPr?: (opts: {
		cwd: string;
		branch: string;
		env?: NodeJS.ProcessEnv;
	}) => void;
	/**
	 * Optional FULLY-FORMED review provider INSTANCE used VERBATIM (the SAME seam
	 * `run` exposes via `RunOptions.provider`; forwarded to `performIntegration` as
	 * `providerInstance`). Tests/embeddings inject a stubbed `GitHubProvider` (a
	 * custom `gh` path) to drive the full propose pipeline OFFLINE without a real
	 * GitHub arbiter. This is the resolved provider OBJECT — NOT a config override
	 * (there is none; the provider is purely arbiter-derived). Unset ⇒ the core
	 * selects the provider from the arbiter URL as normal.
	 */
	providerInstance?: ReviewProvider;
	/**
	 * **The PR-INTENT axis** (config `noPR`, ADR §6). When `true` on the propose
	 * path, push the branch but SKIP the review request (the explicit suppress-PR
	 * intent, re-homing the old `provider: none` use). NOT a provider choice — the
	 * provider is purely arbiter-derived. Threaded verbatim into
	 * {@link performIntegration}. Ignored in `merge` mode and when `openPr` is
	 * injected. Unset/false ⇒ propose opens the PR via the arbiter-derived provider.
	 */
	noPR?: boolean;
	/**
	 * Surface a needs-attention bounce ON THE ARBITER (the AUTONOMOUS variant of
	 * the failure path). When set, the two FAILURE routings (`gate-failed` /
	 * `rebase-conflict`) pass this arbiter remote into the ledger write seam's
	 * `applyNeedsAttentionTransition`, which (mode M) cherry-picks the move-only
	 * commit onto the arbiter's `main` — making the stuck state observable to
	 * `scan`/`status`/another machine. This is exactly what `run`'s `runOneItem`
	 * does (it passes `arbiter: job.arbiterRemote`).
	 *
	 * Unset (the default) keeps `complete`'s HUMAN behaviour: route LOCALLY only
	 * (no on-`main` surfacing) — a human is right there, so no cross-machine
	 * surfacing is needed. The unattended `do` worker (the CI command) sets this
	 * so a stuck CI run is NOT invisible.
	 */
	surfaceArbiter?: string;
	/** Environment for child git/provider processes (the identity-scoped env). */
	env?: NodeJS.ProcessEnv;
	/**
	 * Environment for the REVIEW-AGENT launch (Gate 2) — the AMBIENT env, never the
	 * identity-scoped {@link env} (an agent must not act as the bot). Threaded to
	 * {@link performIntegration}'s `agentEnv`. Unset ⇒ falls back to {@link env}
	 * (byte-for-byte unchanged for non-identity callers, e.g. the human `complete`).
	 */
	agentEnv?: NodeJS.ProcessEnv;
	/** Sink for human-readable progress notes. */
	note?: (message: string) => void;
	/**
	 * Sink for a pre-formatted block printed VERBATIM (no `>> ` prefix), used for
	 * the visually-distinct propose-mode next-step block so its blank lines and
	 * heading stand out cleanly. Defaults to `note` when not supplied.
	 */
	noteBlock?: (message: string) => void;
	/**
	 * Emit ANSI color in the (cosmetic) propose-mode next-step block. Defaults
	 * to the TTY/`NO_COLOR` rule against `process.stdout`; injectable so tests
	 * can simulate a TTY (color) vs. a pipe / `NO_COLOR` (plain) without a real
	 * terminal. Color-only — it changes no gate/done-move/commit/integrate logic.
	 */
	color?: boolean;
}

export interface CompleteResult {
	exitCode: 0 | 1;
	outcome: CompleteOutcome;
	/**
	 * True iff a FAILURE outcome (gate-failed / rebase-conflict) was routed to
	 * the shared needs-attention mechanism (ADR §12) — post lock-cutover, the
	 * per-item lock is amended to `state: stuck` with the reason recorded on the
	 * lock entry (there is no `work/needs-attention/` folder write anymore),
	 * rather than the item being left dangling. Undefined/false on the success,
	 * `--skip-verify`, refused, and usage-error paths (none of which mark the
	 * item stuck).
	 */
	routedToNeedsAttention?: boolean;
	/** The work branch that was completed, when one was resolved. */
	branch?: string;
	/** The completion commit message that was authored, on success. */
	commitMessage?: string;
	/** True when the work landed on the arbiter's `main` (merge mode). */
	mergedToMain?: boolean;
	/**
	 * Merge mode only: whether the LOCAL `main` was fast-forwarded to the
	 * just-pushed `<arbiter>/main` (the ergonomic courtesy AFTER the authoritative
	 * push). `true` on the normal ff path; `false` when local `main` had DIVERGED
	 * and the ff could not apply — a NON-FATAL skip (the arbiter push already
	 * defined success, so `outcome` stays `completed` / exit 0; the operator is told
	 * to `git rebase` to sync). Undefined outside merge mode / `--no-switch`.
	 */
	localMainSynced?: boolean;
	/** The branch HEAD ended on after completing (`main`, or the work branch). */
	switchedTo?: string;
	/** True iff the local `work/<slug>` branch was deleted (provably on arbiter). */
	deletedLocalBranch?: boolean;
	/**
	 * The review-request URL (e.g. a GitHub PR) opened in `propose` mode, when a
	 * provider opened one and reported it (ADR §6). Absent in merge mode and on
	 * the push-only / degraded path.
	 */
	prUrl?: string;
	/** Human-readable summary of the terminal condition. */
	message: string;
}

const DEFAULT_ARBITER = 'origin';
const DEFAULT_INTEGRATION: IntegrationMode = 'propose';

/**
 * Resolve the integration mode the human asked for ON THIS invocation from the
 * mutually-exclusive `--merge` / `--propose` flags. Returns the explicit mode,
 * or `undefined` when neither flag was given (per-repo > global > default then
 * decides). Throws when BOTH are given (they are mutually exclusive). This is
 * the TOP of the complete-time precedence chain (flag > per-repo > global >
 * default); the autonomous runner uses no flag and so resolves the same
 * underlying order.
 */
export function integrationFromFlags(flags: {
	merge?: boolean;
	propose?: boolean;
}): IntegrationMode | undefined {
	if (flags.merge && flags.propose) {
		throw new Error(
			'--merge and --propose are mutually exclusive; pass at most one.',
		);
	}
	if (flags.merge) {
		return 'merge';
	}
	if (flags.propose) {
		return 'propose';
	}
	return undefined;
}

/** Raised for usage/environment errors (exit 1, outcome 'usage-error'). */
class CompleteUsageError extends Error {}

/**
 * The CAUSE-CLASS of a {@link CompleteRefusal}. `source-strand` is the SLUG-IS-
 * STUCK class (no in-progress/needs-attention/done file on the branch tree) — on
 * the AUTONOMOUS path (`surfaceArbiter` set) it surfaces to needs-attention via
 * the tree-less seam so the next tick does not re-claim-and-recrash forever.
 * `diverged-main` is an ENV/OPERATOR condition (local main ahead of
 * `<arbiter>/main`) — NOT a stuck task, so it is NEVER bounced even on the
 * autonomous path; it stays the local `refused`.
 */
type RefusalKind = 'source-strand' | 'diverged-main' | 'gate-unrunnable';

/** Raised for a deliberate REFUSAL (exit 1, outcome 'refused'). */
class CompleteRefusal extends Error {
	constructor(
		message: string,
		readonly kind: RefusalKind,
		readonly slug?: string,
	) {
		super(message);
	}
}

/**
 * Run the complete ritual. Never throws for the expected gate-failed /
 * rebase-conflict / refused cases — those are returned with exit 1 and a
 * specific outcome. Usage/environment problems also surface as exit 1.
 */
export async function performComplete(
	options: CompleteOptions,
): Promise<CompleteResult> {
	const note = options.note ?? (() => {});
	try {
		return await runComplete(options, note);
	} catch (err) {
		// AUTONOMOUS-STRAND SURFACE (task
		// `autonomous-integration-refusal-surfaces-not-strands-in-progress`, spec
		// `ledger-integrity` story 7). On the AUTONOMOUS path (`surfaceArbiter` set
		// — the human-vs-autonomous gate the core's other failures use), a SOURCE-
		// STRAND `CompleteRefusal` (the slug-is-stuck `nothing to complete`) and the
		// core's empty-commit `IntegrationNothingStaged` would otherwise return a
		// bare `refused` and silently strand the item in `work/in-progress/` on the
		// arbiter — so the next autonomous tick re-claims it and re-crashes the
		// SAME way forever. Mirror `run`'s posture (an autonomous failure NEVER
		// silently strands the item in in-progress/) by surfacing it to
		// `needs-attention/` via the TREE-LESS arbiter-truth seam
		// (`applyTreelessNeedsAttentionTransition`, the same mechanism `requeue`
		// uses in reverse): there is no working-tree `.md` to `git mv` here (the
		// strand IS that the source file is missing on the branch), so the
		// cwd-bound `applyNeedsAttentionTransition` cannot be used — the tree-less
		// seam resolves the source folder on the arbiter and CAS-publishes the
		// move-only `.md` relocation. The DIVERGED-MAIN refusal is an env/operator
		// condition (NOT a stuck task), so it is excluded — leave it `refused`.
		// When the tree-less surface cannot land (CAS contention exhausted, or no
		// arbiter), report the HONEST still-in-progress signal
		// (`outcome: 'surface-unmoved'`) the gate-fail path's `moved:false` mirrors
		// in `do.ts`/`run.ts` — never a fake success.
		const strandSlug = strandRefusalSlug(err);
		if (strandSlug && options.surfaceArbiter) {
			return await surfaceAutonomousStrand({
				cwd: options.cwd,
				slug: strandSlug,
				reason: (err as Error).message,
				arbiter: options.surfaceArbiter,
				env: options.env,
				note,
			});
		}
		if (
			err instanceof CompleteRefusal ||
			err instanceof IntegrationNothingStaged
		) {
			// `IntegrationNothingStaged` is the core's empty-commit refusal — the same
			// `refused` outcome the inline band raised before the extraction. The
			// diverged-main `CompleteRefusal` (env/operator condition) also lands here
			// on the autonomous path, deliberately UNCHANGED: it is NOT a stuck task.
			return {exitCode: 1, outcome: 'refused', message: err.message};
		}
		if (err instanceof CompleteUsageError) {
			return {exitCode: 1, outcome: 'usage-error', message: err.message};
		}
		const message = err instanceof Error ? err.message : String(err);
		return {exitCode: 1, outcome: 'usage-error', message};
	}
}

/**
 * The SLUG of an autonomous-bounceable strand refusal, or `undefined` when the
 * caught error is NOT a strand class (a `diverged-main` refusal, a usage error,
 * a usual throw). The two strand classes — a `source-strand` {@link
 * CompleteRefusal} and the core's {@link IntegrationNothingStaged} — BOTH leave
 * the slug stuck in `work/in-progress/` on the arbiter (the claim landed and
 * nothing has moved it since), so the autonomous bounce-set is exactly those
 * two. The `diverged-main` refusal is deliberately EXCLUDED: it is an
 * env/operator condition (local main ahead of `<arbiter>/main`), not a stuck
 * task; bouncing it would mis-attribute an env problem to the work.
 */
function strandRefusalSlug(err: unknown): string | undefined {
	if (err instanceof CompleteRefusal && err.kind === 'source-strand') {
		return err.slug;
	}
	if (err instanceof IntegrationNothingStaged) {
		return err.slug;
	}
	return undefined;
}

/**
 * Surface an autonomous-path strand refusal via the TREE-LESS seam ({@link
 * ledgerWrite.applyTreelessNeedsAttentionTransition}). Post lock-cutover the
 * seam is a pure LOCK AMEND — the item's per-item lock is moved to
 * `state: stuck` with the reason on the lock entry; no folder move, no
 * `work/needs-attention/` write. It NEVER touches the caller's
 * working tree / HEAD / index — important here because the refusal was raised
 * precisely because the working tree does NOT hold an `.md` to `git mv`. It is
 * idempotent (a re-surface of an already-surfaced slug is a no-op) and reports
 * `moved: false` honestly when it cannot land (CAS contention exhausted, or no
 * arbiter). The HONEST still-in-progress signal is then `outcome:
 * 'surface-unmoved'` — the SAME vocabulary `do`/`run`/`start` expose for the
 * after-commit tree-less surface that did not land; never a fake success.
 */
async function surfaceAutonomousStrand(params: {
	cwd: string;
	slug: string;
	reason: string;
	arbiter: string;
	env: NodeJS.ProcessEnv | undefined;
	note: (m: string) => void;
}): Promise<CompleteResult> {
	const {cwd, slug, reason, arbiter, env, note} = params;
	const surfaced = await ledgerWrite.applyTreelessNeedsAttentionTransition({
		cwd,
		slug,
		reason,
		arbiter,
		env,
		note,
	});
	if (surfaced.moved) {
		const message =
			`'${slug}' refused (${reason}); surfaced on ${arbiter}/main as a stuck ` +
			'question (needsAnswers) so the next autonomous tick does NOT re-claim it.';
		note(message);
		// PR-2b D3: a clean surface is GREEN (exitCode 0). The autonomous strand
		// surface is one of the cleanly-surfaced bounce sites this policy applies to.
		return {
			exitCode: 0,
			outcome: 'strand-surfaced',
			routedToNeedsAttention: true,
			message,
		};
	}
	const message =
		`'${slug}' refused (${reason}); the tree-less surface to needs-attention ` +
		`did NOT reach ${arbiter}/main — the item is HONESTLY still IN-PROGRESS on ` +
		`the arbiter (retry/resolve). ${surfaced.reasonNotMoved ?? ''}`.trim();
	note(message);
	return {
		exitCode: 1,
		outcome: 'surface-unmoved',
		routedToNeedsAttention: false,
		message,
	};
}

/**
 * Locate the slug's ledger record at a RENAMED done-position on the branch tree, to
 * survive a SELF-RENAMING FOLDER task (the `folder-taxonomy-reorg-and-rename`
 * migration).
 *
 * The trap: a task whose job is to `git mv` the ledger folders themselves (e.g.
 * `done/ -> tasks/done/`) runs through the runner's INSTALLED (pre-rename) binary,
 * whose compiled-in {@link workItemPath} still resolves `done` to `work/done/`.
 * When the agent has placed its OWN record at the NEW done-position
 * (`work/tasks/done/<slug>.md`) as part of the migration, the binary-known
 * `work/done/<slug>.md` does not exist, and the resolver below would crash with
 * `nothing to complete`, reaping the build.
 *
 * This scan is the layout-agnostic backstop: when the record is at NONE of the
 * binary-known ledger folders, walk `work/` and return true iff `<slug>.md` exists
 * directly inside a folder whose LEAF name is `done` (covering BOTH `work/done/`
 * and a renamed `work/tasks/done/`). It deliberately matches ONLY a `done` leaf:
 * a record left in a renamed POOL (`tasks/ready/`) is NOT a finished task and must
 * still refuse, not be mis-integrated as done. When this fires, the slug is treated
 * as already-done-moved by the agent into its terminal position, so the runner
 * SKIPS its own `git mv` (the existing `source: 'done'` / stranded-done path) and
 * just integrates the agent's tree as-is — no binary-vs-branch folder-name
 * reconciliation is needed.
 */
function recordAtRenamedDonePosition(cwd: string, slug: string): boolean {
	const file = `${slug}.md`;
	const workRoot = join(cwd, WORK_ROOT);
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, {withFileTypes: true});
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name === file && basename(dir) === 'done') {
				found.push(full);
			}
		}
	};
	walk(workRoot);
	return found.length > 0;
}

async function runComplete(
	options: CompleteOptions,
	note: (m: string) => void,
): Promise<CompleteResult> {
	const cwd = options.cwd;
	const env = options.env;
	const arbiter = options.arbiter ?? DEFAULT_ARBITER;
	// The integration mode. The shared core integrates a `merge` automatically on a
	// green gate (and an `approve` when review is on) and leaves a `propose` to a
	// human; there is no downgrade, so the mode it resolves always equals this one.
	// The tail below still reads the resolved mode from `core.integration.mode`.
	const requestedMode = options.integration ?? DEFAULT_INTEGRATION;

	if ((await gitSoft(['rev-parse', '--git-dir'], cwd, env)).status !== 0) {
		throw new CompleteUsageError('not inside a git repository');
	}
	if ((await gitSoft(['remote', 'get-url', arbiter], cwd, env)).status !== 0) {
		throw new CompleteUsageError(
			`no git remote named '${arbiter}' (set one, or pass --arbiter)`,
		);
	}

	// Resolve the slug + work branch. `complete` runs ON the work branch (it
	// rebases + pushes it), and the branch carries the namespaced `work/<type>-
	// <slug>` identity. So PREFER the branch HEAD is on (recovering BOTH the type
	// and the slug from it); only when an explicit slug is given AND HEAD is not on
	// a work branch do we synthesise the task-namespaced branch (`complete` is a
	// task command).
	const headBranch = await currentBranch(cwd, env);
	const headParsed = parseWorkBranchRef(headBranch);
	const slug = options.slug || headParsed?.slug || '';
	if (!slug) {
		throw new CompleteUsageError(
			'missing <slug> and the current branch is not a work/<type>-<slug> ' +
				'branch. usage: dorfl complete [<slug>] [--skip-verify] ' +
				'[--type t] [--message s] [--arbiter remote]',
		);
	}
	// The branch HEAD is on when it IS a work branch for this slug (so an explicit
	// `spec:`-style recovery still completes the branch it is standing on); else
	// synthesise the task branch.
	const branch =
		headParsed && headParsed.slug === slug
			? headBranch
			: workBranchRef('task', slug);

	// We must be ON the work branch — that is where the agent's work lives and
	// what we rebase + push. (Unlike `start`, `complete` mutates the checkout.)
	const head = headBranch;
	if (head !== branch) {
		throw new CompleteUsageError(
			`not on ${branch} (HEAD is '${head}'). ` +
				`Check out the work branch before completing '${slug}'.`,
		);
	}

	// The task is normally in `tasks/ready/` (claim leaves the body there — task
	// `cutover-claim-body-stays-and-complete-sources-from-backlog`). The legacy
	// runner-owned recovery path used to also probe `work/needs-attention/<slug>.md`,
	// but the per-item-lock cutover (task
	// `cutover-needs-attention-becomes-lock-stuck-recovery-surface`) retired that
	// folder: a stuck item is now the lock `state: stuck`, the body stays in
	// `tasks/ready/` while claimed, and a recovery `complete` sources from there
	// like any other build. The `needs-attention/` folder probe + the `recovering`
	// re-gate branch are GONE (this task,
	// `finish-needs-attention-folder-cutover-remove-legacy-recovery-readers`):
	// nothing writes that folder anymore so the arm could not fire.
	//
	// This LOCAL source resolution is now only a PRE-FLIGHT (which folder the
	// checkout holds) and the content FALLBACK: the integration core's done-move
	// RESOLVES THE ACTUAL SOURCE FOLDER FROM THE ARBITER (arbiter-is-truth) and
	// removes it from THERE, so the move can never disagree with what the arbiter
	// holds even when the local tree diverges (ledger-integrity defect 1). The
	// `source` we pass is the arbiter-content fallback for the degenerate "arbiter
	// holds nothing" case, not the authority. The legacy `in-progress/` FOLDER PROBE
	// is GONE (task `finish-in-progress-folder-cutover-remove-legacy-recovery-readers`):
	// the per-item-lock cutover moved claim OFF writing `work/in-progress/` (the body
	// rests in `tasks/backlog/`, liveness is the held lock), so nothing writes that
	// folder anymore and the `existsSync(inProgress)` arm could not fire. Liveness is
	// the lock, not the folder.
	const backlog = workItemPath(cwd, 'tasks-ready', slug);
	const staged = workItemPath(cwd, 'tasks-backlog', slug);
	const done = workItemPath(cwd, 'done', slug);
	const onBacklog = existsSync(backlog);
	// `--allow-backlog` drive (spec
	// `do-allow-backlog-drive-staged-tasks-without-promotion`): a staged task driven
	// in place RESTS in `tasks/backlog/` (claim never moved it). Detect it as a build
	// source so the done-move goes `tasks/backlog/ → tasks/done/` DIRECTLY (the
	// human's explicit drive IS the promotion; it never bounces through the pool).
	// LOWER priority than `tasks/ready/` so a same-slug pool copy wins the resolution.
	// GATED on the explicit flag: WITHOUT it, a body in staging is a corrupt/wip
	// strand `complete` must REFUSE (the honest "not finished, not done" position),
	// NOT silently integrate — only the deliberate drive promotes from staging.
	const onPreBacklog = options.allowBacklog === true && existsSync(staged);
	// SELF-RENAMING FOLDER task backstop: the binary-known `work/done/<slug>.md`,
	// OR — when none of the binary-known ledger folders hold the record — the slug
	// at a RENAMED done-position the migration agent placed it in (e.g.
	// `work/tasks/done/<slug>.md`). See {@link recordAtRenamedDonePosition}. The
	// scan runs ONLY in the all-binary-folders-empty case, so a normal task's
	// resolution is byte-for-byte unchanged.
	const onDone =
		existsSync(done) ||
		(!onBacklog && !onPreBacklog && recordAtRenamedDonePosition(cwd, slug));
	// STRANDED-DONE AUTO-RECOVER (spec `ledger-integrity` story 6, the autonomous
	// half of `finish-already-committed-branch`). When the pool/staging does NOT
	// hold the slug on the BRANCH tree BUT done/ does, the work
	// branch was already built + done-moved + committed by a prior run that never
	// landed on the arbiter (a terminal push failed, or the PR never merged). The
	// autonomous `do`/`advance`/plain-`complete` path used to refuse this with
	// `nothing to complete`; instead route into the SHARED recover tail (the SAME
	// `committedRecovery: true` path `complete --isolated` drives), reusing the
	// existing capability. Detection here is the FRONT-GATE only — folder shape;
	// `recoverAlreadyCommitted` owns the unspoofable tip-vs-arbiter `isAncestor`
	// decision (one reachability check, not two), so a tip ALREADY on
	// `<arbiter>/main` returns `already-integrated` (clean no-op, NEVER a
	// re-push/double-integrate). Mutually exclusive with the build-path source +
	// `recovering` flags — the core ignores them when `committedRecovery` is set.
	const folderShapeStranded = !onBacklog && !onPreBacklog && onDone;
	// DIRTY-CONTINUE GATE (task `recover-autodetect-gated-on-nothing-to-commit`).
	// The folder-shape stranded-done auto-detect is necessary but NOT sufficient on
	// a CONTINUE: a requeued task whose prior attempt already done-moved the slug
	// into `done/` on the kept branch looks IDENTICAL by folder shape to a genuine
	// finished strand, even when THIS run's agent produced NEW uncommitted edits.
	// The recover path skips the build/commit/done-move steps and only rebases the
	// ALREADY-committed kept tip, so firing the recover on a dirty continue would
	// SILENTLY DISCARD the new work. Disambiguate on the WORKING-TREE-DIRTY check
	// (the porcelain half of `isWorkBranchDiffEmpty`, extracted as
	// `hasUncommittedSourceChanges`). NOT the core's `nothingStaged`: that is
	// INDEX-only and reads empty BEFORE the core's later `git add -A`, so it would
	// miss the agent's UNSTAGED edits. NOT the FULL `isWorkBranchDiffEmpty`: its
	// commits-ahead half is true for a GENUINE STRAND too (the kept tip carries
	// source commits ahead of main), so it would WRONGLY BLOCK the legitimate
	// recover and break the task-1 / finished-strand behaviour.
	const dirtyContinue =
		folderShapeStranded && (await hasUncommittedSourceChanges({cwd, env}));
	const committedRecovery = folderShapeStranded && !dirtyContinue;
	// CONTINUE-BUILD (task `complete-builds-on-already-done-moved-continue`,
	// scope option A — the explicit `source: 'done'` contract). On a DIRTY
	// continue whose kept branch already holds the slug in `work/done/`, route
	// through the build path's NEW continue-build state: the integration core
	// SKIPS the step-2 `git mv` (the slug is already in done/) and is exempted
	// from the originTrust read + the divergent-done-move reconcile (there is no
	// first-time move on this commit), but still runs prepare → gate → `git add
	// -A` → commit → rebase → integrate on the NEW work. Replaces the blocker
	// task's needs-attention BOUNCE (the dirty continue now AUTO-LANDS instead
	// of surfacing). See `docs/adr/continue-build-already-done-moved.md`.
	// Default branch (post `needs-attention/`-folder cutover, this task): when
	// NONE of the recognised source folders holds the slug, the build cannot
	// proceed — refuse via the `existsSync(sourcePath)` check below (the explicit
	// "nothing to complete" CompleteRefusal). We default `source` to `'tasks-ready'`
	// so `sourcePath` resolves to the canonical pool path the refusal message
	// names; the refusal fires because that file does not exist on disk.
	const source: 'tasks-ready' | 'tasks-backlog' | 'done' = dirtyContinue
		? 'done'
		: onBacklog
			? 'tasks-ready'
			: onPreBacklog
				? 'tasks-backlog'
				: 'tasks-ready';
	const sourcePath =
		source === 'tasks-ready'
			? backlog
			: source === 'tasks-backlog'
				? staged
				: done;
	if (dirtyContinue) {
		// Announce LOUDLY (parallel to the `committedRecovery` recovery note above):
		// the autonomous integrate path took the CONTINUE-BUILD branch, not the
		// clean-strand recover and not a refusal — the CI/job log must record that
		// the new work was built + integrated on top of the kept already-done-moved
		// tip (no second `git mv`).
		note(
			`>> continue-build on '${slug}': the task is already in work/done/ on the ` +
				'kept branch (a prior attempt done-moved it); building + integrating the ' +
				'new uncommitted work on top of the kept tip (no second git mv).',
		);
	}
	// The presence check guards the genuine-strand case (no record anywhere). It is
	// DELIBERATELY skipped for `source === 'done'` (the continue-build / stranded-done
	// state): there the record is ALREADY in its terminal done-position — presence
	// was established by `folderShapeStranded`/`onDone`, which is LAYOUT-AWARE (it
	// accepts a renamed `work/tasks/done/<slug>.md` via `recordAtRenamedDonePosition`).
	// The binary's `sourcePath` (= `done` = `work/done/<slug>.md`) would NOT exist for
	// a self-renaming-folder task, so re-checking it here would wrongly refuse a
	// build the done-detection already accepted. `source: 'done'` skips the `git mv`
	// anyway, so there is nothing this check needs to protect for that branch.
	if (!committedRecovery && source !== 'done' && !existsSync(sourcePath)) {
		throw new CompleteRefusal(
			`work/tasks/ready/${slug}.md not found — ` +
				'nothing to complete (already done, or wrong slug?).',
			'source-strand',
			slug,
		);
	}
	// `source: 'done'` is the CONTINUE-BUILD state — NOT a recover (the agent
	// produced new work this run) and NOT the clean-strand recover
	// (`committedRecovery` is mutually exclusive with `dirtyContinue` by
	// construction above). It falls through to `performIntegration` like a
	// normal build, where the core skips the step-2 `git mv` for this source.
	// Post `needs-attention/`-folder cutover (task
	// `finish-needs-attention-folder-cutover-remove-legacy-recovery-readers`):
	// `source === 'needs-attention'` is no longer reachable here (the folder is
	// retired; a stuck item is the lock `state: stuck` and the body rests in
	// `tasks/ready/`). A recovery `complete` of a stuck item now sources from
	// `tasks/ready/` like a normal build, so `recovering` is always `false`. The
	// integration core still accepts the flag (vestigial, ignored) — every caller
	// passes `false` and the re-gate branches that read it are dead.
	const recovering = false;
	if (committedRecovery) {
		// Announce LOUDLY: a stranded already-complete branch signals an EARLIER
		// un-merged PR — the CI/job log must record that the autonomous path took
		// the recovery branch, not a normal completion. The `already-integrated`
		// no-op gets its own clear note from the core itself.
		note(
			`>> recovered a stranded already-complete branch for '${slug}' — ` +
				'integrating the kept commit (no rebuild). This signals an earlier ' +
				'un-merged PR.',
		);
	}

	// Pre-flight DIVERGENCE GUARD (merge mode only) — the SAME class of refusal `do`
	// raises up front: a local `main` AHEAD of `<arbiter>/main` (unpushed commits)
	// cannot be fast-forwarded by the merge-back, so refuse BEFORE the gate so no
	// work is wasted. Only merge mode ff's local `main`; propose only switches to it
	// (no ff), so the guard is irrelevant there. `--ignore-diverged-main` overrides
	// (mirrors `--ignore-not-ready`); when overridden, the now-NON-FATAL
	// `syncLocalMain` handles the persisting divergence honestly at integrate-time.
	if (requestedMode === 'merge' && options.ignoreDivergedMain !== true) {
		await gitHard(['fetch', '--quiet', arbiter], cwd, env);
		const ahead = await localMainAheadCount(cwd, arbiter, env);
		if (ahead > 0) {
			throw new CompleteRefusal(
				`local main is ahead of ${arbiter}/main by ${ahead} commit` +
					`${ahead === 1 ? '' : 's'} (unpushed); a merge completion ff's local ` +
					"main, which can't fast-forward against a diverged main — push or " +
					'reconcile main first (or re-run with --ignore-diverged-main to ' +
					'proceed anyway).',
				'diverged-main',
				slug,
			);
		}
	}

	// STATIC fresh-worktree-gate readiness guard — the human/recovery mirror of
	// `performDo`'s step 3d (task
	// `do-fails-fast-when-acceptance-gate-statically-unrunnable`). When the fresh-
	// worktree gate is ON for THIS invocation AND `prepare` resolves to no commands
	// AND a lockfile is present, the throwaway worktree the gate runs in will have
	// no installed deps, so the gate cannot run. Surface the precise error BEFORE
	// `performIntegration` does any work (skip-verify bypasses the gate entirely
	// and so bypasses this guard too — if there is no gate to run, there is no
	// precondition to check). Gated on `freshWorktreeGate === true` for THIS
	// invocation: when OFF, the gate runs in the CURRENT checkout (which carries
	// its deps), so the throwaway-worktree reasoning does not apply.
	// ALSO fails fast when `verify` is unset/all-blank (a MODE-INDEPENDENT stop —
	// Dorfl has no default gate). Bypassed by --skip-verify (no gate to check).
	if (options.skipVerify !== true) {
		const guard = checkGatePreconditions({
			freshWorktreeGate: options.freshWorktreeGate,
			prepare: options.prepare,
			verify: options.verify,
			lockfile: detectLockfileOnDisk(cwd),
		});
		if (guard !== undefined) {
			throw new CompleteRefusal(guard.message, 'gate-unrunnable');
		}
	}

	// CORE: run the SHARED gate→integrate band (verify → review → effective-mode
	// decision → done-move → commit → rebase → integrate → needs-attention routing).
	// It returns DATA (the routing + the effective-mode decision already happened
	// inside it); the TAIL below does only `complete`'s caller-specific post-step
	// (switch-to-main / ff / delete-branch / `--no-switch` / the propose next-step
	// block). The human-vs-autonomous difference rides on `surfaceArbiter` (DATA).
	// `IntegrationNothingStaged` is the one refusal the core raises (empty commit);
	// `performComplete`'s try/catch maps it to `refused`, unchanged.
	const core = await performIntegration({
		cwd,
		arbiter,
		slug,
		// The namespaced work branch HEAD is on (resolved above) — pass it through
		// so the integrate core pushes the EXACT branch, not a re-synthesised default.
		branch,
		source,
		recovering,
		// Route stranded-done into the shared recover tail (front-gate detection;
		// the core does the unspoofable tip-vs-arbiter ancestry check).
		committedRecovery,
		prepare: options.prepare,
		verify: options.verify,
		freshWorktreeGate: options.freshWorktreeGate,
		// The cross-job merge-serialiser CAS-retry cap (config `mergeRetries`) — the
		// git-alone FLOOR of the cross-job land-queue, resolved through the gate-family
		// precedence chain (spec `land-time-reverify-and-parallel-merge-ceiling` Story
		// 5). Threaded so a wide-matrix CI's raised cap actually reaches the merge loop.
		mergeRetries: options.mergeRetries,
		skipVerify: options.skipVerify,
		// The untrusted-origin build-propose rule's override (task
		// `untrusted-origin-forces-build-propose`): an explicit `--merge` lets the
		// operator land an untrusted-origin task on main; the autonomous path leaves
		// it unset so untrusted-origin reliably forces propose.
		explicitMerge: options.explicitMerge,
		review: options.review,
		reviewGate: options.reviewGate,
		reviewModel: options.reviewModel,
		reviewMaxRounds: options.reviewMaxRounds,
		mode: requestedMode,
		noPR: options.noPR,
		providerInstance: options.providerInstance,
		openPr: options.openPr,
		body: options.body,
		type: options.type,
		message: options.message,
		surfaceArbiter: options.surfaceArbiter,
		watch: options.watch,
		watchSink: options.watchSink,
		color: options.color,
		sessionsDir: options.sessionsDir,
		env,
		agentEnv: options.agentEnv,
		note,
	});

	// The FAILURE outcomes map 1:1 onto `complete`'s — the core already note()'d
	// the reason and did any routing; the tail never runs for them.
	// PR-2b exit-code policy (spec
	// `surface-stuck-as-questions-and-retire-stuck-lock-state`, decision #4 / D3):
	// a cleanly-surfaced bounce is GREEN (`exitCode: 0`) iff its surface transition
	// SUCCEEDED (`routedToNeedsAttention: true`); a FAILED surface stays non-zero
	// (retry/resolve). Applies to `prepare-failed`/`gate-failed`/`review-blocked`/
	// `review-unparseable`/`rebase-conflict`. The empty-diff backstop is owned by
	// task `empty-diff-bounce-surfaces-dispose-defaulted-question` and is NOT
	// reached here.
	const surfaceExit = (routed: boolean | undefined): 0 | 1 =>
		routed === true ? 0 : 1;
	if (core.outcome === 'prepare-failed') {
		return {
			exitCode: surfaceExit(core.routedToNeedsAttention),
			outcome: 'prepare-failed',
			routedToNeedsAttention: core.routedToNeedsAttention,
			branch: core.branch,
			message: core.reason ?? '',
		};
	}
	if (core.outcome === 'gate-failed') {
		return {
			exitCode: surfaceExit(core.routedToNeedsAttention),
			outcome: 'gate-failed',
			routedToNeedsAttention: core.routedToNeedsAttention,
			branch: core.branch,
			message: core.reason ?? '',
		};
	}
	if (core.outcome === 'review-blocked') {
		return {
			exitCode: surfaceExit(core.routedToNeedsAttention),
			outcome: 'review-blocked',
			routedToNeedsAttention: core.routedToNeedsAttention,
			branch: core.branch,
			message: core.reason ?? '',
		};
	}
	if (core.outcome === 'review-unparseable') {
		// Gate 2 RAN but its verdict was UNPARSEABLE (malformed JSON). The core already
		// routed it work-preservingly via `applyNeedsAttentionTransition` (branch pushed +
		// surfaced on the autonomous path). Map it 1:1 like the other routed failures; the
		// `do`/`run` tail re-labels its cause `transient-infra` (NOT a reviewer block) off
		// the parse-failure phrase in `core.reason`.
		return {
			exitCode: surfaceExit(core.routedToNeedsAttention),
			outcome: 'review-unparseable',
			routedToNeedsAttention: core.routedToNeedsAttention,
			branch: core.branch,
			message: core.reason ?? '',
		};
	}
	if (core.outcome === 'rebase-conflict') {
		return {
			exitCode: surfaceExit(core.routedToNeedsAttention),
			outcome: 'rebase-conflict',
			routedToNeedsAttention: core.routedToNeedsAttention,
			branch: core.branch,
			commitMessage: core.commitMessage,
			message: core.reason ?? '',
		};
	}
	if (core.outcome === 'sidecar-violation') {
		// A co-located `<slug>/` sidecar sits beside a FLOWING task/spec item
		// (WORK-CONTRACT rule 8): a HARD BLOCK before the durable move (the sidecar
		// would strand on `ready → done`). Routed to needs-attention by the same
		// seam the red gate / review block use; the actionable relocate-to-
		// `docs/spikes/<slug>/` reason rides `core.reason`.
		return {
			exitCode: surfaceExit(core.routedToNeedsAttention),
			outcome: 'sidecar-violation',
			routedToNeedsAttention: core.routedToNeedsAttention,
			branch: core.branch,
			message: core.reason ?? '',
		};
	}
	if (core.outcome === 'already-integrated') {
		// Stranded-done auto-recover: the kept tip is ALREADY on `<arbiter>/main`
		// (the PR merged out-of-band before the re-run). A clean, successful no-op
		// — NEVER a re-push / second PR. The core already emitted its honest note;
		// the caller's tail (switch-to-main / ff / delete-branch) is irrelevant
		// because the work is already integrated and the branch may or may not
		// still exist locally.
		//
		// CROSS-SUBSTRATE RELEASE (spec `ledger-status-per-item-lock-refs` US #9/#10;
		// task `complete-lock-then-durable-main-move-crash-safe`): the durable
		// `main` record is already terminal (the kept tip is provably on
		// `<arbiter>/main`), so the per-item lock claim took is now stale: release it
		// SECOND (the move already landed FIRST). `durablyOnMain: true` unconditionally
		// here (unlike the propose build path, this branch is reached ONLY when the
		// work is already integrated on `main`). Best-effort + idempotent (`not-held`
		// is fine when a prior reconcile/release cleared it).
		await releaseClaimLockAfterDurableMove(slug, cwd, arbiter, env, true, note);
		return {
			exitCode: 0,
			outcome: 'already-integrated',
			branch: core.branch,
			message: core.reason ?? '',
		};
	}
	if (core.outcome === 'invariant-violation') {
		// The one-slug-one-folder guard FAILED LOUD: the arbiter already holds the
		// slug in >1 status folder (a corrupt ledger). Nothing was committed/moved;
		// refuse rather than publish corruption (the human resolves the duplicate —
		// `scan`/`gc` surfaces it — then re-runs). Exit 1, never routed.
		return {
			exitCode: 1,
			outcome: 'invariant-violation',
			routedToNeedsAttention: false,
			branch: core.branch,
			message: core.reason ?? '',
		};
	}

	// SUCCESS: the core integrated. `result` is its integration result; `mode` is
	// the mode the core resolved, read from the result (it always equals the
	// requested mode now that there is no downgrade). The tail switches/ffs per the
	// mode that integrated.
	const result = core.integration!;
	const commitMessage = core.commitMessage;
	const mode = result.mode;

	// CROSS-SUBSTRATE RELEASE, gated on the work being DURABLY ON `main` (spec
	// `ledger-status-per-item-lock-refs` US #9/#10; ADR
	// `ledger-status-on-per-item-lock-refs`; the trail's Amendment 6; task
	// `complete-lock-then-durable-main-move-crash-safe`). ORDER MATTERS: the
	// per-item lock that `claim` acquired (`action: implement`, keyed
	// `task:<slug>`) is released SECOND, AFTER the durable `main` move landed FIRST
	// inside `performIntegration`.
	//
	// CRITICAL (task `propose-keep-lock-until-pr-merge`): in PROPOSE mode the
	// done-move did NOT land on `main` here. The `git mv tasks/ready -> done` is
	// committed on the WORK BRANCH and pushed as the PR; `<arbiter>/main` still
	// shows the body in `tasks/ready/` until a human MERGES the PR. So releasing
	// the lock now would leave the task BOTH unlocked AND in `tasks/ready/` on
	// `main`, i.e. fully eligible again, for the whole review window: the next
	// advance tick re-claims it (lock absent), rebuilds, the PR meanwhile merges,
	// the diff is empty, and the item is mis-marked `stuck`. So we release ONLY
	// when the work is provably on `main`: merge mode (`mergedToMain`) or an
	// already-landed propose (`alreadyLanded`, the benign already-on-main race
	// tail). A plain open propose PR KEEPS the lock held (the open PR IS the
	// in-flight state); it is released when the work lands on `main`, reconciled by
	// `reconcileItemLockAgainstMain` when the PR merges out-of-band.
	//
	// A crash between the move and the release leaves a `done`-on-`main` item with
	// a still-held lock; `reconcileItemLockAgainstMain` recovers it (the `main`
	// record is authoritative over the stale lock). The release is best-effort +
	// idempotent (`not-held` when the body predates the lock or a reconcile already
	// cleared it).
	const durablyOnMain =
		result.mergedToMain === true || result.alreadyLanded === true;
	await releaseClaimLockAfterDurableMove(
		slug,
		cwd,
		arbiter,
		env,
		durablyOnMain,
		note,
	);

	// Land back on `main` by default in BOTH modes (the move differs per mode),
	// then delete the local work branch iff its work is provably on the arbiter.
	// `--no-switch` keeps the human on the work branch AND keeps the branch.
	let switchedTo = branch;
	let deletedLocalBranch = false;
	// Merge mode only: whether the local `main` ff'd (the courtesy after the
	// authoritative push). `true` by default; flipped to `false` by `syncLocalMain`
	// on a NON-FATAL diverged-`main` skip. Undefined in propose / `--no-switch`.
	let localMainSynced: boolean | undefined;
	if (!options.noSwitch) {
		if (mode === 'merge') {
			// merge: the work landed on <arbiter>/main, so switch to main AND ff it.
			// The ff is a COURTESY — if local `main` diverged it cannot apply, which is
			// NON-FATAL (the push already defined success); `syncLocalMain` reports it.
			localMainSynced = await syncLocalMain(cwd, arbiter, env, note);
		} else {
			// propose: the work is on a pushed branch awaiting review, NOT on main,
			// so JUST switch to main — do NOT ff (arbiter main has not moved).
			await gitHard(['switch', '--quiet', 'main'], cwd, env);
		}
		switchedTo = 'main';
		// Delete the LOCAL work branch when provably on the arbiter (same predicate
		// as worktree deletion, ADR §4, mode-agnostic). NEVER delete the remote.
		deletedLocalBranch = await deleteLocalBranchIfProvablyOnArbiter(
			cwd,
			arbiter,
			branch,
			env,
		);
	}

	if (mode === 'merge') {
		// When the local ff was SKIPPED (diverged main, non-fatal), say so honestly —
		// the work IS on the arbiter; only the local courtesy ff was left undone.
		const localState =
			localMainSynced === false
				? 'local main left diverged (run `git rebase origin/main` to sync)'
				: 'local main updated';
		const landed = options.noSwitch
			? `merged to ${arbiter}/main; left on ${branch} (--no-switch).`
			: `merged to ${arbiter}/main; ${localState}` +
				`${deletedLocalBranch ? ` and ${branch} deleted` : ''}.`;
		const message = `Completed '${slug}': ${landed}`;
		note(message);
		return {
			exitCode: 0,
			outcome: 'completed',
			branch,
			commitMessage,
			mergedToMain: result.mergedToMain,
			localMainSynced,
			switchedTo,
			deletedLocalBranch,
			message,
		};
	}

	// propose: the branch is pushed; report the next step. The next step is the
	// ONE thing the human must act on, so it is emitted as a visually-distinct
	// block (blank lines + heading + TTY-aware color) ON TOP of the plain summary
	// note below — cosmetic only; the structured result is unchanged.
	//
	// BENIGN ALREADY-LANDED RACE TAIL (task `propose-push-survives-stale-lease-
	// on-reaped-work-ref`, follow-up
	// `complete-propose-honour-already-landed-and-rename-continue-branch-module`):
	// when the integrator's propose push observed a REAPED `work/<slug>` ref AND
	// the work was provably on `<arbiter>/main`, it returns `alreadyLanded: true`
	// with a custom `instruction`. In that case NOTHING was pushed and there is
	// NO ref for a PR to point at, so emitting the generic
	// `formatProposeNextStep` push+PR block ("Pushed ... Open a PR/MR ...") would
	// misreport a clean no-op as unfinished work. Surface the integrator's
	// `instruction` VERBATIM instead — it is already the correct clean-no-op
	// prose (the CI-dominant recovery path via `performIntegration` already does
	// the same; this is the sibling `complete.ts` caller's honest report). The
	// tail (switch-to-main / delete-local-branch / `--no-switch`) is UNCHANGED
	// — only the emitted next-step + summary text differ.
	if (result.alreadyLanded === true) {
		const instruction =
			result.instruction ??
			`${branch}: already on ${arbiter}/main (clean no-op).`;
		const tail = options.noSwitch
			? `; left on ${branch} (--no-switch).`
			: deletedLocalBranch
				? `; switched to main and deleted ${branch}.`
				: '; switched to main.';
		const message = `Completed '${slug}': ${instruction}${tail}`;
		note(message);
		return {
			exitCode: 0,
			outcome: 'completed',
			branch,
			commitMessage,
			mergedToMain: false,
			switchedTo,
			deletedLocalBranch,
			message,
		};
	}
	const color = options.color ?? shouldUseColor(process.stdout);
	const noteBlock = options.noteBlock ?? note;
	noteBlock(
		formatProposeNextStep({
			branch,
			arbiter,
			requestOpened: result.requestOpened,
			color,
		}),
	);
	const next = result.requestOpened
		? result.url
			? `pushed ${branch} and opened a review (${result.url})`
			: `pushed ${branch} and opened a review`
		: `pushed ${branch} to ${arbiter}. ` + 'Open a PR/MR to land it on main';
	const tail = options.noSwitch
		? `; left on ${branch} (--no-switch).`
		: deletedLocalBranch
			? `; switched to main and deleted ${branch}.`
			: '; switched to main.';
	const message = `Completed '${slug}': ${next}${tail}`;
	note(message);
	return {
		exitCode: 0,
		outcome: 'completed',
		branch,
		commitMessage,
		mergedToMain: false,
		switchedTo,
		deletedLocalBranch,
		prUrl: result.url,
		message,
	};
}

/**
 * Release the per-item lock `claim` ALSO acquired (`action: implement`, keyed
 * `task:<slug>`) AFTER the durable `main` move has landed — the SECOND, lock-
 * release half of complete's cross-substrate ordering (spec
 * `ledger-status-per-item-lock-refs` US #9/#10; task
 * `complete-lock-then-durable-main-move-crash-safe`).
 *
 * Called ONLY on the SUCCESS paths (`completed` / `already-integrated`). The lock
 * is released ONLY when the work is DURABLY ON `<arbiter>/main` (`durablyOnMain`):
 * merge mode (`mergedToMain`), an already-landed propose race tail
 * (`alreadyLanded`), or the `already-integrated` recovery (provably on main). In
 * those cases the lock is no longer holding anything in flight and is cleanly
 * released SECOND.
 *
 * When `durablyOnMain` is FALSE (a plain open propose PR: the done-move is on the
 * PR branch, NOT on `main`), the lock is KEPT HELD: the open PR IS the in-flight
 * state, and the held lock is what keeps the still-`tasks/ready/`-on-`main` task
 * out of the eligible pool until the PR merges (task
 * `propose-keep-lock-until-pr-merge`). Releasing here would let the next advance
 * tick re-claim the in-flight task and mis-mark it `stuck` on an empty diff. The
 * lock is released when the work lands on `main`, reconciled by
 * `reconcileItemLockAgainstMain` when the PR merges out-of-band.
 *
 * The FAILURE paths (gate-failed / review-blocked / rebase-conflict /
 * prepare-failed) deliberately do NOT call this: those route to needs-attention
 * (the lock is marked `stuck`, not released) and the item is still in flight.
 *
 * Best-effort + idempotent (a `not-held` is fine: the body may predate the lock,
 * or a crash-recovery `reconcileItemLockAgainstMain` may already have cleared it).
 * A release fault never fails an already-landed completion: the durable `main`
 * record is authoritative, and a stranded lock is exactly what recovery clears.
 */
async function releaseClaimLockAfterDurableMove(
	slug: string,
	cwd: string,
	arbiter: string,
	env: NodeJS.ProcessEnv | undefined,
	durablyOnMain: boolean,
	note: (message: string) => void,
): Promise<void> {
	if (!durablyOnMain) {
		// PROPOSE, PR open: the done-move is on the PR branch, not on `main`. KEEP the
		// lock held so the in-flight task is not re-claimed during the review window.
		// The wording used to promise "It is released when the PR merges (reconciled
		// against main)", which was FALSE: no dorfl process is present at merge time
		// (no hook, no daemon), so nothing could act on that event and every propose
		// build leaked its lock ref for ever. The release actually happens on the next
		// command that writes to the arbiter (the claim path sweeps stale terminal
		// locks), so the message now names a trigger that really fires.
		note(
			`'${slug}': keeping the per-item lock HELD (propose PR open; the work is ` +
				'not yet on main). Once the PR merges, the item comes to rest on main and ' +
				'the lock is released by the next claim (or now, with `dorfl status ' +
				'--reconcile-locks`).',
		);
		return;
	}
	try {
		await releaseItemLock({item: `task:${slug}`, cwd, arbiter, env});
	} catch {
		// Best-effort: a release fault leaves a stale lock that recovery
		// (`reconcileItemLockAgainstMain`) clears: the durable move already defined
		// success. Never fail an already-landed completion on the lock release.
	}
}

/**
 * Sync the local `main` to the just-pushed `<arbiter>/main`: switch to main and
 * fast-forward it. We fetch the arbiter's main (we just pushed our rebased work
 * there) then `merge --ff-only` so the user lands on an up-to-date local main
 * without merge noise.
 *
 * The ff is a COURTESY, NOT the safety-bearing step — the authoritative push to
 * `<arbiter>/main` already defined `complete`'s success. So the ff is NON-FATAL:
 * if local `main` has DIVERGED (unpushed commits the arbiter lacks) the ff cannot
 * apply; rather than throw (which would make `complete` exit non-zero even though
 * the merge ALREADY LANDED on the arbiter), we print a clear "rebase to sync"
 * message and return `false` (the caller records `localMainSynced: false` and
 * keeps `outcome: completed` / exit 0). Returns `true` on a normal ff.
 *
 * Only the diverged / ff-cannot-apply case is softened — the `fetch` and `switch`
 * stay `gitHard` (a genuinely different failure is NOT masked, per the task).
 * Exported for direct testing of the softened-vs-fatal boundary in isolation.
 */
export async function syncLocalMain(
	cwd: string,
	arbiter: string,
	env: NodeJS.ProcessEnv | undefined,
	note: (m: string) => void,
): Promise<boolean> {
	await gitHard(['fetch', '--quiet', arbiter], cwd, env);
	await gitHard(['switch', '--quiet', 'main'], cwd, env);
	// SOFT: a non-zero here is (almost always) "not possible to fast-forward" —
	// local `main` diverged. That is the one case we make non-fatal.
	const ff = await gitSoft(
		['merge', '--ff-only', '--quiet', `${arbiter}/main`],
		cwd,
		env,
	);
	if (ff.status === 0) {
		return true;
	}
	note(
		`work landed on ${arbiter}/main; your local main couldn't fast-forward (it ` +
			'has diverged) — run `git rebase origin/main` to sync.',
	);
	return false;
}

/**
 * Delete the LOCAL `work/<slug>` branch iff its work is PROVABLY on the arbiter
 * — the SAME predicate as worktree deletion (ADR §4), mode-agnostic. Must be
 * called AFTER we have switched off the branch (you cannot delete the branch you
 * are on). Returns whether the local branch was deleted.
 *
 * Provably-on-arbiter ⇔ EITHER:
 *   - merged: the branch tip is an ancestor of `<arbiter>/main`, OR
 *   - pushed & up-to-date: `<arbiter>/<branch>` exists AND its tip == the local
 *     branch tip (so a later un-pushed amend is NEVER lost — we verify the
 *     remote tip equals the local tip, not merely that "a branch was pushed").
 *
 * Otherwise the branch is KEPT (unmerged / unpushed / diverged = not safe). The
 * REMOTE branch is NEVER touched (a propose PR is built from it). A `git fetch`
 * refreshes the remote-tracking refs so reachability is read against the LIVE
 * arbiter; an unreachable arbiter simply reads as not-provable → keep (safe).
 */
async function deleteLocalBranchIfProvablyOnArbiter(
	cwd: string,
	arbiter: string,
	branch: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<boolean> {
	if (!(await isLocalBranchProvablyOnArbiter(cwd, arbiter, branch, env))) {
		return false; // not provably on the arbiter → KEEP the local branch
	}
	// Provably on the arbiter → delete ONLY the local branch (force-delete: the
	// `-d` safety check uses the upstream/HEAD, which we have already proven via
	// the predicate above; `-D` avoids a false "not fully merged" in propose mode).
	await gitHard(['branch', '-D', branch], cwd, env);
	return true;
}

/**
 * The provably-safe predicate (ADR §4), mode-agnostic, applied to a LOCAL
 * `branch` in `cwd`: true iff its tip is an ancestor of `<arbiter>/main` (merged)
 * OR `<arbiter>/<branch>` exists with its tip == the local tip (pushed &
 * up-to-date). False when the local branch is absent, or its work is unmerged /
 * unpushed / a diverged un-pushed amend (remote tip != local tip). A `git fetch`
 * refreshes the remote-tracking refs; an unreachable arbiter reads as not-
 * provable → false (the safe direction). Exported for direct testing of the
 * kept-vs-deleted decision in isolation.
 */
export async function isLocalBranchProvablyOnArbiter(
	cwd: string,
	arbiter: string,
	branch: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<boolean> {
	const localTip = (
		await gitSoft(['rev-parse', '--verify', '--quiet', branch], cwd, env)
	).stdout.trim();
	if (localTip === '') {
		return false; // no such local branch
	}

	// Refresh remote-tracking refs against the live arbiter (best-effort).
	await gitSoft(['fetch', '--quiet', arbiter], cwd, env);

	// Merged: the tip is provably on <arbiter>/main — fast-path ancestor OR
	// squash-aware fallback (durable done/dropped record on main + branch
	// carries nothing main lacks). The SAME predicate `gc.ts`'s worktree reaper
	// and `reap-branches.ts`'s remote sweep use — do not fork it.
	const parsed = parseWorkBranchRef(branch);
	const arbiterMainRef = `${arbiter}/main`;
	const merged =
		parsed === undefined
			? (
					await gitSoft(
						['merge-base', '--is-ancestor', localTip, arbiterMainRef],
						cwd,
						env,
					)
				).status === 0
			: isProvablyMergedForReap({
					cwd,
					tip: localTip,
					arbiterMain: arbiterMainRef,
					namespace: parsed.namespace as SidecarType,
					slug: parsed.slug,
					env,
				});
	if (merged) {
		return true;
	}

	// Pushed & up-to-date: <arbiter>/<branch> exists AND its tip == the local tip
	// (we verify remote-tip == local-tip so a later un-pushed amend is never lost).
	const remoteTip = (
		await gitSoft(
			['rev-parse', '--verify', '--quiet', `refs/remotes/${arbiter}/${branch}`],
			cwd,
			env,
		)
	).stdout.trim();
	return remoteTip !== '' && remoteTip === localTip;
}

/** The short symbolic name of HEAD, or '' for a detached HEAD. */
async function currentBranch(
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<string> {
	const sym = await gitSoft(
		['symbolic-ref', '--quiet', '--short', 'HEAD'],
		cwd,
		env,
	);
	return sym.status === 0 ? sym.stdout.trim() : '';
}

/** Run git, returning the raw result (no throw) — for soft checks. */
function gitSoft(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<RunResult> {
	return runAsync('git', args, cwd, {env});
}

/** Run git; throw on non-zero (genuinely unexpected plumbing failures). */
async function gitHard(
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
