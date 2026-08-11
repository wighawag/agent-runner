import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {type WorkFolderKey, workItemPath, workItemRel} from './work-layout.js';
import {
	resolveAdvanceArg,
	SlugResolutionError,
	type SlugNamespace,
} from './slug-namespace.js';
import {ledgerRead, type LedgerReadStrategy} from './ledger-read.js';
import {parseFrontmatter} from './frontmatter.js';
import {
	parseSidecar,
	sidecarPathFor,
	type SidecarModel,
	type SidecarType,
} from './sidecar.js';
import {classifyTick, type TickClassification} from './advance-classify.js';
import {
	acquireAdvancingLock,
	releaseAdvancingLock,
	type AcquireAdvancingLockResult,
	type ReleaseAdvancingLockResult,
} from './advancing-lock.js';
import {performDo, type DoOptions, type DoResult} from './do.js';
import {
	harnessSurfaceGate,
	toNewQuestions,
	type SurfaceGate,
} from './surface-gate.js';
import {harnessTriageGate, type TriageGate} from './triage-gate.js';
import type {ObservationTriage} from './config.js';
import {
	autoDispositionObservation,
	promoteObservation,
	stampTriagedMarker,
	type AutoDispositionOptions,
	type AutoDispositionResult,
	type PromoteObservationOptions,
	type PromoteObservationResult,
	type StampTriagedMarkerOptions,
	type StampTriagedMarkerResult,
} from './triage-persist.js';
import {mintAdr, type MintAdrOptions, type MintAdrResult} from './mint-adr.js';
import {LIFECYCLE_CAS_CONTENTION} from './advancing-lock.js';
import {
	decide,
	DisallowedOutcomeError,
	type DecisionVerdict,
} from './decision-engine.js';
import {
	APPLY_ALLOWED_OUTCOMES,
	buildApplyDecisionInput,
	harnessApplyDecider,
	type ApplyDecider,
} from './apply-decide.js';
import {
	persistSurfacedQuestions,
	type SurfacePersistOptions,
	type SurfacePersistResult,
} from './surface-persist.js';
import {
	applyAnsweredQuestions,
	hasAppliedAnswersRecord,
	TRIAGED_RESOLVE,
	type ApplyAnsweredQuestionsOptions,
	type ApplyAnsweredQuestionsResult,
} from './apply-persist.js';
import {
	detectAnsweredMergeAction,
	performMergeAction,
	type MergeActionHandler,
	type MergeActionResult,
} from './apply-merge-action.js';
import {
	detectAnsweredStuckAction,
	performStuckAction,
	type StuckActionHandler,
	type StuckActionResult,
} from './apply-stuck-action.js';
import type {VerifyConfig} from './verify.js';
import type {NewQuestion} from './sidecar.js';

/**
 * The **`advance` verb SKELETON** (spec `advance-loop`, task
 * `advance-verb-resolver`, US #1/5/6/18). `advance` is the SIBLING top-level verb
 * (NOT a `do` subcommand — `do` subcommands are REJECTED in the spec) that drives
 * a `work/` item ONE lifecycle rung toward "ready/built", reusing the SAME shared
 * `prefix:arg` resolver `do` uses (extended with the `obs:` namespace, see
 * {@link resolveAdvanceArg}).
 *
 * This module delivers the **classify → lock → execute SKELETON** — the contract
 * both drivers (the later one-shot/loop tasks) wrap:
 *
 *   1. **classify** — read-only, NO model, NO lock: read the item's two signals
 *      (`needsAnswers` + the sidecar's answered-state) and call the pure
 *      {@link classifyTick} to get the rung kind. A CAS loser will have spent ONLY
 *      this free classification.
 *   2. **lock** — take the `advancing` CAS borrow ({@link acquireAdvancingLock})
 *      for the classified rung, keyed on the item's `<type>-<slug>` identity. The
 *      expensive (agent/model) phase is ALWAYS post-lock, so a loser backs off
 *      having done ~nothing (a TOCTOU between classify and CAS is harmless — only
 *      the free classification is wasted, and the loser never starts model work).
 *   3. **execute** — WINNER ONLY: dispatch the classified rung to the
 *      {@link RungExecutor} seam, then release the borrow.
 *
 * The **rung BODIES** are now ALL filled (their own tasks): `surface`
 * (`advance-rung-surface`), `apply` (`advance-rung-apply`), and
 * `triage-observation` (`advance-rung-triage`) dispatch through the clearly-named
 * executor SEAM ({@link RungExecutor}); the build/task rungs ORCHESTRATE
 * `do`/`do spec:`. What this verb does NOT do (LATER tasks):
 *   - The two **DRIVERS** (one-shot sequential / loop) + `-n` + the gate-FAMILY
 *     WIRING that resolves `autoBuild`/`autoTask`/`observationTriage` and threads
 *     them into the build/task gate composition — task `advance-drivers-and-gates`.
 *     (This verb already RESPECTS `observationTriage` in the triage rung — the gate's
 *     resolution chain + the build/task gate composition is the drivers task.)
 *   - The bare `advance` (eligible-SET) form — it needs the pool scan / driver, so
 *     the verb here is a SINGLE named-item tick; the bare form errors clearly
 *     ("needs the driver task"). See the `## Decisions` block in the task.
 *
 * The build-task / task-spec rungs ORCHESTRATE the existing `do` / `do spec:`
 * machinery ({@link performDo}) — `advance` is a driver layered ON TOP, NEVER a
 * peer that duplicates the build/task path (ONE build path, ONE task path —
 * US #6).
 */

const DEFAULT_ARBITER = 'origin';

/**
 * The terminal condition of one `advance` tick (mirrors `DoOutcome`'s shape).
 *
 * `vanished` (task `observation-identity-is-its-filename-not-a-foreign-slug`):
 * a BENIGN SKIP when the item's file was enumerated into the lifecycle pool but
 * has since been moved/triaged/deleted by a sibling leg (the cross-tick window
 * under parallel CI). It is `exitCode: 0` so the matrix tolerates it, but it is
 * DISTINGUISHABLE from `no-op` (which is a calm classify result, e.g. a pending
 * sidecar) so reviewers can grep these out. NOT used for a human-typed bare slug
 * that names nothing — that is a malformed invocation; today the two are not
 * distinguished at this seam (a human typo also skips benignly) and the matrix
 * scale of the calm condition justifies the trade.
 */
export type AdvanceOutcome =
	| 'advanced'
	| 'no-op'
	| 'vanished'
	/**
	 * The triage/apply promote leg found the task it would mint ALREADY EXISTS on
	 * the arbiter AND was PROVABLY minted from THIS observation in a prior run (its
	 * `promotedFrom:` back-reference matches) — an idempotency fact, so the source was
	 * already triaged. `exitCode: 0` (the matrix tolerates it, so it does NOT red CI),
	 * DISTINGUISHABLE from `vanished` (item file gone) and `no-op` (calm classify) so
	 * reviewers can grep it. The LOUD `lost` (exit 2) is reserved for a genuine
	 * concurrent-create race with an UNRELATED same-path item, where a retry helps.
	 * (task `observation-triage-already-triaged-benign-skip`; sibling of the
	 * stale-snapshot / held-lock CI-noise fixes.)
	 */
	| 'already-triaged'
	| 'usage-error'
	| 'lost'
	| 'contended'
	| 'not-implemented'
	| 'invariant-violation'
	/**
	 * The answered-merge dispatcher REFUSED the land on the rebased tip (RED
	 * re-verify, rebase conflict, or a pre-checkout failure). Distinct from
	 * `usage-error` (which is reserved for genuine caller-usage errors — e.g.
	 * the workspacesDir-unset guard below). `performIntegration` has already
	 * routed the item to needs-attention via its shared seam, so `main` never
	 * received a failing tree; the sidecar is LEFT IN PLACE so the open answer
	 * stays surfaced for a human follow-up. `exitCode: 1`.
	 * (task `merge-action-nits-followup` nit 2.)
	 */
	| 'merge-refused';

/** Maps onto the claim-CAS exit codes (identical semantics). */
export type AdvanceExitCode = 0 | 1 | 2 | 3;

/**
 * The injectable rung-executor SEAM — WHAT happens once the tick has classified a
 * rung AND won the `advancing` lock. It is the boundary between the skeleton (this
 * task) and the rung bodies (later tasks): the surface/apply/triage rungs are
 * filled by their own tasks; the build/task rungs ORCHESTRATE `do`/`do spec:`.
 *
 * Production wires {@link defaultRungExecutor}; tests inject a spy to assert the
 * classify→lock→dispatch ORDER (and that a CAS loser never reaches the executor).
 */
export interface RungExecutor {
	/** A ready task → build it by ORCHESTRATING `do <slug>` (NOT a re-implementation). */
	buildTask(input: RungExecInput): Promise<RungExecResult>;
	/** A ready spec → task it by ORCHESTRATING `do spec:<slug>` (NOT a re-implementation). */
	taskSpec(input: RungExecInput): Promise<RungExecResult>;
	/** An untriaged observation → triage it (LATER task fills this body). */
	triageObservation(input: RungExecInput): Promise<RungExecResult>;
	/** `needsAnswers` but no sidecar → surface the questions (LATER task fills this). */
	surface(input: RungExecInput): Promise<RungExecResult>;
	/** Every entry answered → apply the answers + advance (LATER task fills this). */
	apply(input: RungExecInput): Promise<RungExecResult>;
}

/** What a rung executor is handed: the resolved identity + the run context. */
export interface RungExecInput {
	/** The canonical namespaced identity (`task:<slug>` / `spec:<slug>` / `observation:<slug>`). */
	item: string;
	/** The resolved namespace (`task` / `spec` / `observation`). */
	namespace: SlugNamespace;
	/** The bare slug. */
	slug: string;
	/** The classification that selected this rung (the two signals are visible). */
	classification: TickClassification;
	/** The tick's run context (cwd, arbiter, …) — threaded to `do`/`do spec:`. */
	context: AdvanceContext;
}

/** A rung executor's result (the outcome the tick reports). */
export interface RungExecResult {
	exitCode: AdvanceExitCode;
	outcome: AdvanceOutcome;
	message: string;
}

/** The run context threaded from the CLI into the tick + the rung executor. */
export interface AdvanceContext {
	/** The working clone/checkout to run in-place in. */
	cwd: string;
	/** Name of the arbiter git remote. Defaults to `origin`. */
	arbiter?: string;
	/** The base `do` options the build/task rungs orchestrate `performDo` with. */
	doOptions?: Omit<DoOptions, 'arg'>;
	/**
	 * The build/task ORCHESTRATION DRIVER seam (task
	 * `advance-loop-driver-registry-set-job-worktrees`). The build-task / task-spec
	 * rungs ORCHESTRATE `do` by handing the resolved arg + the threaded
	 * {@link doOptions} to THIS driver. `undefined` ⇒ {@link performDo} (the IN-PLACE
	 * substrate — the human-local one-shot `advance` command + today's
	 * single-mirror `run --advance`, which build in the cwd checkout). The
	 * registry-set advance driver injects a PER-MIRROR JOB-WORKTREE driver
	 * ({@link jobWorktreeDoDriver}) so the daemon/CI path builds isolated off each
	 * mirror's arbiter (the SAME isolation `run`'s build tick gives `runOneItem`),
	 * NOT in `process.cwd()`. This is the parameterised isolation strategy the
	 * task's `## Decisions` records: in-place and worktree COEXIST behind one seam,
	 * reusing the EXISTING `selectIsolationStrategy`/`jobWorktreeStrategy` (no second
	 * isolation mechanism). The DEFAULT keeps in-place behaviour byte-for-byte.
	 */
	doDriver?: (options: DoOptions) => Promise<DoResult>;
	/**
	 * The SURFACE gate seam — the fresh-context `surface-questions` spawn the
	 * surface rung uses (task `advance-rung-surface`). The skill JUDGES (emits
	 * questions); the engine PERSISTS. Production wires {@link harnessSurfaceGate};
	 * tests inject a stub emit. `undefined` ⇒ the surface rung defaults to
	 * {@link harnessSurfaceGate} (a NullHarness, no real model) so the seam is never
	 * a crash — but the CLI threads the real harness-backed gate.
	 */
	surfaceGate?: SurfaceGate;
	/**
	 * The model the SURFACE agent runs on (de-correlated from the builder, like
	 * `reviewModel`). Flows to the gate's launch through `LaunchInput.model`.
	 */
	surfaceModel?: string;
	/**
	 * Persist the surfaced questions ATOMICALLY (append-or-create the sidecar + set
	 * `needsAnswers:true` in ONE commit). Tests inject a spy; production uses
	 * {@link persistSurfacedQuestions}. The ENGINE owns ALL persistence — the skill
	 * writes nothing.
	 */
	surfacePersist?: (options: SurfacePersistOptions) => SurfacePersistResult;
	/**
	 * Apply the HUMAN's answered sidecar ATOMICALLY (item body + sidecar in ONE
	 * commit, via the sidecar contract's atomic-apply), then resolve / re-pause /
	 * disposition to a terminal. Tests inject a spy; production uses
	 * {@link applyAnsweredQuestions}. The engine applies ONLY human-authored answers
	 * — it NEVER invents one.
	 */
	applyPersist?: (
		options: ApplyAnsweredQuestionsOptions,
	) => ApplyAnsweredQuestionsResult;
	/**
	 * Supply the NEW follow-up questions an apply discovered (so it APPENDS them and
	 * re-pauses rather than resolving). `undefined`/empty ⇒ the apply resolves (or
	 * dispositions) the item. The follow-up GENERATION is the surface skill's job;
	 * this seam lets the apply rung append already-formulated follow-ups (and lets
	 * tests drive the append-re-pause path) WITHOUT inventing an ANSWER.
	 */
	applyFollowups?: NewQuestion[];
	/**
	 * The AGENTIC apply DECISION seam (task
	 * `agentic-apply-retire-disposition-vocabulary`): the fresh-context decision
	 * agent the apply rung runs on a fully-answered OBSERVATION to choose what to DO
	 * with the signal (`mint-task | mint-spec | mint-adr | dispose-source |
	 * resolve-no-mint | ask-follow-up`),
	 * grounded in the source's full context. It is the injected
	 * {@link ApplyDecider} the shared `decide(input, allowedOutcomes)` engine runs;
	 * tests inject a CANNED verdict (no model). `undefined` ⇒ the apply rung defaults
	 * to {@link harnessApplyDecider} (a NullHarness, no real model) so the seam is
	 * never a crash — but the CLI threads the real harness-backed decider. The
	 * verdict's type SELECTION (task vs spec vs adr) replaces the retired `promote-*`
	 * disposition token; `adr` is now WIRED (task `agentic-apply-mint-adr-route`).
	 */
	applyDecide?: ApplyDecider;
	/** The model the apply-DECISION agent runs on (de-correlated, like `surfaceModel`). */
	applyModel?: string;
	/**
	 * The 3-state `observationTriage` policy (ADR `ci-config-policy-and-gate-
	 * family` §2) read at the triage rung. It governs the rung-internal
	 * ask-vs-auto distinction (the SELECTION-layer `off` gate is applied EARLIER, in
	 * the driver, by dropping the observation pool — so a rung that runs was either
	 * `ask`/`auto`-selected OR explicitly named, which BYPASSES the selection gate):
	 *   - `'auto'` ⇒ the conservative auto-disposition EXCEPTION is live (ask the
	 *     {@link TriageGate}; auto-dispose ONLY the no-question cases);
	 *   - `'ask'` / `'off'` / `undefined` ⇒ surface the promote/keep/delete question
	 *     and WAIT (the question-gated path). Under `off` + an EXPLICIT `obs:<slug>`
	 *     (which bypasses the selection gate) the rung runs in `ask`-mode — the
	 *     conservative, question-surfacing default (task `## Decisions`). SURFACE +
	 *     APPLY stay ALWAYS allowed; this gate ONLY governs the auto-disposition
	 *     exception, never the always-allowed question loop.
	 */
	observationTriage?: ObservationTriage;
	/**
	 * The TRIAGE auto-disposition gate seam — the fresh-context spawn the triage
	 * rung asks (ONLY when `observationTriage` is `'auto'`) whether an observation
	 * is a no-question case. The skill JUDGES; the engine ACTS. Production wires
	 * {@link harnessTriageGate}; tests inject a stub decision. `undefined` ⇒ the
	 * triage rung defaults to {@link harnessTriageGate} (a NullHarness, no real
	 * model) so the seam is never a crash.
	 */
	triageGate?: TriageGate;
	/** The model the TRIAGE agent runs on (de-correlated, like `surfaceModel`). */
	triageModel?: string;
	/**
	 * Execute the conservative auto-disposition ATOMICALLY (record + marker, one
	 * commit). Tests inject a spy; production uses {@link autoDispositionObservation}.
	 */
	autoDisposition?: (options: AutoDispositionOptions) => AutoDispositionResult;
	/**
	 * Back-stamp the `triaged:` settled marker on a note that was ALREADY
	 * resolved-and-kept before the apply rung learned to stamp it (the legacy arm of
	 * the triage rung's settled guard). Tests inject a spy; production uses
	 * {@link stampTriagedMarker}.
	 */
	stampTriaged?: (
		options: StampTriagedMarkerOptions,
	) => StampTriagedMarkerResult;
	/**
	 * Promote an answered observation: CAS-create a new backlog stub keyed on the
	 * NEW item's identity, then record + resolve the observation. Tests inject a
	 * spy; production uses {@link promoteObservation}.
	 */
	promote?: (
		options: PromoteObservationOptions,
	) => Promise<PromoteObservationResult>;
	/**
	 * Mint an ADR from an answered observation (the agentic `mint-adr` verdict, task
	 * `agentic-apply-mint-adr-route`): CAS-create `docs/adr/<slug>.md` keyed on the
	 * NEW ADR's identity, with the source + sidecar deleted in the SAME commit. The
	 * SIBLING of {@link promote} for the `docs/adr/` target (an ADR lands OUTSIDE the
	 * work board, so it is a distinct route, not a `promoteObservation` artifact
	 * type). Tests inject a spy; production uses {@link mintAdr}.
	 */
	mintAdr?: (options: MintAdrOptions) => Promise<MintAdrResult>;
	/**
	 * The NEW backlog slug an answered promote drafts. `undefined` ⇒ the promote
	 * defaults to the observation's own slug. Lets a test (or a future driver) steer
	 * the promoted item's identity WITHOUT inventing the answer.
	 */
	promoteSlug?: string;
	/**
	 * The execution working area (`workspacesDir`, default `~/.dorfl`) the
	 * answered-merge LAND uses to cut a per-job worktree from the hub mirror
	 * (via `workspace.ts` `createJob`). Unset ⇒ no `workspacesDir` is available
	 * to the dispatcher, so an answered `kind: merge` entry is REFUSED as a
	 * genuine caller-usage error (outcome `usage-error`, `exitCode: 1`) and the
	 * answer stays surfaced for a follow-up — threading `workspacesDir` is the
	 * caller's contract, and forgetting it gets this documented clean refusal
	 * rather than a mysterious downstream failure (task
	 * `merge-action-nits-followup` nit 3). The registry-set advance driver
	 * threads the resolved `workspacesDir` here.
	 * (spec `land-time-reverify-and-parallel-merge-ceiling`, task
	 * `apply-rung-merge-disposition`)
	 */
	workspacesDir?: string;
	/**
	 * The arbiter URL the answered-merge LAND mirrors from. Optional: when
	 * unset the dispatcher resolves it via `git remote get-url <arbiter>` in the
	 * apply rung's `cwd` (the in-place / one-shot caller). The registry-set
	 * advance driver threads the per-mirror origin URL here directly so the
	 * per-mirror tree-less clone (whose `origin` points at the LOCAL mirror
	 * path, not the real arbiter URL) is bypassed.
	 */
	arbiterUrl?: string;
	/**
	 * Per-repo env-prep config (`prepare`) the answered-merge LAND threads into
	 * `performIntegration` so the fresh-worktree gate runs `prepare` then
	 * `verify` on the rebased tip — the SAME config the build path uses.
	 */
	prepare?: VerifyConfig;
	/**
	 * Per-repo acceptance gate (`verify`) the answered-merge LAND threads into
	 * `performIntegration` so the fresh-worktree gate re-verifies the rebased
	 * tip before integrating.
	 */
	verify?: VerifyConfig;
	/**
	 * Resolved `strictMergeApproval` boolean (sibling task
	 * `strict-merge-approval-gate`). Default OFF ⇒ honour the prior approval +
	 * land on a green re-verify (cheap, the SPEC-applied OQ6 default). ON ⇒
	 * re-surface the merge-question when the merge-base moved between the
	 * surfacer's question and this apply (the host-agnostic analogue of
	 * GitHub's "dismiss stale approvals when the base changes").
	 */
	strictMergeApproval?: boolean;
	/**
	 * The merge-action dispatch SEAM (task `apply-rung-merge-disposition`):
	 * the deterministic answer-driven runner-action handler the apply rung
	 * invokes BEFORE the agentic decider when an answered `kind: merge` entry
	 * is detected. Production wires {@link performMergeAction} (checks out via
	 * `createJob` + lands via `performIntegration` with `committedRecovery:
	 * true` + `freshWorktreeGate: true`); tests inject a stub so they assert on
	 * the apply-rung's `landed | refused | restale | hold | drop` routing
	 * WITHOUT spinning up a hub mirror or running real verify.
	 */
	mergeAction?: MergeActionHandler;
	/**
	 * The stuck-action dispatch SEAM (task
	 * `apply-resolve-reset-flag-discards-work-branch`, spec
	 * `surface-stuck-as-questions-and-retire-stuck-lock-state`): the
	 * deterministic answer-driven runner-action handler the apply rung invokes
	 * BEFORE the fall-through persist when an answered `kind: 'stuck'` entry
	 * (the shape the bounce-surface path stamps) is detected. Production wires
	 * {@link performStuckAction} (drives the shared
	 * `deleteRemoteWorkBranchIfPresent` primitive on `reset`); tests inject a
	 * stub so they assert on the apply-rung's `keep | reset | refused | cancel`
	 * routing WITHOUT touching a real arbiter. The deterministic sibling of
	 * {@link mergeAction} for the `kind: 'stuck'` axis.
	 */
	stuckAction?: StuckActionHandler;
	/** Sink for human-readable progress notes. */
	note?: (message: string) => void;
}

/** The options one `advance` tick consumes. */
export interface AdvanceOptions extends AdvanceContext {
	/**
	 * The raw CLI slug argument: bare (= task), `task:<slug>`, `spec:<slug>`, or
	 * `obs:<slug>` / `observation:<slug>`. Omit/empty ⇒ the bare eligible-SET form,
	 * which needs the driver task (a clear error here — see `## Decisions`).
	 */
	arg?: string;
	/** The repo working-tree root whose `work/` to read (defaults to `cwd`). */
	repoPath?: string;
	/** The read seam for the resolver's cross-namespace existence check. */
	read?: LedgerReadStrategy;
	/** The rung executor seam (defaults to {@link defaultRungExecutor}). */
	executor?: RungExecutor;
	/** Inject the classify signals (tests); production reads them from disk. */
	readSignals?: (input: ReadSignalsInput) => ItemSignals;
	/** Inject the lock acquire (tests); production uses {@link acquireAdvancingLock}. */
	acquireLock?: (item: string) => Promise<AcquireAdvancingLockResult>;
	/** Inject the lock release (tests); production uses {@link releaseAdvancingLock}. */
	releaseLock?: (item: string) => Promise<ReleaseAdvancingLockResult>;
}

/** The tick's terminal result. */
export interface AdvanceResult {
	exitCode: AdvanceExitCode;
	outcome: AdvanceOutcome;
	/** The classified rung kind, when the tick got far enough to classify. */
	rung?: TickClassification['kind'];
	/** The resolved bare slug acted on, when one was resolved. */
	slug?: string;
	/** Human-readable summary of the terminal condition. */
	message: string;
}

/** The two classify SIGNALS read off the item (the only state the classifier needs). */
export interface ItemSignals {
	/** The item-body `needsAnswers` flag. */
	needsAnswers: boolean | undefined;
	/** The parsed ACTIVE sidecar, or `undefined` when none exists. */
	sidecar: SidecarModel | undefined;
}

/** What {@link readItemSignals} needs to read an item's two signals off disk. */
export interface ReadSignalsInput {
	/** The repo working-tree root. */
	repoPath: string;
	/** The item type (task / spec / observation). */
	type: SidecarType;
	/** The bare slug. */
	slug: string;
	/** The canonical namespaced identity (`<namespace>:<slug>`). */
	item: string;
}

/**
 * Map the resolver's namespace onto the sidecar type. The `spec` namespace maps
 * to the `spec` sidecar type, so `advance spec:<slug>` resolves its
 * signals/folders (`FOLDERS_FOR_TYPE['spec']`) and orchestrates `do spec:<slug>`.
 */
function sidecarTypeFor(namespace: SlugNamespace): SidecarType {
	return namespace === 'observation'
		? 'observation'
		: namespace === 'spec'
			? 'spec'
			: 'task';
}

/**
 * Read an item's two CLASSIFY signals off disk (read-only, NO model, NO lock):
 *   - `needsAnswers` from the item-body frontmatter (searching the lifecycle
 *     folders the type may rest in), and
 *   - the ACTIVE sidecar (`work/questions/<type>-<slug>.md`) parsed when present.
 *
 * Identity-keyed: the sidecar path derives PURELY from `<type>-<slug>` (it
 * survives the item's `git mv`s with no lock-step move). Returns
 * `needsAnswers:undefined` when no item file is found (the classifier treats it
 * as "not gated", an ANALYSE rung) — the verb's job here is to wire the two
 * signals, not to assert the item exists (that is the rung's concern).
 */
export function readItemSignals(input: ReadSignalsInput): ItemSignals {
	const {repoPath, type, slug, item} = input;
	const needsAnswers = readNeedsAnswers(repoPath, type, slug);
	const sidecarRel = sidecarPathFor(item);
	const sidecarAbs = join(repoPath, sidecarRel);
	let sidecar: SidecarModel | undefined;
	if (existsSync(sidecarAbs)) {
		sidecar = parseSidecar(readFileSync(sidecarAbs, 'utf8'));
	}
	return {needsAnswers, sidecar};
}

/**
 * The lifecycle folders each item type may rest in (frontmatter source). After
 * the capstone cut-over (task
 * `cutover-retire-slicing-advancing-markers-and-trim-folder-sets`) the transient
 * `tasking/` folder is GONE — a spec rests in `specs/ready` (source) or
 * `specs/tasked` (tasked); while it is being tasked the body STAYS in
 * `specs/ready` (the lock no longer moves it), so `tasking/` is never a
 * frontmatter source.
 *
 * STAGING IS INCLUDED (`tasks-backlog` / `prds-proposed`): with `surfaceStaging`
 * on (the user-visible default) the lifecycle surface pool enumerates
 * `needsAnswers` items resting in STAGING as `task:`/`spec:` legs
 * (`lifecycle-gather.ts`). The rung CLASSIFIER's signal read MUST see those
 * staged bodies, or `needsAnswers` reads back `undefined`, the classifier
 * mis-routes the item to the BUILD rung, and claim dies with "not found on
 * origin/main" (observation
 * `advance-task-folder-set-omits-tasks-backlog-staged-surface-items-misroute-to-build`).
 * This is the staging-inclusive set its sibling `apply-persist.ts`
 * (`APPLY_LIFECYCLE_FOLDERS`) already uses — kept in step here. BUILD/claim
 * eligibility is UNCHANGED (still pool-only; staging items stay non-claimable):
 * only the rung-classifier's frontmatter-source folders widen.
 */
const FOLDERS_FOR_TYPE: Record<SidecarType, readonly WorkFolderKey[]> = {
	task: ['tasks-backlog', 'tasks-ready', 'in-progress', 'done'],
	// `spec` rests in the parent-spec regime folders (a `spec:<slug>` legs
	// frontmatter-source read resolves against these).
	spec: ['specs-proposed', 'specs-ready', 'specs-tasked'],
	observation: ['observations'],
};

/** Read `needsAnswers` off the FIRST `work/<folder>/<slug>.md` that exists. */
function readNeedsAnswers(
	repoPath: string,
	type: SidecarType,
	slug: string,
): boolean | undefined {
	for (const folder of FOLDERS_FOR_TYPE[type]) {
		const abs = workItemPath(repoPath, folder, slug);
		if (existsSync(abs)) {
			return parseFrontmatter(readFileSync(abs, 'utf8')).needsAnswers;
		}
	}
	return undefined;
}

/**
 * The PRODUCTION rung executor: build/task rungs ORCHESTRATE the existing
 * `do`/`do spec:` machinery ({@link performDo}); the `surface`/`apply`/
 * `triage-observation` rung bodies are filled by their own tasks
 * ({@link surfaceRung} / {@link applyRung} / {@link triageRung}). It NEVER
 * re-implements the build/task path — it hands the resolved arg to `performDo`,
 * which spans both namespaces (the task path is the `do spec:` rung the spec's
 * 2026-06-09 UPDATE confirms routes through `performIntegration`).
 */
export const defaultRungExecutor: RungExecutor = {
	async buildTask(input) {
		return orchestrateDo(input);
	},
	async taskSpec(input) {
		return orchestrateDo(input);
	},
	async triageObservation(input) {
		return triageRung(input);
	},
	async surface(input) {
		return surfaceRung(input);
	},
	async apply(input) {
		return applyRung(input);
	},
};

/**
 * ORCHESTRATE `do`/`do spec:` for the build-task / task-spec rungs: hand the
 * resolved namespaced identity to {@link performDo} (the ONE build path / ONE
 * task path). `advance` is a driver ON TOP — it does NOT duplicate `do`. The
 * `do` outcome is mapped back onto the tick's outcome surface.
 */
async function orchestrateDo(input: RungExecInput): Promise<RungExecResult> {
	const {item, context} = input;
	const base = context.doOptions;
	if (base === undefined) {
		// The skeleton can classify + lock + DISPATCH without `do` options wired
		// (the driver task threads them). Report it honestly rather than crash —
		// the orchestration TARGET is `performDo`, named here, not re-implemented.
		return {
			exitCode: 1,
			outcome: 'usage-error',
			message:
				`advance would ORCHESTRATE \`do ${item}\` for this rung, but no \`do\` ` +
				`options were threaded into the tick (the driver task wires them).`,
		};
	}
	// The ORCHESTRATION TARGET is `performDo` by DEFAULT (in-place, the cwd checkout
	// IS the isolation), or the injected {@link AdvanceContext.doDriver} — the
	// registry-set advance driver threads a PER-MIRROR JOB-WORKTREE driver so the
	// daemon/CI build runs isolated off the mirror's arbiter. Either way `advance`
	// ORCHESTRATES `do` (the ONE build path / ONE task path) — it does NOT duplicate it.
	const driver = context.doDriver ?? performDo;
	const result: DoResult = await driver({...base, arg: item});
	return {
		exitCode: result.exitCode,
		outcome: result.exitCode === 0 ? 'advanced' : mapDoOutcome(result),
		message: result.message,
	};
}

/** Map a non-zero `do` result onto the tick's outcome vocabulary. */
function mapDoOutcome(result: DoResult): AdvanceOutcome {
	switch (result.outcome) {
		case 'lost':
			return 'lost';
		case 'contended':
			return 'contended';
		default:
			return 'usage-error';
	}
}

/**
 * The SURFACE rung BODY (task `advance-rung-surface`, US #32/33): the FIRST rung
 * filling the executor seam, establishing the spawn→emit→persist pattern the
 * other rung bodies reuse. Under the `advancing` CAS lock (held by
 * {@link performAdvance} BEFORE this runs — so the expensive spawn is POST-lock,
 * winner-only), it:
 *
 *   1. spawns a FRESH-CONTEXT agent with `surface-questions` loaded (the
 *      {@link SurfaceGate} seam, mirroring the review gate's `review` spawn) and
 *      collects the EMITTED questions — the skill JUDGES, writes nothing; and
 *   2. has the ENGINE ITSELF write/append them to the sidecar CAS-atomically AND
 *      set `needsAnswers:true` in the SAME commit
 *      ({@link persistSurfacedQuestions}) — the engine PERSISTS.
 *
 * Append-never-overwrite: a re-surface ADDS `qN+1` and flips a previously-all-
 * answered sidecar back to not-all-answered (the persist owns that). An EMPTY
 * emit (the skill's honest "no open judgement") writes nothing and reports it.
 */
async function surfaceRung(
	input: RungExecInput,
	surfaceOpts: {baseQuestions?: NewQuestion[]} = {},
): Promise<RungExecResult> {
	const {item, context} = input;
	const note = context.note ?? (() => {});
	const cwd = context.cwd;

	// Locate the item file (the only thing the persist needs beyond the questions:
	// the file to set `needsAnswers:true` on). The sidecar path is identity-derived,
	// not folder-derived, so only the ITEM file's folder must be found.
	const itemPath = findItemPath(cwd, input.namespace, input.slug);
	if (itemPath === undefined) {
		return vanishedSkip({rung: 'surface', item});
	}

	// DETERMINISTIC BASE QUESTIONS (the triage rung's "always ask" contract): the
	// caller may pass engine-built questions that MUST be surfaced regardless of the
	// agent. They are added ONLY on the FIRST pass (no sidecar yet) — on a re-surface
	// the sidecar already carries them, and `appendQuestions` does NOT dedup, so
	// re-adding would duplicate. When base questions are present the agent is
	// ADDITIVE ONLY and its flake/empty is NON-FATAL (the base question still lands).
	const baseQuestions = surfaceOpts.baseQuestions ?? [];
	const hasBase = baseQuestions.length > 0;
	const sidecarExists = existsSync(join(cwd, sidecarPathFor(item)));
	const baseToAdd = hasBase && !sidecarExists ? baseQuestions : [];

	// 1. SPAWN the fresh-context `surface-questions` agent (the skill JUDGES). The
	//    expensive model work is POST-lock (the lock is held by `performAdvance`).
	//
	// SHORT-CIRCUIT (primary/load-bearing half of task
	// `surface-short-circuit-already-triaged-observations-and-harden-skill-empty-emit`):
	// an OBSERVATION with provably no open judgement (frontmatter `needsAnswers` NOT
	// true, no non-empty `## Open questions` section, no pending sidecar) — the
	// typical shape of a decision-record / already-triaged note — deterministically
	// yields `{questions: []}` WITHOUT round-tripping the flaky surface-questions
	// agent (source observation
	// `surface-questions-agent-still-emits-no-parseable-questions-on-decision-record-obs-2026-07-10`).
	// The loud-error contract from
	// `advance-surface-limbo-observation-loudly-instead-of-silent-no-op` is
	// PRESERVED for the observations that DO reach the agent — this only spares the
	// ones that provably have nothing to ask. Conservative: fires only on
	// observations; tasks/specs still always ask.
	const gate = context.surfaceGate ?? harnessSurfaceGate();
	let emit;
	if (isNothingToSurfaceObservation(cwd, input, itemPath, sidecarExists)) {
		note(
			`surface ${item}: auto-triaged (no open questions, no sidecar) — skipped agent.`,
		);
		emit = {questions: []};
	} else {
		try {
			emit = await gate({
				item,
				cwd,
				surfaceModel: context.surfaceModel,
			});
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			if (!hasBase) {
				return {
					exitCode: 1,
					outcome: 'usage-error',
					message: `surface ${item}: the surface-questions agent produced no usable emit (${detail}).`,
				};
			}
			// The agent flaked but we have a deterministic base question to surface: the
			// flake is NON-FATAL. Treat the agent's extras as empty and carry on (the
			// base triage question still lands, so the human can triage via the sidecar).
			note(
				`surface ${item}: the surface-questions agent produced no usable emit ` +
					`(${detail}); surfacing the deterministic question(s) only.`,
			);
			emit = {questions: []};
		}
	}

	// 2. The ENGINE persists (the skill wrote nothing): append-or-create the sidecar
	//    + set `needsAnswers:true` in ONE commit (CAS-atomic under the held lock).
	//    Base questions FIRST (q1…), then the agent's additive extras.
	const persist = context.surfacePersist ?? persistSurfacedQuestions;
	const result = persist({
		cwd,
		item,
		itemPath,
		questions: [...baseToAdd, ...toNewQuestions(emit)],
		note,
	});
	if (result.outcome === 'nothing') {
		// The agent had nothing to ask AND there was no base question to add (a
		// task/spec surface, or a re-surface whose base question is already present).
		// This is the calm "no open judgement" no-op — no sidecar written. (There is
		// no "limbo" any more: the triage rung ALWAYS passes a base question on the
		// first pass, so an untriaged observation can never fall here empty-handed.)
		return {
			exitCode: 0,
			outcome: 'no-op',
			message: `surface ${item}: no open judgement — nothing surfaced.`,
		};
	}
	return {
		exitCode: 0,
		outcome: 'advanced',
		message:
			`surfaced ${result.entryCount} question(s) for ${item} → ${result.sidecarPath} ` +
			`(needsAnswers:true, CAS-atomic).`,
	};
}

/**
 * Would this OBSERVATION provably surface `{questions: []}` — i.e. is there no
 * open judgement anywhere on it? Cheap read-only predicate the surface rung uses
 * to skip the flaky agent round-trip for already-triaged / decision-record notes
 * (task
 * `surface-short-circuit-already-triaged-observations-and-harden-skill-empty-emit`;
 * source observation
 * `surface-questions-agent-still-emits-no-parseable-questions-on-decision-record-obs-2026-07-10`).
 *
 * Fires ONLY when ALL of these hold (conservative — err on the side of STILL
 * calling the agent if uncertain):
 *   - the item's namespace is `observation` (tasks/specs are out of scope here —
 *     they carry no engine-owned base question and a false-positive there would
 *     silently drop a real question the author asked for);
 *   - the item body's frontmatter does NOT set `needsAnswers: true` (an author
 *     who set the flag is explicitly asking for the agent's pass);
 *   - the body carries no non-empty `## Open questions` section (empty /
 *     whitespace-only sections don't count as judgement);
 *   - there is no pending open-question sidecar for the item (same signal the
 *     classifier's invariant-1 read uses — the sidecar path is identity-derived).
 *
 * The decision-record shape (a `Decision (…)` line and/or `## Alternatives
 * considered` section) is a HINT, not required — the four conditions above are
 * load-bearing on their own.
 */
function isNothingToSurfaceObservation(
	cwd: string,
	input: RungExecInput,
	itemPath: string,
	sidecarExists: boolean,
): boolean {
	if (input.namespace !== 'observation') {
		return false;
	}
	if (sidecarExists) {
		return false;
	}
	let content: string;
	try {
		content = readFileSync(join(cwd, itemPath), 'utf8');
	} catch {
		return false;
	}
	const fm = parseFrontmatter(content);
	if (fm.needsAnswers === true) {
		return false;
	}
	if (hasNonEmptyOpenQuestionsSection(content)) {
		return false;
	}
	return true;
}

/**
 * Does the body carry a non-empty `## Open questions` section? Tolerates the
 * `## Open questions to NOT guess` variant the capture-signal skill writes (same
 * pattern the triage split uses). Whitespace-only / "none" markers count as
 * empty.
 */
function hasNonEmptyOpenQuestionsSection(content: string): boolean {
	const lines = content.replace(/\r\n/g, '\n').split('\n');
	const startIdx = lines.findIndex((l) => /^##\s+Open questions\b/i.test(l));
	if (startIdx === -1) {
		return false;
	}
	let endIdx = lines.length;
	for (let i = startIdx + 1; i < lines.length; i++) {
		if (/^##\s+/.test(lines[i])) {
			endIdx = i;
			break;
		}
	}
	const body = lines
		.slice(startIdx + 1, endIdx)
		.join('\n')
		.trim();
	if (body === '') {
		return false;
	}
	// A single "none" / "n/a" marker line — treat as empty (author signalled "no
	// open judgement" explicitly).
	if (/^(?:none|n\/a|-|_+)\.?$/i.test(body)) {
		return false;
	}
	return true;
}

/**
 * The DETERMINISTIC triage question the triage rung ALWAYS surfaces for an
 * untriaged observation (the "no limbo, ever" contract). It is engine-built (NOT
 * LLM output), so it can never be zeroed out or flake: every untriaged observation
 * gets exactly this question, and the human answers it via the sidecar — a record,
 * a rationale note, and a fresh-bug signal are all treated identically (the human
 * decides the disposition). The `surface-questions` agent runs ADDITIVELY on top,
 * adding any extra pointed questions it extracts from the body.
 */
export function buildTriageBaseQuestion(): NewQuestion {
	return {
		question:
			'What should become of this observation? Reply with a disposition and a ' +
			'reason: resolve (settle it, keep the note on record — say why), promote ' +
			'(mint a task / spec / adr — say which and why), delete (redundant or ' +
			'obsolete — say why), or duplicate (maps onto an existing item — name it).',
		context:
			'The engine records your disposition from the answer (no token needed); an ' +
			'answered promote mints the artifact, resolve keeps the note settled, ' +
			'delete/duplicate discharge it.',
	};
}

/**
 * The observation TRIAGE rung BODY (task `advance-rung-triage`, US #16/17/23):
 * the rung the classifier picks for an UNTRIAGED observation (`needsAnswers` not
 * set, no sidecar). It is QUESTION-GATED BY DEFAULT: it surfaces a promote/keep/
 * delete question and WAITS — so "is this worth building?" is NEVER decided
 * autonomously. A CONSERVATIVE `observationTriage: 'auto'`-gated EXCEPTION (US #17,
 * high bar) may auto-disposition ONLY the no-question cases:
 *
 *   - **default (question-gated):** delegate to {@link surfaceRung} — spawn the
 *     `surface-questions` agent (it emits a PLAIN "what becomes of this signal?"
 *     question — NO disposition token any more, task
 *     `agentic-apply-retire-disposition-vocabulary`) and the ENGINE persists the
 *     sidecar + `needsAnswers`. When the human answers, the AGENTIC apply decision
 *     (not a stamped token) reads the answer + source and chooses what to DO.
 *     Surface stays ALWAYS allowed (US #23) — this path runs under `ask`/`off`
 *     (and `off` + an explicit `obs:` runs in this `ask`-mode).
 *   - **`auto` exception:** ONLY under `observationTriage: 'auto'`, ask the
 *     {@link TriageGate} whether the observation is a no-question case. If it emits
 *     `auto: true` (`duplicate` → DELETE the redundant note; `map` → unambiguous
 *     map onto an existing item), the engine auto-dispositions it WITHOUT a
 *     question ({@link autoDispositionObservation}). It NEVER auto-deletes a
 *     NON-duplicate (a `duplicate` discharges by deletion because it is a
 *     redundant copy of an already-captured signal — nothing is lost) and NEVER
 *     auto-promotes a judgement call (`auto: false` ⇒ fall back to the surface
 *     question). Promotion is ALWAYS a human answer (the apply path).
 *
 * Under the `advancing` CAS lock (held by {@link performAdvance} BEFORE this runs),
 * so the expensive spawn is POST-lock, winner-only.
 */
async function triageRung(input: RungExecInput): Promise<RungExecResult> {
	const {item, context} = input;
	const note = context.note ?? (() => {});
	const cwd = context.cwd;

	// SETTLED GUARD: a `triaged:` frontmatter marker means a human already
	// dispositioned this observation, so it DROPS OUT of the triage pool. The pool
	// enumeration already excludes it, but an EXPLICIT `obs:<slug>` bypasses the pool
	// gate and still classifies as `triage-observation` — so re-check the marker here
	// and no-op rather than surfacing a FRESH triage question on an already-settled
	// note. (Replaces the old `detectObservationLimbo` special-case: there is no
	// limbo any more — an UNtriaged observation always surfaces the deterministic
	// question below; a SETTLED one is a calm no-op here.)
	//
	// SECOND ARM — the LEGACY back-fill (ADR
	// `resolve-settles-the-question-loop-not-the-note`): a note the apply rung
	// resolved-and-KEPT before it learned to stamp the marker carries the
	// ENGINE-WRITTEN `## Applied answers` record but NO marker, which is the exact
	// shape this rung would re-ask forever. That record is PROOF the engine already
	// applied a human's answers to this note, so we stamp what the apply rung would
	// have written and no-op. Self-healing and one-shot: the stamped note drops out
	// of the pool, so this arm can never fire twice for the same note.
	{
		const itemRel = findItemPath(cwd, input.namespace, input.slug);
		if (itemRel !== undefined) {
			const body = readFileSync(join(cwd, itemRel), 'utf8');
			const fm = parseFrontmatter(body);
			if (fm.triaged !== undefined && fm.triaged !== '') {
				return {
					exitCode: 0,
					outcome: 'no-op',
					message: `triage ${item}: already triaged (triaged:${fm.triaged}) — nothing to do.`,
				};
			}
			if (hasAppliedAnswersRecord(body)) {
				const stamp = context.stampTriaged ?? stampTriagedMarker;
				const result = stamp({
					cwd,
					item,
					itemPath: itemRel,
					value: TRIAGED_RESOLVE,
					reason:
						'Back-filled: the note carries an engine-written applied-answers ' +
						'record, so its triage question-loop was already settled by a human ' +
						'answer before the apply rung stamped the marker.',
					note,
				});
				return {exitCode: 0, outcome: 'no-op', message: result.message};
			}
		}
	}

	// The CONSERVATIVE auto-disposition EXCEPTION — ONLY under `observationTriage:
	// 'auto'`. Under `'ask'`/`'off'`/unset (including `off` + an EXPLICIT obs:<slug>
	// that bypassed the selection gate), EVERY untriaged observation surfaces the
	// question (the always-allowed path), so "worth building?" is never decided
	// autonomously — `off` + explicit runs in the conservative `ask`-mode.
	if (context.observationTriage === 'auto') {
		const itemPath = findItemPath(cwd, input.namespace, input.slug);
		if (itemPath === undefined) {
			return vanishedSkip({rung: 'triage', item});
		}
		const gate = context.triageGate ?? harnessTriageGate();
		let decision;
		try {
			decision = await gate({item, cwd, triageModel: context.triageModel});
		} catch (err) {
			// A gate failure is NOT a reason to auto-dispose — fall back to the SAFE
			// question-gated path (surface the question), never the reverse.
			const detail = err instanceof Error ? err.message : String(err);
			note(
				`triage ${item}: the auto-triage gate produced no usable emit (${detail}); ` +
					'falling back to the question-gated surface path.',
			);
			decision = {auto: false as const};
		}
		if (decision.auto === true) {
			// A no-question case (duplicate / map) — auto-disposition WITHOUT a
			// question. BOTH discharge the redundant note BY DELETION (a duplicate is a
			// redundant copy; a map is already covered by the item it maps onto), so an
			// AUTO disposition never RESTS a note — resting a KEPT note is the
			// human-answered `resolve` verdict's job on the apply rung. NEVER auto-deletes
			// a NON-redundant signal; NEVER auto-promotes.
			const dispose = context.autoDisposition ?? autoDispositionObservation;
			const result = dispose({
				cwd,
				item,
				itemPath,
				kind: decision.kind,
				existing: decision.existing,
				reason: decision.reason,
				note,
			});
			return {exitCode: 0, outcome: 'advanced', message: result.message};
		}
		// `auto: false` ⇒ a judgement call. Fall through to the surface question.
	}

	// DEFAULT (question-gated): surface a PLAIN "what becomes of this signal?"
	// question + WAIT. This REUSES the surface rung verbatim (the `surface-questions`
	// skill emits the triage question — NO disposition token any more, task
	// `agentic-apply-retire-disposition-vocabulary`); the AGENTIC apply decision
	// reads the human's answer + source and decides what to DO when it is answered.
	//
	// ALWAYS-ASK (the "no limbo" contract): pass the DETERMINISTIC triage question as
	// the base question, so an untriaged observation ALWAYS surfaces it (q1) even if
	// the `surface-questions` agent emits empty or flakes. The agent is ADDITIVE:
	// any pointed questions it extracts from the body are appended after q1.
	return surfaceRung(input, {baseQuestions: [buildTriageBaseQuestion()]});
}

/**
 * The APPLY rung BODY (task `advance-rung-apply`; AGENTIC apply, task
 * `agentic-apply-retire-disposition-vocabulary`): when the classifier says `apply`
 * (ALL sidecar entries answered), apply the HUMAN's answers.
 *
 * For a fully-answered OBSERVATION (and no caller-supplied follow-up batch), the
 * apply rung is now AGENT-DRIVEN: it runs the shared `decide(input, allowedOutcomes)`
 * engine ({@link decide}) over `(the answered question(s) + the SOURCE item + its
 * type/context)` via the injected {@link ApplyDecider}, allowing the set
 * `{task | spec | adr | dispose | resolve | ask}` (= `{mint-task | mint-spec |
 * mint-adr | dispose-source | resolve-no-mint | ask-follow-up}`; `adr` is now WIRED
 * by task
 * `agentic-apply-mint-adr-route`, which added the {@link mintAdr} route). The
 * verdict ROUTES:
 *   - `ask` → the EXISTING append/re-pause loop ({@link applyAnsweredQuestions}
 *     with the follow-up appended; `needsAnswers:true` stays, re-pause in one
 *     commit);
 *   - `adr` → {@link mintAdr} (mint a SELF-CONTAINED ADR into `docs/adr/` + `git
 *     rm` the source + sidecar in the SAME atomic commit; the SIBLING route for the
 *     off-board target);
 *   - `task` / `spec` → {@link promoteObservation} (mint a SELF-CONTAINED artifact +
 *     `git rm` the source + sidecar in the SAME atomic commit); the artifact type
 *     comes from the agent's VERDICT, NOT a human `promote-*` field;
 *   - `resolve` → {@link applyAnsweredQuestions} resolve-fully (harvest answers
 *     into the body, clear `needsAnswers`, delete the sidecar; the note is
 *     RETAINED — the sibling of `dispose` that mints nothing but keeps the note);
 *   - `dispose` → {@link applyAnsweredQuestions} regime-polymorphic disposal
 *     (task `apply-disposition-delete-to-dispose-regime-polymorphic`, spec
 *     `surface-stuck-as-questions-and-retire-stuck-lock-state` decision #5): an
 *     OBSERVATION is `git rm`-ed in one revertible commit (notes leave by
 *     deletion; reason in the message); a TASK is `git mv`-ed to
 *     `tasks/cancelled/` (RETAINED, `reason:` written into the moved body); a
 *     SPEC is `git mv`-ed to `specs/dropped/` (RETAINED). Making `dispose`
 *     polymorphic (rather than a literal `delete`) makes "a task cannot be
 *     hard-deleted by the apply rung, only disposed to its terminal" true BY
 *     CONSTRUCTION.
 *
 * For a TASK/SPEC (answering its OWN open questions) or a caller-supplied follow-up
 * batch, it delegates straight to {@link applyAnsweredQuestions} (resolve fully /
 * re-pause) — the lifecycle path is untouched (a task/spec is dropped by its own
 * lifecycle, not by a question answer).
 *
 * Under the `advancing` CAS lock (held by {@link performAdvance} BEFORE this runs
 * — so the work is POST-lock, winner-only). ALWAYS allowed (no gate). NEVER
 * invents an answer — it applies ONLY the human-authored `answer:` text; a
 * subset-answered sidecar is not even classified `apply` (the classifier NO-OPs),
 * asserted in the persist.
 */
async function applyRung(input: RungExecInput): Promise<RungExecResult> {
	const {item, context} = input;
	const note = context.note ?? (() => {});
	const cwd = context.cwd;

	const itemPath = findItemPath(cwd, input.namespace, input.slug);
	if (itemPath === undefined) {
		return vanishedSkip({rung: 'apply', item});
	}

	// RUNNER-ACTION KIND-CHECK (task `apply-rung-merge-disposition`, spec
	// `land-time-reverify-and-parallel-merge-ceiling`): an answered `kind: merge`
	// sidecar entry is a DETERMINISTIC land action, NOT a content decision. It
	// dispatches HERE (a sibling of the agentic `decide()`), keyed off the
	// question kind + the human's plain `merge | hold | drop` answer, BEFORE the
	// agentic decider runs. The dispatcher invokes the EXISTING land primitive
	// (`performIntegration` with `committedRecovery: true` + `freshWorktreeGate:
	// true`) through the EXISTING per-job worktree seam (`workspace.ts`
	// `createJob` off the hub mirror) — it does NOT re-implement rebase / verify
	// / advance and does NOT improvise a worktree or clone.
	const mergeRoute = await maybeRunMergeAction(input, itemPath);
	if (mergeRoute !== undefined) {
		return mergeRoute;
	}

	// RUNNER-ACTION KIND-CHECK for `kind: 'stuck'` (task
	// `apply-resolve-reset-flag-discards-work-branch`, spec
	// `surface-stuck-as-questions-and-retire-stuck-lock-state` decision #6): a
	// bounced TASK surfaces as a `kind: 'stuck'` question; the human's plain
	// `keep | reset | cancel` answer drives one of the three deterministic
	// verbs. The DIRECT SIBLING of `maybeRunMergeAction` above (there is NO
	// agentic decider on the TASK apply path — `runAgenticDecision` fires only
	// for observations — so a bounced task's answer MUST be sourced from a
	// deterministic parse+dispatch, not a widened decider). `keep` and `reset`
	// fall through to the normal fall-through persist (with the branch
	// pre-deleted on `reset` via the SHARED
	// `deleteRemoteWorkBranchIfPresent`); `cancel` dispatches through
	// `applyAnsweredQuestions`' `dispose` option (task →
	// `tasks/cancelled/`); `refused` short-circuits with the sidecar left in
	// place for a re-answer.
	const stuckRoute = await maybeRunStuckAction(input, itemPath);
	if (stuckRoute !== undefined) {
		return stuckRoute;
	}

	// AGENTIC APPLY for an answered OBSERVATION (the subsumed triage rung): run the
	// shared decision engine over the answer(s) + source, route the verdict. A
	// caller-supplied follow-up batch (`applyFollowups`) bypasses the decision and
	// re-pauses directly (a test/driver hook). TASK/SPEC items resolve in place
	// (their own lifecycle), so they skip the decision and fall through to the
	// persist below.
	const runAgenticDecision =
		input.namespace === 'observation' &&
		!(context.applyFollowups && context.applyFollowups.length > 0);
	if (runAgenticDecision) {
		return applyAgenticDecision(input, itemPath);
	}

	const apply = context.applyPersist ?? applyAnsweredQuestions;
	try {
		const result = apply({
			cwd,
			item,
			itemPath,
			appendQuestions: context.applyFollowups,
			note,
		});
		// Map the apply persist's outcome to the rung's outcome. `vanished` is the
		// F3a clean-exit case (item was gone between capture and write, e.g. a
		// concurrent promote); benign skip, exitCode 0, distinct from `no-op`.
		const mapped: AdvanceOutcome =
			result.outcome === 'repaused'
				? 'no-op'
				: result.outcome === 'vanished'
					? 'vanished'
					: 'advanced';
		return {
			exitCode: 0,
			outcome: mapped,
			message: result.message,
		};
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			exitCode: 1,
			outcome: 'usage-error',
			message: `apply ${item}: ${detail}`,
		};
	}
}

/**
 * Dispatch an answered MERGE-QUESTION (a sidecar entry stamped `kind: merge` by
 * the merge-question surfacer) through the EXISTING land primitive
 * (`performIntegration` with `committedRecovery: true` + `freshWorktreeGate:
 * true`) via the EXISTING per-job worktree seam (`workspace.ts` `createJob`).
 * The deterministic SIBLING of the agentic `decide()` content-decision (SPEC
 * `land-time-reverify-and-parallel-merge-ceiling`, task
 * `apply-rung-merge-disposition`; Stories #15, #16): a merge-acceptance has no
 * judgement content (the human's plain `merge | hold | drop` answer IS the
 * decision; the apply-time re-verify on the rebased tip is the real correctness
 * gate), so the apply rung KIND-CHECKS the sidecar BEFORE the agentic decider.
 *
 * Returns `undefined` when there is no answered `kind: merge` entry to dispatch
 * (the apply rung then proceeds to the existing path — agentic for
 * observations, normal `applyAnsweredQuestions` for task/spec content questions).
 * Returns a {@link RungExecResult} when the dispatcher handled the rung:
 *
 *   - `landed` / `already-integrated` ⇒ the kept commit landed on `main` (or
 *     was already there); the dispatcher FALLS THROUGH to the normal apply path
 *     so the answer is recorded in the item body + the sidecar is resolved.
 *   - `refused` ⇒ the LAND was refused (RED re-verify on the rebased tip,
 *     rebase conflict, or pre-checkout failure); `performIntegration` routed
 *     the item to needs-attention through its own shared seam, so `main` never
 *     received a failing tree. The apply rung SHORT-CIRCUITS — the sidecar is
 *     LEFT IN PLACE so the open answer stays surfaced for a human follow-up.
 *   - `restale` ⇒ `strictMergeApproval` was ON and the merge-base moved
 *     between the surfacer's question and this apply; the apply rung appends
 *     a follow-up question + re-pauses (the human re-confirms against the new
 *     base).
 *   - `hold` / `drop` ⇒ no land; fall through to the normal apply path so the
 *     answer is recorded in body. The branch stays unmerged; a future
 *     surfacer pass may re-emit a merge-question.
 */
async function maybeRunMergeAction(
	input: RungExecInput,
	itemPath: string,
): Promise<RungExecResult | undefined> {
	const {item, context} = input;
	const cwd = context.cwd;
	const note = context.note ?? (() => {});

	const detected = detectAnsweredMergeAction(cwd, item);
	if (detected === undefined) return undefined;

	const handler = context.mergeAction ?? performMergeAction;

	// The dispatcher needs a `workspacesDir` to cut a per-job worktree (the
	// `createJob` seam). When unset (a caller that has not threaded it) we
	// REFUSE cleanly rather than guess: a land without isolation is not the
	// shape this dispatcher promises.
	const workspacesDir = context.workspacesDir;
	if (workspacesDir === undefined && context.mergeAction === undefined) {
		const message =
			`apply ${item}: answered merge-question detected (kind=merge, answer=` +
			`${detected.verb}) but no \`workspacesDir\` is threaded into the apply ` +
			`rung — the dispatcher needs one to cut the per-job worktree via ` +
			`\`workspace.ts\` \`createJob\`. NOT landing; the answer stays surfaced.`;
		note(message);
		return {exitCode: 1, outcome: 'usage-error', message};
	}

	let result: MergeActionResult;
	try {
		result = await handler({
			action: detected,
			item,
			slug: input.slug,
			cwd,
			arbiter: context.arbiter ?? DEFAULT_ARBITER,
			arbiterUrl: context.arbiterUrl,
			workspacesDir: workspacesDir ?? '',
			prepare: context.prepare,
			verify: context.verify,
			strictMergeApproval: context.strictMergeApproval,
			note,
		});
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		const message =
			`apply ${item}: answered merge-question dispatch raised (${detail}); NOT ` +
			`landing; the answer stays surfaced.`;
		note(message);
		return {exitCode: 1, outcome: 'usage-error', message};
	}

	if (result.outcome === 'refused') {
		// `main` never received a failing tree (performIntegration routed the
		// bounce to needs-attention through its own shared seam). SHORT-CIRCUIT:
		// leave the sidecar so the open answer stays surfaced — the apply rung
		// MUST NOT also resolve it (the next surfacer / human will follow up).
		// Outcome tag `merge-refused` (task `merge-action-nits-followup` nit 2):
		// distinct from `usage-error` — which is reserved for genuine caller-usage
		// errors (e.g. the workspacesDir-unset guard above) — so reviewers can
		// grep the refusal-on-rebased-tip signal without confusing it with a
		// misuse. `exitCode: 1` preserved.
		note(result.message);
		return {exitCode: 1, outcome: 'merge-refused', message: result.message};
	}

	if (result.outcome === 'restale') {
		// `strictMergeApproval` re-surface: append a follow-up question and
		// re-pause. The previous answer stays recorded in the entry; the human
		// re-confirms against the new merge-base in the appended question.
		const apply = context.applyPersist ?? applyAnsweredQuestions;
		try {
			const applied = apply({
				cwd,
				item,
				itemPath,
				appendQuestions: [
					{
						question:
							`Merge-base for \`work/${input.slug}\` moved since your last ` +
							`answer (strictMergeApproval is ON). Re-confirm: still land?`,
						context: result.message,
						default: 'merge | hold | drop',
						kind: 'merge',
					},
				],
				note,
			});
			return {
				exitCode: 0,
				outcome: 'no-op',
				message: applied.message,
			};
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			return {
				exitCode: 1,
				outcome: 'usage-error',
				message: `apply ${item}: re-surfacing the merge-question failed (${detail}).`,
			};
		}
	}

	// landed | already-integrated | hold | drop: the dispatcher's action is
	// done; FALL THROUGH to the normal apply path so the answer is recorded in
	// the item body + the sidecar is resolved.
	note(result.message);
	const apply = context.applyPersist ?? applyAnsweredQuestions;
	try {
		const applied = apply({cwd, item, itemPath, note});
		const mapped: AdvanceOutcome =
			applied.outcome === 'repaused'
				? 'no-op'
				: applied.outcome === 'vanished'
					? 'vanished'
					: 'advanced';
		return {
			exitCode: 0,
			outcome: mapped,
			message: `${result.message} ${applied.message}`,
		};
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			exitCode: 1,
			outcome: 'usage-error',
			message: `apply ${item}: ${detail}`,
		};
	}
}

/**
 * Dispatch an answered STUCK-QUESTION (a sidecar entry stamped `kind: 'stuck'`
 * by the bounce-surface path) through the deterministic
 * {@link performStuckAction} sibling. The DIRECT SIBLING of
 * {@link maybeRunMergeAction} for the `kind: 'stuck'` axis (task
 * `apply-resolve-reset-flag-discards-work-branch`, spec
 * `surface-stuck-as-questions-and-retire-stuck-lock-state` decision #6):
 *
 *   - `keep`   -> fall through to today's normal `applyAnsweredQuestions`
 *                 resolve (branch untouched; continue-from-WIP);
 *   - `reset`  -> the SHARED `deleteRemoteWorkBranchIfPresent` primitive
 *                 discards the remote `work/task-<slug>` FIRST, then the
 *                 normal fall-through persist clears `needsAnswers`. Safely
 *                 IDEMPOTENT when no branch exists (an item never built) —
 *                 an `already-gone` push is tolerated as a no-op;
 *   - `cancel` -> fall through to the normal persist with the `dispose`
 *                 option (`git mv -> tasks/cancelled/`), the answer text
 *                 recorded as the human's reason;
 *   - `refused` -> a REAL push-delete failure aborted the discard;
 *                  SHORT-CIRCUIT with the sidecar left in place so the human
 *                  sees the failure and re-answers (matches the
 *                  `requeue --reset` abort-on-failed-delete contract).
 *
 * Returns `undefined` when no answered `kind: 'stuck'` entry is present (the
 * apply rung then proceeds to the existing path — an unrelated content
 * question falls through to the normal `applyAnsweredQuestions` /
 * agentic-decider path).
 */
async function maybeRunStuckAction(
	input: RungExecInput,
	itemPath: string,
): Promise<RungExecResult | undefined> {
	const {item, context} = input;
	const cwd = context.cwd;
	const note = context.note ?? (() => {});

	const detected = detectAnsweredStuckAction(cwd, item);
	if (detected === undefined) return undefined;

	const handler = context.stuckAction ?? performStuckAction;

	let result: StuckActionResult;
	try {
		result = await handler({
			action: detected,
			item,
			slug: input.slug,
			cwd,
			arbiter: context.arbiter ?? DEFAULT_ARBITER,
			note,
		});
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		const message =
			`apply ${item}: answered stuck-question dispatch raised (${detail}); NOT ` +
			`clearing needsAnswers; the sidecar stays surfaced.`;
		note(message);
		return {exitCode: 1, outcome: 'usage-error', message};
	}

	if (result.outcome === 'refused') {
		// The arbiter delete FAILED (not `already-gone`); we MUST NOT clear
		// needsAnswers, because that would leave the item claimable while still
		// carrying the WIP branch we meant to discard — the very stale-continue
		// trap the `requeue --reset` path guards against. Leave the sidecar in
		// place for a re-answer.
		note(result.message);
		return {exitCode: 1, outcome: 'usage-error', message: result.message};
	}

	note(result.message);
	const apply = context.applyPersist ?? applyAnsweredQuestions;
	try {
		const applyOptions: ApplyAnsweredQuestionsOptions = {
			cwd,
			item,
			itemPath,
			note,
		};
		if (result.outcome === 'cancel') {
			// The human's answer text is the dispose reason (verbatim), so the
			// terminal `tasks/cancelled/` body records WHY — the same reason
			// contract the agentic `dispose` verdict uses.
			applyOptions.dispose = {reason: detected.entry.answer.trim()};
		}
		const applied = apply(applyOptions);
		const mapped: AdvanceOutcome =
			applied.outcome === 'repaused'
				? 'no-op'
				: applied.outcome === 'vanished'
					? 'vanished'
					: 'advanced';
		return {
			exitCode: 0,
			outcome: mapped,
			message: `${result.message} ${applied.message}`,
		};
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			exitCode: 1,
			outcome: 'usage-error',
			message: `apply ${item}: ${detail}`,
		};
	}
}

/**
 * The cross-tick-window BENIGN SKIP shared by all three rungs that need to
 * resolve an item file (surface / triage / apply). The lifecycle pool enumerated
 * the item at scan-time, but by the time this leg ran a sibling parallel leg had
 * already triaged/settled/deleted it. At the ~33-way CI matrix scale this is a
 * CALM, EXPECTED condition — making it an exit-1 "a human must reconcile" turned
 * the matrix into a wall of red. It is now a `vanished` outcome (`exitCode: 0`,
 * distinguishable from `no-op`) carrying a clear message naming the rung + item.
 * (See task `observation-identity-is-its-filename-not-a-foreign-slug`.)
 */
function vanishedSkip(input: {
	rung: 'surface' | 'triage' | 'apply';
	item: string;
}): RungExecResult {
	return {
		exitCode: 0,
		outcome: 'vanished',
		message:
			`advance classified the '${input.rung}' rung for ${input.item} but its ` +
			`item file was gone from work/ by the time the leg ran (a sibling leg ` +
			`likely triaged/settled/deleted it between enumerate and run) — benign ` +
			`skip.`,
	};
}

/**
 * Find the item file `work/<folder>/<slug>.md` for a type, across the lifecycle
 * folders it may rest in (the SAME folder set {@link readNeedsAnswers} searches).
 * Returns the path RELATIVE to `cwd`, or `undefined` when no file exists.
 */
function findItemPath(
	cwd: string,
	namespace: SlugNamespace,
	slug: string,
): string | undefined {
	const type = sidecarTypeFor(namespace);
	for (const folder of FOLDERS_FOR_TYPE[type]) {
		const rel = workItemRel(folder, `${slug}.md`);
		if (existsSync(join(cwd, rel))) {
			return rel;
		}
	}
	return undefined;
}

/**
 * The AGENTIC apply DECISION for a fully-answered OBSERVATION (task
 * `agentic-apply-retire-disposition-vocabulary`): run the shared
 * `decide(input, allowedOutcomes)` engine over the answer(s) + source, then ROUTE
 * the verdict. The artifact-type selection (task vs spec) comes from the agent's
 * VERDICT, NOT a human `promote-*` field (which is retired). Replaces the old
 * `answeredPromoteArtifact` + disposition picker.
 *
 *   - `ask` → append the follow-up question(s) + re-pause (the EXISTING loop, via
 *     {@link applyAnsweredQuestions}'s `appendQuestions`);
 *   - `task` / `spec` → {@link promoteObservation} (mint self-contained + delete
 *     source in the same atomic commit);
 *   - `adr` → {@link mintAdr} (mint a self-contained ADR into `docs/adr/` + delete
 *     source in the same atomic commit; the SIBLING route for the off-board target,
 *     task `agentic-apply-mint-adr-route`);
 *   - `resolve` → {@link applyAnsweredQuestions}'s resolve-fully path (harvest the
 *     answers into `## Applied answers`, strip the open-questions block, clear
 *     `needsAnswers`, DELETE the sidecar — the note is RETAINED). The sibling of
 *     `dispose` that KEEPS the note instead of moving/rm-ing it (task
 *     `apply-decide-resolve-verdict-mint-nothing`);
 *   - `dispose` → {@link applyAnsweredQuestions}'s regime-polymorphic disposal
 *     (task `apply-disposition-delete-to-dispose-regime-polymorphic`): an
 *     observation is `git rm`-ed in one revertible commit (reason in the
 *     message); a task is `git mv`-ed to `tasks/cancelled/` (reason written into
 *     the body); a spec is `git mv`-ed to `specs/dropped/`.
 *
 * The allowed set is `{task | spec | adr | dispose | resolve | ask}`; a verdict
 * outside it is
 * rejected by the engine's allowed-outcome guard ({@link DisallowedOutcomeError})
 * and mapped onto a usage-error — never dispatched.
 */
async function applyAgenticDecision(
	input: RungExecInput,
	itemPath: string,
): Promise<RungExecResult> {
	const {item, context} = input;
	const note = context.note ?? (() => {});
	const cwd = context.cwd;

	const decisionInput = buildApplyDecisionInput({
		item,
		type: sidecarTypeFor(input.namespace),
		itemPath,
		cwd,
		model: context.applyModel,
	});
	if (decisionInput === undefined) {
		// No sidecar / item to decide over (a sibling leg removed it between classify
		// and run) — the same benign clean-exit the persist's vanished branch gives.
		return vanishedSkip({rung: 'apply', item});
	}

	const decider = context.applyDecide ?? harnessApplyDecider();
	let verdict: DecisionVerdict;
	try {
		verdict = await decide(decisionInput, decider, APPLY_ALLOWED_OUTCOMES);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		// A DisallowedOutcomeError (e.g. a stubbed `adr` verdict) and an agent-failed
		// parse both degrade HONESTLY onto a usage-error — never a silent dispatch.
		const label =
			err instanceof DisallowedOutcomeError
				? `apply ${item}: the decision verdict is not an allowed outcome (${detail})`
				: `apply ${item}: the decision agent produced no usable verdict (${detail})`;
		return {exitCode: 1, outcome: 'usage-error', message: label};
	}

	if (verdict.outcome === 'ask') {
		// ask-follow-up → the EXISTING append/re-pause loop. One BATCH of follow-ups.
		const apply = context.applyPersist ?? applyAnsweredQuestions;
		const question = (verdict.question ?? '').trim();
		if (question === '') {
			return {
				exitCode: 1,
				outcome: 'usage-error',
				message: `apply ${item}: the decision agent chose 'ask' but emitted no follow-up question.`,
			};
		}
		try {
			const result = apply({
				cwd,
				item,
				itemPath,
				appendQuestions: [{question}],
				note,
			});
			return {
				exitCode: 0,
				outcome: result.outcome === 'vanished' ? 'vanished' : 'no-op',
				message: result.message,
			};
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			return {
				exitCode: 1,
				outcome: 'usage-error',
				message: `apply ${item}: ${detail}`,
			};
		}
	}

	if (verdict.outcome === 'task' || verdict.outcome === 'spec') {
		// mint-task / mint-spec → CAS-create a SELF-CONTAINED artifact + delete the
		// source + sidecar in the SAME commit (delete-on-promote, preserved). The
		// verdict's drafted body (when present) seeds the new item; else the writer
		// builds a self-contained body FROM the observation (carrying the answers +
		// open-question scoping). The artifact type is the agent's VERDICT.
		const promote = context.promote ?? promoteObservation;
		const draftedBody =
			verdict.outcome === 'task' ? verdict.taskBody : verdict.specBody;
		const draftedSlug =
			verdict.outcome === 'task' ? verdict.taskSlug : verdict.specSlug;
		try {
			const result = await promote({
				cwd,
				item,
				itemPath,
				artifact: verdict.outcome,
				newSlug: context.promoteSlug ?? draftedSlug,
				...(draftedBody !== undefined && draftedBody.trim() !== ''
					? {stubContent: draftedBody}
					: {}),
				arbiter: context.arbiter,
				// Lifecycle FAN-OUT: widen the CAS contention budget + jitter the retries
				// so N parallel promote legs desync (task
				// `jitter-and-widen-cas-contention-retry-for-lifecycle-fanout`).
				contention: LIFECYCLE_CAS_CONTENTION,
				note,
			});
			return {
				exitCode: result.exitCode,
				outcome:
					result.outcome === 'promoted'
						? 'advanced'
						: result.outcome === 'already-triaged'
							? 'already-triaged'
							: result.outcome === 'lost'
								? 'lost'
								: result.outcome === 'contended'
									? 'contended'
									: 'usage-error',
				message: result.message,
			};
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			return {
				exitCode: 1,
				outcome: 'usage-error',
				message: `apply ${item}: ${detail}`,
			};
		}
	}

	if (verdict.outcome === 'adr') {
		// mint-adr → CAS-create a SELF-CONTAINED ADR into `docs/adr/` + delete the
		// source + sidecar in the SAME commit (delete-on-promote, preserved via the
		// shared create-CAS). An ADR lives OUTSIDE the work board, so this is the
		// SIBLING route (NOT a `promoteObservation` artifact type). The verdict's
		// drafted body (when present) seeds the ADR; else `mintAdr` builds a
		// self-contained body FROM the observation + the answered question(s).
		const mint = context.mintAdr ?? mintAdr;
		const answers = decisionInput.sidecar.entries.map((e) => ({
			question: e.question,
			answer: e.answer,
		}));
		try {
			const result = await mint({
				cwd,
				item,
				itemPath,
				adrSlug: context.promoteSlug ?? verdict.adrSlug,
				...(verdict.adrTitle !== undefined ? {adrTitle: verdict.adrTitle} : {}),
				...(verdict.adrBody !== undefined && verdict.adrBody.trim() !== ''
					? {adrBody: verdict.adrBody}
					: {}),
				answers,
				arbiter: context.arbiter,
				// Lifecycle FAN-OUT: widen the CAS contention budget + jitter the retries
				// so N parallel mint-adr legs desync (task
				// `jitter-and-widen-cas-contention-retry-for-lifecycle-fanout`).
				contention: LIFECYCLE_CAS_CONTENTION,
				note,
			});
			return {
				exitCode: result.exitCode,
				outcome:
					result.outcome === 'minted'
						? 'advanced'
						: result.outcome === 'lost'
							? 'lost'
							: result.outcome === 'contended'
								? 'contended'
								: 'usage-error',
				message: result.message,
			};
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			return {
				exitCode: 1,
				outcome: 'usage-error',
				message: `apply ${item}: ${detail}`,
			};
		}
	}

	if (verdict.outcome === 'resolve') {
		// resolve-no-mint → the EXISTING resolve-fully path (task
		// `apply-decide-resolve-verdict-mint-nothing`). The answer SETTLES the item
		// with NOTHING to mint and the note RETAINED: call `applyAnsweredQuestions`
		// with NEITHER `appendQuestions` (re-pause) NOR `dispose` (drop/terminal), so it
		// takes the default resolve-fully branch — harvest the answers into `##
		// Applied answers`, strip the marker-fenced open-questions block, clear
		// `needsAnswers`, and DELETE the sidecar in ONE atomic commit. Invariant-clean
		// (`needsAnswers:false` ⟺ no active sidecar). The note file is KEPT (this is
		// the sibling of `dispose`, which git-rm's it or moves it to a terminal). `resolveReason` is advisory
		// context only; the durable disposition record is the harvested `## Applied
		// answers` block the resolve-fully path writes (NOT a separate convention).
		//
		// Because the note is KEPT, that same commit also stamps `triaged: resolve` on
		// it (ADR `resolve-settles-the-question-loop-not-the-note`): a kept note stays
		// in the inbox the triage rung scans, and without the marker its two
		// classifier signals (`needsAnswers:false`, no sidecar) are IDENTICAL to a note
		// that was never triaged — so the next tick re-surfaced the same engine-built
		// triage question forever. The stamp is done by the persist, not here, so no
		// caller of the resolve-fully path can forget it.
		const apply = context.applyPersist ?? applyAnsweredQuestions;
		try {
			const result = apply({cwd, item, itemPath, note});
			return {
				exitCode: 0,
				outcome: result.outcome === 'vanished' ? 'vanished' : 'advanced',
				message: result.message,
			};
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			return {
				exitCode: 1,
				outcome: 'usage-error',
				message: `apply ${item}: ${detail}`,
			};
		}
	}

	// dispose-source → regime-polymorphic disposal (DIRECT, no confirm — decision
	// 12; task `apply-disposition-delete-to-dispose-regime-polymorphic`, spec
	// `surface-stuck-as-questions-and-retire-stuck-lock-state` decision #5). The
	// human's answer is the source of truth; the persist chooses the on-disk
	// effect by the source's regime: an OBSERVATION is `git rm`-ed in one
	// revertible commit (reason in the message, git history = archive); a TASK is
	// `git mv`-ed to `tasks/cancelled/` (RETAINED, `reason:` written into the
	// moved body); a SPEC is `git mv`-ed to `specs/dropped/` (RETAINED). A task
	// cannot be hard-deleted by the apply rung — dispose is the only path off the
	// board.
	const apply = context.applyPersist ?? applyAnsweredQuestions;
	try {
		const result = apply({
			cwd,
			item,
			itemPath,
			dispose: {reason: verdict.disposeReason ?? ''},
			note,
		});
		return {
			exitCode: 0,
			outcome: result.outcome === 'vanished' ? 'vanished' : 'advanced',
			message: result.message,
		};
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			exitCode: 1,
			outcome: 'usage-error',
			message: `apply ${item}: ${detail}`,
		};
	}
}

/**
 * Run ONE `advance` tick over a SINGLE named item: classify → lock → dispatch →
 * release. The pure tick the drivers (later tasks) wrap. The expensive phase is
 * ALWAYS post-lock — a CAS loser backs off having done ONLY the free
 * classification (it never reaches the executor).
 */
export async function performAdvance(
	options: AdvanceOptions,
): Promise<AdvanceResult> {
	const note = options.note ?? (() => {});
	const cwd = options.cwd;
	const repoPath = options.repoPath ?? cwd;
	const arbiter = options.arbiter ?? DEFAULT_ARBITER;

	// {@link performAdvance} is the SINGLE-item tick. The bare `advance`
	// (eligible-SET) form is the DRIVER's job ({@link performAdvanceAuto} in
	// `advance-drivers.ts`, which selects over the pool + runs THIS tick per item) —
	// the tick itself REQUIRES a named item, so an empty arg here is a usage error
	// (the CLI dispatches the bare form to the driver before reaching here).
	if (options.arg === undefined || options.arg.trim() === '') {
		const message =
			'`advance` with no item is the eligible-SET form (the one-shot driver). ' +
			'The single-item tick needs a named item: ' +
			'`advance <slug>` / `advance spec:<slug>` / `advance obs:<slug>`.';
		note(message);
		return {exitCode: 1, outcome: 'usage-error', message};
	}

	// 1. RESOLVE the arg via the SHARED resolver (extended with `obs:`). `advance`
	//    spans task / spec / observation; a collision / bad arg is a loud usage error.
	let resolved;
	try {
		resolved = resolveAdvanceArg({
			arg: options.arg,
			repoPath,
			read: options.read ?? ledgerRead,
		});
	} catch (err) {
		if (err instanceof SlugResolutionError) {
			return {exitCode: 1, outcome: 'usage-error', message: err.message};
		}
		const message = err instanceof Error ? err.message : String(err);
		return {exitCode: 1, outcome: 'usage-error', message};
	}

	const type = sidecarTypeFor(resolved.namespace);
	const item = `${resolved.namespace}:${resolved.slug}`;

	// 2. CLASSIFY — read-only, NO model, NO lock. Read the two signals + run the
	//    pure classifier. This is the ONLY work a CAS loser will have spent.
	const readSignals = options.readSignals ?? readItemSignals;
	const signals = readSignals({repoPath, type, slug: resolved.slug, item});
	const classification = classifyTick({
		type,
		needsAnswers: signals.needsAnswers,
		sidecar: signals.sidecar,
	});

	// A NO-OP (pending sidecar / nothing eligible) or an invariant violation never
	// takes the lock — there is nothing to execute, so do NOT pay the CAS.
	if (classification.kind === 'no-op') {
		const message = `no-op for ${item} (${classification.reason ?? 'nothing to advance'}).`;
		note(message);
		return {
			exitCode: 0,
			outcome: 'no-op',
			rung: 'no-op',
			slug: resolved.slug,
			message,
		};
	}
	if (classification.kind === 'invariant-violation') {
		const message =
			`refusing to advance ${item}: the \`needsAnswers\` flag and the sidecar ` +
			`disagree (${classification.reason ?? 'invariant violation'}). ` +
			`A human must reconcile them.`;
		note(message);
		return {
			exitCode: 1,
			outcome: 'invariant-violation',
			rung: 'invariant-violation',
			slug: resolved.slug,
			message,
		};
	}

	// 3. LOCK — take the `advancing` CAS borrow for the classified rung, keyed on
	//    the item's `<type>-<slug>` identity. The expensive phase is POST-lock.
	//
	//    UNIFIED PER-ITEM LOCK, TREE-LESS RUNGS ONLY (spec
	//    `ledger-status-per-item-lock-refs` US #1/#3/#18; ADR
	//    `ledger-status-on-per-item-lock-refs`). The rung kind is KNOWN here
	//    (`classification.kind`, classified pre-lock), so the tree-less-only policy
	//    lives HERE — where the rung is known — and `advancing-lock.ts` stays
	//    rung-agnostic (it only learns "unified or not" via `acquireUnified`). For a
	//    TREE-LESS rung (`surface`/`apply`/`triage-observation`) the advancing acquire
	//    ALSO takes the item's unified lock (`action: advance`) — these rungs have NO
	//    inner `do`, so the unified hold is what realises advance∥claim / advance∥task
	//    exclusion. For a BUILD-TASK / TASK-SPEC rung we do NOT take the unified lock
	//    at the advance layer: `performAdvance` ORCHESTRATES an inner `performDo` that
	//    ITSELF acquires the SAME `task-<slug>`/`prd-<slug>` ref (the create-only CAS
	//    with NO re-entrancy/auto-steal, per the ADR), so taking it here too would
	//    DEADLOCK the tick against itself. The inner `do`'s claim/task lock IS the
	//    single exclusion point for those rungs. The `work/advancing/<entry>.md` marker
	//    CAS is KEPT for ALL rungs (its removal is the capstone task #9).
	const unifiedForRung = isTreeLessRung(classification.kind);
	const acquire =
		options.acquireLock ??
		((lockItem: string) =>
			acquireAdvancingLock({
				item: lockItem,
				cwd,
				arbiter,
				acquireUnified: unifiedForRung,
				note,
			}));
	const lock = await acquire(item);
	if (lock.exitCode !== 0) {
		// A CAS LOSER (exit 2) or contended (exit 3) backs off having spent ONLY the
		// free classification above — it never reaches the executor.
		return {
			exitCode: lock.exitCode,
			outcome: lock.outcome === 'lost' ? 'lost' : 'contended',
			rung: classification.kind,
			slug: resolved.slug,
			message: lock.message,
		};
	}

	// 4. EXECUTE — WINNER ONLY: dispatch the classified rung to the executor seam,
	//    then ALWAYS release the borrow (the item never moved; release is clean).
	const executor = options.executor ?? defaultRungExecutor;
	const release =
		options.releaseLock ??
		((lockItem: string) =>
			releaseAdvancingLock({
				item: lockItem,
				cwd,
				arbiter,
				releaseUnified: unifiedForRung,
				note,
			}));
	try {
		const exec = await dispatchRung(executor, {
			item,
			namespace: resolved.namespace,
			slug: resolved.slug,
			classification,
			context: {
				cwd,
				arbiter,
				doOptions: options.doOptions,
				doDriver: options.doDriver,
				surfaceGate: options.surfaceGate,
				surfaceModel: options.surfaceModel,
				surfacePersist: options.surfacePersist,
				applyPersist: options.applyPersist,
				applyFollowups: options.applyFollowups,
				applyDecide: options.applyDecide,
				applyModel: options.applyModel,
				observationTriage: options.observationTriage,
				triageGate: options.triageGate,
				triageModel: options.triageModel,
				autoDisposition: options.autoDisposition,
				promote: options.promote,
				mintAdr: options.mintAdr,
				promoteSlug: options.promoteSlug,
				// The answered-merge LAND dispatch context (task
				// `apply-rung-merge-disposition`): threaded into the apply rung's
				// kind-check for a `kind: merge` runner-action.
				workspacesDir: options.workspacesDir,
				arbiterUrl: options.arbiterUrl,
				prepare: options.prepare,
				verify: options.verify,
				strictMergeApproval: options.strictMergeApproval,
				mergeAction: options.mergeAction,
				// The answered-stuck-question dispatch context (task
				// `apply-resolve-reset-flag-discards-work-branch`): threaded into the
				// apply rung's kind-check for a `kind: 'stuck'` runner-action.
				stuckAction: options.stuckAction,
				note,
			},
		});
		return {
			exitCode: exec.exitCode,
			outcome: exec.outcome,
			rung: classification.kind,
			slug: resolved.slug,
			message: exec.message,
		};
	} finally {
		await release(item);
	}
}

/**
 * Is this a TREE-LESS rung (`surface`/`apply`/`triage-observation`) — the rungs
 * that have NO inner `performDo`, so the advancing acquire must ALSO take the
 * unified per-item lock (`action: advance`) to realise advance∥claim / advance∥task
 * exclusion? The build/task rungs (`build-task`/`task-spec`) are the inverse:
 * their inner `do` holds the SAME unified ref, so the advance layer must NOT take
 * it (it would deadlock the tick against itself). `no-op`/`invariant-violation`
 * never reach the lock step. This is the single place the tree-less-only policy
 * is expressed (the rung is known here); `advancing-lock.ts` stays rung-agnostic.
 */
function isTreeLessRung(kind: TickClassification['kind']): boolean {
	return (
		kind === 'surface' || kind === 'apply' || kind === 'triage-observation'
	);
}

/** Dispatch the classified rung to the executor seam (winner-only). */
function dispatchRung(
	executor: RungExecutor,
	input: RungExecInput,
): Promise<RungExecResult> {
	switch (input.classification.kind) {
		case 'build-task':
			return executor.buildTask(input);
		case 'task-spec':
			return executor.taskSpec(input);
		case 'triage-observation':
			return executor.triageObservation(input);
		case 'surface':
			return executor.surface(input);
		case 'apply':
			return executor.apply(input);
		default:
			// `no-op` / `invariant-violation` never reach here (handled pre-lock).
			return Promise.resolve({
				exitCode: 1,
				outcome: 'usage-error',
				message: `unexpected rung kind '${input.classification.kind}' at dispatch.`,
			});
	}
}
