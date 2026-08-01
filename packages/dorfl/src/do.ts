import {existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {performStart} from './start.js';
import {performComplete} from './complete.js';
import {performClaim} from './claim-cas.js';
import {
	resolveSlug,
	SlugResolutionError,
	workBranchRef,
} from './slug-namespace.js';
import {performTask, type TaskResult} from './tasking.js';
import type {TaskReviewGate} from './tasker-review-loop.js';
import {
	resolveTask,
	buildAgentPrompt,
	resolveContinueContext,
	resolvePromptGuidanceForItem,
	PromptError,
} from './prompt.js';
import {NullHarness, type AgentTreeReap, type Harness} from './harness.js';
import {acquireWorktreeWriterLock} from './worktree-writer-lock.js';
import {PiHarness} from './pi-harness.js';
import {launchWithOptionalWatch} from './agent-launch.js';
import {ledgerRead, type LedgerReadStrategy} from './ledger-read.js';
import {
	ledgerWrite,
	type ApplyNeedsAttentionTransitionResult,
} from './ledger-write.js';
import type {SurfaceToNeedsAttentionResult} from './needs-attention.js';
import {
	jobWorktreeStrategy,
	selectIsolationStrategy,
	type IsolatedTree,
} from './isolation.js';
import {ensureMirror, encodeRepoKey, mirrorPath} from './repo-mirror.js';
import {jobWorktreePath} from './workspace.js';
import {reapJob} from './gc.js';
import {isGitHubArbiterUrl, GitHubProvider} from './github.js';
import type {ReviewProvider} from './integrator.js';
import {arbiterUrl} from './integration-core.js';
import {
	shouldFailProposePrIntent,
	PROPOSE_PR_INTENT_GH_UNAVAILABLE_MESSAGE,
} from './do-config.js';
import {
	checkGatePreconditions,
	detectLockfileOnDisk,
	detectLockfileOnMirrorMain,
} from './gate-readiness.js';
import type {IntegrationMode, PromptGuidance} from './config.js';
import type {VerifyConfig} from './verify.js';
import type {ReviewGate} from './review-gate.js';
import {git, run, runAsync, localMainAheadCount} from './git.js';
import {
	identityEnv,
	assertTransportAllowed,
	type Identity,
} from './identity.js';
import {
	parseStopSentinel,
	isWorkBranchDiffEmpty,
	emptyDiffStopReason,
	emptyDiffDisposeEnvelope,
	type AgentStopClass,
} from './agent-stop.js';
import {
	surfaceStuckToNeedsAttention,
	routeToNeedsAttention,
} from './needs-attention.js';
import {resolveItemPathByIdentity} from './item-path.js';
import {
	classifyFailureCause,
	failureCauseLabel,
	type FailureCause,
} from './failure-cause.js';

/**
 * `dorfl do <slug>` (in-place form) — the per-repo, in-place WORKER that
 * claims + builds + gates + integrates in ONE checkout, then EXITS (ADR §3).
 * **This is the CI command** (CI has a checkout, is one repo, is one triggered
 * invocation, exits) and it ABSORBS the manual `ar-run.sh` test-driver.
 *
 * In-place `do` is on the ISOLATION SEAM (`do-run-share-isolation-seam`): it is
 * the FIRST production consumer of `selectIsolationStrategy`/`inPlaceStrategy`,
 * so all THREE `do`/`run` forms (in-place `do`, `do --remote`, `run`) share the
 * ONE `IsolatedTree`-handle post-claim shape. The composition mirrors
 * `do --remote`/`run` exactly: keep the two in-place GUARDS (dirty-tree refusal
 * + pre-flight diverged-main guard) in this driver BEFORE onboarding, CLAIM
 * explicitly via the CAS (`performClaim`), then let
 * `selectIsolationStrategy({checkout}).prepare()` do the ONBOARDING half (fetch +
 * continue-detection + fresh-main `work/<slug>` switch, incl. the §14
 * continue/rebase + §10 conflict path) WITHOUT re-claiming. The agent run is the
 * ONLY new middle step (the one `ar-run.sh` shelled out for, `prompt | pi`). The
 * runner owns EVERY git-state transition (claim, done-move, completion commit,
 * integration); the agent only edits code.
 *
 * The in-place ISOLATION (ADR §3): the current checkout / CI container IS the
 * isolation — no hub mirror, no external worktree. `inPlaceStrategy.prepare()`
 * puts the checkout on `work/<slug>` cut from the freshly-fetched
 * `<arbiter>/main`; its handle's `teardown` is a NO-OP (the checkout is left in a
 * defined state on `work/<slug>`, NEVER reaped). `do --remote` (the job-worktree
 * strategy) is the SEPARATE `do-remote` task; auto-pick / multi-arg / `-n` is
 * `do-autopick`.
 *
 * CLAIM SEMANTICS (autonomous, same as `do --remote`/`run`): the claim is
 * explicit and claim-or-lose. An item that is NOT in the pool (`tasks-ready`) on
 * the arbiter (already in-progress / done / absent) is not claimable, so the CAS
 * returns
 * `lost` (exit 2) and the run skips cleanly — `do`, the unattended CI worker,
 * never re-claims an item someone else holds and never silently picks up a
 * needs-attention item (a human does that through the human face).
 *
 * **CRITICAL — `do` is AUTONOMOUS, so its failure path is `run`'s, NOT
 * `complete`'s.** On a red gate / rebase conflict, `performComplete` routes the
 * item to needs-attention via the SAME seam call as `run`'s `runOneItem`, but
 * `complete` calls it WITHOUT an arbiter (the human path: a human is right
 * there). `do` runs UNATTENDED, so it MUST get the autonomous, arbiter-passed
 * surfacing like `run` (the on-`main` cherry-pick that makes a stuck CI run
 * visible to `scan`/`status`/another machine). We achieve this by passing
 * `surfaceArbiter` into `performComplete` (resolution (a) from the task): the
 * success path reuses `complete`'s machinery; only the NEEDS-ATTENTION routing
 * becomes the autonomous variant.
 *
 * `--propose` (default) / `--merge` is resolved at integrate-time exactly like
 * `complete` (the caller threads the resolved mode in as `integration`).
 */

/**
 * The commit-message subject the deadline-checkpoint save writes, and the
 * pattern used to COUNT consecutive checkpoints on the branch (spec
 * `graceful-pre-timeout-wip-checkpoint` — the anti-loop ceiling). Living
 * on-branch means the counter naturally RESETS when the item completes (the
 * branch is discarded on integration) and when a `--reset` requeue discards
 * the branch: a genuinely-progressing task cannot silently accumulate a
 * ceiling breach across generations.
 */
const DEADLINE_CHECKPOINT_COMMIT_SUBJECT_PREFIX = 'chore(deadline-checkpoint)';

/**
 * Distinct reason strings for the two deadline-checkpoint branches (spec
 * `graceful-pre-timeout-wip-checkpoint` — the CI/human report must NEVER
 * collapse to a generic "agent-failed"). Auto-continue and surface carry
 * different phrasing so the counter + ceiling are legible.
 */
function deadlineAutoContinueReason(params: {
	slug: string;
	count: number;
	max: number;
}): string {
	return (
		`deadline checkpoint (auto-continued ${params.count}/${params.max}): ` +
		`'${params.slug}' hit the dorfl-internal deadline with new work-branch ` +
		`progress this session; saved the WIP and released the lock so the next ` +
		`tick continues from the branch tip.`
	);
}
function deadlineSurfaceReason(params: {
	slug: string;
	kind: 'no-progress' | 'ceiling' | 'unreaped';
	count?: number;
	max?: number;
	/** The harness's loud reap detail (the `unreaped` kind only). */
	detail?: string;
}): string {
	if (params.kind === 'unreaped') {
		// The auto-continue path is BLOCKED, not merely skipped: releasing the lock
		// would let a successor onboard into a worktree a live predecessor may still
		// be writing to (observation
		// `checkpoint-releases-lock-while-predecessor-agent-still-writes`). The work
		// is saved and pushed; only the hand-off is withheld.
		return (
			`deadline checkpoint (agent NOT verifiably stopped): '${params.slug}' hit ` +
			'the dorfl-internal deadline and its WIP was saved + pushed, but the agent ' +
			'process tree could not be confirmed dead, so the lock was NOT released and ' +
			'no successor was dispatched — a second agent in the same working tree can ' +
			'clobber or silently absorb the first one\u2019s edits. ' +
			`${params.detail ?? ''}`.trim()
		);
	}
	if (params.kind === 'no-progress') {
		return (
			`deadline checkpoint (no progress / ceiling): '${params.slug}' hit ` +
			`the dorfl-internal deadline WITHOUT any work-branch progress this ` +
			`session — indistinguishable from a wedge; surfaced for a human to ` +
			`decide (continue / split / cancel).`
		);
	}
	return (
		`deadline checkpoint (no progress / ceiling): '${params.slug}' has hit ` +
		`the dorfl-internal deadline ${params.count}/${params.max} times ` +
		`consecutively — it may be too big for one CI leg. Split it or run ` +
		`it locally; surfaced for a human to decide.`
	);
}

/**
 * Count how many DEADLINE-CHECKPOINT commits (subject prefix
 * `chore(deadline-checkpoint)`) currently sit on the work branch ahead of
 * `<arbiter>/main` — the branch-based anti-loop counter (spec
 * `graceful-pre-timeout-wip-checkpoint`). A best-effort count: an unreachable
 * arbiter / a bare mirror reads as 0 (the SAFE direction — never falsely block
 * an auto-continue) so a genuine plumbing fault degrades to "under the ceiling"
 * rather than surfacing a spurious ceiling breach. Resets naturally when the
 * item completes (the branch is discarded on integration).
 */
async function countDeadlineCheckpointsOnBranch(params: {
	cwd: string;
	arbiter: string;
	branch: string;
	env: NodeJS.ProcessEnv | undefined;
}): Promise<number> {
	const {cwd, arbiter, branch, env} = params;
	const range = `${arbiter}/main..HEAD`;
	void branch;
	const r = await runAsync('git', ['log', '--format=%s', range], cwd, {env});
	if (r.status !== 0) {
		return 0;
	}
	const lines = r.stdout.split('\n').filter((s) => s.length > 0);
	return lines.filter((s) =>
		s.startsWith(DEADLINE_CHECKPOINT_COMMIT_SUBJECT_PREFIX),
	).length;
}

/**
 * SAVE the WIP on a deadline stop (spec `graceful-pre-timeout-wip-checkpoint`,
 * build step 3): commit the tree as-is + push `work/<slug>`. Reuses the SAVE
 * HALF of the needs-attention mechanism ({@link routeToNeedsAttention}) but
 * ADDS a distinguishing checkpoint-marker commit on top so
 * {@link countDeadlineCheckpointsOnBranch} can count auto-continues. Distinct
 * from `applyNeedsAttentionTransition` (the whole thing) which ALSO marks the
 * lock stuck — auto-continue must NOT mark stuck; only the surface branch does.
 */
async function saveDeadlineCheckpoint(params: {
	slug: string;
	branch: string;
	cwd: string;
	arbiter: string;
	reason: string;
	env: NodeJS.ProcessEnv | undefined;
	note: (message: string) => void;
}): Promise<import('./needs-attention.js').RouteToNeedsAttentionResult> {
	const {slug, branch, cwd, arbiter, reason, env, note} = params;
	void reason;
	// Save any uncommitted work first (the routeToNeedsAttention save half also
	// commits + pushes; but we ALSO want a distinct checkpoint-marker commit so
	// countDeadlineCheckpointsOnBranch can enumerate them). Stage everything and
	// commit a MARKER commit if there's anything to record OR if there is not
	// already a marker on the tip — the marker's job is to make the checkpoint
	// COUNTABLE, not to represent new work.
	const addResult = await runAsync('git', ['add', '-A'], cwd, {env});
	void addResult;
	const diffCached = await runAsync(
		'git',
		['diff', '--cached', '--quiet'],
		cwd,
		{env},
	);
	const hasStaged = diffCached.status !== 0;
	if (hasStaged) {
		await runAsync(
			'git',
			[
				'commit',
				'-q',
				'-m',
				`${DEADLINE_CHECKPOINT_COMMIT_SUBJECT_PREFIX}: save wip for '${slug}'`,
			],
			cwd,
			{env},
		);
	}
	// Push the branch to the arbiter (best-effort). Reuse routeToNeedsAttention's
	// save-half exact contract: it commits any residue + pushes the branch with
	// bounded backoff. We already committed above; the wip commit inside
	// routeToNeedsAttention will be a no-op (clean tree) and the push runs.
	return routeToNeedsAttention({
		cwd,
		slug,
		reason: `deadline-checkpoint save for '${slug}' (see branch)`,
		arbiter,
		branch,
		note,
		env,
	});
}

/** The terminal status of one in-place `do` run. */
export type DoOutcome =
	| 'completed' // claimed/onboarded → agent → gate green → integrated → exited
	| 'lost' // claim lost the race — skipped cleanly
	| 'contended' // claim push kept being rejected
	| 'needs-attention' // red gate / rebase conflict / review-block → surfaced (autonomous)
	| 'surface-unmoved' // the tree-less surface to needs-attention did NOT land on the arbiter (lost the CAS race / no arbiter) — the item is STILL in-progress on the arbiter; retry/resolve
	| 'agent-failed' // the agent ran but produced bad/empty output (the conservative generic), OR the cause is unknown — work SAVED + surfaced
	| 'transient-infra' // a harness-surfaced model/connection outage (post-retry) or a git/provider outage — RETRY the same work (FAILURE-CAUSE axis)
	| 'needs-reauth' // a credential expired / was revoked (OAuth refresh) — retry cannot help; a human must RE-AUTH (FAILURE-CAUSE axis)
	| 'config-error' // a thrown CORE wiring/config error (e.g. review on, no reviewGate) — fix the WIRING, not the task (FAILURE-CAUSE axis)
	| 'agent-stopped' // the agent DELIBERATELY stopped (task drifted/ambiguous) OR produced no change → surfaced; gate + Gate-2 SKIPPED
	| 'deadline-auto-continued' // the dorfl-internal deadline fired; WIP saved + branch pushed + lock RELEASED (no sidecar) so the next tick continues (spec `graceful-pre-timeout-wip-checkpoint`)
	| 'deadline-surfaced' // the dorfl-internal deadline fired but auto-continue was refused (no progress this session, or the maxAutoCheckpoints ceiling was hit); WIP saved + question SURFACED for a human
	| 'refused' // refused (dirty tree, wrong folder, nothing to complete, …)
	| 'usage-error' // usage / environment problem, or a slug-resolution error
	| 'tasked' // `do spec:<slug>` — the spec was tasked into work/backlog/ (runner-owned)
	| 'gate-refused' // `do spec:<slug>` — the tasking gate refused (honest skip)
	| 'stale'; // `do spec:<slug>` — the held spec was edited under the lock (stale tasking)

export interface DoResult {
	exitCode: 0 | 1 | 2 | 3;
	outcome: DoOutcome;
	/** The resolved bare slug acted on (task or spec), when one was resolved. */
	slug?: string;
	/** The work branch the run operated on, when one was created/switched-to. */
	branch?: string;
	/**
	 * True iff a FAILURE (agent-failed) SAVED + surfaced the partial work via the
	 * needs-attention mechanism (committed the agent's work, pushed the
	 * `work/<slug>` branch, surfaced on the arbiter's main) rather than dropping it.
	 * Undefined/false on the success, lost/contended/refused, and usage-error paths.
	 */
	routedToNeedsAttention?: boolean;
	/** Human-readable summary of the terminal condition. */
	message: string;
}

/** The agent invocation: edits code in `cwd` to satisfy the prompt. */
export type DoDorfl = (input: {
	cwd: string;
	prompt: string;
	slug: string;
	env?: NodeJS.ProcessEnv;
}) => {
	ok: boolean;
	detail?: string;
	/**
	 * The agent's FINAL SUMMARY (the harness seam's `LaunchResult.output`): the
	 * channel the propose-mode PR BODY is built from. Optional so a test agent may
	 * supply a body; production surfaces the build agent's last assistant message.
	 * Absent ⇒ no body ⇒ the provider degrades to `--fill` (no regression).
	 */
	output?: string;
	/**
	 * **True iff the injected agent simulates a dorfl-internal DEADLINE stop**
	 * (spec `graceful-pre-timeout-wip-checkpoint`). Test-only signal so an
	 * injected `DoDorfl` can drive the checkpoint routing (save WIP +
	 * auto-continue / surface). Production `runDoAgent` never sets this on the
	 * injected path — the real deadline race lives in `PiHarness.launchAsync`.
	 */
	timedOut?: boolean;
	/**
	 * **The simulated process-tree REAP verdict** for a {@link timedOut} stop
	 * (observation `checkpoint-releases-lock-while-predecessor-agent-still-writes`).
	 * Test-only signal, the sibling of `timedOut`, so an injected agent can drive
	 * the "predecessor could not be verified dead" routing — where the checkpoint
	 * must NOT release the item lock, because the next tick would then onboard a
	 * successor into a working tree the predecessor may still be writing to.
	 * Absent ⇒ nothing was left running (the pre-existing behaviour).
	 */
	reap?: AgentTreeReap;
};

export interface DoOptions {
	/** The raw CLI slug argument: bare (= task), `task:<slug>`, or `spec:<slug>`. */
	arg: string;
	/** The working clone/checkout to run in-place in. */
	cwd: string;
	/** Name of the arbiter git remote. Defaults to `origin`. */
	arbiter?: string;
	/**
	 * The optional runner IDENTITY (a bot), threaded from host-only
	 * `config.identity`. Scopes the runner's GIT/provider ops (claim, push,
	 * integrate, `gh`) — NEVER the agent launch (the agent stays ambient; it must
	 * not commit as the identity). Absent ⇒ ambient. See {@link identityEnv}.
	 */
	identity?: Identity;
	/**
	 * Per-repo `autoTask` policy (resolved by `autoslice-gate`: flag > env >
	 * per-repo > global > default false). It gates the AUTO-PICK / pool path only
	 * (`do-autopick.ts`'s taskable-spec pool): "may an agent auto-task an
	 * UNDECLARED spec in this repo?". An EXPLICITLY-named `do spec:<slug>` tasks
	 * REGARDLESS of this policy (the dispatch passes `explicit: true` to
	 * `performTask` — naming the spec IS the authorization, exactly as `do <task>`
	 * builds regardless of `autoBuild`). Ignored by the task-build path.
	 */
	autoTask?: boolean;
	/**
	 * The resolved {@link PromptGuidance} NUDGE namespace (e.g. `testFirst`),
	 * threaded from the per-repo config by the CLI and forwarded INTO
	 * {@link buildAgentPrompt} so the autonomous in-place `do` worker prompt
	 * actually carries the nudge. Absent ⇒ every member false ⇒ byte-identical to
	 * today. (Without this the per-repo `promptGuidance.testFirst` was a silent
	 * no-op on the build path — only `dorfl prompt` honoured it.)
	 */
	promptGuidance?: PromptGuidance;
	/**
	 * **The tasker review→edit→converge LOOP seam** (`slicer-review-edit-loop`):
	 * consumed ONLY by the `do spec:<slug>` tasking path — after the agent produces
	 * candidate tasks, run the `review` SKILL as a review→edit→re-review loop that
	 * improves them, routing the verdict through the needsAnswers / needs-attention
	 * sink. Ignored by the task-build path. Omitted ⇒ no loop (candidate tasks land
	 * as-is). Production wires {@link harnessTaskReviewGate}; tests inject a canned
	 * verdict+edits.
	 */
	reviewLoop?: TaskReviewGate;
	/** The tasker improver loop's `taskerLoopMax` cap (flag > env > per-repo > global > default). Loop only. */
	taskerLoopMax?: number;
	/** The tasker improver loop's de-correlated review model (`--tasker-loop-model`). Loop only. */
	taskerLoopModel?: string;
	/** How many fresh-context (M) executions of the tasker loop to run. Default 1. Loop only. */
	reviewExecutions?: number;
	/** Integration mode resolved at integrate-time (flag > per-repo > global > default). */
	integration?: IntegrationMode;
	/**
	 * **The explicit `--merge` override** for the untrusted-origin build-propose rule
	 * (task `untrusted-origin-forces-build-propose`). `true` iff the operator
	 * EXPLICITLY typed `--merge` (vs `merge` resolved from config). Forwarded to the
	 * task-BUILD `performComplete` → `performIntegration` so an explicit `--merge`
	 * OVERRIDES the untrusted-origin build-propose rule. The autonomous/CI path (a bare
	 * `advance`/`do` auto-pick) passes no flag ⇒ unset ⇒ an untrusted-origin task
	 * reliably forces `propose`. (Build transition only; the tasking transition is
	 * unaffected — a task FILE landing on main is inert.)
	 */
	explicitMerge?: boolean;
	/**
	 * **Per-TRANSITION override for the TASKING transition only** (config
	 * `taskingIntegration`). Consumed ONLY by the `do spec:<slug>` tasking path: the
	 * value threaded into {@link performTask} is `taskingIntegration ?? integration`,
	 * so an unset override is byte-for-byte today's behaviour (tasking uses
	 * `integration`). The task-BUILD path ALWAYS threads `integration` (never this
	 * key). An explicit `--merge`/`--propose` flag wins over BOTH (the flag-override
	 * layer sets `integration` AND `taskingIntegration` to the typed mode — see
	 * `do-config.ts`). DISTINCT from intake's per-EMITTED-TYPE `{task, spec}` resolver.
	 */
	taskingIntegration?: IntegrationMode;
	/**
	 * **The per-repo TASK-PLACEMENT default** (spec
	 * `staging-pool-position-gate-and-trust-model` US #5, task
	 * `runner-deterministic-slice-placement-policy-and-precedence`). Consumed by
	 * the `do spec:<slug>` tasking path: the value is fed as the
	 * CONFIGURED-DEFAULT rung into the runner-deterministic placement resolver
	 * (`src/placement.ts`). Resolved per-repo through the SAME chain as
	 * `taskingIntegration` (flag > env > per-repo > global > built-in
	 * `backlog`). The task-BUILD path ignores it (placement is a TASKING
	 * lifecycle concern).
	 */
	tasksLandIn?: 'backlog' | 'ready';
	/**
	 * **The per-repo UNTRUSTED-side TASK-PLACEMENT default** (spec
	 * `untrusted-origin-carries-via-stamp-intake-placement-symmetry-and-ci-gate-resolution`,
	 * ADR `untrusted-origin-carries-via-stamp-not-forced-staging`). Threaded into
	 * {@link performTask}, which selects it (over {@link tasksLandIn}) as the
	 * configured-default rung when the tasked spec carries an
	 * `originTrust: untrusted` stamp. See {@link performTask}'s
	 * `untrustedTasksLandIn`.
	 */
	untrustedTasksLandIn?: 'backlog' | 'ready';
	/**
	 * **The OPERATOR's EXPLICIT task-placement override** (the TOP precedence
	 * rung in the placement resolver). Set ONLY when the operator typed
	 * `--tasks-land-in <where>` on this invocation; never when the value came
	 * from config. Wins over the configured default (the operator is present;
	 * CLI always wins, no special force-key) — the positional analogue of
	 * `explicitMerge` overriding the untrusted-origin build-propose rule.
	 */
	explicitTasksLandIn?: 'backlog' | 'ready';
	/**
	 * Override the pre-flight DIVERGENCE guard (`--ignore-diverged-main`, mirroring
	 * `--ignore-not-ready`): proceed even when local `main` is ahead of
	 * `<arbiter>/main` (has unpushed commits). When overridden and the divergence
	 * persists, `complete`'s now-NON-FATAL local-main sync handles the outcome
	 * honestly (the work lands on the arbiter; local `main` is left for the operator
	 * to rebase). Loud, never the default.
	 */
	ignoreDivergedMain?: boolean;
	/**
	 * **`--allow-backlog`** (spec
	 * `do-allow-backlog-drive-staged-tasks-without-promotion`): let this `do task:`
	 * invocation FIND, CLAIM, and COMPLETE a task that lives in `tasks/backlog/`
	 * (staging) IN PLACE, WITHOUT first promoting it to the pool — so no `advance`
	 * leg / `run` daemon can claim it out from under the operator. It widens ONLY
	 * resolution (`resolveTask` also searches `tasks-backlog`, lowest priority) +
	 * the claimable predicate (`performClaim` accepts a staged body); claim/lock/
	 * build/gate are identical, and the done-move goes `tasks/backlog/ → tasks/done/`
	 * directly (the explicit drive IS the promotion). EXPLICIT-INVOCATION-ONLY:
	 * default off, never set by `run`/auto-pick/`advance` (the leak-fence). The
	 * task-build path only; the `do spec:` path is unaffected.
	 */
	allowBacklog?: boolean;
	/** The declared per-repo ENV-PREP step (string | list), run ONCE before the
	 * first `verify` on a fresh worktree. Unset ⇒ a no-op (NO default install). */
	prepare?: VerifyConfig;
	/** The declared per-repo acceptance gate (string | list). */
	verify?: VerifyConfig;
	/**
	 * Run the acceptance gate against the REBASED tip in a clean throwaway worktree
	 * (the tree that integrates) when `true` (the default), else in the build
	 * worktree (the pre-rebase tree). `do` is a SINGLE-JOB path, so the resolved
	 * flag is passed UNCONDITIONALLY (no `run`-fleet downgrade).
	 */
	freshWorktreeGate?: boolean;
	/**
	 * **The cross-job merge-serialiser CAS-retry cap** (config `mergeRetries`, spec
	 * `land-time-reverify-and-parallel-merge-ceiling` Story 5 / Applied Answer q1
	 * (a)). Threaded VERBATIM into `performComplete` → `performIntegration` so a
	 * wide-matrix CI's raised cap actually reaches the cross-job land queue (the
	 * CAS loop IS the queue across separate jobs). Resolved per-repo through the
	 * gate-family precedence chain (flag > env > per-repo > global > default).
	 */
	mergeRetries?: number;
	/**
	 * **The PR-INTENT axis** (config `noPR`, ADR §6): when `true`, propose pushes
	 * the branch but deliberately skips the PR (the explicit suppress-PR intent).
	 * NOT a provider choice — the provider is purely arbiter-derived. Threaded
	 * verbatim into `performComplete`. Unset/false ⇒ propose opens the PR normally.
	 */
	noPR?: boolean;
	/**
	 * The `gh` AUTH/AVAILABILITY PROBE the PR-INTENT pre-flight guard runs UP FRONT
	 * (propose + GitHub arbiter + `noPR` unset): `true` ⇒ `gh` CAN open a PR. The
	 * probe is the signal (mirroring `GitHubProvider.available`), NOT a config check
	 * — an absent identity falls back to ambient `gh` auth and the probe reports it
	 * available. Injectable so tests stub `gh` without a real binary; production
	 * defaults to `new GitHubProvider().available(cwd, env)`. Side-effecting (it
	 * shells `gh`), a deliberate pre-flight cost justified by saving a wasted build.
	 */
	ghCanOpenPr?: (cwd: string, env: NodeJS.ProcessEnv | undefined) => boolean;
	/**
	 * Optional FULLY-FORMED review provider INSTANCE used VERBATIM (the SAME seam
	 * `run` exposes via `RunOptions.provider`; threaded to `performComplete` →
	 * `performIntegration` as `providerInstance`). Tests/embeddings inject a stubbed
	 * `GitHubProvider` (a custom `gh` path) to drive the full propose pipeline
	 * OFFLINE without a real GitHub arbiter. The resolved provider OBJECT, NOT a
	 * config override (there is none). Unset ⇒ the core selects from the arbiter URL.
	 */
	providerInstance?: ReviewProvider;
	/**
	 * **Gate 2 — the PR/code review gate** (GATES spec `work/specs/tasked/review.md`):
	 * threaded VERBATIM into `performComplete` (the gate rides inside the shared
	 * `do`/`complete` pipeline, so CI inherits it for free). When `review` is on,
	 * the `review` SKILL runs as a fresh-context agent AFTER the green `verify` and
	 * BEFORE the done-move; a `block` maps to the `needs-attention` outcome the same
	 * way `gate-failed` does (exit 1). `reviewModel`/`reviewMaxRounds`
	 * tune it; `reviewGate` is the injectable seam (production: harness-backed).
	 */
	review?: boolean;
	reviewModel?: string;
	reviewMaxRounds?: number;
	reviewGate?: ReviewGate;
	/**
	 * **The task-SET ACCEPTANCE GATE seam** (task `slice-acceptance-gate`):
	 * consumed ONLY by the `do spec:<slug>` tasking path. When `review` resolves on,
	 * a fresh-context review of the produced task SET runs BEFORE the tasks
	 * integrate (riding `performIntegration`'s review block); `block` routes the set
	 * to needs-attention, `approve` lets it integrate. It rides the SAME BUILD
	 * `--review`/`--no-review`/`--review-model` family as Gate-2 (one gate-config
	 * story) and is ONE-SHOT (no rounds; it does NOT inherit `reviewMaxRounds`). It
	 * is DISTINCT from the build {@link reviewGate} (a task-SET prompt, not a code
	 * diff) and from the tasker improver loop ({@link reviewLoop}). Production wires
	 * `harnessTaskAcceptanceGate`; tests inject a canned verdict. Omitted ⇒ no gate.
	 */
	taskReviewGate?: ReviewGate;
	/**
	 * The autonomous agent invocation. Tests inject this to edit files directly;
	 * production wires the harness seam (the prompt-fed, run-to-completion launch
	 * `run` uses). When omitted, {@link harness} is used.
	 */
	dorfl?: DoDorfl;
	/** The harness seam used when `dorfl` is omitted; defaults to the null adapter. */
	harness?: Harness;
	/**
	 * `do --watch`: stream the agent's high-signal events live by tailing the pi
	 * session `.jsonl` (task `do-watch`, option (a)). A READ-ONLY observer — it
	 * NEVER changes the run's outcome, gate, integration, git, or exit code; only a
	 * concurrent log-tail is added. REQUIRES the pi harness (the null adapter has
	 * no session log to tail) — passing it with a non-pi harness is a usage error.
	 */
	watch?: boolean;
	/** The configured agent command the harness shells out to (null adapter). */
	agentCmd?: string;
	/** The model routing intent forwarded to the harness (ADR §13). Sourced
	 * from `config.buildModel` (which inherits the general `config.model` when
	 * unset via `applyModelFallbacks`). */
	model?: string;
	/**
	 * The HOST-ONLY root folder under which this run's pi session FILE is generated
	 * (resolved `config.sessionsDir`; flag > env > global > default). `undefined`
	 * ⇒ pi's default per-cwd folder. Mapped from `Config` in `cli.ts`'s `do`
	 * action (the bridge from resolved config to the launch — without it the key
	 * resolves but never reaches pi).
	 */
	sessionsDir?: string;
	/** Override the read seam (slug resolution); defaults to {@link ledgerRead}. */
	read?: LedgerReadStrategy;
	/** Override the resolver's repo path (slug-namespace existence reads). Defaults to `cwd`. */
	repoPath?: string;
	/** Environment for child git/agent processes. */
	env?: NodeJS.ProcessEnv;
	/** Sink for human-readable progress notes. */
	note?: (message: string) => void;
	/**
	 * Sink for a pre-formatted block printed VERBATIM (forwarded to `complete`'s
	 * propose-mode next-step block). Defaults to `note`.
	 */
	noteBlock?: (message: string) => void;
	/** Emit ANSI color in `complete`'s (cosmetic) propose next-step block. */
	color?: boolean;
	/**
	 * Where `--watch`'s tailed events are written (defaults to stderr). Tests inject
	 * a sink to assert the surfaced lines without a real terminal.
	 */
	watchSink?: (line: string) => void;
	/**
	 * The dorfl-internal agent-session deadline in minutes (spec
	 * `graceful-pre-timeout-wip-checkpoint`). Threaded through {@link runDoAgent}
	 * to `launchWithOptionalWatch` — the harness races the child against it and
	 * flags a graceful stop on fire, which `performDo` routes as a CHECKPOINT
	 * (save WIP + auto-continue on progress under the ceiling, else surface).
	 * Absent ⇒ no deadline (a run that finishes on its own is byte-for-byte
	 * unchanged).
	 */
	agentDeadlineMinutes?: number;
	/**
	 * Anti-loop ceiling on CONSECUTIVE deadline auto-continues (spec
	 * `graceful-pre-timeout-wip-checkpoint`). On hitting this the next
	 * deadline checkpoint surfaces to a human instead of auto-continuing.
	 */
	maxAutoCheckpoints?: number;
}

/**
 * The agent-launch fields {@link runDoAgent} reads, shared by the in-place
 * {@link DoOptions} and the remote {@link DoRemoteOptions} (so one launch helper
 * serves both forms). A structural subset — both option shapes satisfy it.
 */
interface DoAgentLaunchOptions {
	dorfl?: DoDorfl;
	harness?: Harness;
	agentCmd?: string;
	model?: string;
	sessionsDir?: string;
	/**
	 * The resolved {@link PromptGuidance} NUDGE namespace (e.g. `testFirst`),
	 * threaded from the per-repo config by the CLI and forwarded INTO
	 * {@link buildAgentPrompt} so the autonomous worker prompt actually carries the
	 * nudge. Absent ⇒ every member false ⇒ the wrapper is byte-identical to today.
	 * (Without this the per-repo `promptGuidance.testFirst` was a silent no-op on
	 * the build path — only `dorfl prompt` honoured it.)
	 */
	promptGuidance?: PromptGuidance;
	watch?: boolean;
	watchSink?: (line: string) => void;
	color?: boolean;
	/**
	 * **The dorfl-internal agent deadline in minutes** (spec
	 * `graceful-pre-timeout-wip-checkpoint`). Threaded to {@link runDoAgent},
	 * which converts it to a wall-clock `deadlineMs` and passes it to
	 * {@link launchWithOptionalWatch} — the pi harness races the child against
	 * that deadline. When the deadline fires, the agent is gracefully stopped
	 * (SIGTERM + 10s grace + SIGKILL) and the caller routes the run as a
	 * CHECKPOINT (save WIP + auto-continue / surface). Absent ⇒ no deadline
	 * (byte-for-byte the pre-task behaviour).
	 */
	agentDeadlineMinutes?: number;
	/**
	 * **The anti-loop ceiling** for consecutive deadline auto-continues (spec
	 * `graceful-pre-timeout-wip-checkpoint`). On hitting this the next deadline
	 * checkpoint SURFACES to a human instead of auto-continuing. Absent ⇒
	 * unlimited (⇒ defensive callers should always thread the resolved config
	 * value; the default is 5).
	 */
	maxAutoCheckpoints?: number;
	env?: NodeJS.ProcessEnv;
	/**
	 * The optional runner IDENTITY (a bot). Threaded from the host-only
	 * `config.identity`. It scopes the runner's GIT + provider operations (claim,
	 * push, integration, `gh`) via process-scoped env overrides — NEVER the AGENT
	 * launch (the agent keeps the plain ambient `env`; the agent must not commit as
	 * the identity, only the runner's own git transitions do). Absent ⇒ ambient
	 * (today's behaviour, byte-for-byte).
	 */
	identity?: Identity;
}

/**
 * Options for {@link performDoRemote} — `do --remote <r> <arg>`. It carries the
 * SAME pipeline knobs as {@link DoOptions} (integration / verify / review /
 * agent-launch), but selects a REGISTERED repo by `remote` (auto-mirrored) +
 * `workspacesDir` (the agents' execution area) INSTEAD of an in-place `cwd`:
 * there is no checkout, so the worktree is materialised under `workspacesDir`.
 */
export interface DoRemoteOptions extends DoAgentLaunchOptions {
	/** The raw CLI slug argument: bare (= task), `task:<slug>`, or `spec:<slug>`. */
	arg: string;
	/**
	 * The registered remote spec/URL to run against (`do --remote <r>`). Resolved
	 * to a hub mirror via `ensureMirror` (auto-created when unregistered).
	 */
	remote: string;
	/**
	 * The execution working area (config `workspacesDir`) — the AGENTS' area where
	 * the hub mirror + job worktree live. NEVER the human area.
	 */
	workspacesDir: string;
	/**
	 * Name of the arbiter remote, used ONLY for human-readable surfacing messages
	 * (the actual rebase/integrate/push target inside the worktree is `origin`, the
	 * bare mirror's clone remote). Defaults to `origin`.
	 */
	arbiter?: string;
	/**
	 * Per-repo `autoTask` policy — gates the AUTO-PICK / pool path only. An
	 * EXPLICITLY-named `do --remote spec:<slug>` tasks regardless of it (the
	 * dispatch passes `explicit: true`), mirroring `do <task>` vs `autoBuild`.
	 * Ignored by the task-build path.
	 */
	autoTask?: boolean;
	/** The tasker review→edit→converge loop seam — `do --remote spec:<slug>` path only (see {@link DoOptions.reviewLoop}). */
	reviewLoop?: TaskReviewGate;
	/** The tasker improver loop's `taskerLoopMax` cap. Loop only. */
	taskerLoopMax?: number;
	/** The tasker improver loop's de-correlated review model (`--tasker-loop-model`). Loop only. */
	taskerLoopModel?: string;
	/** How many fresh-context (M) executions of the tasker loop to run. Default 1. Loop only. */
	reviewExecutions?: number;
	/** Integration mode resolved at integrate-time (flag > per-repo > global > default). */
	integration?: IntegrationMode;
	/**
	 * The explicit `--merge` override for the untrusted-origin build-propose rule on the
	 * `do --remote` task-BUILD path. See {@link DoOptions.explicitMerge}.
	 */
	explicitMerge?: boolean;
	/**
	 * **Per-TRANSITION override for the TASKING transition only** (config
	 * `taskingIntegration`) on the `do --remote spec:<slug>` path: threaded into
	 * {@link performTask} as `taskingIntegration ?? integration`. Unset ⇒ tasking
	 * uses `integration` (today's behaviour); the task-BUILD path always threads
	 * `integration`. See {@link DoOptions.taskingIntegration}.
	 */
	taskingIntegration?: IntegrationMode;
	/**
	 * **The per-repo TASK-PLACEMENT default** (spec
	 * `staging-pool-position-gate-and-trust-model` US #5) on the `do --remote
	 * spec:<slug>` path: threaded into {@link performTask} as the
	 * configured-default rung. See {@link DoOptions.tasksLandIn}.
	 */
	tasksLandIn?: 'backlog' | 'ready';
	/**
	 * **The per-repo UNTRUSTED-side TASK-PLACEMENT default** on the `do --remote
	 * spec:` path. See {@link DoOptions.untrustedTasksLandIn}.
	 */
	untrustedTasksLandIn?: 'backlog' | 'ready';
	/**
	 * **The OPERATOR's EXPLICIT task-placement override** on the `do --remote
	 * spec:` path. See {@link DoOptions.explicitTasksLandIn}.
	 */
	explicitTasksLandIn?: 'backlog' | 'ready';
	/** The declared per-repo ENV-PREP step (string | list), run ONCE before the
	 * first `verify` on a fresh worktree. Unset ⇒ a no-op (NO default install). */
	prepare?: VerifyConfig;
	/** The declared per-repo acceptance gate (string | list). */
	verify?: VerifyConfig;
	/**
	 * Run the acceptance gate against the REBASED tip in a clean throwaway worktree
	 * (the tree that integrates) when `true` (the default), else in the build
	 * worktree. `do --remote`/`--isolated` is a SINGLE-JOB path, so the resolved
	 * flag is passed UNCONDITIONALLY (no `run`-fleet downgrade).
	 */
	freshWorktreeGate?: boolean;
	/**
	 * **The cross-job merge-serialiser CAS-retry cap** (config `mergeRetries`, spec
	 * `land-time-reverify-and-parallel-merge-ceiling` Story 5 / Applied Answer q1
	 * (a)). Threaded VERBATIM into `performComplete` → `performIntegration` so the
	 * resolved cap reaches the cross-job land queue (the CAS loop IS the queue
	 * across separate jobs). Mirrors {@link DoOptions.mergeRetries} so the in-place
	 * and no-checkout `do` paths share ONE knob.
	 */
	mergeRetries?: number;
	/**
	 * **The PR-INTENT axis** (config `noPR`, ADR §6): when `true`, propose pushes
	 * the branch but skips the PR (the explicit suppress-PR intent). NOT a provider
	 * choice — the provider is purely arbiter-derived. Unset/false ⇒ PR opens.
	 */
	noPR?: boolean;
	/**
	 * The `gh` AUTH/AVAILABILITY PROBE the PR-INTENT pre-flight guard runs UP FRONT
	 * on the AUTONOMOUS path too (propose + GitHub arbiter + `noPR` unset): `true` ⇒
	 * `gh` CAN open a PR. Mirrors {@link DoOptions.ghCanOpenPr} so the in-place and
	 * no-checkout `do` paths share ONE signal. The probe (not a config check) is the
	 * signal — an absent `providers.github` identity falls back to ambient `gh` auth,
	 * which the probe reports available, so a working ambient setup still PROCEEDS.
	 * Injectable so tests stub `gh` without a real binary; production defaults to
	 * `new GitHubProvider().available(probeDir, env)`, run in the claim clone (which
	 * carries the arbiter remote), NOT a bare cwd.
	 */
	ghCanOpenPr?: (cwd: string, env: NodeJS.ProcessEnv | undefined) => boolean;
	/**
	 * Optional FULLY-FORMED review provider INSTANCE (tests/embeddings inject a
	 * stubbed `GitHubProvider` to drive the propose pipeline offline). The resolved
	 * provider OBJECT, NOT a config override. Unset ⇒ the core selects from the
	 * arbiter URL.
	 */
	providerInstance?: ReviewProvider;
	/** Gate 2 (PR/code review) toggle — threaded verbatim into `performComplete`. */
	review?: boolean;
	reviewModel?: string;
	reviewMaxRounds?: number;
	reviewGate?: ReviewGate;
	/** The task-SET ACCEPTANCE GATE seam — `do --remote spec:<slug>` path only (see {@link DoOptions.taskReviewGate}). */
	taskReviewGate?: ReviewGate;
	/**
	 * **`--allow-backlog`** on the no-checkout `do --remote`/`--isolated` path (see
	 * {@link DoOptions.allowBacklog}): widen resolution + the claimable predicate to
	 * ALSO accept a `tasks/backlog/`-resident task, so the human-driven `drive-tasks`
	 * opt-in backlog mode can build a STAGED task in place. The done-move goes
	 * `tasks/backlog/ → tasks/done/` directly. Default off; never set by an
	 * autonomous path. The task-build path only.
	 */
	allowBacklog?: boolean;
	/** Override the read seam (slug resolution); defaults to {@link ledgerRead}. */
	read?: LedgerReadStrategy;
	/** Sink for human-readable progress notes. */
	note?: (message: string) => void;
	/** Sink for a pre-formatted block (forwarded to `complete`'s next-step block). */
	noteBlock?: (message: string) => void;
}

const DEFAULT_ARBITER = 'origin';

/**
 * Map a `do spec:<slug>` {@link TaskResult} onto the `do` {@link DoResult}
 * contract: outcomes pass through (tasked / gate-refused / stale / agent-failed /
 * usage-error), the lock-lost outcome splits into `lost` (exit 2) vs `contended`
 * (exit 3) by its exit code, and the tasking-only exit 4 (stale) is reported on
 * the `do` exit contract (`0|1|2|3`) as exit 1 — the needs-attention-class
 * failure code, same as a stuck build.
 */
function taskResultToDoResult(tasked: TaskResult): DoResult {
	let outcome: DoOutcome;
	let exitCode: 0 | 1 | 2 | 3;
	switch (tasked.outcome) {
		case 'tasked':
			outcome = 'tasked';
			exitCode = 0;
			break;
		case 'gate-refused':
			outcome = 'gate-refused';
			exitCode = 1;
			break;
		case 'lock-lost':
			if (tasked.exitCode === 3) {
				outcome = 'contended';
				exitCode = 3;
			} else {
				outcome = 'lost';
				exitCode = 2;
			}
			break;
		case 'stale':
			outcome = 'stale';
			exitCode = 1;
			break;
		case 'needs-attention':
			// The tasker review→edit loop found the decomposition unclear and routed the
			// spec to needs-attention (no guessed tasks). Same exit class as a stuck
			// build (1).
			outcome = 'needs-attention';
			exitCode = 1;
			break;
		case 'agent-failed':
			outcome = 'agent-failed';
			exitCode = 1;
			break;
		default:
			outcome = 'usage-error';
			exitCode = 1;
	}
	return {exitCode, outcome, slug: tasked.slug, message: tasked.message};
}

/**
 * Run the in-place `do` ritual end-to-end. Never throws for the expected
 * lost/contended/refused/needs-attention cases — those are returned with the
 * appropriate exit code and outcome. The runner owns all git; the agent only
 * edits code.
 */
export async function performDo(options: DoOptions): Promise<DoResult> {
	const note = options.note ?? (() => {});
	const arbiter = options.arbiter ?? DEFAULT_ARBITER;
	const cwd = options.cwd;
	// `env` here is the runner's GIT/provider env, scoped to the configured
	// identity (claim, push, integrate, `gh`). The AGENT launch is the ONE thing
	// that must NOT be the identity — it stays on the ambient `options.env`
	// (`runDoAgent` reads `options.env` directly, never this local `env`), so the
	// agent never commits as the bot; only the runner's own transitions do. Absent
	// identity ⇒ `options.env` unchanged (byte-for-byte ambient). A configured
	// identity that cannot be resolved (e.g. `tokenEnv` names an unset env var) is
	// a clean usage error here, never a crash or a silent ambient fallback.
	let env: NodeJS.ProcessEnv;
	try {
		env = identityEnv(options.identity, options.env ?? process.env);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		note(message);
		return {exitCode: 1, outcome: 'usage-error', message};
	}

	// 0. `--watch` REQUIRES the pi harness (task `do-watch`): only the pi adapter
	//    writes a session `.jsonl` event log to tail. The null/shell adapter has no
	//    session log / event taxonomy, so there is nothing to observe — ERROR
	//    CLEARLY here, BEFORE any git transition (no claim, no branch), rather than
	//    silently running without the view. The injected `dorfl` (tests /
	//    custom embeddings) is its own launch path and is exempt.
	if (
		options.watch === true &&
		options.dorfl === undefined &&
		!(options.harness instanceof PiHarness)
	) {
		return {
			exitCode: 1,
			outcome: 'usage-error',
			message:
				'`do --watch` requires the pi harness; configure `harness: pi` or drop ' +
				'`--watch`.',
		};
	}

	// 1. Resolve the slug across BOTH namespaces — `do` is the ONE command that
	//    spans them (ADR §3a): bare → task (after a no-spec-collision check;
	//    ERROR on collision), `task:`/`spec:` explicit. A collision / resolution
	//    failure is a loud usage error (exit 1).
	let resolved;
	try {
		resolved = resolveSlug({
			arg: options.arg,
			repoPath: options.repoPath ?? cwd,
			read: options.read ?? ledgerRead,
		});
	} catch (err) {
		if (err instanceof SlugResolutionError) {
			return {exitCode: 1, outcome: 'usage-error', message: err.message};
		}
		const message = err instanceof Error ? err.message : String(err);
		return {exitCode: 1, outcome: 'usage-error', message};
	}

	// 2. `do spec:<slug>` → the spec-TASKING path (`autoslice-command`): the in-place
	//    `do` worker is AUTONOMOUS, so it tasks as the AGENT (gate-bound + lock).
	//    The orchestration (gate → lock → to-task harness → runner-owned commit)
	//    lives in `tasking.ts`; `do` dispatches `spec:` here. The agent only writes
	//    task files — the runner owns every git transition (same boundary as the
	//    build path). It does NOT run the task-build pipeline below.
	//    `resolveSlug` returns `{namespace:'spec'}` for a `spec:<slug>` arg, so
	//    `do spec:<slug>` routes here to tasking.
	if (resolved.namespace === 'spec') {
		const tasked = await performTask({
			slug: resolved.slug,
			cwd,
			arbiter,
			doer: 'agent',
			autoTask: options.autoTask,
			// EXPLICIT dispatch: a `do spec:<slug>` target was NAMED (the operator typed
			// it, or the auto-pick POOL already filtered it on `autoTask` before
			// dispatching here — the single policy-enforcement point). So the tasking gate
			// drops the `autoTask` policy term and binds only the spec's own readiness
			// (`humanOnly`/`needsAnswers`) + `taskedAfter`, EXACTLY as `do <task>` builds a
			// named task regardless of `autoBuild` (the pool gates the policy, not the
			// explicit claim).
			explicit: true,
			// The injected dorfl (tests) writes task files directly. The
			// DoDorfl shape is a structural superset of TaskDorfl (its
			// extra `output` is ignored by the tasking path), so it threads straight in.
			dorfl: options.dorfl,
			harness: options.harness,
			agentCmd: options.agentCmd,
			model: options.model,
			sessionsDir: options.sessionsDir,
			// The integrate-time args (task `slice-output-through-integration`): the
			// `provider` is the SAME the task-build path threads (arg parity), but the
			// MODE is the per-TRANSITION TASKING resolution (`per-transition-integration-
			// mode-tasking-vs-build`): `taskingIntegration ?? integration`. Unset override ⇒
			// falls back to `integration` (today's behaviour); a repo with
			// `integration:'propose'` + `taskingIntegration:'merge'` lands the task FILES
			// on main here while the BUILD path below still threads plain `integration`.
			integration: options.taskingIntegration ?? options.integration,
			// The cross-job merge-serialiser CAS-retry cap (config `mergeRetries`) —
			// threaded so the `do spec:` tasking-transition's land tail respects the
			// same per-repo cap the build path uses (task
			// `thread-merge-retries-cross-task-and-ratify-default`).
			mergeRetries: options.mergeRetries,
			// The per-repo TASK-PLACEMENT defaults (trusted + untrusted twin) + the
			// operator's explicit override (task `runner-deterministic-slice-
			// placement-policy-and-precedence`; ADR `untrusted-origin-carries-via-
			// stamp-not-forced-staging`). The tasker reads the spec's stamped
			// `originTrust:` to SELECT the trusted-vs-untrusted configured default,
			// then feeds it (with the explicit override on top) into the
			// runner-deterministic placement resolver (which no longer has a trust
			// rung).
			tasksLandIn: options.tasksLandIn,
			untrustedTasksLandIn: options.untrustedTasksLandIn,
			explicitTasksLandIn: options.explicitTasksLandIn,
			noPR: options.noPR,
			providerInstance: options.providerInstance,
			// The tasker review→edit→converge loop (slicer-review-edit-loop): improves the
			// candidate tasks in place + routes the verdict through the needsAnswers /
			// needs-attention sink. Threaded only on the `do spec:` path; omitted ⇒ no loop.
			reviewLoop: options.reviewLoop,
			taskerLoopMax: options.taskerLoopMax,
			reviewExecutions: options.reviewExecutions,
			taskerLoopModel: options.taskerLoopModel,
			// The task-SET ACCEPTANCE GATE (slice-acceptance-gate): rides the BUILD
			// `--review`/`--review-model` family — a fresh-context review of the produced
			// SET before it integrates, ONE-SHOT, independent of the improver loop above.
			review: options.review,
			reviewGate: options.taskReviewGate,
			acceptanceReviewModel: options.reviewModel,
			env,
			// The tasker + review AGENTS launch AMBIENT, never the identity env.
			agentEnv: options.env,
			note,
		});
		return taskResultToDoResult(tasked);
	}

	const slug = resolved.slug;

	// 3. Refuse on a DIRTY working tree (ar-run.sh's first guard). `do` runs in a
	//    REAL checkout (the human's clone / the CI container); it must NOT
	//    entangle unrelated work or run over uncommitted changes. (Mirrors the
	//    bash driver: "error: working tree is dirty — commit/stash before
	//    running a task.")
	if (await isDirtyTree(cwd, env)) {
		const message =
			`working tree is dirty — commit or stash before running '${slug}' ` +
			'(do runs in-place in this checkout and will not entangle unrelated ' +
			'changes).';
		return {exitCode: 1, outcome: 'refused', slug, message};
	}

	// 3b. Refuse on a DIVERGED local `main` (MERGE MODE ONLY — mirrors `complete`'s
	//     guard). A local `main` AHEAD of `<arbiter>/main` (unpushed commits) breaks
	//     ONLY the paths that fast-forward local `main`, and only merge mode ff's it:
	//     the task builds off `<arbiter>/main`, so a merge-back ff cannot apply over
	//     a diverged main. Propose mode never ff's local `main` (it pushes the work
	//     branch + opens a PR; completion only `switch`es to main, no ff), so the
	//     guard is irrelevant there and must NOT fire. Catch it UP FRONT — before the
	//     claim + agent run — so a whole build is not wasted. Resolve the mode the
	//     SAME way the rest of the flow does (the `options.integration` we thread into
	//     `complete`), then fetch (as the onboarding flow does) and compare.
	//     `--ignore-diverged-main` overrides (mirrors `--ignore-not-ready`); when
	//     overridden, Part 1's non-fatal sync handles the persisting divergence
	//     honestly at complete-time.
	if (
		(options.integration ?? 'propose') === 'merge' &&
		options.ignoreDivergedMain !== true
	) {
		await runAsync('git', ['fetch', '--quiet', arbiter], cwd, {env});
		const ahead = await localMainAheadCount(cwd, arbiter, env);
		if (ahead > 0) {
			const message =
				`local main is ahead of ${arbiter}/main by ${ahead} commit` +
				`${ahead === 1 ? '' : 's'} (unpushed); the task builds off ${arbiter}/main ` +
				"and the merge-back can't fast-forward — push or reconcile main first " +
				'(or re-run with --ignore-diverged-main to proceed anyway).';
			return {exitCode: 1, outcome: 'refused', slug, message};
		}
	}

	// 3c. PR-INTENT pre-flight guard (the honest-failure value of the `noPR` axis).
	//     When this run is `propose` on a GITHUB arbiter and the operator INTENDS a PR
	//     (`noPR` unset), run a `gh` AUTH/AVAILABILITY PROBE UP FRONT — BEFORE the
	//     claim + agent run — and FAIL FAST if `gh` genuinely cannot open one, instead
	//     of letting integration silently degrade to manual-PR instructions. This sits
	//     alongside the dirty-tree / diverged-main guards (and mirrors the shared
	//     `doNeedsAgentCmd`/`NO_AGENT_CMD_MESSAGE` up-front refusal) so no build work
	//     is wasted. CRITICAL: the PROBE is the signal, NOT "is a `providers.github`
	//     identity present" — an absent identity falls back to AMBIENT `gh` auth (the
	//     common local-dev case), which the probe correctly reports as available, so a
	//     working ambient setup still PROCEEDS. A genuinely transient mid-run `gh`
	//     outage (probe passes here, the API fails later) is left to the runtime
	//     degrade. `noPR: true` skips the guard entirely (no PR is intended).
	{
		const url = await arbiterUrl(cwd, arbiter, env);
		const probe =
			options.ghCanOpenPr ??
			((probeCwd, probeEnv) =>
				new GitHubProvider().available(probeCwd, probeEnv));
		if (
			shouldFailProposePrIntent({
				mode: options.integration ?? 'propose',
				arbiterIsGitHub: url !== undefined && isGitHubArbiterUrl(url),
				noPR: options.noPR,
				ghCanOpenPr: () => probe(cwd, env),
			})
		) {
			return {
				exitCode: 1,
				outcome: 'refused',
				slug,
				message: PROPOSE_PR_INTENT_GH_UNAVAILABLE_MESSAGE,
			};
		}
	}

	// 3d. STATIC fresh-worktree-gate readiness guard (task
	//     `do-fails-fast-when-acceptance-gate-statically-unrunnable`). When the
	//     fresh-worktree gate is ON AND `prepare` resolves to no commands AND a
	//     lockfile is present, the throwaway worktree the gate runs in will have no
	//     `node_modules` and `verify`'s tools (`prettier`/`tsc`/`vitest`) will be
	//     "command not found" — fail fast HERE, BEFORE the claim and BEFORE spawning
	//     the build agent, instead of wasting a whole `do` run and (worse) routing
	//     correct work to needs-attention as if the task were at fault. A repo with
	//     NO lockfile is the intentional dep-free case (the design point preserved)
	//     and proceeds. The guard ALSO fails fast when `verify` is unset/all-blank
	//     (a MODE-INDEPENDENT stop — Dorfl has no default gate, so an unconfigured
	//     `verify` can never pass in any mode).
	{
		const guard = checkGatePreconditions({
			freshWorktreeGate: options.freshWorktreeGate,
			prepare: options.prepare,
			verify: options.verify,
			lockfile: detectLockfileOnDisk(cwd),
		});
		if (guard !== undefined) {
			return {exitCode: 1, outcome: 'refused', slug, message: guard.message};
		}
	}

	// 4. Onboard via the ISOLATION SEAM (`selectIsolationStrategy`/`inPlaceStrategy`)
	//    with the SAME claim-first composition `do --remote` (and `run`) use — this
	//    is the consumer that finally puts in-place `do` on the seam, so all THREE
	//    `do`/`run` forms share the one `IsolatedTree`-handle post-claim shape:
	//
	//      a. CLAIM explicitly via the CAS (the claim is the `do` driver's job,
	//         BEFORE prepare). A lost/contended/usage claim is propagated verbatim
	//         and NOTHING is onboarded — the same clean skip `run`/`do --remote` do.
	//         An already-in-progress / done / absent item is NOT claimable, so the
	//         CAS returns `lost` (exit 2): `do` (the autonomous CI worker) never
	//         re-claims an item someone else holds, exactly like its siblings.
	//      b. `selectIsolationStrategy({checkout})` → `inPlaceStrategy`, whose
	//         `prepare` does the ONBOARDING half (fetch + continue-detection +
	//         fresh-main `work/<slug>` switch, incl. the §14 continue/rebase path)
	//         WITHOUT re-claiming — the split the seam mandates (claim → driver,
	//         onboarding → strategy).
	const claim = await performClaim({
		slug,
		cwd,
		arbiter,
		// `--allow-backlog`: widen the claimable predicate to ALSO accept a
		// `tasks/backlog/`-resident body. Claim stays a pure lock (writes nothing to
		// `main`, moves nothing); default off ⇒ pool-only, exactly as today.
		allowBacklog: options.allowBacklog === true,
		env,
		note,
	});
	if (claim.outcome === 'lost') {
		return {exitCode: 2, outcome: 'lost', slug, message: claim.message};
	}
	if (claim.outcome === 'contended') {
		return {exitCode: 3, outcome: 'contended', slug, message: claim.message};
	}
	if (claim.exitCode !== 0) {
		// usage/environment error (not inside a repo, no arbiter remote, dirty
		// index, …): surface verbatim. NOTHING was onboarded.
		return {exitCode: 1, outcome: 'usage-error', slug, message: claim.message};
	}

	// The claim landed (the item is now in-progress on the arbiter). Onboard the
	// checkout onto its work branch THROUGH the seam — the in-place strategy puts
	// `cwd` on `work/<slug>` off the freshly-fetched `<arbiter>/main` (or continues
	// a kept requeue branch + rebases it, §14/§10). `prepare` can throw on a genuine
	// plumbing failure (unreachable arbiter, …) — surface that as a usage error,
	// never a false success.
	let tree: IsolatedTree;
	try {
		tree = selectIsolationStrategy({checkout: cwd, arbiter}).prepare({
			slug,
			// The task-build path: namespace the branch `work/task-<slug>`, and
			// branch it from the EXACT claim commit (the defensive guard) so a stale
			// same-named branch (e.g. one `intake` left) is re-pointed, never reused.
			type: 'task',
			claimCommit: claim.claimCommit,
			env,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {exitCode: 1, outcome: 'usage-error', slug, message};
	}
	const branch = tree.branch;

	// 4a. CONTINUE rebase conflict (ADR §14 + §10): a requeue kept a `work/<slug>`
	//     that did not replay onto the current main at onboard-time (aborted, never
	//     auto-resolved). Surface to needs-attention TREE-LESSLY via the SAME `#89`
	//     mechanism `requeue` uses for the reverse direction — the rebase was
	//     ABORTED, so the kept `work/<slug>` tip == the arbiter tip (already on the
	//     arbiter, after-commit, recoverable). The surface is purely the lock amend
	//     to `state: stuck` with the reason (post lock-cutover — no folder move, no
	//     branch push, no worktree mutation) instead of running the agent — the §10
	//     path. The work
	//     did NOT onboard; the runner owns the bounce.
	if (tree.continueRebaseConflict) {
		const reason =
			`continuing the kept ${tree.branch}: rebase onto the latest main ` +
			'conflicted (aborted, never auto-resolved) — run `requeue --reconcile` ' +
			'to non-destructively re-sync the mirror and retry the rebase (keeps ' +
			'the work). Last resort: `requeue --reset` DESTRUCTIVELY discards the ' +
			'branch and starts fresh.';
		const surfaced = await ledgerWrite.applyTreelessNeedsAttentionTransition({
			cwd: tree.dir,
			slug,
			reason,
			arbiter: tree.arbiterRemote,
			env,
			note,
		});
		if (!surfaced.moved) {
			return surfaceUnmovedDoResult({slug, branch, reason, surfaced});
		}
		return {
			exitCode: 1,
			outcome: 'needs-attention',
			slug,
			branch,
			message: reason,
		};
	}

	// 4b. CONTINUE reconcile-push TERMINAL failure (the stale-lease-strand bug):
	//     the onboard reconcile push of the kept (already-committed) work branch
	//     FAILED terminally (stale-lease cap exhausted, or a non-stale-lease
	//     rejection / unreachable arbiter). The push helper THROWS; the strategy
	//     CATCHES it and flags `continuePushFailure` so the run does NOT crash
	//     leaving the task silently in-progress. Surface to needs-attention
	//     TREE-LESSLY via the SAME `#89` mechanism `requeue` uses — the kept branch
	//     is already on the arbiter (after-commit, recoverable), so the surface is
	//     purely the one-file ledger move + reason (no branch push, no worktree).
	if (tree.continuePushFailure !== undefined) {
		const reason =
			`continuing the kept ${tree.branch}: publishing the rebased work branch ` +
			`to the arbiter failed terminally (${tree.continuePushFailure}) — the kept ` +
			'branch is left intact on the arbiter (recoverable); `requeue --reconcile` ' +
			'to non-destructively re-sync the mirror and retry once the churn ' +
			'settles (keeps the work). Last resort: `requeue --reset` DESTRUCTIVELY ' +
			'discards the branch and starts fresh.';
		const surfaced = await ledgerWrite.applyTreelessNeedsAttentionTransition({
			cwd: tree.dir,
			slug,
			reason,
			arbiter: tree.arbiterRemote,
			env,
			note,
		});
		if (!surfaced.moved) {
			return surfaceUnmovedDoResult({slug, branch, reason, surfaced});
		}
		return {
			exitCode: 1,
			outcome: 'needs-attention',
			slug,
			branch,
			message: reason,
		};
	}

	// 5. Run the agent autonomously in the checkout, ON the work branch — the
	//    SAME prompt assembly `dorfl prompt` emits (canonical wrapper +
	//    source spec + the task's ## Prompt). The agent only edits code (it does
	//    no git). This is the one NEW middle step `ar-run.sh` shelled out for
	//    (`prompt | pi`).
	//    The post-claim pipeline reads the uniform `IsolatedTree` handle (`tree.dir`)
	//    — in-place that IS `cwd`, but reading the handle keeps the shared shape the
	//    future advance-loop tick wraps (no in-place-only special case).
	let prompt: string;
	try {
		// CONTINUE-aware resolution: on a continue (the arbiter holds a kept
		// `work/<slug>` whose tip is STRANDED off main) the task may already be in
		// `work/done/`; admit `done/` ONLY behind the tip-vs-arbiter stranded gate
		// (story 5), reusing the SAME refs the continue-detection uses.
		const task = resolveTask(
			tree.dir,
			slug,
			{
				cwd: tree.dir,
				branchRef: `${tree.arbiterRemote}/${tree.branch}`,
				mainRef: `${tree.arbiterRemote}/main`,
				env,
			},
			// `--allow-backlog`: also resolve a `tasks/backlog/`-resident body
			// (lowest priority). Default off ⇒ unchanged.
			{allowBacklog: options.allowBacklog === true},
		);
		// CONTINUE-mode (the `agent-prompt-continue-context` task): if the arbiter
		// holds a kept `work/<slug>` ahead of main (a requeue) the checkout was
		// CONTINUED onto it — inject the continue block (prior diff + reason + note).
		// REUSE the SAME continue-detection the onboarding path used (in-place clone
		// refs: `<arbiter>/work/<slug>` vs `<arbiter>/main`).
		const continueContext = resolveContinueContext({
			cwd: tree.dir,
			slug,
			arbiter: tree.arbiterRemote,
			branchRef: `${tree.arbiterRemote}/${tree.branch}`,
			mainRef: `${tree.arbiterRemote}/main`,
			content: readFileSync(task.path, 'utf8'),
			env,
		});
		// Per-item override layer: a task or spec may pin `promptGuidance.testFirst`
		// in its frontmatter, superseding the resolved repo policy for THIS item.
		const itemGuidance = resolvePromptGuidanceForItem({
			cwd: tree.dir,
			repoResolved: {testFirst: options.promptGuidance?.testFirst === true},
			taskContent: readFileSync(task.path, 'utf8'),
		});
		prompt = buildAgentPrompt(task.slug, task.spec, task.taskPrompt, {
			cwd: tree.dir,
			continueContext,
			promptGuidance: itemGuidance,
		});
	} catch (err) {
		if (err instanceof PromptError) {
			return await saveAgentFailure({
				slug,
				branch,
				cwd: tree.dir,
				arbiter: tree.arbiterRemote,
				detail: err.message,
				env,
				note,
			});
		}
		throw err;
	}

	let agent: {
		ok: boolean;
		detail?: string;
		output?: string;
		timedOut?: boolean;
		reap?: AgentTreeReap;
	};
	try {
		agent = await runDoAgent(options, tree.dir, prompt, slug);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return await saveAgentFailure({
			slug,
			branch,
			cwd: tree.dir,
			arbiter: tree.arbiterRemote,
			detail: message,
			env,
			note,
		});
	}
	// DEADLINE CHECKPOINT (spec `graceful-pre-timeout-wip-checkpoint`): the
	// dorfl-internal deadline fired — stop is graceful, NOT a failure. Route
	// through the shared checkpoint path (save WIP + auto-continue on progress
	// under the ceiling, else surface). Distinct from `saveAgentFailure` on
	// purpose — the deadline path must NOT mark the item stuck when it
	// auto-continues.
	if (agent.timedOut) {
		return await routeDeadlineCheckpoint({
			slug,
			branch,
			cwd: tree.dir,
			arbiter: tree.arbiterRemote,
			maxAutoCheckpoints: options.maxAutoCheckpoints ?? 5,
			reap: agent.reap,
			env,
			note,
		});
	}
	if (!agent.ok) {
		const detail = agent.detail ?? `the agent failed to build '${slug}'.`;
		return await saveAgentFailure({
			slug,
			branch,
			cwd: tree.dir,
			arbiter: tree.arbiterRemote,
			detail,
			env,
			note,
		});
	}

	// 5b. HONOR a deliberate STOP (task `agent-stop-signal`). The agent exited
	//     cleanly (`agent.ok`), but the CLAIM-PROTOCOL wrapper tells it to STOP and
	//     report on a DRIFTED/ambiguous/stale-premise task WITHOUT building. Detect
	//     that BEFORE the gate via the in-band sentinel (the agent's reason is the
	//     needs-attention reason VERBATIM); a clean STOP with no source change is the
	//     deterministic empty-diff backstop. Either routes to needs-attention and
	//     SKIPS the acceptance gate AND Gate-2 — a clean STOP is NOT "a build that
	//     changed nothing".
	const stopReason = await resolveStopReason({
		output: agent.output,
		slug,
		cwd: tree.dir,
		arbiter: tree.arbiterRemote,
		env,
	});
	if (stopReason !== undefined) {
		return await saveAgentStop({
			slug,
			branch,
			cwd: tree.dir,
			arbiter: tree.arbiterRemote,
			reason: stopReason.reason,
			kind: stopReason.kind,
			env,
			note,
		});
	}

	// 6. Gate + done-move + commit + rebase + integrate + branch-tidy LIKE
	//    `complete` — but with the AUTONOMOUS needs-attention surfacing (pass
	//    `surfaceArbiter` so a red gate / rebase conflict surfaces on the
	//    arbiter's main, cross-machine visible — a stuck CI `do` that only routed
	//    locally would be invisible). The success path reuses `complete`'s
	//    machinery unchanged.
	//
	// Push-time transport-coherence guard (identity): refuse a forbidden transport
	// for THIS arbiter's actual URL rather than silently pushing under an ambient
	// credential. A no-op when no identity is configured.
	try {
		assertTransportAllowed(options.identity, tree.arbiterUrl);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return await saveAgentFailure({
			slug,
			branch,
			cwd: tree.dir,
			arbiter: tree.arbiterRemote,
			detail: message,
			env,
			note,
		});
	}
	const completed = await performComplete({
		slug,
		cwd: tree.dir,
		arbiter: tree.arbiterRemote,
		integration: options.integration,
		// An explicit `--merge` overrides the untrusted-origin build-propose rule (task
		// `untrusted-origin-forces-build-propose`); the autonomous path leaves it
		// unset so untrusted-origin reliably forces propose.
		explicitMerge: options.explicitMerge,
		// `do` already ran the pre-flight divergence guard UP FRONT (step 3b), before
		// the claim + agent; skip `complete`'s redundant re-check. When `do` was run
		// with --ignore-diverged-main the guard was bypassed there too, so either way
		// the (now non-fatal) local-main sync handles any persisting divergence.
		ignoreDivergedMain: true,
		// `--allow-backlog`: treat a `tasks/backlog/`-resident body as a valid build
		// source so the done-move goes `tasks/backlog/ → tasks/done/` directly. Gated
		// on the flag (without it `complete` refuses a staged strand). Default off.
		allowBacklog: options.allowBacklog === true,
		prepare: options.prepare,
		verify: options.verify,
		freshWorktreeGate: options.freshWorktreeGate,
		// The cross-job merge-serialiser CAS-retry cap (config `mergeRetries`) — the
		// git-alone FLOOR of the cross-job land queue (spec `land-time-reverify-and-
		// parallel-merge-ceiling` Story 5 / Applied Answer q1 (a)). Threaded so a
		// wide-matrix CI's raised cap actually reaches the merge loop.
		mergeRetries: options.mergeRetries,
		noPR: options.noPR,
		// The resolved provider INSTANCE seam (tests/embeddings inject a stubbed
		// GitHubProvider to drive the propose pipeline offline). Unset ⇒ the core
		// selects from the arbiter URL.
		providerInstance: options.providerInstance,
		// Half B (propose-mode PR body): the build agent's FINAL SUMMARY, captured
		// from the harness seam's `LaunchResult.output` (surfaced by `runDoAgent`
		// below) and threaded as the PR description. `complete` scaffolds a
		// deterministic header (task pointer) above it. Undefined ⇒ no body ⇒ the
		// provider degrades to `gh ... --fill` (no regression).
		body: agent.output,
		// Gate 2 (PR/code review) rides INSIDE `complete`: run the `review` SKILL as a
		// fresh-context agent after the green `verify` (the non-skippable floor) and
		// before the done-move. A `block` re-uses the same needs-attention surfacing
		// (`surfaceArbiter`) the red gate does; mapped to `needs-attention` below.
		review: options.review,
		reviewModel: options.reviewModel,
		reviewMaxRounds: options.reviewMaxRounds,
		reviewGate: options.reviewGate,
		// `--watch` (task `watch-review-session`): tail the Gate-2 review agent's
		// session live too, AFTER the build stream the `runDoAgent` watch surfaced
		// (the gate prints a build→review boundary). Threaded into the gate launch via
		// `complete`; OFF ⇒ the review path is byte-identical (sync launch, no tailer).
		watch: options.watch,
		watchSink: options.watchSink,
		sessionsDir: options.sessionsDir,
		// The autonomous failure-surfacing: route stuck items to the arbiter's
		// main (the `run` semantics), NOT local-only (the human `complete`).
		surfaceArbiter: tree.arbiterRemote,
		color: options.color,
		note,
		noteBlock: options.noteBlock,
		env,
		// The review AGENT (Gate 2) launches AMBIENT — never the identity env (an
		// agent must not act as the bot; only the runner's git ops carry identity).
		agentEnv: options.env,
	});

	if (
		completed.outcome === 'completed' ||
		completed.outcome === 'already-integrated'
	) {
		// `already-integrated` is the stranded-done auto-recover's clean no-op (the
		// kept tip was already on `<arbiter>/main` — e.g. the prior PR merged
		// out-of-band before the re-claim). It is a SUCCESSFUL terminal state — the
		// work is integrated — so it folds into `DoOutcome 'completed'` (exit 0),
		// not a new outcome value: the autonomous caller just needs to know the
		// integrate path ended cleanly. The distinct `CompleteOutcome` value
		// preserves the no-op signal for tests + the `complete` surface.
		return {
			exitCode: 0,
			outcome: 'completed',
			slug,
			branch,
			message: completed.message,
		};
	}
	if (completed.outcome === 'review-unparseable') {
		// Gate 2 RAN but its verdict was UNPARSEABLE (malformed JSON). The core already
		// routed it work-preservingly (branch pushed + surfaced). This is the FAILURE-
		// CAUSE axis, NOT a reviewer block: classify the parse-failure phrase the core
		// recorded → `transient-infra` (re-run the SAME work: the gate output is
		// stochastic + the parser now repairs the control-char class, so a re-run is far
		// more likely to parse). Same `classifyFailureCause` `run` uses, so `do`/`run`
		// agree on the label. (`classifyFailureCause` only EVER returns config/transient/
		// agent-failed; the malformed-JSON signature lands transient-infra, never a
		// silent success.)
		const cause = classifyFailureCause(completed.message);
		return {
			exitCode: 1,
			outcome: failureCauseToDoOutcome(cause),
			slug,
			branch,
			message: completed.message,
		};
	}
	if (
		completed.outcome === 'prepare-failed' ||
		completed.outcome === 'gate-failed' ||
		completed.outcome === 'review-blocked' ||
		completed.outcome === 'rebase-conflict' ||
		completed.outcome === 'strand-surfaced'
	) {
		// Failed env-prep / red gate / Gate-2 review block / rebase conflict — routed
		// to needs-attention (surfaced on the arbiter). A `prepare-failed` (the env
		// could not be made ready, so verify was NOT run) and a `review-blocked` are
		// mapped HERE the SAME way `gate-failed` is. The work did NOT complete; the
		// runner owns the bounce.
		//
		// `strand-surfaced` is the autonomous-strand parity (the SHARED `complete.ts`
		// seam already surfaced the source-strand / empty-staged refusal to
		// needs-attention on the arbiter) — in-place `performDo` inherits the fix
		// here, mapped to the SAME `needs-attention` outcome shape `do --remote`
		// (`runRemotePipeline`) uses, so `advance task:<slug>` (via the default
		// `doDriver = performDo`) agrees with the remote path on the caller-visible
		// label.
		//
		// PR-2b D3: a clean surface (routedToNeedsAttention:true) is GREEN.
		return {
			exitCode: completed.routedToNeedsAttention ? 0 : 1,
			outcome: 'needs-attention',
			slug,
			branch,
			message: completed.message,
		};
	}
	if (completed.outcome === 'surface-unmoved') {
		// Strand-surface could not land on the arbiter (CAS contention exhausted /
		// no arbiter) — HONESTLY still in-progress on the arbiter. Mirror
		// `runRemotePipeline`'s `surface-unmoved` mapping so in-place `performDo`
		// (and `advance task:<slug>` via the default `doDriver`) agrees with
		// `do --remote` on the same signal, never a fake success.
		return {
			exitCode: 1,
			outcome: 'surface-unmoved',
			slug,
			branch,
			message: completed.message,
		};
	}
	// refused (nothing to commit, wrong folder) / usage-error: surface verbatim —
	// BUT first reclassify a thrown CORE wiring/config error (which `performComplete`
	// swallows into `usage-error`) onto the SAME `config-error` cause `run` records,
	// closing the cross-path divergence (`do`: usage-error vs `run`: agent-failed for
	// the identical thrown core error). Best-effort: a non-config usage-error stays
	// `usage-error` (the conservative default — the classifier only re-labels what it
	// recognises).
	if (completed.outcome === 'usage-error') {
		const cause = classifyFailureCause(completed.message);
		if (cause === 'config-error') {
			return {
				exitCode: 1,
				outcome: 'config-error',
				slug,
				branch,
				message: completed.message,
			};
		}
	}
	const outcome: DoOutcome =
		completed.outcome === 'refused' ? 'refused' : 'usage-error';
	return {exitCode: 1, outcome, slug, branch, message: completed.message};
}

/**
 * The EXACT recovery one-liner handed to the operator when an isolated/remote `do`
 * integration fails terminally AFTER the work was committed + done-moved (the
 * stale-lease-strand class surfaced by Part B #97), leaving the job worktree
 * RETAINED. It points them straight at the recover-already-committed path
 * (`complete --isolated <slug>`) so they need not reverse-engineer the encoded
 * worktree path \u2014 the FINISH half of try-to-finish / else-surface. Detection is
 * unspoofable (an already-integrated task is a clean no-op), so re-running it is
 * always safe.
 *
 * `complete --isolated` recovers the retained WORKTREE, so it ONLY works ON THE
 * MACHINE that ran the job (the worktree is local + reaped when that runner ends).
 * From a DIFFERENT checkout (e.g. a CI-stranded job finished on your laptop),
 * `--isolated` finds no local worktree and silently no-ops; there, check out the
 * already-pushed work branch off the arbiter and run plain `complete`. Both named.
 */
export function recoverIsolatedOneLiner(slug: string): string {
	return (
		`To FINISH the stranded branch once the cause clears: ON THE SAME MACHINE that ` +
		`ran the job, run \`dorfl complete --isolated ${slug}\` (integrates the ` +
		`kept commit from the retained worktree; a no-op if already integrated). From ` +
		`ANOTHER checkout (e.g. a CI-stranded job finished on your laptop), check out ` +
		`the pushed work branch off the arbiter and run plain \`dorfl complete ` +
		`${slug}\` instead.`
	);
}

/**
 * Build the HONEST per-op fragment describing WHAT actually reached the arbiter
 * after a needs-attention route — reading the seam's captured per-op outcome
 * (`branchPush`) rather than ASSUMING "pushed" off the local move. Shared by
 * every save-failure / save-stop message site so they can never drift from
 * reality (the observed bug: the report claimed "pushed" when the branch push
 * was skipped-empty or failed). A PUSH failure (HIGH severity: work-at-risk /
 * breaks cross-machine recovery) flips the fragment to a loud "saved LOCALLY
 * only" with recovery guidance. The OBSERVABLE half (the stuck state) now rides
 * on the per-item lock `state: stuck` amend — there is no separate on-`main`
 * surface to report.
 */
function routeReport(
	routed: ApplyNeedsAttentionTransitionResult,
	branch: string,
): {fragment: string; pushFailed: boolean} {
	const branchPush = routed.branchPush ?? 'not-attempted';
	const branchFailed = branchPush === 'failed';

	if (branchFailed) {
		// HIGH severity: the recoverable branch push did not reach the arbiter — say
		// so loudly, the work is saved LOCALLY only, and how to recover.
		return {
			fragment:
				`push of ${branch} FAILED — the work is saved LOCALLY only; push it ` +
				'when online, then `requeue` (continue) or `requeue --reconcile` ' +
				'(non-destructive retry). Last resort: `requeue --reset` ' +
				'DESTRUCTIVELY discards.',
			pushFailed: true,
		};
	}

	// The push that was attempted succeeded (or was honestly skipped). Report
	// the branch state truthfully.
	let landed: string;
	if (branchPush === 'pushed') {
		landed = `pushed ${branch}`;
	} else if (branchPush === 'skipped-empty') {
		landed = `branch ${branch} skipped (nothing to recover yet)`;
	} else {
		landed = 'saved locally';
	}
	return {
		fragment:
			`${landed}. Recover via \`requeue\` (continue) or \`requeue --reconcile\` ` +
			'(non-destructive retry). Last resort: `requeue --reset` ' +
			'DESTRUCTIVELY discards.',
		pushFailed: false,
	};
}

/**
 * SAVE the partial work of a FAILED agent instead of dropping it (the keystone of
 * the `agent-fail-saves-work` task). An agent failure (`runDoAgent` returned
 * `ok:false`, threw, or the prompt could not be assembled) used to BARE-RETURN
 * `agent-failed`, leaving whatever the agent edited only on the local work branch
 * in the (disposable, possibly remote) job worktree — silently lost.
 *
 * This routes it through the SAME work-preserving machinery a RED GATE uses: the
 * ledger write seam's needs-attention transition (`git add -A` + a wip commit
 * capturing the agent's work, then — post lock-cutover — a LOCK AMEND to
 * `state: stuck` with the failure detail as the reason on the lock entry, in
 * place of the retired `git mv → needs-attention/` move-only commit), surfaced on
 * the arbiter's `main` (the autonomous, cross-machine-visible mode-M surfacing
 * `do` already uses for the gate-fail path) so `scan`/`status`/another machine
 * see it.
 *
 * It ALSO pushes the `work/<slug>` branch to the arbiter so the saved partial
 * commits travel cross-machine and the item is RECOVERABLE via `requeue`
 * (continue): the continue-detection in `continue-branch.ts` looks for an arbiter
 * `work/<slug>` ahead of main. That push now lives IN the ledger write seam (the
 * RECOVERABLE half of the needs-attention transition — fired when an `arbiter` is
 * given, best-effort, emptiness-guarded), consolidated there by
 * `centralise-bounce-branch-push` so it cannot drift from the OBSERVABLE surface;
 * this function no longer pushes separately.
 *
 * The EMPTY-failure case (the agent made NO commits / no changes) is handled
 * without crashing on an empty commit: `routeToNeedsAttention` (under the seam)
 * skips the wip commit when the tree is clean, and the move-only commit (reason +
 * the `git mv`) is always non-empty, so the failure reason is still surfaced.
 *
 * The OUTCOME is the classified failure CAUSE (the FAILURE-CAUSE axis): the
 * genuinely-new `transient-infra` / `config-error` where the surfaced detail makes
 * the cause knowable, else the conservative generic `agent-failed` (still distinct
 * from a clean success and from a red `gate-failed`/`needs-attention` — `do`'s exit
 * contract stays coherent). Only the WORK-PRESERVING side-effect (unchanged here)
 * matches the gate-failure path. We do NOT validate or "fix" the partial work — a broken
 * tree committed + surfaced (with the reason) is recoverable; the human chooses
 * `requeue` (continue) / `requeue --reconcile` (non-destructive retry) vs
 * `requeue --reset` (destructive last resort).
 */
async function saveAgentFailure(params: {
	slug: string;
	branch: string | undefined;
	cwd: string;
	arbiter: string;
	detail: string;
	env: NodeJS.ProcessEnv | undefined;
	note: (message: string) => void;
}): Promise<DoResult> {
	const {slug, cwd, arbiter, detail, env, note} = params;
	// The work branch is the namespaced build branch (`work/task-<slug>`; the
	// onboarding switched the checkout to it before the agent ran); derive it from
	// the slug so the push target is always defined even when the caller's `branch`
	// was not narrowed.
	const branch = params.branch ?? workBranchRef('task', slug);
	// Classify the failure CAUSE (best-effort + conservative) from the surfaced
	// detail — the SAME `classifyFailureCause` `run` uses, so `do`/`run` agree on the
	// same error. The cause LABEL prefixes the recorded reason so the cause is legible
	// on the needs-attention route without a second naming scheme; `agent-failed`
	// keeps the historical "agent failed:" prefix (no reason-prose regression).
	const cause = classifyFailureCause(detail);
	const reason = `${failureCauseLabel(cause)}: ${detail}`;

	// Route through the SAME seam the gate-fail path uses: save the agent's work as
	// a wip commit (skipped when the tree is clean — the empty-failure case), amend
	// the item's per-item lock ref to `state: stuck` with the reason in the body,
	// surface that lock amend on the arbiter (OBSERVABLE, mode-M, cross-machine
	// visible) AND push the `work/<slug>` branch (RECOVERABLE — so a requeue-continue
	// reading <arbiter>/work/<slug> lands on the saved wip). Both halves fire from
	// the single `arbiter` here; no separate push to forget.
	const routed = await ledgerWrite.applyNeedsAttentionTransition({
		cwd,
		slug,
		reason,
		arbiter,
		env,
		note,
	});

	const report = routed.moved ? routeReport(routed, branch) : undefined;
	const message = routed.moved
		? `Agent run failed building '${slug}' [${cause}] (${detail}); SAVED the ` +
			`partial work and marked '${slug}' stuck on its lock (${report!.fragment}).`
		: `Agent run failed building '${slug}' [${cause}] (${detail}); could not ` +
			`mark '${slug}' stuck (${routed.reasonNotMoved ?? 'unknown'}).`;
	note(message);
	// PR-2b D3: a cleanly-surfaced bounce is GREEN (exitCode 0); a FAILED surface
	// stays non-zero.
	return {
		exitCode: routed.moved ? 0 : 1,
		outcome: failureCauseToDoOutcome(cause),
		slug,
		branch,
		routedToNeedsAttention: routed.moved,
		message,
	};
}

/**
 * Map a {@link FailureCause} onto the `do` {@link DoOutcome}. The cause names ARE
 * the outcome names (the FAILURE-CAUSE axis reuses the terminal vocabulary), so
 * this is identity — a single helper documents the mapping + keeps the `do`/`run`
 * sites symmetric (`run` has the twin {@link failureCauseToItemStatus}).
 */
function failureCauseToDoOutcome(cause: FailureCause): DoOutcome {
	return cause;
}

/**
 * Build the HONEST result for a CONTINUE-site surface that did NOT land on the
 * arbiter (`{moved: false}`). The tree-less stuck-lock amend (post lock-cutover —
 * `state: stuck` with the reason, in place of the retired `in-progress/ →
 * needs-attention/` move)
 * lost the CAS race against a busy arbiter (its contention-retry cap exhausted) or
 * had no arbiter to publish to, so the item is STILL in-progress on the arbiter —
 * a clean `needs-attention` would mislead (it claims the surface landed). Distinct
 * `surface-unmoved` outcome, carrying `reasonNotMoved`, so the caller/human can
 * tell it from a successful surface and retry/resolve. The `moved: true` path is
 * left byte-for-byte unchanged (this branch is only reached on `!moved`).
 */
function surfaceUnmovedDoResult(params: {
	slug: string;
	branch?: string;
	reason: string;
	surfaced: SurfaceToNeedsAttentionResult;
}): DoResult {
	const {slug, branch, reason, surfaced} = params;
	const message =
		`'${slug}' could NOT be surfaced to needs-attention — the surface did not ` +
		`reach the arbiter's main; the item is still IN-PROGRESS on the arbiter ` +
		`(retry/resolve). ${surfaced.reasonNotMoved ?? reason}`;
	return {exitCode: 1, outcome: 'surface-unmoved', slug, branch, message};
}

/**
 * Resolve the STOP reason for a clean (`agent.ok`) run, or `undefined` when the
 * run is a genuine build that should proceed to the gate (task
 * `agent-stop-signal`). TWO independent triggers, the sentinel winning:
 *
 *   1. The IN-BAND STOP sentinel in the agent's output ({@link parseStopSentinel})
 *      — the principled case: the agent declared the task drifted/ambiguous and
 *      reported WHY. Its reason is used VERBATIM (a non-empty diff with a sentinel
 *      is still a STOP — the agent may have left scratch; the sentinel wins).
 *   2. The DETERMINISTIC empty-diff backstop ({@link isWorkBranchDiffEmpty}) — the
 *      observable safety net for when the agent stopped WITHOUT (or with a
 *      malformed) sentinel: `agent.ok` but no source change vs `<arbiter>/main` is
 *      never a successful build.
 *
 * Shared by `performDo` and `runRemotePipeline` so the in-place and remote forms
 * detect a STOP identically.
 */
async function resolveStopReason(params: {
	output: string | undefined;
	slug: string;
	cwd: string;
	arbiter: string;
	env: NodeJS.ProcessEnv | undefined;
}): Promise<AgentStopClass | undefined> {
	const {output, slug, cwd, arbiter, env} = params;
	const sentinel = parseStopSentinel(output);
	if (sentinel !== undefined) {
		return {kind: 'sentinel', reason: sentinel.reason};
	}
	if (await isWorkBranchDiffEmpty({cwd, arbiter, env})) {
		return {kind: 'empty-diff', reason: emptyDiffStopReason(slug)};
	}
	return undefined;
}

/**
 * Route a DELIBERATE agent STOP (task `agent-stop-signal`) to needs-attention
 * through the SAME work-preserving seam `saveAgentFailure` uses (save the branch,
 * surface on the arbiter) — but as the DISTINCT `agent-stopped` outcome, NOT
 * `agent-failed` (the agent did not error) nor `needs-attention` (no red gate /
 * rebase conflict). The agent's STOP reason is recorded VERBATIM as the
 * needs-attention reason. The acceptance gate AND Gate-2 are NEVER reached.
 */
async function saveAgentStop(params: {
	slug: string;
	branch: string | undefined;
	cwd: string;
	arbiter: string;
	reason: string;
	kind: 'sentinel' | 'empty-diff';
	env: NodeJS.ProcessEnv | undefined;
	note: (message: string) => void;
}): Promise<DoResult> {
	const {slug, cwd, arbiter, reason, kind, env, note} = params;
	const branch = params.branch ?? workBranchRef('task', slug);

	// EMPTY-DIFF branch (spec resolved decision #2, task
	// `empty-diff-bounce-surfaces-dispose-defaulted-question`): surface a sidecar
	// on `<arbiter>/main` carrying an engine-authored DISPOSE-DEFAULTED envelope
	// question, THEN release the lock. "Nothing to do" is a non-deterministic LLM
	// judgement, so this seam MUST NOT blindly requeue (that would infinite-loop);
	// the surfaced sidecar + `needsAnswers:true` on `main` parks the item as a
	// human-visible question a `dispose` answer settles to `tasks/cancelled/`.
	if (kind === 'empty-diff') {
		const item = `task:${slug}`;
		const itemPath = resolveItemPathByIdentity(cwd, item);
		if (itemPath === undefined) {
			const message =
				`The agent STOPPED building '${slug}' (empty diff) but its body could ` +
				`not be located on the arbiter to surface a sidecar. Reason: ${reason}`;
			note(message);
			return {
				exitCode: 1,
				outcome: 'agent-stopped',
				slug,
				branch,
				routedToNeedsAttention: false,
				message,
			};
		}
		const surfaced = await surfaceStuckToNeedsAttention({
			cwd,
			slug,
			item,
			itemPath,
			reason,
			envelope: emptyDiffDisposeEnvelope({item, reason}),
			arbiter,
			env,
			note,
		});
		const message = surfaced.surfaced
			? `The agent STOPPED building '${slug}' (empty diff); surfaced a ` +
				`dispose-defaulted question on ${arbiter}/main and released the lock. ` +
				`Reason: ${reason}`
			: `The agent STOPPED building '${slug}' (empty diff) but the surface ` +
				`did not land (${surfaced.reasonNotSurfaced ?? 'unknown'}). ` +
				`Reason: ${reason}`;
		note(message);
		return {
			exitCode: 1,
			outcome: 'agent-stopped',
			slug,
			branch,
			routedToNeedsAttention: surfaced.surfaced,
			message,
		};
	}

	const routed = await ledgerWrite.applyNeedsAttentionTransition({
		cwd,
		slug,
		reason,
		arbiter,
		env,
		note,
	});

	const report = routed.moved ? routeReport(routed, branch) : undefined;
	const message = routed.moved
		? `The agent STOPPED building '${slug}' (the task drifted / is ambiguous / ` +
			`produced no change); marked '${slug}' stuck on its lock (${report!.fragment}) ` +
			`WITHOUT running the gate or Gate-2 review. Reason: ${reason}`
		: `The agent STOPPED building '${slug}' but it could not be marked stuck ` +
			`(${routed.reasonNotMoved ?? 'unknown'}). Reason: ${reason}`;
	note(message);
	// PR-2b D3: agent-stopped (sentinel) on a clean surface is GREEN (exitCode 0);
	// a FAILED surface stays non-zero. The empty-diff branch above is UNCHANGED
	// (owned by `empty-diff-bounce-surfaces-dispose-defaulted-question`).
	return {
		exitCode: routed.moved ? 0 : 1,
		outcome: 'agent-stopped',
		slug,
		branch,
		routedToNeedsAttention: routed.moved,
		message,
	};
}

/**
 * Run the agent against the checkout. Prefers the injected `dorfl` (tests
 * / custom embeddings); otherwise launches `agentCmd` through the SHARED
 * {@link launchWithOptionalWatch} helper (the null adapter by default),
 * forwarding the model routing intent.
 *
 * With `--watch` (pi harness only, validated earlier), the helper launches the
 * agent NON-BLOCKING (`PiHarness.launchAsync` — `spawn`, not `spawnSync`) so a
 * `SessionTailer` can READ the growing session `.jsonl` concurrently and surface
 * the high-signal events live. The tailer is a pure observer: the launch result
 * is IDENTICAL to the non-watch path, so outcome / gate / git / exit code are
 * unchanged — only a concurrent log-tail is added.
 *
 * The build session-id is the SLUG (in-place `do` has no work-id), which the
 * helper makes unique per launch; the Gate-2 REVIEW launch uses the SAME helper
 * with a DISTINCT id (`<slug>-review`) so the two sessions never collide — one
 * watch implementation, two callers (task `watch-review-session`).
 */
async function runDoAgent(
	options: DoAgentLaunchOptions,
	cwd: string,
	prompt: string,
	slug: string,
): Promise<{
	ok: boolean;
	detail?: string;
	output?: string;
	timedOut?: boolean;
	reap?: AgentTreeReap;
}> {
	if (options.dorfl) {
		return options.dorfl({cwd, prompt, slug, env: options.env});
	}
	const harness = options.harness ?? new NullHarness();

	// WORKING-TREE SENTINEL (observation
	// `checkpoint-releases-lock-while-predecessor-agent-still-writes`): the item
	// lock guards the ITEM; this guards the TREE. A deadline checkpoint releases the
	// item lock so the next tick can continue the task in the SAME worktree, so the
	// item lock alone cannot keep a successor out while a predecessor is still
	// alive. Refuse to launch a second agent into a tree that already has a LIVE
	// writer, independently of the reap. A dead holder's sentinel is stale and taken
	// over, so a crashed runner never poisons the worktree.
	const writer = acquireWorktreeWriterLock({dir: cwd, slug, env: options.env});
	if (!writer.acquired) {
		return {ok: false, detail: writer.reason};
	}
	try {
		return await launchAgentUnderWriterLock({
			options,
			cwd,
			prompt,
			slug,
			harness,
		});
	} finally {
		writer.release();
	}
}

/**
 * The actual harness launch, run while this process holds the worktree writer
 * sentinel (see {@link runDoAgent}). Split out purely so the sentinel's
 * acquire/release brackets the launch in a `try/finally` without indenting the
 * whole body.
 */
async function launchAgentUnderWriterLock(params: {
	options: DoAgentLaunchOptions;
	cwd: string;
	prompt: string;
	slug: string;
	harness: Harness;
}): Promise<{
	ok: boolean;
	detail?: string;
	output?: string;
	timedOut?: boolean;
	reap?: AgentTreeReap;
}> {
	const {options, cwd, prompt, slug, harness} = params;
	// Convert the dorfl-internal deadline (minutes) into a wall-clock epoch-ms so
	// the harness (`launchAsync`) can race the child against it (spec
	// `graceful-pre-timeout-wip-checkpoint`). Absent ⇒ no deadline; a run that
	// finishes before it is byte-for-byte unchanged (the harness clears the
	// timer on normal exit). Forcing the async path when a deadline is set is
	// {@link launchWithOptionalWatch}'s job.
	const deadlineMs =
		options.agentDeadlineMinutes !== undefined
			? Date.now() + options.agentDeadlineMinutes * 60_000
			: undefined;
	const launched = await launchWithOptionalWatch({
		harness,
		dir: cwd,
		slug,
		command: options.agentCmd ?? '',
		prompt,
		model: options.model,
		// In-place `do` has NO work-id, so the build session id is the slug.
		sessionId: slug,
		sessionsDir: options.sessionsDir,
		watch: options.watch,
		deadlineMs,
		watchSink: options.watchSink,
		color: options.color,
		env: options.env,
	});
	// Surface the agent's FINAL SUMMARY (`LaunchResult.output`) — the source channel
	// for the propose-mode PR body — instead of dropping it. Absent (no parseable
	// assistant text) ⇒ undefined ⇒ the body degrades to `--fill` (no regression).
	return {
		ok: launched.ok,
		detail: launched.detail,
		output: launched.output,
		timedOut: launched.timedOut,
		// The harness's PROOF that a deadline-stopped agent's process tree is gone.
		// Threaded to {@link routeDeadlineCheckpoint}, which refuses to release the
		// item lock without it.
		reap: launched.reap,
	};
}

/**
 * Route a DEADLINE STOP (spec `graceful-pre-timeout-wip-checkpoint`) through
 * the checkpoint machinery: ALWAYS save the WIP (commit + push), then
 * decide — progress AND under ceiling ⇒ AUTO-CONTINUE (release lock, keep
 * branch, NO sidecar, exit 0); else ⇒ SURFACE a `needsAnswers:true` question.
 * Shared by {@link performDo} and {@link runRemotePipeline} so the in-place
 * and remote forms route a deadline stop identically.
 */
async function routeDeadlineCheckpoint(params: {
	slug: string;
	branch: string;
	cwd: string;
	arbiter: string;
	maxAutoCheckpoints: number;
	/**
	 * The harness's VERIFIED reap of the checkpointed agent's process tree. The
	 * auto-continue branch releases the lock and lets the next tick dispatch a
	 * SUCCESSOR into this same worktree, so it may only run once the predecessor
	 * is proven gone (observation
	 * `checkpoint-releases-lock-while-predecessor-agent-still-writes`). Absent ⮕
	 * the harness spawned no killable group (test doubles, the null adapter), which
	 * is treated as "nothing was left running".
	 */
	reap?: AgentTreeReap;
	env: NodeJS.ProcessEnv | undefined;
	note: (message: string) => void;
}): Promise<DoResult> {
	const {slug, branch, cwd, arbiter, maxAutoCheckpoints, reap, env, note} =
		params;

	// 0. THE PREDECESSOR MUST BE DEAD BEFORE THE LOCK CAN MOVE.
	//
	// The item lock guards the ITEM; nothing guards the WORKING TREE. So if we
	// released the lock while the checkpointed agent's tree were still alive, the
	// next tick would onboard a successor into the very worktree the predecessor is
	// still writing to — one lock, one working tree, two live writers. That was
	// observed in the field: a predecessor kept writing for four minutes into its
	// successor's run, and its last write landed on a file the successor had already
	// read as clean in its opening `git status`.
	//
	// A reap we could not VERIFY is therefore a hard stop for the auto-continue
	// path. We still SAVE the work below (never lose work) and still surface the
	// item, but we do not hand the tree to anybody else.
	const predecessorGone = reap === undefined || reap.reaped;
	if (reap !== undefined && reap.escalatedToSigkill && reap.reaped) {
		note(`Deadline checkpoint for '${slug}': ${reap.detail}`);
	}

	// 1. ALWAYS save the WIP first: commit any residue + push the work branch.
	const savedReason = `deadline checkpoint save for '${slug}'`;
	const saved = await saveDeadlineCheckpoint({
		slug,
		branch,
		cwd,
		arbiter,
		reason: savedReason,
		env,
		note,
	});
	void saved;

	// 2. Progress this session? Reuse the SAME primitive the STOP backstop uses.
	const emptyDiff = await isWorkBranchDiffEmpty({cwd, arbiter, env});
	const madeProgressThisSession = !emptyDiff;

	// 3. Count consecutive deadline checkpoints on the branch (ceiling gate). The
	//    marker commit we just saved is included — so the count is the number
	//    of checkpoints INCLUDING this one.
	const checkpointCount = await countDeadlineCheckpointsOnBranch({
		cwd,
		arbiter,
		branch,
		env,
	});

	if (
		predecessorGone &&
		madeProgressThisSession &&
		checkpointCount <= maxAutoCheckpoints
	) {
		// AUTO-CONTINUE: release the lock via the SAME default keep+continue path
		// `requeue` uses (no --reset, no --reconcile, no sidecar). The branch is
		// KEPT on the arbiter so the next claim continues from its tip.
		const reason = deadlineAutoContinueReason({
			slug,
			count: checkpointCount,
			max: maxAutoCheckpoints,
		});
		const returned = await ledgerWrite.applyReturnToBacklogTransition({
			cwd,
			slug,
			arbiter,
			env,
			note,
		});
		if (returned.moved) {
			// Derive this line from the SINGLE state `returnToBacklog` resolved, never
			// from an independent assumption. It used to assert "the next tick continues
			// from <branch>" unconditionally, which contradicted the requeue's own
			// "'<slug>' has no work branch on <arbiter> — nothing to continue from" line
			// emitted two lines earlier. Both cannot be true, and acting on the wrong one
			// re-drives the task from scratch and discards the saved work (observation
			// `checkpoint-path-reports-its-own-write-as-absent`). One resolved state, one
			// story: mutually contradictory lines are worse than emitting nothing.
			const continueFrom = returned.continueBranch;
			const continuation =
				continueFrom === undefined || continueFrom.aheadOfMain
					? `lock released so the next tick continues from ${continueFrom?.branch ?? branch}`
					: continueFrom.trustworthy
						? 'lock released; the arbiter has no work to continue from, so the next ' +
							'tick starts this item fresh'
						: `lock released; the arbiter could not be read to confirm ${continueFrom.branch}, ` +
							'so do NOT assume the work is gone — check the branch before re-driving';
			const message =
				`Auto-continued '${slug}' at the dorfl-internal deadline (checkpoint ` +
				`${checkpointCount}/${maxAutoCheckpoints}): WIP saved + branch pushed, ` +
				`${continuation}. ${reason}`;
			note(message);
			return {
				exitCode: 0,
				outcome: 'deadline-auto-continued',
				slug,
				branch,
				message,
			};
		}
		// The auto-continue lock release did not land — fall through to SURFACE.
		note(
			`Auto-continue lock release for '${slug}' did not land ` +
				`(${returned.reasonNotMoved ?? 'unknown'}); surfacing instead.`,
		);
	}

	// SURFACE: mark the lock stuck via the whole applyNeedsAttentionTransition
	// (save + push + stuck). The WIP was already saved above; a second save is
	// idempotent (empty commit is skipped inside routeToNeedsAttention).
	const surfaceReason = !predecessorGone
		? deadlineSurfaceReason({slug, kind: 'unreaped', detail: reap?.detail})
		: madeProgressThisSession
			? deadlineSurfaceReason({
					slug,
					kind: 'ceiling',
					count: checkpointCount,
					max: maxAutoCheckpoints,
				})
			: deadlineSurfaceReason({slug, kind: 'no-progress'});
	const routed = await ledgerWrite.applyNeedsAttentionTransition({
		cwd,
		slug,
		reason: surfaceReason,
		arbiter,
		env,
		note,
	});
	const report = routed.moved ? routeReport(routed, branch) : undefined;
	const why = !predecessorGone
		? 'the checkpointed agent could not be verified dead'
		: madeProgressThisSession
			? `ceiling ${checkpointCount}/${maxAutoCheckpoints}`
			: 'no progress this session';
	const message = routed.moved
		? `Surfaced '${slug}' at the deadline checkpoint (${why}); ` +
			`${report!.fragment}. ${surfaceReason}`
		: `Could not surface '${slug}' at the deadline checkpoint ` +
			`(${routed.reasonNotMoved ?? 'unknown'}). ${surfaceReason}`;
	note(message);
	return {
		exitCode: 1,
		outcome: 'deadline-surfaced',
		slug,
		branch,
		routedToNeedsAttention: routed.moved,
		message,
	};
}

/**
 * True when the working tree has uncommitted (unstaged OR staged) changes — the
 * dirty-tree refusal predicate (ar-run.sh: `git diff --quiet` AND
 * `git diff --cached --quiet`). Read-only.
 */
async function isDirtyTree(
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<boolean> {
	const unstaged = await runAsync('git', ['diff', '--quiet'], cwd, {env});
	if (unstaged.status !== 0) {
		return true;
	}
	const staged = await runAsync('git', ['diff', '--cached', '--quiet'], cwd, {
		env,
	});
	return staged.status !== 0;
}

/**
 * `dorfl do --remote <r> <arg>` — the per-repo `do` WORKER run against a
 * REGISTERED repo with NO checkout (`docs/adr/command-surface-and-journeys.md`
 * §3). Where the in-place {@link performDo} uses the CURRENT checkout AS its
 * isolation, this form materialises a **hub mirror + job worktree in the AGENTS'
 * area** (`workspacesDir`, the SAME isolation `run` uses — NEVER the human area),
 * runs the existing `do` pipeline against that worktree, then tears it down per
 * the §4 provably-safe deletion predicate.
 *
 * **Option A — materialise-then-reuse** (the drift correction; the full
 * IsolatedTree-seam unification is the SEPARATE `do-run-share-isolation-seam`
 * task). `performDo` composes the human verbs against a literal `cwd`; this
 * function does the same — it just points that `cwd` at a freshly-cut job
 * worktree instead of a checkout. It reuses (does NOT reimplement) the pipeline:
 * `performStart` (resume) → agent → `performComplete`.
 *
 * **The claim ↔ worktree ↔ start composition.** Both `createJob` (cuts the
 * `work/<slug>` branch off the mirror's fresh main) and `performStart` (claims +
 * switches to `work/<slug>`) overlap. To compose without double-claiming or
 * fighting over the branch we order them as the task mandates:
 *
 *   1. **CLAIM FIRST** — the CAS push to the arbiter, run in a throwaway clone of
 *      the mirror (the CAS needs a non-bare checkout with an `origin/main`
 *      tracking ref + a worktree to commit in, which a bare mirror does not
 *      provide — exactly `work-on`'s remote-form claim context).
 *   2. **MATERIALISE the worktree** off the POST-CLAIM fresh main via the EXISTING
 *      job-worktree machinery (`jobWorktreeStrategy`/`createJob`): `createJob`
 *      re-`ensureMirror`s (fetching the claim move) then cuts `work/<slug>` off
 *      the freshly-fetched mirror main.
 *   3. **RUN start/agent/complete** against the worktree dir as `cwd`. `start` is
 *      driven with `resume: true` so it PLAIN-SWITCHES the branch `createJob`
 *      already created (the item is in-progress on the arbiter after the claim;
 *      `performStart`'s resume path switches without re-claiming) — no
 *      double-claim, no branch fight. The worktree's arbiter remote is `origin`
 *      (the bare mirror's clone remote), so both `start` and `complete` use
 *      `origin`.
 *
 * **Teardown** re-applies the §4 predicate via the strategy handle's `teardown`
 * (`reapJob`): reap the worktree iff clean AND on the arbiter, retain otherwise
 * (the never-lose-work signal). NEVER `--force`.
 *
 * **Recovery contract.** The worktree is disposable; the durable artifact is the
 * `work/<slug>` BRANCH (pushed by the autonomous needs-attention surfacing on a
 * stuck/failed run). A human recovers via the human face (`requeue` + re-claim,
 * or `work-on`), NEVER by editing the agents'-area worktree.
 */
/**
 * Resolve the URL of a CHECKOUT's arbiter remote — the primitive `do --isolated`
 * needs to point the job-worktree pipeline ({@link performDoRemote}) at MY OWN
 * arbiter (`git -C <cwd> remote get-url <arbiter>`). Returns the URL, or
 * `undefined` when the cwd is not a git repo or has no such remote (the
 * "isolated against what?" case the CLI turns into a clear error naming
 * `--remote <url>`). Does NOT fork the isolation/integrate path — it only feeds
 * the EXISTING `performDoRemote` its `remote` URL.
 */
export function resolveArbiterUrlFromCheckout(
	cwd: string,
	arbiter: string,
	env?: NodeJS.ProcessEnv,
): string | undefined {
	const res = run('git', ['remote', 'get-url', arbiter], cwd, {env});
	if (res.status !== 0) {
		return undefined;
	}
	const url = res.stdout.trim();
	return url === '' ? undefined : url;
}

export async function performDoRemote(
	options: DoRemoteOptions,
): Promise<DoResult> {
	const note = options.note ?? (() => {});
	// The runner's GIT/provider env, scoped to the configured identity (claim,
	// push, integrate, `gh`). The AGENT launch stays ambient via `options.env`
	// (`runDoAgent` reads it directly) — the agent must not commit as the bot.
	// Absent identity ⇒ `options.env` unchanged (byte-for-byte ambient).
	const workspacesDir = options.workspacesDir;

	// Resolve the identity env AND run the push-time transport-coherence guard:
	// refuse a forbidden transport for THIS remote's URL (the registered remote),
	// and fail cleanly on an unresolvable identity (e.g. `tokenEnv` unset) — never
	// a crash or a silent ambient fallback. Both are no-ops without an identity.
	let env: NodeJS.ProcessEnv;
	try {
		env = identityEnv(options.identity, options.env ?? process.env);
		assertTransportAllowed(options.identity, options.remote);
	} catch (err) {
		return {
			exitCode: 1,
			outcome: 'usage-error',
			message: err instanceof Error ? err.message : String(err),
		};
	}

	// 0. `--watch` REQUIRES the pi harness (same guard as in-place `do`): only the
	//    pi adapter writes a session `.jsonl` to tail. Error CLEARLY here, BEFORE
	//    any mirror/claim/worktree side-effect. The injected `dorfl` (tests)
	//    is its own launch path and is exempt.
	if (
		options.watch === true &&
		options.dorfl === undefined &&
		!(options.harness instanceof PiHarness)
	) {
		return {
			exitCode: 1,
			outcome: 'usage-error',
			message:
				'`do --watch` requires the pi harness; configure `harness: pi` or drop ' +
				'`--watch`.',
		};
	}

	// 1. Resolve / auto-create the hub mirror for `<r>` (the `registry-remote` /
	//    `work-on`-remote precedent: an unregistered remote is auto-mirrored
	//    before use). `ensureMirror` creates it (`git clone --bare`) when absent
	//    or fetches it when present, under `workspacesDir/repos/` — the agents'
	//    area, NEVER the human area.
	let mirror;
	try {
		mirror = ensureMirror({url: options.remote, workspacesDir, env});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {exitCode: 1, outcome: 'usage-error', message};
	}
	note(
		mirror.created
			? `Auto-registered hub mirror for ${mirror.url} at ${mirror.path}.`
			: `Using hub mirror for ${mirror.url} at ${mirror.path}.`,
	);

	// 1b. PR-INTENT pre-flight guard — the AUTONOMOUS mirror of in-place `performDo`
	//     step 3c. The SAME predicate, run UP FRONT here (mirror resolved, BEFORE the
	//     claim clone / worktree) so a `propose` run on a GitHub arbiter that INTENDS a
	//     PR (`noPR` unset) fails fast when `gh` genuinely cannot open one, instead of
	//     letting integration silently degrade to manual-PR instructions. NO claim/
	//     build side-effect: it precedes even the throwaway claim CLONE below. The probe
	//     runs in the bare mirror dir (`mirror.path`), which carries the arbiter remote
	//     as `origin`, NOT a bare cwd. CRITICAL: the PROBE is the signal, NOT a config
	//     check — an absent `providers.github` identity falls back to AMBIENT `gh` auth
	//     (the probe reports it available), so a working ambient setup still PROCEEDS.
	//     `arbiterIsGitHub` is derived from `mirror.url` (the resolved arbiter URL).
	//     REUSES the predicate + message so the in-place + autonomous paths cannot
	//     drift.
	{
		const probe =
			options.ghCanOpenPr ??
			((probeCwd, probeEnv) =>
				new GitHubProvider().available(probeCwd, probeEnv));
		if (
			shouldFailProposePrIntent({
				mode: options.integration ?? 'propose',
				arbiterIsGitHub: isGitHubArbiterUrl(mirror.url),
				noPR: options.noPR,
				ghCanOpenPr: () => probe(mirror.path, env),
			})
		) {
			return {
				exitCode: 1,
				outcome: 'refused',
				message: PROPOSE_PR_INTENT_GH_UNAVAILABLE_MESSAGE,
			};
		}
	}

	// 1c. STATIC fresh-worktree-gate readiness guard — the AUTONOMOUS mirror of
	//     `performDo` step 3d. When the fresh-worktree gate is ON AND `prepare`
	//     resolves to no commands AND a lockfile is present IN THE MIRROR, the
	//     throwaway worktree the gate runs in will have no installed deps, so the
	//     gate cannot run. Probe the bare mirror's main tree (`git ls-tree main`)
	//     so the guard fires BEFORE the throwaway claim clone is even cut. A repo
	//     with NO lockfile is the intentional dep-free case and proceeds. The guard
	//     ALSO fails fast when `verify` is unset/all-blank (a MODE-INDEPENDENT stop —
	//     Dorfl has no default gate, so an unconfigured `verify` never passes).
	{
		const guard = checkGatePreconditions({
			freshWorktreeGate: options.freshWorktreeGate,
			prepare: options.prepare,
			verify: options.verify,
			lockfile: detectLockfileOnMirrorMain(mirror.path, env),
		});
		if (guard !== undefined) {
			return {exitCode: 1, outcome: 'refused', message: guard.message};
		}
	}

	// 2. A throwaway claim clone of the mirror (the CAS context). Slug resolution
	//    + the claim both run here against `origin` (the arbiter URL). Keyed PER
	//    ARG (not a single fixed `__remote` path per mirror) so two CONCURRENT
	//    `do --remote` calls on the SAME mirror — the registry-set advance batch's
	//    per-mirror concurrency (`perRepoMax > 1`) — get DISTINCT claim clones rather
	//    than racing one shared dir (the SAME per-job-clone keying `run`'s
	//    `claimAgainstRepo` uses; the prior single-shot caller never raced, so this
	//    is a pure concurrency hardening, not a behaviour change for it).
	const claimKey = options.arg.replace(/[^a-zA-Z0-9._-]/g, '_');
	const claimDir = join(
		workspacesDir,
		'claim',
		`${encodeRepoKey(mirror.url).split('/').join('__')}__${claimKey}`,
	);
	rmSync(claimDir, {recursive: true, force: true});
	mkdirSync(dirname(claimDir), {recursive: true});
	git(['clone', '--quiet', mirror.url, claimDir], dirname(claimDir), {env});

	try {
		// 2a. Resolve the slug across BOTH namespaces against the claim clone (it
		//     carries `work/` from the mirror's main). A collision / resolution
		//     failure is a loud usage error; a `spec:` arg reaches the not-yet-wired
		//     stub — identical behaviour to in-place `do`.
		let resolved;
		try {
			resolved = resolveSlug({
				arg: options.arg,
				repoPath: claimDir,
				read: options.read ?? ledgerRead,
			});
		} catch (err) {
			if (err instanceof SlugResolutionError) {
				return {exitCode: 1, outcome: 'usage-error', message: err.message};
			}
			const message = err instanceof Error ? err.message : String(err);
			return {exitCode: 1, outcome: 'usage-error', message};
		}

		// `do --remote spec:<slug>` routes to tasking (the `spec` namespace).
		if (resolved.namespace === 'spec') {
			// `do --remote spec:<slug>`: task the spec as the AGENT, against the claim
			// clone (its `origin` IS the arbiter URL + it carries a working tree from the
			// mirror's main). No job worktree is needed — the tasking transition is a
			// runner-owned `spec → tasking → spec` move + emit-backlog on the arbiter, not
			// a build pipeline. The agent only writes task files; the runner does all git.
			const tasked = await performTask({
				slug: resolved.slug,
				cwd: claimDir,
				arbiter: 'origin',
				doer: 'agent',
				autoTask: options.autoTask,
				// EXPLICIT dispatch (same as the in-place path above): the `spec:<slug>` was
				// NAMED (typed, or pool-filtered on `autoTask` before reaching here), so the
				// tasking gate drops the policy term — only the spec's own readiness +
				// `taskedAfter` bind, mirroring the build path vs `autoBuild`.
				explicit: true,
				dorfl: options.dorfl,
				harness: options.harness,
				agentCmd: options.agentCmd,
				model: options.model,
				sessionsDir: options.sessionsDir,
				// The integrate-time args (task `slice-output-through-integration`): the
				// `provider` is the SAME the task-build path threads (arg parity), but the
				// MODE is the per-TRANSITION TASKING resolution
				// (`per-transition-integration-mode-slicing-vs-build`):
				// `taskingIntegration ?? integration`, so the `--remote spec:` output ALSO
				// routes through the shared core with the tasking-resolved mode.
				integration: options.taskingIntegration ?? options.integration,
				// The cross-job merge-serialiser CAS-retry cap (config `mergeRetries`) —
				// threaded on the no-checkout `do --remote spec:` tasking path too,
				// mirroring the in-place site above.
				mergeRetries: options.mergeRetries,
				// The per-repo TASK-PLACEMENT defaults (trusted + untrusted twin) + the
				// operator's explicit override. Same stamp-selected threading as the
				// in-place `do spec:` path (ADR `untrusted-origin-carries-via-stamp-
				// not-forced-staging`).
				tasksLandIn: options.tasksLandIn,
				untrustedTasksLandIn: options.untrustedTasksLandIn,
				explicitTasksLandIn: options.explicitTasksLandIn,
				noPR: options.noPR,
				providerInstance: options.providerInstance,
				// The tasker review→edit→converge loop on the `do --remote spec:` path too.
				reviewLoop: options.reviewLoop,
				taskerLoopMax: options.taskerLoopMax,
				reviewExecutions: options.reviewExecutions,
				taskerLoopModel: options.taskerLoopModel,
				// The task-SET ACCEPTANCE GATE on the `do --remote spec:` path too.
				review: options.review,
				reviewGate: options.taskReviewGate,
				acceptanceReviewModel: options.reviewModel,
				env,
				// The tasker + review AGENTS launch AMBIENT, never the identity env.
				agentEnv: options.env,
				note,
			});
			return taskResultToDoResult(tasked);
		}
		const slug = resolved.slug;

		// 3. CLAIM FIRST (the CAS push to the arbiter), in the throwaway clone.
		//    `origin` there IS the arbiter URL. A lost/contended/usage claim is
		//    propagated verbatim — NO worktree is materialised (clean failure, like
		//    `run`'s `runOneItem`).
		const claim = await performClaim({
			slug,
			cwd: claimDir,
			arbiter: 'origin',
			// `--allow-backlog`: accept a `tasks/backlog/`-resident body (staging). The
			// claim stays a pure lock. Default off ⇒ pool-only.
			allowBacklog: options.allowBacklog === true,
			env,
			note,
		});
		if (claim.outcome === 'lost') {
			return {exitCode: 2, outcome: 'lost', slug, message: claim.message};
		}
		if (claim.outcome === 'contended') {
			return {exitCode: 3, outcome: 'contended', slug, message: claim.message};
		}
		if (claim.exitCode !== 0) {
			return {
				exitCode: 1,
				outcome: 'usage-error',
				slug,
				message: claim.message,
			};
		}

		// 4. MATERIALISE the job worktree off the POST-CLAIM fresh main via the
		//    EXISTING job-worktree machinery (the SAME path `run` uses). `createJob`
		//    re-`ensureMirror`s (fetching the claim move) then cuts `work/<slug>`
		//    off the freshly-fetched mirror main, in the agents' area.
		const strategy = jobWorktreeStrategy({
			fromRepo: claimDir,
			arbiter: 'origin',
			workspacesDir,
		});
		let tree: IsolatedTree | undefined;
		let result: DoResult | undefined;
		try {
			try {
				tree = strategy.prepare({slug, type: 'task', env});
			} catch (err) {
				// `prepare()`/`createJob` THREW before returning the handle (e.g. an
				// onboard reconcile/stale-lease push surfaced as a throw). `tree` is
				// undefined, so the normal teardown below would be skipped and a
				// partially-created worktree could LEAK with no teardown attempt at all —
				// and its checked-out `work/<slug>` branch would then poison the next
				// build's fetch. Best-effort reap the deterministic worktree path for this
				// slug (it is reaped ONLY if its branch is reachable on the arbiter —
				// never lose work), then re-throw so the failure is still reported.
				reapPreparedWorktreeLeak(mirror.url, slug, workspacesDir, env, note);
				throw err;
			}
			result = await runRemotePipeline(options, tree, slug, note, env);
			return result;
		} finally {
			// 7. Teardown via the strategy handle. On a CLEAN completion: reap iff clean
			//    AND on the arbiter (the standard §4 predicate). On a FAILURE return
			//    (needs-attention / config-error / refused etc. — the seam already
			//    surfaced the item + pushed the branch): reap on REACHABILITY ALONE, so a
			//    churn-dirty-but-arbiter-safe worktree does not linger to poison the next
			//    build's config-read/materialisation fetch. A worktree whose work is NOT
			//    yet on the arbiter is RETAINED either way (never lose work). NEVER
			//    --force.
			if (tree) {
				const reachableOnly =
					result !== undefined && result.outcome !== 'completed';
				tree.teardown({reachableOnly});
			}
		}
	} finally {
		// Remove the throwaway claim clone either way.
		rmSync(claimDir, {recursive: true, force: true});
	}
}

/**
 * Best-effort reap of a worktree that {@link IsolationStrategy.prepare}/`createJob`
 * may have created at the deterministic per-job path BEFORE it threw (so the
 * handle was never returned and the normal teardown is skipped). Reaps it ONLY
 * if its branch is provably reachable on the arbiter — a `prepare` throw can
 * happen AFTER a clean continue-push (work is safe ⇒ reap so it can't poison the
 * next build) or BEFORE any push (work not safe ⇒ retain; never lose work). All
 * git ops are swallowed: this runs on an already-failing path and must never mask
 * the original throw.
 */
function reapPreparedWorktreeLeak(
	mirrorUrl: string,
	slug: string,
	workspacesDir: string,
	env: NodeJS.ProcessEnv | undefined,
	note: (m: string) => void,
): void {
	try {
		const dir = jobWorktreePath(workspacesDir, mirrorUrl, slug);
		if (!existsSync(dir)) {
			return;
		}
		const mirrorDir = mirrorPath(workspacesDir, mirrorUrl);
		const result = reapJob({
			dir,
			branch: workBranchRef('task', slug),
			mirrorPath: mirrorDir,
			// Same failure-path stance as the normal teardown: reachable-on-arbiter is
			// enough (don't let incidental churn retain a worktree whose branch is
			// already safe). Reachability still gates — unsaved work is retained.
			reachableOnly: true,
			env,
		});
		if (result.removed) {
			note(
				`Reaped leaked worktree for ${slug} after prepare() threw ` +
					`(branch safe on the arbiter).`,
			);
		}
	} catch {
		// best-effort — never mask the original prepare() throw
	}
}

/**
 * Run the existing `do` pipeline (start[resume] → agent → complete) against an
 * already-materialised job worktree. Mirrors {@link performDo}'s middle/back —
 * but `cwd` is the worktree and the arbiter remote inside it is `origin`. The
 * needs-attention surfacing is the AUTONOMOUS, arbiter-passed variant (like
 * `run`/in-place `do`): a stuck remote `do` must be cross-machine visible.
 */
async function runRemotePipeline(
	options: DoRemoteOptions,
	tree: IsolatedTree,
	slug: string,
	note: (m: string) => void,
	env: NodeJS.ProcessEnv | undefined,
): Promise<DoResult> {
	const cwd = tree.dir;
	const arbiterRemote = tree.arbiterRemote; // `origin` (the bare mirror's clone).

	// 4a. CONTINUE rebase conflict (ADR §14 + §10): a requeue kept a `work/<slug>`
	//     that did not replay onto the current main at onboard-time (aborted, never
	//     auto-resolved). Route to needs-attention via the seam (surfaced on the
	//     arbiter + the kept branch already on the arbiter) instead of running the
	//     agent — the §10 path `run` uses.
	if (tree.continueRebaseConflict) {
		const reason =
			`continuing the kept ${tree.branch}: rebase onto the latest main ` +
			'conflicted (aborted, never auto-resolved) — run `requeue --reconcile` ' +
			'to non-destructively re-sync the mirror and retry the rebase (keeps ' +
			'the work). Last resort: `requeue --reset` DESTRUCTIVELY discards the ' +
			'branch and starts fresh.';
		await ledgerWrite.applyNeedsAttentionTransition({
			cwd,
			slug,
			reason,
			arbiter: arbiterRemote,
			env,
			note,
		});
		return {
			exitCode: 1,
			outcome: 'needs-attention',
			slug,
			branch: tree.branch,
			message: reason,
		};
	}

	// 4b. CONTINUE reconcile-push TERMINAL failure (the stale-lease-strand bug this
	//     fix kills): the onboard reconcile push of the kept (already-committed)
	//     work branch to the arbiter FAILED terminally (the stale-lease retry cap
	//     exhausted, or a non-stale-lease rejection / unreachable arbiter). The push
	//     helper THROWS; `createJob` CATCHES it and flags `continuePushFailure`
	//     rather than letting the throw escape (which crashed the run and left the
	//     task silently in `work/in-progress/` on the arbiter, the work stranded in
	//     the worktree). Route to needs-attention via the SAME seam the conflict path
	//     uses — surfaced on the arbiter, the kept branch already on the arbiter from
	//     the prior requeue (recoverable) — instead of running the agent.
	if (tree.continuePushFailure !== undefined) {
		const reason =
			`continuing the kept ${tree.branch}: publishing the rebased work branch ` +
			`to the arbiter failed terminally (${tree.continuePushFailure}) — the kept ` +
			'branch is left intact on the arbiter (recoverable); `requeue --reconcile` ' +
			'to non-destructively re-sync the mirror and retry once the churn ' +
			'settles (keeps the work). Last resort: `requeue --reset` DESTRUCTIVELY ' +
			'discards the branch and starts fresh.';
		await ledgerWrite.applyNeedsAttentionTransition({
			cwd,
			slug,
			reason,
			arbiter: arbiterRemote,
			env,
			note,
		});
		return {
			exitCode: 1,
			outcome: 'needs-attention',
			slug,
			branch: tree.branch,
			message: reason,
		};
	}

	// 5. HARDEN start to work against a job-worktree `cwd` (the load-bearing work).
	//    `performStart` reads/switches via the `<arbiter>/main` REMOTE-TRACKING ref
	//    (`origin/main` here). A job worktree is cut from a BARE hub mirror whose
	//    `origin` remote has NO fetch refspec, so `origin/main` /
	//    `origin/work/<slug>` would not otherwise resolve — and `start` would
	//    wrongly read the slug as "absent". Prime those two remote-tracking refs
	//    EXPLICITLY (the SAME technique `integrator.rebaseOntoArbiterMain` /
	//    `gc.fetchTracking` use against a bare-mirror worktree). After this the
	//    existing `performStart` runs UNCHANGED against the worktree.
	await primeWorktreeTrackingRef(cwd, arbiterRemote, 'main', env);
	await primeWorktreeTrackingRef(
		cwd,
		arbiterRemote,
		workBranchRef('task', slug),
		env,
	);

	// Onboard onto the work branch like in-place `do` — but the item is ALREADY
	// CLAIMED (step 3), so `performStart` runs with `resume: true`: it
	// PLAIN-SWITCHES the `work/<slug>` branch `createJob` already created WITHOUT
	// re-claiming (no double-claim, no branch fight). This proves `start` works
	// against a job-worktree `cwd`.
	const started = await performStart({
		slug,
		cwd,
		arbiter: arbiterRemote,
		resume: true,
		// `--allow-backlog`: a staged body (claimed, still in `tasks/backlog/`) is a
		// valid onboard residence; without this `start` would read it as `absent`.
		allowBacklog: options.allowBacklog === true,
		env,
		note,
	});
	if (started.outcome === 'needs-attention') {
		return {
			exitCode: 1,
			outcome: 'needs-attention',
			slug,
			branch: started.branch,
			message: started.message,
		};
	}
	// FORWARD the honest un-moved signal end-to-end: a continue-site surface that
	// did NOT land on the arbiter (start's `surface-unmoved`) must NOT degrade to
	// `usage-error` here — the item is still in-progress on the arbiter (retry/resolve).
	if (started.outcome === 'surface-unmoved') {
		return {
			exitCode: 1,
			outcome: 'surface-unmoved',
			slug,
			branch: started.branch,
			message: started.message,
		};
	}
	if (started.exitCode !== 0) {
		const outcome: DoOutcome =
			started.outcome === 'refused' ? 'refused' : 'usage-error';
		return {exitCode: 1, outcome, slug, message: started.message};
	}
	const branch = started.branch;

	// 6. Build the prompt + run the agent autonomously in the worktree (the SAME
	//    assembly in-place `do` uses). The agent only edits code.
	let prompt: string;
	try {
		// CONTINUE-aware resolution (job-worktree path): admit `work/done/` ONLY
		// behind the tip-vs-arbiter stranded gate (story 5), using the worktree's
		// primed `<origin>/work/<slug>` vs `<origin>/main` tracking refs.
		const task = resolveTask(
			cwd,
			slug,
			{
				cwd,
				branchRef: `${arbiterRemote}/${branch}`,
				mainRef: `${arbiterRemote}/main`,
				env,
			},
			// `--allow-backlog`: also resolve a `tasks/backlog/`-resident body.
			{allowBacklog: options.allowBacklog === true},
		);
		// CONTINUE-mode (job-worktree path): the worktree's tracking refs were primed
		// above (`primeWorktreeTrackingRef`), so reuse the SAME continue-detection with
		// the worktree's `<origin>/work/<slug>` vs `<origin>/main` refs.
		const continueContext = resolveContinueContext({
			cwd,
			slug,
			arbiter: arbiterRemote,
			branchRef: `${arbiterRemote}/${branch}`,
			mainRef: `${arbiterRemote}/main`,
			content: readFileSync(task.path, 'utf8'),
			env,
		});
		// Per-item override layer (mirrors in-place `do`): the task/spec frontmatter
		// may override the resolved repo `promptGuidance.testFirst` for THIS item.
		const itemGuidance = resolvePromptGuidanceForItem({
			cwd,
			repoResolved: {testFirst: options.promptGuidance?.testFirst === true},
			taskContent: readFileSync(task.path, 'utf8'),
		});
		prompt = buildAgentPrompt(task.slug, task.spec, task.taskPrompt, {
			cwd,
			continueContext,
			promptGuidance: itemGuidance,
		});
	} catch (err) {
		if (err instanceof PromptError) {
			return await saveRemoteAgentFailure({
				slug,
				branch,
				cwd,
				arbiterRemote,
				detail: err.message,
				env,
				note,
			});
		}
		throw err;
	}

	let agent: {
		ok: boolean;
		detail?: string;
		output?: string;
		timedOut?: boolean;
		reap?: AgentTreeReap;
	};
	try {
		agent = await runDoAgent(options, cwd, prompt, slug);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return await saveRemoteAgentFailure({
			slug,
			branch,
			cwd,
			arbiterRemote,
			detail: message,
			env,
			note,
		});
	}
	// Deadline checkpoint on the no-checkout `do --remote` path — same routing
	// as the in-place path (see performDo).
	if (agent.timedOut) {
		return await routeDeadlineCheckpoint({
			slug,
			branch: branch ?? workBranchRef('task', slug),
			cwd,
			arbiter: arbiterRemote,
			maxAutoCheckpoints: options.maxAutoCheckpoints ?? 5,
			reap: agent.reap,
			env,
			note,
		});
	}
	if (!agent.ok) {
		const detail = agent.detail ?? `the agent failed to build '${slug}'.`;
		return await saveRemoteAgentFailure({
			slug,
			branch,
			cwd,
			arbiterRemote,
			detail,
			env,
			note,
		});
	}

	// 6b. HONOR a deliberate STOP (task `agent-stop-signal`) — the SAME detection
	//     in-place `do` runs, shared via `resolveStopReason`/`saveAgentStop`. A
	//     sentinel STOP (verbatim reason) or an empty work-branch diff routes to
	//     needs-attention (surfaced on the arbiter) and SKIPS the gate + Gate-2. The
	//     diff base is the worktree's `origin` (arbiterRemote).
	const stopReason = await resolveStopReason({
		output: agent.output,
		slug,
		cwd,
		arbiter: arbiterRemote,
		env,
	});
	if (stopReason !== undefined) {
		return await saveAgentStop({
			slug,
			branch,
			cwd,
			arbiter: arbiterRemote,
			reason: stopReason.reason,
			kind: stopReason.kind,
			env,
			note,
		});
	}

	// 7. Gate + done-move + commit + rebase + integrate LIKE in-place `do`: the
	//    AUTONOMOUS surfacing (`surfaceArbiter: origin`) so a red gate / rebase
	//    conflict / review block surfaces on the arbiter's main (cross-machine
	//    visible). The success path reuses `complete`'s machinery unchanged.
	const completed = await performComplete({
		slug,
		cwd,
		arbiter: arbiterRemote,
		integration: options.integration,
		// An explicit `--merge` overrides the untrusted-origin build-propose rule (task
		// `untrusted-origin-forces-build-propose`); unset on the autonomous path so
		// untrusted-origin reliably forces propose.
		explicitMerge: options.explicitMerge,
		// SCOPE: the divergence guard is in-place only. A job worktree is cut fresh off
		// the bare mirror and never ff's the operator's local main, so the guard does
		// not apply here — opt out explicitly (the task: do NOT touch do --remote/run).
		ignoreDivergedMain: true,
		// `--allow-backlog`: a staged build sources from `tasks/backlog/` (gated on
		// the flag; otherwise a staged strand still refuses). Default off.
		allowBacklog: options.allowBacklog === true,
		prepare: options.prepare,
		verify: options.verify,
		freshWorktreeGate: options.freshWorktreeGate,
		// The cross-job merge-serialiser CAS-retry cap (config `mergeRetries`) — see
		// the in-place site above for the rationale; mirrored here so the no-checkout
		// `do --remote`/`--isolated` path threads the same resolved cap.
		mergeRetries: options.mergeRetries,
		noPR: options.noPR,
		providerInstance: options.providerInstance,
		body: agent.output,
		review: options.review,
		reviewModel: options.reviewModel,
		reviewMaxRounds: options.reviewMaxRounds,
		reviewGate: options.reviewGate,
		watch: options.watch,
		watchSink: options.watchSink,
		sessionsDir: options.sessionsDir,
		surfaceArbiter: arbiterRemote,
		color: options.color,
		note,
		noteBlock: options.noteBlock,
		env,
		// The review AGENT (Gate 2) launches AMBIENT — never the identity env (an
		// agent must not act as the bot; only the runner's git ops carry identity).
		agentEnv: options.env,
	});

	if (
		completed.outcome === 'completed' ||
		completed.outcome === 'already-integrated'
	) {
		// Stranded-done auto-recover's clean no-op folds into `completed` here too
		// (see the in-place performDo handler for the rationale): same SHARED
		// `complete.ts` seam — so `do --remote` (this `performDoRemote`) inherits
		// the auto-recover without per-caller duplication.
		return {
			exitCode: 0,
			outcome: 'completed',
			slug,
			branch,
			message: completed.message,
		};
	}
	if (completed.outcome === 'review-unparseable') {
		// Gate 2 RAN but its verdict was UNPARSEABLE (malformed JSON). The core already
		// routed it work-preservingly (branch pushed + surfaced). FAILURE-CAUSE axis, NOT
		// a reviewer block: classify the parse-failure phrase → `transient-infra` (re-run
		// the SAME work), the SAME convergence in-place `do`/`run` apply, so `do --remote`
		// agrees on the label. The job worktree is RETAINED by the §4 reap (a
		// not-provably-safe tree); hand the operator the recover-one-liner like the other
		// retained-tree failures.
		note(recoverIsolatedOneLiner(slug));
		const cause = classifyFailureCause(completed.message);
		return {
			exitCode: 1,
			outcome: failureCauseToDoOutcome(cause),
			slug,
			branch,
			message: completed.message,
		};
	}
	if (
		completed.outcome === 'prepare-failed' ||
		completed.outcome === 'gate-failed' ||
		completed.outcome === 'review-blocked' ||
		completed.outcome === 'rebase-conflict' ||
		completed.outcome === 'strand-surfaced'
	) {
		// The job worktree is RETAINED (the §4 reap keeps a not-provably-safe tree).
		// When the work was committed + done-moved but the integrate failed terminally
		// (the stale-lease-strand class Part B #97 surfaces), the operator FINISHES the
		// stranded branch with the recover-already-committed path \u2014 hand them the EXACT
		// one-liner so they need not reverse-engineer the encoded worktree path.
		//
		// `strand-surfaced` is the autonomous-strand parity (the SHARED `complete.ts`
		// seam already surfaced the source-strand / empty-staged refusal to
		// needs-attention on the arbiter) — `do --remote` inherits the fix here
		// without per-caller duplication; mapped to the SAME `needs-attention`
		// outcome shape the in-place `performDo` uses.
		note(recoverIsolatedOneLiner(slug));
		return {
			exitCode: 1,
			outcome: 'needs-attention',
			slug,
			branch,
			message: completed.message,
		};
	}
	if (completed.outcome === 'surface-unmoved') {
		// Strand-surface could not land on the arbiter (CAS contention exhausted) —
		// HONESTLY still in-progress on the arbiter. Mirror in-place `performDo`'s
		// `surface-unmoved` mapping so `do --remote` agrees on the same signal.
		return {
			exitCode: 1,
			outcome: 'surface-unmoved',
			slug,
			branch,
			message: completed.message,
		};
	}
	// Reclassify a thrown CORE wiring/config error (swallowed into `usage-error` by
	// `performComplete`) onto `config-error` — the SAME convergence in-place `do`
	// applies, so `do --remote` agrees with `do`/`run` on the same error too.
	if (completed.outcome === 'usage-error') {
		const cause = classifyFailureCause(completed.message);
		if (cause === 'config-error') {
			return {
				exitCode: 1,
				outcome: 'config-error',
				slug,
				branch,
				message: completed.message,
			};
		}
	}
	const outcome: DoOutcome =
		completed.outcome === 'refused' ? 'refused' : 'usage-error';
	return {exitCode: 1, outcome, slug, branch, message: completed.message};
}

/**
 * SAVE the partial work of a FAILED agent in a remote `do` worktree — the same
 * work-preserving routing in-place `do`'s {@link saveAgentFailure} uses, but
 * against the worktree's `origin` arbiter remote. The agent's edits + the failure
 * reason are committed + surfaced on the arbiter's main AND the `work/<slug>`
 * branch is pushed (the RECOVERABLE durable artifact — the disposable worktree is
 * NOT the recovery surface). The outcome is the classified failure CAUSE
 * (`transient-infra` / `config-error` / the generic `agent-failed`), same as the
 * in-place form.
 */
async function saveRemoteAgentFailure(params: {
	slug: string;
	branch: string | undefined;
	cwd: string;
	arbiterRemote: string;
	detail: string;
	env: NodeJS.ProcessEnv | undefined;
	note: (message: string) => void;
}): Promise<DoResult> {
	const {slug, cwd, arbiterRemote, detail, env, note} = params;
	const branch = params.branch ?? workBranchRef('task', slug);
	// Same best-effort cause classification as in-place `do`'s `saveAgentFailure`
	// (shared `classifyFailureCause`), so the remote form labels the SAME error the
	// SAME way too.
	const cause = classifyFailureCause(detail);
	const reason = `${failureCauseLabel(cause)}: ${detail}`;

	const routed = await ledgerWrite.applyNeedsAttentionTransition({
		cwd,
		slug,
		reason,
		arbiter: arbiterRemote,
		env,
		note,
	});

	const report = routed.moved ? routeReport(routed, branch) : undefined;
	const message = routed.moved
		? `Agent run failed building '${slug}' [${cause}] (${detail}); SAVED the ` +
			`partial work and marked '${slug}' stuck on its lock (${report!.fragment}).`
		: `Agent run failed building '${slug}' [${cause}] (${detail}); could not ` +
			`mark '${slug}' stuck (${routed.reasonNotMoved ?? 'unknown'}).`;
	note(message);
	// PR-2b D3: cleanly-surfaced remote agent failure is GREEN.
	return {
		exitCode: routed.moved ? 0 : 1,
		outcome: failureCauseToDoOutcome(cause),
		slug,
		branch,
		routedToNeedsAttention: routed.moved,
		message,
	};
}

/**
 * Prime ONE arbiter head into its remote-tracking ref inside a job worktree
 * (`+refs/heads/<head>:refs/remotes/<arbiter>/<head>`). A job worktree is cut
 * from a BARE hub mirror whose `origin` remote has no fetch refspec, so
 * `<arbiter>/main` / `<arbiter>/work/<slug>` would not otherwise resolve — which
 * makes the (otherwise unchanged) `performStart` read the slug as absent. This is
 * the EXACT technique `integrator.rebaseOntoArbiterMain` + `gc.fetchTracking`
 * already use for the same bare-mirror-worktree reason. Best-effort: an
 * unreachable arbiter / a missing head leaves the local ref absent, which `start`
 * then handles (the FRESH branch already exists locally from `createJob`).
 */
async function primeWorktreeTrackingRef(
	cwd: string,
	arbiter: string,
	head: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<void> {
	// SOFT (no throw): the head may not exist on the arbiter (e.g. a FRESH cut has
	// no pushed `work/<slug>` yet) — that is the common, expected case, and `start`
	// handles a missing remote-tracking ref (the local branch `createJob` created
	// is plain-switched). A genuine fetch error likewise leaves the ref absent →
	// the safe direction.
	await runAsync(
		'git',
		[
			'fetch',
			'--quiet',
			arbiter,
			`+refs/heads/${head}:refs/remotes/${arbiter}/${head}`,
		],
		cwd,
		{env},
	);
}

/**
 * Adapt the IN-PLACE {@link DoOptions} build/task driver onto the WORKTREE-
 * ISOLATED {@link performDoRemote} pipeline (task
 * `advance-loop-driver-registry-set-job-worktrees`) — the per-mirror job-worktree
 * `doDriver` the registry-set advance driver threads into the advance tick.
 *
 * The advance tick's build/task rung ORCHESTRATES `do` by calling the
 * {@link AdvanceContext.doDriver} seam with a resolved {@link DoOptions} (whose
 * `cwd` is the per-mirror in-place checkout). The DEFAULT driver is
 * {@link performDo} (in-place, the cwd checkout IS the isolation — the human-local
 * one-shot `advance` + today's `run --advance`). The DAEMON/CI registry-set path
 * wants the SAME per-job-worktree isolation `run`'s build tick gives `runOneItem`,
 * so it injects THIS driver instead: it re-routes the orchestration onto
 * {@link performDoRemote}, which materialises a hub mirror + job worktree off the
 * mirror's arbiter via the EXISTING `jobWorktreeStrategy` (no second isolation
 * mechanism), runs the SAME `do` pipeline there, and reaps per the §4 predicate.
 * The cwd checkout is NEVER touched (the equivalence the task asserts vs plain
 * `run`).
 *
 * The pipeline knobs (verify / integration / review family / agent launch /
 * identity) ride VERBATIM from the threaded `DoOptions` onto the structurally-
 * matching {@link DoRemoteOptions} fields; `cwd` is DROPPED (the worktree replaces
 * it) and `remote` + `workspacesDir` are supplied from this driver's closure (the
 * mirror's arbiter URL + the agents' execution area). A `spec:` arg flows through
 * unchanged — `performDoRemote` tasks it against the claim clone with NO build
 * worktree (the tasking/surface/triage/apply rungs are tree-less ledger moves, the
 * substrate the task's criterion 4 preserves).
 */
export function jobWorktreeDoDriver(closure: {
	/** The mirror's arbiter URL (`git -C <mirror> remote get-url origin`) — `performDoRemote`'s `remote`. */
	remote: string;
	/** The agents' execution area (config `workspacesDir`) where the hub mirror + worktree live. */
	workspacesDir: string;
}): (options: DoOptions) => Promise<DoResult> {
	return (options: DoOptions): Promise<DoResult> => {
		// Map the in-place DoOptions onto the worktree DoRemoteOptions. `cwd` is
		// intentionally DROPPED (the worktree is the isolation, not the checkout);
		// every other pipeline knob rides verbatim onto its structural twin.
		const remoteOptions: DoRemoteOptions = {
			arg: options.arg,
			remote: closure.remote,
			workspacesDir: closure.workspacesDir,
			arbiter: options.arbiter,
			identity: options.identity,
			autoTask: options.autoTask,
			reviewLoop: options.reviewLoop,
			taskerLoopMax: options.taskerLoopMax,
			taskerLoopModel: options.taskerLoopModel,
			reviewExecutions: options.reviewExecutions,
			integration: options.integration,
			// The explicit `--merge` override for the untrusted-origin build-propose rule.
			explicitMerge: options.explicitMerge,
			prepare: options.prepare,
			verify: options.verify,
			noPR: options.noPR,
			review: options.review,
			reviewModel: options.reviewModel,
			reviewMaxRounds: options.reviewMaxRounds,
			reviewGate: options.reviewGate,
			taskReviewGate: options.taskReviewGate,
			dorfl: options.dorfl,
			harness: options.harness,
			agentCmd: options.agentCmd,
			model: options.model,
			sessionsDir: options.sessionsDir,
			watch: options.watch,
			watchSink: options.watchSink,
			color: options.color,
			agentDeadlineMinutes: options.agentDeadlineMinutes,
			maxAutoCheckpoints: options.maxAutoCheckpoints,
			read: options.read,
			env: options.env,
			note: options.note,
			noteBlock: options.noteBlock,
		};
		return performDoRemote(remoteOptions);
	};
}
