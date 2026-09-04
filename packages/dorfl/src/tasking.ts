import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {parseFrontmatter} from './frontmatter.js';
import {runAsync, type RunResult} from './git.js';
import {
	workFolderRel,
	workFolderPath,
	workItemPath,
	workItemRel,
	isWorkItemFile,
} from './work-layout.js';
import {
	performIntegration,
	type IntegrationCoreResult,
} from './integration-core.js';
import type {IntegrationMode} from './config.js';
import type {ReviewProvider} from './integrator.js';
import {
	resolveTaskingEligibility,
	type TaskingEligibilityResult,
} from './tasking-eligibility.js';
import {
	acquireTaskingLock,
	releaseTaskingLock,
	type AcquireTaskingLockOptions,
	type AcquireTaskingLockResult,
	type ReleaseTaskingLockOptions,
	type ReleaseTaskingLockResult,
} from './tasking-lock.js';
import {releaseItemLock} from './item-lock.js';
import {NullHarness, type Harness} from './harness.js';
import {launchWithOptionalWatch} from './agent-launch.js';
import {placementFolder, resolvePlacement} from './placement.js';
import {setNeedsAnswersMarker, propagateOrigin} from './frontmatter.js';
import {workBranchRef} from './slug-namespace.js';
import {
	runTaskReviewLoop,
	type TaskReviewGate,
	type RunTaskReviewLoopResult,
	REVIEW_EDITS_SCRATCH_DIR,
} from './tasker-review-loop.js';
import {ReviewParseError, ReviewOutputCappedError} from './review-verdict.js';
import type {ReviewGate} from './review-gate.js';

/**
 * The **`do spec:<slug>` tasking path** (spec `auto-slice`, task
 * `autoslice-command`) — the orchestration that ties the tasking GATE
 * (`tasking-eligibility.ts`) and the tasking LOCK (`tasking-lock.ts`) together to
 * task a spec into `work/tasks/backlog/` STAGED items (task
 * `pre-backlog-staging-folder-and-promote-step-a` — the runner-owned promotion
 * moves them `tasks/backlog/ → tasks/ready/` later), with the RUNNER owning every git-state
 * transition. This is the spec branch of the `do` worker (ADR
 * `command-surface-and-journeys.md` §3/§3a), NOT a standalone `task` command;
 * `do.ts` dispatches `resolved.namespace === 'spec'` here.
 *
 * The end-to-end flow (mirroring the `do`/`run` runner-owns-git discipline — the
 * agent only EDITS files, the runner does ALL git):
 *
 *   1. **Resolve the gate** (agent path): refuse to task a spec that is
 *      `humanOnly`/`needsAnswers`, or whose `taskedAfter` specs are not yet tasked.
 *      The repo's `autoTask` POLICY also refuses on the AUTO-PICK pool path, but
 *      NOT when the spec was named EXPLICITLY (`do spec:<slug>`, `explicit: true`):
 *      naming it IS the authorization, exactly as `do <task>` builds regardless of
 *      `autoBuild` (the pool, not the explicit claim, gates the policy). The HUMAN
 *      path is unbound by the gate entirely.
 *   2. **Acquire the lock** (agent path) via the unified per-item lock CAS —
 *      serialising concurrent taskers on the `spec:<slug>` ref (the body STAYS in
 *      `work/specs/ready/`; the lock no longer moves it). The HUMAN path with no contention
 *      may task on `main` directly WITHOUT the lock.
 *   3. **Invoke the agent harness** with the `to-task` spec — the agent runs the
 *      tasker methodology and produces `work/tasks/backlog/<slug>.md` FILES ONLY; it does
 *      NOT commit/push/move (the same in-band boundary as the build agent).
 *   4. **The runner integrates the COMPLETING transition through the SHARED core**
 *      (`performIntegration`, task `slice-output-through-integration`): the agent's
 *      tasking runs on a `work/<slug>` branch cut from `<arbiter>/main` (whose base
 *      holds the spec in `work/specs/ready/`), and the produced backlog tasks + the durable
 *      spec lifecycle move (`work/specs/ready/ → work/specs/tasked/`)
 *      integrate via the band honoring `--propose` (push the branch + open a
 *      PR, NO `main` touch) / `--merge` (land on `main`). Because the integrate-time
 *      args resolve ONCE in the shared core, EVERY `do task:` integrate arg applies
 *      to `do spec:` by construction. A content-identity STALE CHECK (the lock's
 *      read-stability backstop) fires FIRST against the acquire-time `lockedBlob`,
 *      so a concurrent edit of the held spec still fails loud (`stale`).
 *
 * The tasking LOCK (`tasking-lock.ts`, `acquireTaskingLock`/`releaseTaskingLock`)
 * is the UNIFIED per-item lock (`refs/dorfl/lock/<entry>`, `action: task`)
 * — the transient `tasking/` folder marker is RETIRED (task
 * `cutover-retire-slicing-advancing-markers-and-trim-folder-sets`). The lock
 * RELEASE owns the needs-attention redirect for the loop's decomposition-unclear
 * verdict (it amends the lock `active → stuck` — no folder write); only the SUCCESS
 * output integrates through the shared core. This path
 * does NOT build the no-human confidence routing — that is the review/edit loop
 * owned by `slicer-review-edit-loop`; this path produces + integrates the tasks.
 */

/** The terminal status of one `do spec:<slug>` tasking run. */
export type TaskOutcome =
	| 'tasked' // gate passed (agent) / unbound (human) → lock → agent → committed
	| 'gate-refused' // the agent gate refused (humanOnly/needsAnswers/autoTask/taskedAfter)
	| 'lock-lost' // the lock was lost/contended (another tasker holds it)
	| 'agent-failed' // the agent invocation itself errored
	| 'stale' // the held spec was edited under the lock → the tasking is stale
	| 'needs-attention' // the tasker edit loop found the decomposition unclear → spec routed to needs-attention (no tasks)
	| 'usage-error'; // usage / environment problem (missing spec, bad release, …)

export interface TaskResult {
	exitCode: 0 | 1 | 2 | 3 | 4;
	outcome: TaskOutcome;
	/** The spec slug acted on. */
	slug: string;
	/** Repo-relative paths of the backlog tasks the runner committed. */
	emitted?: string[];
	/**
	 * The tasker review→edit LOOP's disposition (`slicer-review-edit-loop`), when
	 * the loop ran. `converged` = the improved tasks landed; `uncertain-tasks` =
	 * the cap was hit and specific tasks landed `needsAnswers: true`; absent when
	 * no loop ran or the spec was routed to needs-attention (`outcome:
	 * 'needs-attention'`).
	 */
	loop?: 'converged' | 'uncertain-tasks';
	/** Human-readable summary of the terminal condition. */
	message: string;
}

/**
 * The agent invocation: runs the `to-task` spec in `cwd`, WRITING
 * `work/tasks/backlog/<slug>.md` task files (and trimming the spec). It does NO git —
 * the runner captures the produced files and commits them.
 */
export type TaskDorfl = (input: {
	cwd: string;
	prompt: string;
	slug: string;
	env?: NodeJS.ProcessEnv;
}) => {ok: boolean; detail?: string};

/** Injectable lock seams (production: the real CAS; tests: stubs). */
export interface TaskingLockSeam {
	acquire(
		options: AcquireTaskingLockOptions,
	): Promise<AcquireTaskingLockResult>;
	release(
		options: ReleaseTaskingLockOptions,
	): Promise<ReleaseTaskingLockResult>;
}

const DEFAULT_LOCK_SEAM: TaskingLockSeam = {
	acquire: acquireTaskingLock,
	release: releaseTaskingLock,
};

export interface PerformTaskOptions {
	/** The spec slug to task (`work/specs/ready/<slug>.md`). */
	slug: string;
	/** The working clone/checkout the tasking runs in. */
	cwd: string;
	/** Name of the arbiter git remote. Defaults to `origin`. */
	arbiter?: string;
	/**
	 * The DOER: `'agent'` (the default; bound by the gate, MUST take the lock) or
	 * `'human'` (unbound by the gate; with no contention tasks on `main` directly
	 * WITHOUT the lock). The human-vs-agent choice the command wires.
	 */
	doer?: 'agent' | 'human';
	/** Per-repo `autoTask` policy (resolved by `autoslice-gate`). Agent path only. */
	autoTask?: boolean;
	/**
	 * The spec was named EXPLICITLY by the operator (`do spec:<slug>`), so the
	 * `autoTask` POLICY is already satisfied — naming the spec IS the authorization,
	 * EXACTLY as `do <task>` builds a named task regardless of `autoBuild` (the
	 * build path's precedent: `autoBuild` gates the scan/selection POOL only, never
	 * `performDo`'s explicit claim). When `true`, the agent tasking gate drops the
	 * `autoTask` policy term and binds ONLY the spec's own readiness axes
	 * (`humanOnly`/`needsAnswers`) + `taskedAfter`. Defaults `false`. Both the
	 * explicit `do spec:` dispatch AND the auto-pick path pass `true` here: the
	 * auto-pick POOL (`do-autopick.ts`) is the single `autoTask`-enforcement point
	 * (a pool-ineligible spec is never selected), so once a spec is dispatched its
	 * policy is already settled. Agent path only.
	 */
	explicit?: boolean;
	/**
	 * The agent invocation. Tests inject this to write task files directly;
	 * production wires the harness seam. When omitted, {@link harness} is used.
	 */
	dorfl?: TaskDorfl;
	/** The harness seam used when `dorfl` is omitted; defaults to the null adapter. */
	harness?: Harness;
	/** The configured agent command the harness shells out to (null adapter). */
	agentCmd?: string;
	/** The model routing intent forwarded to the harness (ADR §13). */
	model?: string;
	/** The HOST-ONLY sessions root for the pi session file. */
	sessionsDir?: string;
	/**
	 * The integration mode the produced tasks integrate THROUGH the shared core
	 * with (task `slice-output-through-integration`): `propose` (default — push the
	 * `work/<slug>` branch + open a PR carrying the tasks, NO `main` touch) or
	 * `merge` (land them on `main`). Resolved ONCE in {@link performIntegration},
	 * so EVERY `do task:` integrate-time arg applies to `do spec:` by construction.
	 * The AGENT path only; the human path commits its own output. Defaults to the
	 * system default (`propose`).
	 */
	integration?: IntegrationMode;
	/**
	 * **The PR-INTENT axis** (config `noPR`, ADR §6): when `true`, propose pushes
	 * the produced task branch but skips the PR (the explicit suppress-PR intent).
	 * NOT a provider choice — the provider is purely arbiter-derived. Unset/false ⇒
	 * the PR opens normally.
	 */
	noPR?: boolean;
	/**
	 * Optional FULLY-FORMED review provider INSTANCE used VERBATIM (the SAME seam
	 * `run`/`do` expose; forwarded to `performIntegration` as `providerInstance`).
	 * Tests/embeddings inject a stubbed `GitHubProvider` (a custom `gh` path) to
	 * drive the propose pipeline OFFLINE. The resolved provider OBJECT, NOT a config
	 * override. Unset ⇒ the core selects from the arbiter URL.
	 */
	providerInstance?: ReviewProvider;
	/**
	 * **The task-SET ACCEPTANCE GATE** (task `slice-acceptance-gate`): the
	 * task-path mirror of the build Gate-2, riding {@link performIntegration}'s
	 * review-before-integrate block. When `review` resolves on, a FRESH-CONTEXT
	 * agent reviews the WHOLE produced task SET (coherence / dependency graph /
	 * gaps + overlap / spec-goal correct-if-implemented) BEFORE the tasks integrate;
	 * `approve` lands them, `block` routes the set to needs-attention. It is
	 * controlled by the BUILD `--review`/`--no-review`/`--review-model` family (ONE
	 * gate-configuration story shared with the build path) and is ONE-SHOT —
	 * terminal pass/fail, NO rounds (it does NOT inherit `--review-max-rounds`; the
	 * caller drives it with a single reviewer invocation). It is DISTINCT from and
	 * independently controllable from the tasker improver loop ({@link reviewLoop} /
	 * the `--tasker-loop*` family).
	 */
	review?: boolean;
	/** The task-SET acceptance-gate SEAM (injectable). Required when `review` is on. */
	reviewGate?: ReviewGate;
	/**
	 * The model the task-SET acceptance-gate reviewer runs on (the BUILD
	 * `--review-model`, de-correlated from the tasker). DISTINCT from the improver
	 * loop's {@link taskerLoopModel} — see the note there.
	 */
	acceptanceReviewModel?: string;
	/**
	 * **The cross-job merge-serialiser CAS-retry cap** (config `mergeRetries`, spec
	 * `land-time-reverify-and-parallel-merge-ceiling` Story 5 / Applied Answer q1
	 * (a)). Threaded VERBATIM into {@link performIntegration} so a wide-matrix CI's
	 * raised cap actually reaches the cross-job land queue (the CAS loop IS the
	 * queue across separate jobs) on the `do spec:<slug>` tasking-transition path
	 * too. Resolved ONCE at the entry point through the gate-family precedence chain
	 * (flag > env > per-repo > global > default), same as `complete`/`do`/`run`.
	 * Unset ⇒ falls through to the engine's `DEFAULT_MERGE_RETRIES = 1000`
	 * (byte-for-byte unchanged).
	 */
	mergeRetries?: number;
	/** Injectable lock seam (tests stub acquire/release). Defaults to the real CAS. */
	lock?: TaskingLockSeam;
	/**
	 * **The per-repo TASK-PLACEMENT default** (spec
	 * `staging-pool-position-gate-and-trust-model` US #5, task
	 * `runner-deterministic-slice-placement-policy-and-precedence`). The
	 * resolved per-repo default landing for the tasker's emitted tasks, fed as
	 * the CONFIGURED-DEFAULT rung into the runner-deterministic placement
	 * resolver (`src/placement.ts`). The resolver overlays an EXPLICIT operator
	 * flag ({@link explicitTasksLandIn}, top) and the UNTRUSTED-ORIGIN force
	 * (`originTrust: untrusted` ⇒ staging) on top. Unset ⇒ the resolver's
	 * built-in floor applies (`staging` = `tasks/backlog/`, the conservative
	 * landing that preserves zero behaviour change for the normal path).
	 */
	tasksLandIn?: 'backlog' | 'ready';
	/**
	 * **The per-repo UNTRUSTED-side TASK-PLACEMENT default** (spec
	 * `untrusted-origin-carries-via-stamp-intake-placement-symmetry-and-ci-gate-resolution`
	 * US #6/#10, governing ADR
	 * `untrusted-origin-carries-via-stamp-not-forced-staging`). The TWIN of
	 * {@link tasksLandIn} selected when the SPEC being tasked carries an
	 * `originTrust: untrusted` stamp: `performTask` reads the stamp and feeds
	 * THIS default (rather than {@link tasksLandIn}) as the configured-default
	 * rung of the placement resolver. This is the same knob intake uses for a
	 * task emitted directly from an issue (decision X: one policy governs an
	 * untrusted task's destination regardless of birth path). Resolved per-repo
	 * like {@link tasksLandIn} (flag `--untrusted-tasks-land-in` > env
	 * `DORFL_UNTRUSTED_TASKS_LAND_IN` > per-repo > global > built-in `backlog`).
	 * Unset ⇒ the resolver's built-in floor (`staging`) applies. The resolver no
	 * longer has an untrusted-forces-staging rung; safety for an untrusted task
	 * that lands in `ready` here is the carried stamp (its BUILD is forced to a
	 * code PR), NOT the folder.
	 */
	untrustedTasksLandIn?: 'backlog' | 'ready';
	/**
	 * **The OPERATOR's EXPLICIT task-placement override** (the TOP precedence
	 * rung). When set, the runner-deterministic resolver lands the tasks HERE
	 * regardless of `originTrust` or {@link tasksLandIn} — the positional
	 * analogue of `explicitMerge` overriding the untrusted-origin
	 * build-propose rule ("the operator is present; CLI always wins, no special
	 * force-key"). Set ONLY when the operator typed `--tasks-land-in <where>`;
	 * never when the value came from config.
	 */
	explicitTasksLandIn?: 'backlog' | 'ready';
	/**
	 * **The tasker review→edit→converge LOOP** (`slicer-review-edit-loop`, GATES spec
	 * `work/specs/ready/review.md` RESOLVED DESIGN — Shape 2 / insertion point A). When
	 * provided, AFTER the agent produces candidate tasks (step 3) and BEFORE the
	 * runner finalises them (step 4), run the `review` SKILL as a review→edit→
	 * re-review loop that IMPROVES the candidate tasks in place, then routes the
	 * verdict through the three outcomes (converge→land / uncertain-task→
	 * needsAnswers / decomposition-unclear→spec-to-needs-attention). The seam is the
	 * review+edit gate (tests inject a canned verdict+edits; production:
	 * {@link harnessTaskReviewGate}). Omitted ⇒ NO loop (the candidate tasks land
	 * as-is — the pre-loop behaviour). The HUMAN path is unaffected (the loop runs
	 * on the auto-tasker's output only — see the gating in {@link performTask}).
	 */
	reviewLoop?: TaskReviewGate;
	/**
	 * The HARD CAP on the tasker improver loop's in-context review passes (N) —
	 * resolved per-repo (flag `--tasker-loop-max` > env > per-repo > global > cheap
	 * default). Only consulted when {@link reviewLoop} is set. Defaults to 3 (the
	 * cheap default) when omitted.
	 */
	taskerLoopMax?: number;
	/**
	 * How many fresh-context EXECUTIONS (M) of the loop to run — each a NEW launch in
	 * a fresh context. Default 1 (the cheap degenerate case). Only consulted when
	 * {@link reviewLoop} is set.
	 */
	reviewExecutions?: number;
	/**
	 * The model the IMPROVER loop's review agent runs on (de-correlated from the
	 * tasker; the `--tasker-loop-model` family). Loop only. DISTINCT from the
	 * acceptance gate's {@link acceptanceReviewModel} (build `--review-model`).
	 */
	taskerLoopModel?: string;
	/** Environment for child GIT/provider processes (the identity-scoped env). */
	env?: NodeJS.ProcessEnv;
	/**
	 * Environment for the AGENT launches (the tasker agent + the review/improver
	 * loop's review agent). Distinct from {@link env}: an AGENT must NOT carry the
	 * runner identity (only the runner's git transitions do). Unset ⇒ falls back to
	 * {@link env} (byte-for-byte unchanged for non-identity callers).
	 */
	agentEnv?: NodeJS.ProcessEnv;
	/** Sink for human-readable progress notes. */
	note?: (message: string) => void;
}

const DEFAULT_ARBITER = 'origin';

/**
 * **The STAGED-TASKS dir** (spec `staging-pool-position-gate-and-trust-model`,
 * task `pre-backlog-staging-folder-and-promote-step-a`, governing ADR
 * `placement-is-runner-deterministic-humanonly-is-agent-judgement`). The runner
 * lands the tasker's emitted task files HERE, NOT in `work/tasks/ready/`: an item
 * born in `tasks/backlog/` is durable + readable but NOT in the agent-eligible
 * pool (`work/tasks/ready/` STILL means the pool — every reader is byte-for-byte
 * unchanged). A runner/human-owned promotion (`promoteFromPreBacklog` in
 * `needs-attention.ts`) moves an approved item `tasks/backlog/ → tasks/ready/` to make
 * it claimable. STEP A: ADDITIVE — no `work/tasks/ready/` reader changes here.
 */
export const STAGED_TASKS_DIR = workFolderRel('tasks-backlog');

/**
 * The POOL folder tasks land in when the runner-deterministic placement
 * resolver chooses the pool side (`tasksLandIn: 'ready'` and a trusted
 * origin, or an `--tasks-land-in ready` operator override). The agent NEVER
 * writes here — it always writes to {@link STAGED_TASKS_DIR}; the runner
 * redirects the emitted files to the resolved destination at integrate-stage
 * time. spec US #4 / the governing ADR: the agent cannot self-place into the
 * pool. Task `runner-deterministic-slice-placement-policy-and-precedence`.
 */
const POOL_TASKS_DIR = workFolderRel('tasks-ready');

/**
 * The placement slots for the TASK lifecycle (folder names). EXPORTED so the
 * intake TASK emit (`intake.ts` `dispatchTask`) reuses the SAME slots + resolver
 * the tasker uses, reaching parity with the intake SPEC emit (ADR
 * `untrusted-origin-carries-via-stamp-not-forced-staging`) WITHOUT forking a
 * second copy of the task folder names.
 */
export const TASK_PLACEMENT_SLOTS = {
	staging: STAGED_TASKS_DIR,
	pool: POOL_TASKS_DIR,
} as const;

/**
 * Map the `tasksLandIn` value spelling (`backlog` | `ready`) onto the
 * resolver's lifecycle-generic side enum (`staging` | `pool`). Returns
 * `undefined` when no value is set, so the resolver's next precedence rung
 * applies (the built-in floor). The legacy `'pre-backlog'`/`'todo'` spellings
 * are NOT accepted (clean break — the staging value was renamed
 * `'pre-backlog'` → `'backlog'`, and the pool value was renamed
 * `'backlog'` → `'todo'` → `'ready'`, ADR
 * `rename-task-pool-folder-todo-to-ready`). EXPORTED alongside
 * {@link TASK_PLACEMENT_SLOTS} so the intake TASK emit reuses this exact mapping
 * (the task twin of `specLandingToSide` on the intake spec path).
 */
export function landingToSide(
	landing: 'backlog' | 'ready' | undefined,
): 'staging' | 'pool' | undefined {
	if (landing === 'backlog') return 'staging';
	if (landing === 'ready') return 'pool';
	return undefined;
}

/** The repo-relative path of a staged task's `.md` (per {@link STAGED_TASKS_DIR}). */
function stagedTaskPath(name: string): string {
	return `${STAGED_TASKS_DIR}/${name}`;
}

/**
 * Run the `do spec:<slug>` tasking path end-to-end. Never throws for the expected
 * gate-refused / lock-lost / agent-failed / stale cases — those are returned with
 * the appropriate exit code and outcome. The runner owns all git; the agent only
 * writes task files.
 */
export async function performTask(
	options: PerformTaskOptions,
): Promise<TaskResult> {
	const note = options.note ?? (() => {});
	const arbiter = options.arbiter ?? DEFAULT_ARBITER;
	const cwd = options.cwd;
	// `env` is the runner's GIT/provider env (identity-scoped). `agentEnv` is the
	// AMBIENT env for AGENT launches (tasker agent, review/improver agents) — an
	// agent must not act as the bot. Falls back to `env` when no identity.
	const env = options.env;
	const agentEnv = options.agentEnv ?? options.env;
	const slug = options.slug;
	const doer = options.doer ?? 'agent';
	const lock = options.lock ?? DEFAULT_LOCK_SEAM;

	// 0. The spec must exist in the checkout (`work/specs/ready/<slug>.md`) — it is the
	//    source the agent tasks + the file the lock holds.
	const specPath = workItemPath(cwd, 'specs-ready', slug);
	if (!existsSync(specPath)) {
		const message = `no spec '${slug}' found at ${workFolderRel('specs-ready')}/${slug}.md.`;
		note(message);
		return {exitCode: 1, outcome: 'usage-error', slug, message};
	}
	const specContent = readFileSync(specPath, 'utf8');
	const specFm = parseFrontmatter(specContent);

	// 1. RESOLVE THE GATE (agent path only). The human path is UNBOUND — a human
	//    decides for themselves whether a spec is taskable.
	if (doer === 'agent') {
		const eligibility = resolveAgentGate(
			cwd,
			slug,
			specFm,
			options.autoTask,
			options.explicit ?? false,
		);
		if (!eligibility.taskable) {
			const message = gateRefusalReason(slug, specFm, eligibility, options);
			note(message);
			return {exitCode: 1, outcome: 'gate-refused', slug, message};
		}
	}

	// 2. ACQUIRE THE LOCK (agent path; concurrency serialisation). The human path
	//    with no contention may task on `main` directly WITHOUT the lock.
	let lockedBlob: string | undefined;
	const useLock = doer === 'agent';
	// The integrate mode resolved ONCE (`--merge`/`--propose` > default `propose`),
	// used to decide BOTH the tasking lock's lifetime (release on `merge`, HOLD
	// across the PR on `propose`) AND whether a not-landed surface should close a
	// stale open PR (propose only).
	const resolvedMode = options.integration ?? 'propose';
	if (useLock) {
		const acquired = await lock.acquire({slug, cwd, arbiter, env, note});
		if (acquired.outcome === 'lost') {
			return {
				exitCode: 2,
				outcome: 'lock-lost',
				slug,
				message: acquired.message,
			};
		}
		if (acquired.outcome === 'contended') {
			return {
				exitCode: 3,
				outcome: 'lock-lost',
				slug,
				message: acquired.message,
			};
		}
		if (acquired.exitCode !== 0) {
			return {
				exitCode: 1,
				outcome: 'usage-error',
				slug,
				message: acquired.message,
			};
		}
		lockedBlob = acquired.lockedBlob;
	}

	// 2b. ONBOARD the agent's tasking work onto a `work/<slug>` BRANCH cut from the
	//     freshly-fetched `<arbiter>/main` (task `slice-output-through-integration`).
	//     The spec body rests in `work/specs/ready/<slug>.md` on `<arbiter>/main` (the lock no
	//     longer moves it), so the branch's base HOLDS the held spec — the lifecycle
	//     stage below moves it `specs/ready/ → specs/tasked/` ON THIS BRANCH and the shared integrate core (`--propose`
	//     PR / `--merge` main) lands the whole transition, WITHOUT the lock release
	//     committing tasks straight to `main`. The agent runs IN-PLACE on this branch
	//     (branch ≠ worktree; the isolation seam upgrades it). The HUMAN path stays on
	//     its own branch and commits its output itself (no integrate, no branch cut).
	if (useLock) {
		await switchToWorkBranch(cwd, arbiter, slug, env);
	}

	// 3. INVOKE THE AGENT with the to-task spec. It WRITES
	//    `work/tasks/backlog/*.md` task files (the STAGED area — NOT `work/tasks/ready/`,
	//    which is the agent-eligible pool the runner owns the promotion into; task
	//    `pre-backlog-staging-folder-and-promote-step-a`); it does NO git. We
	//    snapshot the staged-tasks folder before/after so the runner (not the
	//    agent) captures + commits exactly what was produced.
	const before = snapshotStagedTasks(cwd);
	// Also snapshot the POOL `work/tasks/ready/` BEFORE the agent runs: the runner's
	// final commit must scrub any agent writes there (an attempt to self-place into
	// the pool, spec US #4) before `git add -A` would sweep them in.
	const poolBefore = snapshotPool(cwd);
	// Read the parent-spec self-pointer off `specFm.spec` (populated from the
	// `spec:` key).
	const prompt = buildTaskingSpec(slug, specFm.spec);
	let agent: {ok: boolean; detail?: string};
	try {
		agent = await runTaskAgent(options, cwd, prompt, slug);
	} catch (err) {
		agent = {
			ok: false,
			detail: err instanceof Error ? err.message : String(err),
		};
	}
	if (!agent.ok) {
		const detail = agent.detail ?? `the agent failed to task '${slug}'.`;
		let message = `Agent failed tasking '${slug}' (${detail}).`;
		// RELEASE THE LOCK THE FAILED RUN TOOK (observation
		// `crashed-do-spec-strands-a-tasking-lock-no-verb-releases`).
		//
		// The pre-fix behaviour left the lock HELD on the arbiter, justified by a
		// comment claiming "surfacing it is the review/edit loop's job". That is
		// UNREACHABLE from here: the review/edit loop runs at step 3.5, strictly
		// AFTER this early return, so an agent that dies at step 3 is surfaced by
		// NOBODY. The lock outlived every process that knew about it and each retry
		// of `do spec:<slug>` lost the create-only CAS against a holder that no
		// longer existed (`'spec-<slug>' is already locked (held by another)`).
		// Field trigger: three consecutive model-API faults (`Connection error.`,
		// `overloaded_error`, `api_error`).
		//
		// WHY A PLAIN RELEASE AND NOT A `stuck` SURFACE. The sibling failure just
		// below (`ReviewParseError`) routes through `surfaceTaskingBlock`, which
		// marks the spec `needsAnswers:true` + writes a question sidecar. That is
		// correct THERE (a review verdict is a JUDGEMENT a human must resolve) and
		// wrong HERE: an agent/transport crash carries no judgement to record, and
		// surfacing it would take the spec OUT of the taskable pool behind a
		// contentless question — turning a retryable blip into mandatory human
		// paperwork. A crashed agent is RETRYABLE, so the recovery is to return the
		// spec to the pool and let `do spec:<slug>` simply be re-run.
		//
		// WHY THIS DISCARDS NOTHING. The tasking work branch is created by
		// `switchToWorkBranch` with a LOCAL `git switch -C` and is never pushed
		// before the integrate band; the durable `specs/ready → specs/tasked` move
		// also happens only at integrate. A run that died at step 3 therefore
		// published NOTHING to the arbiter, so releasing its lock cannot lose work.
		// The release is deliberately no more cautious than that risk warrants.
		//
		// A release FAULT is reported but never masks the agent failure: the agent
		// outcome is the terminal one, and `release-lock spec:<slug>` remains the
		// human backstop for the case where this process is itself killed.
		if (useLock) {
			const released = await lock.release({
				slug,
				cwd,
				arbiter,
				lockedBlob,
				env,
				note,
			});
			message =
				released.exitCode === 0
					? `${message} Released the tasking lock for '${slug}' — the spec is ` +
						'back in the taskable pool, so re-run `dorfl do spec:' +
						`${slug}\` to retry (nothing was published, so nothing was lost).`
					: `${message} WARNING: could not release the tasking lock for ` +
						`'${slug}' (${released.message}). Clear it with \`dorfl ` +
						`release-lock spec:${slug}\` before retrying.`;
		}
		note(message);
		return {exitCode: 1, outcome: 'agent-failed', slug, message};
	}

	// 3.5 THE TASKER REVIEW→EDIT→CONVERGE LOOP (`slicer-review-edit-loop`, Shape 2 /
	//     insertion point A): when a loop seam is wired, run the `review` SKILL as a
	//     review→edit→re-review loop that IMPROVES the candidate tasks in place, then
	//     determines the disposition (the three outcomes). This plugs in AFTER the
	//     candidate tasks are produced and BEFORE they are finalised. The agent makes
	//     the review/edit JUDGEMENTS; the loop applies edits to the candidate files
	//     and routes the verdict; the runner (below) owns the git transition. Only the
	//     AGENT path runs the loop — the human tasking path is unaffected.
	let loopDisposition: RunTaskReviewLoopResult | undefined;
	if (options.reviewLoop && doer === 'agent') {
		// REVIEW-LEG FAILURE handling (observation
		// `tasker-review-edits-payload-caps-the-verdict-response`): the tasker produced
		// a good candidate set but the review/improver leg can fail to return a
		// parseable verdict (a generic parse failure, or the NAMED cap-truncation
		// class). The pre-fix behaviour THREW here, crashing the run, LEAVING THE
		// LOCK HELD, writing NO question sidecar, and DISCARDING the tasker's
		// candidate tasks. Now: catch it, PERSIST the candidate tasks, and BOUNCE
		// through the SAME surface the decomposition-unclear path uses (release the
		// lock + a question sidecar). NEVER a silent approve — a parse failure is
		// always a needs-attention route. A non-review throw (genuine wiring error)
		// is re-thrown.
		try {
			loopDisposition = await runTaskReviewLoop({
				slug,
				cwd,
				gate: options.reviewLoop,
				// SCOPING FENCE (the requeue fix): the loop reviews/edits/flags ONLY the
				// tasks THIS run produced (new-or-changed vs `before`), never the
				// pre-existing staged tasks that share `work/tasks/backlog/`.
				before,
				taskerLoopMax: options.taskerLoopMax ?? 3,
				executions: options.reviewExecutions,
				taskerLoopModel: options.taskerLoopModel,
				sessionsDir: options.sessionsDir,
				// The improver loop's review AGENT launches AMBIENT, never the identity.
				env: agentEnv,
				note,
			});
		} catch (err) {
			if (!(err instanceof ReviewParseError)) {
				throw err;
			}
			const reviewErr = err as ReviewParseError;
			// Reap any review-edits SCRATCH the failed pass left on disk so it is never
			// swept into a later run's integrate commit.
			try {
				rmSync(join(cwd, REVIEW_EDITS_SCRATCH_DIR), {
					recursive: true,
					force: true,
				});
			} catch {
				// Best-effort.
			}
			const candidatePaths = await persistTaskingCandidates(
				cwd,
				slug,
				before,
				arbiter,
				env,
				note,
			);
			const reason = reviewFailureReason(slug, reviewErr, candidatePaths);
			const message = reviewFailureMessage(slug, reviewErr);
			if (useLock) {
				return await surfaceTaskingBlock({
					slug,
					cwd,
					arbiter,
					reason,
					message,
					lockedBlob,
					release: lock.release,
					mode: resolvedMode,
					provider: options.providerInstance,
					env,
					note,
				});
			}
			note(reason);
			// Human, no-lock path: a clean park-for-human is a success terminal (exit 0).
			return {exitCode: 0, outcome: 'needs-attention', slug, message};
		}
		// DECOMPOSITION UNCLEAR: emit NO guessed tasks — route the held spec to
		// needs-attention with the questions as the reason. The lock release amends the
		// `spec:<slug>` unified lock `active → stuck` (the tasking needs-attention surface
		// is the stuck lock now — NO folder write; the spec body stays in `work/specs/ready/`).
		if (loopDisposition.outcome === 'decomposition-unclear') {
			const reason = decompositionUnclearReason(
				slug,
				loopDisposition.specQuestions,
			);
			if (useLock) {
				return await surfaceTaskingBlock({
					slug,
					cwd,
					arbiter,
					reason,
					message: loopDisposition.message,
					lockedBlob,
					release: lock.release,
					mode: resolvedMode,
					provider: options.providerInstance,
					env,
					note,
				});
			}
			note(loopDisposition.message);
			// Human, no-lock path: nothing to release/surface via the seam; a clean
			// park-for-human is still a success terminal (exit 0).
			return {
				exitCode: 0,
				outcome: 'needs-attention',
				slug,
				message: loopDisposition.message,
			};
		}
		// UNCERTAIN TASKS: mark each named candidate `needsAnswers: true` + record
		// its questions in the body, so it lands but is not agent-buildable. The
		// runner writes the marker (the agent does no git/disk-escape).
		if (loopDisposition.outcome === 'uncertain-tasks') {
			for (const uncertain of loopDisposition.uncertainTasks) {
				markTaskNeedsAnswers(cwd, uncertain.path, uncertain.questions, note);
			}
		}
	}

	// 4. The RUNNER commits the COMPLETING transition: drop the produced backlog
	//    tasks IN + move the spec specs/ready/ -> specs/tasked/ (residence = tasked-ness) — now
	//    through the SHARED integrate core (`--propose` PR / `--merge` main), NOT a
	//    direct commit to `main`. The agent never does git. (The backlog snapshot is
	//    taken AFTER any loop edits, so the runner integrates the IMPROVED tasks,
	//    not the pre-loop candidates.)
	const stagedEmitted = newOrChangedStagedTasks(cwd, before);
	const emitTasks = collectEmittedTasks(cwd, stagedEmitted);
	// RUNNER-DETERMINISTIC PLACEMENT (task
	// `runner-deterministic-slice-placement-policy-and-precedence`; the
	// untrusted-forces-staging rung was RETIRED by ADR
	// `untrusted-origin-carries-via-stamp-not-forced-staging`). Resolve which
	// folder the runner lands the emitted tasks in BEFORE handing them to the
	// shared integrate band: precedence `explicit > configured default >
	// built-in (staging)`. THIS caller selects the trusted-vs-untrusted
	// configured default by reading the spec's propagated `originTrust:` stamp:
	// an untrusted-origin spec selects `untrustedTasksLandIn` (default staging;
	// `ready` when configured), a trusted/unset spec selects `tasksLandIn`. One
	// knob (`untrustedTasksLandIn`) governs an untrusted task's destination
	// whether born from an issue directly (intake) or from an untrusted spec
	// here. The agent NEVER influences this; it always writes to
	// `work/tasks/backlog/`, and the runner redirects at `stage()` time. Safety
	// for an untrusted task landing in `ready` is the carried stamp (its BUILD is
	// forced to a code PR), not the folder.
	const configuredTasksLanding =
		specFm.originTrust === 'untrusted'
			? options.untrustedTasksLandIn
			: options.tasksLandIn;
	const placementDecision = resolvePlacement({
		explicit: landingToSide(options.explicitTasksLandIn),
		configuredDefault: landingToSide(configuredTasksLanding),
	});
	const placementDir = placementFolder(
		TASK_PLACEMENT_SLOTS,
		placementDecision.choice,
	);
	// REWRITE the emitted list to the RUNNER-RESOLVED destination so callers see
	// where the runner actually placed the files (not where the agent wrote them).
	const emitted = stagedEmitted.map(
		(rel) => `${placementDir}/${basename(rel)}`,
	);
	const loopTag: 'converged' | 'uncertain-tasks' | undefined =
		loopDisposition?.outcome === 'converged'
			? 'converged'
			: loopDisposition?.outcome === 'uncertain-tasks'
				? 'uncertain-tasks'
				: undefined;

	if (useLock) {
		// READ-STABILITY BACKSTOP (the lock's content-identity check, now owned at the
		// integrate seam): the OUTPUT no longer rides the lock release, so the band
		// below would otherwise rebase a concurrent edit of the held spec body CLEANLY
		// into spec/ (a rename+edit merge) while the tasks were cut from the OLD body —
		// the exact silent stale-task drift the lock forbids
		// (`work/notes/observations/tasking-lock-does-not-stabilise-spec-content.md`). So we
		// compare the CURRENTLY held `work/specs/ready/<slug>.md` blob on the arbiter against
		// the snapshot the lock TOOK (`lockedBlob`); ANY change ⇒ STALE ⇒ fail loud,
		// touch NOTHING (the lock stays held; a human re-tasks or routes to
		// needs-attention). It is the SAME content-identity check `releaseTaskingLock`
		// runs — relocated here because this transition, not the release, owns the
		// completing commit now.
		const stale = await heldSpecIsStale(cwd, arbiter, slug, lockedBlob, env);
		if (stale) {
			const specRel = workItemRel('specs-ready', `${slug}.md`);
			const message =
				`RELEASE CONFLICT for '${slug}': the spec was edited (${specRel} ` +
				`changed on ${arbiter}/main) while the tasking lock was held. The tasking is ` +
				`STALE — re-task from the edited spec or route it to needs-attention. ` +
				`The arbiter was NOT modified (lock still held).`;
			note(message);
			return {exitCode: 4, outcome: 'stale', slug, message};
		}

		// Route the OUTPUT through the SHARED integrate back-half (task
		// `slice-output-through-integration`): the produced backlog tasks + the spec
		// lifecycle move (`work/specs/ready/ -> work/specs/tasked/`, residence = tasked-ness) integrate
		// via `performIntegration` honoring `--propose` (push the work branch + open a
		// PR, NO `main` touch) / `--merge` (land on `main`). Because the integrate-time
		// args resolve ONCE in the shared core, every `do task:` arg applies here by
		// construction. The agent did NO git; the runner (the band) owns the ONE commit.
		const core = await performIntegration({
			cwd,
			arbiter,
			slug,
			// `source`/`recovering` are task-shaped and IGNORED when `lifecycle` is set
			// (a tasking transition never recovers a surfaced needs-attention move).
			source: 'in-progress',
			recovering: false,
			// Skip the build acceptance gate (Gate 1 / verify): a tasking transition has
			// no `verify` floor (the tasker review loop above is its quality gate).
			skipVerify: true,
			// THE TASK-SET ACCEPTANCE GATE (task `slice-acceptance-gate`): the
			// task-path mirror of the build Gate-2, riding THIS shared core's
			// review-before-integrate block. When `review` resolves on, the wired
			// `reviewGate` (production: `harnessTaskReviewGate` with the task-SET
			// prompt) runs a FRESH-CONTEXT review of the produced task SET before it
			// integrates: `approve` lands it, `block` routes the set to needs-attention
			// via the SAME machinery the build block uses (mapped to the tasking
			// `needs-attention` outcome below). It is ONE-SHOT: we pin
			// `reviewMaxRounds: 1` so the gate is a SINGLE reviewer invocation → verdict
			// (terminal pass/fail). The task path NEVER exposes/consults
			// `--review-max-rounds` — a gate is terminal, the rounds bound is an orphan
			// that belongs to a future revise↔review loop (see
			// `work/notes/observations/reviewmaxrounds-on-wrong-concept.md`). This is
			// independently controllable from the tasker improver loop (`reviewLoop` /
			// the `--tasker-loop*` family); toggling one does not affect the other.
			review: options.review,
			reviewGate: options.reviewGate,
			reviewModel: options.acceptanceReviewModel,
			reviewMaxRounds: 1,
			// The cross-job merge-serialiser CAS-retry cap (config `mergeRetries`) —
			// threaded so a wide-matrix CI's raised cap reaches the tasking-
			// transition's land tail too (task
			// `thread-merge-retries-cross-task-and-ratify-default`). Unset ⇒ falls
			// through to the engine default (byte-for-byte unchanged).
			mergeRetries: options.mergeRetries,
			// The EXPLICITLY-chosen integrate mode proceeds AS-IS on an APPROVE — a
			// `--merge` tasking run lands on main, `--propose` opens a PR. The tasking
			// path's merge-vs-propose decision is the `integration` mode the user typed;
			// `merge` IS the auto-land mode, so a resolved `merge` is never downgraded.
			// The task gate family is `--review`/`--no-review`/`--review-model` only
			// (spec US #6).
			mode: resolvedMode,
			noPR: options.noPR,
			providerInstance: options.providerInstance,
			// PROPOSE-MODE PR BODY (task `slicing-pr-body-summary-threading`): mirror the
			// BUILD path's body threading (`do.ts` — `body: agent.output`). The tasker
			// agent produces no `LaunchResult.output` we can carry, but the slice-SET
			// itself is a summary-worthy artifact: the emitted task slugs+titles, their
			// coverage of the spec's user stories, the dependency graph (keystone +
			// blockedBy edges), and any `needsAnswers` open questions the tasker review
			// loop flagged. Compose it here and thread it into the shared core as `body`
			// so the propose-mode PR carries the summary instead of degrading to
			// `gh pr create --fill`. Empty-set (no emitted tasks) ⇒ undefined ⇒ the
			// provider's `--fill` fallback (no regression on that edge).
			body: composeTaskingProposeBody(slug, emitTasks),
			type: 'tasking',
			lifecycle: {
				// Read the PR title / commit summary from the held spec (before it moves).
				titlePath: workItemPath(cwd, 'specs-ready', slug),
				commitTag: 'tasked',
				stage: () =>
					stageTaskingLifecycle({
						cwd,
						slug,
						emitTasks,
						poolBefore,
						placementDir,
						note,
						env,
					}),
			},
			env,
			// The task-SET acceptance review AGENT launches AMBIENT, never the
			// identity-scoped `env` (an agent must not act as the bot).
			agentEnv,
			note,
		});

		// THE TASK-SET ACCEPTANCE GATE BLOCKED (task `slice-acceptance-gate`): the
		// fresh-context review of the produced SET returned `block`, so the core ran
		// the review BEFORE the stage/integrate and did NOT integrate the tasks
		// (correct). The CORRECT task-path destination is the SAME needs-attention
		// route the lock release owns for the decomposition-unclear verdict: it amends
		// the `spec:<slug>` unified lock `active -> stuck` with the block reason (the
		// tasking needs-attention surface is the stuck lock now — NO folder write; the
		// spec body stays in `work/specs/ready/`). So on a block we route the held spec to
		// needs-attention THROUGH the lock release — the set never lands.
		if (core.outcome === 'review-blocked') {
			const reason = taskGateBlockedReason(slug, core.reviewBlockReason);
			return await surfaceTaskingBlock({
				slug,
				cwd,
				arbiter,
				reason,
				message:
					`The task acceptance gate disapproved the set produced for '${slug}'; ` +
					`parked it for your attention (no tasks landed). ` +
					`Resolve the findings, then re-task.`,
				lockedBlob,
				release: lock.release,
				mode: resolvedMode,
				provider: options.providerInstance,
				env,
				note,
			});
		}
		if (core.outcome === 'sidecar-violation') {
			// A co-located `<slug>/` asset sidecar sits beside the FLOWING spec item
			// (WORK-CONTRACT.md rule 8): the tasking transition would `git mv`
			// `specs/ready → specs/tasked` and STRAND the sidecar. The core HARD-BLOCKED
			// before the stage/integrate; route the held spec to needs-attention through
			// the SAME `spec:<slug>` lock-release seam the block path uses (no tasks land),
			// carrying the actionable relocate-to-`docs/spikes/<slug>/` reason.
			const reason =
				`The spec '${slug}' carries a co-located asset sidecar: ` +
				`${core.reviewBlockReason ?? core.reason ?? ''}`;
			return await surfaceTaskingBlock({
				slug,
				cwd,
				arbiter,
				reason,
				message:
					`The spec '${slug}' carries a co-located asset sidecar (WORK-CONTRACT ` +
					`rule 8); parked it for your attention (no tasks landed; relocate it ` +
					`to docs/spikes/${slug}/ and reference by path).`,
				lockedBlob,
				release: lock.release,
				mode: resolvedMode,
				provider: options.providerInstance,
				env,
				note,
			});
		}
		if (core.outcome === 'review-unparseable') {
			// The task-set acceptance gate RAN but its verdict was UNPARSEABLE (malformed
			// JSON). Route the held spec to needs-attention through the SAME lock-release
			// seam the block path uses (the tasking needs-attention surface is the stuck
			// `spec:<slug>` lock; no folder write). It is NOT a block (the gate output was
			// unreadable) — record it as the transient-infra-class re-run signal so the
			// stuck reason reads correctly; nothing landed.
			const reason =
				`The task acceptance gate for '${slug}' produced an UNPARSEABLE verdict ` +
				`(re-run — transient): ${core.reason ?? ''}`;
			return await surfaceTaskingBlock({
				slug,
				cwd,
				arbiter,
				reason,
				message:
					`The task acceptance gate produced an unparseable verdict for '${slug}'; ` +
					`parked it for your attention (no tasks landed; re-run).`,
				lockedBlob,
				release: lock.release,
				mode: resolvedMode,
				provider: options.providerInstance,
				env,
				note,
			});
		}
		if (core.outcome === 'completed') {
			// LOCK LIFETIME IS MODE-DEPENDENT (fix
			// `propose-tasking-releases-lock-so-spec-is-retasked-and-pr-force-pushed-every-tick`;
			// the "hold-across-the-PR" capstone the older interim half deferred).
			//
			// `merge`: the durable `specs/ready → specs/tasked` `main` move HAS landed, so
			// residence-in-`specs/tasked/` on `main` now carries tasked-ness and the lock
			// has done its job — RELEASE it (delete the ref). Best-effort + idempotent
			// (`not-held` is fine).
			//
			// `propose`: the move lives ONLY on the pushed work branch / open PR — `main`
			// still holds the spec in `work/specs/ready/`, so residence does NOT yet signal
			// tasked-ness. If we released here, the next in-place scan would see the spec
			// eligible again (ready + not-tasked + lock free) and re-task it EVERY tick,
			// force-recreating the branch (`git switch -C`) and force-pushing the SAME PR —
			// regenerating its review forever until a human merges/closes it. So we KEEP
			// the `spec:<slug>` lock HELD across the open PR: the held lock IS the
			// "in-flight tasking" marker, and `scoreSpecs`/`taskableSpecs` subtract held
			// specs from the taskable pool (symmetric to the task-pool held-slug
			// subtraction). The lock is reaped when the PR resolves: a MERGE lands the
			// durable move (which now carries tasked-ness on its own) and the reap/gc path
			// deletes the merged branch + its lock; a human CLOSING the PR unmerged is a
			// recovery the human owns via `release-lock` (the same model as any other
			// abandoned in-flight item — no liveness heartbeat/auto-steal).
			//
			// MIGRATE step: the ref is keyed under the `spec:<slug>` identity (the
			// `spec-<slug>` lock entry the acquire took).
			if (useLock && resolvedMode === 'merge') {
				await releaseItemLock({item: `spec:${slug}`, cwd, arbiter, env});
			}
		}
		return integrationToTaskResult(core, {slug, emitted, loop: loopTag});
	}

	// HUMAN, no-lock path: the human commits on `main` directly (the runner does
	// not own the human's git). We report the produced tasks; moving the spec into
	// `work/specs/tasked/` (residence = tasked-ness) and committing is the human's to
	// do, as with the human `complete`.
	const message =
		`Tasked '${slug}' -> ${emitted.length} backlog task` +
		`${emitted.length === 1 ? '' : 's'} (human path, no lock). Inspect + commit ` +
		`the produced files (and move the spec into work/specs/tasked/) yourself.`;
	note(message);
	return {
		exitCode: 0,
		outcome: 'tasked',
		slug,
		emitted,
		loop: loopTag,
		message,
	};
}

/**
 * Map a non-`released` lock-release result onto the {@link TaskResult} contract
 * (the decomposition-unclear routing reuses the SAME release seam, so it can also
 * be `stale`/`lost`/`contended`/usage-error). Mirrors the step-4 release mapping.
 */
function releaseFailureToResult(
	released: ReleaseTaskingLockResult,
	slug: string,
): TaskResult {
	if (released.outcome === 'stale') {
		return {exitCode: 4, outcome: 'stale', slug, message: released.message};
	}
	if (released.outcome === 'lost' || released.outcome === 'contended') {
		const code = released.outcome === 'lost' ? 2 : 3;
		return {
			exitCode: code,
			outcome: 'lock-lost',
			slug,
			message: released.message,
		};
	}
	return {exitCode: 1, outcome: 'usage-error', slug, message: released.message};
}

/**
 * Map the shared integrate band's {@link IntegrationCoreResult} onto the tasking
 * {@link TaskResult} (task `slice-output-through-integration`). On `completed`
 * (propose pushed the work branch + opened a PR / merge landed on `main`) the
 * tasking is `tasked`. The band's FAILURE outcomes are reported on the tasking
 * contract: a `rebase-conflict` against a concurrently-advanced `main` maps to
 * `stale` (exit 4) — the tasking analogue of "the held spec moved under us"; a
 * a `gate-failed` cannot occur (the tasking path passes `skipVerify`) but maps to
 * a usage error defensively. A `review-blocked` (the task-SET ACCEPTANCE GATE
 * blocked the set, task `slice-acceptance-gate`) is handled by `performTask`
 * BEFORE this mapper — it routes the held spec to needs-attention via
 * the lock release (the task-path needs-attention route) — so it never reaches
 * here; it is mapped defensively to a usage error if it ever does.
 */
function integrationToTaskResult(
	core: IntegrationCoreResult,
	ctx: {
		slug: string;
		emitted: string[];
		loop: 'converged' | 'uncertain-tasks' | undefined;
	},
): TaskResult {
	const {slug, emitted, loop} = ctx;
	if (core.outcome === 'completed') {
		const landed =
			core.integration?.mode === 'merge'
				? 'landed them on the arbiter main'
				: 'opened a PR carrying them (main untouched)';
		const message =
			`Tasked '${slug}' -> ${emitted.length} backlog task` +
			`${emitted.length === 1 ? '' : 's'}; the runner integrated the transition ` +
			`through the shared core (moved work/specs/ready/ -> work/specs/tasked/, the ` +
			`tasked resting state) and ${landed}.`;
		return {exitCode: 0, outcome: 'tasked', slug, emitted, loop, message};
	}
	if (core.outcome === 'rebase-conflict') {
		return {
			exitCode: 4,
			outcome: 'stale',
			slug,
			message:
				core.reason ??
				`Integrating the tasking of '${slug}' conflicted against the latest ` +
					`${slug} main — the tasking is stale; re-task from the current spec.`,
		};
	}
	return {
		exitCode: 1,
		outcome: 'usage-error',
		slug,
		message:
			core.reason ??
			`Integrating the tasking of '${slug}' failed unexpectedly.`,
	};
}

/**
 * ONBOARD the tasking work onto a `work/<slug>` branch cut from the freshly-
 * fetched `<arbiter>/main` (task `slice-output-through-integration`). Called
 * AFTER the tasking lock is held, so the branch's base HOLDS the spec in
 * `work/specs/ready/` (the lock no longer moves the body) — the lifecycle stage then moves
 * it `specs/ready/ -> specs/tasked/` ON THIS BRANCH and the shared integrate core lands it. A
 * pre-existing local `work/<slug>` (a re-run) is force-recreated off fresh main.
 * The agent runs in-place on this branch (branch ≠ worktree).
 */
async function switchToWorkBranch(
	cwd: string,
	arbiter: string,
	slug: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<void> {
	// The tasking path is the parent-spec namespace (`do spec:<slug>`): the branch
	// is `work/spec-<slug>`, distinct from a same-slug task-build's `work/task-<slug>`.
	// MIGRATE step (spec `prd-to-spec-vocabulary-cutover-and-migration-command`):
	// MINT the work-branch under the `spec` namespace token (`workBranchRef` still
	// parses the legacy `work/prd-<slug>` form, so in-flight branches keep resolving).
	const branch = workBranchRef('spec', slug);
	await gitHard(['fetch', '--quiet', arbiter], cwd, env);
	await gitHard(
		['switch', '--quiet', '-C', branch, `${arbiter}/main`],
		cwd,
		env,
	);
}

/**
 * The READ-STABILITY content-identity STALE CHECK (the lock's backstop, owned at
 * the integrate seam now that the OUTPUT no longer rides the lock release): true
 * iff the CURRENTLY held `work/specs/ready/<slug>.md` blob on `<arbiter>/main` DIFFERS
 * from the snapshot the lock TOOK (`lockedBlob`, read from `work/specs/ready/<slug>.md` at
 * acquire). ANY change = a concurrent edit under the lock = the tasking is STALE.
 * Stronger than a textual rebase conflict (which a rename+edit merge can apply
 * CLEANLY). When `lockedBlob` is absent (never, in production) it reads as
 * not-stale (the lock acquire always returns it).
 */
async function heldSpecIsStale(
	cwd: string,
	arbiter: string,
	slug: string,
	lockedBlob: string | undefined,
	env: NodeJS.ProcessEnv | undefined,
): Promise<boolean> {
	if (lockedBlob === undefined) {
		return false;
	}
	await gitHard(['fetch', '--quiet', arbiter], cwd, env);
	const held = await gitSoft(
		['rev-parse', `${arbiter}/main:${workFolderRel('specs-ready')}/${slug}.md`],
		cwd,
		env,
	);
	// The spec being absent (already tasked/moved) is NOT this check's concern
	// (the integrate's rebase/push surfaces that); only a CHANGED held blob is stale.
	if (held.status !== 0) {
		return false;
	}
	return held.stdout.trim() !== lockedBlob;
}

/**
 * STAGE the tasking lifecycle into the index on the `work/<slug>` branch (the
 * {@link performIntegration} lifecycle seam): move the held spec
 * `git mv work/specs/ready/<slug>.md -> work/specs/tasked/<slug>.md` (the TASKED resting
 * state — the build-machine `done/` analogue, the SOURCE OF TRUTH for tasked-ness),
 * and write+`git add` the produced `work/tasks/backlog/*.md` files. The band's subsequent
 * `git add -A` + atomic commit folds this AND the agent's uncommitted backlog writes
 * into ONE runner-owned commit (the agent never does git).
 *
 * TASK `prd-sliced-folder-step-a` (spec `slicing-coherence` US #8): the lifecycle
 * destination is `work/specs/tasked/` (NOT back to `work/specs/ready/`) — `specs/tasked/`
 * residence IS tasked-ness (like `done/` for tasks, with no `done:` marker). The
 * `tasked:` frontmatter marker was removed entirely in `remove-sliced-marker-step-b`
 * (sequenced last): residence in `work/specs/tasked/` is now the sole signal.
 */
async function stageTaskingLifecycle(params: {
	cwd: string;
	slug: string;
	emitTasks: Record<string, string>;
	poolBefore: Map<string, string>;
	/**
	 * The runner-resolved destination folder (task
	 * `runner-deterministic-slice-placement-policy-and-precedence`). Computed
	 * ONCE in `performTask` via the shared {@link resolvePlacement}. The caller
	 * selects the configured default from the spec's `originTrust:` stamp
	 * (`untrustedTasksLandIn` when untrusted, else `tasksLandIn`; ADR
	 * `untrusted-origin-carries-via-stamp-not-forced-staging`) and overlays the
	 * operator's explicit override, then passes the result in here — so the call
	 * site sees exactly where the emitted tasks landed (the placement decision is
	 * not buried in the stage closure).
	 */
	placementDir: string;
	note: (message: string) => void;
	env: NodeJS.ProcessEnv | undefined;
}): Promise<void> {
	const {cwd, slug, emitTasks, poolBefore, placementDir, note, env} = params;
	const spec = workItemRel('specs-ready', `${slug}.md`);
	const specTasked = workItemRel('specs-tasked', `${slug}.md`);
	// PROPAGATE the origin-trust PROVENANCE (task
	// `untrusted-origin-forces-build-propose`): read the held spec's `origin`/
	// `originTrust` stamp BEFORE the move, so each emitted task can carry it. A
	// task's risk is its BUILD; the stamp must reach the task so the build
	// transition can force `propose` for untrusted-origin work. An UNSTAMPED spec (a
	// human/local-authored one ⇒ trusted) propagates nothing — the normal path is
	// untouched.
	const specAbs = join(cwd, spec);
	const specProvenance = existsSync(specAbs)
		? parseFrontmatter(readFileSync(specAbs, 'utf8'))
		: {origin: undefined, originTrust: undefined};
	// NOTE: author-trust no longer FORCES staging here (ADR
	// `untrusted-origin-carries-via-stamp-not-forced-staging`). An untrusted spec's
	// emitted tasks land per `untrustedTasksLandIn` (default staging; `ready` when
	// configured), selected by the caller from the stamp before `resolvePlacement`;
	// safety for a `ready` landing is the propagated `originTrust: untrusted` stamp
	// below (its BUILD is forced to a code PR), not the folder. The placement
	// decision itself is fully computed in `performTask`; this stage just writes to
	// the resolved `placementDir`.
	// Move the held spec specs/ready/ -> specs/tasked/ (the TASKED resting state — folder =
	// source of truth, like done/ for tasks). This is the DURABLE `specs/ready → specs/tasked`
	// success move, owned by THIS transition's commit (the lock no longer moved the
	// body, so the source is `work/specs/ready/`, never `work/tasking/`).
	mkdirSync(dirname(join(cwd, specTasked)), {recursive: true});
	await gitHard(['mv', spec, specTasked], cwd, env);
	await gitHard(['add', '--', specTasked], cwd, env);
	// **POOL-PLACEMENT FENCE (spec US #4 / governing ADR
	// `placement-is-runner-deterministic-humanonly-is-agent-judgement`).** The
	// agent ALWAYS writes to the STAGING folder (`work/tasks/backlog/`); the POOL
	// (`work/tasks/ready/`) is the agent-eligible pool the runner owns the promotion
	// into. Anything the agent dropped under the pool would otherwise be swept in
	// by `performIntegration`'s subsequent `git add -A` — a self-placement into
	// the pool. Scrub it FIRST (before the runner writes its resolved destination
	// files below), so when the runner-deterministic placement resolves to the
	// pool the runner's writes are the ONLY legitimate pool entries in the commit.
	await scrubPoolDrift(cwd, poolBefore, env);
	// Drop the produced backlog tasks IN at the RUNNER-RESOLVED destination
	// (write + stage; the band's `git add -A` also catches them, but staging here
	// keeps the transition explicit + atomic). The runner STAMPS the propagated
	// provenance onto each task as it writes it (the agent does no git; the runner
	// owns the file write here). When the resolved destination DIFFERS from where
	// the agent wrote (the staging folder), remove the agent's source file too —
	// otherwise `git add -A` would commit BOTH (staging twin + pool destination).
	for (const [agentRel, content] of Object.entries(emitTasks)) {
		const filename = basename(agentRel);
		const destRel = `${placementDir}/${filename}`;
		const destAbs = join(cwd, destRel);
		mkdirSync(dirname(destAbs), {recursive: true});
		writeFileSync(destAbs, propagateOrigin(specProvenance, content));
		await gitHard(['add', '--', destRel], cwd, env);
		if (destRel !== agentRel) {
			const srcAbs = join(cwd, agentRel);
			rmSync(srcAbs, {force: true});
			// Also unstage if `git add --` from a previous run picked it up;
			// untracked-and-now-gone is fine.
			await gitSoft(['rm', '-f', '--quiet', '--', agentRel], cwd, env);
		}
	}
}

/**
 * Revert any change/addition the agent made to the POOL `work/tasks/ready/` during a
 * tasking run. The agent's STAGING folder is `work/tasks/backlog/`; a write to the
 * pool is an attempt to self-place into the agent-eligible pool the runner owns
 * the promotion into (spec US #4 / governing ADR). Compared to the `poolBefore`
 * snapshot (the branch-base state of `work/tasks/ready/`, taken BEFORE the agent
 * ran), any new file is removed from the worktree and any changed file is
 * checked back out to HEAD — so the subsequent `git add -A` cannot land it. The
 * runner's commit then carries ONLY the explicit `tasks/backlog/` placement.
 */
async function scrubPoolDrift(
	cwd: string,
	poolBefore: Map<string, string>,
	env: NodeJS.ProcessEnv | undefined,
): Promise<void> {
	const dir = workFolderPath(cwd, 'tasks-ready');
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (!isWorkItemFile(name)) {
			continue;
		}
		const abs = join(dir, name);
		const content = readFileSync(abs, 'utf8');
		if (poolBefore.has(name)) {
			if (poolBefore.get(name) === content) {
				continue;
			}
			// The agent edited a pre-existing pool task — restore it from HEAD.
			await gitSoft(
				['checkout', 'HEAD', '--', workItemRel('tasks-ready', name)],
				cwd,
				env,
			);
			continue;
		}
		// The agent introduced a NEW file in the pool: drop it.
		rmSync(abs, {force: true});
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

/**
 * Build the needs-attention REASON for a task-SET ACCEPTANCE GATE block (task
 * `slice-acceptance-gate`): the fresh-context review of the produced set returned
 * `block`, so the spec is marked stuck on its per-item lock (post lock-cutover —
 * `state: stuck` with this reason on the lock entry, no `work/needs-attention/`
 * folder write) and NO tasks land. Takes the core's
 * structured `reviewBlockReason` (the gate's blocking findings); falls back to a
 * generic line when absent. DISTINCT from the improver loop's
 * {@link decompositionUnclearReason} (which carries the loop's open questions).
 */
function taskGateBlockedReason(
	slug: string,
	findingsReason: string | undefined,
): string {
	const head =
		`The task acceptance gate (fresh-context review of the produced SET) blocked ` +
		`'${slug}'. The spec is parked for your attention with no tasks landed; ` +
		`resolve the blocking findings, then re-task.`;
	return findingsReason ? `${head}\n\n${findingsReason}` : head;
}

/**
 * Shared terminal for a tasking transition that DID NOT land — a disapproving
 * task-set review, a co-located sidecar violation, an unparseable verdict, or a
 * decomposition-unclear loop exhaustion. It:
 *
 *   1. (propose mode + a provider) CLOSES the spec's OPEN PR — if one already
 *      exists (the multi-run artefact) — with the disapproving `reason` as the
 *      CLOSING COMMENT, KEEPING the branch (task
 *      `tasking-disapprove-closes-existing-pr-keeps-branch`). A later approving
 *      re-task REOPENs the same PR via `openRequest`. Only-if-exists: we never
 *      OPEN a PR just to close it, and merge mode has no PR to close.
 *   2. RELEASES the spec's per-item lock and SURFACES the item for the human as a
 *      `needsAnswers: true` body + a question sidecar on `<arbiter>/main` (via the
 *      release's `routeToNeedsAttention` redirect). The lock is RELEASED, not
 *      held — this is a parked question, not a lock the human must clear.
 *
 * A clean surface is a SUCCESSFUL terminal of the loop's "drain toward done OR
 * surface a question and idle" contract, so it returns `exitCode: 0` (the CI leg
 * is GREEN — a park-for-human is not a failure). Only a surface that FAILED to
 * publish maps to a non-zero {@link releaseFailureToResult}.
 */
async function surfaceTaskingBlock(params: {
	slug: string;
	cwd: string;
	arbiter: string;
	reason: string;
	message: string;
	lockedBlob: string | undefined;
	release: TaskingLockSeam['release'];
	mode: 'propose' | 'merge';
	provider: ReviewProvider | undefined;
	env: NodeJS.ProcessEnv | undefined;
	note: (message: string) => void;
}): Promise<TaskResult> {
	const {
		slug,
		cwd,
		arbiter,
		reason,
		message,
		lockedBlob,
		release,
		mode,
		provider,
		env,
		note,
	} = params;

	// 1. Close a stale OPEN PR (propose only, only-if-exists) with the review as
	//    the closing comment; keep the branch for a later approving re-task to
	//    reopen. Advisory + never-throw — a close failure never blocks the surface.
	if (mode === 'propose' && provider !== undefined) {
		const closed = await provider.closeRequestOnBranch({
			cwd,
			branch: workBranchRef('spec', slug),
			arbiter,
			comment: reason,
			env,
		});
		note(closed.instruction);
	}

	// 2. Release the lock + surface the parked question on main.
	const routed = await release({
		slug,
		cwd,
		arbiter,
		lockedBlob,
		routeToNeedsAttention: {reason},
		env,
		note,
	});
	if (routed.outcome !== 'released') {
		return releaseFailureToResult(routed, slug);
	}
	note(reason);
	// exit 0: a clean park-for-human is a successful loop terminal, not a failure.
	return {exitCode: 0, outcome: 'needs-attention', slug, message};
}

/**
 * Build the needs-attention REASON for a decomposition-unclear loop verdict (the
 * spec is parked for the human with these open questions + a question sidecar on
 * main, no guessed tasks). Prose only — recorded as the parked question's reason.
 */
function decompositionUnclearReason(slug: string, questions: string[]): string {
	const head =
		`The tasker review→edit loop could not converge on a sound decomposition of ` +
		`'${slug}' (--tasker-loop-max exhausted with unresolved blockers). The spec is parked ` +
		`for your attention with no guessed tasks; resolve:`;
	const body =
		questions.length > 0
			? questions.map((q) => `- ${q}`).join('\n')
			: '- (no specific questions surfaced; the decomposition is broadly unclear)';
	return `${head}\n${body}`;
}

/**
 * The needs-attention REASON for a REVIEW-LEG FAILURE (a parse failure, or the
 * NAMED cap-truncation class — observation
 * `tasker-review-edits-payload-caps-the-verdict-response`). The tasker produced a
 * good candidate set but the review/improver leg could not return a parseable
 * verdict, so the run is parked (the lock RELEASED, a question sidecar written)
 * rather than the whole tasking discarded. Names the failure precisely so an
 * operator does not mis-read a cap-truncation as a model flake and retry blindly.
 * The candidate tasks the tasker produced are PERSISTED on the work branch (see
 * {@link persistTaskingCandidates}) so a human can recover them.
 */
function reviewFailureReason(
	slug: string,
	err: ReviewParseError,
	candidatePaths: string[],
): string {
	const named =
		err instanceof ReviewOutputCappedError
			? `The tasker review leg failed on '${slug}': ${err.message}. This is a ` +
				"STRUCTURAL cap-truncation (the review edits payload shared the model's " +
				'capped output response with the verdict), NOT a model flake — do not ' +
				'blindly retry; the run is parked for you to recover the candidate tasks ' +
				'and re-task.'
			: `The tasker review leg failed on '${slug}': the review agent produced no ` +
				`parseable verdict (${err.message}). The run is parked for you to recover ` +
				'the candidate tasks and re-task.';
	const tasks =
		candidatePaths.length > 0
			? `\n\nThe tasker produced ${candidatePaths.length} candidate task(s) before the ` +
				'review leg failed; they are saved on the work branch ' +
				`'${workBranchRef('spec', slug)}' (commit "chore(tasking): save candidate ` +
				`tasks") for recovery:\n${candidatePaths.map((p) => `- ${p}`).join('\n')}`
			: '\n\n(No candidate tasks were on disk when the review leg failed.)';
	return `${named}${tasks}`;
}

/** The human-readable terminal MESSAGE for a review-leg failure (the result's `message`). */
function reviewFailureMessage(slug: string, err: ReviewParseError): string {
	if (err instanceof ReviewOutputCappedError) {
		return (
			`Tasking '${slug}' parked: the review leg hit the model output cap ` +
			`(${err.outputTokens} tokens) and was truncated before emitting its ` +
			'verdict. The candidate tasks were saved on the work branch; the lock was ' +
			'released and a question surfaced.'
		);
	}
	return (
		`Tasking '${slug}' parked: the review leg produced no parseable verdict ` +
		`(${err.message}). The candidate tasks were saved on the work branch; the ` +
		'lock was released and a question surfaced.'
	);
}

/**
 * PERSIST the tasker's candidate tasks (priority: do not discard the tasker's work
 * on the review-failure path). Commits the new-or-changed `work/tasks/backlog/*.md`
 * (this run's own output vs `before`) to the work branch under a marker commit,
 * then pushes the branch to the arbiter BEST-EFFORT (a push failure is noted, not
 * fatal — the local branch commit still survives a worktree teardown and is
 * recoverable by `git checkout work/spec-<slug>`). Returns the repo-relative
 * candidate paths persisted (empty when there were none). Never throws — a git
 * failure is noted and the bounce proceeds (the lock is still released).
 */
async function persistTaskingCandidates(
	cwd: string,
	slug: string,
	before: Map<string, string>,
	arbiter: string,
	env: NodeJS.ProcessEnv | undefined,
	note: (message: string) => void,
): Promise<string[]> {
	const candidatePaths = newOrChangedStagedTasks(cwd, before);
	if (candidatePaths.length === 0) {
		return [];
	}
	const branch = workBranchRef('spec', slug);
	try {
		await gitHard(['add', '--', ...candidatePaths], cwd, env);
		// Commit only if something is actually staged (a clean tree → nothing to save).
		const diffCached = await gitSoft(['diff', '--cached', '--quiet'], cwd, env);
		if (diffCached.status === 0) {
			return candidatePaths; // nothing new staged (already committed by a prior step).
		}
		await gitHard(
			[
				'commit',
				'-q',
				'-m',
				`chore(tasking): save candidate tasks for '${slug}' (review leg failed; not landed)`,
			],
			cwd,
			env,
		);
	} catch (err) {
		note(
			`Could not commit the candidate tasks to the work branch for recovery ` +
				`(best-effort; the bounce still proceeds): ${
					err instanceof Error ? err.message : String(err)
				}`,
		);
		return candidatePaths;
	}
	// Push the work branch best-effort so the candidate tasks survive a worktree
	// teardown on an isolated run (the branch ref survives locally too, but a push
	// makes them remote-recoverable). A push failure is noted, never fatal.
	try {
		const pushed = await gitSoft(['push', arbiter, branch], cwd, env);
		if (pushed.status !== 0) {
			note(
				`Could not push the candidate-tasks work branch '${branch}' to ${arbiter} ` +
					`(best-effort; the local commit still persists for recovery).`,
			);
		}
	} catch (err) {
		note(
			`Could not push the candidate-tasks work branch '${branch}' to ${arbiter} ` +
				`(best-effort; the local commit still persists for recovery): ${
					err instanceof Error ? err.message : String(err)
				}`,
		);
	}
	return candidatePaths;
}

/**
 * Mark a candidate task file `needsAnswers: true` and record its open questions in
 * its body (the loop's uncertain-task routing outcome). The runner writes the
 * file; the agent does no git/disk-escape. A path outside `work/tasks/backlog/`
 * is skipped (defensive). A relative `work/tasks/backlog/<slug>.md` that does not
 * exist is skipped with a note (never crash the transition).
 */
function markTaskNeedsAnswers(
	cwd: string,
	relPath: string,
	questions: string[],
	note: (message: string) => void,
): void {
	const normalized = relPath.replace(/\\/g, '/');
	if (
		!normalized.startsWith(`${STAGED_TASKS_DIR}/`) ||
		normalized.includes('..')
	) {
		note(
			`Skipped a needsAnswers mark outside ${STAGED_TASKS_DIR}/ (${relPath}).`,
		);
		return;
	}
	const abs = join(cwd, normalized);
	if (!existsSync(abs)) {
		note(`Skipped a needsAnswers mark for missing candidate task ${relPath}.`);
		return;
	}
	const current = readFileSync(abs, 'utf8');
	const marked = setNeedsAnswersMarker(current, true);
	writeFileSync(abs, appendQuestionsBlock(marked, questions));
}

/** The heading that opens the open-questions block in an uncertain task body. */
const OPEN_QUESTIONS_HEADING = '## Open questions';

/**
 * Append an `## Open questions` block (prose, never a frontmatter field —
 * WORK-CONTRACT rule 3) listing the loop's surfaced questions to an uncertain
 * task's body. A human answers these before the task becomes agent-buildable.
 */
function appendQuestionsBlock(content: string, questions: string[]): string {
	if (questions.length === 0) {
		return content;
	}
	const base = content.replace(/\s*$/, '');
	const items = questions.map((q) => `- ${q}`).join('\n');
	return [base, '', OPEN_QUESTIONS_HEADING, '', items, ''].join('\n');
}

/**
 * Resolve the AGENT tasking gate for `slug`: the pure predicate
 * (`needsAnswers !== true && humanOnly !== true && autoTask`) plus the
 * cross-spec `taskedAfter` ordering, resolved against `work/specs/tasked/` residence of
 * the specs present in the checkout.
 */
function resolveAgentGate(
	cwd: string,
	slug: string,
	specFm: {humanOnly?: boolean; needsAnswers?: boolean; taskedAfter: string[]},
	autoTask: boolean | undefined,
	explicit: boolean,
): TaskingEligibilityResult {
	return resolveTaskingEligibility({
		humanOnly: specFm.humanOnly,
		needsAnswers: specFm.needsAnswers,
		taskedAfter: specFm.taskedAfter,
		taskedSlugs: readTaskedSlugs(cwd),
		autoTask: autoTask ?? false,
		explicit,
	});
}

/** Build an HONEST gate-refusal message naming WHY the agent skipped the spec. */
function gateRefusalReason(
	slug: string,
	specFm: {humanOnly?: boolean; needsAnswers?: boolean},
	eligibility: TaskingEligibilityResult,
	options: PerformTaskOptions,
): string {
	const reasons: string[] = [];
	if (specFm.humanOnly === true) {
		reasons.push('the spec is humanOnly (a human must drive its tasking)');
	}
	if (specFm.needsAnswers === true) {
		reasons.push(
			'the spec has needsAnswers (open questions block auto-tasking)',
		);
	}
	// The autoTask POLICY only refuses on the NON-explicit (auto-pick pool) path:
	// an explicitly-named `do spec:<slug>` is authorized by the naming itself (the
	// build path's autoBuild precedent), so the policy is never the reason there.
	if (
		options.explicit !== true &&
		specFm.humanOnly !== true &&
		specFm.needsAnswers !== true &&
		(options.autoTask ?? false) !== true
	) {
		reasons.push("the repo's autoTask policy is off");
	}
	if (!eligibility.taskedAfter.satisfied) {
		reasons.push(
			`taskedAfter spec(s) not yet tasked: ${eligibility.taskedAfter.missing.join(', ')}`,
		);
	}
	const why =
		reasons.length > 0 ? reasons.join('; ') : 'the tasking gate refused';
	return `Skipped tasking '${slug}': ${why}.`;
}

/**
 * Read the set of slugs whose specs are already TASKED in this checkout — RESIDENCE
 * in `work/specs/tasked/` (the tasked resting state, task `prd-sliced-folder-step-a`
 * / spec `slicing-coherence` US #9), the build-machine `done/` analogue. The FOLDER
 * is the source of truth; the `tasked:` frontmatter marker was removed entirely in
 * `remove-sliced-marker-step-b` and is NOT consulted. So `taskedAfter` resolves
 * against `specs/tasked/` residence
 * (mirroring `blockedBy` -> `done/`). A missing folder reads as empty. The slug is
 * read from each file's frontmatter `slug:`, falling back to the filename — the same
 * shape the task readers use.
 */
function readTaskedSlugs(cwd: string): Set<string> {
	const slugs = new Set<string>();
	const dir = workFolderPath(cwd, 'specs-tasked');
	for (const file of listMarkdown(dir)) {
		const content = readFileSync(join(dir, file), 'utf8');
		const fm = parseFrontmatter(content);
		slugs.add(fm.slug ?? file.replace(/\.md$/i, ''));
	}
	return slugs;
}

/**
 * Build the tasking PROMPT: instruct a fresh-context agent to apply the
 * **tasking discipline** (`work/protocol/TASKING-PROTOCOL.md`) to the held
 * spec at `work/specs/ready/<slug>.md` and to EMIT tracer-bullet vertical
 * tasks under `work/tasks/backlog/`. The discipline body (the tracer-bullet
 * rules, the two-axis gate guidance, the confidence check, file-orthogonality,
 * the emitted task shape) lives in `TASKING-PROTOCOL.md` — NOT inlined here
 * (task `slicing-protocol-doc-and-vocabulary-fix`). The shape's source of
 * truth is the frontmatter parser + the task template (`work/protocol/
 * task-template.md`); the doc DESCRIBES it (D2).
 *
 * This builder owns ONLY the PER-BUILDER framing: who you are (a fresh-context
 * tasker for ONE spec), where the held spec is, where the emitted task files
 * MUST land (the staging folder, never the pool), and the runner-owns-git
 * boundary on the agent path. The shared discipline body is NOT duplicated
 * here.
 */
function buildTaskingSpec(slug: string, _spec: string | undefined): string {
	const specReady = workFolderRel('specs-ready');
	const specTasked = workFolderRel('specs-tasked');
	return [
		`You are a FRESH-CONTEXT tasker for the spec \`${specReady}/${slug}.md\`.`,
		`Apply the tasking discipline defined in \`work/protocol/TASKING-PROTOCOL.md\``,
		`(the in-band, protocol-native tasking protocol every set-up repo carries; the`,
		`human-facing pointer is \`skills/to-task/SKILL.md\`) to this ONE spec:`,
		`decompose it into independently-grabbable, tracer-bullet vertical tasks.`,
		`Read the spec fully first.`,
		``,
		`The discipline rules — the tracer-bullet test, the two-axis gate guidance`,
		`(\`humanOnly\` is NARROW; \`needsAnswers\` flags genuine uncertainty), the`,
		`confidence check that REPLACES the human-quiz step when no human is present,`,
		`the file-orthogonality preference, the spec-vs-task gate disjointness, and`,
		`the emitted task shape — ALL live in that doc. Read them there.`,
		``,
		`No human is present, so apply the CONFIDENCE CHECK (\`TASKING-PROTOCOL.md\``,
		`step 4): only emit tasks you would have gotten a human to approve. If`,
		`granularity, dependency order, a gate, or a seam is genuinely unresolved, set`,
		`\`needsAnswers: true\` on the specific uncertain task (questions in its body)`,
		`rather than guessing — or, if the whole decomposition is unclear, stop and`,
		`route the spec to needs-attention with the questions.`,
		``,
		`Task the spec ATOMICALLY or NOT AT ALL (\`TASKING-PROTOCOL.md\` §2a): run the`,
		`COMPLETENESS CHECK across the spec's user stories FIRST — a three-branch`,
		`decision. Every story becomes a task now, or NONE does; there is no "partially`,
		`tasked" state. (1) EVERY story build-taskable now (committed, answered, and you`,
		`know HOW to build it) — task the whole spec. (2) SOME stories gated / deferred /`,
		`unanswered (mixed confidence) — the spec is MIS-SCOPED: do NOT task the confident`,
		`subset; it must be SPLIT (a fully-taskable spec plus a separate spec for the`,
		`gated remainder). (3) The WHOLE thing too big / too uncertain to build-task even`,
		`after splitting (you do NOT yet know HOW to build it) — do NOT write FICTIONAL`,
		`build tasks; it must be REFRAMED as an EXPLORATION spec whose "done" is`,
		`confidence + a de-risked build plan (pin the seam, spike the risky part on one`,
		`case, resolve the questions, emit the plan). In BOTH the split and the reframe`,
		`case, emit NO tasks: stop and route the spec to needs-attention with the reason`,
		`(a human authors the split / exploration reframe).`,
		``,
		`WRITE EVERY emitted task file under \`${STAGED_TASKS_DIR}/\` (the STAGING folder)`,
		`— NEVER \`work/tasks/ready/\`. \`work/tasks/ready/\` is the agent-eligible POOL and`,
		`the runner owns the runner/human-only promotion into it; the tasker's staging`,
		`folder is \`work/tasks/backlog/\`. A write outside the staging folder is dropped`,
		`by the runner-deterministic placement resolver.`,
		``,
		`Set each task's \`spec:\` field to the source spec slug (\`${slug}\`) so the`,
		`link back to the spec survives.`,
		``,
		`Do NOT perform any git operations — do not stage, commit, push, or move any`,
		`files. The RUNNER owns every git-state transition (it commits the produced`,
		`tasks, releases the tasking lock, and moves the spec into \`${specTasked}/\`).`,
	].join('\n');
}

/** Run the task agent. Prefers the injected runner; else the harness seam. */
async function runTaskAgent(
	options: PerformTaskOptions,
	cwd: string,
	prompt: string,
	slug: string,
): Promise<{ok: boolean; detail?: string}> {
	// The tasker AGENT launches with the AMBIENT env (`agentEnv`), never the
	// identity-scoped `env` (an agent must not act as the bot). Falls back to `env`
	// when no identity is configured.
	const agentEnv = options.agentEnv ?? options.env;
	if (options.dorfl) {
		return options.dorfl({cwd, prompt, slug, env: agentEnv});
	}
	const harness = options.harness ?? new NullHarness();
	const launched = await launchWithOptionalWatch({
		harness,
		dir: cwd,
		slug,
		command: options.agentCmd ?? '',
		prompt,
		model: options.model,
		sessionId: `task-${slug}`,
		sessionsDir: options.sessionsDir,
		env: agentEnv,
	});
	return {ok: launched.ok, detail: launched.detail};
}

/** A snapshot of {@link STAGED_TASKS_DIR}: filename → file content. */
function snapshotStagedTasks(cwd: string): Map<string, string> {
	const dir = join(cwd, STAGED_TASKS_DIR);
	const snap = new Map<string, string>();
	for (const file of listMarkdown(dir)) {
		snap.set(file, readFileSync(join(dir, file), 'utf8'));
	}
	return snap;
}

/**
 * Repo-relative paths of the {@link STAGED_TASKS_DIR}`/*.md` files the agent
 * NEWLY created or CHANGED vs the pre-run snapshot — exactly what the runner
 * captures + commits. (An untouched pre-existing staged task is NOT
 * re-committed.) The agent's staging folder is `work/tasks/backlog/`; writes to
 * the pool `work/tasks/ready/` are scrubbed at stage time, never picked up here.
 */
function newOrChangedStagedTasks(
	cwd: string,
	before: Map<string, string>,
): string[] {
	const dir = join(cwd, STAGED_TASKS_DIR);
	const changed: string[] = [];
	for (const file of listMarkdown(dir)) {
		const content = readFileSync(join(dir, file), 'utf8');
		if (before.get(file) !== content) {
			changed.push(stagedTaskPath(file));
		}
	}
	return changed.sort();
}

/** Snapshot the POOL `work/tasks/ready/` (for the agent-write fence at stage time). */
function snapshotPool(cwd: string): Map<string, string> {
	const dir = workFolderPath(cwd, 'tasks-ready');
	const snap = new Map<string, string>();
	for (const file of listMarkdown(dir)) {
		snap.set(file, readFileSync(join(dir, file), 'utf8'));
	}
	return snap;
}

/** Read the produced backlog tasks' content keyed by repo-relative path. */
function collectEmittedTasks(
	cwd: string,
	relPaths: string[],
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rel of relPaths) {
		out[rel] = readFileSync(join(cwd, rel), 'utf8');
	}
	return out;
}

/**
 * Compose the propose-mode PR BODY for a slice-set (task
 * `slicing-pr-body-summary-threading`): mirror the BUILD path's body threading
 * (`do.ts` — `body: agent.output`) with a summary drawn from what the tasker
 * ALREADY has in hand — the emitted task files. The shared
 * {@link composeProposeBody} then wraps this prose with its runner-owned header.
 *
 * Sections (all suppressed when empty, so the body stays honest):
 *   1. A lead line naming the source spec + emitted task count.
 *   2. **Tasks** — one bullet per task: `slug — title`, plus `covers:` (which
 *      spec user stories it maps to, as `US-<n>` so GitHub does not autolink
 *      the index as an issue/PR reference), `blockedBy:`, and `needsAnswers`
 *      if set.
 *   3. **Dependency graph** — the KEYSTONE(S) (tasks whose `blockedBy` names no
 *      other task in this set, so they land first) and the `blockedBy` edges.
 *   4. **Needs answers** — any open questions the tasker review→edit loop
 *      appended under `## Open questions` on `needsAnswers: true` tasks, so the
 *      deferred seams are visible on the PR (not buried in task bodies).
 *
 * Returns `undefined` for the empty set (no emitted tasks) so the provider's
 * `gh pr create --fill` fallback still applies on that edge (matches the build
 * path's absent-body behaviour).
 */
export function composeTaskingProposeBody(
	specSlug: string,
	emitTasks: Record<string, string>,
): string | undefined {
	const entries = Object.entries(emitTasks);
	if (entries.length === 0) {
		return undefined;
	}
	const tasks = entries
		.map(([rel, content]) => parseTaskSummary(rel, content))
		.sort((a, b) => a.slug.localeCompare(b.slug));
	const setSlugs = new Set(tasks.map((t) => t.slug));
	const lines: string[] = [];
	const n = tasks.length;
	lines.push(
		`Auto-tasked \`${specSlug}\` into ${n} backlog task${n === 1 ? '' : 's'}.`,
	);
	lines.push('');
	lines.push('## Tasks');
	lines.push('');
	for (const t of tasks) {
		lines.push(`- **${t.slug}** — ${t.title}`);
		if (t.covers.length > 0) {
			// User-story ids are rendered as `US-<n>` (NOT `US #<n>`): a bare
			// `#<n>` in a GitHub PR body autolinks to issue/PR #<n>, which is a
			// confusing false reference (the number is a spec user-story index,
			// not an issue). The hyphenated form carries the same meaning without
			// tripping GitHub's autolinker.
			lines.push(`  - covers: ${t.covers.map((c) => `US-${c}`).join(', ')}`);
		}
		if (t.blockedBy.length > 0) {
			lines.push(`  - blockedBy: ${t.blockedBy.join(', ')}`);
		}
		if (t.needsAnswers) {
			lines.push('  - needsAnswers: true');
		}
	}
	// Dependency graph: keystone(s) are tasks whose blockedBy names no OTHER
	// member of this set (an external blocker — e.g. a task already in `done/` —
	// does not prevent this set-relative starting point); the edges list every
	// set-internal `blockedBy` link so a reviewer can trace the ordering.
	const keystones = tasks.filter((t) =>
		t.blockedBy.every((b) => !setSlugs.has(b)),
	);
	const edges = tasks.flatMap((t) =>
		t.blockedBy.filter((b) => setSlugs.has(b)).map((b) => `${t.slug} ← ${b}`),
	);
	if (keystones.length > 0 || edges.length > 0) {
		lines.push('');
		lines.push('## Dependency graph');
		lines.push('');
		if (keystones.length > 0) {
			const word = keystones.length === 1 ? 'Keystone' : 'Keystones';
			lines.push(`- ${word}: ${keystones.map((k) => k.slug).join(', ')}`);
		}
		for (const edge of edges) {
			lines.push(`- ${edge}`);
		}
	}
	const uncertain = tasks.filter((t) => t.needsAnswers);
	if (uncertain.length > 0) {
		lines.push('');
		lines.push('## Needs answers');
		lines.push('');
		for (const t of uncertain) {
			lines.push(`- **${t.slug}**:`);
			if (t.openQuestions.length === 0) {
				lines.push('  - (no specific questions surfaced)');
				continue;
			}
			for (const q of t.openQuestions) {
				lines.push(`  - ${q}`);
			}
		}
	}
	return lines.join('\n');
}

/** Summary of one emitted task, for {@link composeTaskingProposeBody}. */
interface TaskSummary {
	slug: string;
	title: string;
	covers: string[];
	blockedBy: string[];
	needsAnswers: boolean;
	openQuestions: string[];
}

/**
 * Parse one emitted task file into a {@link TaskSummary}. Uses
 * {@link parseFrontmatter} for the shared fields; scans the raw frontmatter
 * block for `covers:` (not currently modelled on the parser's typed shape) and
 * the body for a trailing `## Open questions` bullet list (the loop's
 * uncertain-task disposition sink, see {@link appendQuestionsBlock}).
 */
function parseTaskSummary(rel: string, content: string): TaskSummary {
	const fm = parseFrontmatter(content);
	const slug = fm.slug ?? basename(rel).replace(/\.md$/i, '');
	const title = readTitleField(content) ?? slug;
	return {
		slug,
		title,
		covers: readCoversField(content),
		blockedBy: fm.blockedBy,
		needsAnswers: fm.needsAnswers === true,
		openQuestions: readOpenQuestions(content),
	};
}

/**
 * Extract the `title:` scalar from the raw frontmatter block (not on
 * {@link parseFrontmatter}'s typed shape). Missing / malformed ⇒ `undefined`.
 * Comment-tolerant: a trailing `# ...` after an UNQUOTED value is stripped.
 */
function readTitleField(content: string): string | undefined {
	const normalized = content.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
	if (!normalized.startsWith('---\n')) {
		return undefined;
	}
	const lines = normalized.split('\n');
	const closing = lines.indexOf('---', 1);
	if (closing === -1) {
		return undefined;
	}
	for (let i = 1; i < closing; i++) {
		const m = lines[i].match(/^title:\s*(.*)$/);
		if (!m) continue;
		let value = m[1].trim();
		if (value === '') return undefined;
		// Quoted ⇒ return inner text verbatim; unquoted ⇒ strip trailing `# ...`.
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			return value.slice(1, -1);
		}
		const hash = value.indexOf('#');
		if (hash !== -1) value = value.slice(0, hash).trimEnd();
		return value === '' ? undefined : value;
	}
	return undefined;
}

/**
 * Extract the `covers: [...]` inline-list values from the raw frontmatter block
 * of a task (not on {@link parseFrontmatter}'s typed shape, so we scan the raw
 * fence here). Missing / malformed / empty ⇒ `[]`. Comment-tolerant (a trailing
 * `# ...` after the `]` is ignored, matching the house style on `blockedBy: []
 * # startable now`).
 */
function readCoversField(content: string): string[] {
	const normalized = content.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
	if (!normalized.startsWith('---\n')) {
		return [];
	}
	const lines = normalized.split('\n');
	const closing = lines.indexOf('---', 1);
	if (closing === -1) {
		return [];
	}
	for (let i = 1; i < closing; i++) {
		const line = lines[i];
		const m = line.match(/^covers:\s*\[([^\]]*)\]/);
		if (!m) continue;
		return m[1]
			.split(',')
			.map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
			.filter((s) => s !== '');
	}
	return [];
}

/**
 * Extract the bullets under a trailing `## Open questions` heading in a task
 * body — the tasker review loop's uncertain-task sink (see
 * {@link appendQuestionsBlock}). Returns `[]` when no such block exists.
 */
function readOpenQuestions(content: string): string[] {
	const normalized = content.replace(/\r\n/g, '\n');
	const idx = normalized.lastIndexOf(`\n${OPEN_QUESTIONS_HEADING}`);
	if (idx === -1) {
		return [];
	}
	const tail = normalized.slice(idx + 1);
	const lines = tail.split('\n').slice(1);
	const questions: string[] = [];
	for (const raw of lines) {
		const line = raw.trimEnd();
		if (line === '') continue;
		const m = line.match(/^- (.*)$/);
		if (!m) break;
		questions.push(m[1]);
	}
	return questions;
}

/** List `*.md` files in `dir`, sorted; an absent dir reads as empty. */
function listMarkdown(dir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries.filter((name) => isWorkItemFile(name)).sort();
}
