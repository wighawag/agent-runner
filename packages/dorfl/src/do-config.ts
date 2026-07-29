import type {
	Config,
	IntegrationMode,
	MergeQuestions,
	ObservationTriage,
	PartialConfig,
} from './config.js';

/**
 * The CLI flags that select WHICH agent runs and HOW it is launched — shared,
 * verbatim, by `run` and `do`. Both commands offer `--harness`/`--agent-cmd`/
 * `--pi-bin`/`--model`; this is the single place their string→`PartialConfig`
 * mapping lives so there is exactly ONE override path (not a parallel one per
 * command). `cli.ts`'s `runFlagOverrides` and {@link doFlagOverrides} both fold
 * this in.
 */
export interface HarnessFlags {
	agentCmd?: string;
	model?: string;
	/** `--build-model <id>` — the builder-specific model override (falls back to `--model`). */
	buildModel?: string;
	harness?: string;
	piBin?: string;
	/**
	 * The HOST-ONLY root folder under which a job's pi session FILE is generated
	 * (`--sessions-dir`). Forwarded verbatim like `piBin`; the path generator turns
	 * it into `<sessionsDir>/<unique-id>.jsonl` at launch (unset ⇒ pi's per-cwd
	 * default folder).
	 */
	sessionsDir?: string;
}

/**
 * Map the shared harness/adapter flags into a {@link PartialConfig} of overrides
 * — the per-key mapping `run` and `do` both reuse. Only flags actually present
 * contribute (absent flag ⇒ absent key), so the override layer never clobbers a
 * lower precedence source with `undefined`. `--harness` is validated against the
 * `HarnessAdapter` union (an out-of-range value is dropped, matching `run`).
 */
export function harnessFlagOverrides(flags: HarnessFlags): PartialConfig {
	const overrides: PartialConfig = {};
	if (flags.agentCmd !== undefined) {
		overrides.agentCmd = flags.agentCmd;
	}
	if (flags.model !== undefined) {
		overrides.model = flags.model;
	}
	if (flags.buildModel !== undefined) {
		overrides.buildModel = flags.buildModel;
	}
	if (flags.harness === 'null' || flags.harness === 'pi') {
		overrides.harness = flags.harness;
	}
	if (flags.piBin !== undefined) {
		overrides.piBin = flags.piBin;
	}
	if (flags.sessionsDir !== undefined) {
		overrides.sessionsDir = flags.sessionsDir;
	}
	return overrides;
}

/**
 * Build the flag-override `PartialConfig` for the `do` command. This is the FIX
 * for the silent-drop bug: `do` DECLARES `--harness`/`--agent-cmd`/`--pi-bin`/
 * `--model`, so its action MUST thread them into `resolveRepoConfig`'s `flags`
 * — not just `{integration}`. It reuses the SAME per-key mapping `run` uses
 * ({@link harnessFlagOverrides}), then folds in the integrate-time mode (the
 * already-resolved `--merge`/`--propose`, via `integrationFromFlags`) so the
 * full set rides the same precedence chain (flag > env > per-repo > global >
 * default).
 */
export function doFlagOverrides(
	flags: HarnessFlags &
		ReviewFlags &
		TaskerLoopFlags &
		TriageModelFlags &
		FreshWorktreeGateFlags &
		SelectionOrderFlags &
		ObservationTriageFlags &
		SurfaceBlockersFlags &
		MergeQuestionsFlags &
		StrictMergeApprovalFlags &
		NoPRFlags &
		MergeRetriesFlags,
	integration?: IntegrationMode,
): PartialConfig {
	const overrides = {
		...harnessFlagOverrides(flags),
		// `--observation-triage <off|ask|auto>` rides the SAME flag-override chain
		// (flag > env > per-repo > global > default): the observation-inbox gate.
		...observationTriageFlagOverrides(flags),
		// `--surface-blockers`/`--no-surface-blockers` rides the SAME chain: the
		// boolean gate over DECLARED blocked work (the orthogonal peer of
		// `--observation-triage`).
		...surfaceBlockersFlagOverrides(flags),
		// `--merge-questions <off|ask|auto>` rides the SAME flag-override chain
		// (flag > env > per-repo > global > default `ask`): the 3-state gate over
		// the merge-question SURFACER (spec `land-time-reverify-and-parallel-
		// merge-ceiling` Story 17 / task `merge-questions-gate-axis`). SEPARATE
		// axis from `--observation-triage` with a HIGHER default — NEVER rides
		// `--observation-triage`.
		...mergeQuestionsFlagOverrides(flags),
		// `--strict-merge-approval`/`--no-strict-merge-approval` rides the SAME
		// flag-override chain (flag > env > per-repo > global > default `false`):
		// the OPT-IN strictness layered on the OQ6 stale-approval default. SEPARATE
		// axis from `--merge-questions` — the re-surface vs. land branch is
		// `apply-rung-merge-disposition`'s consumer; this only resolves the boolean.
		...strictMergeApprovalFlagOverrides(flags),
		// `--selection-order <order>` rides the SAME flag-override chain (flag > env >
		// per-repo > global > default): a comma-separated value becomes a list (an
		// explicit pool order), otherwise the verbatim string (a preset keyword). The
		// resolver (`select-order.ts`) validates/expands it at selection time.
		...selectionOrderFlagOverrides(flags),
		// Gate 2 (PR/code review) flags ride the SAME flag-override path so
		// `--review`/`--review-model`/`--review-max-rounds` resolve
		// flag > env > per-repo > global > default, exactly like the harness flags.
		...reviewFlagOverrides(flags),
		// The tasker IMPROVER-loop family (`--tasker-loop`/`--no-tasker-loop`/
		// `--tasker-loop-max`/`--tasker-loop-model`) rides the same chain — a DISTINCT
		// family from the gate's `--review*`, never sharing a flag/key/field name.
		// The flag fields bridge onto the `taskerLoop*` config keys.
		...taskerLoopFlagOverrides(flags),
		// `--triage-model <id>` (the advance lifecycle gates' model — surface, apply,
		// triage) rides the SAME chain. DISTINCT from `--review-model`/
		// `--tasker-loop-model`; falls back to `model` when unset at all levels.
		...triageModelFlagOverrides(flags),
		// `--fresh-worktree-gate`/`--no-fresh-worktree-gate` (run the acceptance gate
		// against the REBASED tip in a clean throwaway worktree, ON by default) rides
		// the SAME chain — a DISTINCT family from `--review*`/`--tasker-loop*`.
		...freshWorktreeGateFlagOverrides(flags),
		// `--no-pr` (the PR-INTENT axis): suppress the PR even on an authed GitHub
		// arbiter. Rides the SAME flag > env > per-repo > global > default chain.
		...noPRFlagOverrides(flags),
		// `--merge-retries <n>` (the cross-job merge serialiser's CAS-retry cap — spec
		// `land-time-reverify-and-parallel-merge-ceiling` Story 5 / Applied Answer
		// q1 (a)) rides the SAME chain (flag > env > per-repo > global > default).
		...mergeRetriesFlagOverrides(flags),
	};
	if (integration !== undefined) {
		// An explicit `--merge`/`--propose` flag ALWAYS wins for the transition this
		// command runs. `do` runs EITHER the build transition (a task) OR the tasking
		// transition (a `do spec:`) per invocation, and the typed flag is
		// transition-AGNOSTIC, so it must override BOTH the build mode (`integration`)
		// AND the tasking mode (`taskingIntegration`). Setting both at the top of the
		// precedence chain means a `--propose` on a `taskingIntegration:'merge'` repo
		// proposes the tasking too (the tasking path reads `taskingIntegration ??
		// integration`, and the flag-set `taskingIntegration` shadows the config one).
		// (`per-transition-integration-mode-slicing-vs-build`.)
		overrides.integration = integration;
		overrides.taskingIntegration = integration;
	}
	return overrides;
}

/**
 * The Gate-2 (PR/code review) CLI flags, offered by `do` AND `complete`
 * (`--review`/`--no-review`, `--review-model`, `--review-max-rounds`). Both commands resolve them through
 * the SAME `flag > env > per-repo > global > default` chain as `integration`, so
 * the mapping lives in ONE place (not a parallel copy per command).
 */
export interface ReviewFlags {
	/** `--review` ⇒ true, `--no-review` ⇒ false, absent ⇒ undefined. */
	review?: boolean;
	/** `--review-model <id>` — the de-correlated review model (routing intent). */
	reviewModel?: string;
	/** `--review-max-rounds <n>` — the revise↔review loop bound (parsed to a number). */
	reviewMaxRounds?: string;
}

/**
 * The tasker IMPROVER-loop CLI flags (`do` only): `--tasker-loop` /
 * `--no-tasker-loop` (the on/off toggle), `--tasker-loop-max <n>` (the in-context
 * convergence cap), and `--tasker-loop-model <id>` (the loop reviewer's
 * de-correlated model). A DISTINCT family from the acceptance gate's `--review*`
 * (see {@link ReviewFlags}) — no flag/key/field name spans both. Resolved through
 * the SAME `flag > env > per-repo > global > default` chain.
 *
 * NOTE the flag NAMES are tasking-vocabulary (`--tasker-loop*`, so commander
 * populates the `taskerLoop*` fields below), and they resolve into the
 * `taskerLoop*` CONFIG KEYS, so {@link taskerLoopFlagOverrides} bridges the
 * flag fields onto the config keys.
 */
export interface TaskerLoopFlags {
	/** `--tasker-loop` ⇒ true, `--no-tasker-loop` ⇒ false, absent ⇒ undefined. */
	taskerLoop?: boolean;
	/** `--tasker-loop-max <n>` — the loop's in-context convergence cap (parsed to a number). */
	taskerLoopMax?: string;
	/** `--tasker-loop-model <id>` — the loop reviewer's de-correlated model (routing intent). */
	taskerLoopModel?: string;
}

/**
 * Map the Gate-2 review flags into a {@link PartialConfig} of overrides — the
 * per-key mapping `do` and `complete` both reuse. Only flags actually present
 * contribute (absent flag ⇒ absent key), so the override layer never clobbers a
 * lower-precedence source with `undefined`. `--review-max-rounds` is parsed to a
 * number; a non-numeric value is dropped (the lower layer / default decides).
 */
export function reviewFlagOverrides(flags: ReviewFlags): PartialConfig {
	const overrides: PartialConfig = {};
	if (flags.review !== undefined) {
		overrides.review = flags.review;
	}
	if (flags.reviewModel !== undefined) {
		overrides.reviewModel = flags.reviewModel;
	}
	if (flags.reviewMaxRounds !== undefined) {
		const n = Number(flags.reviewMaxRounds);
		if (flags.reviewMaxRounds.trim() !== '' && !Number.isNaN(n)) {
			overrides.reviewMaxRounds = n;
		}
	}
	return overrides;
}

/**
 * Map the tasker IMPROVER-loop flags into a {@link PartialConfig} of overrides.
 * Only flags actually present contribute (absent flag ⇒ absent key), so the
 * override layer never clobbers a lower-precedence source with `undefined`.
 * `--tasker-loop-max` is parsed to a number; a non-numeric value is dropped (the
 * lower layer / default decides). A DISTINCT family from {@link reviewFlagOverrides}.
 *
 * The tasking-vocabulary FLAG fields (`taskerLoop*`) bridge onto the
 * `taskerLoop*` CONFIG KEYS, so the operator types `--tasker-loop` and the value
 * resolves through the standard precedence into `config.taskerLoop`.
 */
export function taskerLoopFlagOverrides(flags: TaskerLoopFlags): PartialConfig {
	const overrides: PartialConfig = {};
	if (flags.taskerLoop !== undefined) {
		overrides.taskerLoop = flags.taskerLoop;
	}
	if (flags.taskerLoopMax !== undefined) {
		const n = Number(flags.taskerLoopMax);
		if (flags.taskerLoopMax.trim() !== '' && !Number.isNaN(n)) {
			overrides.taskerLoopMax = n;
		}
	}
	if (flags.taskerLoopModel !== undefined) {
		overrides.taskerLoopModel = flags.taskerLoopModel;
	}
	return overrides;
}

/**
 * The `--triage-model` flag — the model the advance lifecycle gates (surface,
 * apply, triage) run on. A single string flag, distinct from the harness
 * `--model`/`--build-model` family and from `--review-model`/
 * `--tasker-loop-model`. Resolved through the SAME `flag > env > per-repo >
 * global > default` chain; falls back to `model` when unset at all levels (via
 * `applyModelFallbacks`).
 */
export interface TriageModelFlags {
	/** `--triage-model <id>` — the advance lifecycle gates' model (routing intent). */
	triageModel?: string;
}

/**
 * Map the `--triage-model` flag into a {@link PartialConfig} override. Only
 * contributes when the flag is actually present (absent flag => absent key), so
 * the override layer never clobbers a lower-precedence source with `undefined`.
 */
export function triageModelFlagOverrides(
	flags: TriageModelFlags,
): PartialConfig {
	const overrides: PartialConfig = {};
	if (flags.triageModel !== undefined) {
		overrides.triageModel = flags.triageModel;
	}
	return overrides;
}

/**
 * The fresh-worktree acceptance-gate CLI flag (`do`/`complete`/`run`):
 * `--fresh-worktree-gate` / `--no-fresh-worktree-gate`, the POSITIVE boolean
 * (default ON) toggling whether the acceptance gate (`prepare` then `verify`)
 * runs against the REBASED tip in a clean throwaway worktree (the merged
 * artifact) or in the agent's build worktree (the pre-rebase tree). Modelled
 * EXACTLY on {@link TaskerLoopFlags}'s on/off toggle; a DISTINCT family (no
 * flag/key/field name spans both). Resolved through the SAME
 * `flag > env > per-repo > global > default` chain.
 */
export interface FreshWorktreeGateFlags {
	/** `--fresh-worktree-gate` ⇒ true, `--no-fresh-worktree-gate` ⇒ false, absent ⇒ undefined. */
	freshWorktreeGate?: boolean;
}

/**
 * Map the `--fresh-worktree-gate`/`--no-fresh-worktree-gate` flag into a
 * {@link PartialConfig} override. Only a present flag contributes (absent ⇒
 * absent key), so the override layer never clobbers a lower-precedence source
 * with `undefined`. A negatable boolean (mirrors `taskerLoop`), so the caller
 * leaves `freshWorktreeGate` UNDEFINED unless the user explicitly passed the
 * flag (see the cli's option-source read).
 */
export function freshWorktreeGateFlagOverrides(
	flags: FreshWorktreeGateFlags,
): PartialConfig {
	const overrides: PartialConfig = {};
	if (flags.freshWorktreeGate !== undefined) {
		overrides.freshWorktreeGate = flags.freshWorktreeGate;
	}
	return overrides;
}

/**
 * The selection-order CLI flag (`do` AND `advance`): `--selection-order <order>`
 * (a preset keyword like `drain`/`groom`, or a comma-separated explicit pool
 * order like `build,task,surface,triage`). Resolved through the SAME
 * `flag > env > per-repo > global > default` chain as the other `do` flags.
 */
export interface SelectionOrderFlags {
	/** `--selection-order <order>` — a preset keyword or comma-separated pool list. */
	selectionOrder?: string;
}

/**
 * Map the `--selection-order` flag into a {@link PartialConfig} override. Only a
 * present flag contributes (absent ⇒ absent key). A value CONTAINING a comma is
 * parsed into a trimmed, non-empty list (an explicit pool order, mirroring the
 * env `'list'` coercion); otherwise it is the verbatim string (a preset keyword
 * or a single pool name). The resolver (`select-order.ts`) does the
 * validation/expansion + loud failure at selection time — this only normalises
 * the flag's surface syntax.
 */
export function selectionOrderFlagOverrides(
	flags: SelectionOrderFlags,
): PartialConfig {
	const overrides: PartialConfig = {};
	if (flags.selectionOrder !== undefined) {
		const raw = flags.selectionOrder;
		overrides.selectionOrder = raw.includes(',')
			? raw
					.split(',')
					.map((s) => s.trim())
					.filter((s) => s !== '')
			: raw;
	}
	return overrides;
}

/**
 * The observation-triage CLI flag (`advance`): `--observation-triage
 * <off|ask|auto>`, the 3-state gate over the observation INBOX (ADR
 * `ci-config-policy-and-gate-family`). Resolved through the SAME
 * `flag > env > per-repo > global > default` chain as the other gate flags.
 */
export interface ObservationTriageFlags {
	/** `--observation-triage <off|ask|auto>` — the observation-inbox gate state. */
	observationTriage?: string;
}

/** The valid `--observation-triage` values (mirrors the env enum coercion). */
const OBSERVATION_TRIAGE_VALUES: readonly ObservationTriage[] = [
	'off',
	'ask',
	'auto',
];

/**
 * Map the `--observation-triage` flag into a {@link PartialConfig} override. Only
 * a present flag contributes (absent ⇒ absent key). An INVALID value FAILS LOUDLY
 * (the same loud-failure contract the env enum coercion enforces) rather than
 * silently falling through to a lower layer — a typo on an autonomy gate must
 * never be quietly ignored.
 */
export function observationTriageFlagOverrides(
	flags: ObservationTriageFlags,
): PartialConfig {
	const overrides: PartialConfig = {};
	if (flags.observationTriage !== undefined) {
		const raw = flags.observationTriage;
		if (!OBSERVATION_TRIAGE_VALUES.includes(raw as ObservationTriage)) {
			throw new Error(
				`Invalid value for --observation-triage: '${raw}'. ` +
					`Expected one of: ${OBSERVATION_TRIAGE_VALUES.join(', ')}.`,
			);
		}
		overrides.observationTriage = raw as ObservationTriage;
	}
	return overrides;
}

/**
 * The surface-blockers CLI flag (`advance`): `--surface-blockers` /
 * `--no-surface-blockers`, the BOOLEAN gate over DECLARED blocked work (whether a
 * `needsAnswers:true` task/spec is rendered into a question sidecar; ADR
 * `ci-config-policy-and-gate-family`). The orthogonal PEER of
 * `--observation-triage`. Resolved through the SAME
 * `flag > env > per-repo > global > default` chain as the other gate flags.
 */
export interface SurfaceBlockersFlags {
	/** `--surface-blockers` ⇒ true, `--no-surface-blockers` ⇒ false, absent ⇒ undefined. */
	surfaceBlockers?: boolean;
}

/**
 * Map the `--surface-blockers` flag into a {@link PartialConfig} override. Only a
 * present flag contributes (absent ⇒ absent key), so the override layer never
 * clobbers a lower-precedence source with `undefined`. A negatable boolean, so the
 * caller leaves `surfaceBlockers` UNDEFINED unless the user explicitly passed
 * `--surface-blockers`/`--no-surface-blockers` (see the cli's option-source read).
 */
export function surfaceBlockersFlagOverrides(
	flags: SurfaceBlockersFlags,
): PartialConfig {
	const overrides: PartialConfig = {};
	if (flags.surfaceBlockers !== undefined) {
		overrides.surfaceBlockers = flags.surfaceBlockers;
	}
	return overrides;
}

/**
 * **The cross-job merge-serialiser CAS-retry cap CLI flag** (`--merge-retries
 * <n>`) — spec `land-time-reverify-and-parallel-merge-ceiling` Story 5 / Applied
 * Answer q1 (a). The git-alone FLOOR of the cross-job land-queue; a wide-matrix
 * CI raises the cap so more contenders converge before any spurious bounce to
 * needs-attention. Offered by `do`/`run`/`complete`. Resolved through the SAME
 * `flag > env > per-repo > global > default` chain as `--review-max-rounds` /
 * `--fresh-worktree-gate`.
 */
export interface MergeRetriesFlags {
	/** `--merge-retries <n>` — the cross-job CAS-retry cap (parsed to a non-negative integer). */
	mergeRetries?: string;
}

/**
 * Map the `--merge-retries <n>` flag into a {@link PartialConfig} override. Only
 * a present flag contributes (absent ⇒ absent key), so the override layer never
 * clobbers a lower-precedence source with `undefined`. The value MUST be a
 * NON-NEGATIVE integer (`0` is meaningful — it disables the retry, the
 * un-retried path the engine's tests pin); a non-integer / negative value is
 * dropped silently so the lower layer / default decides (mirrors
 * {@link reviewFlagOverrides}'s parse-or-drop on `--review-max-rounds`).
 */
export function mergeRetriesFlagOverrides(
	flags: MergeRetriesFlags,
): PartialConfig {
	const overrides: PartialConfig = {};
	if (flags.mergeRetries !== undefined) {
		const raw = flags.mergeRetries;
		if (raw.trim() !== '') {
			const n = Number(raw);
			if (Number.isInteger(n) && n >= 0) {
				overrides.mergeRetries = n;
			}
		}
	}
	return overrides;
}

/**
 * The merge-questions CLI flag (`advance`): `--merge-questions <off|ask|auto>`,
 * the 3-state gate over the MERGE-QUESTION SURFACER (spec
 * `land-time-reverify-and-parallel-merge-ceiling` Story 17 / task
 * `merge-questions-gate-axis`). MIRRORS `--observation-triage`'s SHAPE but is a
 * SEPARATE axis with a HIGHER default (`ask`, never `off` — a dropped merge-
 * question means pushed work never lands). Resolved through the SAME
 * `flag > env > per-repo > global > default` chain as the other gate flags.
 */
export interface MergeQuestionsFlags {
	/** `--merge-questions <off|ask|auto>` — the merge-question surfacer gate. */
	mergeQuestions?: string;
}

/** The valid `--merge-questions` values (mirrors the env enum coercion). */
const MERGE_QUESTIONS_VALUES: readonly MergeQuestions[] = [
	'off',
	'ask',
	'auto',
];

/**
 * Map the `--merge-questions` flag into a {@link PartialConfig} override. Only a
 * present flag contributes (absent ⇒ absent key). An INVALID value FAILS LOUDLY
 * (the same loud-failure contract `--observation-triage` enforces) rather than
 * silently falling through — a typo on a question-surfacing gate must never be
 * quietly ignored.
 */
export function mergeQuestionsFlagOverrides(
	flags: MergeQuestionsFlags,
): PartialConfig {
	const overrides: PartialConfig = {};
	if (flags.mergeQuestions !== undefined) {
		const raw = flags.mergeQuestions;
		if (!MERGE_QUESTIONS_VALUES.includes(raw as MergeQuestions)) {
			throw new Error(
				`Invalid value for --merge-questions: '${raw}'. ` +
					`Expected one of: ${MERGE_QUESTIONS_VALUES.join(', ')}.`,
			);
		}
		overrides.mergeQuestions = raw as MergeQuestions;
	}
	return overrides;
}

/**
 * **The strict-merge-approval CLI flag** (`--strict-merge-approval` /
 * `--no-strict-merge-approval`) — spec
 * `land-time-reverify-and-parallel-merge-ceiling` sidecar OQ6 / task
 * `strict-merge-approval-gate`. The OPT-IN strictness layered on the OQ6
 * stale-approval default: ON re-surfaces the merge-question on a merge-base
 * change instead of auto-landing on a green re-verify (the host-agnostic
 * analogue of GitHub's "dismiss stale approvals when the base changes"); OFF
 * (default) honours the prior answer + lands when the rebased tip re-verifies
 * GREEN. Offered alongside `--merge-questions` on `advance` (the apply rung is
 * the consumer). Resolved through the SAME `flag > env > per-repo > global >
 * default` chain as the other gate-family members. A negatable boolean
 * (mirrors `--fresh-worktree-gate`).
 */
export interface StrictMergeApprovalFlags {
	/** `--strict-merge-approval` ⇒ true, `--no-strict-merge-approval` ⇒ false, absent ⇒ undefined. */
	strictMergeApproval?: boolean;
}

/**
 * Map the `--strict-merge-approval`/`--no-strict-merge-approval` flag into a
 * {@link PartialConfig} override. Only a present flag contributes (absent ⇒
 * absent key), so the override layer never clobbers a lower-precedence source
 * with `undefined`. A negatable boolean (mirrors
 * {@link freshWorktreeGateFlagOverrides}): the caller leaves
 * `strictMergeApproval` UNDEFINED unless the user explicitly passed the flag.
 */
export function strictMergeApprovalFlagOverrides(
	flags: StrictMergeApprovalFlags,
): PartialConfig {
	const overrides: PartialConfig = {};
	if (flags.strictMergeApproval !== undefined) {
		overrides.strictMergeApproval = flags.strictMergeApproval;
	}
	return overrides;
}

/**
 * The PR-INTENT CLI flag (`--no-pr`), offered by `do`/`complete`/`run`: push the
 * branch but deliberately skip the review request (the explicit suppress-PR
 * intent, ADR §6). NOT a provider choice. Commander stores the negatable flag as
 * `pr` (false when `--no-pr` is passed). Resolved through the SAME
 * `flag > env > per-repo > global > default` chain as `integration`/`review`.
 */
export interface NoPRFlags {
	/** `--no-pr` ⇒ commander stores `pr === false` (the suppress-PR intent). */
	pr?: boolean;
}

/**
 * Map the `--no-pr` flag into a {@link PartialConfig} override. Only an explicit
 * `--no-pr` (commander's `pr === false`) contributes `noPR: true`; otherwise the
 * key stays absent so the lower layer (env / per-repo / global / default) decides.
 */
export function noPRFlagOverrides(flags: NoPRFlags): PartialConfig {
	const overrides: PartialConfig = {};
	if (flags.pr === false) {
		overrides.noPR = true;
	}
	return overrides;
}

/**
 * The null-default guard: the `null` adapter shells out to `agentCmd`, so it is
 * required there; the `pi` adapter invokes the pi CLI directly and does not
 * consume `agentCmd`. Returns `true` when the resolved config selects the null
 * adapter with no `agentCmd` — the case `do`/`run`/`--remote` must reject with a
 * clear error ({@link NO_AGENT_CMD_MESSAGE}). All three CLI sites call THIS one
 * predicate (named here so the fix's no-regression test can pin it).
 */
export function doNeedsAgentCmd(config: Config): boolean {
	return config.harness !== 'pi' && config.agentCmd.trim() === '';
}

/**
 * The shared up-front message for the {@link doNeedsAgentCmd} refusal. Names BOTH
 * escape hatches: the `--harness pi` adapter (which needs no agentCmd) and
 * setting `harness`/`agentCmd` in config. Shared so `do`/`run`/`--remote` speak
 * with one voice (and the test that pins `--harness pi` only has to pin it once).
 */
export const NO_AGENT_CMD_MESSAGE =
	'no harness configured and no agentCmd set — nothing would run. Pass ' +
	'--harness pi (or set harness/agentCmd in dorfl.json or global config).';

/**
 * The shared up-front message for the PR-INTENT pre-flight refusal: a `propose`
 * run on a GitHub arbiter intends a PR (`noPR` unset) but a `gh` AUTH/AVAILABILITY
 * PROBE says `gh` cannot open one. Surfaced BEFORE any claim/onboard/build so no
 * work is wasted, and naming EVERY real fix (auth `gh`, set a `providers.github`
 * identity token, switch to `--merge`, or `--no-pr` to push without a PR). The
 * honest-failure value the `noPR` axis buys: it disambiguates "I deliberately
 * want no PR" from "I wanted a PR and silently didn't get one". Shared so the
 * in-place + no-checkout `do` paths speak with one voice.
 */
export const PROPOSE_PR_INTENT_GH_UNAVAILABLE_MESSAGE =
	'propose mode on a GitHub arbiter intends a PR, but `gh` is not ' +
	'available/authenticated to open one. Run `gh auth login` (or set a ' +
	'`providers.github` identity token), or pass `--merge` to land on main, or ' +
	'`--no-pr` to push the branch without opening a PR.';

/**
 * Should the PR-INTENT pre-flight guard FIRE for this run? It fires ONLY when ALL
 * hold: the run is `propose` mode (not `merge` — merge never opens a PR), the
 * arbiter is a GitHub URL (only then is a PR even possible), `noPR` is UNSET (the
 * operator INTENDS a PR), and the injected `gh` auth/availability `probe` reports
 * `gh` cannot open one. The probe (mirroring `GitHubProvider.available`) is
 * the signal, NOT a config inspection: an ABSENT `providers.github` identity must
 * NOT trip this guard — it falls back to AMBIENT `gh` auth (the common local-dev
 * case), which the probe correctly reports as available. A genuinely TRANSIENT
 * mid-run `gh` outage (the probe passes here but the API fails later) is left to
 * the runtime degrade — the probe only catches the start-of-run unauthed case.
 */
export function shouldFailProposePrIntent(input: {
	mode: IntegrationMode;
	arbiterIsGitHub: boolean;
	noPR: boolean | undefined;
	/** The `gh` auth/availability probe (true ⇒ `gh` CAN open a PR). */
	ghCanOpenPr: () => boolean;
}): boolean {
	if (input.mode !== 'propose') {
		return false;
	}
	if (!input.arbiterIsGitHub) {
		return false;
	}
	if (input.noPR === true) {
		return false;
	}
	return !input.ghCanOpenPr();
}
