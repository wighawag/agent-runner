import type {Config, PartialConfig} from './config.js';
import {brand, constantCase} from './brand.js';

/**
 * The environment-variable config layer.
 *
 * A per-machine context (a CI job, a developer's shell) can set ANY {@link Config}
 * key via an `DORFL_*` environment variable WITHOUT committing a file —
 * including the host-only keys (`piBin`, `agentCmd`, …) that the per-repo
 * `dorfl.json` deliberately rejects.
 *
 * Env is a legitimate *per-machine source* — exactly like a CLI flag or the
 * global `~/.config/dorfl/config.json` — so it is NOT subject to the
 * per-repo allow/reject split (that split only governs the *committed repo
 * file*). This is the sharpened host-only principle (ADR §13): host-only keys
 * must come from a per-machine source (flag, env, or global file), never the
 * committed repo file; env is simply the per-machine source CI actually has
 * without writing a file.
 *
 * Resolution chain (highest wins):
 *
 *   flag > ENV (DORFL_*) > per-repo > global > built-in default
 *
 * Naming: `DORFL_<SCREAMING_SNAKE(key)>` (mechanical camelCase →
 * SCREAMING_SNAKE, prefixed with `DORFL_` to match the binary). E.g.
 * `DORFL_AGENT_CMD`, `DORFL_PI_BIN`, `DORFL_DEFAULT_ARBITER`,
 * `DORFL_PER_REPO_MAX`.
 *
 * Each value is coerced per the key's type and a typo/invalid value FAILS LOUDLY
 * (never silently ignored) with a message naming the offending variable.
 */

/**
 * The shared `DORFL_` prefix on every env config variable. Derived from
 * the single brand identity (`constantCase(base) + '_'`) so a rename flips the
 * prefix in lockstep with the binary name (see `brand.ts`).
 */
export const ENV_PREFIX = brand.envPrefix;

/** How a key's env value is coerced from its raw string. */
type Coercion =
	| 'string'
	| 'boolean'
	| 'number'
	| 'list'
	| {enum: readonly string[]};

/**
 * The coercion to apply per env-settable {@link Config} key. The source of truth
 * for which env vars exist and how their raw strings become typed values. EVERY
 * SCALAR `Config` key appears here (host-only included) — env is a per-machine
 * source, so no scalar key is off-limits. Keys not listed have no env var.
 *
 * The lone EXCLUSION is `identity`: it is a NESTED structured object (with its
 * own `auth`/`providers` sub-objects), not a scalar a single env string can
 * carry. A `tokenEnv` indirection already covers the one secret a CI/per-machine
 * context legitimately injects via env (the `gh` token), so there is no JSON-in-
 * env hack here. The mapped type is `Partial` precisely to ALLOW this exclusion.
 */
const KEY_COERCIONS: {[K in keyof Config]?: Coercion} = {
	autoBuild: 'boolean',
	autoTask: 'boolean',
	// The observation-triage gate is a 3-state ENUM coercion (like `integration`),
	// so `DORFL_OBSERVATION_TRIAGE=off|ask|auto` works and a typo FAILS
	// LOUDLY naming the variable + the valid options.
	observationTriage: {enum: ['off', 'ask', 'auto']},
	// The merge-question SURFACER gate is a 3-state ENUM coercion (mirrors
	// `observationTriage`'s shape; SEPARATE axis with a HIGHER default, spec
	// `land-time-reverify-and-parallel-merge-ceiling` Story 17 / task
	// `merge-questions-gate-axis`), so `DORFL_MERGE_QUESTIONS=off|ask|auto`
	// works and a typo FAILS LOUDLY naming the variable + the valid options.
	mergeQuestions: {enum: ['off', 'ask', 'auto']},
	// The surface-blockers gate is a BOOLEAN coercion (like `autoBuild`), so
	// `DORFL_SURFACE_BLOCKERS=true|false` works and a typo FAILS LOUDLY.
	surfaceBlockers: 'boolean',
	// `surfaceStaging` (the BOOLEAN gate-family member that widens the SURFACE
	// candidate set to include STAGING — `tasks/backlog/` + `specs/proposed/` —
	// not only the agent pool; spec
	// `staging-surface-and-apply-promote-safety` F2) coerces as a BOOLEAN like
	// `autoBuild`/`surfaceBlockers`, so `DORFL_SURFACE_STAGING=true|false`
	// works and a typo FAILS LOUDLY. Resolution chain identical to the other
	// gate-family members (flag > env > per-repo > global > built-in `true`).
	surfaceStaging: 'boolean',
	// `selectionOrder` coerces as a `'list'` (comma form
	// `DORFL_SELECTION_ORDER=build,task,surface,triage`); a single-element
	// list whose one entry is a preset keyword (`=drain`) is expanded by the
	// resolver (`select-order.ts`). Subsumes the removed `prdsFirst` boolean.
	selectionOrder: 'list',
	maxParallel: 'number',
	perRepoMax: 'number',
	defaultArbiter: 'string',
	workspacesDir: 'string',
	arbitersDir: 'string',
	humanWorktreesDir: 'string',
	integration: {enum: ['propose', 'merge']},
	// `taskingIntegration` (the per-TRANSITION TASKING override) coerces as the SAME
	// `propose`/`merge` enum as `integration`, so `DORFL_TASKING_INTEGRATION`
	// works and a typo FAILS LOUDLY. Unset ⇒ the tasking transition falls back to
	// `integration` (the flat value). It NEVER touches the build transition or intake.
	taskingIntegration: {enum: ['propose', 'merge']},
	// `intakeIntegration` (the per-TRANSITION INTAKE-DOCUMENT override — the twin of
	// `taskingIntegration` for the intake front door) coerces as the SAME
	// `propose`/`merge` enum as `integration`, so `DORFL_INTAKE_INTEGRATION`
	// works and a typo FAILS LOUDLY. Unset ⇒ the intake document emit falls back to
	// `integration` (the flat value). Decoupled from the autonomy gates
	// (`autoBuild`/`autoTask`) — the intake document PR-mode is operator/config, not
	// a function of autonomy (ADR untrusted-origin-carries-via-stamp-not-forced-staging).
	intakeIntegration: {enum: ['propose', 'merge']},
	// `tasksLandIn` (the per-repo TASK-PLACEMENT default — spec
	// `staging-pool-position-gate-and-trust-model` US #5) coerces as the
	// `backlog`/`ready` enum, so `DORFL_TASKS_LAND_IN=ready` works and a
	// typo FAILS LOUDLY. Same
	// precedence chain as `taskingIntegration` (flag > env > per-repo > global >
	// built-in `backlog`); fed into the runner-deterministic placement
	// resolver (`src/placement.ts`) as the configured-default rung.
	tasksLandIn: {enum: ['backlog', 'ready']},
	// `specsLandIn` (the per-repo SPEC-PLACEMENT default — spec
	// `staging-pool-position-gate-and-trust-model` US #2/#5) coerces as the
	// `proposed`/`ready` enum, so `DORFL_SPECS_LAND_IN=ready` works and a typo
	// FAILS LOUDLY. Same precedence chain as `tasksLandIn` (flag > env > per-repo
	// > global > built-in `proposed`); fed into the shared placement resolver
	// (`src/placement.ts`) as the configured-default rung for the spec lifecycle.
	// The legacy `prdsLandIn` key / `DORFL_PRDS_LAND_IN` env are GONE after the
	// ''prd'' → `spec` hard cutover (clean break).
	specsLandIn: {enum: ['proposed', 'ready']},
	// `untrustedTasksLandIn` (the UNTRUSTED-side TWIN of `tasksLandIn` — spec
	// `untrusted-origin-carries-via-stamp-intake-placement-symmetry-and-ci-gate-resolution`
	// US #5/#6, ADR `untrusted-origin-carries-via-stamp-not-forced-staging`)
	// coerces as the SAME `backlog`/`ready` enum as `tasksLandIn`, so
	// `DORFL_UNTRUSTED_TASKS_LAND_IN=ready` works and a typo FAILS LOUDLY. Same
	// precedence chain (flag > env > per-repo > global > built-in `backlog`); the
	// caller selects it (over the trusted `tasksLandIn`) by reading the
	// `originTrust` stamp before feeding the placement resolver.
	untrustedTasksLandIn: {enum: ['backlog', 'ready']},
	// `untrustedSpecsLandIn` (the UNTRUSTED-side TWIN of `specsLandIn` — same spec
	// US #7) coerces as the SAME `proposed`/`ready` enum as `specsLandIn`, so
	// `DORFL_UNTRUSTED_SPECS_LAND_IN=ready` works and a typo FAILS LOUDLY. Same
	// precedence chain (flag > env > per-repo > global > built-in `proposed`).
	untrustedSpecsLandIn: {enum: ['proposed', 'ready']},
	// `noPR` (the PR-INTENT axis) is a BOOLEAN coercion (like `review`), so
	// `DORFL_NO_PR=true|false` works and a typo FAILS LOUDLY. The removed
	// `provider` override has NO env var (a stale `DORFL_PROVIDER` is ignored
	// with a deprecation warning — see `envOverrides`).
	noPR: 'boolean',
	agentCmd: 'string',
	// `dorflCmd` (the repo-declared dorfl COMMAND bare `dorfl` self-forwards to —
	// spec `dorfl-self-version-pinning-and-bootstrap-forward`) coerces as a STRING
	// (carried verbatim, no shell-splitting), so `DORFL_DORFL_CMD="npx dorfl@0.7.0"`
	// works. Unlike `piBin`/`agentCmd` (host-only) it is ALSO repo-settable (ADR
	// `dorfl-cmd-repo-settable-exception-to-host-only`); env is simply the
	// per-machine layer above the committed file in the shared precedence chain.
	// A non-string / empty value is normalised at load (`validateDorflCmdConfig`).
	dorflCmd: 'string',
	model: 'string',
	buildModel: 'string',
	triageModel: 'string',
	intakeModel: 'string',
	harness: {enum: ['null', 'pi']},
	piBin: 'string',
	sessionsDir: 'string',
	// `prepare` coerces as a `'list'` (comma form
	// `DORFL_PREPARE=pnpm install,git submodule update --init`), exactly
	// like `verify` — the SAME precedence chain, the sibling env-prep step.
	prepare: 'list',
	verify: 'list',
	review: 'boolean',
	reviewModel: 'string',
	reviewMaxRounds: 'number',
	taskerLoop: 'boolean',
	taskerLoopMax: 'number',
	taskerLoopModel: 'string',
	// `freshWorktreeGate` is a BOOLEAN coercion (like `taskerLoop`), so
	// `DORFL_FRESH_WORKTREE_GATE=true|false` works and a typo FAILS LOUDLY.
	freshWorktreeGate: 'boolean',
	// `mergeRetries` (the cross-job merge serialiser's CAS-retry cap — spec
	// `land-time-reverify-and-parallel-merge-ceiling` Story 5 / Applied Answer q1 (a))
	// coerces as a NUMBER (like `reviewMaxRounds`), so `DORFL_MERGE_RETRIES=20`
	// works and a typo FAILS LOUDLY. A wide-matrix CI raises it; the default
	// (1000 — the C2 large liveness ceiling) stays in place when unset.
	mergeRetries: 'number',
	// `strictMergeApproval` (the OPT-IN strictness layered on the OQ6
	// stale-approval default — spec `land-time-reverify-and-parallel-merge-ceiling`
	// sidecar OQ6 / task `strict-merge-approval-gate`) coerces as a BOOLEAN
	// (like `freshWorktreeGate`), so `DORFL_STRICT_MERGE_APPROVAL=true|false`
	// works and a typo FAILS LOUDLY. Default OFF; ON re-surfaces the
	// merge-question on a merge-base change instead of auto-landing.
	strictMergeApproval: 'boolean',
	// The dorfl-INTERNAL agent deadline (minutes) — spec
	// `graceful-pre-timeout-wip-checkpoint`. NUMBER coercion (like
	// `reviewMaxRounds`); range validation is fail-loud in `validateDeadlineConfig`
	// (not clamped here). Env is a per-machine source, so CI can override the
	// per-repo default without a config edit: `DORFL_AGENT_DEADLINE_MINUTES=90`.
	agentDeadlineMinutes: 'number',
	checkpointHeadroomMinutes: 'number',
	maxAutoCheckpoints: 'number',
	// `promptGuidance` is a STRUCTURED (nested) namespace, so it has no scalar env
	// var of its own — each MEMBER carries its own env var (the nested-key form
	// `DORFL_PROMPT_GUIDANCE_<MEMBER>`), handled out-of-band in
	// `envOverrides` below. Listing the namespace here would imply a single scalar
	// `DORFL_PROMPT_GUIDANCE` env var, which is NOT how the namespace is
	// shaped (each nudge member is independently resolvable).
};

/**
 * The env vars for the nested members of the `promptGuidance` namespace. The
 * key is the env var name (`DORFL_PROMPT_GUIDANCE_<MEMBER>`, the nested
 * naming the spec specifies); the value is the (boolean) coercion. Each member
 * present in env contributes `{<member>: bool}` into a single
 * `promptGuidance` partial — mergeConfig replaces the whole namespace per the
 * layered precedence, which is correct because EVERY member is included (env
 * supplies a complete inner object whenever ANY member is set).
 */
const PROMPT_GUIDANCE_ENV: Readonly<Record<string, 'boolean'>> = {
	[ENV_PREFIX + 'PROMPT_GUIDANCE_TEST_FIRST']: 'boolean',
};

/** The `DORFL_*` env var name for a config key (`perRepoMax` →
 * `DORFL_PER_REPO_MAX`): the brand prefix + the key in `constantCase`. */
export function envVarName(key: keyof Config): string {
	return ENV_PREFIX + constantCase(key);
}

/** A raw env map (defaults to `process.env`). */
export type EnvMap = Record<string, string | undefined>;

/**
 * Coerce a raw env string for one key, FAILING LOUDLY (with the offending var
 * name) on invalid input: booleans accept only `true`/`false`; numbers reject
 * NaN; enums must be in their union; list keys split on comma; strings verbatim.
 */
function coerceValue(
	varName: string,
	raw: string,
	coercion: Coercion,
): unknown {
	if (typeof coercion === 'object') {
		// Enum: validate against the union.
		if (!coercion.enum.includes(raw)) {
			throw new Error(
				`Invalid value for ${varName}: '${raw}'. ` +
					`Expected one of: ${coercion.enum.join(', ')}.`,
			);
		}
		return raw;
	}
	switch (coercion) {
		case 'string':
			return raw;
		case 'boolean':
			if (raw === 'true') {
				return true;
			}
			if (raw === 'false') {
				return false;
			}
			throw new Error(
				`Invalid boolean for ${varName}: '${raw}'. Expected 'true' or 'false'.`,
			);
		case 'number': {
			const n = Number(raw);
			if (raw.trim() === '' || Number.isNaN(n)) {
				throw new Error(
					`Invalid number for ${varName}: '${raw}'. Expected a numeric value.`,
				);
			}
			return n;
		}
		case 'list':
			// Split on comma (cross-platform; not `:`), trimming each entry. An empty
			// string ⇒ an empty list (an explicit "clear" of a list key).
			return raw
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s !== '');
	}
}

/**
 * Read the `DORFL_*` env layer into a {@link PartialConfig}. Only vars
 * actually present (and non-`undefined`) contribute, so absent env ⇒ `{}` and
 * built-in floors/defaults are untouched. Each present var is coerced per its
 * key's type; an invalid value throws LOUDLY naming the variable.
 *
 * Env may set ANY key — host-only included — because env is a per-machine
 * source, NOT the committed repo file (see this module's doc + ADR §13).
 */
export function envOverrides(
	env: EnvMap = process.env,
	warn: (message: string) => void = (m) => console.error(`>> ${m}`),
): PartialConfig {
	// A stale `DORFL_PROVIDER` (the removed provider OVERRIDE) is IGNORED with
	// a one-line deprecation warning, never an error — the provider is now purely
	// arbiter-derived; "suppress the PR" re-homes to `noPR` (`DORFL_NO_PR`).
	const staleProvider = env[ENV_PREFIX + 'PROVIDER'];
	if (staleProvider !== undefined) {
		warn(
			`Ignoring deprecated env var ${ENV_PREFIX}PROVIDER: the provider is now ` +
				'purely arbiter-derived (a GitHub remote ⇒ the GitHub provider, else ' +
				'none). To suppress the PR (the old `none` use), set ' +
				`${ENV_PREFIX}NO_PR=true (or pass --no-pr).` +
				(staleProvider === 'none'
					? ' (your `none` maps directly to NO_PR=true.)'
					: ''),
		);
	}
	const overrides: PartialConfig = {};
	// Per-member env layer for the `promptGuidance` NUDGE namespace. Each member
	// is INDEPENDENTLY resolvable (`DORFL_PROMPT_GUIDANCE_<MEMBER>`); a
	// present env var sets that member in the partial. We merge ALL set members
	// into a single inner object, then assign once — the outer mergeConfig
	// REPLACES the namespace per layer, so we send a coherent partial-inner per
	// env override (a missing member there reads its default from the lower
	// layer's namespace, which works because env is precisely a per-machine
	// SETTER, not a gate).
	const promptGuidancePartial: Partial<{testFirst: boolean}> = {};
	for (const [varName, coercion] of Object.entries(PROMPT_GUIDANCE_ENV)) {
		const raw = env[varName];
		if (raw === undefined) {
			continue;
		}
		const value = coerceValue(varName, raw, coercion) as boolean;
		if (varName === ENV_PREFIX + 'PROMPT_GUIDANCE_TEST_FIRST') {
			promptGuidancePartial.testFirst = value;
		}
	}
	if (Object.keys(promptGuidancePartial).length > 0) {
		overrides.promptGuidance = {
			testFirst: promptGuidancePartial.testFirst ?? false,
		};
	}
	for (const key of Object.keys(KEY_COERCIONS) as (keyof Config)[]) {
		const coercion = KEY_COERCIONS[key];
		if (coercion === undefined) {
			continue;
		}
		const varName = envVarName(key);
		const raw = env[varName];
		if (raw === undefined) {
			continue;
		}
		const coerced = coerceValue(varName, raw, coercion);
		// Type matches by construction: each coercion yields the key's value type.
		(overrides as Record<string, unknown>)[key] = coerced;
	}
	return overrides;
}
