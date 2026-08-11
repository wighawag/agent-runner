import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	LEDGER_STATUS_FOLDERS,
	type LedgerStatusFolder,
	type WorkFolderKey,
	workItemPath,
	workItemRel,
	workFolderPath,
	workFolderPrefix,
} from './work-layout.js';
import {runVerify, type VerifyConfig} from './verify.js';
import {ensurePrepared} from './prepare.js';
import {
	type ReviewGate,
	type ReviewFinding,
	type ReviewVerdict,
	ReviewParseError,
	formatBlockReason,
	reviewRoundsExhaustedReason,
} from './review-gate.js';
import {type IntegrateResult, type ReviewProvider} from './integrator.js';
import {extractDecisionsBlock} from './agent-stop.js';
import {ledgerWrite} from './ledger-write.js';
import {selectProvider} from './github.js';
import type {IntegrationMode} from './config.js';
import {parseFrontmatter} from './frontmatter.js';
import {git, run, runAsync, type RunResult} from './git.js';
import {realSleep, type Sleep} from './retry-backoff.js';
import {workBranchRef} from './slug-namespace.js';
import {isAncestor} from './gc.js';
import {
	detectColocatedSidecars,
	formatSidecarGuardReason,
} from './sidecar-guard.js';

/**
 * Build the human-facing CONTEXT tail appended to an `acceptance gate failed`
 * reason — the load-bearing fix for the opaque `acceptance gate failed (exit N)`
 * bounce message (a maintainer could not tell WHICH command failed or WHY without
 * re-running the whole gate). Given the failed command + its output tail (both
 * from {@link RunVerifyResult}), it produces a compact, deterministic block:
 *
 *   - names the FAILED command (`the failing step was: \`<cmd>\``), so a
 *     multi-command gate (`build && test && format:check`) points at the culprit;
 *   - quotes the last lines of that command's output (the ACTUAL error, e.g.
 *     "no changesets were found"), so the answer surface carries real signal;
 *   - when neither is known (an older result / a prepare failure) it returns the
 *     empty string — the caller's base reason is unchanged (graceful degrade).
 *
 * PURE + seam-free (string in, string out) so it is unit-testable and reused by
 * every gate-failure site (front gate, rebased-tip fresh gate, committed
 * recovery). The output is bounded by {@link RunVerifyResult.outputTail}'s own
 * cap, so it can never bloat the surfaced sidecar.
 */
export function formatGateFailureContext(params: {
	failedCommand?: string;
	outputTail?: string;
}): string {
	const {failedCommand, outputTail} = params;
	const parts: string[] = [];
	if (failedCommand !== undefined && failedCommand.trim() !== '') {
		parts.push(`the failing step was: \`${failedCommand.trim()}\``);
	}
	if (outputTail !== undefined && outputTail.trim() !== '') {
		parts.push(`its last output was:\n\n${outputTail.trimEnd()}`);
	}
	if (parts.length === 0) {
		return '';
	}
	return ` — ${parts.join('; ')}`;
}

/**
 * **The shared gate→integrate BACK-HALF** of the per-item pipeline, extracted out
 * of `performComplete` (`complete.ts`) so BOTH the human `do`/`complete` path and
 * (a later task) the autonomous `run` path share ONE implementation of the
 * gate→integrate band. The exact ORDER depends on the fresh-worktree gate
 * (`freshWorktreeGate`, task `gate-on-rebased-tip-fresh-worktree`):
 *
 *   - fresh gate OFF (the pre-rebase gate, today byte-for-byte):
 *       verify (cwd) → review (cwd) → effective-mode decision → done-move →
 *       atomic commit → rebase-onto-arbiter → integrate.
 *   - fresh gate ON (the default; gate the tree that MERGES):
 *       done-move → atomic commit → rebase-onto-arbiter → verify (rebased tip) →
 *       review (rebased tip) → effective-mode decision → integrate.
 *
 * Either way `verify` is the deterministic FLOOR and runs FIRST, with the Gate-2
 * REVIEW (judgement) layered ON TOP and only on `verify`'s green — and (ON path,
 * MAINTAINER DECISION 2) BOTH run on the SAME rebased tip (the tree that actually
 * integrates), so verify-then-review holds on the merged tree, never split across
 * two trees. Any failure routes to needs-attention.
 *
 * It is the CORE in the head / core / tail decomposition (spec
 * `work/specs/tasked/run-do-integrate-convergence.md`): the caller-specific HEAD
 * (repo/arbiter/branch checks, source resolution, the `recovering` flag) and TAIL
 * (switch-to-main / `syncLocalMain` / delete-local-branch / `--no-switch` / the
 * propose next-step block, or — for `run` — the job-record + worktree reap) stay
 * in their respective callers; this is the band they share.
 *
 * It returns DATA ({@link IntegrationCoreResult}) and performs the needs-attention
 * ROUTING and the effective-mode DECISION — but NO caller-specific side effects
 * (no `git switch main`, no branch delete, no job record, no propose next-step
 * block). The human-vs-autonomous difference rides entirely on the {@link
 * IntegrationCoreInput.surfaceArbiter} field (human = unset ⇒ local-only routing;
 * autonomous = set ⇒ surface-on-main + push-branch routing) — DATA, never a
 * caller-identity flag.
 *
 * The band below was extracted (a pure refactor) from `performComplete`. A
 * resolved `merge` ALWAYS lands on a green gate (and, with review on, an
 * `approve`); `propose` always leaves the merge to a human. There is no
 * `merge`→`propose` downgrade — `merge` IS the auto-land mode. The effective
 * mode the core resolved is carried in {@link IntegrationCoreResult.integration}'s
 * `mode`; the tail reads it from there, NEVER from the requested mode.
 */

/**
 * The outcome the core resolved. These already match `complete`'s
 * `CompleteOutcome` subset the core can produce — the tail maps them 1:1 (it adds
 * only `refused`/`usage-error`, which are HEAD concerns the core never reaches).
 */
export type IntegrationCoreOutcome =
	| 'completed' // gated, reviewed, moved, committed, rebased, integrated
	| 'prepare-failed' // the env-prep step (prepare) was red — env not ready, verify untrusted
	| 'gate-failed' // the acceptance gate (verify) was red (and not skipped)
	| 'review-blocked' // Gate 2 (PR/code review) returned `block` (or exhausted rounds)
	| 'review-unparseable' // Gate 2 ran but its verdict JSON could not be parsed (malformed output) — work-preserving route, transient-infra cause (NOT a reviewer block)
	| 'rebase-conflict' // rebase onto arbiter/main conflicted (aborted; human resolves)
	| 'sidecar-violation' // a co-located <slug>/ sidecar sits beside a flowing task/spec item (WORK-CONTRACT rule 8) — HARD BLOCK before the durable move
	| 'invariant-violation' // one-slug-one-folder would break (slug in two folders on the arbiter)
	| 'already-integrated'; // committed-recovery: the kept tip is already on <arbiter>/main (clean no-op)

/**
 * The CORE's input — everything the band needs, nothing caller-shaped. Every
 * divergence between the human `complete` path and the autonomous `do`/`run` path
 * maps to a FIELD VALUE here, not an `if (caller === …)` branch (spec: "zero
 * caller-identity leakage"). In-place vs worktree = `cwd`; arbiter name =
 * `arbiter`; human vs autonomous surfacing = `surfaceArbiter`; do's recovery =
 * `source` + `recovering`; per-repo/lang gate = `verify`.
 */
/**
 * A NON-TASK lifecycle the integrate band threads in place of its default,
 * task-shaped done-move + title source. The shared band
 * (verify→review→commit→rebase→integrate→propose-PR-with-title/body) is
 * IDENTICAL; only the "which item move + which file to read the title from" step
 * is caller-supplied. This is the seam the `do spec:<slug>` TASKING transition
 * rides (task `slice-output-through-integration`): its "item move" is the spec
 * LIFECYCLE move (`work/specs/ready/<slug>.md → work/specs/tasked/<slug>.md`, residence =
 * tasked-ness) plus its EMITTED backlog files — NOT a task done-move. Supplying it
 * makes every integrate-time arg (`--propose`/`--merge`, provider, title/body)
 * apply to tasking BY CONSTRUCTION, because they resolve ONCE here.
 *
 * When set, the band: (1) reads the PR title / default commit summary from
 * {@link titlePath} instead of `work/<source>/<slug>.md`; (2) calls {@link stage}
 * (runner-owned, on the work branch) instead of the task `git mv → work/done/`;
 * and (3) uses the PLAIN rebase (a tasking transition never `recover`s a
 * surfaced needs-attention move). Everything else — the `git add -A` that sweeps
 * the agent's uncommitted work + the staged lifecycle move, the atomic commit,
 * the rebase, the integrate, and the propose-mode PR title/body — is shared.
 */
export interface IntegrationLifecycle {
	/**
	 * Absolute path to the item file whose `title:` frontmatter seeds the default
	 * commit summary AND the synthesised propose-mode PR title. For the tasking
	 * transition this is the held spec (`work/specs/ready/<slug>.md`) — read BEFORE
	 * {@link stage} moves it. IGNORED when {@link title} is supplied (the explicit
	 * title wins — no file read).
	 */
	titlePath: string;
	/**
	 * The drafted item TITLE, supplied EXPLICITLY (no file read). When set, the band
	 * uses THIS as the title source for the default commit summary AND the synthesised
	 * propose-mode PR title, INSTEAD of reading {@link titlePath}. This is the seam for
	 * a lifecycle whose output file does NOT yet exist at title-read time — the intake
	 * lone-task / spec path WRITES `work/backlog/<slug>.md` / `work/specs/ready/<slug>.md` in
	 * {@link stage}, which runs AFTER the title read, so a `titlePath` read would race
	 * the write and fall back to a generic subject. The `do spec:` tasking transition
	 * leaves this unset (its `titlePath` is an already-existing held spec, read fine).
	 */
	title?: string;
	/**
	 * STAGE the lifecycle move + emitted files into the index on the current work
	 * branch (runner-owned git; the agent never does git). For the tasking
	 * transition: `git mv work/specs/ready/<slug>.md → work/specs/tasked/<slug>.md`
	 * (residence = tasked-ness; no marker), and write+`git add` the produced
	 * `work/backlog/*.md` files. The band's subsequent `git add -A` + atomic commit
	 * folds this staging
	 * AND the agent's uncommitted backlog writes into ONE runner-owned commit. May
	 * be async (it shells git).
	 */
	stage(): Promise<void> | void;
	/**
	 * The trailing transition tag on the runner-owned commit subject
	 * (`<type>(<slug>): <summary>; <commitTag>`). Defaults to `done` (the build
	 * lifecycle); the tasking transition supplies `tasked`. Cosmetic — it names
	 * WHICH lifecycle landed; it gates nothing.
	 */
	commitTag?: string;
}

/**
 * The default LIVENESS CEILING for the merge-mode `${branch}:main` push (the
 * durable promotions `tasks/ready → tasks/done` and, via `lifecycle`, `specs/ready
 * → specs/tasked`). Task `c2-rebase-until-real-on-durable-main-promotions` turned
 * the previous SMALL FIXED CAP (was 5, the `run-fleet-claim-integrate-and-sibling-
 * rebase-concurrency-safe` Race-1 budget) into rebase-until-real-conflict: a CLEAN
 * re-rebase no longer counts against a tiny give-up budget — only a GENUINE
 * conflict surfaced by {@link rebaseOntoMainWithReconcile} stops the loop (the
 * step-4 rebase IS the source-folder precondition recheck for the slug-relocation
 * family: if the slug is GONE from its expected source folder on the new `main`,
 * the `git mv` replay fails and `rebaseConflictRoute` routes definitively — never a
 * silent re-push that would clobber a concurrent legitimate same-item winner).
 *
 * The cap survives only as a LARGE liveness ceiling that bounds the pathological
 * livelock tail (a sustained-parallel-load hot ref where the loser's round-trip is
 * always beaten by another winner — classic CAS livelock). Combined with the
 * modest jitter on the refetch below it desynchronises the herd, so a route-to-
 * needs-attention from this loop becomes a RARE livelock signal rather than the
 * ROUTINE false-contention signal it was at the old cap of 5.
 *
 * SCOPE (`work/notes/ideas/ledger-lock-evolution-per-item-ref-vs-rebase-until-real-
 * conflict.md` `### C2` SCOPE box, repeated here because over-applying C2 is the
 * one near-fatal mistake): the durable promotions are slug RELOCATIONS, not the
 * same-path / append family. They MUST keep their source-folder precondition
 * recheck — reused here verbatim as `rebaseOntoMainWithReconcile`'s rebase replay
 * + arbiter ledger-placement read. Do NOT add a new conflict-detection path; the
 * existing one IS the genuine-conflict terminator.
 *
 * Tests inject a small `mergeRetries` (or `0`) to exercise the old un-retried /
 * cap-exhausted route deterministically — that test seam is preserved.
 */
const DEFAULT_MERGE_RETRIES = 1000;

/**
 * Default modest jitter (ms) on the refetch between merge-push retries — load-
 * bearing under sustained parallel load: an instant lockstep refetch→re-push loop
 * maximises mutual rejection (a thundering herd), fattening the livelock tail.
 * Modest randomisation desynchronises the herd. Each attempt sleeps a UNIFORMLY-
 * random integer in `[0, DEFAULT_MERGE_JITTER_MS]` ms. Small enough (≤25ms) that
 * the additional latency under realistic contention is negligible vs the
 * round-trip cost of a rebase+push, and small enough that the in-tree concurrency
 * tests are not slowed measurably. Tests override via `mergeJitterMs: 0`.
 */
const DEFAULT_MERGE_JITTER_MS = 25;

/**
 * Promise-based sleep, used for the {@link DEFAULT_MERGE_JITTER_MS} merge-push
 * retry jitter (C2). Internal — the legacy non-seamed sleep this module uses
 * for the C2 jitter (kept for byte-for-byte compatibility with existing tests).
 * The recovery-rebase loop uses the INJECTABLE {@link Sleep} seam from
 * `retry-backoff.ts` instead, so its timeline is test-driveable.
 */
function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * **Default cap on RE-FETCH+RE-REBASE attempts** in the committed-recovery tail
 * (`recoverAlreadyCommitted`, task `recovery-rebase-retry-against-moving-arbiter
 * -main`). The recovery's single fetch-then-rebase is a CONTENTION race against a
 * concurrently-MOVING `<arbiter>/main` (a sibling `advance` run lands a burst of
 * `advance: surface observation:…` commits); a one-shot rebase against a stale
 * fetched base can conflict against a main that already moved AGAIN, surfacing a
 * purely transient race as `rebase-conflict`. So the rebase is wrapped in a small
 * bounded CONTENTION loop: re-fetch `<arbiter>/main` (it may have advanced) +
 * re-rebase; on clean → integrate; on conflict → `--abort`, a small jitter sleep,
 * try again. The cap stops the loop ONLY when every fresh-fetched attempt still
 * conflicts (a genuinely persistent conflict ⇒ route to needs-attention exactly
 * as today). Small on purpose — a few attempts ride out a `advance` burst (each
 * burst is tens of commits over a few seconds); a real conflict surfaces fast.
 *
 * This is the CONTENTION model (instant re-fetch+rebuild, like `claim-cas.ts`
 * and the Race-1 merge loop above), NOT the OUTAGE model in
 * {@link file://./retry-backoff.ts} (exponential temporal backoff, the remote
 * may come back). The two failure classes are deliberately kept SEPARATE; do not
 * substitute `retryWithBackoff` here.
 *
 * Tests inject `recoveryRebaseRetries: 0` (no retry — the legacy one-shot shape)
 * or a small explicit cap (assert the cap exhausts deterministically).
 */
const DEFAULT_RECOVERY_REBASE_RETRIES = 4;

/**
 * **Default max jitter (ms)** between recovery-rebase attempts — a SMALL
 * livelock-breaking SPREAD between concurrent runners (NOT exponential outage
 * backoff). Pure instant retry has a real hazard: two runners that begin
 * retrying at the same instant re-fetch and re-rebase in LOCKSTEP, each moving
 * the base the other just rebased onto, and can livelock. A uniformly-random
 * `[0, mergeJitterMs]` ms sleep before each re-attempt de-correlates the two
 * racers. Bounded and tiny — a contention nudge, not an outage wait. Tests pass
 * `recoveryRebaseJitterMs: 0` for a deterministic latency-free loop, OR inject
 * the `sleep`/`random` seams to drive the timeline reproducibly with a seeded RNG.
 */
const DEFAULT_RECOVERY_REBASE_JITTER_MS = 100;

export interface IntegrationCoreInput {
	/** The working clone/checkout (in-place) OR worktree dir the work branch lives in. */
	cwd: string;
	/** Name of the arbiter git remote (valid in `cwd`). */
	arbiter: string;
	/** The slug being integrated (its work branch is `work/<type>-<slug>`). */
	slug: string;
	/**
	 * The work BRANCH being integrated. The caller is ALWAYS on it (the agent
	 * built there / the lifecycle stage wrote there), so it carries the namespaced
	 * `work/<type>-<slug>` identity. When omitted, the core derives it from the
	 * branch HEAD is on (the robust default — the type is encoded IN the name). A
	 * caller that knows the type explicitly may pass it (e.g. the tasking path
	 * passes its `work/specs/ready-<slug>`).
	 */
	branch?: string;
	/**
	 * Which folder the item is being completed FROM: `tasks-ready` (the normal,
	 * freshly-built path — since claim no longer moves the body, a freshly-built
	 * task RESTS in the pool on `main`, task
	 * `cutover-claim-body-stays-and-complete-sources-from-backlog`),
	 * `tasks-backlog` (the `--allow-backlog` staged-drive path, spec
	 * `do-allow-backlog-drive-staged-tasks-without-promotion`: a human drove a
	 * STAGED task in place, so the done-move goes `tasks/backlog/ → tasks/done/`
	 * DIRECTLY — the explicit drive IS the promotion, never bouncing through the
	 * pool), `needs-attention` (the runner-owned recovery path), or `done` (the
	 * CONTINUE-BUILD path, task `complete-builds-on-already-done-moved-continue`).
	 * The HEAD resolved this; the core uses it for the done-move source folder and
	 * the recovery rebase. IGNORED when {@link lifecycle} is set (a non-task move).
	 * (`in-progress` is RETAINED in the union for the bounce/recovery surfaces that
	 * may still source from `in-progress/` until its folder removal, 9c.)
	 *
	 * `done` — the continue-build lifecycle state: a CONTINUE on a kept work
	 * branch whose `<slug>.md` is ALREADY in `work/done/` (a prior attempt moved
	 * it there), and THIS run produced NEW uncommitted source edits. The slug is
	 * already in `done/` ⇒ the step-2 `git mv` is SKIPPED (there is nothing to
	 * move), and the originTrust read + the divergent-done-move reconciliation
	 * are EXEMPTED (there is no first-time move on this commit — the prior
	 * attempt already went through the checkpoint, and the local + arbiter both
	 * already hold the slug in `done/` so there is nothing to reconcile). The
	 * build path still runs prepare → gate → `git add -A` → commit → rebase →
	 * integrate on the NEW work so it lands as a continuation commit on top of
	 * the kept (already-done-moved) tip. Mutually exclusive with
	 * {@link committedRecovery} (the clean-strand fast-path — `complete.ts`
	 * resolves `done` only when the working tree is DIRTY, and
	 * {@link committedRecovery} only when it is CLEAN; they cannot both be set
	 * for the same call). See `docs/adr/continue-build-already-done-moved.md`.
	 */
	// `needs-attention` was a recovery source in the legacy folder model; it is
	// gone (task `finish-needs-attention-folder-cutover-remove-legacy-recovery-readers`).
	// The retired folder is no longer written, so a recovery `complete` sources
	// from `tasks-ready` (the pool position, where claim now leaves the body)
	// like a normal build.
	source: 'tasks-ready' | 'tasks-backlog' | 'in-progress' | 'done';
	/**
	 * Vestigial: was `true` when completing FROM the retired `needs-attention/`
	 * folder (a recovery finish under the legacy folder model). The per-item-lock cutover
	 * (`cutover-needs-attention-becomes-lock-stuck-recovery-surface`) retired
	 * that folder — a stuck item is now the lock `state: stuck` and the body
	 * stays in `tasks/ready/`, so a recovery `complete` is structurally a normal
	 * build. EVERY caller now passes `false`; the field is preserved on the input
	 * type only so callers compile unchanged — every branch that read it has been
	 * deleted (the `if (recovering)` re-gate paths). A future cross-caller change
	 * can remove the field; out of this task's scope.
	 */
	recovering: boolean;
	/**
	 * **RECOVER an already-committed, already-done-moved STRANDED branch** (spec
	 * `ledger-integrity` story 6, the `finish-already-committed-branch` task). When
	 * `true`, the work is ALREADY committed on the work branch with the task already
	 * `git mv`'d into `work/done/` (a terminal push failed AFTER steps 2–3, leaving
	 * the green work stranded). So the core SKIPS steps 0–3 (prepare / gate / review /
	 * done-move / commit — they already ran) and runs ONLY the rebase→integrate TAIL
	 * (steps 4–5) from the kept commit, reusing the SAME
	 * `ledgerWrite.applyCompleteTransition` integrate primitive — no rebuild, no
	 * orphan branch.
	 *
	 * The detection is UNSPOOFABLE: before acting the core verifies the work-branch
	 * tip is genuinely AHEAD of `<arbiter>/main` (`isAncestor`, the SAME reachability
	 * predicate `gc.ts` uses). A tip ALREADY reachable on `<arbiter>/main` is
	 * already-integrated → a clean `already-integrated` no-op, NEVER a re-push /
	 * double-integrate. Mutually exclusive with `recovering` and `lifecycle` (both
	 * presuppose an un-committed source state this path has moved past); when set
	 * they are ignored.
	 */
	committedRecovery?: boolean;
	/**
	 * The declared per-repo ENV-PREP step (string | list), run ONCE before the
	 * FIRST `verify` on a fresh worktree to make the env ready (install deps,
	 * submodules, codegen). Unset ⇒ a no-op (NO default install — the deliberate
	 * difference from `verify`). Sequenced BEFORE `verify`; a failing prepare
	 * surfaces as `prepare-failed` and NEVER proceeds to `verify`/integrate. Skip
	 * is gated by a NON-COMMITTED prepared-ness marker in the worktree's git
	 * control area (`prepare.ts`), so it does not re-install per gate within one
	 * worktree. Honoured on the build paths (`do`/`run` fresh worktrees) +
	 * `complete`; the standalone `dorfl verify` CLI does NOT run it (the
	 * pure gate — a human prepares their own checkout).
	 */
	prepare?: VerifyConfig;
	/** The declared per-repo gate (string | list). Unset ⇒ the default command. */
	verify?: VerifyConfig;
	/**
	 * **The fresh-worktree gate toggle** (config `freshWorktreeGate`, ON by
	 * default). When `true`, the acceptance gate (`prepare` then `verify`) runs in
	 * a CLEAN throwaway worktree cut from the work branch REBASED onto the latest
	 * `<arbiter>/main` (the would-be-integrated tip) — so a green gate provably
	 * describes the MERGED artifact: gitignored/uncommitted state in this `cwd`
	 * cannot leak in (the worktree is cut from the committed, rebased tip), and a
	 * change the integration rebase introduces IS gated. The band then does the
	 * done-move + commit, rebases, runs the gate in the fresh worktree, reaps it,
	 * and only on green integrates. When `false` (or unset ⇒ treated as the
	 * caller's default; the CLI resolves the default to `true`), `prepare`+`verify`
	 * run in THIS `cwd` BEFORE the done-move exactly as before (the pre-rebase
	 * gate), byte-for-byte. The band simply HONOURS this boolean (caller-agnostic);
	 * the `run`-fleet downgrade at `perRepoMax > 1` lives in the `run` caller, NOT
	 * here. A `--skip-verify` skips the gate ENTIRELY regardless of this flag.
	 */
	freshWorktreeGate?: boolean;
	/** Skip the acceptance gate (human-only escape hatch; never used unattended). */
	skipVerify?: boolean;
	/** Run Gate 2 (the PR/code review gate) after the green `verify`. Default OFF. */
	review?: boolean;
	/** The review-gate SEAM (injectable). Required when `review` is on. */
	reviewGate?: ReviewGate;
	/** The model the REVIEW agent runs on (de-correlated from the builder). */
	reviewModel?: string;
	/** Bound the revise↔review loop (Gate 2). Defaults to 2. */
	reviewMaxRounds?: number;
	/** Integration mode the caller REQUESTED (`propose` default, or `merge`). */
	mode: IntegrationMode;
	/**
	 * **The UNTRUSTED-ORIGIN build-propose rule** (task
	 * `untrusted-origin-forces-build-propose`). When `true`, the operator EXPLICITLY
	 * passed `--merge` on this invocation — which OVERRIDES the untrusted-origin
	 * `propose` default (the operator is present; CLI always wins, no special
	 * force-key). The autonomous/CI build path passes no flag ⇒ leaves this unset ⇒
	 * an untrusted-origin task reliably forces `propose`. Resolved entirely from the
	 * task's stamped `originTrust:` frontmatter (read HERE from the build source
	 * file); a `trusted`/unset task is config-as-is (ZERO behaviour change). This
	 * rule touches the task BUILD transition ONLY: it never fires when
	 * {@link lifecycle} is set (the tasking/intake-emit transitions — a file landing
	 * on main is inert) nor on {@link committedRecovery} (already gated + moved).
	 */
	explicitMerge?: boolean;
	/**
	 * **The PR-INTENT axis** (config `noPR`, ADR §6). When `true` on the `propose`
	 * path, the branch is pushed (the safety-bearing step) but NO review request is
	 * opened (the explicit suppress-PR intent that re-homes the old `provider: none`
	 * use) — no warning, the no-PR outcome is intended. It does NOT pick a provider
	 * (`selectProvider` stays purely arbiter-derived); it is an intent LAYERED on
	 * top. Ignored in `merge` mode (it never opens a PR) and when `providerInstance`
	 * is injected (the test/embedding seam decides its own provider). Unset/false ⇒
	 * propose opens the PR via the arbiter-derived provider as normal.
	 */
	noPR?: boolean;
	/**
	 * Optional FULLY-FORMED review provider to use VERBATIM (highest precedence,
	 * above `openPr` and the arbiter-derived selection). The `run` path injects a
	 * stubbed `GitHubProvider` here in tests (a custom `gh` binary path) to drive
	 * the full propose pipeline incl. title/body/url — which the lossy `openPr`
	 * bridge cannot carry. Unset by `do`/`complete` (they use the arbiter-derived
	 * selection / `openPr`), so their behaviour is unchanged.
	 */
	providerInstance?: ReviewProvider;
	/** Optional injectable PR opener (legacy bridge); used in `propose` mode. */
	openPr?: (opts: {
		cwd: string;
		branch: string;
		env?: NodeJS.ProcessEnv;
	}) => void;
	/**
	 * Optional review-request BODY (propose mode) — advisory prose. The runner
	 * scaffolds a deterministic header (a pointer to `work/done/<slug>.md`) above
	 * it. Absent ⇒ today's `gh pr create --fill` (no regression).
	 */
	body?: string;
	/** Conventional-commit type for the completion commit. Defaults to `feat`. */
	type?: string;
	/** Commit summary. Defaults to the task `title` minus a leading `slug — `. */
	message?: string;
	/**
	 * Surface a needs-attention bounce ON THE ARBITER (the AUTONOMOUS variant). When
	 * set, the failure routings (`gate-failed` / `review-blocked` / `rebase-conflict`)
	 * pass this arbiter remote into the ledger write seam's
	 * `applyNeedsAttentionTransition` (which cherry-picks the move onto `main` +
	 * pushes the branch — observable + recoverable cross-machine). Unset ⇒ the human
	 * `complete` behaviour: route LOCALLY only.
	 */
	surfaceArbiter?: string;
	/** `--watch`: tail the Gate-2 review agent's session live. Observability only. */
	watch?: boolean;
	/** Where the tailed review lines are written (defaults to stderr). */
	watchSink?: (line: string) => void;
	/** Emit ANSI colour in the tailed review lines (the caller's TTY decision). */
	color?: boolean;
	/** The HOST-ONLY sessions root the review session FILE is generated under. */
	sessionsDir?: string;
	/** Environment for child GIT/provider processes (the identity-scoped env). */
	env?: NodeJS.ProcessEnv;
	/**
	 * Optional per-repo INTEGRATE serialiser (the `run` concurrency seam, sibling
	 * of the claim lock). When set, ONLY the rebase-to-integrate TAIL (step 4
	 * fetch+rebase through step 5 integrate) runs inside `integrateLock(key, fn)`,
	 * so two concurrent SAME-repo merge jobs land on `main` one-at-a-time: the
	 * loser re-fetches + rebases onto the winner's now-advanced `<arbiter>/main`
	 * INSIDE the lock, making its `${branch}:main` a clean fast-forward (a genuine
	 * code conflict then routes ONE to needs-attention, never both-land by timing).
	 * The front-of-band `prepare`+`verify` gate and the Gate-2 review agent run
	 * OUTSIDE the lock, so same-repo jobs still gate + review CONCURRENTLY (run's
	 * parallelism is preserved). Single-job callers (`do`/`--isolated`/`--remote`/
	 * `complete`) leave it unset ⇒ the tail runs directly, byte-for-byte unchanged.
	 * Keyed per repo (see {@link integrateLockKey}), so cross-repo integration
	 * stays fully concurrent.
	 */
	integrateLock?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
	/**
	 * The key {@link integrateLock} serialises on — the repo path (the SAME key the
	 * claim lock uses), so same-repo integrations serialise while distinct repos
	 * integrate concurrently. Ignored when {@link integrateLock} is unset.
	 */
	integrateLockKey?: string;
	/**
	 * **Race-1 (claim-vs-integrate) bounded re-rebase-and-retry cap** for the
	 * merge-mode `${branch}:main` push (task
	 * `run-fleet-claim-integrate-and-sibling-rebase-concurrency-safe`). On a
	 * non-fast-forward rejection (a sibling same-repo CLAIM — under the SEPARATE
	 * claim lock — or integrate advanced `<arbiter>/main` during this job's push
	 * window) the step-4 tail RE-RUNS its rebase (reconciling sibling-ledger
	 * divergence) and RETRIES the push up to this cap. The `integrateLock` only
	 * serialises sibling INTEGRATES; a sibling CLAIM is on a DIFFERENT lock, so this
	 * retry (not the lock) is what makes claim-vs-integrate deterministic. Absent ⇒
	 * {@link DEFAULT_MERGE_RETRIES}. Tests inject a small cap (or `0` to assert the
	 * un-retried non-fast-forward route).
	 *
	 * **C2 rebase-until-real-conflict (task `c2-rebase-until-real-on-durable-main-
	 * promotions`):** the SEMANTICS changed — a CLEAN re-rebase no longer counts
	 * against a give-up budget; only a GENUINE conflict surfaced by the rebase
	 * (`rebaseConflictRoute` / `invariant-violation`) stops the loop. This value
	 * now serves as a LARGE liveness ceiling (default {@link DEFAULT_MERGE_RETRIES}
	 * = 1000) that bounds the pathological livelock tail, not as a small Race-1
	 * contention budget. The test seam is preserved: a small explicit cap (or `0`)
	 * still forces the un-retried / cap-exhausted route.
	 */
	mergeRetries?: number;
	/**
	 * Modest jitter (ms) on the refetch between merge-push retries — load-bearing
	 * under sustained parallel load (desynchronises a thundering-herd lockstep,
	 * task `c2-rebase-until-real-on-durable-main-promotions`). Each attempt sleeps
	 * a uniformly-random integer in `[0, mergeJitterMs]` ms. Defaults to
	 * {@link DEFAULT_MERGE_JITTER_MS} (25ms); tests can pass `0` for deterministic,
	 * latency-free retries.
	 */
	mergeJitterMs?: number;
	/**
	 * **Committed-recovery rebase RE-FETCH+RE-REBASE cap** (task `recovery-rebase-
	 * retry-against-moving-arbiter-main`). The recovery tail
	 * ({@link recoverAlreadyCommitted}) wraps its rebase onto `<arbiter>/main` in a
	 * bounded CONTENTION loop: on a conflicting rebase it `--abort`s, re-fetches
	 * `<arbiter>/main` (it may have advanced — `advance` runs land bursts of
	 * observation commits on main), and re-rebases, up to this cap of ADDITIONAL
	 * attempts after the first one. Only after the cap is exhausted does it return
	 * `rebase-conflict` exactly as today. Absent ⇒ {@link DEFAULT_RECOVERY_REBASE_
	 * RETRIES}. Tests inject `0` for the legacy one-shot shape, or a small explicit
	 * cap to assert the cap-exhausted route.
	 */
	recoveryRebaseRetries?: number;
	/**
	 * **Committed-recovery rebase JITTER (max ms)** between attempts — a SMALL
	 * livelock-breaking SPREAD, NOT exponential outage backoff. Each post-conflict
	 * sleep is a uniformly-random integer in `[0, recoveryRebaseJitterMs]` ms
	 * (drawn via the injectable {@link recoveryRebaseRandom}). Defaults to
	 * {@link DEFAULT_RECOVERY_REBASE_JITTER_MS}; tests pass `0` for a deterministic
	 * zero-delay schedule.
	 */
	recoveryRebaseJitterMs?: number;
	/**
	 * **Injectable sleep seam** for the committed-recovery rebase retry loop —
	 * reuses the {@link Sleep} type from `retry-backoff.ts` (the same seam
	 * `run.ts` / `needs-attention.ts` use). Defaults to {@link realSleep}; tests
	 * inject a capturing zero-sleep to assert the per-attempt delay schedule and to
	 * drive a moving-base scenario between attempts.
	 */
	recoveryRebaseSleep?: Sleep;
	/**
	 * **Injectable RNG** for the recovery-rebase jitter — `() => number` returning
	 * `[0, 1)` (same shape as `Math.random`). Defaults to `Math.random`; tests
	 * inject a seeded RNG (or a fixed constant) so the captured jitter timeline is
	 * reproducible.
	 */
	recoveryRebaseRandom?: () => number;
	/**
	 * Environment for the REVIEW-AGENT launch (Gate 2). Distinct from {@link env}
	 * because the review agent is an AGENT — it must NOT carry the runner identity
	 * (the agent must not act/commit as the bot; only the runner's own git
	 * transitions do). The caller passes the plain AMBIENT env here when an identity
	 * is configured. Unset ⇒ falls back to {@link env} (no identity ⇒ they are the
	 * same env, so this is byte-for-byte unchanged for every non-identity caller).
	 */
	agentEnv?: NodeJS.ProcessEnv;
	/** Sink for human-readable progress notes. */
	note?: (message: string) => void;
	/**
	 * A NON-TASK lifecycle move + title source (task
	 * `slice-output-through-integration`). When set, the band reads the title from
	 * its {@link IntegrationLifecycle.titlePath}, calls its
	 * {@link IntegrationLifecycle.stage} INSTEAD of the task `git mv → work/done/`,
	 * and uses the plain rebase ({@link recovering} is irrelevant). The `do spec:`
	 * TASKING transition supplies it; `do`/`complete`/`run` leave it unset (the
	 * task done-move is unchanged).
	 */
	lifecycle?: IntegrationLifecycle;
}

/**
 * The CORE's output — pure DATA. The core performed the gate/review/move/commit/
 * rebase/integrate AND the failure routing, but NOT the caller-specific tail.
 */
export interface IntegrationCoreResult {
	/** What the core resolved (the tail maps this 1:1 onto its own outcome). */
	outcome: IntegrationCoreOutcome;
	/**
	 * True iff a FAILURE outcome was routed through the shared needs-attention
	 * mechanism — post lock-cutover, the per-item lock was amended to
	 * `state: stuck` with the reason on the lock entry (no folder move). False
	 * on the success path and when a failure was NOT surfaced (e.g. a red
	 * re-gate that stays put in recovery).
	 */
	routedToNeedsAttention: boolean;
	/** The work branch that was processed (`work/<slug>`). */
	branch: string;
	/**
	 * A human-readable summary of a FAILURE terminal condition, ready for the tail
	 * to surface VERBATIM. Absent on the success path (the tail composes the
	 * success message from the integration result + its own switch/delete state).
	 */
	reason?: string;
	/** The completion commit message that was authored, on success. */
	commitMessage?: string;
	/**
	 * The integration result — carries the resolved mode + the PR url. Present on
	 * the success path; the tail reads `integration.mode` to decide its switch/ff
	 * behaviour, NEVER the requested mode.
	 */
	integration?: IntegrateResult;
	/**
	 * On a `review-blocked` outcome, the review gate's STRUCTURED block reason (the
	 * `formatBlockReason` of the blocking findings) — so a caller doing its OWN
	 * needs-attention routing can record the findings as the item-body prose. The
	 * tasking path (task `slice-acceptance-gate`) reads this: the core's build
	 * `applyNeedsAttentionTransition` is keyed on a TASK lock, so the tasking path
	 * routes the spec itself via the lock release's needs-attention redirect (amend the
	 * `spec:<slug>` unified lock `active -> stuck`, no folder move), using THIS
	 * findings text as the body. Absent on every non-`review-blocked` outcome. (The
	 * build path ignores it — its routing already records the findings in-body.)
	 */
	reviewBlockReason?: string;
}

const DEFAULT_TYPE = 'feat';

/**
 * Run the shared gate→integrate band for a prepared (claimed, built, on-its-work-
 * branch) item. The HEAD has already resolved `cwd`/`arbiter`/`slug`/`source`/
 * `recovering`; this runs the gate, the review gate, the effective-mode decision,
 * the done-move + atomic commit + rebase + integrate, and routes ANY failure to
 * needs-attention — returning pure DATA for the caller's tail.
 *
 * It never throws for the expected gate-failed / review-blocked / rebase-conflict
 * cases (those are returned with the corresponding outcome). A genuinely
 * unexpected git plumbing failure (e.g. the done-move itself, or nothing staged)
 * throws — the caller's existing try/catch maps it.
 */
export async function performIntegration(
	input: IntegrationCoreInput,
): Promise<IntegrationCoreResult> {
	const cwd = input.cwd;
	const env = input.env;
	const arbiter = input.arbiter;
	const slug = input.slug;
	const source = input.source;
	const recovering = input.recovering;
	const note = input.note ?? (() => {});
	// The work branch: the caller is on it (it carries the namespaced identity).
	// Prefer the explicit `branch`; else read the branch HEAD is on; only fall
	// back to a synthesised `work/task-<slug>` if HEAD is detached (a degenerate
	// case that the on-branch invariant should preclude).
	const branch = input.branch ?? resolveWorkBranch(cwd, slug, env);
	// Captured from the Gate-2 review (when it runs + approves) so that AFTER the
	// propose integrate — where the opened PR url is finally in scope — we can post
	// the agent's deliberately-authored `review` prose as a PR comment (task
	// `review-comment-prose-field`). Stays undefined when review is off / the agent
	// emitted no `review` field, so the post is skipped (no-op). The verdict/routing
	// decision uses neither.
	let approvedVerdict: ReviewVerdict | undefined;
	// The resolved integration mode. `merge` lands automatically on a green gate
	// (and an `approve` when review is on); `propose` leaves the merge to a human.
	// MUTABLE because the untrusted-origin build-propose rule below may force it to
	// `propose` for a task BUILD (the build transition only) — see the rule after
	// `sourcePath` is resolved.
	let mode = input.mode;
	// The fresh-worktree gate (task `gate-on-rebased-tip-fresh-worktree`): when ON
	// the deterministic acceptance gate (`prepare`+`verify`) does NOT run here on
	// the agent's PRE-rebase `cwd`; instead it runs LATER, in a clean throwaway
	// worktree cut from the work branch REBASED onto `<arbiter>/main` (the
	// would-be-integrated tip), inside the rebase-to-integrate tail. So a green gate
	// provably describes the MERGED artifact. When OFF the front prepare+verify runs
	// here exactly as before (byte-for-byte). The band HONOURS the boolean it is
	// handed (caller-agnostic); the `run`-fleet `perRepoMax === 1` downgrade lives
	// in the `run` caller, not here.
	const freshWorktreeGate = input.freshWorktreeGate === true;

	// RECOVER an already-committed, already-done-moved STRANDED branch (spec
	// `ledger-integrity` story 6). The work + the done-move are ALREADY committed on
	// the work branch (a terminal push failed AFTER steps 2–3); SKIP steps 0–3
	// (prepare / gate / review / done-move / commit) and run ONLY the
	// rebase→integrate TAIL from the kept commit, reusing the SAME integrate
	// primitive. Returns BEFORE any of the build-path steps run.
	if (input.committedRecovery) {
		return await recoverAlreadyCommitted({
			cwd,
			arbiter,
			slug,
			branch,
			mode,
			noPR: input.noPR,
			providerInstance: input.providerInstance,
			openPr: input.openPr,
			recoveryRebaseRetries: input.recoveryRebaseRetries,
			recoveryRebaseJitterMs: input.recoveryRebaseJitterMs,
			recoveryRebaseSleep: input.recoveryRebaseSleep,
			recoveryRebaseRandom: input.recoveryRebaseRandom,
			// GATE-2 REVIEW on the recovery path (task
			// `committed-recovery-always-reviews`): a stranded already-complete
			// branch is NOT "already reviewed" — its earlier attempt's PR never
			// merged and Gate 2 may never have run on it. So when `review` is on we
			// MUST run Gate 2 on the rebased tip here too (the SAME reasoning that
			// forces the re-verify: `<arbiter>/main` moved, the merged tree is new).
			// Pass the whole `input` so the recovery tail can call `runGate2Review`
			// with the identical gate/model/watch/round wiring the build path uses.
			input,
			// PR BODY on the recovery path: the recovery has NO fresh agent output
			// (no rebuild), so carry whatever `body` the caller supplied so the PR
			// gets a description instead of degrading to a blank `gh --fill`.
			body: input.body,
			// Answered-merge land (task `committed-recovery-honours-fresh-worktree-gate`,
			// spec `land-time-reverify-and-parallel-merge-ceiling`): the apply-rung
			// dispatches an answered `merge` through this committed-recovery tail (the
			// branch already carries its done-move commit, so the build path's
			// `git mv`+`add -A`+commit would raise `IntegrationNothingStaged`). UNLIKE
			// the original stranded-recovery caller (whose pre-strand build already
			// gated), `<arbiter>/main` may have MOVED since this branch's last build,
			// so the rebased tip MUST be re-verified before it lands or the load-bearing
			// invariant ("main never receives a tree that fails verify") cannot hold on
			// the merge path. Thread the gate inputs through; recovery runs the EXISTING
			// `runFreshWorktreeGate` on the rebased tip when `freshWorktreeGate` is set
			// (and not `--skip-verify`), routing a RED gate to needs-attention via the
			// SAME seam the build path uses. With `freshWorktreeGate` unset (the
			// stranded-recovery caller), recovery is byte-identical to before — no
			// extra gate, no extra fetch.
			freshWorktreeGate,
			skipVerify: input.skipVerify,
			prepare: input.prepare,
			verify: input.verify,
			surfaceArbiter: input.surfaceArbiter,
			env,
			note,
		});
	}

	// The file whose `title:` seeds the commit summary + PR title. For a TASKING
	// transition (a non-task `lifecycle`) this is the held spec it supplies; for a
	// build it is the task in its source folder. Read BEFORE any move.
	const lifecycle = input.lifecycle;
	// CONTINUE-BUILD (`source: 'done'`, task
	// `complete-builds-on-already-done-moved-continue`): on a dirty continue whose
	// kept branch already holds the slug in `work/done/`, the file we read for the
	// title + (otherwise) untrusted-origin lives there too — not in
	// `in-progress/`/`needs-attention/`. The step-2 `git mv` is later SKIPPED for
	// this source (the slug is already in done/), and the originTrust read +
	// arbiter ledger placement/divergent-done-move reconcile are EXEMPTED below.
	const sourcePath = lifecycle
		? lifecycle.titlePath
		: source === 'done'
			? workItemPath(cwd, 'done', slug)
			: workItemPath(cwd, source, slug);

	// UNTRUSTED-ORIGIN BUILD-PROPOSE RULE (task `untrusted-origin-forces-build-propose`).
	// A task born from an UNTRUSTED issue carries `originTrust: untrusted` (stamped
	// at intake, propagated by the tasker). Its risk is the BUILD (it becomes code),
	// so the build transition resolves to `propose` even when the requested mode is
	// `merge` — moving the human checkpoint onto the becomes-code build. Precedence:
	//   explicit --merge  >  untrusted-origin ⇒ propose  >  config mode  >  default.
	// An explicit `--merge` (input.explicitMerge) OVERRIDES the rule (the operator
	// is present; CLI always wins, no special force-key). The autonomous/CI path
	// passes no flag, so there an untrusted-origin task RELIABLY forces propose.
	//
	// SCOPE: the task BUILD transition ONLY. It NEVER fires for a `lifecycle`
	// transition (tasking / intake-emit — a spec/task FILE landing on main is inert;
	// intake's OWN per-emit resolver already decided that mode), and the source file
	// here is the task being built. A `trusted`/unset task ⇒ untouched (zero
	// behaviour change for the normal human path).
	// CONTINUE-BUILD EXEMPTION (task
	// `complete-builds-on-already-done-moved-continue`): the prior attempt that
	// done-moved this task already went through the originTrust checkpoint (an
	// untrusted task on a `merge` config proposed on that first attempt). The
	// continue-build commit is layered on top of that kept tip, so re-evaluating
	// the rule here would either double-checkpoint or be a no-op against the same
	// frontmatter — exempt this state (the task file lives in `done/` and is now
	// effectively an on-`main` artifact). The other states are unchanged.
	if (
		!lifecycle &&
		source !== 'done' &&
		mode === 'merge' &&
		input.explicitMerge !== true &&
		existsSync(sourcePath) &&
		parseFrontmatter(readFileSync(sourcePath, 'utf8')).originTrust ===
			'untrusted'
	) {
		mode = 'propose';
		note(
			`Untrusted-origin task '${slug}': forcing the BUILD transition to ` +
				'propose (a human reviews the becomes-code change before it merges). ' +
				'Pass --merge to override.',
		);
	}

	// 0. Prepare: make the worktree's ENV READY before the gate (install deps,
	//    submodules, codegen). A fresh job worktree off the hub mirror has no
	//    `node_modules`, so `verify` would fail for lack of deps unless prepare
	//    runs FIRST. `prepare` is the SIBLING of `verify`, NOT baked into it: it
	//    runs ONCE before the first verify, gated by a NON-COMMITTED prepared-ness
	//    marker in the worktree's git control area (so it does not re-install per
	//    gate within one persistent worktree). Unset ⇒ a no-op (no default install).
	//    A FAILING prepare is a HARD STOP distinct from a red gate (`prepare-failed`):
	//    the env could not be made ready, so `verify` cannot be trusted — it NEVER
	//    proceeds to verify/integrate, and routes the item the SAME way a red gate
	//    does. (`--skip-verify` skips only the gate, not env-prep: a verify-skipped
	//    finish still needs a ready env; the marker keeps an already-prepared tree
	//    a no-op.)
	//
	//    FRESH-WORKTREE GATE: when ON, this front prepare+verify is SKIPPED here and
	//    runs LATER on the rebased-tip throwaway worktree (see the tail). The OFF
	//    path below is byte-for-byte today's pre-rebase gate.
	if (!freshWorktreeGate) {
		const prep = await ensurePrepared({cwd, prepare: input.prepare, env});
		if (!prep.noop && !prep.skipped) {
			note('Running the env-prep step (prepare)…');
		}
		if (!prep.passed) {
			const reason = `prepare (env-prep) failed (exit ${prep.exitCode})`;
			// Mark the item stuck on its per-item lock (the SAME seam a red gate uses)
			// — recording the prepare-failed reason on the lock entry + saving the
			// agent's uncommitted work as a wip commit (post lock-cutover: a lock amend,
			// no `in-progress/ → needs-attention/` folder move). We NEVER run `verify`
			// on an env that could not be made ready.
			const routed = await ledgerWrite.applyNeedsAttentionTransition({
				cwd,
				slug,
				reason,
				arbiter: input.surfaceArbiter,
				env,
				note,
			});
			return {
				outcome: 'prepare-failed',
				routedToNeedsAttention: routed.moved,
				branch,
				reason: routed.moved
					? `Env-prep (prepare) failed (exit ${prep.exitCode}); marked '${slug}' ` +
						'stuck on its per-item lock (the environment could not be made ready, ' +
						'so the acceptance gate was NOT run). Fix the prepare command, then ' +
						'`requeue` to release the stuck lock.'
					: `Env-prep (prepare) failed (exit ${prep.exitCode}); not completing ` +
						`'${slug}' (the environment could not be made ready, so the ` +
						'acceptance gate was NOT run). Fix the prepare command, then retry.',
			};
		}
	}

	// 1. Gate: bad work never proceeds to done. Default-on; --skip-verify is a
	//    human-only escape hatch (the autonomous runner never skips — ADR §8).
	//    FRESH-WORKTREE GATE: when ON this front gate is SKIPPED and runs LATER on
	//    the rebased-tip throwaway worktree (see the tail); the OFF branch below is
	//    byte-for-byte today's pre-rebase gate.
	if (input.skipVerify) {
		note('Skipping the acceptance gate (--skip-verify).');
	} else if (!freshWorktreeGate) {
		note('Running the acceptance gate (verify)…');
		const gate = await runVerify({cwd, verify: input.verify, env});
		if (!gate.passed) {
			// Don't leave the item dangling: mark it stuck on its per-item lock with
			// the reason (ADR §12) THROUGH the ledger write seam's needs-attention
			// transition. Post lock-cutover this is a lock amend (`state: stuck` + the
			// reason on the lock entry, no `in-progress/ → needs-attention/` folder
			// move) plus saving the agent's uncommitted work as a wip commit. No
			// partial state.
			// Enrich the surfaced reason with WHICH gate command failed + the tail of
			// its output (the actual error), so the needs-attention question is
			// actionable instead of a bare exit code.
			const reason =
				`acceptance gate failed (exit ${gate.exitCode})` +
				formatGateFailureContext({
					failedCommand: gate.failedCommand,
					outputTail: gate.outputTail,
				});
			const routed = await ledgerWrite.applyNeedsAttentionTransition({
				cwd,
				slug,
				reason,
				// Autonomous caller (`do`) passes the arbiter so the seam both SURFACES
				// the stuck state on `main` (OBSERVABLE, cross-machine visible) AND
				// pushes the `work/<slug>` branch (RECOVERABLE — a requeue-continue on
				// another machine, reading <arbiter>/work/<slug>, lands on the saved
				// wip). The human `complete` leaves it unset → no surface, no push,
				// local-only (a human is right there). One operation in one place: the
				// push lives in the seam (it is HEAD's branch — `work/<slug>` — here),
				// no bolted-on push to forget.
				arbiter: input.surfaceArbiter,
				env,
				note,
			});
			return {
				outcome: 'gate-failed',
				routedToNeedsAttention: routed.moved,
				branch,
				reason: routed.moved
					? `Acceptance gate failed (exit ${gate.exitCode}); marked '${slug}' ` +
						'stuck on its per-item lock (surfaced by status; `requeue` once ' +
						'resolved). Fix the work, or use --skip-verify to override.'
					: `Acceptance gate failed (exit ${gate.exitCode}); not completing ` +
						`'${slug}'. Fix the work, or use --skip-verify to override.`,
			};
		}
	}

	// 1b. Gate 2 — the PR/code REVIEW gate (GATES spec `work/specs/tasked/review.md`). It is a
	//     JUDGEMENT gate layered ON TOP of the deterministic `verify` floor (ADR §8)
	//     — NEVER a replacement, and ALWAYS verify-THEN-review on the SAME tree.
	//
	//     WHERE it runs depends on the fresh-worktree gate (MAINTAINER DECISION 2):
	//       - OFF: `verify` ran HERE on the pre-rebase `cwd`, so the review runs HERE
	//         too, on `cwd`, BEFORE the done-move — byte-for-byte today's order.
	//       - ON: the front `verify` was SKIPPED here and runs LATER on the rebased
	//         tip (step 4c). So the review is RELOCATED to run there too, AFTER the
	//         rebased-tip `verify` passes, inside the same fresh gate worktree — so
	//         verify-then-review holds on the SAME merged tree (the tree that lands),
	//         not split across two trees. (Letting verify move to the rebased tip
	//         while review stayed on the pre-rebase `cwd` would deliver the
	//         gate-the-merged-tree guarantee for verify but BREAK it for review,
	//         incoherent with this task's own goal.)
	//
	//     Either way the verdict routes IDENTICALLY:
	//       approve → fall through to the done-move/commit/integrate unchanged;
	//       block   → route to needs-attention via the SAME machinery the red gate
	//                 uses (`applyNeedsAttentionTransition`, surfaced on
	//                 `surfaceArbiter` for the autonomous `do` path), with the
	//                 blocking findings recorded as the reason, no integrate.
	if (input.review && !freshWorktreeGate) {
		const reviewOutcome = await runGate2Review({
			reviewCwd: cwd,
			input,
			slug,
			branch,
			cwd,
			env,
			note,
		});
		if (reviewOutcome.kind === 'blocked') {
			return reviewOutcome.result;
		}
		// approve: carry the verdict (post-integrate PR comment) and write the per-run
		// non-blocking-nits observation INTO `cwd` BEFORE the done-move + atomic commit
		// (so it is swept into that SAME done-commit). A resolved `merge` then lands
		// automatically (`merge` IS the auto-land mode); `propose` leaves it to a human.
		approvedVerdict = reviewOutcome.verdict;
		writeReviewNitsObservation({
			cwd,
			slug,
			findings: reviewOutcome.verdict?.findings ?? [],
			note,
		});
	}

	// 1c. CO-LOCATED SIDECAR GUARD (WORK-CONTRACT.md rule 8). A `<slug>/` asset
	//     sidecar co-located with a FLOWING task/spec item strands on the
	//     `ready → done` / `ready → tasked` `git mv` (the `<slug>.md` moves, the
	//     `<slug>/` folder is left behind — one item split across two status folders,
	//     the SAME one-slug-one-folder invariant `ledger-lint`/the integration core
	//     enforce). So this is a HARD BLOCK at LAND, BEFORE the durable move: a
	//     detected sidecar routes the item to needs-attention via the SAME
	//     `applyNeedsAttentionTransition` seam the red gate / review block use, with
	//     an ACTIONABLE relocate-to-`docs/spikes/<slug>/` reason. A `notes/*` sidecar
	//     is NOT scanned (notes do not flow), and the `work/questions/*`
	//     status-mechanism file is not an item sidecar — so neither false-positives.
	//     Runs for BOTH the build and the tasking (`lifecycle`) transitions: either
	//     way a flowing item is about to be `git mv`'d and would strand a sidecar.
	//     ROUTING: the BUILD path routes here (the task lock the `applyNeedsAttention
	//     Transition` seam keys on — `task:<slug>` — is the one `claim` holds); the
	//     TASKING (`lifecycle`) path does its OWN spec-lock routing in `tasking.ts`
	//     from `reviewBlockReason` (exactly as the review-blocked tasking path does),
	//     so here it only RETURNS the reason without touching a `task:` lock that a
	//     tasking run never held.
	const colocatedSidecars = detectColocatedSidecars(cwd, slug);
	if (colocatedSidecars.length > 0) {
		const reason = formatSidecarGuardReason(colocatedSidecars);
		if (lifecycle) {
			return {
				outcome: 'sidecar-violation',
				routedToNeedsAttention: false,
				branch,
				reason:
					`Co-located sidecar detected for '${slug}'; not completing the ` +
					`transition. ${reason}`,
				reviewBlockReason: reason,
			};
		}
		const routed = await ledgerWrite.applyNeedsAttentionTransition({
			cwd,
			slug,
			reason,
			arbiter: input.surfaceArbiter,
			env,
			note,
		});
		return {
			outcome: 'sidecar-violation',
			routedToNeedsAttention: routed.moved,
			branch,
			reason: routed.moved
				? `Co-located task/spec sidecar detected for '${slug}'; marked it stuck ` +
					`on its per-item lock (a flowing item's <slug>/ sidecar strands on ` +
					`the durable move). ${reason}`
				: `Co-located task/spec sidecar detected for '${slug}'; not completing ` +
					`it. ${reason}`,
			reviewBlockReason: reason,
		};
	}

	// Read the title now, BEFORE the move, for the default commit summary AND the
	// synthesised propose-mode PR TITLE (the source file is about to be git-mv'd
	// away). The PR title is a SINGLE, capped line built runner-side from the
	// task's `title:` frontmatter + the slug (`<type>(<slug>): <title>`) so it can
	// never be the multi-line commit-subject run-on `--fill` would derive.
	//
	// When the lifecycle supplies an EXPLICIT `title`, use it DIRECTLY (no file read):
	// the intake lone-task / spec path writes its output file in `stage()`, which runs
	// AFTER this point, so a `titlePath` read would race the write and degrade the
	// subject/PR title to the generic fallback. The `do spec:` tasking path leaves
	// `title` unset and keeps reading its already-existing held spec (unchanged).
	const explicitTitle = lifecycle?.title;
	const taskTitle =
		explicitTitle !== undefined ? explicitTitle : readTaskTitle(sourcePath);
	const defaultMessage =
		explicitTitle !== undefined
			? summaryFromTitle(explicitTitle, slug)
			: defaultSummary(sourcePath, slug);
	const prTitle = synthesiseProposeTitle({
		type: (input.type ?? DEFAULT_TYPE).trim() || DEFAULT_TYPE,
		slug,
		title: taskTitle,
	});

	// 2. STAGE the item move into the index. For a build that is the task done-move
	//    (`work/<source>/<slug>.md → work/done/<slug>.md`); for a TASKING
	//    transition (a non-task `lifecycle`) it is the caller-supplied spec
	//    lifecycle move + emitted backlog files (the runner stages them, the agent
	//    never does git). Either way the subsequent `git add -A` folds the agent's
	//    uncommitted work + this staging into ONE atomic commit.
	//
	//    The task done-move is ATOMIC AGAINST THE ARBITER (ledger-integrity
	//    defect 1 + its root defect 2). The LOCAL move here is the legacy clean
	//    `git mv work/<source>/<slug>.md → work/done/<slug>.md` (one folder, no
	//    fetch — every existing path is byte-for-byte unchanged); the ARBITER
	//    resolution + the one-slug-one-folder enforcement happen AFTER the rebase
	//    (step 4b, `reconcileDoneMoveAgainstArbiter`), against the freshly-fetched
	//    `<arbiter>/main`. That ordering is deliberate: a NEW fetch in THIS step
	//    would race a sibling job's integration on the SHARED bare-mirror refs (the
	//    very regression that orphaned this work, ADR §2), so we reuse the existing
	//    step-4 fetch's result instead. The reconciliation REMOVES any divergent
	//    `in-progress/`/`needs-attention/` ghost the merge would otherwise leave (so
	//    the move is a MOVE, not a COPY) and FAILS LOUD if the arbiter holds the slug
	//    in two folders with differing content.
	if (lifecycle) {
		await lifecycle.stage();
	} else if (source === 'done') {
		// CONTINUE-BUILD (`source: 'done'`, task
		// `complete-builds-on-already-done-moved-continue`): the slug is ALREADY in
		// `work/done/` on this kept branch (a prior attempt moved it there), so there
		// is NOTHING to move — skip the step-2 `git mv`. The subsequent `git add -A`
		// folds the agent's NEW uncommitted source edits into the atomic commit on
		// top of the kept (already-done-moved) tip; no second move, no copy.
	} else {
		mkdirSync(workFolderPath(cwd, 'done'), {recursive: true});
		await gitHard(
			[
				'mv',
				workItemRel(source, `${slug}.md`),
				workItemRel('done', `${slug}.md`),
			],
			cwd,
			env,
		);
	}

	// 2b. TRANSCRIBE the agent's `## Decisions` block into the DONE RECORD (the
	//     builder's rationale channel, WORK-CONTRACT "Where a BUILDER's RATIONALE
	//     lives"). The builder does NO git and MUST NOT edit the task body, and the
	//     done-move is ours, so "record your rationale in the done record" is an
	//     instruction it CANNOT obey directly. It emits a `## Decisions` block on the
	//     one surface it owns (its final report, reaching us as `input.body`), and we
	//     append it here: AFTER the move (so we write the record at its DONE path) and
	//     BEFORE the `git add -A` below (so it rides the SAME atomic completion commit,
	//     not a second one). Skipped for a TASKING transition (`lifecycle`), which
	//     lands a spec: no done record, and no building agent.
	if (!lifecycle) {
		transcribeDecisionsIntoDoneRecord({cwd, slug, output: input.body, note});
	}

	// 3. Commit: git add -A (the agent's uncommitted work + the move) into ONE
	//    atomic commit. Nothing to commit is FATAL (no-op-is-fatal, like claim.sh).
	await gitHard(['add', '-A'], cwd, env);
	if (await nothingStaged(cwd, env)) {
		throw new IntegrationNothingStaged(
			`nothing to commit for '${slug}' — no work and no move staged. ` +
				'(Did the agent produce changes? Is the task already done?)',
			slug,
		);
	}
	// SCOOP + REPORT agent-authored CAPTURED NOTES (task `runner-scoops-captured-notes`,
	// advance-loop's reporting-channel fold-in). A rung's agent may write capture-bucket
	// files (`work/notes/observations/*`, `work/findings/*`) during its run — its `capture-signal`
	// reflex — but it does NO git (Rule A). The `git add -A` above already SWEEPS them into
	// THIS one runner-owned commit (the same way the review-nits observation rides it), so
	// they are TRACKED, not dropped/untracked. Rule B is extended HERE: the runner REPORTS
	// exactly which note files landed (honest reporting — what actually reached the commit,
	// read from the staged set, not assumed). This is the ONE shared place — BOTH the build
	// path (`do <task>`/`run`/`complete`) and the tasking path (`do spec:`, via the
	// `lifecycle` seam) route through it, so the channel is NOT forked. Zero notes ⇒ no
	// report (the no-note case is byte-for-byte unchanged).
	await reportScoopedNotes(cwd, env, note);
	const summary = input.message ?? defaultMessage;
	const type = (input.type ?? DEFAULT_TYPE).trim() || DEFAULT_TYPE;
	// The trailing transition tag: a build is `; done`, a TASKING transition is
	// `; tasked` (the lifecycle supplies it). Keeps the runner-owned commit subject
	// honest about WHICH lifecycle landed.
	const commitMessage = `${type}(${slug}): ${summary}; ${lifecycle?.commitTag ?? 'done'}`;
	await gitHard(['commit', '-q', '-m', commitMessage], cwd, env);
	note(`Committed: ${commitMessage}`);

	// The rebase-to-integrate TAIL (step 4 fetch+rebase → step 5 integrate) is the
	// ONLY region serialised per repo under the `run` concurrency seam: it is the
	// land-on-`main` band where two concurrent SAME-repo merge jobs would otherwise
	// race (the loser pushing a non-fast-forward `${branch}:main`). Wrapping ONLY
	// this tail keeps the front-of-band gate (`prepare`+`verify`) and the Gate-2
	// review agent CONCURRENT across same-repo jobs (run's parallelism); inside the
	// lock the loser re-fetches + rebases onto the winner's now-advanced main, so
	// its push is a clean fast-forward (a genuine conflict routes ONE to
	// needs-attention). Single-job callers pass no lock ⇒ the tail runs directly,
	// byte-for-byte unchanged. The lock is keyed per repo, so cross-repo
	// integration stays fully concurrent.
	const runRebaseToIntegrateTail = async (): Promise<IntegrationCoreResult> => {
		// The step-4 rebase-onto-`<arbiter>/main` (with BOTH reconciliation arms: the
		// sibling-slug ledger arm and the divergent-done-move recovery), factored so it
		// can run ONCE before the gate AND be RE-RUN in the Race-1 merge-push retry loop
		// (a sibling advancing main mid-push needs the SAME reconcile, not a bare
		// rebase). Returns `{}` on a clean rebase (fall through to gate/integrate) or
		// `{route}` when a genuine conflict / invariant violation must stop the tail.
		const rebaseOntoMainWithReconcile = async (): Promise<{
			route?: IntegrationCoreResult;
		}> => {
			// 4. Rebase-before-integrate (ADR §10): rebase the work branch onto the
			//    latest <arbiter>/main. Clean → continue. Conflict → abort + stop.
			//
			//    RECOVERY reconciliation: post the per-item-lock cut-over, a stuck item's
			//    body never moved into a `needs-attention/` folder (stuck is the lock
			//    `state: stuck`; the body rests in `backlog/`), so a recovery `complete`'s
			//    kept branch carries NO historical `in-progress → needs-attention`
			//    move-only commit to drop and `<arbiter>/main` holds no surface move to
			//    conflict with. The old recovery drop (`rebaseDroppingNeedsAttentionSurface`,
			//    drop-bookkeeping-rebase) is deleted; recovery is now the SAME plain replay
			//    onto `<arbiter>/main` as any other build (see the plain-rebase note below).
			// Fetch the arbiter's `main` into the `<arbiter>/main` remote-tracking ref
			// EXPLICITLY. A `run` JOB WORKTREE is cut from a bare hub mirror whose remote
			// has no fetch refspec (so `<arbiter>/main` would not otherwise resolve / would
			// be stale, causing a spurious rebase conflict); a regular clone (`do`/
			// `complete`) already has it, where the explicit refspec is harmless (the same
			// refspec `rebaseOntoArbiterMain` used before the convergence).
			await gitHard(
				[
					'fetch',
					'--quiet',
					arbiter,
					`+refs/heads/main:refs/remotes/${arbiter}/main`,
				],
				cwd,
				env,
			);
			// ONE-SLUG-ONE-FOLDER guard + divergent-base PRE-CHECK, read from the
			// freshly-fetched `<arbiter>/main` (a READ of the tracking ref the fetch above
			// just populated — NO new fetch, so no shared-mirror race). It (a) FAILS LOUD if
			// the arbiter already holds the slug in >1 status folder with differing content
			// (a corrupt ledger; never publish over it), and (b) detects the DIVERGENT base
			// — the arbiter holds the slug's source in a DIFFERENT folder than our local
			// done-move removed — which is the case that turns the rebased "move" into a
			// "copy" (PR #86). The tasking lifecycle is exempt (its move is not a task
			// done-move).
			// CONTINUE-BUILD EXEMPTION (task
			// `complete-builds-on-already-done-moved-continue`): on `source: 'done'`
			// there was no first-time move on this commit (the slug was already in
			// `done/` on the kept branch + on the arbiter), so the divergent-done-move
			// reconcile reasoning does not apply. Skip the arbiter ledger placement
			// pre-check too: it is structurally an instrument FOR that reconcile, and a
			// continue-build is by construction already in `done/` on both sides.
			if (!lifecycle && source !== 'done') {
				const arbiterPlacement = readArbiterLedgerPlacement(
					cwd,
					arbiter,
					slug,
					env,
				);
				if (arbiterPlacement.error) {
					note(arbiterPlacement.error);
					return {
						route: {
							outcome: 'invariant-violation',
							routedToNeedsAttention: false,
							branch,
							reason: arbiterPlacement.error,
						},
					};
				}
			}
			// PLAIN rebase. After the per-item-lock cut-over (spec
			// `ledger-status-per-item-lock-refs`, tasks 9a–9d) no transient status
			// lands on a work branch: needs-attention is the lock `state: stuck` (not a
			// `git mv` to `needs-attention/`), the body rests in `backlog/` while
			// claimed, and the tasking/advancing markers are gone. So a recovery
			// complete's kept branch carries NO historical route-to-needs-attention
			// move-only commit to drop — the old `rebaseDroppingNeedsAttentionSurface`
			// (drop-bookkeeping-rebase) is deleted and BOTH recovering and lifecycle
			// rebases are the same plain replay onto `<arbiter>/main`.
			void recovering;
			void lifecycle;
			// RENAME-DETECTION-OFF (task
			// `disable-rename-detection-on-continue-rebase`): scope
			// `-c merge.directoryRenames=false` to THIS rebase invocation, so a single
			// durable folder-transition `git mv` out of a SPARSE work/<from>/ folder is
			// NOT misread by git's directory-rename heuristic as a whole-DIRECTORY
			// rename `work/<from>/ → work/<to>/` (which would spuriously flag every
			// sibling file `<arbiter>/main` added into that folder as `CONFLICT (file
			// location)` and force a FALSE needs-attention). Content-rename detection
			// (`-Xno-renames`/`merge.renames`/`diff.renames`) is the wrong knob and
			// does NOT suppress this directory-rename conflict; only
			// `merge.directoryRenames=false` does. NEVER a persistent `git config`
			// write — the repo's config stays clean so a user's interactive
			// `git rebase` is unaffected. A GENUINE content conflict still surfaces
			// and still routes via `rebaseConflictRoute()` below.
			const rebase = await gitSoft(
				['-c', 'merge.directoryRenames=false', 'rebase', `${arbiter}/main`],
				cwd,
				env,
			);
			if (rebase.status !== 0) {
				// NEVER auto-resolve a genuine CODE conflict. But FIRST, a SIBLING-SLUG
				// LEDGER conflict (the replay conflicts ONLY on OTHER slugs'
				// `work/<status>/<otherslug>.md` ledger files — a sibling job landed its own
				// status-folder move on `<arbiter>/main` between our base and this rebase) is
				// a benign ledger-only divergence with NO semantic judgement: the reconcile
				// ABORTS the rebase, then redoes OUR work as one clean commit on top of
				// `<arbiter>/main` (taking the arbiter's version of every sibling ledger file
				// automatically). It is scoped STRICTLY to other slugs' ledger files — a
				// conflict touching ANY code file, or THIS slug's own ledger, returns `false`
				// (and leaves the rebase in progress), so the divergent-done-move recovery /
				// needs-attention route below handles it; it NEVER widens to code. The tasking
				// lifecycle is exempt (its move is not a task done-move).
				const siblingReconciled = lifecycle
					? false
					: await reconcileSiblingLedgerConflict({
							cwd,
							arbiter,
							slug,
							env,
							note,
						});
				if (siblingReconciled) {
					// The branch is now cleanly on top of `<arbiter>/main` with OUR work + the
					// arbiter's sibling-ledger files — fall through to the fresh-gate + integrate
					// band. THIS slug's own move is untouched.
					note(
						`Reconciled a sibling-slug ledger conflict during the rebase onto ` +
							`${arbiter}/main (took the arbiter's version of the other slugs' ` +
							`work/<status>/<slug>.md ledger files; no code file was touched).`,
					);
				} else if (!lifecycle && source !== 'done') {
					// NEVER auto-resolve a genuine CODE conflict: abort the rebase. But FIRST, a
					// DIVERGENT-LEDGER conflict (the arbiter holds the slug's source in a folder
					// our local done-move did not remove — PR #86) is auto-RECONCILABLE without
					// any semantic judgement: redo the done-move arbiter-resolved (remove the
					// arbiter's actual source folder, add `done/`) on top of `<arbiter>/main`. We
					// only do this when the post-abort tree's ONLY divergence is the slug's ledger
					// file; a real code conflict still routes to needs-attention untouched.
					await gitSoft(['rebase', '--abort'], cwd, env);
					const recovered = await reconcileDivergentDoneMove({
						cwd,
						arbiter,
						slug,
						branch,
						localSource: source,
						env,
						note,
					});
					if (recovered) {
						// The branch is now cleanly on top of `<arbiter>/main` with the slug in
						// `done/` ONLY — fall through to integrate (skip the needs-attention
						// route below).
						note(
							`Reconciled the done-move against ${arbiter}/main: '${slug}' is in ` +
								'work/done/ ONLY (the divergent source folder was removed; the move ' +
								'is a move, not a copy).',
						);
					} else {
						return {route: await rebaseConflictRoute()};
					}
				} else {
					await gitSoft(['rebase', '--abort'], cwd, env);
					return {route: await rebaseConflictRoute()};
				}
			}
			// Clean rebase (or a reconciled one): fall through to the gate + integrate.
			return {};
		};

		// Run the step-4 rebase ONCE up front (before the slow fresh gate).
		const firstRebase = await rebaseOntoMainWithReconcile();
		if (firstRebase.route) {
			return firstRebase.route;
		}

		// The rebase-conflict needs-attention route, factored so the divergent-ledger
		// recovery above can fall through to integrate while a genuine code conflict
		// still routes here.
		async function rebaseConflictRoute(): Promise<IntegrationCoreResult> {
			// Then mark the item stuck on its per-item lock with the conflict reason
			// (ADR §12) THROUGH the ledger write seam's needs-attention transition,
			// rather than leaving it dangling. Post lock-cutover this is a lock amend
			// (`state: stuck` + the reason on the lock entry, no `done/ →
			// needs-attention/` folder move); the done-move already committed above
			// stands. No partial state.
			const reason = `rebase onto ${arbiter}/main conflicted (aborted, never auto-resolved)`;
			const routed = await ledgerWrite.applyNeedsAttentionTransition({
				cwd,
				slug,
				reason,
				// Autonomous caller (`do`) passes the arbiter so the seam both surfaces the
				// conflict on `main` (OBSERVABLE) AND pushes the `work/<slug>` branch
				// (RECOVERABLE, cross-machine). The human `complete` leaves it unset →
				// no surface, no push, local-only. The push lives in the seam (HEAD's
				// branch is `work/<slug>` here) — no bolted-on push.
				arbiter: input.surfaceArbiter,
				env,
				note,
			});
			return {
				outcome: 'rebase-conflict',
				routedToNeedsAttention: routed.moved,
				branch,
				commitMessage,
				reason: routed.moved
					? `Rebasing ${branch} onto ${arbiter}/main conflicted; the rebase was ` +
						`aborted (never auto-resolved) and '${slug}' was marked stuck on ` +
						'its per-item lock (surfaced by status). Resolve against the latest ' +
						'main, then `requeue` to release the stuck lock and re-run.'
					: `Rebasing ${branch} onto ${arbiter}/main conflicted; the rebase was ` +
						'aborted (never auto-resolved). Resolve against the latest main, ' +
						'then re-run complete.',
			};
		}

		// 4c. FRESH-WORKTREE GATE (task `gate-on-rebased-tip-fresh-worktree`): when ON,
		//     the acceptance gate (`prepare` then `verify`) runs HERE — on the work
		//     branch tip the rebase above just produced (the would-be-integrated tip) —
		//     rather than on the agent's pre-rebase `cwd`. We cut a CLEAN throwaway
		//     worktree from `HEAD` (the rebased committed tip), `prepare` then `verify`
		//     in it, REAP it (pass or fail), and only on GREEN fall through to integrate.
		//     A gitignored/uncommitted file in `cwd` cannot leak into this gate (the
		//     worktree is cut from the committed, rebased tip), and a change the
		//     integration rebase introduced IS gated. A red gate routes the item the SAME
		//     way the front gate did — EXCEPT the done-move already happened (steps 2–3),
		//     so the bounce is from `work/done/` (the seam finds the slug wherever it
		//     rests) instead of `work/in-progress/`. A `--skip-verify` skipped the gate
		//     entirely at the front, so it never reaches here. The tasking `lifecycle`
		//     path is exempt (its quality engine is the tasker loop, not this gate).
		if (freshWorktreeGate && !input.skipVerify && !lifecycle) {
			const tip = (
				await gitSoft(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd, env)
			).stdout.trim();
			const gated = await runFreshWorktreeGate({
				cwd,
				commit: tip,
				prepare: input.prepare,
				verify: input.verify,
				env,
				note,
				// GATE-2 REVIEW relocation (MAINTAINER DECISION 2): when `review` is ON,
				// the fresh gate runs it AFTER the rebased-tip verify, against the rebased
				// tip (the gate worktree) — so verify-THEN-review holds on the SAME merged
				// tree. The needs-attention ROUTING still targets `cwd` (the work branch +
				// ledger), so the verdict handling is identical to the OFF path.
				review: input.review
					? (reviewCwd) =>
							runGate2Review({
								reviewCwd,
								input,
								slug,
								branch,
								cwd,
								env,
								note,
							})
					: undefined,
			});
			if (!gated.passed) {
				// prepare-failed or gate-failed on the rebased tip: route the item to
				// needs-attention through the SAME seam the front gate / rebase-conflict use.
				// The done-move was already committed (steps 2–3), so the slug sits in
				// work/done/; the seam bounces it from there (done → needs-attention). The
				// recovery path keeps it where it is (no re-route) exactly like the front gate.
				const outcome: IntegrationCoreOutcome =
					gated.kind === 'prepare' ? 'prepare-failed' : 'gate-failed';
				const what =
					gated.kind === 'prepare'
						? `Env-prep (prepare) failed (exit ${gated.exitCode})`
						: `Acceptance gate failed (exit ${gated.exitCode})`;
				// The gate-failure CONTEXT (which command failed + its output tail) is
				// meaningful only for a `verify` failure; a prepare failure names its
				// single command already. Enrich the surfaced reason so the question is
				// actionable rather than an opaque exit code.
				const context =
					gated.kind === 'prepare'
						? ''
						: formatGateFailureContext({
								failedCommand: gated.failedCommand,
								outputTail: gated.outputTail,
							});
				const reason =
					gated.kind === 'prepare'
						? `prepare (env-prep) failed (exit ${gated.exitCode}) on the rebased tip`
						: `acceptance gate failed (exit ${gated.exitCode}) on the rebased tip${context}`;
				const routed = await ledgerWrite.applyNeedsAttentionTransition({
					cwd,
					slug,
					reason,
					arbiter: input.surfaceArbiter,
					env,
					note,
				});
				return {
					outcome,
					routedToNeedsAttention: routed.moved,
					branch,
					commitMessage,
					reason: routed.moved
						? `${what} on the rebased tip; marked '${slug}' stuck on its ` +
							'per-item lock (surfaced by status; `requeue` once resolved). ' +
							'Fix the work, or use --skip-verify to override.'
						: `${what} on the rebased tip; not completing '${slug}'. Fix the ` +
							'work, or use --skip-verify to override.',
				};
			}
			// GATE-2 REVIEW outcome on the rebased tip (MAINTAINER DECISION 2): the
			// rebased-tip verify PASSED, so the review ran AFTER it (verify-then-review on
			// the merged tree). Route a BLOCK exactly as the OFF-path front review does
			// (only the reviewed tree moved, not the routing). On APPROVE: carry the
			// verdict (post-integrate PR comment), write the per-run non-blocking-nits
			// observation. A resolved `merge` then lands automatically; `propose` leaves
			// the merge to a human.
			if (gated.review) {
				if (gated.review.kind === 'blocked') {
					// The done-move was already committed (steps 2–3), so the slug sits in
					// work/done/; the routing marked it stuck on its per-item lock (post
					// lock-cutover — a lock amend, no folder move).
					return gated.review.result;
				}
				approvedVerdict = gated.review.verdict;
				// The done-move + atomic commit already happened (steps 2–3, before this
				// rebased-tip gate), so — unlike the OFF path where the nits write rides the
				// upcoming commit — we write the observation into `cwd` and FOLD it into the
				// existing done-commit via `commit --amend` (the branch is not yet
				// integrated). The observation still lands in the SAME done-commit that
				// integrates, preserving the no-separate-commit/surface model.
				const nitsBefore = await stagedCaptureNotes(cwd, env);
				writeReviewNitsObservation({
					cwd,
					slug,
					findings: gated.review.verdict?.findings ?? [],
					note,
				});
				// Only amend when the write actually produced a new staged file (zero
				// non-blocking findings ⇒ no write ⇒ no amend, the done-commit unchanged).
				await gitHard(['add', '-A'], cwd, env);
				if (!(await nothingStaged(cwd, env))) {
					const nitsAfter = await stagedCaptureNotes(cwd, env);
					if (nitsAfter.length > nitsBefore.length) {
						await gitHard(['commit', '-q', '--amend', '--no-edit'], cwd, env);
					}
				}
			}
		}

		// 5. Integrate per mode through the ledger write seam's COMPLETE transition
		//    (ADR §6 + `docs/adr/claim-ledger-vs-protected-main.md`). The rebase above
		//    already brought the branch up to date, so the seam's sole strategy uses
		//    `integrate` (not `integrateWithRebase`) and never --forces. Provider
		//    selection: an injected `openPr` wins (legacy bridge); otherwise pick by
		//    the arbiter's remote URL (a GitHub remote ⇒ `gh pr create`, else push-only
		//    `none`) — PURELY arbiter-derived, no override axis. A missing/unauthenticated
		//    `gh` degrades to push-only at runtime — never a hard failure (and the
		//    start-of-run unauthed case is caught UP FRONT by the pre-flight `gh` probe).
		//    The seam is storage-agnostic: we hand it the work branch, the integration
		//    mode, the provider, and the PR-INTENT (`noPR`) — `main` lives only in the
		//    strategy.
		// Provider precedence: an injected fully-formed provider wins (the `run`
		// stubbed-provider seam, carrying title/body/url); else the legacy `openPr`
		// bridge; else select PURELY from the arbiter URL (no override). The orthogonal
		// `noPR` INTENT (suppress the PR) is threaded SEPARATELY — it does NOT pick a
		// provider, the integrator simply skips `openRequest` when it is set.
		const provider =
			input.providerInstance ??
			(input.openPr
				? bridgeProvider(input.openPr)
				: selectProvider({
						arbiterUrl: await arbiterUrl(cwd, arbiter, env),
					}));
		// Race-1 (claim-vs-integrate, task
		// `run-fleet-claim-integrate-and-sibling-rebase-concurrency-safe`): integrate,
		// and on a non-fast-forward `${branch}:main` push (a SIBLING same-repo CLAIM —
		// under the SEPARATE claim lock — or a sibling integrate advanced
		// `<arbiter>/main` during our push window) RE-RUN the step-4 rebase (which
		// carries the sibling-ledger + divergent-done-move reconcile arms — a bare
		// re-rebase would MISS them) and RETRY the push, up to a small cap. INSTANT
		// retry (contention, not an outage; see `claim-cas.ts`). We NEVER `--force`
		// main: each retry re-rebases to a clean fast-forward. A genuine code conflict
		// on a re-rebase routes to needs-attention via the SAME `route` the up-front
		// rebase uses. A persistent non-fast-forward past the cap also routes (never a
		// silent drop). `input.mergeRetries` overrides the cap (tests; `0` ⇒ no retry).
		//
		// **C2 rebase-until-real-conflict (task `c2-rebase-until-real-on-durable-main-
		// promotions`):** the loop's TERMINATION CHANGED. A CLEAN re-rebase no longer
		// counts against a tiny give-up budget — only a GENUINE conflict surfaced by
		// `rebaseOntoMainWithReconcile` (a `route` ⇒ `rebase-conflict` or
		// `invariant-violation`) stops the loop. The step-4 rebase IS the source-folder
		// precondition recheck reused verbatim: if the slug is GONE from its expected
		// source folder on the new `main` (a concurrent legitimate same-item winner
		// already moved it), the `git mv` replay fails and `rebaseConflictRoute` routes
		// definitively — never a silent re-push that would clobber the winner. The
		// `maxMergeRetries` cap survives ONLY as a large liveness ceiling on the
		// pathological livelock tail (default {@link DEFAULT_MERGE_RETRIES} = 1000);
		// modest jitter on the refetch desynchronises a herd so the tail is not
		// reached under sustained parallel load.
		const maxMergeRetries = input.mergeRetries ?? DEFAULT_MERGE_RETRIES;
		const mergeJitterMs = input.mergeJitterMs ?? DEFAULT_MERGE_JITTER_MS;
		let integration!: IntegrateResult;
		for (let mergeAttempt = 0; ; mergeAttempt++) {
			integration = await ledgerWrite.applyCompleteTransition({
				arbiter,
				branch,
				mode,
				provider,
				// PR-INTENT: when set (propose mode), push the branch but skip the PR.
				noPR: input.noPR,
				// Half A: an explicit single-line PR title (propose mode), so `gh` no longer
				// derives a run-on title from the commit subject via `--fill`.
				title: prTitle,
				// Half B: the propose-mode PR body — the agent's summary under a deterministic
				// runner header (task pointer). Undefined when no body was supplied (the
				// header is only scaffolded when there IS a body) ⇒ today's `--fill` (no
				// regression). Ignored in merge mode by the provider/integrator.
				body: composeProposeBody({slug, body: input.body}),
				// Part (b) of the merged-branch hygiene task: when WE perform the merge
				// (this resolved `merge` mode), reap the remote `work/<slug>` HEAD branch
				// INLINE right after the merge lands — the commits are now on `main`, so the
				// head is provably merged and safe to delete (ancestor-guarded inside the
				// integrator). Idempotent no-op when no remote head exists (the plain
				// `${branch}:main` push opened none); ignored in `propose` mode (its branch is
				// the review surface, reaped later by `gc --remote-branches`). NEVER `--force`.
				deleteMergedHead: true,
				cwd,
				env,
			});
			// Only the merge push can be non-fast-forward (propose pushes its own ref).
			if (integration.mergeNonFastForward !== true) {
				break;
			}
			if (mergeAttempt >= maxMergeRetries) {
				// LIVENESS CEILING hit (default 1000; previously the small Race-1 cap of 5,
				// now reinterpreted by C2 as the pathological-livelock-tail bound, NOT a
				// false-contention budget). Route to needs-attention rather than looping
				// forever or force-pushing main. A RARE outcome under realistic load thanks
				// to the jitter below + the rebase-until-real-conflict semantics; tests
				// reach it deterministically by injecting a small `mergeRetries`.
				return await mergeNonFastForwardRoute(
					`integrating ${branch} onto ${arbiter}/main kept hitting a ` +
						`non-fast-forward push (a sibling advanced main ${mergeAttempt + 1} ` +
						`times); gave up cleanly without --force`,
				);
			}
			// Modest jitter on the refetch (C2): an instant lockstep refetch→re-push loop
			// maximises mutual rejection under sustained parallel load (thundering herd).
			// A uniformly-random `[0, mergeJitterMs]` ms sleep desynchronises the herd.
			// Skipped when `mergeJitterMs === 0` (the test seam).
			if (mergeJitterMs > 0) {
				await sleepMs(Math.floor(Math.random() * (mergeJitterMs + 1)));
			}
			// A sibling advanced main: re-run the step-4 rebase (with the reconcile arms)
			// before retrying the push. A genuine conflict on the re-rebase routes via
			// `rebaseOntoMainWithReconcile`'s `route` (the existing source-folder /
			// one-slug placement recheck IS the genuine-conflict terminator — see the
			// `DEFAULT_MERGE_RETRIES` docstring for the C2 SCOPE box). A clean re-rebase
			// (no route) loops without counting against a small budget.
			const reRebase = await rebaseOntoMainWithReconcile();
			if (reRebase.route) {
				return reRebase.route;
			}
		}

		// The Race-1 needs-attention route for a merge that could not land (a genuine
		// re-rebase conflict is handled by `rebaseOntoMainWithReconcile`'s `route`; this
		// covers the cap-exhausted persistent-contention case). Mirrors
		// `rebaseConflictRoute`: the done-move was already committed (steps 2–3), so the
		// slug sits in work/done/ and the seam bounces it from there.
		async function mergeNonFastForwardRoute(
			reason: string,
		): Promise<IntegrationCoreResult> {
			const routed = await ledgerWrite.applyNeedsAttentionTransition({
				cwd,
				slug,
				reason,
				arbiter: input.surfaceArbiter,
				env,
				note,
			});
			return {
				outcome: 'rebase-conflict',
				routedToNeedsAttention: routed.moved,
				branch,
				commitMessage,
				reason: routed.moved
					? `Integrating ${branch} onto ${arbiter}/main kept hitting a ` +
						`non-fast-forward push (a sibling advanced main); '${slug}' was ` +
						`marked stuck on its per-item lock (surfaced by status). Resolve ` +
						`against the latest main, then \`requeue\` to release the stuck ` +
						`lock and re-run.`
					: `Integrating ${branch} onto ${arbiter}/main kept hitting a ` +
						`non-fast-forward push (a sibling advanced main). Resolve against the ` +
						`latest main, then re-run complete.`,
			};
		}

		// 6. Make the Gate-2 review VISIBLE on the PR (task `review-comment-prose-field`,
		//    refining `review-gate-pr-comment`): AFTER the propose integrate, where the
		//    approved verdict (with its deliberately-authored `review` prose), the
		//    resolved `provider`, AND the opened PR url (`integration.url`) are ALL in
		//    scope, post `verdict.review` as a comment on that PR — INCLUDING on approve
		//    (the audit trail; decided 2026-06-06). The `review` field is a first-class
		//    AUTHORED review (the prompt requires it), NOT the residue around the JSON
		//    — posting the residue was the bug
		//    (`work/findings/review-comment-posts-agent-thinking-not-a-review.md`). It
		//    reuses the SAME `provider` the integrate used (the core never imports `gh`).
		//    The comment is ADVISORY: it changes no gate/verdict/merge/integration logic
		//    — by here the verdict has ALREADY routed (block never reaches this point; it
		//    routed to needs-attention above) and the integrate has ALREADY happened.
		//    The PR identity is resolved in PRECEDENCE: a parsed `integration.url` wins
		//    (the normal path — post on it directly); else, when a PR WAS opened but its
		//    url was unparseable (`integration.requestOpened` true, `url` undefined — the
		//    `gh pr create` exit-0-but-unparseable-stdout degradation), FALL BACK to the
		//    BRANCH-resolved comment (task `review-comment-fallback-on-unparsed-pr-url`):
		//    the provider resolves the branch's open PR and comments on it, instead of
		//    silently dropping a review on a PR that genuinely exists. Only when NO PR was
		//    opened at all (merge mode, or a degraded/push-only propose ⇒ `requestOpened`
		//    false) is it the honest clean no-op — and the branch-resolved fallback's own
		//    "no PR resolvable" path is a clean no-op too (it tries first). Either way
		//    `postPRComment*` never throws; the review stays in the run output. Because
		//    this lives in the shared core, BOTH `do`/`complete` AND `run` post the
		//    comment — no per-caller wiring.
		if (approvedVerdict?.review !== undefined) {
			if (integration.url !== undefined) {
				const posted = provider.postPRComment({
					cwd,
					url: integration.url,
					body: approvedVerdict.review,
					env,
				});
				note(posted.instruction);
			} else if (integration.requestOpened) {
				// A PR opened but its url was unparseable — resolve it from the branch
				// rather than dropping the review (the audit-trail fallback).
				const posted = provider.postPRCommentOnBranch({
					cwd,
					branch,
					body: approvedVerdict.review,
					env,
				});
				note(posted.instruction);
			}
		}

		return {
			outcome: 'completed',
			routedToNeedsAttention: false,
			branch,
			commitMessage,
			integration,
		};
	};

	// Serialise ONLY this tail per repo when the `run` seam is wired; absent ⇒ run
	// it directly (an un-contended no-op, single-job behaviour unchanged).
	return input.integrateLock && input.integrateLockKey !== undefined
		? await input.integrateLock(
				input.integrateLockKey,
				runRebaseToIntegrateTail,
			)
		: await runRebaseToIntegrateTail();
}

/**
 * RECOVER an already-committed, already-done-moved STRANDED branch (spec
 * `ledger-integrity` story 6, the `finish-already-committed-branch` task). The
 * green work AND the `git mv → work/done/` are ALREADY committed on the work
 * branch (a terminal push failed AFTER `performIntegration`'s steps 2–3), and the
 * tip is NOT on the arbiter. This runs ONLY the rebase→integrate TAIL (steps 4–5)
 * from the kept commit — NO re-done-move, NO re-commit, NO rebuild, NO orphan
 * branch — reusing the SAME `ledgerWrite.applyCompleteTransition` integrate
 * primitive the build path uses.
 *
 * RE-GATE on the REBASED TIP (task `committed-recovery-honours-fresh-worktree-
 * gate`, spec `land-time-reverify-and-parallel-merge-ceiling`): when the caller
 * sets `freshWorktreeGate` (and not `skipVerify`), the EXISTING
 * `runFreshWorktreeGate` runs on the rebased tip AFTER the rebase loop and
 * BEFORE `applyCompleteTransition`, mirroring the build path's
 * `freshWorktreeGate && !skipVerify && !lifecycle` branch — a red gate routes
 * to needs-attention through the SAME shared seam, never integrates a clean-
 * rebase-but-broken merge. This is OPT-IN per caller: the original stranded-
 * recovery caller (`complete --integration`'s already-built strand, whose pre-
 * strand build already gated) leaves it UNSET and is byte-identical to before —
 * no extra gate, no extra fetch. The answered-merge apply-rung SETS it because
 * `<arbiter>/main` may have moved since the branch's last build, so the rebased
 * tip MUST be re-verified before it lands or the load-bearing invariant
 * ("main never receives a tree that fails verify") cannot hold on the merge
 * path.
 *
 * SAFETY — UNSPOOFABLE detection: BEFORE acting it fetches `<arbiter>/main` and
 * checks whether the kept tip is ALREADY reachable there (`isAncestor`, the SAME
 * predicate `gc.ts` uses). If so the work is already integrated → a clean
 * `already-integrated` no-op (never a re-push / double-integrate); a re-run after a
 * successful recovery hits this. Only when the tip is genuinely AHEAD does it
 * rebase + integrate. A rebase CONFLICT here is a genuine code conflict the human
 * resolves — the branch is aborted and the outcome is `rebase-conflict` (the kept
 * commit stays intact on the branch, recoverable), NEVER auto-resolved, NEVER
 * `--force` to main.
 */
async function recoverAlreadyCommitted(params: {
	cwd: string;
	arbiter: string;
	slug: string;
	branch: string;
	mode: IntegrationMode;
	noPR?: boolean;
	providerInstance?: ReviewProvider;
	openPr?: (opts: {
		cwd: string;
		branch: string;
		env?: NodeJS.ProcessEnv;
	}) => void;
	recoveryRebaseRetries?: number;
	recoveryRebaseJitterMs?: number;
	recoveryRebaseSleep?: Sleep;
	recoveryRebaseRandom?: () => number;
	/**
	 * Run the EXISTING `runFreshWorktreeGate` (`prepare` then `verify`) on the
	 * rebased tip AFTER the rebase loop and BEFORE `applyCompleteTransition`
	 * (task `committed-recovery-honours-fresh-worktree-gate`, spec
	 * `land-time-reverify-and-parallel-merge-ceiling`). The original stranded-
	 * recovery caller (`complete --integration`'s already-built strand) leaves
	 * this UNSET ⇒ no gate, no extra fetch — byte-identical to before. The
	 * answered-merge apply-rung sets it ⇒ the rebased tip is re-verified before
	 * it lands, so the load-bearing invariant ("main never receives a tree that
	 * fails verify") holds on the merge path: a clean rebase that fails verify
	 * routes to needs-attention via the SAME `applyNeedsAttentionTransition`
	 * seam the build path's `freshWorktreeGate && !skipVerify && !lifecycle`
	 * branch uses — no fork of a second gate or a second integrate primitive.
	 */
	freshWorktreeGate?: boolean;
	/** `--skip-verify` honoured exactly as the build path: skips the gate entirely. */
	skipVerify?: boolean;
	/** Env-prep config for the fresh gate (mirrors the build path). */
	prepare?: VerifyConfig;
	/** Acceptance gate config for the fresh gate (mirrors the build path). */
	verify?: VerifyConfig;
	/**
	 * The full integration input, threaded so the recovery tail can run Gate 2
	 * (`runGate2Review`) with the identical gate/model/watch/round wiring the
	 * build path uses (task `committed-recovery-always-reviews`). Gate 2 runs on
	 * the rebased tip when `input.review` is on and the fresh gate ran green — a
	 * stranded already-complete branch is NOT trusted as already-reviewed (its
	 * earlier attempt never merged). Optional so the pre-existing non-review
	 * callers (and tests) that do not thread it stay byte-identical.
	 */
	input?: IntegrationCoreInput;
	/**
	 * The propose-mode PR BODY (task `committed-recovery-always-reviews`): the
	 * recovery has NO fresh agent output (no rebuild), so the caller passes
	 * whatever advisory body it has so the PR carries a description instead of a
	 * blank `gh --fill`. Undefined ⇒ today's `--fill` fallback.
	 */
	body?: string;
	/**
	 * Autonomous needs-attention surface (mirrors the build path): when set, a
	 * red rebased-tip gate cherry-picks the bounce onto `main` + pushes the
	 * work branch (observable + cross-machine). Unset ⇒ local-only routing.
	 */
	surfaceArbiter?: string;
	env: NodeJS.ProcessEnv | undefined;
	note: (message: string) => void;
}): Promise<IntegrationCoreResult> {
	const {cwd, arbiter, slug, branch, mode, env, note} = params;
	const retries =
		params.recoveryRebaseRetries ?? DEFAULT_RECOVERY_REBASE_RETRIES;
	const jitterMs =
		params.recoveryRebaseJitterMs ?? DEFAULT_RECOVERY_REBASE_JITTER_MS;
	const sleep = params.recoveryRebaseSleep ?? realSleep;
	const random = params.recoveryRebaseRandom ?? Math.random;

	// Helper: the explicit-refspec fetch (the build path's step-4 fetch shape — a
	// bare-mirror worktree's remote has no fetch refspec, so `<arbiter>/main` would
	// not otherwise resolve / would be stale). REUSED on EACH attempt (the root cause
	// of the moving-base race is a stale SINGLE fetch — see the loop below).
	const refetchMain = async (): Promise<void> => {
		await gitHard(
			[
				'fetch',
				'--quiet',
				arbiter,
				`+refs/heads/main:refs/remotes/${arbiter}/main`,
			],
			cwd,
			env,
		);
	};

	await refetchMain();

	const tip = (
		await gitSoft(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd, env)
	).stdout.trim();
	if (tip === '') {
		throw new Error(
			`cannot recover '${slug}': HEAD does not resolve (no committed work on ` +
				`${branch}?).`,
		);
	}

	// UNSPOOFABLE detection: the kept tip ALREADY reachable on `<arbiter>/main`
	// means the work is already integrated — a clean no-op, NEVER a re-integration.
	// (`isAncestor` is the SAME reachability predicate `gc.ts` uses; do not fork it.)
	// KEPT before the retry loop: a no-op MUST short-circuit before we burn any
	// re-fetch/re-rebase budget.
	//
	// DELIBERATELY the RAW ancestry predicate, NOT `isProvablyMergedForReap`
	// (task `reap-squash-merged-remote-work-branches`, ratified): this is an
	// integration-IDEMPOTENCY check, not reap-safety. A squash-landed LOOKALIKE
	// whose tip is NOT genuinely reachable would falsely read "already
	// integrated" here and skip a needed rebase/re-push. The squash-aware helper
	// is scoped to reap-safety ONLY; see gc.ts `isProvablyMergedForReap` and
	// work/notes/observations/reap-squash-helper-scope-2026-07-10.md.
	if (isAncestor(cwd, tip, `refs/remotes/${arbiter}/main`, env)) {
		const message =
			`Nothing to recover for '${slug}': its work branch tip is already on ` +
			`${arbiter}/main (already integrated). No re-push, no double-integrate.`;
		note(message);
		return {
			outcome: 'already-integrated',
			routedToNeedsAttention: false,
			branch,
			reason: message,
		};
	}

	// The tip is genuinely AHEAD — rebase the kept commit onto the latest
	// `<arbiter>/main`. A clean rebase continues; a CONFLICT is wrapped in a
	// bounded CONTENTION loop (task `recovery-rebase-retry-against-moving-arbiter-
	// main`): on each conflict `--abort`, sleep a small jitter, RE-FETCH
	// `<arbiter>/main` (it may have advanced — `advance` runs land bursts of
	// `advance: surface observation:…` commits on main, so a one-shot rebase against
	// a stale fetched base can conflict against a main that already moved AGAIN),
	// then re-rebase. Only after the cap exhausts (a freshly-fetched main STILL
	// conflicts on every attempt) do we surface `rebase-conflict` (never auto-
	// resolved, NEVER `--force` to main — the kept commit stays on the branch,
	// recoverable; the human resolves and re-runs).
	//
	// This is the CONTENTION model (instant re-fetch+rebuild against the new base,
	// like `claim-cas.ts` / the Race-1 merge loop above), NOT the OUTAGE model in
	// `retry-backoff.ts` (exponential temporal backoff for an unreachable remote).
	// The jitter is a SMALL livelock-breaking SPREAD (two runners that begin
	// retrying at the same instant must NOT re-fetch/re-rebase in lockstep) — NOT
	// exponential outage backoff. The `--abort` is unconditional on conflict (never
	// leave the worktree mid-rebase between attempts).
	//
	// RECONCILE ARMS DECISION (this task): the recovery rebase is deliberately
	// BARE — it does NOT layer the sibling-ledger / divergent-done-move arms the
	// build path's `rebaseOntoMainWithReconcile()` carries. Reasoning: this tail
	// integrates a branch whose done-move was ALREADY committed in a prior run, so
	// there is no first-time slug relocation on THIS commit for the divergent-
	// done-move reconcile to act on, and a sibling-slug ledger conflict on the
	// re-fetched main is the same shape it would have hit on the original run (the
	// recovery is not the place to grow new reconcile semantics).
	//
	// RENAME-DETECTION composition (task
	// `disable-rename-detection-on-continue-rebase`): the rebase carries
	// `-c merge.directoryRenames=false` SCOPED to the invocation — written as a
	// small args array so every retry of THIS loop carries it too — so a single
	// durable folder-transition `git mv` out of a SPARSE source folder is NOT
	// misread as a whole-DIRECTORY rename and the post-rename heuristic does NOT
	// flag sibling files `<arbiter>/main` added into that folder as `CONFLICT
	// (file location)`. Content-rename detection (`-Xno-renames`/`merge.renames`/
	// `diff.renames`) is the WRONG knob and was verified ineffective for this
	// directory-rename conflict; only `merge.directoryRenames=false` suppresses
	// it. NEVER a persistent `git config` write — the repo's config stays clean.
	// A GENUINE same-path content conflict still surfaces and still routes to
	// `rebase-conflict` (the user's interactive `git rebase` is unaffected).
	note(
		`Recovering '${slug}': rebasing the kept ${branch} onto ${arbiter}/main…`,
	);
	const rebaseArgs = (): string[] => [
		'-c',
		'merge.directoryRenames=false',
		'rebase',
		`${arbiter}/main`,
	];
	let attempt = 0;
	for (;;) {
		const rebase = await gitSoft(rebaseArgs(), cwd, env);
		if (rebase.status === 0) {
			break; // clean rebase ⇒ fall through to integrate
		}
		// ALWAYS abort on conflict — never leave mid-rebase between attempts.
		await gitSoft(['rebase', '--abort'], cwd, env);
		if (attempt >= retries) {
			const message =
				`Recovering '${slug}': rebasing the kept ${branch} onto ${arbiter}/main ` +
				`conflicted on every attempt (${attempt + 1} total, against a freshly-` +
				`fetched ${arbiter}/main each time); the rebase was aborted (never auto-` +
				'resolved). The committed work is intact on the branch (recoverable). ' +
				'Resolve against the latest main, then re-run.';
			note(message);
			return {
				outcome: 'rebase-conflict',
				routedToNeedsAttention: false,
				branch,
				reason: message,
			};
		}
		// Small livelock-breaking jitter (contention spread, NOT outage backoff).
		// Sleep happens BEFORE the re-fetch so a sleep-injection in tests can also
		// drive the timeline (e.g. advance the arbiter between attempts).
		const delay = jitterMs > 0 ? Math.floor(random() * (jitterMs + 1)) : 0;
		await sleep(delay);
		await refetchMain();
		attempt++;
	}

	// FRESH-WORKTREE GATE on the REBASED TIP (task `committed-recovery-honours-
	// fresh-worktree-gate`, spec `land-time-reverify-and-parallel-merge-ceiling`):
	// when `freshWorktreeGate` is set (the answered-merge land caller) and not
	// `--skip-verify`, re-run the acceptance gate on the rebased tip BEFORE we
	// integrate, mirroring the build path's `freshWorktreeGate && !skipVerify &&
	// !lifecycle` branch (recovery never carries a lifecycle, so no lifecycle
	// guard is needed). A green gate ⇒ fall through to integrate exactly as today;
	// a red gate routes to needs-attention through the SAME shared seam
	// (`applyNeedsAttentionTransition`) the build path uses — NEVER integrates a
	// clean-rebase-but-broken merge. With `freshWorktreeGate` UNSET (the original
	// stranded-recovery caller, whose pre-strand build already gated) this whole
	// block is skipped and behaviour is byte-identical to before.
	// Carry an approved Gate-2 verdict (when review ran) so its authored `review`
	// prose is posted as a PR comment AFTER the integrate below — the SAME audit
	// trail the build path keeps (task `committed-recovery-always-reviews`).
	let approvedVerdict: ReviewVerdict | undefined;
	if (params.freshWorktreeGate && !params.skipVerify) {
		const tip = (
			await gitSoft(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd, env)
		).stdout.trim();
		// GATE-2 REVIEW callback (task `committed-recovery-always-reviews`): when
		// `input.review` is on, run Gate 2 on the rebased tip AFTER the green verify
		// — EXACTLY the build path's fresh-gate `review:` callback. A stranded
		// already-complete branch is NOT trusted as already-reviewed (its earlier
		// attempt's PR never merged, and Gate 2 may never have run on it); the same
		// reasoning that forces the re-verify here (`<arbiter>/main` moved, so the
		// merged tree is new) forces the re-review. The needs-attention ROUTING
		// targets `cwd` (the work branch + ledger), identical to the build path.
		const reviewInput = params.input;
		const gated = await runFreshWorktreeGate({
			cwd,
			commit: tip,
			prepare: params.prepare,
			verify: params.verify,
			env,
			note,
			review:
				reviewInput?.review === true
					? (reviewCwd) =>
							runGate2Review({
								reviewCwd,
								input: reviewInput,
								slug,
								branch,
								cwd,
								env,
								note,
							})
					: undefined,
		});
		if (!gated.passed) {
			const outcome: IntegrationCoreOutcome =
				gated.kind === 'prepare' ? 'prepare-failed' : 'gate-failed';
			const what =
				gated.kind === 'prepare'
					? `Env-prep (prepare) failed (exit ${gated.exitCode})`
					: `Acceptance gate failed (exit ${gated.exitCode})`;
			const context =
				gated.kind === 'prepare'
					? ''
					: formatGateFailureContext({
							failedCommand: gated.failedCommand,
							outputTail: gated.outputTail,
						});
			const reason =
				gated.kind === 'prepare'
					? `prepare (env-prep) failed (exit ${gated.exitCode}) on the rebased tip`
					: `acceptance gate failed (exit ${gated.exitCode}) on the rebased tip${context}`;
			const routed = await ledgerWrite.applyNeedsAttentionTransition({
				cwd,
				slug,
				reason,
				arbiter: params.surfaceArbiter,
				env,
				note,
			});
			return {
				outcome,
				routedToNeedsAttention: routed.moved,
				branch,
				reason: routed.moved
					? `${what} on the rebased tip during committed-recovery; marked ` +
						`'${slug}' stuck on its per-item lock (surfaced by status; ` +
						'`requeue` once resolved). Fix the work, or use --skip-verify ' +
						'to override.'
					: `${what} on the rebased tip during committed-recovery; not ` +
						`completing '${slug}'. Fix the work, or use --skip-verify to ` +
						'override.',
			};
		}
		// GATE-2 REVIEW outcome on the rebased tip: a BLOCK routes to needs-attention
		// exactly as the build path (only the reviewed tree moved, not the routing).
		// On APPROVE: carry the verdict for the post-integrate PR comment and write
		// the per-run non-blocking-nits observation. UNLIKE the build path this branch
		// integrates the ALREADY-committed kept tip (no upcoming done-move/commit to
		// sweep the nits file into), so we FOLD the observation into the kept commit
		// via `commit --amend` — mirroring the build path's fresh-gate amend so the
		// nits still land in the SAME commit that integrates (no separate commit).
		if (gated.review) {
			if (gated.review.kind === 'blocked') {
				return gated.review.result;
			}
			approvedVerdict = gated.review.verdict;
			const nitsBefore = await stagedCaptureNotes(cwd, env);
			writeReviewNitsObservation({
				cwd,
				slug,
				findings: gated.review.verdict?.findings ?? [],
				note,
			});
			await gitHard(['add', '-A'], cwd, env);
			if (!(await nothingStaged(cwd, env))) {
				const nitsAfter = await stagedCaptureNotes(cwd, env);
				if (nitsAfter.length > nitsBefore.length) {
					await gitHard(['commit', '-q', '--amend', '--no-edit'], cwd, env);
				}
			}
		}
	}

	// Integrate the rebased kept commit through the SAME complete-transition
	// primitive the build path uses (no duplication of the integrate mechanism; the
	// branch is already rebased so it is the non-rebasing `integrate`, never
	// `--force`). Provider precedence matches the build path: injected instance >
	// legacy `openPr` bridge > arbiter-derived selection.
	const provider =
		params.providerInstance ??
		(params.openPr
			? bridgeProvider(params.openPr)
			: selectProvider({arbiterUrl: await arbiterUrl(cwd, arbiter, env)}));
	// PR TITLE + BODY on the recovery path (task `committed-recovery-always-
	// reviews`): the stranded branch already holds the task in `work/done/`, so
	// synthesise the SAME single-line `<type>(<slug>): <title>` PR title the build
	// path does (from the done-resident task file, never agent text) and scaffold
	// the task-pointer body around the caller-supplied advisory `body`. Undefined
	// body ⇒ `composeProposeBody` returns undefined ⇒ the provider degrades to
	// `gh --fill` (no regression); a supplied body gives the PR a real description
	// instead of the blank one the recovery path used to open.
	const prTitle = synthesiseProposeTitle({
		type: (params.input?.type ?? DEFAULT_TYPE).trim() || DEFAULT_TYPE,
		slug,
		title: readTaskTitle(workItemPath(cwd, 'done', slug)),
	});
	const integration = await ledgerWrite.applyCompleteTransition({
		arbiter,
		branch,
		mode,
		provider,
		noPR: params.noPR,
		title: prTitle,
		body: composeProposeBody({slug, body: params.body}),
		deleteMergedHead: true,
		cwd,
		env,
	});
	note(
		attempt === 0
			? `Recovered '${slug}': integrated the kept commit from ${branch}.`
			: `Recovered '${slug}': integrated the kept commit from ${branch} ` +
					`(absorbed a moving ${arbiter}/main across ${attempt} re-fetch+re-` +
					`rebase attempt${attempt === 1 ? '' : 's'}).`,
	);
	// Post the Gate-2 review as a PR comment (task `committed-recovery-always-
	// reviews`): the SAME post-integrate audit trail the build path keeps — the
	// approved verdict's authored `review` prose, on the opened PR. Advisory only
	// (a block never reaches here — it returned above); the same URL/branch
	// precedence the build path uses (parsed url wins; else a branch-resolved
	// fallback when a PR opened but its url was unparseable). `postPRComment*`
	// never throws. A clean no-op in merge mode / push-only propose (no PR).
	if (approvedVerdict?.review !== undefined) {
		if (integration.url !== undefined) {
			const posted = provider.postPRComment({
				cwd,
				url: integration.url,
				body: approvedVerdict.review,
				env,
			});
			note(posted.instruction);
		} else if (integration.requestOpened) {
			const posted = provider.postPRCommentOnBranch({
				cwd,
				branch,
				body: approvedVerdict.review,
				env,
			});
			note(posted.instruction);
		}
	}
	return {
		outcome: 'completed',
		routedToNeedsAttention: false,
		branch,
		integration,
	};
}

/**
 * Resolve the work branch the integration runs on: the branch HEAD is currently
 * on (the caller is ALWAYS on the work branch — the agent built there / the
 * lifecycle stage wrote there), which carries the namespaced `work/<type>-<slug>`
 * identity. Falls back to a synthesised `work/task-<slug>` ONLY for a detached
 * HEAD (a degenerate case the on-branch invariant precludes), so the push target
 * is always defined.
 */
function resolveWorkBranch(
	cwd: string,
	slug: string,
	env: NodeJS.ProcessEnv | undefined,
): string {
	try {
		const head = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, {
			env,
		}).trim();
		if (head.startsWith('work/')) {
			return head;
		}
	} catch {
		// detached HEAD or plumbing failure — fall through to the synthesised default
	}
	return workBranchRef('task', slug);
}

/**
 * Raised when the atomic completion commit has NOTHING staged (no agent work and
 * no move) — a deliberate REFUSAL, mapped by `complete`'s try/catch to its
 * `refused` outcome (preserving its existing message verbatim). Exported so the
 * caller can `instanceof`-route it.
 *
 * Carries the {@link slug} so the autonomous-strand surface in `complete.ts`
 * (which catches this error in `performComplete`'s outer try/catch, OUTSIDE the
 * `runComplete` slug scope) can mark the item stuck on its per-item lock (post
 * lock-cutover — the tree-less lock amend, no `in-progress/ → needs-attention/`
 * folder move) without re-deriving the slug from the error message.
 */
export class IntegrationNothingStaged extends Error {
	constructor(
		message: string,
		readonly slug: string,
	) {
		super(message);
	}
}

/**
 * The arbiter's remote URL for `arbiter` in `cwd` (for provider auto-detection),
 * or `undefined` when it cannot be resolved. Read-only; soft (never throws).
 * Exported so the PR-INTENT pre-flight guard (`do.ts`) can resolve the arbiter
 * URL up front to decide whether a GitHub PR is even possible for this run.
 */
export async function arbiterUrl(
	cwd: string,
	arbiter: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<string | undefined> {
	const res = await gitSoft(['remote', 'get-url', arbiter], cwd, env);
	if (res.status !== 0) {
		return undefined;
	}
	const url = res.stdout.trim();
	return url === '' ? undefined : url;
}

/** Adapt the legacy `openPr` callback into the new ReviewProvider seam. */
function bridgeProvider(
	openPr: (opts: {
		cwd: string;
		branch: string;
		env?: NodeJS.ProcessEnv;
	}) => void,
): ReviewProvider {
	return {
		name: 'none',
		async openRequest(req) {
			openPr({cwd: req.cwd, branch: req.branch, env: req.env});
			return {
				opened: true,
				instruction: `Opened a review for ${req.branch}.`,
			};
		},
		// The legacy `openPr` bridge has no comment channel (it returns no PR url),
		// so postPRComment degrades: it never opens a PR url to comment on, so the
		// in-core poster no-ops anyway. Implemented for the seam, surfacing the text.
		postPRComment(req) {
			return {
				posted: false,
				instruction:
					'The legacy review bridge cannot post a comment; the review:\n' +
					req.body,
			};
		},
		// Likewise the bridge cannot resolve a PR from a branch — a clean no-op.
		postPRCommentOnBranch(req) {
			return {
				posted: false,
				instruction:
					'The legacy review bridge cannot post a comment; the review:\n' +
					req.body,
			};
		},
		// The legacy bridge has no PR-close capability — a clean no-op (keep the
		// branch), surfacing the disapproving review text.
		async closeRequestOnBranch(req) {
			return {
				closed: false,
				instruction:
					'The legacy review bridge cannot close a PR (branch kept); the ' +
					`disapproving review:\n${req.comment}`,
			};
		},
	};
}

/**
 * Default commit summary: the task's `title` frontmatter with any leading
 * `slug — ` (or `slug -`) prefix stripped, so a task titled
 * "complete — gate, mark done, …" yields "gate, mark done, …". Falls back to a
 * generic summary when the title is missing/unreadable.
 */
function defaultSummary(inProgressPath: string, slug: string): string {
	let title: string | undefined;
	try {
		title = readTitle(readFileSync(inProgressPath, 'utf8'));
	} catch {
		title = undefined;
	}
	return summaryFromTitle(title, slug);
}

/**
 * The PURE commit-summary derivation from a (possibly absent) item title — the
 * shared core of {@link defaultSummary} (file-read path) and the lifecycle's
 * EXPLICIT-title path (intake, whose output file is not written until {@link
 * IntegrationLifecycle.stage}, AFTER the title read). Strips a leading `slug — `
 * prefix; falls back to the generic summary when the title is missing/empty.
 */
function summaryFromTitle(title: string | undefined, slug: string): string {
	if (!title) {
		return 'complete work task';
	}
	// Strip a leading "slug" followed by an em-dash / en-dash / hyphen separator.
	const prefix = new RegExp(`^${escapeRegExp(slug)}\\s*[—–-]\\s*`, 'i');
	return title.replace(prefix, '').trim() || title;
}

/**
 * The sane single-line cap for a synthesised PR title (Half A). GitHub itself
 * accepts long titles, but a PR list/notification truncates ugly past ~72 chars;
 * we cap to keep the title scannable and guarantee it is never a run-on. Beyond
 * the cap we truncate and append an ellipsis (counted within the cap).
 */
export const PR_TITLE_MAX = 72;

/**
 * The task's raw `title:` frontmatter (NOT the commit-summary-stripped form),
 * or undefined when missing/unreadable. Used as the human-authored source for
 * the synthesised PR title.
 */
function readTaskTitle(taskPath: string): string | undefined {
	try {
		return readTitle(readFileSync(taskPath, 'utf8'));
	} catch {
		return undefined;
	}
}

/**
 * Synthesise the propose-mode PR TITLE runner-side (Half A) from data the runner
 * already has — NO agent text: `<type>(<slug>): <title>`, reusing the `--type`
 * convention (default `feat`). It is FORCED to a single line (newlines → spaces,
 * runs of whitespace collapsed) and CAPPED to {@link PR_TITLE_MAX} (truncating
 * with a trailing `…`), so it can NEVER be the multi-line run-on `gh ... --fill`
 * derives from the commit subject. When the task `title:` is missing it falls
 * back to the slug alone (`<type>(<slug>)`). Exported for unit tests of the
 * single-line + cap guarantee.
 */
export function synthesiseProposeTitle(input: {
	type: string;
	slug: string;
	title?: string;
}): string {
	const type = input.type.trim() || DEFAULT_TYPE;
	// Strip a leading `slug — ` / `slug -` prefix (some task titles repeat the
	// slug; the `<slug>` scope already carries it) and flatten to one line.
	const prefix = new RegExp(`^${escapeRegExp(input.slug)}\\s*[—–-]\\s*`, 'i');
	const cleanTitle = (input.title ?? '')
		.replace(prefix, '')
		.replace(/\s+/g, ' ')
		.trim();
	const composed =
		cleanTitle === ''
			? `${type}(${input.slug})`
			: `${type}(${input.slug}): ${cleanTitle}`;
	if (composed.length <= PR_TITLE_MAX) {
		return composed;
	}
	// Cap, reserving one char for the ellipsis (counted within the cap).
	return composed.slice(0, PR_TITLE_MAX - 1).trimEnd() + '…';
}

/**
 * Compose the propose-mode PR BODY (Half B): the supplied advisory prose (the
 * build agent's final summary, or a human `--body`) UNDER a deterministic runner
 * header that points a reviewer back to the task file. Returns `undefined` when
 * no body was supplied — so the provider degrades to today's `gh ... --fill` (no
 * regression); the header is ONLY scaffolded when there IS prose to carry.
 * Exported for unit tests of the header + pointer.
 */
export function composeProposeBody(input: {
	slug: string;
	body?: string;
}): string | undefined {
	const prose = input.body?.trim();
	if (!prose) {
		return undefined;
	}
	const header = `Task: \`${workItemRel('done', `${input.slug}.md`)}\``;
	return `${header}\n\n${prose}`;
}

/**
 * On a review APPROVE that carries ≥1 NON-BLOCKING finding, write ONE per-run
 * observation `work/notes/observations/review-nits-<slug>-<YYYY-MM-DD>.md` capturing all
 * of this run's non-blocking nits, so they get a durable, contract-native home
 * instead of evaporating (the block path already records BLOCKING findings as the
 * stuck reason on the item's per-item lock; the approve path dropped non-blocking ones — see
 * `work/findings/review-nonblocking-findings-disposition.md`).
 *
 * The RUNNER writes it (the review agent stays write-free). It is a PLAIN
 * pre-commit disk write — NOT the heavier `applyNeedsAttentionTransition`
 * move/commit/surface — so `performIntegration`'s subsequent done-move + atomic
 * `git add -A` commit sweeps it into the SAME done-commit on every path
 * (merge / propose / CI, `do` AND `run`); it is never left dangling/uncommitted.
 *
 * ZERO non-blocking findings ⇒ writes NOTHING (no empty-file spam). The file is
 * ONE-per-RUN (a content-derived, dated name), never an append to a shared ledger
 * — the dated `<slug>-<date>` name makes a later-abandoned run's nit-observation
 * trivially findable + deletable (lifecycle hygiene). Frontmatter mirrors the
 * `work/notes/observations/*.md` convention (`title` / `date` / `status: open`) plus a
 * `reviewOf:` back-pointer to the slug it came from, so it gets triaged like any
 * observation. (Identity stays the FILENAME — no `slug:` frontmatter — so the
 * lifecycle enumerate→resolve round-trip is total; see task
 * `observation-identity-is-its-filename-not-a-foreign-slug`.)
 */
function writeReviewNitsObservation(params: {
	cwd: string;
	slug: string;
	findings: ReviewFinding[];
	note: (message: string) => void;
}): void {
	const nits = params.findings.filter((f) => f.severity === 'non-blocking');
	// No empty observations: an approve with zero non-blocking findings writes none.
	if (nits.length === 0) {
		return;
	}
	const date = observationDate();
	const obsDir = workFolderPath(params.cwd, 'observations');
	mkdirSync(obsDir, {recursive: true});
	const filename = `review-nits-${params.slug}-${date}.md`;
	writeFileSync(
		join(obsDir, filename),
		renderReviewNitsObservation({slug: params.slug, date, nits}),
	);
	params.note(
		`Recorded ${nits.length} non-blocking review nit(s) for '${params.slug}' ` +
			`in ${workItemRel('observations', filename)}.`,
	);
}

/** Today's date as `YYYY-MM-DD` (UTC), for the dated observation filename. */
function observationDate(): string {
	return new Date().toISOString().slice(0, 10);
}

/**
 * Render the per-run review-nits observation file body — `observations/`-convention
 * frontmatter (`title` / `date` / `status: open`) plus a `reviewOf:` back-pointer
 * naming the TASK the run reviewed, then each non-blocking finding (its
 * `question` + optional `context`), and a one-line note that these are review-gate
 * nits for triage (promote-to-task / keep / delete). Exported-free pure string
 * builder.
 *
 * Identity rule (task `observation-identity-is-its-filename-not-a-foreign-slug`):
 * the observation's IDENTITY is its FILENAME (`review-nits-<slug>-<date>.md`).
 * The frontmatter therefore does NOT emit `slug:` — emitting the reviewed task's
 * slug there collided with the (now-done) reviewed task AND broke the
 * enumerate→resolve round-trip (the lifecycle pool keyed off `fm.slug`, which
 * differed from the filename). The back-pointer lives in `reviewOf:` instead, a
 * clearly-different field whose name cannot be mistaken for identity.
 */
function renderReviewNitsObservation(input: {
	slug: string;
	date: string;
	nits: ReviewFinding[];
}): string {
	const findingBlocks = input.nits.map((f) => {
		const ctx = f.context ? `\n  (${f.context})` : '';
		return `- ${f.question}${ctx}`;
	});
	return [
		'---',
		`title: review-gate non-blocking nits for '${input.slug}' (Gate 2 approve)`,
		`date: ${input.date}`,
		'status: open',
		`reviewOf: ${input.slug}`,
		'---',
		'',
		'## Non-blocking review findings',
		'',
		`The PR/code review gate (Gate 2) APPROVED '${input.slug}' but raised the`,
		'following non-blocking findings (nits). They do not block integration; this',
		'is their durable home for triage — promote-to-task / keep / delete.',
		'',
		...findingBlocks,
		'',
	].join('\n');
}

/** Read the `title:` scalar from a task's frontmatter block, or undefined. */
function readTitle(content: string): string | undefined {
	const normalized = content.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
	if (!normalized.startsWith('---\n')) {
		return undefined;
	}
	const lines = normalized.split('\n');
	const closing = lines.indexOf('---', 1);
	const block = closing === -1 ? lines.slice(1) : lines.slice(1, closing);
	for (const line of block) {
		const match = /^title\s*:\s*(.*)$/.exec(line);
		if (match) {
			const value = match[1].trim();
			return value === '' ? undefined : unquote(value);
		}
	}
	return undefined;
}

function unquote(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' || first === "'") && last === first) {
			return value.slice(1, -1);
		}
	}
	return value;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the index has no staged changes against HEAD (nothing to commit). */
async function nothingStaged(
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<boolean> {
	// `diff --cached --quiet` exits 0 when there is NOTHING staged, 1 when there is.
	const res = await gitSoft(['diff', '--cached', '--quiet'], cwd, env);
	return res.status === 0;
}

/**
 * The capture-bucket folders a rung's agent may write notes into (its
 * `capture-signal` reflex). REPORTED by {@link reportScoopedNotes} when the
 * runner's atomic commit scoops them. Deliberately NARROW (only the two capture
 * buckets) so accidental scratch files the agent left elsewhere are not announced
 * as captured signals — matching the observation's recommended scope.
 */
const CAPTURE_NOTE_DIRS = [
	workFolderPrefix('observations'),
	workFolderPrefix('findings'),
] as const;

/**
 * TRANSCRIBE the build agent's `## Decisions` block into the DONE RECORD: the
 * runner half of the builder's rationale channel (WORK-CONTRACT.md, "Where a
 * BUILDER's RATIONALE lives").
 *
 * The builder MUST surface a non-obvious in-scope decision for ratification, but
 * every home the contract used to offer it was UNREACHABLE: it does no git, it must
 * not edit the task body (`CLAIM-PROTOCOL.md`), and the done-move, the completion
 * commit and the PR body are all the RUNNER's. So an acceptance criterion like
 * "rationale recorded in the done record" was structurally unsatisfiable, and the
 * rationale scattered into a JSDoc, a changeset, or an invented
 * `work/notes/observations/decisions-<slug>.md` note (a BACKWARD artifact in a LIVE,
 * FORWARD bucket, so it can never be discharged). Reviewers then re-raised the
 * identical "no Decisions block in the done record" finding on task after task.
 *
 * The fix is structural, not exhortative: the builder emits the block on the ONE
 * surface it owns (its final report, which reaches us as `input.body`), and the
 * runner, already the owner of the done-move, appends it here. Properties that
 * matter:
 *
 *   - **Same commit.** The caller invokes this AFTER the `git mv` (so the record is
 *     written at its `tasks/done/` path) and BEFORE `git add -A` (so it rides the
 *     ONE atomic completion commit, never a second, dangling one).
 *   - **Verbatim.** The agent's prose is appended unaltered under a `## Decisions`
 *     heading; we add structure, never interpretation.
 *   - **Idempotent.** A record that ALREADY carries a `## Decisions` section is left
 *     untouched, so a `requeue` continue, or a re-run over an already-done-moved
 *     branch (`source: 'done'`), cannot append the same block twice.
 *   - **Best-effort.** No block, no record on disk, or an unreadable/unwritable file
 *     is a silent no-op: a rationale note must NEVER fail an otherwise-green
 *     completion (the same stance as {@link reportScoopedNotes}).
 */
function transcribeDecisionsIntoDoneRecord(params: {
	cwd: string;
	slug: string;
	output: string | undefined;
	note: (message: string) => void;
}): void {
	const {cwd, slug, output, note} = params;
	const decisions = extractDecisionsBlock(output);
	if (decisions === undefined) {
		return; // the common case: the agent recorded no in-scope decision.
	}
	const path = workItemPath(cwd, 'done', slug);
	if (!existsSync(path)) {
		return; // no done record to annotate (a lifecycle/degenerate shape).
	}
	try {
		const body = readFileSync(path, 'utf8');
		if (/^##\s+Decisions\s*$/m.test(body)) {
			return; // already transcribed (a continue/re-run): never duplicate.
		}
		const separator = body.endsWith('\n') ? '\n' : '\n\n';
		writeFileSync(path, `${body}${separator}## Decisions\n\n${decisions}\n`);
		note(
			`Recorded the agent's "## Decisions" block in ${workItemRel('done', `${slug}.md`)}.`,
		);
	} catch {
		// Best-effort: never fail a green completion over a rationale note.
	}
}

/**
 * SCOOP + REPORT the agent-authored CAPTURED NOTES this run's atomic commit is
 * landing (task `runner-scoops-captured-notes`). A rung's agent writes
 * capture-bucket files (`work/notes/observations/*`, `work/findings/*`) but does NO git
 * (Rule A); the caller's `git add -A` already STAGED them into THIS commit, so
 * they are tracked, not dropped. This extends Rule B: the runner REPORTS exactly
 * which note files landed — read from the STAGED set (`git diff --cached`), so it
 * reports what ACTUALLY reached the commit, never an assumption.
 *
 * It is honest reporting, the same model as the review-nits observation report:
 * a PLAIN read + `note(...)`, no extra git (the commit owns the files). Zero
 * captured notes ⇒ NOTHING is reported (the no-note case is byte-for-byte
 * unchanged). Read-only / best-effort: a failed status read reports nothing
 * rather than crashing the integrate. Because it lives in the shared core, BOTH
 * the build path AND the tasking path report identically — the channel is not
 * forked.
 */
async function reportScoopedNotes(
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
	note: (message: string) => void,
): Promise<void> {
	const notes = await stagedCaptureNotes(cwd, env);
	if (notes.length === 0) {
		return;
	}
	note(
		`Scooped ${notes.length} agent-authored captured note` +
			`${notes.length === 1 ? '' : 's'} into this commit: ${notes.join(', ')}.`,
	);
}

/**
 * The repo-relative paths of the capture-bucket files (`work/notes/observations/*`,
 * `work/findings/*`) STAGED for THIS commit — i.e. new-or-changed vs HEAD, exactly
 * what the runner is about to land. Read via `git diff --cached --name-only` so it
 * reflects the real staged set (`git add -A` already ran), filtered to the capture
 * buckets and sorted for a deterministic report. Best-effort: a non-zero status
 * reads as no notes (never crashes the integrate). Exported-free; pure read.
 */
async function stagedCaptureNotes(
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<string[]> {
	const res = await gitSoft(['diff', '--cached', '--name-only'], cwd, env);
	if (res.status !== 0) {
		return [];
	}
	return res.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((path) => CAPTURE_NOTE_DIRS.some((dir) => path.startsWith(dir)))
		.sort();
}

/**
 * The DURABLE `work/` status folders a slug's ledger file can resting-live in (the
 * one-slug-one-folder set the invariant is asserted over). After the capstone
 * cut-over (task `cutover-retire-slicing-advancing-markers-and-trim-folder-sets`,
 * spec `ledger-status-per-item-lock-refs`) the ONLY `work/` moves on `main` are the
 * durable resting transitions, so the source a build completes FROM is `backlog/`
 * (claim no longer moves the body, task
 * `cutover-claim-body-stays-and-complete-sources-from-backlog`) and the canonical
 * done-move destination is `done/`. The task regime's won't-proceed terminal
 * `tasks/cancelled/` is also a durable resting folder, so the one-slug-one-folder
 * guard covers it (a slug in `tasks/cancelled/` AND another durable folder is a
 * corrupt ledger to refuse). The
 * transient `in-progress`/`needs-attention` are GONE from `main`'s tree (they are
 * per-item lock-ref state now).
 */
/**
 * The folders {@link readArbiterLedgerPlacement} scans for a slug's source on the
 * arbiter: the durable `LEDGER_STATUS_FOLDERS` (`tasks-ready`/`done`/`cancelled`)
 * PLUS `tasks-backlog` (staging). Staging is included ONLY for the arbiter-side
 * source RESOLUTION of a `--allow-backlog` done-move (spec
 * `do-allow-backlog-drive-staged-tasks-without-promotion`) and the one-slug-one-
 * folder guard over the malformed "same slug in `tasks/ready/` AND `tasks/backlog/`"
 * state; it is DELIBERATELY NOT added to the shared `LEDGER_STATUS_FOLDERS` (which
 * ledger-lint's duplicate detection + the sibling-ledger reconcile reuse and which
 * deliberately omits the non-resting staging folder).
 */
const ARBITER_PLACEMENT_FOLDERS = [
	...LEDGER_STATUS_FOLDERS,
	'tasks-backlog',
] as const satisfies readonly WorkFolderKey[];

/** One of the folders the arbiter placement read scans. */
type ArbiterPlacementFolder = (typeof ARBITER_PLACEMENT_FOLDERS)[number];

/** The result of {@link readArbiterLedgerPlacement}. */
interface ArbiterLedgerPlacement {
	/**
	 * Set when the ONE-SLUG-ONE-FOLDER guard FAILED LOUD: the arbiter already holds
	 * the slug in >1 status folder with DIFFERING content (a corrupt ledger). The
	 * caller maps it to the `invariant-violation` outcome and refuses — nothing is
	 * published over the corruption.
	 */
	error?: string;
	/**
	 * The NON-`done` status folders the ARBITER currently holds the slug in (e.g.
	 * `['in-progress']` or `['needs-attention']`). Empty when the arbiter holds it
	 * only in `done/`, holds it nowhere, or the tracking ref could not be read.
	 */
	sourceFolders: string[];
}

/**
 * Read WHICH `work/<folder>/<slug>.md` the ARBITER currently holds the slug in,
 * from the `<arbiter>/main` TRACKING REF (the source of truth). It is a pure READ
 * of the ref the caller has ALREADY fetched (the step-4 rebase fetch) — it does
 * NOT fetch, so it never races a sibling job's integration on the shared
 * bare-mirror refs (ADR §2; a new fetch here was the regression that orphaned
 * this very work).
 *
 * It ENFORCES the one-slug-one-folder invariant: if the arbiter already holds the
 * slug in MORE THAN ONE status folder it is a pre-existing corrupt ledger — it
 * FAILS LOUD (returns an `error`) rather than silently pick one, UNLESS it is
 * PROVABLY SAFE (every copy is byte-identical, so the canonical `done/`
 * destination is unambiguous), mirroring the manual `279b542` cleanup.
 *
 * It scans {@link ARBITER_PLACEMENT_FOLDERS} — the durable `LEDGER_STATUS_FOLDERS`
 * PLUS `tasks-backlog`, so a `--allow-backlog` staged drive (spec
 * `do-allow-backlog-drive-staged-tasks-without-promotion`) whose done-move sources
 * from `tasks/backlog/` is DISCOVERED here too (the arbiter is the authority for
 * the actual source folder; the local `source` is the fallback). Including staging
 * also makes the one-slug-one-folder guard cover the malformed "same slug in both
 * `tasks/ready/` and `tasks/backlog/`" state (the spec's decision 5): it FAILS LOUD
 * rather than the resolver silently arbitrating a collision the contract forbids.
 */
function readArbiterLedgerPlacement(
	cwd: string,
	arbiter: string,
	slug: string,
	env: NodeJS.ProcessEnv | undefined,
): ArbiterLedgerPlacement {
	const arbiterRef = `${arbiter}/main`;
	const placements: {folder: ArbiterPlacementFolder; blob: string}[] = [];
	for (const folder of ARBITER_PLACEMENT_FOLDERS) {
		const path = workItemRel(folder, `${slug}.md`);
		const ls = run('git', ['ls-tree', arbiterRef, path], cwd, {env});
		const line = ls.stdout.trim();
		if (ls.status !== 0 || line === '') {
			continue;
		}
		const match = /^\d+ blob ([0-9a-f]+)\t/.exec(line);
		if (match) {
			placements.push({folder, blob: match[1]});
		}
	}
	const sourceFolders = placements
		.filter((p) => p.folder !== 'done')
		.map((p) => p.folder);

	if (placements.length > 1) {
		const uniqueBlobs = new Set(placements.map((p) => p.blob));
		const folders = placements
			.map((p) => workFolderPrefix(p.folder))
			.join(', ');
		if (uniqueBlobs.size !== 1) {
			return {
				error:
					`one-slug-one-folder invariant violated: '${slug}' is present in more ` +
					`than one status folder on ${arbiterRef} (${folders}) with DIFFERING ` +
					`content — refusing to publish a corrupt ledger. Resolve the duplicate ` +
					`(keep the correct copy, delete the stale one) and re-run; ` +
					`'dorfl scan'/'gc' surfaces such duplicates.`,
				sourceFolders,
			};
		}
		// Provably safe (byte-identical copies): the duplicate is auto-cleaned by the
		// divergent-done-move reconciliation, which moves the slug to `done/` ONLY.
	}
	return {sourceFolders};
}

/** The `work/<status>/` prefixes a ledger file can live under (no trailing `/`). */
const LEDGER_FOLDER_PREFIXES = LEDGER_STATUS_FOLDERS.map((folder) =>
	workFolderPrefix(folder),
);

/**
 * Classify a rebase-conflicted path: is it a SIBLING-slug ledger file (a
 * `work/<status>/<otherslug>.md` for some slug OTHER than `ourSlug`)? Returns
 * `false` for any code file AND for THIS slug's own ledger file (both must keep
 * routing to needs-attention — the sibling arm NEVER widens to code or own-ledger).
 */
function isSiblingLedgerPath(path: string, ourSlug: string): boolean {
	const prefix = LEDGER_FOLDER_PREFIXES.find((p) => path.startsWith(p));
	if (prefix === undefined) {
		return false; // not a ledger file at all — a code file (or non-ledger work/ file).
	}
	const rest = path.slice(prefix.length);
	if (!rest.endsWith('.md') || rest.includes('/')) {
		return false; // not a `<slug>.md` directly under the status folder.
	}
	const otherSlug = rest.slice(0, -'.md'.length);
	return otherSlug !== ourSlug; // OUR own ledger is NOT a sibling — it routes as today.
}

/**
 * Reconcile a SIBLING-SLUG ledger conflict during the step-4 rebase WITHOUT
 * aborting it (Race 2 of `run-fleet-claim-integrate-and-sibling-rebase-concurrency-safe`).
 * Called WHILE the rebase is still in progress (right after `git rebase` returned
 * non-zero): a sibling same-repo job landed its OWN `work/<status>/<otherslug>.md`
 * move on `<arbiter>/main` between our base and this rebase, so replaying our
 * commit conflicts on that OTHER slug's ledger file — a benign ledger-only
 * divergence, NOT a real code conflict.
 *
 * STRICT SCOPE (the safety fence): it reconciles ONLY when EVERY conflicted path
 * is a SIBLING slug's ledger file ({@link isSiblingLedgerPath}). If ANY conflicted
 * path is a CODE file, a non-ledger `work/` file, or THIS slug's OWN ledger file,
 * it does NOTHING (returns `false`) so the caller aborts + routes to
 * needs-attention exactly as today — it NEVER widens to code or own-ledger.
 *
 * The resolution takes the ARBITER's (rebased-onto) version of each sibling
 * ledger file (`git checkout --ours` — during a rebase `--ours` is the base we are
 * replaying ONTO, i.e. `<arbiter>/main`), stages it, and `git rebase --continue`s,
 * looping until the rebase completes (a later replayed commit could re-conflict on
 * a sibling ledger). Returns `true` once the rebase finished cleanly (the caller
 * falls through to integrate); returns `false` — leaving the rebase in progress —
 * when the conflict is out of scope (the caller aborts + routes).
 */
async function reconcileSiblingLedgerConflict(params: {
	cwd: string;
	arbiter: string;
	slug: string;
	env: NodeJS.ProcessEnv | undefined;
	note: (message: string) => void;
}): Promise<boolean> {
	const {cwd, arbiter, slug, env} = params;
	const arbiterRef = `${arbiter}/main`;

	// The conflicted (unmerged) paths of the failed rebase step. Read them WHILE the
	// rebase is still in progress (the caller invokes us right after the non-zero
	// rebase), BEFORE we abort — so we know what conflicted.
	const conflicted = (
		await gitSoft(['diff', '--name-only', '--diff-filter=U'], cwd, env)
	).stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '');
	if (conflicted.length === 0) {
		return false; // not a conflict we can reason about here — defer to the caller.
	}
	// SCOPE GATE: every conflicted path MUST be a SIBLING slug's ledger file. Any
	// code file / own-ledger / non-ledger work file disqualifies the WHOLE
	// reconciliation (never widen to code) — the caller aborts + routes.
	if (!conflicted.every((path) => isSiblingLedgerPath(path, slug))) {
		return false;
	}

	// Benign sibling-ledger divergence. Rather than the fragile in-progress
	// `git rebase --continue` (which mutates the shared-worktree branch ref mid-
	// rebase and flakes under same-repo fleet ref contention), ABORT and REDO our
	// own work as ONE clean commit on top of `<arbiter>/main` — the SAME safe
	// reset-and-redo pattern `reconcileDivergentDoneMove` uses. This automatically
	// takes the arbiter's version of EVERY sibling ledger file (they live in the
	// reset base, untouched) while preserving OUR agent edits + OUR done-move (kept
	// in the working tree by the mixed reset). NO semantic judgement, NO `--ours`/
	// `--theirs` heuristic on any code file.
	await gitSoft(['rebase', '--abort'], cwd, env);

	// Re-point the branch onto `<arbiter>/main`, KEEPING the working tree (our edits
	// + our done-move): a mixed reset moves HEAD + index to the arbiter base but
	// leaves the working tree intact. Our own changes stay in the tree. (`HEAD` was
	// restored to our work-branch tip by the abort above.)
	const reset = await gitSoft(
		['reset', '--mixed', '--quiet', arbiterRef],
		cwd,
		env,
	);
	if (reset.status !== 0) {
		return false;
	}
	// Take the ARBITER's placement of every SIBLING slug whose ledger conflicted: the
	// conflict means we touched a sibling's ledger file that the arbiter moved, so our
	// working-tree copy is STALE. Hard-restore EVERY ledger folder for each affected
	// sibling slug from the arbiter (index + working tree) and drop any stray copy our
	// tree still holds, so the sibling's OWN status-folder move (e.g. its done-move) is
	// honoured verbatim — never clobbered by our stale touch, never duplicated.
	const siblingSlugs = new Set<string>();
	for (const path of conflicted) {
		const prefix = LEDGER_FOLDER_PREFIXES.find((p) => path.startsWith(p));
		if (prefix !== undefined) {
			siblingSlugs.add(path.slice(prefix.length, -'.md'.length));
		}
	}
	for (const otherSlug of siblingSlugs) {
		for (const folder of LEDGER_STATUS_FOLDERS) {
			const ledgerPath = workItemRel(folder, `${otherSlug}.md`);
			const onArbiter =
				(
					await gitSoft(
						['cat-file', '-e', `${arbiterRef}:${ledgerPath}`],
						cwd,
						env,
					)
				).status === 0;
			if (onArbiter) {
				// The arbiter holds the sibling here — take its exact copy.
				await gitSoft(['checkout', arbiterRef, '--', ledgerPath], cwd, env);
			} else {
				// The arbiter does NOT hold the sibling here — drop any stale copy ours has.
				const abs = join(cwd, ledgerPath);
				if (existsSync(abs)) {
					rmSync(abs, {force: true});
				}
			}
		}
	}
	// Stage everything (our agent edits + our arbiter-aligned ledger move; the
	// sibling ledgers are already at the arbiter version) and commit ONE clean
	// commit on top of `<arbiter>/main`. Nothing staged ⇒ the work is already on the
	// arbiter (an already-integrated no-op) — treat as cleanly reconciled.
	await gitSoft(['add', '-A'], cwd, env);
	if ((await gitSoft(['diff', '--cached', '--quiet'], cwd, env)).status === 0) {
		return true;
	}
	await gitHard(
		[
			'commit',
			'-q',
			'-m',
			`feat(${slug}): reconcile sibling-ledger rebase; done`,
		],
		cwd,
		env,
	);
	return true;
}

/**
 * Recover a DIVERGENT-BASE done-move whose plain rebase CONFLICTED (ledger-
 * integrity defect 1, the PR #86 ghost). The arbiter holds the slug's source in a
 * DIFFERENT folder than our local done-move removed, so replaying the local
 * `-work/<localsrc>/<slug>.md +work/done/<slug>.md` patch onto `<arbiter>/main`
 * (which lacks `<localsrc>`) conflicts on the ledger file.
 *
 * It reconciles WITHOUT any semantic judgement (so it is safe automatically,
 * unlike a real code conflict): RESET the work branch onto `<arbiter>/main` (the
 * working tree kept), then redo the done-move ARBITER-RESOLVED — remove the slug
 * from EVERY non-`done` folder the arbiter holds it in, write `work/done/<slug>.md`
 * — and commit ONE done commit on top of `<arbiter>/main`. The branch ends cleanly
 * on the arbiter with the slug in `done/` ONLY (the move is a MOVE, not a copy);
 * no further rebase is needed.
 *
 * Returns `true` on success (the caller falls through to integrate). Returns
 * `false` when this is NOT the divergent-ledger case (the arbiter holds the slug
 * only in `done/`/nowhere, or the placement read failed) so the caller routes the
 * genuine conflict to needs-attention unchanged.
 */
async function reconcileDivergentDoneMove(params: {
	cwd: string;
	arbiter: string;
	slug: string;
	branch: string;
	/** The folder the LOCAL done-move removed the slug from (its `git mv` source). */
	localSource: 'tasks-ready' | 'tasks-backlog' | 'in-progress';
	env: NodeJS.ProcessEnv | undefined;
	note: (message: string) => void;
}): Promise<boolean> {
	const {cwd, arbiter, slug, localSource, env} = params;
	const arbiterRef = `${arbiter}/main`;

	// The arbiter's current placement (read from the already-fetched ref — no
	// fetch). This recovery applies ONLY to the divergent-LEDGER conflict: the
	// arbiter holds the slug's source in a DIFFERENT folder than our local done-move
	// removed it from. When the arbiter's source folder MATCHES our local source (or
	// the arbiter holds it only in `done/`/nowhere), the rebase conflict is a
	// genuine CODE conflict (e.g. the agent's edits vs an advanced main) — NEVER
	// auto-resolved; defer to the needs-attention route.
	const placement = readArbiterLedgerPlacement(cwd, arbiter, slug, env);
	if (placement.error || placement.sourceFolders.length === 0) {
		return false;
	}
	if (placement.sourceFolders.includes(localSource)) {
		// The arbiter still holds the slug in the SAME source folder we moved from —
		// the ledger placement agrees, so the conflict is NOT a divergent-ledger one.
		return false;
	}

	// Capture the slug's ledger content (our tip's done/ copy, or any source copy)
	// BEFORE we reset — it is what lands in `done/`.
	let ledgerContent: string | undefined;
	// Scan the ARBITER-placement set (durable folders PLUS `tasks-backlog`) so a
	// `--allow-backlog` staged-drive's source copy is captured too. `done` first so
	// our tip's already-moved copy wins.
	const captureOrder: readonly ArbiterPlacementFolder[] = [
		'done',
		...ARBITER_PLACEMENT_FOLDERS,
	];
	for (const folder of captureOrder) {
		const abs = workItemPath(cwd, folder, slug);
		if (existsSync(abs)) {
			ledgerContent = readFileSync(abs, 'utf8');
			break;
		}
	}

	// Re-point the branch onto `<arbiter>/main`, KEEPING the working tree (the
	// agent's edits + our done/ file): a mixed reset moves HEAD + the index to the
	// arbiter base but leaves the working tree intact. We then fix only the LEDGER
	// placement against the arbiter and commit one clean done commit.
	const reset = await gitSoft(
		['reset', '--mixed', '--quiet', arbiterRef],
		cwd,
		env,
	);
	if (reset.status !== 0) {
		return false;
	}

	// Arbiter-resolved ledger placement: write `done/` from the captured content,
	// and remove every non-`done` copy (the arbiter's source folder is now checked
	// out by the reset; any stale local source is swept too).
	mkdirSync(workFolderPath(cwd, 'done'), {recursive: true});
	const donePath = workItemPath(cwd, 'done', slug);
	if (ledgerContent !== undefined) {
		writeFileSync(donePath, ledgerContent);
	}
	// Sweep every non-`done` copy the arbiter could hold the slug in, INCLUDING
	// `tasks-backlog` (a `--allow-backlog` staged drive), so the move is a MOVE not
	// a copy.
	for (const folder of ARBITER_PLACEMENT_FOLDERS) {
		if (folder === 'done') {
			continue;
		}
		const abs = workItemPath(cwd, folder, slug);
		if (existsSync(abs)) {
			rmSync(abs, {force: true});
		}
	}

	// Stage everything (agent work + the arbiter-aligned ledger move) and commit a
	// single done commit on top of `<arbiter>/main`. Nothing staged ⇒ the slug is
	// already done on the arbiter (an already-integrated no-op) — treat as cleanly
	// reconciled.
	await gitSoft(['add', '-A'], cwd, env);
	if ((await gitSoft(['diff', '--cached', '--quiet'], cwd, env)).status === 0) {
		return true;
	}
	await gitHard(
		['commit', '-q', '-m', `feat(${slug}): reconcile done-move; done`],
		cwd,
		env,
	);
	return true;
}

/**
 * The outcome of the Gate-2 review run ({@link runGate2Review}): either it BLOCKED
 * (a ready-to-return {@link IntegrationCoreResult}) or it APPROVED (the verdict to
 * carry).
 */
type Gate2ReviewOutcome =
	| {kind: 'blocked'; result: IntegrationCoreResult}
	| {
			kind: 'approved';
			verdict: ReviewVerdict | undefined;
	  };

/**
 * Run the Gate-2 PR/code REVIEW gate against a given tree ({@param reviewCwd}) and
 * route a BLOCK to needs-attention, returning DATA the caller acts on. Factored out
 * of {@link performIntegration} so the SAME gate can run in TWO places without
 * forking its logic (MAINTAINER DECISION 2, task `gate-on-rebased-tip-fresh-worktree`):
 *
 *   - fresh-worktree gate OFF: the caller invokes it at the FRONT on the pre-rebase
 *     `cwd`, right after the front `verify` (today's order, byte-for-byte);
 *   - fresh-worktree gate ON: the caller invokes it on the REBASED TIP (the fresh
 *     gate worktree), right AFTER the rebased-tip `verify` passes — so
 *     verify-THEN-review holds on the SAME merged tree.
 *
 * The review AGENT inspects {@param reviewCwd} (the tree under review); the
 * needs-attention ROUTING always targets `params.cwd` (where the work branch +
 * ledger live), so the routing is identical whichever tree was reviewed — ONLY the
 * source of the reviewed tree moved, not the verdict handling.
 *
 * It NEVER mutates `mode` or writes the nits observation itself (those are the
 * caller's concern, because WHEN they happen differs by path — pre-commit on OFF,
 * post-commit-amend on ON); it returns the verdict and lets the caller place those
 * effects correctly for its band position.
 */
async function runGate2Review(params: {
	/** The tree the review AGENT inspects (pre-rebase `cwd` OFF; rebased tip ON). */
	reviewCwd: string;
	input: IntegrationCoreInput;
	slug: string;
	branch: string;
	/** Where the work branch + ledger live (the needs-attention routing target). */
	cwd: string;
	env: NodeJS.ProcessEnv | undefined;
	note: (message: string) => void;
}): Promise<Gate2ReviewOutcome> {
	const {reviewCwd, input, slug, branch, cwd, env, note} = params;
	const reviewGate = input.reviewGate;
	if (!reviewGate) {
		// `review` on with no gate wired is a usage error — the floor must never be
		// silently skipped. (Production always wires `harnessReviewGate`.) The caller's
		// try/catch maps a thrown error to its usage-error outcome.
		throw new Error(
			`review is on but no review gate is configured — cannot run Gate 2 ` +
				`for '${slug}' (this is a wiring bug; the gate must not be skipped).`,
		);
	}
	const maxRounds = Math.max(1, input.reviewMaxRounds ?? 2);
	note('Running the PR/code review gate (Gate 2)…');
	// CORROBORATED-APPROVAL semantics (NOT retry-until-pass): the gate runs the
	// reviewer up to `reviewMaxRounds` times on the SAME tip and approves ONLY if
	// EVERY round approves. A `block` is TERMINAL — it short-circuits the loop and
	// is never re-rolled, because the reviewer is stochastic and re-reviewing an
	// UNCHANGED tip after a block would just be a dice re-roll that could launder a
	// real reject into a pass. The extra rounds therefore exist to make a FALSE
	// APPROVE harder to slip through (a second reviewer gets a veto), never to give
	// blocked work a second chance. (A future builder-REVISE step that mutates the
	// tree between rounds is the ONLY thing that should make a block retryable; it
	// would change the artifact under review and is not implemented here.)
	let approved = false;
	let lastVerdict: ReviewVerdict | undefined;
	for (let round = 1; round <= maxRounds; round++) {
		let verdict: ReviewVerdict;
		try {
			verdict = await reviewGate({
				slug,
				cwd: reviewCwd,
				reviewModel: input.reviewModel,
				round,
				// `--watch` threading (task `watch-review-session`): when on, the production
				// gate tails the review session live. OFF ⇒ the plain sync launch, unchanged.
				watch: input.watch,
				watchSink: input.watchSink,
				color: input.color,
				sessionsDir: input.sessionsDir,
				// The review AGENT launches with the AMBIENT env, never the identity-scoped
				// `env` (an agent must not act as the bot). Falls back to `env` when no
				// identity is configured (unchanged for non-identity callers).
				env: input.agentEnv ?? env,
			});
		} catch (err) {
			if (!(err instanceof ReviewParseError)) {
				// Anything else (a harness/connection throw, a programmer bug) is NOT this
				// gate's concern — re-throw so the existing catch sites classify it.
				throw err;
			}
			// THE GATE RAN BUT ITS VERDICT WAS UNREADABLE (direction 1, the safety net):
			// the reviewer did NOT block — the gate's OUTPUT could not be parsed (a
			// malformed JSON verdict, common on large diffs + weaker models, AFTER the
			// direction-2 repair pass could not salvage it). WITHOUT this catch the throw
			// escapes the core and `performComplete` maps it to the generic `usage-error`
			// (verbatim, no push, no surface) AFTER the green build but BEFORE the
			// done-move/push — STRANDING the lock + work branch with no PR.
			//
			// A parse failure in ANY round is TERMINAL: route IMMEDIATELY, never re-roll
			// the remaining rounds (mirroring the block-is-terminal rule — re-reviewing
			// the same tip would just be the dice re-roll the corroboration loop forbids).
			// We route through the SAME work-preserving `applyNeedsAttentionTransition`
			// seam the block path uses (it PUSHES the work branch + surfaces the item on
			// `surfaceArbiter` for the autonomous path), targeting `cwd` (the work branch +
			// ledger), NOT the throwaway `reviewCwd` — so BOTH the direct `!freshWorktreeGate`
			// path AND the fresh-worktree `review:` callback are covered by this ONE catch.
			// The recorded reason carries the parse-failure phrase the `failure-cause.ts`
			// signature matches → the `do`/`run` tail classifies it `transient-infra`
			// (retry the SAME work: the gate output is STOCHASTIC, so a re-run CAN differ,
			// and the direction-2 repair makes a re-run far more likely to parse). NEVER a
			// silent approve.
			const reason =
				`PR/code review (Gate 2) ran but its verdict could not be parsed: ` +
				`${err.message}`;
			const routed = await ledgerWrite.applyNeedsAttentionTransition({
				cwd,
				slug,
				reason,
				arbiter: input.surfaceArbiter,
				env,
				note,
			});
			const message = routed.moved
				? `PR/code review (Gate 2) produced an UNPARSEABLE verdict for '${slug}'; ` +
					'marked it stuck on its per-item lock (work branch pushed + lock ' +
					'surfaced; transient-infra — re-run). NOT integrated.'
				: `PR/code review (Gate 2) produced an UNPARSEABLE verdict for '${slug}'; ` +
					'NOT integrating.';
			note(message);
			return {
				kind: 'blocked',
				result: {
					outcome: 'review-unparseable',
					routedToNeedsAttention: routed.moved,
					branch,
					reason,
				},
			};
		}
		lastVerdict = verdict;
		if (verdict.verdict !== 'approve') {
			// A `block` is TERMINAL: stop now (never re-roll an unchanged tip) and route
			// the blocking findings to needs-attention below. `approved` stays false.
			approved = false;
			break;
		}
		// An `approve`: provisionally approved, but keep going — every remaining round
		// must ALSO approve for the gate to pass (corroboration, not first-approve-wins).
		approved = true;
	}
	if (!approved) {
		// NON-approve verdict: route to needs-attention via the SAME seam the red gate
		// uses, NEVER integrate. We reach here EITHER because a round returned a
		// (terminal) block, OR because not every round corroborated the approve. The
		// reason records the last verdict's blocking findings (the proximate cause) plus
		// the `reviewMaxRounds` note (so a single-round block also reads correctly).
		const findingsReason = lastVerdict ? formatBlockReason(lastVerdict) : '';
		const reason =
			(findingsReason ? findingsReason + '\n' : '') +
			reviewRoundsExhaustedReason(maxRounds);
		const routed = await ledgerWrite.applyNeedsAttentionTransition({
			cwd,
			slug,
			reason,
			// Same autonomous-vs-human gate as the red-gate path: `do` passes the arbiter
			// (surface on main + push the branch), the human `complete` leaves it unset.
			arbiter: input.surfaceArbiter,
			env,
			note,
		});
		const message = routed.moved
			? `PR/code review (Gate 2) blocked '${slug}'; marked it stuck on its ` +
				'per-item lock (surfaced by status; the blocking findings are ' +
				'recorded on the lock entry). NOT integrated.'
			: `PR/code review (Gate 2) blocked '${slug}'; NOT integrating.`;
		note(message);
		return {
			kind: 'blocked',
			result: {
				outcome: 'review-blocked',
				routedToNeedsAttention: routed.moved,
				branch,
				reason: message,
				// The structured block reason (the blocking findings ONLY) for a caller
				// doing its OWN routing (the tasking path); the build path ignores it.
				reviewBlockReason: findingsReason || message,
			},
		};
	}
	note(`PR/code review (Gate 2) approved '${slug}'.`);
	return {
		kind: 'approved',
		verdict: lastVerdict,
	};
}

/** The result of {@link runFreshWorktreeGate}. */
interface FreshGateResult {
	/** True iff BOTH `prepare` and `verify` passed on the rebased-tip worktree. */
	passed: boolean;
	/** Which step failed (when `!passed`): the env-prep step or the acceptance gate. */
	kind?: 'prepare' | 'verify';
	/** The non-zero exit code of the failing step (when `!passed`). */
	exitCode?: number;
	/**
	 * The EXACT gate command that failed (`verify` kind only) — threaded from
	 * {@link RunVerifyResult.failedCommand} so the surfaced reason names WHICH step
	 * of a multi-command gate failed. Absent for a `prepare` failure (the prepare
	 * command is single + already named).
	 */
	failedCommand?: string;
	/**
	 * The TAIL of the failed gate command's output (`verify` kind only) — threaded
	 * from {@link RunVerifyResult.outputTail} so the surfaced question carries the
	 * actual error text.
	 */
	outputTail?: string;
	/**
	 * The Gate-2 REVIEW outcome, present ONLY when a review gate was supplied to the
	 * fresh gate AND `verify` passed (so the review ran AFTER it on the rebased tip).
	 * The caller routes a `blocked` and acts on an `approved` (carry the verdict,
	 * write the nits observation). Absent when no review was requested or `verify`
	 * failed (the review never ran).
	 */
	review?: Gate2ReviewOutcome;
}

/**
 * Run the acceptance gate (`prepare` then `verify`) in a CLEAN THROWAWAY worktree
 * cut from `commit` (the work branch tip AFTER it was rebased onto `<arbiter>/main`
 * — the would-be-integrated tip), then REAP the worktree (pass OR fail). This is
 * the fresh-worktree gate (task `gate-on-rebased-tip-fresh-worktree`): a green
 * gate provably describes the MERGED artifact, because the worktree is cut from the
 * COMMITTED, rebased tip — gitignored/uncommitted state in the agent's `cwd` cannot
 * leak in, and a change the integration rebase introduced IS gated.
 *
 * The worktree is registered on `cwd`'s git common dir (`git worktree add --detach`
 * run IN `cwd`), so it works for BOTH isolation strategies: an in-place clone
 * (`<cwd>/.git`) and a job worktree cut from a bare hub mirror (the mirror's git
 * dir). It is a TRANSIENT gate sandbox — distinct from the agent's job worktree — and
 * is ALWAYS removed afterwards (`git worktree remove --force` + a dir cleanup
 * fallback), never leaked (cross-ref the worktree-hygiene/reap discipline in
 * `gc.ts`). The throwaway worktree is fresh (no deps), so `prepare` runs in it
 * before `verify` (forced — `useMarker: false` — since it is per-gate); a failing
 * `prepare` short-circuits and never runs `verify` (the env could not be made
 * ready), surfaced distinctly as `kind: 'prepare'`.
 *
 * GATE-2 REVIEW (MAINTAINER DECISION 2): when a `review` callback is supplied (the
 * caller resolved `review` ON), the review runs HERE — AFTER the rebased-tip
 * `verify` passes, against THIS fresh gate worktree (the rebased tip) — so
 * verify-THEN-review holds on the SAME merged tree. The review runs INSIDE the
 * worktree's lifetime (before it is reaped), so the review agent inspects the
 * rebased tip. Its outcome is returned in {@link FreshGateResult.review} for the
 * caller to route/act on; the worktree is reaped regardless of the verdict.
 */
async function runFreshWorktreeGate(params: {
	cwd: string;
	commit: string;
	prepare?: VerifyConfig;
	verify?: VerifyConfig;
	env: NodeJS.ProcessEnv | undefined;
	note: (message: string) => void;
	/**
	 * Run the Gate-2 review on the rebased-tip worktree AFTER `verify` passes
	 * (verify-then-review on the merged tree). Supplied ONLY when `review` resolved
	 * ON; absent ⇒ the fresh gate runs prepare+verify only (no review). Receives the
	 * gate worktree dir (the tree to review) and returns the routed outcome.
	 */
	review?: (reviewCwd: string) => Promise<Gate2ReviewOutcome>;
}): Promise<FreshGateResult> {
	const {cwd, commit, env, note} = params;
	// A throwaway gate-sandbox dir OUTSIDE any tracked tree (the OS temp area), so it
	// can never be swept into a commit and is naturally disposable.
	const gateDir = mkdtempSync(join(tmpdir(), 'dorfl-fresh-gate-'));
	// `git worktree add` will refuse to add into a non-empty existing dir, so add a
	// child path under the (empty) mkdtemp dir.
	const worktreeDir = join(gateDir, 'tip');
	try {
		// Cut a CLEAN DETACHED worktree from the rebased tip. Detached (no branch) so it
		// never collides with the work branch already checked out in `cwd`.
		await gitHard(
			['worktree', 'add', '--quiet', '--detach', worktreeDir, commit],
			cwd,
			env,
		);
		note(
			'Running the acceptance gate (prepare then verify) on the rebased tip in ' +
				'a clean throwaway worktree…',
		);
		// prepare: a fresh worktree has no deps, so install BEFORE verify. Forced per
		// gate (`useMarker: false`) — this worktree is throwaway. Unset ⇒ a no-op.
		const prep = await ensurePrepared({
			cwd: worktreeDir,
			prepare: params.prepare,
			env,
			useMarker: false,
		});
		if (!prep.passed) {
			return {passed: false, kind: 'prepare', exitCode: prep.exitCode};
		}
		const gate = await runVerify({
			cwd: worktreeDir,
			verify: params.verify,
			env,
		});
		if (!gate.passed) {
			return {
				passed: false,
				kind: 'verify',
				exitCode: gate.exitCode,
				failedCommand: gate.failedCommand,
				outputTail: gate.outputTail,
			};
		}
		// GATE-2 REVIEW on the rebased tip, AFTER the green verify (verify-then-review
		// on the SAME merged tree). Runs while the worktree is still live (the review
		// agent inspects the rebased tip). The outcome is returned for the caller to
		// route/act on.
		const review = params.review ? await params.review(worktreeDir) : undefined;
		return {passed: true, review};
	} finally {
		// REAP the throwaway fresh-gate worktree (pass or fail) — never leak it. Remove the
		// git-registered worktree first (so the common dir has no dangling
		// registration), then best-effort drop the temp dir + prune.
		try {
			await gitSoft(['worktree', 'remove', '--force', worktreeDir], cwd, env);
		} catch {
			// best-effort
		}
		try {
			await gitSoft(['worktree', 'prune'], cwd, env);
		} catch {
			// best-effort
		}
		try {
			rmSync(gateDir, {recursive: true, force: true});
		} catch {
			// best-effort
		}
	}
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
