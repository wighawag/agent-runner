#!/usr/bin/env node
import {Command, Option} from 'commander';
import type {Command as Commander} from 'commander';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {realpathSync, mkdirSync, rmSync, readFileSync} from 'node:fs';
import {join as joinPath, dirname} from 'node:path';
import {git} from './git.js';
import {
	loadConfig,
	mergeConfig,
	defaultConfigPath,
	type Config,
	type PartialConfig,
} from './config.js';
import {
	defaultConfigOverridePath,
	loadConfigOverride,
	type ConfigOverrideMap,
} from './config-override.js';
import {envOverrides} from './env-config.js';
import {scan} from './scan.js';
import {remoteAdd, remoteRm, listMirrors, RegistryError} from './registry.js';
import {findParticipatingRepos} from './detect.js';
import {formatReport} from './format.js';
import {resolveCwdSection, cwdSectionDisposition} from './cwd-section.js';
import {
	runOnce,
	runLoop,
	type ItemResult,
	type RunOnceResult,
	type RunTick,
} from './run.js';
import {performClaim} from './claim-cas.js';
import {createClaimSpinner} from './cli-spinner.js';
import {performStart} from './start.js';
import {
	performWorkOn,
	loadHumanWorktreesDir,
	persistHumanWorktreesDir,
} from './work-on.js';
import {performComplete, integrationFromFlags} from './complete.js';
import {
	performRecoverIsolated,
	locateIsolatedRecovery,
} from './recover-isolated.js';
import {
	performDo,
	performDoRemote,
	resolveArbiterUrlFromCheckout,
	type DoOptions,
	type DoRemoteOptions,
} from './do.js';
import {performDoRemoteAuto, performDoRemoteArgs} from './do-remote-auto.js';
import {performAdvance, type AdvanceContext} from './advance.js';
import {
	performAdvanceAuto,
	performAdvanceArgs,
	runAdvanceTickWithTreelessPublish,
	type AdvanceMultiResult,
} from './advance-drivers.js';
import {
	performAdvanceIsolated,
	performAdvanceIsolatedAuto,
	performAdvanceIsolatedArgs,
	type IsolatedAdvanceContext,
} from './advance-isolated.js';
import {advanceRegistrySetRunTick} from './advance-loop-driver.js';
import {performIntake, resolveIntakeIntegrationModes} from './intake.js';
import {workFolderPrefix} from './work-layout.js';
import {
	performDoAuto,
	performDoArgs,
	type DoMultiResult,
} from './do-autopick.js';
import {createHarness} from './pi-harness.js';
import {generateSessionPath} from './session-path.js';
import type {InteractiveLauncher} from './harness.js';
import {shouldUseColor} from './output.js';
import {
	resolveRepoConfig,
	resolveRepoConfigFromLoaded,
	loadRepoConfigFromContent,
	REPO_CONFIG_FILENAME,
	type LoadedRepoConfig,
} from './repo-config.js';
import {
	ensureMirrorMain,
	readRepoConfigFromMirrorMain,
	encodeRepoKey,
} from './repo-mirror.js';
import {identityEnv, type Identity} from './identity.js';
import {
	harnessFlagOverrides,
	doFlagOverrides,
	doNeedsAgentCmd,
	NO_AGENT_CMD_MESSAGE,
	reviewFlagOverrides,
	freshWorktreeGateFlagOverrides,
	mergeRetriesFlagOverrides,
	noPRFlagOverrides,
	triageModelFlagOverrides,
} from './do-config.js';
import {harnessReviewGate, harnessTaskAcceptanceGate} from './review-gate.js';
import {harnessSurfaceGate} from './surface-gate.js';
import {harnessTriageGate} from './triage-gate.js';
import {harnessApplyDecider} from './apply-decide.js';
import {harnessTaskReviewGate} from './tasker-review-loop.js';
import {runVerify} from './verify.js';
import {renderPrompt} from './prompt.js';
import {resolvePromptGuidance, applyModelFallbacks} from './config.js';
import {
	gc,
	resolveArbiterKeyFromCwd,
	enumerateWorkspaceArbiters,
	RETAIN_REASON_TEXT,
} from './gc.js';
import {
	runPrdToSpec,
	type PrdToSpecResult,
	type DataLeak,
} from './prd-to-spec.js';
import {resyncProtocol, type ResyncResult} from './resync-protocol.js';
import {sweepRemoteMergedBranches} from './reap-branches.js';
import {sweepOrphanSidecars} from './orphan-sidecar.js';
import {sweepLedgerDuplicates, formatLedgerSweep} from './ledger-lint.js';
import {status, formatStatus} from './status.js';
import {ledgerWrite} from './ledger-write.js';
import {
	releaseItemLock,
	releaseLiteralLockEntry,
	reportItemLocks,
	formatItemLockReport,
	itemLockReportNeedsAttention,
	reapStaleItemLocks,
	formatReapReport,
	reapReportNeedsAttention,
} from './item-lock.js';
import {
	migrateStuckLocks,
	formatMigrateStuckLocksReport,
	migrateStuckLocksNeedsAttention,
} from './migrate-stuck-locks.js';
import {
	promoteFromPreBacklog,
	promoteFromPreSpec,
	listPromotable,
} from './needs-attention.js';
import {parseSlugArg} from './slug-namespace.js';
import {dropSource} from './drop-source.js';
import {arbiterStatus, DEFAULT_ARBITER_REMOTE} from './arbiter.js';
import {
	resolveTaskOnlyArg,
	workBranchRef,
	SlugResolutionError,
} from './slug-namespace.js';
import {brand} from './brand.js';
import {maybeForward} from './bootstrap-forward.js';
import {installCI, type WizardPrompts} from './install-ci.js';
import {GitHubCIContext} from './install-ci-github.js';
import {loadCapabilityRegistry} from './install-ci-core.js';
import {performCloseMergedIssues} from './close-job.js';
import {installSkills, type InstallSkillsResult} from './install-skills.js';

interface ScanFlags {
	config?: string;
	autoBuild?: boolean;
	json?: boolean;
	here?: boolean;
	arbiterRemote?: string;
	arbiter?: string;
}

/**
 * Whether `--auto-build` / `--no-auto-build` was explicitly passed on the command
 * line. Commander gives a negatable boolean option a default of `true`, so we
 * must check the value SOURCE to distinguish "user set it" from "default"; only an
 * explicit flag becomes a config override (so config/defaults still win
 * otherwise).
 */
function autoBuildFromCli(command: Commander | undefined): boolean | undefined {
	if (!command) {
		return undefined;
	}
	if (command.getOptionValueSource('autoBuild') === 'cli') {
		return command.getOptionValue('autoBuild') as boolean;
	}
	return undefined;
}

/**
 * Build the overrides a user supplied via CLI flags. Discovery is the registry
 * (the hub-mirror set, ADR §1), so there are no `--root`/`--include`/`--exclude`
 * flags any more — only the autonomy-gate `--auto-build` toggle.
 */
function flagOverrides(flags: ScanFlags, command?: Commander): PartialConfig {
	const overrides: PartialConfig = {};
	const autoBuild = autoBuildFromCli(command);
	if (autoBuild !== undefined) {
		overrides.autoBuild = autoBuild;
	}
	return overrides;
}

/**
 * Resolve the global (non-per-repo) config along the chain
 *
 *   flag > ENV (DORFL_*) > global file > built-in default
 *
 * by layering the file config, then the `DORFL_*` env layer, then the
 * flag overrides on top. Env is a per-machine source (like a flag or the global
 * file) and may set ANY key, host-only included. Used by the commands that build
 * a single global config (`scan`, `run`); per-repo commands fold env in via
 * `resolveRepoConfig` instead.
 */
function resolveGlobalConfig(
	fileConfig: PartialConfig,
	flags: PartialConfig,
): Config {
	const config = mergeConfig({...fileConfig, ...envOverrides(), ...flags});
	applyModelFallbacks(config);
	return config;
}

/**
 * Load BOTH the global config file AND the per-machine `config.override.json`
 * sibling for the given `--config` flag (or the default paths). This is the
 * SINGLE entry point CLI commands use so the override layer is wired uniformly
 * everywhere a per-repo resolution happens (ADR
 * `per-machine-config-override-layer`); a missing override file is a no-op
 * (empty map) — byte-identical to the pre-override behaviour.
 */
function loadGlobalAndOverride(configPath: string | undefined): {
	global: Config;
	override: ConfigOverrideMap;
} {
	return {
		global: loadConfig(configPath),
		override: loadConfigOverride(defaultConfigOverridePath(configPath)),
	};
}

/**
 * Resolve the effective config for a `do --remote <r>` run, layering the target
 * repo's COMMITTED `dorfl.json` (read from `<arbiter>/main` via the hub
 * mirror) into the SAME `flag > env > per-repo > global > default` chain in-place
 * `do` uses. This is the no-checkout analogue of {@link resolveRepoConfig}: there
 * is no working tree, so the bytes come from the arbiter's `main` instead of the
 * cwd — but the parse + allow/reject FILTER (`loadRepoConfigFromContent`) and the
 * layering (`resolveRepoConfigFromLoaded`) are the EXISTING per-repo machinery,
 * reused verbatim. Host-only keys in the committed file are rejected + reported
 * exactly as the in-place read rejects them.
 *
 * Resilient by design: a config-less repo (no file on main) OR an unreachable
 * mirror falls back to global+default (the pre-task behaviour), with a warning
 * on a genuine fetch/read fault — a `--remote` build must not be blocked because
 * the arbiter was momentarily offline.
 *
 * The config read uses {@link ensureMirrorMain} (main-only, NO-prune), NOT the
 * all-heads pruning {@link ensureMirror}: `git show main:dorfl.json` only
 * needs `main`, and the all-heads `+refs/heads/*:refs/heads/*` fetch would let a
 * `work/<slug>` branch CHECKED OUT in some stale job worktree block it (git
 * refuses to fetch into a checked-out branch), throwing the read into its
 * fallback and silently dropping the per-repo `harness`/`verify`/etc. The build's
 * own worktree MATERIALISATION still calls the all-heads `ensureMirror` later
 * (continue-detection needs the kept `work/<slug>` head) — that is a separate,
 * untouched concern; only the CONFIG-READ fetch is narrowed here.
 */
function resolveRemoteRepoConfig(options: {
	remote: string;
	workspacesDir: string;
	global: Config;
	flags: PartialConfig;
	identity: Identity | undefined;
	note: (message: string) => void;
	/**
	 * The per-machine override map (from `loadConfigOverride`). The hub key is
	 * derived from `remote` (the URL is in hand), so the per-repo entry applies
	 * without a git read. Default: empty (no override) — byte-identical to
	 * pre-override behaviour.
	 */
	override?: ConfigOverrideMap;
}): Config {
	const {remote, workspacesDir, global, flags, identity, note, override} =
		options;
	let loaded: LoadedRepoConfig;
	try {
		const env = identityEnv(identity, process.env);
		const mirror = ensureMirrorMain({url: remote, workspacesDir, env});
		const content = readRepoConfigFromMirrorMain(mirror.path, env);
		loaded =
			content === undefined
				? {
						path: `${remote}#main:${REPO_CONFIG_FILENAME}`,
						config: {},
						rejected: [],
					}
				: loadRepoConfigFromContent(
						content,
						`${remote}#main:${REPO_CONFIG_FILENAME}`,
					);
	} catch (err) {
		// A fetch/read fault (offline arbiter, corrupt mirror) must NOT block the
		// build: warn + fall back to global+default (today's no-per-repo behaviour).
		note(
			`could not read the target repo's ${REPO_CONFIG_FILENAME} from ` +
				`${remote}/main; resolving config from global + flags only. ` +
				`${err instanceof Error ? err.message : String(err)}`,
		);
		loaded = {path: `${remote}#main`, config: {}, rejected: []};
	}
	if (loaded.message) {
		note(loaded.message);
	}
	return resolveRepoConfigFromLoaded(loaded, {
		global,
		flags,
		override,
		arbiterUrl: remote,
	}).config;
}

/**
 * Build the {@link RunTick} that **plain `run`** (no flag) loops: the REGISTRY-SET
 * ADVANCE tick (task `run-uses-advance-tick`). This points the deliberate
 * {@link RunTick} swap seam at the precursor's registry-set advance driver
 * ({@link advanceRegistrySetRunTick}) instead of the build-only `runOnce` tick, so
 * plain `run` ≡ advance with calm-default gates: behaviour-preserving today
 * (both lifecycle gates default off ⇒ build ready tasks / task ready prds /
 * route failures to needs-attention, over the SAME registry-set discovery +
 * per-mirror job-worktree isolation the build tick used), lifecycle-capable the
 * moment a gate is flipped (triage / surface / apply).
 *
 * Where the deprecated single-mirror advance wiring drained ONE named mirror
 * IN-PLACE in the cwd checkout (the library {@link advanceRunTick}, now reached
 * only by the precursor's single-mirror tests, no longer the CLI), this discovers
 * the WHOLE registry via
 * `scan(config)` (the SAME discovery the build tick uses) and the registry-set
 * driver threads a PER-MIRROR job-worktree `doDriver` so each mirror's build/task
 * rungs run isolated off THAT mirror's arbiter (NOT `process.cwd()`). The
 * tree-less surface/triage/apply rungs commit in a per-mirror working CLONE of the
 * mirror's arbiter (materialised lazily under the agents' workspace), since a bare
 * hub mirror has no work tree to `git mv`/`git commit` in.
 */
function buildRegistrySetAdvanceTick(options: {
	config: Config;
	workspace: string;
	arbiter?: string;
	env?: NodeJS.ProcessEnv;
	/**
	 * The per-machine {@link ConfigOverrideMap} — threaded into the registry-set
	 * advance driver so per-mirror config resolution honours the override (ADR
	 * `per-machine-config-override-layer`).
	 */
	override?: ConfigOverrideMap;
}): RunTick {
	const {config, workspace, arbiter, env, override} = options;
	const gitEnv = identityEnv(config.identity, env);
	const harness = createHarness({harness: config.harness, piBin: config.piBin});
	return advanceRegistrySetRunTick({
		config,
		override,
		workspace,
		// The SELECTION-layer gates for the loop/CI path, IDENTICAL to the
		// single-mirror wiring above: `observationTriage != off` enumerates the
		// observation (triage) pool; `surfaceBlockers` enumerates the `needsAnswers`-
		// blocked (surface) pool. `off`/`false` drops the respective pool. Apply
		// (consume) is always-on (never gated here). Both default to their calm state,
		// so plain `run` out of the box is behaviour-identical to the old build tick.
		lifecycleGates: {
			triage: config.observationTriage !== 'off',
			surface: config.surfaceBlockers,
			// `surfaceStaging` widens the SURFACE candidate set into STAGING (spec
			// `staging-surface-and-apply-promote-safety` F2). Default `true` — a
			// tasked `needsAnswers` task in `tasks/backlog/` (or spec in
			// `specs/proposed/`) surfaces its questions BEFORE promotion. BUILD/claim
			// stays pool-only either way.
			surfaceStaging: config.surfaceStaging,
		},
		// Build the per-mirror advance CONTEXT the registry-set driver injects its
		// per-mirror job-worktree `doDriver` on top of: the build/task `doOptions`
		// base + the surface/triage gate seams + a tree-less working clone of THIS
		// mirror's arbiter (the ledger-write cwd the surface/triage/apply rungs commit
		// in — a bare mirror cannot `git mv`/`git commit`).
		contextFor: ({mirrorPath, originUrl}) => {
			// A per-mirror working clone of the mirror's arbiter for the tree-less
			// lifecycle rungs (surface/triage/apply). Keyed by the mirror's repo key so
			// distinct mirrors get distinct clones; re-created fresh each tick so the
			// rungs always commit onto the latest mirror `main` (idempotent, cheap
			// local clone). The build/task rungs DO NOT use this cwd (the worktree
			// `doDriver` replaces it); it serves ONLY the tree-less moves.
			const treelessCwd = joinPath(
				workspace,
				'advance-cwd',
				encodeRepoKey(originUrl).split('/').join('__'),
			);
			rmSync(treelessCwd, {recursive: true, force: true});
			mkdirSync(joinPath(treelessCwd, '..'), {recursive: true});
			git(['clone', '--quiet', mirrorPath, treelessCwd], workspace, {
				env: gitEnv,
			});
			const doOptions: Omit<DoOptions, 'arg'> = {
				cwd: treelessCwd,
				arbiter: arbiter ?? config.defaultArbiter,
				identity: config.identity,
				autoTask: config.autoTask,
				integration: config.integration,
				// The per-TRANSITION TASKING override: the `do spec:` tasking path threads
				// `taskingIntegration ?? integration`; the build path stays on `integration`.
				taskingIntegration: config.taskingIntegration,
				// The TASK-PLACEMENT configured defaults (`do spec:` tasking output:
				// `backlog` staged vs `ready` pool). No operator flag on this
				// registry-driven advance context, so only the configured default rungs
				// are threaded (trusted + the untrusted twin the tasker selects from the
				// spec's stamp; the resolver layers the built-in floor).
				tasksLandIn: config.tasksLandIn,
				untrustedTasksLandIn: config.untrustedTasksLandIn,
				prepare: config.prepare,
				verify: config.verify,
				// Single-job build path: gate the REBASED tip (the default) unconditionally.
				freshWorktreeGate: config.freshWorktreeGate,
				// Cross-job merge-serialiser CAS-retry cap (spec `land-time-reverify-and-
				// parallel-merge-ceiling` Story 5 / Applied Answer q1 (a)) — resolved per-repo
				// and threaded so the registry-driven advance path's `do` inherits it.
				mergeRetries: config.mergeRetries,
				noPR: config.noPR,
				harness,
				agentCmd: config.agentCmd,
				model: config.buildModel,
				sessionsDir: config.sessionsDir,
				review: config.review,
				reviewModel: config.reviewModel,
				reviewMaxRounds: config.reviewMaxRounds,
				reviewGate: config.review
					? harnessReviewGate({harness, agentCmd: config.agentCmd})
					: undefined,
				reviewLoop: config.taskerLoop
					? harnessTaskReviewGate({harness, agentCmd: config.agentCmd})
					: undefined,
				taskerLoopMax: config.taskerLoopMax,
				taskerLoopModel: config.taskerLoopModel,
				taskReviewGate: config.review
					? harnessTaskAcceptanceGate({harness, agentCmd: config.agentCmd})
					: undefined,
				color: shouldUseColor(process.stdout),
				note: (message) => console.error(`>> ${message}`),
				noteBlock: (message) => console.error(message),
			};
			const context: AdvanceContext = {
				cwd: treelessCwd,
				arbiter: arbiter ?? config.defaultArbiter,
				doOptions,
				surfaceGate: harnessSurfaceGate({harness, agentCmd: config.agentCmd}),
				surfaceModel: config.triageModel,
				applyDecide: harnessApplyDecider({harness, agentCmd: config.agentCmd}),
				applyModel: config.triageModel,
				observationTriage: config.observationTriage,
				triageGate: harnessTriageGate({harness, agentCmd: config.agentCmd}),
				triageModel: config.triageModel,
				// The ANSWERED-MERGE LAND DISPATCH context (task
				// `apply-rung-merge-disposition`, spec `land-time-reverify-and-parallel-
				// merge-ceiling`): the dispatcher cuts a per-job worktree via
				// `workspace.ts` `createJob` off the hub mirror (so we thread the resolved
				// `workspacesDir` + the real arbiter URL — the per-mirror tree-less
				// `treelessCwd` has `origin` pointing at the LOCAL mirror path, NOT the
				// arbiter URL, so we MUST pass `originUrl` directly here), then drives
				// `performIntegration` with `committedRecovery: true` +
				// `freshWorktreeGate: true` (the rebased tip is re-verified, the RED
				// route refuses, the GREEN route lands). `prepare`/`verify` are the SAME
				// per-repo gate the build path uses; `strictMergeApproval` is the OQ6
				// opt-in resolved by the sibling task `strict-merge-approval-gate`
				// (default OFF ⇒ honour + land on a green re-verify).
				workspacesDir: workspace,
				arbiterUrl: originUrl,
				prepare: config.prepare,
				verify: config.verify,
				strictMergeApproval: config.strictMergeApproval,
				note: (message) => console.error(`>> ${message}`),
			};
			return context;
		},
	});
}

/**
 * Resolve the arbiter URL for `do --isolated <slug>` from the CURRENT repo (cwd).
 *
 * `--isolated` builds in a job worktree off MY OWN arbiter (the same isolation +
 * integrate pipeline `do --remote <url>` uses), so it needs the URL of the cwd's
 * arbiter remote. It uses the SAME arbiter-remote resolution in-place `do` does:
 * `--arbiter` > the resolved cwd `defaultArbiter` (the per-repo/global config), as
 * the remote NAME, then `git remote get-url <name>` in the checkout to get its URL.
 * That URL is then fed into the EXISTING `performDoRemote` pipeline as `remote`.
 *
 * Returns the URL, or `undefined` when there is no resolvable arbiter (cwd is not
 * a git repo, or the named arbiter remote does not exist) — the "isolated against
 * what?" case the caller turns into a clear error naming `--remote <url>`.
 */
function resolveDefaultArbiterForCwd(
	cwd: string,
	global: Config,
	flags: PartialConfig,
	override?: ConfigOverrideMap,
): string {
	// The SAME per-repo config read in-place `do` uses (`resolveRepoConfig` on the
	// cwd), so `--isolated` resolves the arbiter remote NAME (`defaultArbiter`)
	// through the identical `flag > env > per-repo > global > default` chain. An
	// absent `dorfl.json` falls back to the global/default (`origin`).
	return resolveRepoConfig({repoPath: cwd, global, flags, override}).config
		.defaultArbiter;
}

/**
 * First-use prompt for the human worktree root (`work-on`). Offers `suggestion`
 * as the default (Enter accepts it); a blank non-interactive answer aborts. The
 * prompt goes to stderr so `--print-dir`'s stdout stays clean.
 */
function promptForWorktreesRoot(suggestion: string): Promise<string> {
	return new Promise((resolvePrompt) => {
		const rl = createInterface({input: process.stdin, output: process.stderr});
		rl.question(
			'work-on needs a human worktree root (NOT under ~/.dorfl). ' +
				`Where should parallel worktrees live? [${suggestion}] `,
			(answer) => {
				rl.close();
				const trimmed = answer.trim();
				resolvePrompt(trimmed === '' ? suggestion : trimmed);
			},
		);
	});
}

interface RunFlags extends ScanFlags {
	once?: boolean;
	/**
	 * `run --advance` is a DEPRECATED NO-OP ALIAS (task `run-uses-advance-tick`).
	 * Plain `run` (no flag) now ALREADY drives the registry-set ADVANCE tick with
	 * calm-default gates, so there is no longer a separate advance MODE to opt into:
	 * passing `--advance` warns + is otherwise ignored (it does NOT change the tick,
	 * which is already advance). Kept so an existing `run --advance` invocation does
	 * not break; it carries NO value (the old `--advance <mirror>` single-mirror
	 * form is gone — the daemon discovers the WHOLE registry via `scan(config)`, the
	 * SAME discovery the build tick used).
	 */
	advance?: boolean;
	maxIterations?: string;
	maxDuration?: string;
	interval?: string;
	maxParallel?: string;
	perRepoMax?: string;
	arbiter?: string;
	integration?: string;
	/** `--no-pr` ⇒ commander stores `pr === false` (the suppress-PR intent). */
	pr?: boolean;
	agentCmd?: string;
	model?: string;
	/** `--build-model <id>` — the builder-specific model override (falls back to `--model`). */
	buildModel?: string;
	harness?: string;
	piBin?: string;
	sessionsDir?: string;
	workspace?: string;
	review?: boolean;
	reviewModel?: string;
	reviewMaxRounds?: string;
	/** `--triage-model <id>` — the advance lifecycle gates' model (surface, apply, triage). */
	triageModel?: string;
	/** `--fresh-worktree-gate` / `--no-fresh-worktree-gate` — gate the REBASED tip in a clean throwaway worktree (ON by default). */
	freshWorktreeGate?: boolean;
	/** `--merge-retries <n>` — the cross-job merge-serialiser CAS-retry cap (spec `land-time-reverify-and-parallel-merge-ceiling` Story 5 / Applied Answer q1 (a)). */
	mergeRetries?: string;
}

function runFlagOverrides(flags: RunFlags, command?: Commander): PartialConfig {
	const overrides = flagOverrides(flags, command);
	if (flags.maxParallel !== undefined) {
		overrides.maxParallel = Number(flags.maxParallel);
	}
	if (flags.perRepoMax !== undefined) {
		overrides.perRepoMax = Number(flags.perRepoMax);
	}
	if (flags.arbiter !== undefined) {
		overrides.defaultArbiter = flags.arbiter;
	}
	if (flags.integration === 'propose' || flags.integration === 'merge') {
		overrides.integration = flags.integration;
	}
	// `--no-pr` (the PR-INTENT axis): suppress the PR even on an authed GitHub
	// arbiter. Commander stores the negatable flag as `pr` (false when `--no-pr` is
	// passed). Rides the SAME flag-override chain as `integration`.
	if (flags.pr === false) {
		overrides.noPR = true;
	}
	// The harness/adapter flags (--agent-cmd/--model/--harness/--pi-bin) map via
	// the SHARED per-key mapping `do` also reuses (do-config.harnessFlagOverrides),
	// so there is exactly ONE override path for them.
	Object.assign(overrides, harnessFlagOverrides(flags));
	// Gate 2 (PR/code review) flags ride the SAME flag-override path so
	// `--review`/`--review-model`/`--review-max-rounds` resolve
	// flag > env > per-repo > global > default — mirroring the `do` command (the
	// fleet inherits the review gate via the converged `performIntegration` core).
	Object.assign(overrides, reviewFlagOverrides(flags));
	// `--triage-model` (the advance lifecycle gates' model) rides the SAME chain.
	Object.assign(overrides, triageModelFlagOverrides(flags));
	// `--fresh-worktree-gate`/`--no-fresh-worktree-gate` rides the SAME chain: gate
	// the REBASED tip in a clean throwaway worktree (ON by default). The `run` fleet
	// caller additionally downgrades it to today's gate at `perRepoMax > 1` (the
	// fleet conditional lives in `runOnce`, not in this flag mapping).
	Object.assign(overrides, freshWorktreeGateFlagOverrides(flags));
	// `--merge-retries <n>` rides the SAME chain: the cross-job merge-serialiser
	// CAS-retry cap (spec `land-time-reverify-and-parallel-merge-ceiling` Story 5 /
	// Applied Answer q1 (a)). The `run` fleet inherits the resolved cap through
	// the converged `performIntegration` core (config.mergeRetries threads into
	// the merge loop, replacing the bare `DEFAULT_MERGE_RETRIES` fallback).
	Object.assign(overrides, mergeRetriesFlagOverrides(flags));
	return overrides;
}

function formatItemLine(item: ItemResult): string {
	const extra = item.detail ? ` — ${item.detail}` : '';
	return `  [${item.status}] ${item.repoPath} :: ${item.slug}${extra}`;
}

interface ClaimFlags {
	arbiter?: string;
	retries?: string;
	dryRun?: boolean;
	ignoreNotReady?: boolean;
}

interface VerifyFlags {
	config?: string;
}

/**
 * The flags that drive an INTERACTIVE `--agent` launch (task
 * `agent-interactive-launch`), shared by `start` and `work-on`. `--agent` opts
 * into launching the configured harness interactively after onboarding; the
 * harness/model/pi-bin/sessions-dir flags resolve the SAME way the autonomous
 * `do`/`run` path resolves them (flag > env > per-repo > global > default), so
 * the human starts pinned to the intended model (decision #4).
 */
interface AgentLaunchFlags {
	agent?: boolean;
	harness?: string;
	model?: string;
	piBin?: string;
	sessionsDir?: string;
}

interface StartFlags extends AgentLaunchFlags {
	config?: string;
	arbiter?: string;
	resume?: boolean;
	ignoreNotReady?: boolean;
	/** `--isolated` (resume only): re-engage the slug's retained job worktree. */
	isolated?: boolean;
	workspace?: string;
}

interface WorkOnFlags extends AgentLaunchFlags {
	config?: string;
	arbiter?: string;
	remote?: string;
	copy?: string;
	copyFrom?: string;
	ignoreNotReady?: boolean;
	printDir?: boolean;
	workspace?: string;
}

interface CompleteFlags {
	config?: string;
	arbiter?: string;
	merge?: boolean;
	propose?: boolean;
	/** `--no-pr` ⇒ commander stores `pr === false` (the suppress-PR intent). */
	pr?: boolean;
	switch?: boolean;
	ignoreDivergedMain?: boolean;
	skipVerify?: boolean;
	type?: string;
	message?: string;
	review?: boolean;
	reviewModel?: string;
	reviewMaxRounds?: string;
	/** `--fresh-worktree-gate` / `--no-fresh-worktree-gate` — gate the REBASED tip in a clean throwaway worktree (ON by default). */
	freshWorktreeGate?: boolean;
	/** `--merge-retries <n>` — the cross-job merge-serialiser CAS-retry cap (spec `land-time-reverify-and-parallel-merge-ceiling` Story 5 / Applied Answer q1 (a)). */
	mergeRetries?: string;
	/** `--isolated`: finish the slug's retained job worktree (the stranded-branch recover). */
	isolated?: boolean;
	workspace?: string;
}

/**
 * Resolve the EXPLICIT operator placement override from `--tasks-land-in <where>`
 * (the top of the `do spec:` tasking-placement precedence — task
 * `runner-deterministic-slice-placement-policy-and-precedence`). Mirrors the
 * `flagMode === 'merge'` ⇒ `explicitMerge: true` shape: it contributes
 * `explicitTasksLandIn` ONLY when the operator actually typed the flag, so an
 * untrusted-origin's staging force still wins when the value came from config, not
 * the flag. An invalid value FAILS LOUDLY (a usage error, never silently dropped
 * — the SAME discipline the `--observation-triage` enum + the
 * `DORFL_TASKS_LAND_IN` env coercion use).
 */
function explicitTasksLandInFromFlag(
	raw: string | undefined,
): 'backlog' | 'ready' | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (raw !== 'backlog' && raw !== 'ready') {
		throw new Error(
			`--tasks-land-in must be 'backlog' or 'ready' (got '${raw}').`,
		);
	}
	return raw;
}

/**
 * The SPEC twin of {@link explicitTasksLandInFromFlag} (spec
 * `prd-to-spec-vocabulary-cutover-and-migration-command`). Resolve the EXPLICIT
 * operator spec-placement override from `--specs-land-in <where>` for `intake`'s
 * `spec` dispatch — the TOP of the same precedence chain that the tasking
 * placement uses. Contributes `explicitSpecsLandIn` ONLY when the operator
 * actually typed the flag, so an untrusted-origin's staging force still wins when
 * the value came from config. An invalid value FAILS LOUDLY (a usage error,
 * never silently dropped), mirroring the task helper above and the
 * `DORFL_SPECS_LAND_IN` env coercion.
 *
 * HARD CUTOVER: the legacy `--prds-land-in` flag is GONE (clean break, spec US
 * #8); only `--specs-land-in` is accepted.
 */
function explicitSpecsLandInFromFlag(
	raw: string | undefined,
	flagName = '--specs-land-in',
): 'proposed' | 'ready' | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (raw !== 'proposed' && raw !== 'ready') {
		throw new Error(
			`${flagName} must be 'proposed' or 'ready' (got '${raw}').`,
		);
	}
	return raw;
}

interface DoFlags {
	config?: string;
	arbiter?: string;
	remote?: string;
	/** `--isolated`: build in a job worktree off THIS repo's arbiter (no checkout takeover). Since `make-isolated-default-build-mode` this is the DEFAULT; the flag remains accepted as a redundant explicit opt-IN alias (D3). */
	isolated?: boolean;
	/** `--in-place`: opt OUT of the new default (isolated off the arbiter) and build in the CURRENT checkout, restoring today's dirty-tree-refusing in-place behaviour (D3). */
	inPlace?: boolean;
	/** `-n <x>`: do x eligible items in sequence (auto-pick form). */
	number?: string;
	/** `--selection-order <order>`: a preset keyword (drain/groom) or comma-separated pool order. */
	selectionOrder?: string;
	/** `--observation-triage <off|ask|auto>`: the observation-inbox gate (`advance`). */
	observationTriage?: string;
	/** `--surface-blockers` / `--no-surface-blockers`: the declared-blocked-work gate (`advance`). */
	surfaceBlockers?: boolean;
	/** `--merge-questions <off|ask|auto>`: the merge-question SURFACER gate (`advance`). SEPARATE from `--observation-triage` with a HIGHER default. */
	mergeQuestions?: string;
	/** `--strict-merge-approval` / `--no-strict-merge-approval`: the OPT-IN strictness layered on the OQ6 stale-approval default (`advance`). Default OFF — ON re-surfaces the merge-question on a merge-base change instead of auto-landing on a green re-verify. */
	strictMergeApproval?: boolean;
	merge?: boolean;
	propose?: boolean;
	/** `--tasks-land-in <backlog|ready>`: the explicit operator placement override for `do spec:` tasking output (top of the placement precedence). Resolves into the `tasksLandIn` config key. */
	tasksLandIn?: string;
	/** `--no-pr` ⇒ commander stores `pr === false` (the suppress-PR intent). */
	pr?: boolean;
	ignoreDivergedMain?: boolean;
	/** `--allow-backlog`: drive a staged (tasks/backlog/) task in place without promoting it (`do task:` only). EXPLICIT-INVOCATION-ONLY — never config/env. */
	allowBacklog?: boolean;
	agentCmd?: string;
	model?: string;
	/** `--build-model <id>` — the builder-specific model override (falls back to `--model`). */
	buildModel?: string;
	harness?: string;
	piBin?: string;
	sessionsDir?: string;
	watch?: boolean;
	review?: boolean;
	reviewModel?: string;
	reviewMaxRounds?: string;
	/** `--triage-model <id>` — the advance lifecycle gates' model (surface, apply, triage). */
	triageModel?: string;
	/** `--tasker-loop` / `--no-tasker-loop` — the tasker improver loop on/off toggle (`do spec:` path). Resolves into the `taskerLoop` config key. */
	taskerLoop?: boolean;
	/** `--tasker-loop-max <n>` — the tasker improver loop's in-context convergence cap (`do spec:` path). Resolves into the `taskerLoopMax` config key. */
	taskerLoopMax?: string;
	/** `--tasker-loop-model <id>` — the tasker improver loop reviewer's de-correlated model (`do spec:` path). Resolves into the `taskerLoopModel` config key. */
	taskerLoopModel?: string;
	/** `--fresh-worktree-gate` / `--no-fresh-worktree-gate` — gate the REBASED tip in a clean throwaway worktree (ON by default). */
	freshWorktreeGate?: boolean;
	/** `--merge-retries <n>` — the cross-job merge-serialiser CAS-retry cap (spec `land-time-reverify-and-parallel-merge-ceiling` Story 5 / Applied Answer q1 (a)). */
	mergeRetries?: string;
}

interface IntakeFlags {
	config?: string;
	arbiter?: string;
	merge?: boolean;
	propose?: boolean;
	/** `--no-pr` ⇒ commander stores `pr === false` (the suppress-PR intent). */
	pr?: boolean;
	mergeSpec?: boolean;
	proposeSpec?: boolean;
	mergeTask?: boolean;
	proposeTask?: boolean;
	/**
	 * `--origin-trust <trusted|untrusted>` — the author-trust verdict the CI shell
	 * passes IN so `intake` STAMPS the emitted spec/task (task
	 * `untrusted-origin-forces-build-propose`). `intake` does NOT resolve trust; the
	 * shell derives it from the SAME `author_association` case as the integration
	 * flags. UNSET (a local intake) ⇒ emit unstamped ⇒ human/trusted.
	 */
	originTrust?: string;
	/** `--specs-land-in <proposed|ready>`: the explicit operator spec-placement override (top of the precedence). Resolves into the `specsLandIn` config key. */
	specsLandIn?: string;
	/** `--tasks-land-in <backlog|ready>`: the explicit operator TASK-placement override for a DIRECT-from-issue task emit (top of the precedence). The task twin of `--specs-land-in`. Resolves into the `tasksLandIn` config key. */
	tasksLandIn?: string;
	agentCmd?: string;
	model?: string;
	/** `--intake-model <id>` — the intake decision agent's model (falls back to `--model`). */
	intakeModel?: string;
	harness?: string;
	piBin?: string;
	sessionsDir?: string;
}

interface GcFlags {
	config?: string;
	workspace?: string;
	force?: boolean;
	yes?: boolean;
	json?: boolean;
	ledger?: string;
	remoteBranches?: boolean;
	arbiter?: string;
	allArbiters?: boolean;
	cwd?: string;
	dryRun?: boolean;
	reapStaleLocks?: boolean;
}

interface PrdToSpecFlags {
	repo?: string;
	dryRun?: boolean;
	json?: boolean;
}

/** Human-readable report for the `prd-to-spec` migration result. */
function printPrdToSpecReport(result: PrdToSpecResult): void {
	if (result.refused) {
		const v = result.refused;
		const label =
			v.kind === 'dirty-tree'
				? 'dirty working tree'
				: v.kind === 'held-lock'
					? 'a held per-item lock'
					: 'an in-progress work-branch carrying unlanded work';
		console.error(
			`REFUSED: the repo is not quiescent (${label}): ${v.offender}. ` +
				'Land or discard the in-flight work, then re-run. (prd-to-spec ' +
				'never migrates over uncommitted/in-flight state.)',
		);
		return;
	}

	const verb = result.dryRun ? 'WOULD' : 'DID';
	console.log(
		result.dryRun
			? '=== prd-to-spec (DRY RUN — nothing written) ==='
			: '=== prd-to-spec ===',
	);

	if (result.resync) {
		const changed = result.resync.docs.filter(
			(d) => !d.unchanged && !d.skipped,
		).length;
		console.log(
			`Contract re-sync: ${verb} sync ${result.resync.docs.length} protocol ` +
				`doc(s) (${changed} changed) + bump ${result.resync.versionPath}.`,
		);
		// Surface any doc whose SOURCE could not be resolved LOUDLY: it was NOT
		// copied, so the contract in the target repo is incomplete for that doc.
		for (const skipped of result.resync.docs.filter((d) => d.skipped)) {
			console.warn(
				`  !! ${skipped.name}: SOURCE could not be resolved — NOT copied ` +
					`(the contract doc is missing/unchanged in the target repo).`,
			);
		}
	}
	console.log(`Folders: ${verb} move ${result.folderMoves.length} folder(s).`);
	for (const m of result.folderMoves) {
		console.log(`  ${m.from} -> ${m.to}`);
	}
	console.log(
		`Item content: ${verb} rewrite ${result.contentRewrites.length} item(s).`,
	);
	console.log(
		`Config: ${verb} rename ${result.configRewrites.length} key(s)` +
			(result.configRewrites.length > 0
				? ` (${result.configRewrites.map((c) => `${c.from}->${c.to}`).join(', ')})`
				: '') +
			'.',
	);
	console.log(`Refs: ${verb} rename ${result.refRenames.length} inert ref(s).`);
	for (const r of result.refRenames) {
		console.log(`  ${r.from} -> ${r.to}`);
	}

	if (result.dryRun) {
		console.log(
			'(Re-run without --dry-run to apply; the leak scan gates the output.)',
		);
		return;
	}
	if (result.leaks.length === 0) {
		console.log('Leak scan: GREEN (no surviving spec data ref).');
	} else {
		console.error(`Leak scan: FAILED (${result.leaks.length} leak(s)):`);
		for (const leak of result.leaks) {
			printLeak(leak);
		}
	}
}

function printLeak(leak: DataLeak): void {
	console.error(
		`  [${leak.lens}] ${leak.where}: '${leak.token}' — ${leak.why}`,
	);
}

/**
 * A minimal interactive yes/no confirmation (default NO). Prompts on stderr
 * (stdout stays reserved for machine/report output) and reads one line from
 * stdin. Callers only reach this on an interactive (TTY) session — a non-TTY
 * path decides WITHOUT prompting (so a scripted run never hangs). Returns true
 * only for an explicit `y`/`yes`.
 */
function confirmYesNo(message: string): Promise<boolean> {
	return new Promise((resolvePrompt) => {
		const rl = createInterface({input: process.stdin, output: process.stderr});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			const a = answer.trim().toLowerCase();
			resolvePrompt(a === 'y' || a === 'yes');
		});
	});
}

interface SyncFlags {
	/** The repo working-tree root to sync (default: cwd). */
	repo?: string;
	/** Report what WOULD change, touching nothing. */
	dryRun?: boolean;
	/**
	 * ALSO (re-)install the packaged dorfl skills into the operator's own harness
	 * dir(s), NON-INTERACTIVELY. This flag IS the confirmation: it BYPASSES the
	 * interactive ask. Without it, an interactive (TTY) session PROMPTS once
	 * before installing, and a non-TTY session skips the skills step entirely
	 * (so a scripted `sync` never hangs). Either way, the protocol re-sync half
	 * always runs.
	 */
	addSkills?: boolean;
	/** With `--add-skills` (or a confirmed prompt): scope the skills install to <cwd>/.agents/skills/ instead of the global default. */
	local?: boolean;
	json?: boolean;
}

/**
 * Human-readable report for the deterministic protocol re-sync half of
 * `dorfl sync`. Groups the docs into changed / unchanged / skipped and names the
 * VERSION file. `dryRun` reframes it as "WOULD" so a preview reads honestly.
 * A SKIPPED doc (unresolvable source) is surfaced LOUDLY — the contract in the
 * target repo is incomplete for that doc.
 */
export function formatSyncReport(
	result: ResyncResult,
	dryRun: boolean,
): string {
	const lines: string[] = [];
	const changed = result.docs.filter((d) => !d.unchanged && !d.skipped);
	const unchanged = result.docs.filter((d) => d.unchanged);
	const skipped = result.docs.filter((d) => d.skipped);
	const verb = dryRun ? 'WOULD sync' : 'Synced';
	lines.push(
		dryRun
			? '=== dorfl sync (DRY RUN — nothing written) ==='
			: '=== dorfl sync ===',
	);
	lines.push(
		`Protocol: ${verb} ${result.docs.length} doc(s) — ` +
			`${changed.length} changed, ${unchanged.length} unchanged, ` +
			`${skipped.length} skipped.`,
	);
	for (const d of changed) {
		lines.push(`  ~ ${d.dest}`);
	}
	for (const d of skipped) {
		lines.push(
			`  !! ${d.name}: SOURCE could not be resolved — NOT copied ` +
				'(the contract doc is missing in the package).',
		);
	}
	if (changed.length > 0 || skipped.length === result.docs.length) {
		lines.push(
			`VERSION: ${dryRun ? 'WOULD bump' : 'bumped'} ${result.versionPath}` +
				(skipped.length === result.docs.length
					? ' (no doc synced — no bump)'
					: '.'),
		);
	} else {
		lines.push(`VERSION: unchanged (${result.versionPath} — already current).`);
	}
	return lines.join('\n');
}

interface StatusFlags {
	config?: string;
	workspace?: string;
	arbiterRemote?: string;
	arbiter?: string;
	noArbiter?: boolean;
	here?: boolean;
	json?: boolean;
}

interface RequeueFlags {
	config?: string;
	cwd?: string;
	arbiter?: string;
	reset?: boolean;
	reconcile?: boolean;
	rebase?: boolean;
	message?: string;
}

interface PromoteFlags {
	config?: string;
	cwd?: string;
	arbiter?: string;
}

interface ReleaseLockFlags {
	config?: string;
	cwd?: string;
	arbiter?: string;
	entry?: string;
}

interface DropFlags {
	cwd?: string;
	reason?: string;
}

interface RemoteAddFlags {
	config?: string;
	local?: boolean;
	arbiterRemote?: string;
	force?: boolean;
}

interface RemoteRmFlags {
	config?: string;
}

interface RemoteLsFlags {
	config?: string;
	json?: boolean;
}

interface RemoteFindFlags {
	config?: string;
	yes?: boolean;
}

interface InstallCiFlags {
	config?: string;
	fake?: boolean;
	exportConfig?: string;
	includeSecrets?: boolean;
	installSource?: string;
	maxParallel?: string;
	cwd?: string;
	repo?: string;
	ghBin?: string;
}

interface CloseMergedIssuesFlags {
	cwd?: string;
	ghBin?: string;
	json?: boolean;
}

/**
 * Resolve a task-only command's slug argument through the §3a namespace guard
 * (`resolveTaskOnlyArg`): accept bare (= task) + `task:` (explicit alias),
 * REJECT `spec:` with a clear "operates on tasks, not specs" error. On rejection
 * it prints the error to stderr and exits 1 (the task-only commands never act on
 * a spec). An OMITTED slug (`start`/`complete`/`prompt` infer it from the branch)
 * passes through untouched. (The legacy ''prd:'' prefix is a DEAD namespace token
 * after the hard cutover — it is neither special-cased nor rejected here; a
 * ''prd:<slug>'' arg resolves as a bare literal task slug.)
 *
 * `do` is the ONE command that spans both namespaces; it consumes the full
 * `resolveSlug` (with the cross-namespace collision check) in the `do-in-place`
 * task. This guard is the task-only half of ADR §3a.
 */
function resolveTaskOnlySlug(slug: string | undefined): string | undefined {
	if (slug === undefined) {
		return undefined;
	}
	try {
		return resolveTaskOnlyArg(slug);
	} catch (err) {
		if (err instanceof SlugResolutionError) {
			console.error(`error: ${err.message}`);
			process.exit(1);
		}
		throw err;
	}
}

/**
 * Build the INTERACTIVE launcher closure for `--agent` (task
 * `agent-interactive-launch`), or `undefined` when `--agent` was not passed.
 *
 * It resolves the harness + model the SAME way the autonomous `do`/`run` path
 * does — per-repo config layered flag > env > per-repo > global > default (ADR
 * §13) — so the human starts pinned to the intended model (decision #4). The
 * returned closure is what `start.ts`/`work-on.ts` call AFTER onboarding: it
 * generates the pi `--session` path for the onboarded working tree and calls
 * `harness.launchInteractive` (which inherits stdio, drops `--print`, feeds no
 * prompt, foreground). A NON-pi harness throws a clear pi-only error from the
 * adapter (decision #2). This keeps the git-logic modules decoupled from
 * `createHarness`/config (they only receive the thin {@link InteractiveLauncher}).
 *
 * `repoPath` is the per-repo config root (the current checkout for `start` /
 * in-repo `work-on`); `undefined` (remote `work-on`, no checkout) resolves from
 * the global config only — mirroring `do --remote`.
 */
function buildInteractiveLauncher(
	flags: AgentLaunchFlags,
	configPath: string | undefined,
	repoPath: string | undefined,
): InteractiveLauncher | undefined {
	if (flags.agent !== true) {
		return undefined;
	}
	const {global, override} = loadGlobalAndOverride(configPath);
	const overrides = harnessFlagOverrides(flags);
	const config =
		repoPath !== undefined
			? resolveRepoConfig({repoPath, global, flags: overrides, override}).config
			: resolveGlobalConfig(global, overrides);
	const harness = createHarness({
		harness: config.harness,
		piBin: config.piBin,
	});
	return (site) => {
		// Generate the pi `--session` path for the onboarded working tree so the
		// human session is recorded + dashboard-visible (decision #2); the resolved
		// model flows in (decision #4). The harness's `launchInteractive` runs pi
		// WITHOUT `--print`, inherited stdio, no piped prompt, in `site.dir`.
		const session = generateSessionPath({
			sessionsDir: config.sessionsDir,
			cwd: site.dir,
			id: site.slug,
		});
		harness.launchInteractive({
			slug: site.slug,
			dir: site.dir,
			model: config.model,
			session,
			env: site.env,
		});
	};
}

/**
 * The shared `start`/`resume` action body. `start` and `resume` are the two
 * human in-place verbs of ADR §4: `start` BEGINS work here (claim if needed +
 * switch); `resume` CONTINUES here (re-engage an already-in-progress item by
 * switching to its `work/<slug>` branch WITHOUT claiming). The runtime
 * difference is exactly the `resume` flag — `resume` forces it on (its only mode
 * is to re-engage), while `start` honours the (now hidden) `--resume` alias.
 * Both are task-only (§3a: accept bare + `task:`, reject `spec:`).
 */
async function runStartAction(
	rawSlug: string | undefined,
	flags: StartFlags,
	resume: boolean,
): Promise<void> {
	// Task-only command (§3a): accept bare + `task:`, reject `spec:`.
	const slug = resolveTaskOnlySlug(rawSlug);
	const cwd = process.cwd();

	// `resume --isolated <slug>`: re-engage the slug's RETAINED job worktree (the
	// inverse of `do --isolated`) WITHOUT claiming \u2014 locate it off THIS repo's
	// arbiter and report its path so the operator can cd in. The symmetric
	// companion of `complete --isolated` (finish the stranded worktree). `start`
	// (begin-here) has no isolated form \u2014 there is nothing retained to re-engage yet.
	if (resume && flags.isolated === true) {
		if (slug === undefined || slug === '') {
			console.error(
				'error: resume --isolated requires <slug> (the retained worktree to re-engage).',
			);
			process.exit(1);
		}
		const {config} = loadHumanWorktreesDir(flags.config ?? defaultConfigPath());
		const located = locateIsolatedRecovery({
			slug,
			cwd,
			arbiter: flags.arbiter ?? config.defaultArbiter,
			workspacesDir: flags.workspace ?? config.workspacesDir,
			env: process.env,
		});
		if ('error' in located) {
			console.error(`error: ${located.error}`);
			process.exit(1);
		}
		if (!located.present) {
			console.error(
				`>> No retained isolated worktree for '${slug}' (already integrated and ` +
					'reaped, or never stranded) \u2014 nothing to resume.',
			);
			process.exit(0);
		}
		console.error(
			`>> Re-engaging the retained worktree for '${slug}'. cd into it to ` +
				`continue, then 'dorfl complete --isolated ${slug}' to finish:`,
		);
		process.stdout.write(`${located.dir}\n`);
		process.exit(0);
	}

	const result = await performStart({
		slug,
		cwd,
		arbiter: flags.arbiter ?? 'origin',
		// `resume` (the verb) always asserts ownership; `start` honours --resume.
		resume: resume || flags.resume === true,
		override: flags.ignoreNotReady === true,
		// `--agent`: launch the configured harness INTERACTIVELY in the checkout
		// after onboarding (task `agent-interactive-launch`). The per-repo config
		// root is the current checkout.
		launchInteractive: buildInteractiveLauncher(flags, flags.config, cwd),
		// HUMAN commands (`start` = "begin here", `resume` = "continue here"): the
		// onboard/branch/switch is the human's, so it is NOT given the runner
		// `config.identity` (the autonomous onboard is `do`/`run`, identity-aware).
		// Ambient `process.env` threaded EXPLICITLY so the choice is declared here,
		// not left to the seam's silent `?? process.env` fallback.
		env: process.env,
		note: (message) => console.error(`>> ${message}`),
	});
	if (result.exitCode !== 0) {
		console.error(`error: ${result.message}`);
	}
	process.exit(result.exitCode);
}

/**
 * Help GROUP labels for the two-tier surface (ADR §7). commander v14's
 * `command.helpGroup(...)` renders each command under its label heading, so the
 * HEADLINE tier (the surface a user reaches for) lists first and the
 * ADVANCED/PLUMBING tier (kept, but de-emphasised) lists under its own heading
 * — without removing or hiding anything. Headline: run/do/work-on/start/resume/
 * complete/requeue/scan/status + remote add/ls/find. Advanced: claim/prompt/
 * verify/gc + remote rm.
 */
const HEADLINE_GROUP = 'Commands:';
const ADVANCED_GROUP = 'Advanced / plumbing:';
/** Help group for the de-emphasised plumbing FLAGS named in ADR §7. */
const ADVANCED_OPT_GROUP = 'Advanced / plumbing options:';

/**
 * The CLI's own version, read at runtime from the package's `package.json`
 * (the SINGLE source of truth changesets bumps on release) rather than a
 * compiled-in literal that would silently drift on the next version bump.
 *
 * Resolved relative to THIS module (`dist/cli.js` → `../package.json`), so it
 * works regardless of the cwd `dorfl` is invoked from. Best-effort: an
 * unreadable/malformed `package.json` yields `'unknown'` rather than crashing
 * the whole CLI over a `--version` niggle.
 */
function resolvePackageVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const pkgPath = joinPath(here, '..', 'package.json');
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
			version?: string;
		};
		return typeof pkg.version === 'string' && pkg.version.trim() !== ''
			? pkg.version
			: 'unknown';
	} catch {
		return 'unknown';
	}
}

export function buildProgram(): Command {
	const program = new Command();

	program
		.name(brand.bin)
		.description('Autonomous parallel agents over file-based work/ queues.')
		// `-v`/`--version` print the installed CLI version (read from package.json).
		// commander's default flags are `-V, --version`; we ALSO accept lower-case
		// `-v` since that is what most users reach for.
		.version(
			resolvePackageVersion(),
			'-v, --version',
			'print the dorfl version',
		);

	// `dorfl config --json` (spec `graceful-pre-timeout-wip-checkpoint` — step 5):
	// print the RESOLVED per-repo config as JSON, so BOTH the advance-lifecycle
	// workflow's `enumerate` job (which reads it to emit the dynamic
	// `githubTimeout` output) AND a human debugging a config-precedence question
	// share ONE honest primitive. A focused honest primitive — NOT overloaded
	// onto `scan`. Runs in the cwd (in-place), so the resolution chain reads THIS
	// repo's committed `dorfl.json` exactly like `scan --here`.
	program
		.command('config')
		.helpGroup(HEADLINE_GROUP)
		.description(
			"Print the resolved config for the current repo (flag > env > per-repo > global > default). Consumed by the advance-lifecycle workflow's enumerate job to emit the dynamic GitHub timeout backstop (agentDeadlineMinutes + checkpointHeadroomMinutes) at run time from the committed dorfl.json — so editing dorfl.json reflects everywhere (internal deadline AND GitHub cap) on the next tick, no install-ci re-run.",
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option(
			'--arbiter <remote>',
			'name of the arbiter git remote (default: per-repo/global defaultArbiter)',
		)
		.option('--json', 'output the resolved config as JSON')
		.action(
			async (flags: {config?: string; arbiter?: string; json?: boolean}) => {
				if (flags.json !== true) {
					console.error(
						'error: `dorfl config` currently supports only --json output. Pass --json.',
					);
					process.exit(1);
				}
				const cwd = process.cwd();
				const {global, override} = loadGlobalAndOverride(flags.config);
				const resolved = resolveRepoConfig({
					repoPath: cwd,
					global,
					override,
				}).config;
				console.log(JSON.stringify(resolved, null, 2));
			},
		);

	program
		.command('scan')
		.helpGroup(HEADLINE_GROUP)
		.description(
			'Read-only: list the cross-repo queue of work items (across the registered hub mirrors) and whether each is runnable now. Discovery is the registry — the hub-mirror set under workspacesDir/repos/ (no --root/roots).',
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option(
			'--auto-build',
			'allow agents to auto-build undeclared (not humanOnly) tasks',
		)
		.option(
			'--no-auto-build',
			'forbid agents from auto-building undeclared tasks (default)',
		)
		.option(
			'--arbiter-remote <name>',
			`the current repo's arbiter remote to fetch + diff its local section against (default: ${DEFAULT_ARBITER_REMOTE})`,
		)
		.option(
			'--arbiter <remote>',
			'the COORDINATION arbiter remote whose per-item lock refs (refs/dorfl/lock/*) gate the cwd selection pool (held in-flight items are subtracted); default: origin (the same remote claim/do use, NOT the --arbiter-remote divergence name)',
		)
		.option(
			'--here',
			'report ONLY the current repo (the cwd working tree, fetch-first): skip the cross-repo registry loop entirely. The fast, focused path — no N-mirror fetches.',
		)
		.option('--json', 'output the raw report as JSON')
		.action(async (flags: ScanFlags, command: Commander) => {
			const fileConfig = loadConfig(flags.config);
			const override = loadConfigOverride(
				defaultConfigOverridePath(flags.config),
			);
			const config = resolveGlobalConfig(
				fileConfig,
				flagOverrides(flags, command),
			);
			const warn = (message: string) => console.error(`>> ${message}`);
			const resolveCwd = () =>
				resolveCwdSection({
					cwd: process.cwd(),
					config,
					override,
					arbiterRemote: flags.arbiterRemote,
					lockArbiterRemote: flags.arbiter ?? 'origin',
					warn,
				});
			// `--here`: report ONLY the cwd — skip the registry loop ENTIRELY (the fast,
			// focused path, and the CI shape). The report carries an empty `repos[]` so
			// the `--json` consumers (the CI matrix `jq`) read `.cwd.repo.*` exactly as
			// before, with `.repos[]` simply yielding nothing.
			if (flags.here === true) {
				const cwdSection = await resolveCwd();
				const emptyReport = {repos: [], totalItems: 0, totalEligible: 0};
				if (flags.json) {
					console.log(
						JSON.stringify(
							{...emptyReport, cwd: cwdSection},
							(_key, value) => (value instanceof Set ? [...value] : value),
							2,
						),
					);
				} else {
					console.log(formatReport(emptyReport, cwdSection));
				}
				return;
			}
			const report = await scan(config, {warn, override});
			// The cwd-local section: resolve it ONLY when a participating cwd is NOT
			// already covered by a registered mirror. A FETCH-FREE pre-check
			// (`cwdSectionDisposition`) decides this with zero network I/O; an
			// already-registered cwd is skipped so we never re-fetch the SAME arbiter the
			// registry loop just fetched (the `scan-here-and-skip-redundant-cwd`
			// decision), and an UNregistered cwd is still shown standalone so a
			// mirror-less repo you are standing in is never invisible.
			const disposition = cwdSectionDisposition({
				cwd: process.cwd(),
				config,
				arbiterRemote: flags.arbiterRemote,
			});
			const cwdSection =
				disposition.participating && !disposition.alsoRegistered
					? await resolveCwd()
					: undefined;
			if (flags.json) {
				console.log(
					JSON.stringify(
						{...report, cwd: cwdSection},
						(_key, value) => (value instanceof Set ? [...value] : value),
						2,
					),
				);
			} else {
				console.log(formatReport(report, cwdSection));
			}
		});

	program
		.command('run')
		.helpGroup(HEADLINE_GROUP)
		.description(
			'The cross-repo, parallel daemon: loop the supervised tick over the registry — each tick claims up to maxParallel eligible items (perRepoMax per repo), runs the agents CONCURRENTLY in isolation, integrates, then loops (forever, or until a stop bound). Stuck items surface via the needs-attention seam (on main). `run --once` = one debug tick (NOT the CI path — CI is `do`).',
		)
		.option(
			'--once',
			'run a SINGLE supervised tick then stop — the debug/test affordance on the daemon (NOT the CI path; CI uses `do`)',
		)
		.option(
			'--advance',
			'DEPRECATED no-op alias: plain `run` ALREADY drives the registry-set advance tick (build/task with calm-default gates; flip observationTriage / surfaceBlockers for the lifecycle). Passing this warns and is otherwise ignored. The old `--advance <mirror>` single-mirror form is gone — the daemon discovers the whole registry via scan.',
		)
		.option(
			'--max-iterations <n>',
			'stop after N ticks (a bounded session; default: loop forever)',
		)
		.option(
			'--max-duration <seconds>',
			'stop after this many seconds of wall-clock (a bounded session; default: no bound)',
		)
		.option(
			'--interval <seconds>',
			'pause this many seconds between ticks (default: 0, back-to-back)',
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option(
			'--auto-build',
			'allow agents to auto-build undeclared (not humanOnly) tasks',
		)
		.option(
			'--no-auto-build',
			'forbid agents from auto-building undeclared tasks (default)',
		)
		.option('--max-parallel <n>', 'global cap on items claimed+run this tick')
		.option('--per-repo-max <n>', 'per-repo cap on concurrent claims')
		.option('--arbiter <remote>', 'name of the arbiter git remote')
		.option(
			'--integration <mode>',
			'integration mode: propose (default) or merge',
		)
		.option(
			'--no-pr',
			'propose without opening a PR: push the branch but deliberately skip the review request, even on an authed GitHub arbiter (the explicit suppress-PR intent). Resolved flag > env > per-repo > global > default off.',
		)
		.option('--agent-cmd <cmd>', 'command to run one agent on a task prompt')
		.option(
			'--model <id>',
			'model the agent runs on (routing intent; auth/keys stay the harness\u2019s job). pi: passed as --model; null/shell: substitutes a {model} placeholder in agentCmd. Resolved flag > env > per-repo > global > default (unset).',
		)
		.option(
			'--build-model <id>',
			'model the BUILD agent runs on (the builder-specific override of --model). Unset at every level inherits --model. Resolved flag > env > per-repo > global > fallback to model > default (unset).',
		)
		.option(
			'--harness <adapter>',
			'harness adapter that launches the agent + reports liveness: null (default, shells out to agentCmd) or pi (the pi CLI)',
		)
		.option(
			'--pi-bin <path>',
			'pi CLI binary the pi harness invokes (default: pi on PATH)',
		)
		.option(
			'--sessions-dir <dir>',
			'HOST-ONLY root folder under which pi session files are generated (--session <dir>/<id>.jsonl). Default: pi per-cwd folder under ~/.pi/agent/sessions. Resolved flag > env > global > default (no per-repo).',
		)
		.option(
			'--workspace <dir>',
			'execution working area for hub mirrors + job worktrees (default: workspacesDir / ~/.dorfl)',
		)
		.option(
			'--review',
			'run Gate 2 (PR/code review) after verify, before the done-move, on every item (overrides config). Resolved flag > env > per-repo > global > default off.',
		)
		.option('--no-review', 'do NOT run Gate 2 this tick (overrides config)')
		.option(
			'--review-model <id>',
			'model the Gate-2 review agent runs on (de-correlated from the builder; routing intent). Resolved flag > env > per-repo > global > default.',
		)
		.option(
			'--triage-model <id>',
			'model the advance lifecycle gates (surface, apply, triage) run on. Unset at every level inherits --model. Resolved flag > env > per-repo > global > fallback to model > default (unset).',
		)
		.option(
			'--review-max-rounds <n>',
			'bound the revise/review loop; on exhaustion force needs-attention (default 2)',
		)
		.option(
			'--fresh-worktree-gate',
			'run the acceptance gate (prepare then verify) against the REBASED tip in a CLEAN throwaway worktree (the tree that integrates). ON by default; the `run` fleet uses it only when same-repo concurrency is off (perRepoMax=1), else today\u2019s in-build-worktree gate.',
		)
		.option(
			'--no-fresh-worktree-gate',
			'run the acceptance gate in the build worktree (the pre-rebase tree) — the opt-out for when the per-gate install cost is too high',
		)
		.option(
			'--merge-retries <n>',
			'cross-job merge-serialiser CAS-retry cap: a non-fast-forward `${branch}:main` push re-rebases onto the moved <arbiter>/main and retries up to <n> times before a contender bounces to needs-attention. The CAS loop IS the cross-job queue (the in-process integrateLock only serialises sibling integrates in one process), so a wide-matrix CI raises this. Default 1000 (a large liveness ceiling, NOT a small contention budget). Resolved flag > env > per-repo > global > default.',
		)
		.option('--json', 'output the raw result as JSON')
		.action(async (flags: RunFlags, command: Commander) => {
			const fileConfig = loadConfig(flags.config);
			const override = loadConfigOverride(
				defaultConfigOverridePath(flags.config),
			);
			const config = resolveGlobalConfig(
				fileConfig,
				runFlagOverrides(flags, command),
			);
			// The null adapter shells out to agentCmd, so it is required there; the
			// pi adapter invokes the pi CLI directly and does not consume agentCmd.
			// Share the ONE predicate (doNeedsAgentCmd) with `do`/`--remote`.
			if (doNeedsAgentCmd(config)) {
				throw new Error(NO_AGENT_CMD_MESSAGE);
			}
			const workspace = flags.workspace ?? config.workspacesDir;
			// Gate 2 (PR/code review): wire the PRODUCTION harness-backed gate ONLY when
			// `config.review` resolves on (mirror the `do` command). The per-repo review
			// flags are resolved per-item inside `runOneItem`; only the gate SEAM is
			// threaded here. Off ⇒ undefined ⇒ no review (the default). The harness is
			// resolved + threaded exactly as `do` does so a `run --review` daemon under
			// `harness: pi` uses the pi-backed gate (NOT the NullHarness + empty agentCmd
			// default, which would throw "empty agentCmd — nothing would run").
			const harness = createHarness({
				harness: config.harness,
				piBin: config.piBin,
			});
			const reviewGate = config.review
				? harnessReviewGate({harness, agentCmd: config.agentCmd})
				: undefined;
			const onWarn = (message: string) => console.error(`>> ${message}`);

			// Plain `run` (no flag) NOW drives the REGISTRY-SET ADVANCE tick as its
			// per-item unit (task `run-uses-advance-tick`), via the deliberate
			// {@link RunTick} swap seam: the loop machinery (`runLoop`) is UNCHANGED, the
			// tick it loops is the precursor's registry-set advance driver instead of the
			// build-only `runOnce`. With BOTH lifecycle gates at their calm defaults
			// (observationTriage off, surfaceBlockers off) the advance tick degrades to
			// EXACTLY the old build tick's behaviour over the SAME substrate (registry-set
			// discovery + per-mirror job-worktree isolation) — behaviour-preserving today;
			// flip a gate and the SAME tick performs the lifecycle (triage/surface/apply).
			// `run` ≡ CI: the same advance tick, a different cadence.
			const advanceTick = buildRegistrySetAdvanceTick({
				config,
				workspace,
				arbiter: flags.arbiter,
				env: process.env,
				override,
			});
			// `--advance` is now a DEPRECATED NO-OP ALIAS: plain `run` already IS advance,
			// so there is no separate mode to opt into. Warn (but do not fail) so an
			// existing `run --advance` invocation keeps working without surprise.
			if (flags.advance) {
				onWarn(
					'`run --advance` is deprecated and ignored: plain `run` already runs the ' +
						'advance tick (build/task with calm-default gates; set observationTriage ' +
						'/ surfaceBlockers for the lifecycle).',
				);
			}

			const printTick = (result: RunOnceResult): void => {
				if (flags.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}
				for (const item of result.items) {
					console.log(formatItemLine(item));
				}
				console.log(
					`Summary: ${result.claimedAndDone} done, ${result.skipped} skipped, ${result.failed} failed.`,
				);
			};

			// `run --once` = ONE debug tick (NOT the CI path; CI is `do`). The existing
			// `runOnce` IS this tick.
			if (flags.once) {
				// The advance tick IS a RunTick, so `run --once` debug-ticks it (one
				// registry-set advance batch) identically to how it looped.
				const result = await advanceTick({
					config,
					workspace,
					reviewGate,
					onWarn,
				});
				printTick(result);
				return;
			}

			// `run` (no flag) = the cross-repo, parallel, forever-looping DAEMON: loop
			// the concurrent tick over the registry until a stop bound (--max-iterations
			// / --max-duration) or a SIGINT/SIGTERM (graceful shutdown after the current
			// tick). Stuck items surface via the existing needs-attention seam inside the
			// tick — the loop never infinite-retries and adds no bespoke reporting.
			let stopRequested = false;
			const requestStop = (): void => {
				if (!stopRequested) {
					stopRequested = true;
					console.error(
						'>> stop requested — finishing the current tick, then exiting.',
					);
				}
			};
			process.on('SIGINT', requestStop);
			process.on('SIGTERM', requestStop);
			try {
				const summary = await runLoop({
					config,
					workspace,
					reviewGate,
					onWarn,
					// The swap seam: plain `run` ALWAYS drives the registry-set ADVANCE tick
					// (build/task with calm-default gates; the lifecycle when a gate is on).
					tick: advanceTick,
					maxIterations:
						flags.maxIterations !== undefined
							? Number(flags.maxIterations)
							: undefined,
					maxDurationMs:
						flags.maxDuration !== undefined
							? Number(flags.maxDuration) * 1000
							: undefined,
					intervalMs:
						flags.interval !== undefined ? Number(flags.interval) * 1000 : 0,
					stop: () => stopRequested,
					onTick: (result, iteration) => {
						if (!flags.json) {
							console.error(`>> tick ${iteration}:`);
						}
						printTick(result);
					},
				});
				if (!flags.json) {
					console.log(
						`Loop ended (${summary.stoppedBy}) after ${summary.iterations} tick(s): ` +
							`${summary.claimedAndDone} done, ${summary.skipped} skipped, ${summary.failed} failed.`,
					);
				} else {
					console.log(JSON.stringify(summary, null, 2));
				}
			} finally {
				process.off('SIGINT', requestStop);
				process.off('SIGTERM', requestStop);
			}
		});

	program
		.command('verify')
		.helpGroup(ADVANCED_GROUP)
		.description(
			"Run the repo's declared acceptance gate (per-repo `verify` config) and exit with its status (0 = pass). Deterministic shell gate; no model. Read-only with respect to work/.",
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.action(async (flags: VerifyFlags) => {
			// Resolve the gate through the SAME per-repo chain the runner uses
			// (flag > env > per-repo `dorfl.json` > global > default): the standalone
			// `verify` command must honour the repo's COMMITTED `verify`, exactly as
			// its help text ("the repo's declared acceptance gate (per-repo `verify`
			// config)") promises. Reading only the GLOBAL config here silently ran the
			// old built-in default in every repo whose gate lived in `dorfl.json`.
			const cwd = process.cwd();
			const global = loadConfig(flags.config);
			const config = resolveRepoConfig({repoPath: cwd, global}).config;
			// DELIBERATELY verify-ONLY: the standalone `verify` command does NOT run the
			// `prepare` env-prep step first. `verify` is the PURE acceptance gate (env-
			// ready is a separate concern); a human invoking it prepares their own
			// checkout. `prepare` runs only in the runner's fresh-worktree lifecycle
			// (`do`/`run`/`complete` → `performIntegration`), where a fresh job worktree
			// off the hub mirror genuinely needs deps before the gate can be trusted.
			const result = await runVerify({
				cwd,
				verify: config.verify,
			});
			// An unconfigured gate already streamed its precise message to stderr via
			// runVerify; exit non-zero so a human `dorfl verify` fails LOUD (never a
			// vacuous green) with a clear next step, not a stack trace.
			process.exit(result.exitCode);
		});

	program
		.command('claim')
		.helpGroup(ADVANCED_GROUP)
		.description(
			`Atomically claim a ${workFolderPrefix('tasks-ready')}<slug>.md item via a compare-and-swap push to the arbiter (in-process; mirrors scripts/claim.sh).`,
		)
		.argument('<slug>', 'the slug of the backlog item to claim')
		.option(
			'--arbiter <remote>',
			'name of the arbiter git remote (default: origin)',
			'origin',
		)
		.option('--retries <n>', 'cap on push retries when main advances', '3')
		.option('--dry-run', 'show the intended push without mutating the arbiter')
		.option(
			'--ignore-not-ready',
			'override the readiness guard: claim despite an unmet blockedBy, and silence the needsAnswers warning (loud, never default)',
		)
		.action(async (rawSlug: string, flags: ClaimFlags) => {
			// Task-only command (§3a): accept bare + `task:`, reject `spec:`.
			const slug = resolveTaskOnlySlug(rawSlug) as string;
			// Wrap ONLY this CLI surface's `performClaim` call with the spinner
			// helper (task `claim-cas-spinner`): the push can take seconds, so the
			// terminal looked frozen. In non-TTY mode the helper is a no-op and
			// stderr stays byte-identical to today (silent on success,
			// `error: <message>` on failure, `>> <note>` lines unchanged). The
			// autonomous `performClaim` call sites (`do`/`run`/`start`/`work-on`/
			// `continue-branch`) are explicitly OUT OF SCOPE.
			const spinner = createClaimSpinner({
				stream: process.stderr,
				isTTY: process.stdout.isTTY === true,
				clock: {
					setInterval: (fn, ms) => setInterval(fn, ms),
					clearInterval: (handle) =>
						clearInterval(handle as ReturnType<typeof setInterval>),
				},
				label: `Claiming ${slug}\u2026`,
			});
			const onSigint = (): void => {
				spinner.stop();
				process.exit(130);
			};
			process.on('SIGINT', onSigint);
			spinner.start();
			let result;
			try {
				result = await performClaim({
					slug,
					cwd: process.cwd(),
					arbiter: flags.arbiter ?? 'origin',
					retries:
						flags.retries !== undefined ? Number(flags.retries) : undefined,
					dryRun: flags.dryRun,
					humanPath: true,
					override: flags.ignoreNotReady === true,
					// HUMAN command (the `humanPath: true` above already says so): the
					// standalone `claim` CAS micro-commit + push is the human's, so it is
					// NOT given the runner `config.identity`. The AUTONOMOUS claim is the one
					// inside `do`/`run`/`intake` (identity-aware). Thread the ambient
					// `process.env` EXPLICITLY so the human-identity choice is declared at the
					// call site, not left to the seam's silent `?? process.env` fallback.
					env: process.env,
					note: (message) => spinner.note(message),
				});
			} catch (err) {
				// Unhandled error: tear the spinner down cleanly BEFORE the throw
				// propagates so the cursor is restored + no orphaned ANSI state.
				spinner.stop();
				process.off('SIGINT', onSigint);
				throw err;
			}
			spinner.finish(result);
			process.off('SIGINT', onSigint);
			process.exit(result.exitCode);
		});

	program
		.command('start')
		.helpGroup(HEADLINE_GROUP)
		.description(
			'Claim a backlog item (only if needed) and onboard onto its work/<slug> branch in the CURRENT checkout. Decides on the folder on <arbiter>/main, never on a frontmatter field. Launches no agent/editor.',
		)
		.argument(
			'[slug]',
			'the slug to start (inferred from a work/<slug> branch if omitted)',
		)
		.option(
			'--arbiter <remote>',
			'name of the arbiter git remote (default: origin)',
			'origin',
		)
		// `--resume` is now the HIDDEN alias of the `resume` verb (ADR §4/§7): the
		// documented surface is `start` = begin here, `resume` = continue here. Kept
		// (hidden) for muscle memory; addHelpText below points at the verb.
		.addOption(
			new Option(
				'--resume',
				'(hidden alias of the `resume` verb) assert ownership of an already in-progress item: switch to its work branch without claiming',
			).hideHelp(),
		)
		.option(
			'--ignore-not-ready',
			'override the readiness guard: claim despite an unmet blockedBy, and silence the needsAnswers warning (loud, never default)',
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option(
			'--agent',
			'after onboarding, launch the configured harness INTERACTIVELY in the checkout (foreground, you drive it — no prepared prompt). Requires harness: pi. Not a tracked job (no record/gate); you still run `complete`/`requeue`.',
		)
		.option(
			'--harness <name>',
			'harness adapter for --agent: pi (interactive launch requires pi). Resolved flag > env > per-repo > global > default.',
		)
		.option(
			'--model <model>',
			'model the interactive --agent session starts pinned to (routing intent; you may switch inside pi). Resolved flag > env > per-repo > global > default.',
		)
		.option('--pi-bin <path>', 'path to the pi CLI binary (for --agent)')
		.option(
			'--sessions-dir <dir>',
			'HOST-ONLY root folder under which the --agent pi session file is generated',
		)
		.action((rawSlug: string | undefined, flags: StartFlags) =>
			runStartAction(rawSlug, flags, false),
		);

	program
		.command('resume')
		.helpGroup(HEADLINE_GROUP)
		.description(
			'Re-engage an already in-progress item in the CURRENT checkout: switch to its work/<slug> branch WITHOUT claiming (the item is already in-progress; you assert ownership). The human “continue here” verb — the counterpart to `start` (“begin here”). Decides on the folder on <arbiter>/main, never on a frontmatter field. Launches no agent/editor.',
		)
		.argument(
			'[slug]',
			'the slug to resume (inferred from a work/<slug> branch if omitted)',
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option(
			'--arbiter <remote>',
			'name of the arbiter git remote (default: origin)',
			'origin',
		)
		.option(
			'--isolated',
			"re-engage the slug's RETAINED isolated job worktree (the inverse of `do --isolated`) WITHOUT claiming: locate it off THIS repo's arbiter and print its path to cd into. The symmetric companion of `complete --isolated` (finish the stranded worktree).",
		)
		.option(
			'--workspace <dir>',
			'execution working area for job worktrees (--isolated; default: workspacesDir / ~/.dorfl)',
		)
		.action((rawSlug: string | undefined, flags: StartFlags) =>
			runStartAction(rawSlug, flags, true),
		);

	program
		.command('work-on')
		.helpGroup(HEADLINE_GROUP)
		.description(
			'HUMAN command: claim a task and create an isolated worktree in a human-friendly location (under config humanWorktreesDir, NEVER ~/.dorfl) for parallel work, and cd you in by default (via the shell wrapper). Two forms: `work-on <slug>` (in-repo: infer the arbiter from the current repo) and `work-on --remote <r> <slug>` (ensure a hub mirror via repo-mirror, creating if absent) — consistent with `do --remote` (bare = current repo; --remote = anywhere). BOTH claim, then always fetch + branch work/<slug> off the freshly-fetched <arbiter>/main — same claim, same starting commit; only the worktree LOCATION differs. --copy <patterns> copies named gitignored files (copy, not symlink; --copy-from required in remote mode) with a security notice. A binary cannot cd your shell, so install the wrapper `work-on(){ cd "$(dorfl work-on "$@" --print-dir)"; }`; --print-dir is that wrapper’s plumbing (emits ONLY the path).',
		)
		.argument(
			'<slug>',
			'the slug to work on (bare = the task; the target repo is the current one, or --remote <r>)',
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option(
			'--remote <r>',
			'work on a REGISTERED repo with NO checkout: ensure a hub mirror via repo-mirror (creating if absent) and claim against it (consistent with `do --remote`). Omit for the in-repo form (the arbiter is inferred from the current repo).',
		)
		.option(
			'--arbiter <remote>',
			'name of the arbiter git remote in the current repo (in-repo form; default: origin)',
			'origin',
		)
		.addOption(
			new Option(
				'--copy <patterns>',
				'comma-separated gitignored filenames to COPY into the worktree (e.g. .env.local,.env). In-repo: from the current repo; remote: requires --copy-from. Copy, not symlink.',
			).helpGroup(ADVANCED_OPT_GROUP),
		)
		.addOption(
			new Option(
				'--copy-from <path>',
				'source dir for --copy in the remote form (required there; there is no implicit current repo)',
			).helpGroup(ADVANCED_OPT_GROUP),
		)
		.addOption(
			new Option(
				'--print-dir',
				'print ONLY the worktree path to stdout (for a shell wrapper: work-on(){ cd "$(dorfl work-on "$@" --print-dir)"; })',
			).helpGroup(ADVANCED_OPT_GROUP),
		)
		.option(
			'--workspace <dir>',
			'execution working area for hub mirrors (default: workspacesDir / ~/.dorfl)',
		)
		.option(
			'--ignore-not-ready',
			'override the readiness guard: claim despite an unmet blockedBy, and silence the needsAnswers warning (loud, never default)',
		)
		.option(
			'--agent',
			'after creating the worktree, launch the configured harness INTERACTIVELY in it (foreground, you drive it — no prepared prompt). Requires harness: pi. Not a tracked job (no record/gate); you still run `complete`/`requeue`.',
		)
		.option(
			'--harness <name>',
			'harness adapter for --agent: pi (interactive launch requires pi). Resolved flag > env > per-repo > global > default.',
		)
		.option(
			'--model <model>',
			'model the interactive --agent session starts pinned to (routing intent; you may switch inside pi). Resolved flag > env > per-repo > global > default.',
		)
		.option('--pi-bin <path>', 'path to the pi CLI binary (for --agent)')
		.option(
			'--sessions-dir <dir>',
			'HOST-ONLY root folder under which the --agent pi session file is generated',
		)
		.action(async (rawSlug: string, flags: WorkOnFlags) => {
			// The two forms are now distinguished by the `--remote` FLAG (ADR §4,
			// consistent with `do --remote`), not a positional <remote>: bare =
			// the current repo, `--remote <r>` = any registered repo.
			const remote =
				flags.remote !== undefined && flags.remote.trim() !== ''
					? flags.remote
					: undefined;
			// Task-only command (§3a): accept bare + `task:`, reject `spec:`.
			const theSlug = resolveTaskOnlySlug(rawSlug) as string;

			const configPath = flags.config ?? defaultConfigPath();
			const {dir: configuredRoot, config} = loadHumanWorktreesDir(configPath);
			const workspace = flags.workspace ?? config.workspacesDir;

			// --print-dir wants a clean stdout, so all human-facing notes go to
			// stderr; the path is the ONLY thing on stdout (printed below).
			const printDir = flags.printDir === true;
			const result = await performWorkOn({
				slug: theSlug,
				remote,
				cwd: process.cwd(),
				arbiter: flags.arbiter ?? 'origin',
				copy: flags.copy,
				copyFrom: flags.copyFrom,
				override: flags.ignoreNotReady === true,
				workspacesDir: workspace,
				humanWorktreesDir: configuredRoot,
				promptForRoot: (suggestion) => promptForWorktreesRoot(suggestion),
				saveRoot: (chosen) => persistHumanWorktreesDir(chosen, configPath),
				// `--agent`: launch the configured harness INTERACTIVELY in the new
				// worktree after creation (task `agent-interactive-launch`). In-repo
				// mode resolves per-repo config from the current checkout; remote mode
				// (no checkout) resolves from the global config only (like `do --remote`).
				launchInteractive: buildInteractiveLauncher(
					flags,
					configPath,
					remote === undefined ? process.cwd() : undefined,
				),
				// HUMAN command (the description says so): claim + worktree + branch is
				// the human's, NOT given the runner `config.identity`. Ambient
				// `process.env` threaded EXPLICITLY (not the seam's silent fallback).
				env: process.env,
				note: (message) => console.error(`>> ${message}`),
			});
			if (result.exitCode !== 0) {
				console.error(`error: ${result.message}`);
				process.exit(result.exitCode);
			}
			if (printDir) {
				// Path only on stdout, so `cd "$(... --print-dir)"` works.
				process.stdout.write(`${result.dir}\n`);
			}
			process.exit(0);
		});

	program
		.command('prompt')
		.helpGroup(ADVANCED_GROUP)
		.description(
			`Print to stdout the work-agent prompt for a task: the canonical CLAIM-PROTOCOL wrapper + the task's own ## Prompt (with <slug> and source spec substituted). Resolves work/in-progress/<slug>.md then ${workFolderPrefix('tasks-ready')}<slug>.md; infers <slug> from a work/<slug> branch when omitted. Read-only, stdout only — the same assembly the autonomous runner feeds agentCmd.`,
		)
		.argument(
			'[slug]',
			'the slug to render (inferred from a work/<slug> branch if omitted)',
		)
		.action((rawSlug: string | undefined) => {
			// Task-only command (§3a): accept bare + `task:`, reject `spec:`.
			const slug = resolveTaskOnlySlug(rawSlug);
			// Resolve the `promptGuidance` NUDGE namespace through the SAME chain the
			// gate family uses (env > per-repo > global > default), so e.g. a
			// `promptGuidance.testFirst:true` in `dorfl.json` strengthens the
			// wrapper line for `dorfl prompt` exactly as it would in `do`/`run`.
			const cwd = process.cwd();
			const global = loadConfig();
			const resolved = resolveRepoConfig({repoPath: cwd, global}).config;
			const output = renderPrompt({
				slug,
				cwd,
				promptGuidance: resolvePromptGuidance(resolved),
			});
			process.stdout.write(output);
		});

	program
		.command('complete')
		.helpGroup(HEADLINE_GROUP)
		.description(
			'On a work/<slug> branch (slug inferred if omitted): run the gate, mark done (git mv in-progress\u2192done), commit (<type>(<slug>): <summary>; done) the agent\u2019s uncommitted work + the move, rebase onto <arbiter>/main, and integrate. Mode resolved at completion time (--merge/--propose > per-repo > global > default propose): merge\u2192push to main + switch+ff local main; propose\u2192push branch + switch to main (no ff). Then delete the LOCAL work branch iff provably on the arbiter (never the remote); --no-switch stays on the branch and keeps it. Never --force.',
		)
		.argument(
			'[slug]',
			'the slug to complete (inferred from a work/<slug> branch if omitted)',
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option(
			'--arbiter <remote>',
			'name of the arbiter git remote (default: origin)',
			'origin',
		)
		.option(
			'--merge',
			'integrate in merge mode this invocation (mutually exclusive with --propose; overrides config)',
		)
		.option(
			'--propose',
			'integrate in propose mode this invocation (mutually exclusive with --merge; overrides config)',
		)
		.option(
			'--no-pr',
			'propose without opening a PR: push the branch but deliberately skip the review request, even on an authed GitHub arbiter (the explicit suppress-PR intent). Resolved flag > env > per-repo > global > default off.',
		)
		.option(
			'--no-switch',
			'stay on the work/<slug> branch (and keep it) instead of switching back to main',
		)
		.option(
			'--ignore-diverged-main',
			'override the merge-mode divergence guard: complete --merge even when local main is ahead of <arbiter>/main (unpushed). The work still lands on the arbiter; local main is left for you to `git rebase`. Loud, never default.',
		)
		.option(
			'--isolated',
			"FINISH a STRANDED isolated worktree: integrate the slug's already-committed, already-done-moved retained job worktree (a terminal push failed AFTER the done-move+commit) by running ONLY the rebase\u2192integrate tail from the kept commit \u2014 the locate-EXISTING inverse of `do --isolated`. Detection is unspoofable: an already-integrated task is a clean no-op; no retained worktree is a clean \u201cnothing to recover\u201d. --merge/--propose/--arbiter resolve identically to a normal integrate; the already-passed gate is skipped.",
		)
		.option(
			'--workspace <dir>',
			'execution working area for job worktrees (--isolated; default: workspacesDir / ~/.dorfl)',
		)
		.addOption(
			new Option(
				'--skip-verify',
				'skip the acceptance gate (human-only escape hatch; the runner never skips)',
			).helpGroup(ADVANCED_OPT_GROUP),
		)
		.addOption(
			new Option('--type <type>', 'conventional-commit type for the commit')
				.default('feat')
				.helpGroup(ADVANCED_OPT_GROUP),
		)
		.addOption(
			new Option(
				'--message <summary>',
				'commit summary (default: the task title, minus a leading "slug \u2014 " prefix)',
			).helpGroup(ADVANCED_OPT_GROUP),
		)
		.option(
			'--review',
			'run Gate 2 (PR/code review) after verify, before the done-move (overrides config). Resolved flag > per-repo > global > default off.',
		)
		.option(
			'--no-review',
			'do NOT run Gate 2 this invocation (overrides config)',
		)
		.option(
			'--review-model <id>',
			'model the Gate-2 review agent runs on (de-correlated from the builder; routing intent). Resolved flag > env > per-repo > global > default.',
		)
		.option(
			'--review-max-rounds <n>',
			'bound the revise/review loop; on exhaustion force needs-attention (default 2)',
		)
		.option(
			'--fresh-worktree-gate',
			'run the acceptance gate (prepare then verify) against the REBASED tip in a CLEAN throwaway worktree (the tree that integrates). ON by default. Resolved flag > env > per-repo > global > default on.',
		)
		.option(
			'--no-fresh-worktree-gate',
			'run the acceptance gate in the current checkout (the pre-rebase tree) — the opt-out for when the per-gate install cost is too high',
		)
		.option(
			'--merge-retries <n>',
			'cross-job merge-serialiser CAS-retry cap (see `run --help`); resolved flag > env > per-repo > global > default 1000.',
		)
		.action(async (rawSlug: string | undefined, flags: CompleteFlags) => {
			// Task-only command (§3a): accept bare + `task:`, reject `spec:`.
			const slug = resolveTaskOnlySlug(rawSlug);
			const cwd = process.cwd();
			const {global, override} = loadGlobalAndOverride(flags.config);

			// `--isolated`: FINISH a stranded isolated worktree (the recover-already-
			// committed path) instead of completing the current checkout. It LOCATES the
			// slug's retained job worktree off THIS repo's arbiter and runs ONLY the
			// rebase\u2192integrate tail from the kept commit. The slug is REQUIRED (there is no
			// branch to infer it from in the operator's checkout).
			if (flags.isolated === true) {
				if (slug === undefined || slug === '') {
					console.error(
						'error: complete --isolated requires <slug> (the stranded item to finish).',
					);
					process.exit(1);
				}
				const flagMode = integrationFromFlags(flags);
				const resolved = resolveRepoConfig({
					repoPath: cwd,
					global,
					override,
					flags: {
						...(flagMode ? {integration: flagMode} : {}),
						// `--merge-retries <n>` rides the SAME gate-family precedence chain on
						// the isolated-recovery path so a wide-matrix CI's raised cap actually
						// reaches the land tail here too (task
						// `thread-merge-retries-cross-task-and-ratify-default`).
						...mergeRetriesFlagOverrides(flags),
						...noPRFlagOverrides(flags),
					},
				});
				if (resolved.message) {
					console.error(`>> ${resolved.message}`);
				}
				const isoConfig = resolved.config;
				const recovered = await performRecoverIsolated({
					slug,
					cwd,
					arbiter: flags.arbiter ?? isoConfig.defaultArbiter,
					workspacesDir: flags.workspace ?? isoConfig.workspacesDir,
					integration: isoConfig.integration,
					noPR: isoConfig.noPR,
					// The resolved cross-job CAS-retry cap threaded through so the isolated-
					// recovery land tail respects the per-repo cap (same chain as `complete`).
					mergeRetries: isoConfig.mergeRetries,
					note: (message) => console.error(`>> ${message}`),
					env: process.env,
				});
				if (recovered.exitCode !== 0) {
					console.error(`error: ${recovered.message}`);
				}
				process.exit(recovered.exitCode);
			}

			// Resolve the integration mode at completion time, highest first:
			//   --merge/--propose flag > per-repo dorfl.json > global > default.
			// The flag sits at the TOP of the same chain the autonomous runner uses
			// (per-repo > global > default), so human and autonomous paths agree.
			const flagMode = integrationFromFlags(flags);
			const resolved = resolveRepoConfig({
				repoPath: cwd,
				global,
				override,
				// The integrate-time mode AND the Gate-2 review flags ride the SAME
				// flag > env > per-repo > global > default chain.
				flags: {
					...(flagMode ? {integration: flagMode} : {}),
					...reviewFlagOverrides(flags),
					// `--fresh-worktree-gate`/`--no-fresh-worktree-gate` rides the SAME chain.
					...freshWorktreeGateFlagOverrides(flags),
					// `--merge-retries <n>` rides the SAME chain: the cross-job merge-serialiser
					// CAS-retry cap (spec `land-time-reverify-and-parallel-merge-ceiling` Story 5
					// / Applied Answer q1 (a)).
					...mergeRetriesFlagOverrides(flags),
					// `--no-pr` (the PR-INTENT axis) rides the SAME chain.
					...noPRFlagOverrides(flags),
				},
			});
			if (resolved.message) {
				console.error(`>> ${resolved.message}`);
			}
			const config = resolved.config;
			const result = await performComplete({
				slug,
				cwd,
				arbiter: flags.arbiter ?? config.defaultArbiter,
				integration: config.integration,
				// An EXPLICIT `--merge` overrides the untrusted-origin build-propose rule (task
				// `untrusted-origin-forces-build-propose`): `flagMode` is the typed flag
				// (undefined when none), so this is true ONLY when the operator typed
				// `--merge`, never when `merge` was resolved from config.
				explicitMerge: flagMode === 'merge',
				noPR: config.noPR,
				noSwitch: flags.switch === false,
				ignoreDivergedMain: flags.ignoreDivergedMain === true,
				prepare: config.prepare,
				verify: config.verify,
				skipVerify: flags.skipVerify,
				// Gate 2 (PR/code review): when `review` resolves on, run the `review`
				// SKILL as a fresh-context agent (the production harness-backed gate)
				// AFTER the green verify and BEFORE the done-move. The `reviewModel`
				// override flows to the launch through the existing harness seam.
				review: config.review,
				reviewModel: config.reviewModel,
				reviewMaxRounds: config.reviewMaxRounds,
				// Resolve + thread the harness exactly as `do` does so `complete --review`
				// under `harness: pi` builds the pi-backed gate (NOT the NullHarness + empty
				// agentCmd default, which throws "empty agentCmd — nothing would run").
				reviewGate: config.review
					? harnessReviewGate({
							harness: createHarness({
								harness: config.harness,
								piBin: config.piBin,
							}),
							agentCmd: config.agentCmd,
						})
					: undefined,
				// Run the acceptance gate against the REBASED tip in a clean throwaway
				// worktree (the tree that integrates) when ON (the default). `complete` is
				// a single-job path, so the resolved flag is passed UNCONDITIONALLY (no
				// fleet downgrade).
				freshWorktreeGate: config.freshWorktreeGate,
				// Cross-job merge-serialiser CAS-retry cap (spec `land-time-reverify-and-
				// parallel-merge-ceiling` Story 5 / Applied Answer q1 (a)) — the resolved
				// per-repo value reaches the merge loop via `performComplete`→
				// `performIntegration`.
				mergeRetries: config.mergeRetries,
				type: flags.type,
				message: flags.message,
				// Color the propose-mode next-step block only on an interactive
				// stdout TTY (and not under NO_COLOR); plain when piped/redirected.
				color: shouldUseColor(process.stdout),
				note: (message) => console.error(`>> ${message}`),
				// The propose next-step block is printed verbatim (no `>> ` prefix)
				// so its blank lines + heading stand out as the human call-to-action.
				noteBlock: (message) => console.error(message),
				// `complete` is a HUMAN command: a human finishing/merging the work, so
				// the commit/push/PR is THEIRS — it is deliberately NOT given the runner
				// `config.identity` (the autonomous completion is `do`'s own integrated
				// complete, which IS identity-aware). Thread the ambient `process.env`
				// EXPLICITLY so the human-identity choice is declared at the call site,
				// not left to the seam's silent `?? process.env` fallback (parity with
				// `requeue`).
				env: process.env,
			});
			if (result.exitCode !== 0) {
				console.error(`error: ${result.message}`);
			}
			process.exit(result.exitCode);
		});

	program
		.command('do')
		.helpGroup(HEADLINE_GROUP)
		.description(
			"The per-repo WORKER (the CI command): claim + onboard onto work/<slug>, run the agent, gate, integrate, and exit. Builds in an ISOLATED job worktree off THIS repo's arbiter by DEFAULT (task `make-isolated-default-build-mode` — the cwd is the origin SOURCE only; the human working tree is never written). --in-place opts OUT (build in the current checkout, refusing a dirty tree — today's pre-flip behaviour). --isolated remains accepted as a redundant explicit opt-in alias. With --remote <r>: against a REGISTERED repo with NO checkout — materialise a hub mirror + job worktree in the agents\u2019 area, run the same pipeline there, then reap. do <slug> | do task:<slug> | do spec:<slug> (the tasking path) | do (auto-pick one) | do <a> <b> (those, in sequence) | do -n <x> (x eligible, in sequence). Auto-pick draws TASKS-FIRST then SPECS-to-task by default (per-repo selectionOrder reorders the pools). --propose (default) / --merge resolved at integrate-time. Supersedes ar-run.sh.",
		)
		// EXTENSIBLE argument grammar (the three do-* tasks grow this one block):
		// `do-autopick` widens the single optional positional into a VARIADIC one so
		// `do` (zero args = auto-pick), `do <a> <b> …` (named, in sequence), and
		// `do <slug>` (exactly one) all share the one command. `-n <x>` is the count
		// for the auto-pick form. `do` stays SEQUENTIAL (parallelism is `run`).
		.argument(
			'[slugs...]',
			'the item(s) to do: bare (= the task), task:<slug>, or spec:<slug> (task the spec). Zero args = auto-pick; multiple = do them in sequence.',
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option(
			'--arbiter <remote>',
			'name of the arbiter git remote (default: per-repo/global defaultArbiter)',
		)
		.option(
			'-n, --number <x>',
			'AUTO-PICK x eligible items and do them IN SEQUENCE (ordered by selectionOrder, default drain = tasks-first then prds-to-task). Sequential — never a parallelism knob (that is `run`). Mutually exclusive with naming items.',
		)
		.option(
			'--selection-order <order>',
			'order the auto-pick pools (build/task/surface/triage; apply is always first): a preset keyword (drain (default) | groom) or an explicit comma-separated pool list (e.g. build,task,surface,triage). Resolved flag > env > per-repo > global > default.',
		)
		.option(
			'--remote <r>',
			'run against a REGISTERED repo with NO checkout: materialise a hub mirror + job worktree in the agents\u2019 area (auto-registers an unknown remote), run the pipeline there, then reap (never touches the human area)',
		)
		.option(
			'--isolated',
			"build in an ISOLATED job worktree off THIS repo's arbiter (inferred from cwd) instead of taking over the current checkout, then integrate + reap \u2014 NOW THE DEFAULT since `make-isolated-default-build-mode`; the flag remains accepted as a redundant explicit opt-IN alias (some scripts/skills pin it, and it is harmless once implied). Shares the same grammar as the no-checkout forms: a single named item, multiple named items (in sequence), AND -n/auto-pick over the mirror-side eligible-pool scan. Always SEQUENTIAL (parallelism is `run` / the CI matrix). Orthogonal to --remote (a foreign repo); with --remote, remote wins (isolation is already implied). Mutually exclusive with --in-place (contradictory intents).",
		)
		.option(
			'--in-place',
			"OPT OUT of the new isolated default: build in the CURRENT checkout (integrates in place, refuses a dirty tree) \u2014 today's pre-flip behaviour, now explicit. Mutually exclusive with --isolated (contradictory intents) and with --remote (there is no local checkout to take over). Use this for the edit-locally-then-build loop; the default (isolated off the arbiter) never writes the cwd working tree.",
		)
		.option(
			'--merge',
			'integrate in merge mode this invocation (mutually exclusive with --propose; overrides config)',
		)
		.option(
			'--propose',
			'integrate in propose mode this invocation (default; mutually exclusive with --merge; overrides config)',
		)
		.option(
			'--tasks-land-in <where>',
			'where `do spec:<slug>` tasking output lands: `backlog` (staged, not agent-eligible) or `ready` (the agent POOL). The EXPLICIT operator override at the top of the placement precedence (explicit flag > untrusted-origin forces staging > tasksLandIn default > built-in). Resolved flag > env (DORFL_TASKS_LAND_IN) > per-repo > global > built-in.',
		)
		.option(
			'--no-pr',
			'propose without opening a PR: push the branch but deliberately skip the review request, even on an authed GitHub arbiter (the explicit suppress-PR intent). Resolved flag > env > per-repo > global > default off.',
		)
		.option(
			'--ignore-diverged-main',
			'override the in-place divergence guard: run even when local main is ahead of <arbiter>/main (unpushed). The work still lands on the arbiter; local main is left for you to `git rebase`. In-place only; loud, never default.',
		)
		.option(
			'--allow-backlog',
			'do task:<slug> ONLY: also FIND, CLAIM, and COMPLETE a task that lives in tasks/backlog/ (staging), driving it in place WITHOUT promoting it to the pool (so no advance leg / run daemon can claim it out from under you). The done-move goes tasks/backlog/ -> tasks/done/ directly (your explicit drive IS the promotion). EXPLICIT-INVOCATION-ONLY: default off, never set by run/auto-pick/advance or config/env.',
		)
		.option('--agent-cmd <cmd>', 'command to run the agent on the task prompt')
		.option(
			'--model <id>',
			'model the agent runs on (routing intent; resolved flag > env > per-repo > global > default)',
		)
		.option(
			'--build-model <id>',
			'model the BUILD agent runs on (the builder-specific override of --model). Unset at every level inherits --model. Resolved flag > env > per-repo > global > fallback to model > default (unset).',
		)
		.option(
			'--harness <adapter>',
			'harness adapter that launches the agent: null (default, shells out to agentCmd) or pi (the pi CLI)',
		)
		.option(
			'--pi-bin <path>',
			'pi CLI binary the pi harness invokes (default: pi on PATH)',
		)
		.option(
			'--sessions-dir <dir>',
			'HOST-ONLY root folder under which the pi session file is generated (--session <dir>/<id>.jsonl). Default: pi per-cwd folder under ~/.pi/agent/sessions. Resolved flag > env > global > default (no per-repo).',
		)
		.option(
			'--watch',
			"stream the agent's high-signal events live by tailing the pi session log (requires harness: pi; READ-ONLY observer — does not change outcome/gate/git)",
		)
		.option(
			'--review',
			'run Gate 2 (PR/code review) after verify, before the done-move (overrides config). Resolved flag > env > per-repo > global > default off.',
		)
		.option(
			'--no-review',
			'do NOT run Gate 2 this invocation (overrides config)',
		)
		.option(
			'--review-model <id>',
			'model the Gate-2 review agent runs on (de-correlated from the builder; routing intent). Resolved flag > env > per-repo > global > default.',
		)
		.option(
			'--triage-model <id>',
			'model the advance lifecycle gates (surface, apply, triage) run on. Unset at every level inherits --model. Resolved flag > env > per-repo > global > fallback to model > default (unset).',
		)
		.option(
			'--review-max-rounds <n>',
			'bound the revise/review loop; on exhaustion force needs-attention (default 2)',
		)
		.option(
			'--tasker-loop',
			'run the tasker IMPROVER loop on `do spec:<slug>` (review→edit→converge over the produced task set). ON by default; --no-tasker-loop skips it. DISTINCT from the acceptance gate (--review).',
		)
		.option(
			'--no-tasker-loop',
			'skip the tasker improver loop on `do spec:<slug>`',
		)
		.option(
			'--tasker-loop-max <n>',
			'cap the tasker improver loop on `do spec:<slug>` (in-context review passes); on exhaustion with blockers, reject via needsAnswers / route the spec to needs-attention (default 3)',
		)
		.option(
			'--tasker-loop-model <id>',
			'model the tasker improver loop review agent runs on (de-correlated from the tasker; routing intent). Resolved flag > env > per-repo > global > default. DISTINCT from --review-model.',
		)
		.option(
			'--fresh-worktree-gate',
			'run the acceptance gate (prepare then verify) against the REBASED tip in a CLEAN throwaway worktree (the tree that actually integrates), so a green gate provably describes the merged artifact. ON by default. Resolved flag > env > per-repo > global > default on.',
		)
		.option(
			'--no-fresh-worktree-gate',
			"run the acceptance gate in the agent's build worktree (the pre-rebase tree) as before — the opt-out for when the per-gate install cost is too high",
		)
		.option(
			'--merge-retries <n>',
			'cross-job merge-serialiser CAS-retry cap (see `run --help`); resolved flag > env > per-repo > global > default 1000.',
		)
		.action(async (rawSlugs: string[], flags: DoFlags) => {
			// Variadic grammar (`do-autopick`): zero args = AUTO-PICK; one = the single
			// named item; many = those, IN SEQUENCE. `-n <x>` is the auto-pick count.
			const args = rawSlugs ?? [];

			// `-n <x>` parse + validation. It is the AUTO-PICK count (sequential), so it
			// is mutually exclusive with NAMING items (you either auto-pick a count or
			// name the items, not both).
			let count: number | undefined;
			if (flags.number !== undefined) {
				const n = Number(flags.number);
				if (flags.number.trim() === '' || !Number.isInteger(n) || n < 1) {
					console.error(
						`error: -n/--number must be a positive integer (got '${flags.number}').`,
					);
					process.exit(1);
				}
				if (args.length > 0) {
					console.error(
						'error: -n/--number auto-picks a COUNT of eligible items; do not also ' +
							'name items. Use `do -n <x>` OR `do <a> <b> ...`, not both.',
					);
					process.exit(1);
				}
				count = n;
			}

			const cwd = process.cwd();
			const {global, override} = loadGlobalAndOverride(flags.config);
			// Resolve the integration mode at integrate-time, highest first:
			//   --merge/--propose flag > per-repo dorfl.json > global > default.
			// (Same chain `complete` uses — `do` is the autonomous twin.)
			let flagMode;
			try {
				flagMode = integrationFromFlags(flags);
			} catch (err) {
				console.error(
					`error: ${err instanceof Error ? err.message : String(err)}`,
				);
				process.exit(1);
			}

			// `do --remote <r>` / `do --isolated <slug>`: run the NO-CHECKOUT job-worktree
			// pipeline. Both materialise a hub mirror + job worktree in the agents' area
			// (`workspacesDir`) and reap per ADR §4 — the human area is NEVER touched.
			//
			// `--remote <r>` names the TARGETING axis (a FOREIGN repo, no checkout); the
			// arbiter spec is the `<r>` URL. `--isolated` names the ISOLATION intent (a
			// worktree off MY OWN arbiter, even though I am inside the repo); its arbiter
			// URL is RESOLVED FROM THE CWD's arbiter remote (the same `--arbiter` >
			// per-repo/global `defaultArbiter` name in-place `do` uses). The two are
			// ORTHOGONAL: `--isolated` + `--remote` is REDUNDANT (a foreign `--remote` is
			// already isolated), so we accept it and `--remote` WINS (see `## Decisions`).
			//
			// In BOTH cases the repo's COMMITTED `dorfl.json` is reachable on
			// `<arbiter>/main` (the mirror), so we layer it — `flag > env > per-repo >
			// global > default` parity with in-place `do` (task
			// `remote-do-reads-per-repo-config-from-arbiter-main`). Only the whitelisted
			// `REPO_ALLOWED_KEYS` are layered (host-only keys stay global/flag/env-only,
			// rejected by the SAME `repo-config.ts` split).
			// Mutually-exclusive intent guards for the three FORM flags (task
			// `make-isolated-default-build-mode`, D3): `--in-place` opts OUT of the new
			// isolated default, `--isolated` is the redundant explicit opt-IN alias,
			// `--remote <r>` targets a foreign repo. `--in-place` + `--isolated` is
			// contradictory (build here vs build off the arbiter); `--in-place` + `--remote`
			// is nonsensical (there is no local checkout to take over). Reject loudly
			// rather than silently prefer one.
			if (flags.inPlace === true && flags.isolated === true) {
				console.error(
					'error: --in-place and --isolated are contradictory (build in the current ' +
						"checkout vs build in a worktree off this repo's arbiter). Pick one.",
				);
				process.exit(1);
			}
			if (flags.inPlace === true && flags.remote !== undefined) {
				console.error(
					'error: --in-place builds in the CURRENT checkout; --remote <r> targets a ' +
						'REGISTERED repo with NO checkout. Pick one.',
				);
				process.exit(1);
			}
			// The DEFAULT flip (task `make-isolated-default-build-mode`): with no
			// `--remote` and no `--in-place`, `do <slug>` builds in an ISOLATED job
			// worktree off THIS repo's arbiter — the SAME no-checkout path `--isolated`
			// already used. The cwd is the origin SOURCE only (arbiter-remote resolution
			// + per-repo config), never written. `--isolated` remains accepted as a
			// redundant explicit opt-IN alias (D3). `--in-place` opts out to today's
			// in-checkout path (the fall-through below). See ADR §3.
			const isolatedNoRemote =
				flags.remote === undefined && flags.inPlace !== true;
			// Whether the user DEFAULTED into isolated (no form flag typed) vs typed
			// `--isolated` explicitly. Only used to tune the no-arbiter error message so
			// the default path names `--in-place` as its natural escape (D2).
			const defaultedToIsolated = isolatedNoRemote && flags.isolated !== true;
			if (flags.remote !== undefined || isolatedNoRemote) {
				// The form's user-facing name + canonical usage, for the shared error
				// messages below (so isolated errors read in the form's own terms).
				const form = isolatedNoRemote
					? defaultedToIsolated
						? 'do'
						: '--isolated'
					: '--remote';
				const usage = isolatedNoRemote
					? defaultedToIsolated
						? '`do <slug>`'
						: '`do --isolated <slug>`'
					: '`do --remote <r> <slug>`';
				// The no-checkout forms now support the SAME variadic grammar the in-place
				// form does: a single NAMED item, MULTIPLE named items (sequential), and
				// AUTO-PICK / `-n <x>` (sequential) over the MIRROR-SIDE eligible-pool scan
				// (`mirror-side-eligible-pool-scan`). The old inline `-n`×`--remote` REFUSAL
				// is GONE — the mirror scan backs it now (US #25); `-n` stays ALWAYS
				// SEQUENTIAL (parallelism is `run` / the CI matrix). `-n` is still mutually
				// exclusive with naming items (validated above, shared with the in-place form).
				const remoteFlags = doFlagOverrides(flags, flagMode);
				// Resolve the arbiter spec the rest of the pipeline consumes as `remote`.
				// `--remote` supplies it directly (a foreign URL). `--isolated` resolves it
				// from the CWD's arbiter remote (`git remote get-url`); no resolvable
				// arbiter ⇒ a CLEAR error naming `--remote <url>` as the foreign-repo
				// alternative — NOT a confusing URL-parse failure downstream.
				let effectiveRemote: string;
				if (isolatedNoRemote) {
					const bootstrapIdentity = resolveGlobalConfig(
						global,
						remoteFlags,
					).identity;
					const arbiterName =
						flags.arbiter ??
						resolveDefaultArbiterForCwd(cwd, global, remoteFlags, override);
					const resolvedUrl = resolveArbiterUrlFromCheckout(
						cwd,
						arbiterName,
						identityEnv(bootstrapIdentity, process.env),
					);
					if (resolvedUrl === undefined) {
						// Isolated needs an arbiter to build off. Two message variants:
						//   - defaulted-to-isolated (no form flag typed) leads with the DEFAULT
						//     and names `--in-place` as the natural local escape (D2). This is
						//     the ERROR-not-silent-degrade behaviour the flip requires: a repo
						//     with no arbiter must NOT be quietly built in-place invisibly.
						//   - explicit `--isolated` keeps its own terms (the user asked for
						//     isolation deliberately) but ALSO surfaces `--in-place` alongside
						//     `--remote <url>` as the two escapes.
						if (defaultedToIsolated) {
							console.error(
								`error: no arbiter is configured for this repo ` +
									`(no '${arbiterName}' remote), and \`do\` now defaults to ` +
									`building in an ISOLATED worktree off THIS repo's arbiter ` +
									`(task \`make-isolated-default-build-mode\`). Configure an ` +
									`arbiter (e.g. \`dorfl remote add <url>\`), pass --in-place ` +
									`to build in the current checkout, or use --remote <url> to ` +
									`target another repo.`,
							);
						} else {
							console.error(
								`error: --isolated builds in a worktree off this repo's arbiter ` +
									`('${arbiterName}'), but no such arbiter remote is configured/found ` +
									`here. Run inside a participating repo (a clone with an arbiter ` +
									`remote), pass --in-place to build in the current checkout, or ` +
									`use --remote <url> to target another repo.`,
							);
						}
						process.exit(1);
					}
					effectiveRemote = resolvedUrl;
				} else {
					effectiveRemote = flags.remote as string;
				}
				// BOOTSTRAP resolution (global + flags, no per-repo layer) — it supplies
				// the HOST-ONLY keys needed to even reach the arbiter's committed file:
				// `workspacesDir` (where the mirror lives) and `identity` (the git env the
				// mirror fetch runs under). These are host-only by definition (rejected
				// per-repo), so reading them from global+flags first is correct and stable.
				const bootstrap = resolveGlobalConfig(global, remoteFlags);
				// Source the committed `dorfl.json` from `<arbiter>/main` via the
				// hub mirror, then layer ONLY its whitelisted keys through the EXISTING
				// per-repo machinery. The read refreshes ONLY `main` (no-prune), so a
				// `work/<slug>` branch checked out in a stale worktree can never block it,
				// and the build's later all-heads materialisation fetch is unaffected. A
				// config-less repo (no file on
				// main, or an unreachable mirror) → exactly the bootstrap config, i.e.
				// byte-identical to the pre-task global+default behaviour.
				const remoteConfig = resolveRemoteRepoConfig({
					remote: effectiveRemote,
					workspacesDir: bootstrap.workspacesDir,
					global,
					flags: remoteFlags,
					identity: bootstrap.identity,
					note: (message) => console.error(`>> ${message}`),
					override,
				});
				if (doNeedsAgentCmd(remoteConfig)) {
					console.error(`error: ${NO_AGENT_CMD_MESSAGE}`);
					process.exit(1);
				}
				const remoteHarness = createHarness({
					harness: remoteConfig.harness,
					piBin: remoteConfig.piBin,
				});
				// The per-item `DoRemoteOptions` (everything BUT `arg`) — built ONCE and
				// reused for the single-item path AND threaded by the mirror-side auto-pick
				// driver (`performDoRemoteAuto`) to each sequential `performDoRemote`.
				const baseRemoteOptions: Omit<DoRemoteOptions, 'arg'> = {
					remote: effectiveRemote,
					workspacesDir: remoteConfig.workspacesDir,
					arbiter: flags.arbiter ?? remoteConfig.defaultArbiter,
					// Host-only runner IDENTITY — scopes git/provider ops only (not the
					// agent launch); absent ⇒ ambient.
					identity: remoteConfig.identity,
					// `do --remote spec:<slug>` tasking-gate policy (task-build path ignores it).
					autoTask: remoteConfig.autoTask,
					// The resolved `promptGuidance` nudge — threaded into the remote worker
					// prompt (runRemotePipeline → buildAgentPrompt), mirroring in-place `do`.
					promptGuidance: resolvePromptGuidance(remoteConfig),
					integration: remoteConfig.integration,
					// EXPLICIT `--merge` override for the untrusted-origin build-propose rule.
					explicitMerge: flagMode === 'merge',
					// Per-TRANSITION TASKING override (the `do --remote spec:` tasking path).
					taskingIntegration: remoteConfig.taskingIntegration,
					// TASK-PLACEMENT: the configured defaults (trusted + the untrusted twin
					// the tasker selects from the spec's stamp) + the EXPLICIT operator
					// override (`--tasks-land-in`), the top of the placement precedence —
					// mirrors `explicitMerge` (set only when the flag was typed).
					tasksLandIn: remoteConfig.tasksLandIn,
					untrustedTasksLandIn: remoteConfig.untrustedTasksLandIn,
					explicitTasksLandIn: explicitTasksLandInFromFlag(flags.tasksLandIn),
					prepare: remoteConfig.prepare,
					verify: remoteConfig.verify,
					// Single-job build path: gate the REBASED tip (the default) unconditionally.
					freshWorktreeGate: remoteConfig.freshWorktreeGate,
					// Cross-job merge-serialiser CAS-retry cap (resolved through the per-repo
					// chain on the arbiter-side `dorfl.json` too) — spec
					// `land-time-reverify-and-parallel-merge-ceiling` Story 5.
					mergeRetries: remoteConfig.mergeRetries,
					noPR: remoteConfig.noPR,
					harness: remoteHarness,
					agentCmd: remoteConfig.agentCmd,
					model: remoteConfig.buildModel,
					sessionsDir: remoteConfig.sessionsDir,
					review: remoteConfig.review,
					reviewModel: remoteConfig.reviewModel,
					reviewMaxRounds: remoteConfig.reviewMaxRounds,
					reviewGate: remoteConfig.review
						? harnessReviewGate({
								harness: remoteHarness,
								agentCmd: remoteConfig.agentCmd,
							})
						: undefined,
					// The tasker IMPROVER loop on the `do --remote spec:` path is ON by default
					// (auto-tasking has no `verify` floor, so the loop is the task path's
					// quality engine). `--tasker-loop`/`--no-tasker-loop` gates wiring the seam;
					// `taskerLoopMax`/`taskerLoopModel` resolve per-repo (flag > env > per-repo
					// > global > default). DISTINCT from the gate's `--review*` family.
					reviewLoop: remoteConfig.taskerLoop
						? harnessTaskReviewGate({
								harness: remoteHarness,
								agentCmd: remoteConfig.agentCmd,
							})
						: undefined,
					taskerLoopMax: remoteConfig.taskerLoopMax,
					taskerLoopModel: remoteConfig.taskerLoopModel,
					// The task-SET ACCEPTANCE GATE on the `do --remote spec:` path too.
					taskReviewGate: remoteConfig.review
						? harnessTaskAcceptanceGate({
								harness: remoteHarness,
								agentCmd: remoteConfig.agentCmd,
							})
						: undefined,
					watch: flags.watch === true,
					// The dorfl-internal agent deadline + anti-loop ceiling (spec
					// `graceful-pre-timeout-wip-checkpoint`). Threaded from the RESOLVED
					// remote-repo config (its committed `dorfl.json` on <arbiter>/main).
					agentDeadlineMinutes: remoteConfig.agentDeadlineMinutes,
					maxAutoCheckpoints: remoteConfig.maxAutoCheckpoints,
					color: shouldUseColor(process.stdout),
					note: (message) => console.error(`>> ${message}`),
					noteBlock: (message) => console.error(message),
				};

				// DISPATCH the variadic grammar (the NO-CHECKOUT forms):
				//   zero args        -> AUTO-PICK `count` (default 1) over the MIRROR-SIDE
				//                       eligible-pool scan, run SEQUENTIALLY.
				//   one named arg     -> the single-item remote pipeline (unchanged).
				//   many named args   -> those, IN SEQUENCE (operator's order; no pool).
				// `--watch` tails ONE session, so it only fits the single-named-item form;
				// the auto/`-n`/multi forms run many ticks and do not stream a single log.
				const remoteMulti =
					args.length === 0 || count !== undefined || args.length > 1;
				if (remoteMulti && flags.watch === true) {
					console.error(
						`error: --watch streams ONE session; it does not combine with the ` +
							`${form} auto-pick / -n / multi-item forms. Name a single item: ${usage}.`,
					);
					process.exit(1);
				}
				// `--allow-backlog` is EXPLICIT-SINGLE-TASK-ONLY (the leak-fence): it must
				// not combine with the no-checkout auto-pick / -n / multi-item forms
				// (those select FROM the pool). Reject the misuse loudly, mirroring the
				// in-place guard + the `--watch` multi guard above.
				if (remoteMulti && flags.allowBacklog === true) {
					console.error(
						`error: --allow-backlog drives ONE named staged task in place; it does ` +
							`not combine with the ${form} auto-pick / -n / multi-item forms ` +
							`(those select from the pool). Name a single task: ${usage} --allow-backlog.`,
					);
					process.exit(1);
				}
				if (args.length === 0 || count !== undefined) {
					// AUTO-PICK / `-n <x>` over the MIRROR-SIDE eligible-pool scan, SEQUENTIAL.
					const multi = await performDoRemoteAuto({
						...baseRemoteOptions,
						config: remoteConfig,
						count,
						warn: (message) => console.error(`>> ${message}`),
					});
					console.error(`>> ${multi.message}`);
					process.exit(multi.exitCode);
				}
				if (args.length > 1) {
					// EXPLICIT named items, IN SEQUENCE (the operator's order; no pool).
					const multi = await performDoRemoteArgs(args, {
						...baseRemoteOptions,
						config: remoteConfig,
					});
					console.error(`>> ${multi.message}`);
					process.exit(multi.exitCode);
				}

				// Exactly one named item: the single-item remote pipeline.
				// `--allow-backlog` rides ONLY this single-named-task call (never the
				// shared base used by auto-pick / multi) — the leak-fence.
				const remoteResult = await performDoRemote({
					...baseRemoteOptions,
					arg: args[0],
					allowBacklog: flags.allowBacklog === true,
				});
				if (remoteResult.exitCode !== 0) {
					console.error(`error: ${remoteResult.message}`);
				}
				process.exit(remoteResult.exitCode);
			}

			// Thread the `do` CLI flags (--harness/--agent-cmd/--pi-bin/--model)
			// AND the integrate-time mode into the resolved config — the SAME flag
			// override path `run` uses (do-config.doFlagOverrides reuses
			// harnessFlagOverrides). Passing only `{integration}` here silently
			// DROPPED --harness pi etc.; now flag > env > per-repo > global > default
			// holds for `do` as for `run`.
			const resolved = resolveRepoConfig({
				repoPath: cwd,
				global,
				override,
				flags: doFlagOverrides(flags, flagMode),
			});
			if (resolved.message) {
				console.error(`>> ${resolved.message}`);
			}
			const config = resolved.config;
			// The null adapter shells out to agentCmd, so it is required there; the
			// pi adapter invokes the pi CLI directly and does not consume agentCmd.
			if (doNeedsAgentCmd(config)) {
				console.error(`error: ${NO_AGENT_CMD_MESSAGE}`);
				process.exit(1);
			}
			const harness = createHarness({
				harness: config.harness,
				piBin: config.piBin,
			});
			// The per-item `DoOptions` (everything BUT `arg`) — built ONCE and reused for
			// the single-item path AND threaded by the multi-item layer to each
			// sequential `performDo` (do-autopick runs the EXISTING pipeline per item).
			const baseDoOptions: Omit<DoOptions, 'arg'> = {
				cwd,
				arbiter: flags.arbiter ?? config.defaultArbiter,
				// The host-only runner IDENTITY (a bot): scopes the runner's git/provider
				// ops (claim, push, integrate, `gh`) — NEVER the agent launch. Absent ⇒
				// ambient (today's behaviour). Mapped Config → DoOptions like model/agentCmd.
				identity: config.identity,
				// `do spec:<slug>` tasking-gate policy (the task-build path ignores it).
				autoTask: config.autoTask,
				// The resolved `promptGuidance` NUDGE namespace (e.g. `testFirst`),
				// threaded into the worker prompt by performDo → buildAgentPrompt so a
				// per-repo `promptGuidance.testFirst:true` actually strengthens the
				// autonomous `do` worker's wrapper line (not just `dorfl prompt`).
				promptGuidance: resolvePromptGuidance(config),
				integration: config.integration,
				// EXPLICIT `--merge` override for the untrusted-origin build-propose rule (task
				// `untrusted-origin-forces-build-propose`): true ONLY when the operator
				// typed `--merge` (`flagMode`), never when `merge` came from config — so an
				// untrusted-origin task still forces propose under a config `merge`.
				explicitMerge: flagMode === 'merge',
				// Per-TRANSITION TASKING override: the `do spec:` tasking path threads
				// `taskingIntegration ?? integration`; the task-build path stays on
				// `integration`. Unset ⇒ tasking falls back to `integration` (today's behaviour).
				taskingIntegration: config.taskingIntegration,
				// TASK-PLACEMENT (`do spec:` tasking output): the configured default rungs
				// (trusted + the untrusted twin the tasker selects from the spec's stamp) +
				// the EXPLICIT operator override `--tasks-land-in` (top of the precedence).
				// `explicitTasksLandIn` is set ONLY when the flag was typed (mirrors
				// `explicitMerge`).
				tasksLandIn: config.tasksLandIn,
				untrustedTasksLandIn: config.untrustedTasksLandIn,
				explicitTasksLandIn: explicitTasksLandInFromFlag(flags.tasksLandIn),
				// In-place divergence guard override (mirrors --ignore-not-ready).
				ignoreDivergedMain: flags.ignoreDivergedMain === true,
				prepare: config.prepare,
				verify: config.verify,
				// Single-job build path: gate the REBASED tip (the default) unconditionally.
				freshWorktreeGate: config.freshWorktreeGate,
				// Cross-job merge-serialiser CAS-retry cap (spec `land-time-reverify-and-
				// parallel-merge-ceiling` Story 5 / Applied Answer q1 (a)) — resolved per-repo
				// and threaded to `performComplete`→`performIntegration`.
				mergeRetries: config.mergeRetries,
				noPR: config.noPR,
				harness,
				agentCmd: config.agentCmd,
				model: config.buildModel,
				// The HOST-ONLY sessions root (resolved Config → DoOptions bridge, like
				// model/agentCmd): the path generator turns it into
				// `<sessionsDir>/<id>.jsonl` for `--session`. Without this map the key
				// resolves but never reaches the launch (a silent no-op).
				sessionsDir: config.sessionsDir,
				// Gate 2 (PR/code review) rides inside `complete` (so CI inherits it for
				// free): when `review` resolves on, run the `review` SKILL as a
				// fresh-context agent (its OWN harness launch — same adapter + agentCmd,
				// `reviewModel` via the existing model-routing seam) after the green
				// verify, before the done-move. A block routes to needs-attention.
				review: config.review,
				reviewModel: config.reviewModel,
				reviewMaxRounds: config.reviewMaxRounds,
				reviewGate: config.review
					? harnessReviewGate({harness, agentCmd: config.agentCmd})
					: undefined,
				// The tasker IMPROVER loop on the `do spec:` tasking path is ON by default
				// (auto-tasking has no `verify` floor — the loop is the task path's quality
				// engine). `--tasker-loop`/`--no-tasker-loop` gates wiring the seam;
				// `taskerLoopMax`/`taskerLoopModel` resolve per-repo (flag > env > per-repo
				// > global > default); the task-build path ignores all of these. DISTINCT
				// from the acceptance gate's `--review*` family.
				reviewLoop: config.taskerLoop
					? harnessTaskReviewGate({
							harness,
							agentCmd: config.agentCmd,
						})
					: undefined,
				taskerLoopMax: config.taskerLoopMax,
				taskerLoopModel: config.taskerLoopModel,
				// The task-SET ACCEPTANCE GATE (slice-acceptance-gate): the task-path
				// mirror of Gate-2, on the SAME `--review` family (so `--no-review` skips
				// it). ONE-SHOT (no rounds); production wires the task-SET-prompt gate.
				taskReviewGate: config.review
					? harnessTaskAcceptanceGate({harness, agentCmd: config.agentCmd})
					: undefined,
				// `--watch`: tail the pi session log live (pi harness only; the
				// performDo guard errors clearly on any other adapter). READ-ONLY.
				watch: flags.watch === true,
				// The dorfl-internal agent deadline + anti-loop ceiling (spec
				// `graceful-pre-timeout-wip-checkpoint`). Threaded from the resolved
				// per-repo config so an edit to dorfl.json reflects on the NEXT tick.
				agentDeadlineMinutes: config.agentDeadlineMinutes,
				maxAutoCheckpoints: config.maxAutoCheckpoints,
				color: shouldUseColor(process.stdout),
				note: (message) => console.error(`>> ${message}`),
				noteBlock: (message) => console.error(message),
			};

			// `--allow-backlog` is EXPLICIT-SINGLE-TASK-ONLY (spec
			// `do-allow-backlog-drive-staged-tasks-without-promotion`, decision 4): it
			// drives ONE named staged task in place. It must NOT combine with the
			// AUTO-PICK (zero-args / -n) or MULTI-ITEM forms — those select FROM the
			// pool, and letting the flag widen a pool selection is exactly the
			// competition-bug-one-layer-down the fence forbids. Reject the misuse loudly
			// (mirroring the `--watch` multi guard) rather than silently widen a pool.
			if (
				flags.allowBacklog === true &&
				(args.length !== 1 || count !== undefined)
			) {
				console.error(
					'error: --allow-backlog drives ONE named staged task in place; it does ' +
						'not combine with auto-pick / -n / multi-item forms (those select from ' +
						`the pool). Name a single task: dorfl do task:<slug> --allow-backlog.`,
				);
				process.exit(1);
			}

			// DISPATCH the variadic grammar (in-place forms):
			//   zero args         -> AUTO-PICK `count` (default 1) across the two pools
			//                        (ordered by selectionOrder; default drain = tasks-first)
			//   one named arg     -> the single-item pipeline (unchanged from do-in-place)
			//   many named args   -> those, IN SEQUENCE (operator's order; no pool)
			// Auto-pick / multi-arg run the EXISTING `performDo` pipeline per item,
			// sequentially (`do` is sequential; parallelism is `run`).
			if (args.length === 0) {
				const multi: DoMultiResult = await performDoAuto({
					...baseDoOptions,
					config,
					override,
					count,
				});
				console.error(`>> ${multi.message}`);
				process.exit(multi.exitCode);
			}
			if (args.length > 1) {
				const multi: DoMultiResult = await performDoArgs(args, {
					...baseDoOptions,
					config,
				});
				console.error(`>> ${multi.message}`);
				process.exit(multi.exitCode);
			}

			// Exactly one named item: the single-item in-place pipeline (do-in-place).
			// `--allow-backlog` rides ONLY this single-named-task call (never the
			// auto-pick / multi base above) — the leak-fence: the flag is read from the
			// typed CLI flag here, not from config/env, and never reaches a pool path.
			const result = await performDo({
				...baseDoOptions,
				arg: args[0],
				allowBacklog: flags.allowBacklog === true,
			});
			if (result.exitCode !== 0) {
				console.error(`error: ${result.message}`);
			}
			process.exit(result.exitCode);
		});

	// `advance` — the SIBLING top-level verb (NOT a `do` subcommand; `do`
	// subcommands + a standalone `task` verb are REJECTED in spec `advance-loop`).
	// It reuses the SAME shared `prefix:arg` resolver `do` uses, EXTENDED with the
	// `obs:` namespace, and wires the classify → lock → execute SKELETON: classify
	// the rung (read-only, no model, no lock), take the `advancing` CAS borrow, then
	// dispatch winner-only — build/task rungs ORCHESTRATE `do`/`do spec:` (never a
	// duplicate), surface/apply/triage dispatch to a named executor seam later
	// tasks fill. The DRIVERS (one-shot/loop) + `-n` + per-action gates and the
	// rung BODIES are LATER tasks; the bare eligible-SET form errors clearly here.
	program
		.command('advance')
		.helpGroup(HEADLINE_GROUP)
		.description(
			'Advance work/ item(s) one lifecycle rung toward ready/built (SPEC advance-loop), the SEQUENTIAL one-shot driver over the advance tick. advance <slug> (bare = the task) | advance spec:<slug> (the spec tasking rung) | advance obs:<slug> (triage an observation) | advance (auto-pick one eligible) | advance <a> <b> (those, in sequence) | advance -n <x> (x eligible, in sequence). Each item: classify (read-only, no model, no lock) → take the `advancing` CAS lock → dispatch winner-only — build/task rungs ORCHESTRATE `do`/`do spec:`, surface/apply always run, triage respects observationTriage (off|ask|auto). The bare/`-n` selection respects the per-action gates (build→autoBuild, task→autoTask, triage→observationTriage); `-n` is ALWAYS sequential (parallelism is `run` / the CI matrix).',
		)
		.argument(
			'[slugs...]',
			'the item(s) to advance: bare (= the task), task:<slug>, spec:<slug>, or obs:<slug> (an observation). Zero args = auto-pick one eligible; multiple = advance them in sequence.',
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option(
			'--arbiter <remote>',
			'name of the arbiter git remote (default: per-repo/global defaultArbiter)',
		)
		.option(
			'-n, --number <x>',
			'AUTO-PICK x eligible items and advance them IN SEQUENCE (ordered by selectionOrder, default drain = tasks-first then prds-to-task). Sequential — never a parallelism knob (that is `run` / the CI matrix). Mutually exclusive with naming items.',
		)
		.option(
			'--isolated',
			"advance in an ISOLATED worktree off THIS repo's arbiter (inferred from cwd) instead of taking over the current checkout, then integrate + reap — the in-place-but-isolated form. Shares the same grammar: a single named item, multiple named items (in sequence), AND -n/auto-pick over the mirror-side eligible-pool scan. Always SEQUENTIAL (parallelism is `run` / the CI matrix). Lets you advance from a busy/dirty checkout or anywhere with a participating arbiter.",
		)
		.option(
			'--selection-order <order>',
			'order the auto-pick pools (build/task/surface/triage; apply is always first): a preset keyword (drain (default) | groom) or an explicit comma-separated pool list. Resolved flag > env > per-repo > global > default.',
		)
		.option(
			'--observation-triage <mode>',
			'the observation-inbox gate (off|ask|auto): off (default) leaves observations untouched (the triage pool is dropped from auto-pick); ask surfaces a promote/keep/delete question for each untriaged observation; auto auto-disposes the no-question cases (duplicate/map) and asks about the rest. Resolved flag > env > per-repo > global > default. An explicit `advance obs:<slug>` bypasses the selection gate and runs in ask-mode (auto-disposes only under `auto`).',
		)
		.option(
			'--surface-blockers',
			'the declared-blocked-work gate (the orthogonal peer of --observation-triage): render a task/spec carrying needsAnswers:true into an answerable question sidecar (the needsAnswers-blocked pool is enumerated into auto-pick). Resolved flag > env > per-repo > global > default off. An explicit `advance <slug>`/`advance spec:<slug>` bypasses this selection gate and surfaces regardless. Does NOT gate apply (an answered sidecar still applies) or needs-attention (always on).',
		)
		.option(
			'--no-surface-blockers',
			'leave a needsAnswers:true task/spec silently blocked (default; the blocked pool is dropped from auto-pick)',
		)
		.option(
			'--strict-merge-approval',
			'opt in to the host-agnostic "dismiss stale approvals on base change" discipline (spec `land-time-reverify-and-parallel-merge-ceiling` sidecar OQ6): when the merge-base CHANGED between the human’s merge-answer and the apply step, RE-SURFACE the merge-question (clear the answer back to no-answer; re-author the question on main/runner under the advancing lock) instead of auto-landing on a green re-verify. Default OFF (a green re-verify is trusted as sufficient; honour the prior answer). Story #16’s RED-re-verify refusal is UNCHANGED and independent of this flag. Resolved flag > env > per-repo > global > default off.',
		)
		.option(
			'--no-strict-merge-approval',
			'honour the prior merge-answer and land when the rebased tip re-verifies GREEN even if the merge-base changed (default; the cheap green-re-verify-is-enough path)',
		)
		.option(
			'--merge-questions <mode>',
			'the merge-question SURFACER gate (off|ask|auto): off drops the surfacer (only for a repo that lands by some other means); ask (default) enumerates unmerged `work/*` branches and surfaces a merge-question sidecar a human answers; auto self-supplies the `merge` answer and lands via the SAME deterministic apply-time re-verify (the merge-mode-like fast path). SEPARATE axis from --observation-triage with a HIGHER default (a dropped merge-question means pushed work never lands). Resolved flag > env > per-repo > global > default ask.',
		)
		.option(
			'--merge',
			'integrate the advanced item(s) in merge mode this invocation (mutually exclusive with --propose; overrides config). The CI merge shape is a SINGLE SEQUENTIAL job, so this rides the `-n`/named-sequence path, never the matrix.',
		)
		.option(
			'--propose',
			'integrate the advanced item(s) in propose mode this invocation (default; mutually exclusive with --merge; overrides config). The CI propose shape is the parallel matrix (one PR per item).',
		)
		.option(
			'--tasks-land-in <where>',
			'where `advance spec:<slug>` tasking output lands: `backlog` (staged) or `ready` (the agent POOL). The EXPLICIT operator override at the top of the placement precedence. Resolved flag > env (DORFL_TASKS_LAND_IN) > per-repo > global > built-in.',
		)
		.option(
			'--watch',
			"stream the build agent's high-signal events live by tailing the pi session log (requires harness: pi; READ-ONLY observer — does not change outcome/gate/git). The same view `do --watch` gives, threaded through the build rung; CI uses it so the job log shows the agent working instead of freezing.",
		)
		.action(async (rawSlugs: string[], flags: DoFlags) => {
			// Variadic grammar (mirrors `do`): zero args = AUTO-PICK; one = the single
			// named item; many = those, IN SEQUENCE. `-n <x>` is the auto-pick count
			// (ALWAYS sequential, US #25).
			const args = rawSlugs ?? [];

			// `-n <x>` parse + validation — the AUTO-PICK count (sequential), mutually
			// exclusive with NAMING items (the SAME contract `do -n` enforces).
			let count: number | undefined;
			if (flags.number !== undefined) {
				const n = Number(flags.number);
				if (flags.number.trim() === '' || !Number.isInteger(n) || n < 1) {
					console.error(
						`error: -n/--number must be a positive integer (got '${flags.number}').`,
					);
					process.exit(1);
				}
				if (args.length > 0) {
					console.error(
						'error: -n/--number auto-picks a COUNT of eligible items; do not also ' +
							'name items. Use `advance -n <x>` OR `advance <a> <b> ...`, not both.',
					);
					process.exit(1);
				}
				count = n;
			}

			const cwd = process.cwd();
			const {global, override} = loadGlobalAndOverride(flags.config);
			// Resolve the integration mode this invocation asks for, highest first:
			//   --merge/--propose flag > per-repo dorfl.json > global > default.
			// The SAME chain `do`/`complete` use (via `integrationFromFlags`), so the
			// human, the autonomous runner, and the CI workflow all resolve the SAME
			// order. This is what ties the CI dispatch `integrationMode` to the actual
			// open-PR-vs-merge-to-main behaviour: the propose-matrix legs pass
			// `--propose` and the single sequential merge job passes `--merge`, so the
			// integration mode can never DESYNC from the job shape the input selected.
			let flagMode;
			try {
				flagMode = integrationFromFlags(flags);
			} catch (err) {
				console.error(
					`error: ${err instanceof Error ? err.message : String(err)}`,
				);
				process.exit(1);
			}
			// Build the flag overrides (the `--observation-triage` enum FAILS LOUDLY on a
			// typo, like the env coercion) before resolving — a bad gate value is a clean
			// usage error, never silently dropped.
			let doOverrides;
			try {
				doOverrides = doFlagOverrides(flags, flagMode);
			} catch (err) {
				console.error(
					`error: ${err instanceof Error ? err.message : String(err)}`,
				);
				process.exit(1);
			}

			// `advance --isolated`: run the advance TICK in an ISOLATED worktree off
			// THIS repo's arbiter (resolved from cwd), then integrate + reap — the
			// in-place-but-isolated form, the SAME ergonomic `do --isolated` has. We
			// REUSE `do --isolated`'s arbiter-from-cwd resolver + the isolation substrate
			// (`ensureMirror` + the job-worktree `doDriver` + reap), threading the
			// arbiter URL into the NEW isolated advance-tick runner. `--isolated` is the
			// only ISOLATION axis here: `advance --remote <url>` is a SEPARATE concern
			// (the action already TYPES `flags.remote` via `DoFlags`, but no `--remote`
			// plumbing exists on `advance` — see `## Decisions`), so `--isolated` always
			// resolves the arbiter from the CWD.
			if (flags.isolated === true) {
				// BOOTSTRAP resolution (global + flags, no per-repo layer) supplies the
				// host-only keys needed to even reach the arbiter (`workspacesDir`,
				// `identity`), exactly as `do --isolated` bootstraps them.
				const bootstrap = resolveGlobalConfig(global, doOverrides);
				const arbiterName =
					flags.arbiter ??
					resolveDefaultArbiterForCwd(cwd, global, doOverrides, override);
				const arbiterUrl = resolveArbiterUrlFromCheckout(
					cwd,
					arbiterName,
					identityEnv(bootstrap.identity, process.env),
				);
				if (arbiterUrl === undefined) {
					// The SAME clear "isolated against what?" error `do --isolated` gives —
					// naming `--remote <url>` as the foreign-repo alternative, NOT a
					// downstream URL-parse failure.
					console.error(
						`error: --isolated advances in a worktree off this repo's arbiter ` +
							`('${arbiterName}'), but no such arbiter remote is configured/found ` +
							`here. Run inside a participating repo (a clone with an arbiter ` +
							`remote), or use --remote <url> to target another repo.`,
					);
					process.exit(1);
				}
				// Source the arbiter's COMMITTED `dorfl.json` from `<arbiter>/main`
				// via the hub mirror + layer ONLY its whitelisted keys — the SAME
				// resolution `do --isolated` uses, so the gate family (autoBuild/autoTask/
				// observationTriage/surfaceBlockers) + selectionOrder + integration resolve
				// off the arbiter exactly as the in-place advance resolves them off cwd.
				const remoteConfig = resolveRemoteRepoConfig({
					remote: arbiterUrl,
					workspacesDir: bootstrap.workspacesDir,
					global,
					flags: doOverrides,
					identity: bootstrap.identity,
					note: (message) => console.error(`>> ${message}`),
					override,
				});
				if (doNeedsAgentCmd(remoteConfig)) {
					console.error(`error: ${NO_AGENT_CMD_MESSAGE}`);
					process.exit(1);
				}
				const isoHarness = createHarness({
					harness: remoteConfig.harness,
					piBin: remoteConfig.piBin,
				});
				// The base `do` options the build/task rungs ORCHESTRATE through the
				// INJECTED job-worktree driver (the isolated advance-tick runner wires it).
				const isoDoOptions: Omit<DoOptions, 'arg'> = {
					cwd,
					// `--watch`: stream the build agent's session live (pi harness only;
					// validated in `performDo`). Threaded through the orchestrated build rung
					// so `advance --isolated --watch` (and CI) shows the agent working.
					watch: flags.watch === true,
					arbiter: flags.arbiter ?? remoteConfig.defaultArbiter,
					identity: remoteConfig.identity,
					autoTask: remoteConfig.autoTask,
					integration: remoteConfig.integration,
					// EXPLICIT `--merge` override for the untrusted-origin build-propose rule.
					explicitMerge: flagMode === 'merge',
					// Per-TRANSITION TASKING override (the isolated `do --remote spec:` path).
					taskingIntegration: remoteConfig.taskingIntegration,
					// TASK-PLACEMENT: configured defaults (trusted + untrusted twin) + EXPLICIT
					// `--tasks-land-in` override (set only when typed, mirroring `explicitMerge`).
					tasksLandIn: remoteConfig.tasksLandIn,
					untrustedTasksLandIn: remoteConfig.untrustedTasksLandIn,
					explicitTasksLandIn: explicitTasksLandInFromFlag(flags.tasksLandIn),
					prepare: remoteConfig.prepare,
					verify: remoteConfig.verify,
					// Single-job build path: gate the REBASED tip (the default) unconditionally.
					freshWorktreeGate: remoteConfig.freshWorktreeGate,
					// Cross-job merge-serialiser CAS-retry cap — spec
					// `land-time-reverify-and-parallel-merge-ceiling` Story 5.
					mergeRetries: remoteConfig.mergeRetries,
					noPR: remoteConfig.noPR,
					harness: isoHarness,
					agentCmd: remoteConfig.agentCmd,
					model: remoteConfig.buildModel,
					sessionsDir: remoteConfig.sessionsDir,
					review: remoteConfig.review,
					reviewModel: remoteConfig.reviewModel,
					reviewMaxRounds: remoteConfig.reviewMaxRounds,
					reviewGate: remoteConfig.review
						? harnessReviewGate({
								harness: isoHarness,
								agentCmd: remoteConfig.agentCmd,
							})
						: undefined,
					reviewLoop: remoteConfig.taskerLoop
						? harnessTaskReviewGate({
								harness: isoHarness,
								agentCmd: remoteConfig.agentCmd,
							})
						: undefined,
					taskerLoopMax: remoteConfig.taskerLoopMax,
					taskerLoopModel: remoteConfig.taskerLoopModel,
					taskReviewGate: remoteConfig.review
						? harnessTaskAcceptanceGate({
								harness: isoHarness,
								agentCmd: remoteConfig.agentCmd,
							})
						: undefined,
					color: shouldUseColor(process.stdout),
					note: (message) => console.error(`>> ${message}`),
					noteBlock: (message) => console.error(message),
				};
				// The shared per-item ISOLATED advance CONTEXT (everything BUT `arg` and
				// `cwd`/`doDriver`, which the runner supplies from the isolated clone).
				const isoContext: IsolatedAdvanceContext & {
					env: NodeJS.ProcessEnv;
				} = {
					remote: arbiterUrl,
					workspacesDir: remoteConfig.workspacesDir,
					arbiter: flags.arbiter ?? remoteConfig.defaultArbiter,
					doOptions: isoDoOptions,
					surfaceGate: harnessSurfaceGate({
						harness: isoHarness,
						agentCmd: remoteConfig.agentCmd,
					}),
					surfaceModel: remoteConfig.triageModel,
					applyDecide: harnessApplyDecider({
						harness: isoHarness,
						agentCmd: remoteConfig.agentCmd,
					}),
					applyModel: remoteConfig.triageModel,
					observationTriage: remoteConfig.observationTriage,
					triageGate: harnessTriageGate({
						harness: isoHarness,
						agentCmd: remoteConfig.agentCmd,
					}),
					triageModel: remoteConfig.triageModel,
					note: (message) => console.error(`>> ${message}`),
					env: process.env,
				};

				// DISPATCH the variadic grammar, ISOLATED + SEQUENTIAL (mirrors
				// `do --isolated`): zero args / `-n` -> AUTO-PICK over the mirror-side
				// eligible-pool scan; many named -> those in sequence; one named -> the
				// single isolated tick. `-n` stays ALWAYS SEQUENTIAL (US #25).
				if (args.length === 0 || count !== undefined) {
					const multi = await performAdvanceIsolatedAuto({
						...isoContext,
						config: remoteConfig,
						count,
						warn: (message) => console.error(`>> ${message}`),
						lifecycleGates: {
							triage: remoteConfig.observationTriage !== 'off',
							surface: remoteConfig.surfaceBlockers,
							surfaceStaging: remoteConfig.surfaceStaging,
						},
					});
					console.error(`>> ${multi.message}`);
					process.exit(multi.exitCode);
				}
				if (args.length > 1) {
					const multi = await performAdvanceIsolatedArgs(args, {
						...isoContext,
						config: remoteConfig,
					});
					console.error(`>> ${multi.message}`);
					process.exit(multi.exitCode);
				}
				// Exactly one named item: the single ISOLATED advance tick.
				const result = await performAdvanceIsolated({
					...isoContext,
					arg: args[0],
				});
				if (result.exitCode !== 0) {
					console.error(`error: ${result.message}`);
				}
				process.exit(result.exitCode);
			}

			const resolved = resolveRepoConfig({
				repoPath: cwd,
				global,
				override,
				flags: doOverrides,
			});
			if (resolved.message) {
				console.error(`>> ${resolved.message}`);
			}
			const config = resolved.config;
			const harness = createHarness({
				harness: config.harness,
				piBin: config.piBin,
			});
			// The base `do` options the build/task rungs ORCHESTRATE `performDo` with
			// (the ONE build path / ONE task path). `advance` is a driver ON TOP — it
			// hands the resolved arg to `performDo`, never re-implementing it.
			const doOptions: Omit<DoOptions, 'arg'> = {
				cwd,
				// `--watch`: stream the build agent's session live (pi harness only;
				// validated in `performDo`). Threaded through the orchestrated build rung
				// so `advance --watch` (and CI) shows the agent working, not a frozen log.
				watch: flags.watch === true,
				arbiter: flags.arbiter ?? config.defaultArbiter,
				identity: config.identity,
				autoTask: config.autoTask,
				integration: config.integration,
				// EXPLICIT `--merge` override for the untrusted-origin build-propose rule (a
				// bare `advance` auto-pick passes no flag ⇒ unset ⇒ untrusted forces propose).
				explicitMerge: flagMode === 'merge',
				// Per-TRANSITION TASKING override (the `do spec:` tasking path threads
				// `taskingIntegration ?? integration`; the build path stays on `integration`).
				taskingIntegration: config.taskingIntegration,
				// TASK-PLACEMENT: configured defaults (trusted + untrusted twin) + EXPLICIT
				// `--tasks-land-in` override (set only when typed, mirroring `explicitMerge`).
				tasksLandIn: config.tasksLandIn,
				untrustedTasksLandIn: config.untrustedTasksLandIn,
				explicitTasksLandIn: explicitTasksLandInFromFlag(flags.tasksLandIn),
				prepare: config.prepare,
				verify: config.verify,
				// Single-job build path: gate the REBASED tip (the default) unconditionally.
				freshWorktreeGate: config.freshWorktreeGate,
				// Cross-job merge-serialiser CAS-retry cap (spec `land-time-reverify-and-
				// parallel-merge-ceiling` Story 5 / Applied Answer q1 (a)).
				mergeRetries: config.mergeRetries,
				noPR: config.noPR,
				harness,
				agentCmd: config.agentCmd,
				model: config.buildModel,
				sessionsDir: config.sessionsDir,
				review: config.review,
				reviewModel: config.reviewModel,
				reviewMaxRounds: config.reviewMaxRounds,
				reviewGate: config.review
					? harnessReviewGate({harness, agentCmd: config.agentCmd})
					: undefined,
				reviewLoop: config.taskerLoop
					? harnessTaskReviewGate({harness, agentCmd: config.agentCmd})
					: undefined,
				taskerLoopMax: config.taskerLoopMax,
				taskerLoopModel: config.taskerLoopModel,
				taskReviewGate: config.review
					? harnessTaskAcceptanceGate({harness, agentCmd: config.agentCmd})
					: undefined,
				// The dorfl-internal agent deadline + anti-loop ceiling (spec
				// `graceful-pre-timeout-wip-checkpoint`). Threaded from resolved config.
				agentDeadlineMinutes: config.agentDeadlineMinutes,
				maxAutoCheckpoints: config.maxAutoCheckpoints,
				color: shouldUseColor(process.stdout),
				note: (message) => console.error(`>> ${message}`),
				noteBlock: (message) => console.error(message),
			};
			// The shared per-item advance CONTEXT (everything BUT `arg`) — built ONCE
			// and threaded by the one-shot DRIVER to each sequential tick. The SURFACE
			// rung spawns `surface-questions` fresh-context through the SAME harness seam
			// the review gate uses (the engine then PERSISTS); the TRIAGE rung is
			// question-gated by default; `observationTriage: 'auto'` enables the
			// conservative auto-disposition exception (`ask`/`off` surface the question).
			// Surface + apply stay ALWAYS allowed regardless of the gate family.
			const advanceContext: AdvanceContext = {
				cwd,
				arbiter: flags.arbiter ?? config.defaultArbiter,
				doOptions,
				surfaceGate: harnessSurfaceGate({harness, agentCmd: config.agentCmd}),
				surfaceModel: config.triageModel,
				applyDecide: harnessApplyDecider({harness, agentCmd: config.agentCmd}),
				applyModel: config.triageModel,
				observationTriage: config.observationTriage,
				triageGate: harnessTriageGate({harness, agentCmd: config.agentCmd}),
				triageModel: config.triageModel,
				note: (message) => console.error(`>> ${message}`),
			};

			// `--watch` tails ONE pi session, so it only fits the single-named-item form
			// (mirrors `do --watch`). The auto-pick / `-n` / multi-item forms run many
			// ticks in sequence and would tail several logs; reject rather than silently
			// stream only one. The CI propose matrix names a single item per leg, so it
			// satisfies this; the `-n` merge job must NOT pass `--watch`.
			const advanceMulti =
				args.length === 0 || count !== undefined || args.length > 1;
			if (advanceMulti && flags.watch === true) {
				console.error(
					'error: --watch streams ONE session; it does not combine with the ' +
						'auto-pick / -n / multi-item forms. Name a single item.',
				);
				process.exit(1);
			}

			// DISPATCH the variadic grammar (the one-shot SEQUENTIAL driver):
			//   zero args       -> AUTO-PICK `count` (default 1) over the eligible pool
			//                      (tasks-first then prds-to-task; per-action gates
			//                      respected by the SELECTION layer; ordered by selectionOrder).
			//   one named arg   -> the single-item tick (the always-allowed surface/apply
			//                      path runs regardless of the gate family).
			//   many named args -> those, IN SEQUENCE (operator's order; no pool).
			// `-n` / auto-pick / multi-arg all run the EXISTING tick per item,
			// SEQUENTIALLY (parallelism is `run` / the CI matrix, never `-n`).
			if (args.length === 0) {
				const multi: AdvanceMultiResult = await performAdvanceAuto({
					...advanceContext,
					config,
					override,
					count,
					// The SELECTION-layer gates: `observationTriage != off` enumerates the
					// observation (triage) pool into auto-pick; `surfaceBlockers` enumerates
					// the `needsAnswers`-blocked (surface) pool. `off`/`false` drops the
					// respective pool (its item is left untouched / silently blocked). The
					// two gates are orthogonal peers. The triage rung's ask-vs-auto
					// distinction is read inside the tick from `observationTriage` (threaded
					// on `advanceContext`). Apply (consume) is always-on (never gated here).
					lifecycleGates: {
						triage: config.observationTriage !== 'off',
						surface: config.surfaceBlockers,
						surfaceStaging: config.surfaceStaging,
					},
				});
				console.error(`>> ${multi.message}`);
				process.exit(multi.exitCode);
			}
			if (args.length > 1) {
				const multi: AdvanceMultiResult = await performAdvanceArgs(args, {
					...advanceContext,
					config,
				});
				console.error(`>> ${multi.message}`);
				process.exit(multi.exitCode);
			}

			// Exactly one named item: the single-item tick. Wrapped in the shared
			// in-place tree-less publish so a surfaced sidecar / `triaged:` marker /
			// applied-answer commit reaches the arbiter's `main` (the CI ephemeral-runner
			// case — the local commit would otherwise be lost). The wrapper is the SAME
			// gate the `--isolated` / loop drivers use (`TREELESS_RUNGS` + exit 0 +
			// arbiter configured); a build/task rung integrates through the `doDriver`
			// band already, and a no-arbiter laptop checkout sits on the real `main`.
			const result = await runAdvanceTickWithTreelessPublish(
				{...advanceContext, arg: args[0]},
				performAdvance,
			);
			if (result.exitCode !== 0) {
				console.error(`error: ${result.message}`);
			}
			process.exit(result.exitCode);
		});

	program
		.command('gc')
		.helpGroup(ADVANCED_GROUP)
		.description(
			'Re-apply the provably-safe deletion predicate (ADR \u00a74) to job worktrees under workspacesDir/work/*: reap the provably-safe ones (clean tree AND branch tip reachable on the arbiter \u2014 merged or pushed) via git worktree remove (+ prune, never rm -rf), and report each RETAINED one with a reason. The catch-up for when end-of-job auto-reap did not run (runner crash/kill). SCOPE: by DEFAULT this is ARBITER-SCOPED \u2014 it acts ONLY on worktrees belonging to the arbiter resolved from the cwd (the same arbiter do --isolated/the mirror uses), so a gc in repo A can never reap repo B\u2019s worktrees. Pass --all-arbiters to sweep across EVERY arbiter (loud + global), or --arbiter <remote-or-url> to target a specific one. --force overrides the predicate (discards un-saved work) and requires --yes \u2014 loud, never default; --all-arbiters --force must be opted into explicitly, never reached by default.',
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option(
			'--workspace <dir>',
			'execution working area to sweep (default: workspacesDir / ~/.dorfl)',
		)
		.option(
			'--force',
			'OVERRIDE the predicate: remove worktrees even with un-saved work (requires --yes; never the default)',
		)
		.option('--yes', 'confirm a destructive --force sweep non-interactively')
		.option(
			'--ledger [repoPath]',
			'SWEEP the work/ lifecycle LEDGER instead of job worktrees: REPORT (never delete) every slug present in more than one work/ status folder (the one-slug-one-folder belt-and-suspenders), with its folders + candidate canonical folder, for a HUMAN to resolve. Defaults to the cwd repo.',
		)
		.option(
			'--reap-stale-locks',
			'(with --ledger) OPT-IN: also CLEAR every ORPHAN lock the report finds via the SAME leased delete `release-lock` uses, so one command sweeps all orphaned locks instead of N hand-run release-locks. Reaps the `cleared-stale` class: a held `active` lock that is EITHER terminal on `<arbiter>/main` (stranded between the durable move and the release) OR non-terminal + SURFACED (`needsAnswers:true` + sidecar on `<arbiter>/main`) = the crash-window orphan the ordered bounce transition leaves when step 1 lands but step 2 never runs. A `kept-in-flight` (active + non-terminal + NOT surfaced — a healthy build) is NEVER reaped, even with this flag. A concurrent change to a lock ref makes its leased delete REJECT (reported), never --force. WITHOUT this flag `gc --ledger` stays report-only (fail-loud, deletes nothing).',
		)
		.option(
			'--remote-branches',
			'SWEEP the arbiter’s remote work/* BRANCHES instead of job worktrees: delete (via git push --delete, NEVER --force) exactly those PROVABLY MERGED into <arbiter>/main (git merge-base --is-ancestor, the SAME predicate the worktree reaper uses), and RETAIN the rest with a reason. An in-flight/un-merged branch (the recovery point) is NEVER touched. Provider-agnostic plain git — works on a --bare arbiter. The merged-only complement of `requeue --reset`.',
		)
		.option(
			'--arbiter <remote-or-url>',
			'SCOPE the worktree sweep to a SPECIFIC arbiter (a remote NAME resolved from --cwd, or a direct arbiter URL) instead of the cwd\u2019s. (With --remote-branches / --ledger it names the arbiter git remote whose work/* branches / locks to sweep; default there: origin.)',
		)
		.option(
			'--all-arbiters',
			'GLOBAL, LOUD override: sweep worktrees across EVERY arbiter under workspacesDir/work/* (today\u2019s pre-scoping behaviour), not just the cwd\u2019s. Prints a banner naming every arbiter it will act on before doing anything; combining it with --force still requires --yes. This is the destructive cross-repo path \u2014 opt into it explicitly.',
		)
		.option(
			'--cwd <dir>',
			'(with --remote-branches) the local repo/clone whose --arbiter remote points at the arbiter to sweep (default: cwd); only remote refs are read + deleted, never the working tree',
		)
		.option(
			'--dry-run',
			'(with --remote-branches) REPORT which merged branches WOULD be reaped without deleting anything (a read-only preview)',
		)
		.option('--json', 'output the raw result as JSON')
		.action(async (flags: GcFlags) => {
			const config = resolveGlobalConfig(loadConfig(flags.config), {});
			const workspacesDir = flags.workspace ?? config.workspacesDir;

			// The `gc`-STYLE ledger SWEEP (spec `ledger-integrity` story 3): a SEPARATE
			// surface from the worktree reaper below — it REPORTS one-slug-one-folder
			// violations in a repo's `work/` lifecycle ledger and NEVER deletes (a human
			// resolves each). Distinct `work/`: the ledger, not the execution substrate.
			if (flags.ledger !== undefined) {
				const repoPath =
					typeof flags.ledger === 'string' ? flags.ledger : process.cwd();
				const result = sweepLedgerDuplicates(repoPath);
				// The UNIFIED-LOCK stuck/orphaned-lock REPORT (task
				// `release-lock-verb-and-gc-stuck-report`, spec
				// `ledger-status-per-item-lock-refs` US #12/#13/#14): generalises the
				// advancing-marker report from advancing-only to the unified per-item
				// lock. The locks live on the ARBITER ref (`refs/dorfl/lock/*`),
				// not in the local tree, so this reads the arbiter (cwd's `--arbiter`
				// remote). Best-effort: an absent lock-ref namespace / unreachable arbiter
				// degrades to an EMPTY report ("all locks released" — recoverable, US #12),
				// exactly as an absent lock-ref namespace reads. It REPORTS only,
				// wiring `reconcileItemLockAgainstMain`'s read-only twin to DISTINGUISH a
				// held/stuck lock from a stale-active lock over a terminal item WITHOUT
				// clearing (no auto-sweep; a human asserts a lock is dead via
				// `release-lock`).
				// OPT-IN SWEEP (`--reap-stale-locks`): the WRITE twin of the report. A
				// human asserting "clear the dead TERMINAL locks now": for BOTH
				// terminal-on-main orphan classes (task `reaper-reap-terminal-stuck-lock-orphans`;
				// ADR `ledger-status-on-per-item-lock-refs` § Addendum 2026-07-10) — the
				// stranded `cleared-stale` AND the stuck-terminal `cleared-stuck-terminal`
				// crash-orphan — perform the SAME leased delete `release-lock` / the
				// recovery use, so one command sweeps every orphaned terminal lock. A
				// `kept-stuck` (STUCK + NON-terminal) / `kept-in-flight` lock is NEVER
				// reaped (scope fence); a concurrent change makes a clear REJECT (reported
				// `lost`), never --force. WITHOUT the flag the surface below stays
				// report-only (fail-loud, deletes nothing).
				if (flags.reapStaleLocks) {
					const reap = await reapStaleItemLocks(
						flags.cwd ?? repoPath,
						flags.arbiter ?? 'origin',
						process.env,
					);
					if (flags.json) {
						console.log(JSON.stringify({...result, reap}, null, 2));
					} else {
						const reapLines = formatReapReport(reap);
						const blocks: string[] = [];
						if (result.duplicates.length > 0) {
							blocks.push(formatLedgerSweep(result));
						}
						if (reapLines.length > 0) {
							blocks.push(reapLines.join('\n'));
						}
						console.log(
							blocks.length > 0
								? blocks.join('\n\n')
								: formatLedgerSweep(result),
						);
					}
					// Fail-loud AFTER the sweep: a `kept-stuck` (STUCK + non-terminal —
					// rightly left for a human) or a `lost`/`error` (an orphan lock whose
					// leased delete lost the race) still needs attention; a clean sweep
					// that reaped every orphan lock (stale OR stuck-terminal) and left only
					// healthy in-flight holds exits 0.
					process.exit(
						result.duplicates.length > 0 || reapReportNeedsAttention(reap)
							? 1
							: 0,
					);
				}
				const lockReport = await reportItemLocks(
					flags.cwd ?? repoPath,
					flags.arbiter ?? 'origin',
					process.env,
				);
				if (flags.json) {
					console.log(JSON.stringify({...result, lockReport}, null, 2));
				} else {
					const lockLines = formatItemLockReport(lockReport);
					if (result.duplicates.length === 0 && lockLines.length === 0) {
						console.log(formatLedgerSweep(result));
					} else {
						const blocks: string[] = [];
						const sweepText = formatLedgerSweep(result);
						// Only print the duplicate block when it found something (otherwise
						// it returns the "clean" line, which is misleading when there ARE
						// lingering locks below it).
						if (result.duplicates.length > 0) {
							blocks.push(sweepText);
						}
						if (lockLines.length > 0) {
							blocks.push(lockLines.join('\n'));
						}
						console.log(blocks.join('\n\n'));
					}
				}
				// A corrupt ledger, a stuck advancing-lock marker, OR a per-item lock that
				// NEEDS HUMAN ATTENTION is a fail-loud condition: exit non-zero so a human
				// (or a script) cannot miss it, mirroring the integration core's refusal.
				// ALL are REPORTED here (never auto-deleted — no automatic sweep exists; a
				// human clears a NAMED unified lock via `release-lock`).
				//
				// SCOPED to the ATTENTION verdicts only (spec US#14/#21, ADR
				// `ledger-status-on-per-item-lock-refs` § Addendum 2026-07-10: this surface
				// is the STUCK / crash-orphaned lock, NOT every held one): a `kept-stuck`
				// (STUCK + NON-terminal — the genuine human-attention case), a
				// `cleared-stale`-eligible (terminal + stale active = stranded orphan), or
				// a `cleared-stuck-terminal`-eligible (terminal + stuck = crash-orphan the
				// reaper can now auto-clear) fails loud, but a `kept-in-flight` (active,
				// non-terminal) lock is the NORMAL in-flight state of a healthy concurrent
				// build (read by `status` as healthy) — it is reported informationally
				// and does NOT make a routine `gc --ledger` health check exit non-zero.
				process.exit(
					result.duplicates.length > 0 ||
						itemLockReportNeedsAttention(lockReport)
						? 1
						: 0,
				);
			}

			// The REMOTE merged-BRANCH sweep (this task): a SEPARATE surface from the
			// worktree reaper below — it deletes PROVABLY-MERGED remote `work/*` branches
			// on the arbiter (the cross-machine counterpart of reaping local worktrees),
			// guarded by the SAME ancestor-of-main predicate. Provider-agnostic plain git
			// (works on a `--bare` arbiter); NEVER `--force` (a merged ref needs none),
			// NEVER touches an in-flight branch.
			if (flags.remoteBranches) {
				const sweepCwd = flags.cwd ?? process.cwd();
				const sweep = sweepRemoteMergedBranches({
					cwd: sweepCwd,
					arbiter: flags.arbiter ?? 'origin',
					dryRun: flags.dryRun === true,
					note: (message) => console.error(`>> ${message}`),
				});
				// The ORPHAN-SIDECAR sweep (spec
				// `agentic-question-resolution-retire-disposition-vocabulary`, US #10) rides
				// the SAME `--remote-branches` invocation the SCHEDULED CI lifecycle workflow
				// runs (`dorfl gc --remote-branches --arbiter origin`) — so the reap of a
				// `work/questions/<type>-<slug>.md` whose source item was deleted out-of-band
				// actually FIRES on the cron tick (not behind an un-passed flag). It operates
				// on the WORKING TREE of the checkout `gc` runs in (the same `cwd` the branch
				// sweep targets) — CI checks out the repo — so no arbiter ref query is needed
				// beyond the by-identity source-existence check
				// (`resolveItemPathByIdentity`). A `git rm` deletion (notes/sidecars leave by
				// deletion; git history is the archive), so a wrong source-delete is
				// recoverable from history. Honours `--dry-run` (report-only preview).
				const orphans = sweepOrphanSidecars({
					cwd: sweepCwd,
					dryRun: flags.dryRun === true,
					note: (message) => console.error(`>> ${message}`),
				});
				if (flags.json) {
					console.log(
						JSON.stringify({...sweep, orphanSidecars: orphans}, null, 2),
					);
					return;
				}
				if (flags.dryRun === true) {
					for (const w of sweep.wouldReap) {
						console.log(`  [would-reap] ${w.branch} \u2014 merged`);
					}
					for (const w of orphans.wouldReap) {
						console.log(`  [would-reap] ${w.path} \u2014 orphan sidecar`);
					}
				} else {
					for (const r of sweep.reaped) {
						console.log(`  [reaped]   ${r.branch} \u2014 merged`);
					}
					for (const r of orphans.reaped) {
						console.log(`  [reaped]   ${r.path} \u2014 orphan sidecar`);
					}
				}
				for (const ret of sweep.retained) {
					console.log(`  [retained] ${ret.branch} \u2014 ${ret.reasonText}`);
				}
				const reapedCount =
					flags.dryRun === true
						? sweep.wouldReap.length + orphans.wouldReap.length
						: sweep.reaped.length + orphans.reaped.length;
				const verb = flags.dryRun === true ? 'would reap' : 'reaped';
				console.log(
					`Summary: ${reapedCount} ${verb}, ${sweep.retained.length} retained.`,
				);
				return;
			}

			// SCOPE RESOLUTION (this task): the worktree reaper is ARBITER-SCOPED by
			// default. `--all-arbiters` restores the GLOBAL (cross-arbiter) sweep behind
			// a LOUD banner; `--arbiter <remote-or-url>` targets a specific arbiter; the
			// bare default resolves the arbiter from the cwd (the SAME resolution
			// `do --isolated` / the mirror uses). With NO resolvable cwd arbiter and
			// neither flag, we REFUSE (never silently fall back to global) — gc used to
			// default to global, and a global `gc --force --yes` from repo A could
			// irreversibly discard repo B's un-pushed work.
			let arbiterKey: string | undefined;
			if (flags.allArbiters !== true) {
				if (flags.arbiter !== undefined && flags.arbiter.trim() !== '') {
					// An explicit arbiter: a direct URL (contains `://`, a scp-like `:`,
					// or an absolute path) is keyed directly; otherwise it is a remote NAME
					// resolved from the cwd (default `origin`).
					const spec = flags.arbiter.trim();
					const looksLikeUrl =
						spec.includes('://') ||
						spec.startsWith('/') ||
						/^[^/]+@/.test(spec);
					// A remote NAME resolves from --cwd if given (consistent with the
					// other gc sub-modes), else the process cwd.
					const resolveFrom = flags.cwd ?? process.cwd();
					arbiterKey = looksLikeUrl
						? encodeRepoKey(spec)
						: resolveArbiterKeyFromCwd(resolveFrom, spec, process.env);
					if (arbiterKey === undefined) {
						console.error(
							`refusing: could not resolve arbiter '${spec}' \u2014 not a URL and ` +
								'no git remote with that name in the cwd. Pass a remote name that ' +
								'exists here, an arbiter URL, or --all-arbiters.',
						);
						process.exit(1);
					}
				} else {
					arbiterKey = resolveArbiterKeyFromCwd(
						flags.cwd ?? process.cwd(),
						config.defaultArbiter,
						process.env,
					);
					if (arbiterKey === undefined) {
						console.error(
							'refusing: `gc` is now ARBITER-SCOPED and could not resolve an ' +
								`arbiter from the current directory (no '${config.defaultArbiter}' ` +
								'git remote, or not inside a repo). It will NOT fall back to a ' +
								'global cross-arbiter sweep. Run it from a repo with an arbiter ' +
								'remote, pass --arbiter <remote-or-url>, or --all-arbiters to sweep ' +
								'every arbiter.',
						);
						process.exit(1);
					}
				}
			} else {
				// GLOBAL sweep: LOUD banner naming EVERY arbiter it will act on before
				// doing anything (this task's "loud" requirement). Global + --force must be
				// opted into explicitly (the --yes gate below still applies), never reached
				// by default.
				const arbiters = enumerateWorkspaceArbiters(workspacesDir, process.env);
				console.error(
					'>> --all-arbiters: operating GLOBALLY across ALL arbiters under ' +
						`${workspacesDir}/work/* (NOT scoped to the current repo).`,
				);
				if (arbiters.length > 0) {
					console.error('>> arbiters in scope:');
					for (const a of arbiters) {
						console.error(`>>   - ${a.url ?? a.key ?? '(malformed mirror)'}`);
					}
				} else {
					console.error('>> (no worktrees found under any arbiter)');
				}
			}

			// `--force` discards un-saved work, so it is gated behind an explicit
			// confirmation (`--yes`) — loud + intentional, NEVER the default (ADR §4).
			if (flags.force && !flags.yes) {
				console.error(
					'refusing to --force without --yes: this DISCARDS un-saved work in ' +
						'retained worktrees (commits not on the arbiter, dirty trees). ' +
						'Re-run with `gc --force --yes` to confirm.',
				);
				process.exit(1);
			}
			if (flags.force) {
				console.error(
					'>> --force: OVERRIDING the deletion-safety predicate; un-saved work ' +
						'in retained worktrees will be DISCARDED.',
				);
			}

			const result = gc({
				workspacesDir,
				arbiterKey,
				force: flags.force === true,
				note: (message) => console.error(`>> ${message}`),
			});

			if (flags.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}
			for (const reaped of result.reaped) {
				const how = reaped.forced
					? 'FORCED (discarded un-saved work)'
					: (reaped.verdict.reachableVia ?? 'safe');
				console.log(`  [reaped]   ${reaped.slug} \u2014 ${how}`);
			}
			for (const retained of result.retained) {
				console.log(
					`  [retained] ${retained.slug} \u2014 ${RETAIN_REASON_TEXT[retained.reason]}`,
				);
			}
			for (const orphan of result.sweptOrphans) {
				console.log(`  [swept]    ${orphan.dir} \u2014 ${orphan.kind}`);
			}
			const orphanNote =
				result.sweptOrphans.length > 0
					? `, ${result.sweptOrphans.length} orphan(s) swept`
					: '';
			console.log(
				`Summary: ${result.reaped.length} reaped, ${result.retained.length} retained${orphanNote}.`,
			);
		});

	// `dorfl sync`: bring an already-onboarded repo up to the CURRENT protocol.
	// Always re-syncs `work/protocol/*` + bumps VERSION (the deterministic slice of
	// `setup`, shared with `prd-to-spec` via `resync-protocol.ts`). `--add-skills`
	// ADDITIONALLY (re-)installs the packaged skills into the operator's harness
	// dir(s), NON-INTERACTIVELY (the flag IS the confirmation); without it an
	// interactive session PROMPTS once and a non-TTY session skips skills.
	program
		.command('sync')
		.helpGroup(HEADLINE_GROUP)
		.description(
			"Bring THIS repo up to the current dorfl protocol: re-sync work/protocol/* from the package's canonical contract docs and bump work/protocol/VERSION (idempotent — a no-op when already current). This is how a repo that adopted an older protocol picks up the latest. Optionally ALSO (re-)installs the packaged dorfl skills into your own harness: pass --add-skills to do it non-interactively (the flag bypasses the ask), otherwise an interactive run prompts once (a non-TTY run skips skills). Runs IN-PLACE (no git commit/push — the human commits the result).",
		)
		.option('--repo <dir>', 'the repo working-tree root to sync (default: cwd)')
		.option(
			'--dry-run',
			'REPORT what the protocol re-sync WOULD change, touching nothing (no writes; skills are never installed under --dry-run)',
		)
		.option(
			'--add-skills',
			'ALSO (re-)install the packaged dorfl skills into your own harness dir(s), non-interactively. This flag IS the confirmation — it bypasses the interactive ask.',
		)
		.option(
			'--local',
			'with skills install: scope to <cwd>/.agents/skills/ instead of the global ~/.agents/skills/ default',
		)
		.option('--json', 'output the raw protocol re-sync result as JSON')
		.action(async (flags: SyncFlags) => {
			const repoPath = flags.repo ?? process.cwd();
			const dryRun = flags.dryRun === true;

			// 1. The deterministic protocol re-sync (always runs).
			const resync = resyncProtocol(repoPath, {
				dryRun,
				sourceCommit: 'dorfl sync',
			});
			if (flags.json) {
				console.log(JSON.stringify(resync, null, 2));
			} else {
				console.log(formatSyncReport(resync, dryRun));
			}

			// A doc whose source could not be resolved is a broken package — exit
			// non-zero so a scripted `sync` notices the incomplete contract.
			const anySkipped = resync.docs.some((d) => d.skipped);

			// 2. The OPTIONAL skills install. Never under --dry-run (a preview writes
			//    nothing). `--add-skills` authorises it directly (bypasses the ask);
			//    otherwise an interactive TTY prompts once, and a non-TTY skips.
			if (!dryRun) {
				let doSkills = flags.addSkills === true;
				if (!doSkills && process.stdin.isTTY) {
					const scope = flags.local === true ? 'project-local' : 'global';
					doSkills = await confirmYesNo(
						`Also (re-)install the packaged dorfl skills into your ${scope} harness dir(s)?`,
					);
				}
				if (doSkills) {
					const result = installSkills({global: flags.local !== true});
					console.log(formatSkillsAddReport(result, flags.local === true));
				} else if (flags.addSkills !== true && !process.stdin.isTTY) {
					console.error(
						'>> Skills not installed (non-interactive run; pass --add-skills to install them).',
					);
				}
			}

			if (anySkipped) {
				process.exit(1);
			}
		});

	program
		.command('prd-to-spec')
		.helpGroup(ADVANCED_GROUP)
		.description(
			"Migrate THIS repo's work/ DATA + config + inert git refs from the legacy `prd` vocabulary to `spec`, after upgrading the dorfl package (whose code/contract already speak `spec`). Self-contained: (1) REFUSES unless the repo is quiescent (clean tree AND no held per-item lock AND no in-progress work/prd-* branch), naming the offender; (2) re-syncs work/protocol/* to the new `spec` contract; (3) mechanically converts all four data layers (folders work/prds/* -> work/specs/* via git mv, `prd:` frontmatter + inert refs across ALL items incl. tasks/done + specs/tasked, `prdsLandIn` config key, inert lock-refs/work-branches). Idempotent; --dry-run previews every layer without writing; the forward+reverse leak scan over the converted tree is the acceptance gate. Runs IN-PLACE on the current repo (does no git commit/push -- the human commits the result).",
		)
		.option(
			'--repo <dir>',
			'the repo working-tree root to migrate (default: cwd)',
		)
		.option(
			'--dry-run',
			'REPORT exactly what each layer WOULD change, touching nothing (no writes, no ref renames, no leak-scan)',
		)
		.option('--json', 'output the raw result as JSON')
		.action((flags: PrdToSpecFlags) => {
			const repoPath = flags.repo ?? process.cwd();
			const result = runPrdToSpec({
				repoPath,
				dryRun: flags.dryRun === true,
			});

			if (flags.json) {
				console.log(JSON.stringify(result, null, 2));
			} else {
				printPrdToSpecReport(result);
			}

			// Exit non-zero on a REFUSAL (quiescence gate) or a non-green leak scan
			// (a converted tree that still carries a dangling ''prd'' ref). A clean
			// dry-run or a green migration exits 0.
			if (result.refused || result.leaks.length > 0) {
				process.exit(1);
			}
		});

	program
		.command('status')
		.helpGroup(HEADLINE_GROUP)
		.description(
			'Read-only operational dashboard of JOBS (distinct from scan’s backlog queue): list every job under workspacesDir/work/* from its .dorfl-job.json record + worktree state, grouped active (running + alive) vs failed/retained (needs-attention with its reason, a crashed running-but-dead job, or a done-but-un-reaped one). Liveness comes from the harness seam (PID/session), NOT mtime. Never claims/runs/moves/deletes (deletion is gc).',
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option(
			'--workspace <dir>',
			'execution working area to inspect (default: workspacesDir / ~/.dorfl)',
		)
		.option(
			'--arbiter-remote <name>',
			`the current repo's arbiter remote to report on (folds in the old \`arbiter status\`; default: ${DEFAULT_ARBITER_REMOTE})`,
		)
		.option(
			'--arbiter <remote>',
			'the COORDINATION arbiter remote whose per-item lock refs gate the cwd selection pool (held in-flight items are subtracted); default: origin',
		)
		.option('--no-arbiter', "skip the current repo's arbiter section")
		.option(
			'--here',
			'report ONLY the current repo (the cwd working tree, fetch-first): skip the jobs, registry-mirror, and arbiter sections entirely. "This repo, nothing else" — the fast, focused path.',
		)
		.option('--json', 'output the raw report as JSON')
		.action(async (flags: StatusFlags) => {
			const config = resolveGlobalConfig(loadConfig(flags.config), {});
			const override = loadConfigOverride(
				defaultConfigOverridePath(flags.config),
			);
			const workspacesDir = flags.workspace ?? config.workspacesDir;
			const warn = (message: string) => console.error(`>> ${message}`);
			const resolveCwd = () =>
				resolveCwdSection({
					cwd: process.cwd(),
					config,
					override,
					arbiterRemote: flags.arbiterRemote ?? DEFAULT_ARBITER_REMOTE,
					lockArbiterRemote: flags.arbiter ?? 'origin',
					warn,
				});
			// `--here`: report ONLY the cwd — skip the jobs, registry-mirror, and arbiter
			// sections entirely ("this repo, nothing else"). `status` is built with NO
			// jobs (empty workspace view), NO mirrors, and NO arbiter, so only the cwd
			// block renders.
			if (flags.here === true) {
				const cwdSection = await resolveCwd();
				const report = await status({
					workspacesDir,
					mirrorPaths: [],
					cwd: cwdSection,
					warn,
				});
				if (flags.json) {
					console.log(JSON.stringify(report, null, 2));
				} else {
					console.log(formatStatus(report));
				}
				return;
			}
			// Surface the folder-native needs-attention set (ADR §12) from each
			// REGISTERED HUB MIRROR (the registry), read from its bare `main` ref
			// through the read seam (mirrors have no working tree).
			const mirrorPaths = listMirrors({workspacesDir}).map((m) => m.path);
			// Fold in the current repo's arbiter state (the old `arbiter status`, ADR
			// §1/§7) unless --no-arbiter. Read-only; tolerates not being in a repo.
			const arbiter =
				flags.noArbiter === true
					? undefined
					: arbiterStatus({
							cwd: process.cwd(),
							remote: flags.arbiterRemote ?? DEFAULT_ARBITER_REMOTE,
						});
			// The cwd-local section: resolve it ONLY when a participating cwd is NOT
			// already covered by a registered mirror, via the SAME fetch-free pre-check
			// `scan` uses (`cwdSectionDisposition`) — so an already-registered cwd is not
			// re-fetched (the registry/jobs view already covers it) while a mirror-less
			// cwd is still shown standalone.
			const disposition = cwdSectionDisposition({
				cwd: process.cwd(),
				config,
				arbiterRemote: flags.arbiterRemote ?? DEFAULT_ARBITER_REMOTE,
			});
			const cwdSection =
				disposition.participating && !disposition.alsoRegistered
					? await resolveCwd()
					: undefined;
			const report = await status({
				workspacesDir,
				mirrorPaths,
				arbiter,
				cwd: cwdSection,
				warn,
			});
			if (flags.json) {
				console.log(JSON.stringify(report, null, 2));
			} else {
				console.log(formatStatus(report));
			}
		});

	program
		.command('requeue <slug>')
		.helpGroup(HEADLINE_GROUP)
		.description(
			'Requeue a STUCK task to the backlog for re-claiming (ADR §12/§14). Recovers a task whose per-item lock is held — stuck (the resolved-recovery path: a previously-routed needs-attention item, now lock `state: stuck`) OR active (a claim that never surfaced — an un-surfaced abort, a killed run, or an in-place requeue note). The body rests in work/tasks/backlog/<slug>.md (claim never moves it under the per-item-lock model); requeue releases the lock so the item is claimable again. The release is published as a TREE-LESS compare-and-swap to the arbiter ref, EXACTLY like claim — it NEVER stages or commits in the cwd working tree, so a requeue in a shared checkout can never sweep up a concurrent writer’s uncommitted files. Escalation ladder (least to most destructive): (1) DEFAULT = keep + continue: leave the work/<slug> branch UNTOUCHED so the next claim CONTINUES from its tip (rebased onto fresh main at onboard-time); if the work/<slug> branch is not on the arbiter (never pushed, or a prior --reset already deleted it), default requeue succeeds anyway with a fresh-claim note. (2) --reconcile (alias --rebase) = NON-DESTRUCTIVE recovery: re-sync the mirror to the arbiter (prune-fetch) and RETRY the rebase of the kept branch onto latest arbiter/main in a scratch worktree; on a clean rebase, push the reconciled tip back (--force-with-lease, work branch only) and release the lock; on a genuine content conflict AFTER the clean re-sync, leave the item stuck and the branch UNTOUCHED (nothing deleted) so the human can retry when the churn settles. NEVER deletes the remote branch. (3) --reset = DESTRUCTIVE last resort: delete the remote work/<slug> branch FIRST (then release the lock) so the next claim starts fresh (guarded; never the default). -m/--message appends a dated handoff note to the item body (all modes; append-only).',
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option(
			'--cwd <dir>',
			'the repo/working clone whose work/ tree the arbiter remote is resolved FROM (default: cwd) — an ORIGIN SOURCE only; the move is published to the arbiter, never to this tree',
		)
		.option(
			'--arbiter <remote>',
			'the arbiter git remote the tree-less move is CAS-published to (default: origin). --cwd resolves this remote; the move is never written to the cwd tree.',
		)
		.option(
			'--reconcile',
			'NON-DESTRUCTIVE recovery (middle rung, between the default keep+continue and the destructive --reset): re-sync the mirror to the arbiter (prune-fetch) and RETRY the rebase of the kept work/<slug> onto latest arbiter/main in a scratch worktree; on success, push the reconciled tip back with --force-with-lease and release the lock; on a genuine content conflict after the clean re-sync, leave the item stuck and the branch UNTOUCHED (nothing deleted). NEVER deletes the remote branch. Incompatible with --reset.',
		)
		.option('--rebase', 'alias of --reconcile (canonical name)')
		.option(
			'--reset',
			'DESTRUCTIVE last resort: DISCARD the kept work by deleting the remote work/<slug> branch FIRST, then move to backlog so the next claim starts FRESH (guarded; a deliberate departure from the never-delete-the-remote-branch invariant). Never the default; try --reconcile first.',
		)
		.option(
			'-m, --message <note>',
			'append a dated handoff note to the item body for the next agent (append-only; applies to both default and --reset)',
		)
		.action(async (rawSlug: string, flags: RequeueFlags) => {
			// Task-only command (§3a): accept bare + `task:`, reject `spec:`.
			const slug = resolveTaskOnlySlug(rawSlug) as string;
			const cwd = flags.cwd ?? process.cwd();
			// Route the requeue (default keep+continue / --reset discard / -m handoff)
			// THROUGH the ledger write seam's transition (same seam the needs-attention
			// move uses), not the helper.
			//
			// `requeue` is a HUMAN command (like `complete`): the human is putting a
			// resolved item back, so the move/commit/push is THEIRS — it is NOT given
			// the runner identity (`config.identity`). The autonomous re-attempt is
			// `do` (which IS identity-aware), not this. We thread the ambient
			// `process.env` EXPLICITLY so the human-identity choice is visible at the
			// call site, rather than relying on the seam's silent `?? process.env`
			// default by omission (the implicit fallback that made `requeue`'s human
			// attribution accidental rather than declared).
			const reconcile = flags.reconcile === true || flags.rebase === true;
			if (reconcile && flags.reset) {
				console.error(
					'error: --reconcile and --reset are mutually exclusive ' +
						'(non-destructive recovery vs destructive last resort). Pick one.',
				);
				process.exit(1);
			}
			const result = await ledgerWrite.applyReturnToBacklogTransition({
				cwd,
				slug,
				// Tree-less CAS needs a ref to push to (parity with `claim`): default the
				// arbiter to `origin` so the common case Just Works; `--arbiter` overrides.
				// `--cwd` is purely the ORIGIN SOURCE the remote is resolved from.
				arbiter: flags.arbiter ?? 'origin',
				reset: flags.reset,
				reconcile,
				message: flags.message,
				env: process.env,
				note: (message) => console.error(`>> ${message}`),
			});
			if (!result.moved) {
				console.error(`error: ${result.reasonNotMoved}`);
				process.exit(1);
			}
			const how = result.deletedRemoteBranch
				? ` (--reset: deleted the remote ${workBranchRef('task', slug)} branch; next claim starts fresh)`
				: result.reconciled
					? ` (--reconcile: re-synced mirror + rebased ${workBranchRef('task', slug)} onto latest main and pushed the reconciled tip back; next claim continues from it)`
					: ' (kept the work branch; next claim continues from its tip)';
			console.log(`Requeued '${slug}' to backlog for re-claiming.${how}`);
		});

	// `promote [item]` (spec `staging-pool-position-gate-and-trust-model`, tasks
	// `pre-backlog-staging-folder-and-promote-step-a` /
	// `pre-prd-staging-pool-split-and-untrusted-prd-placement`): the HUMAN/runner-
	// owned verb that moves a STAGED item into its agent-eligible POOL — a task
	// `work/tasks/backlog/<slug>.md → work/tasks/ready/<slug>.md`, a spec
	// `work/specs/proposed/<slug>.md → work/specs/ready/<slug>.md` — as a tree-less CAS on the
	// arbiter, the SAME trust model + mechanism as `requeue`. The agent emits STAGED;
	// only this verb (a human, or the runner) admits it to the pool. With NO argument
	// it LISTS what is promotable (the "what is staged waiting for me?" discovery), so
	// a human need not remember the staged slugs.
	program
		.command('promote [item]')
		.helpGroup(HEADLINE_GROUP)
		.description(
			`Admit a STAGED item into its agent-eligible POOL (the runner/human side of the staging gate): a task \`${workFolderPrefix('tasks-backlog')}<slug>.md → ${workFolderPrefix('tasks-ready')}<slug>.md\`, a spec \`${workFolderPrefix('specs-proposed')}<slug>.md → ${workFolderPrefix('specs-ready')}<slug>.md\`, published as a TREE-LESS compare-and-swap to the arbiter ref (EXACTLY like requeue/claim — it never stages/commits in the cwd tree). The agent only ever CREATES staged; this verb is the gate a human (or the runner) opens. Accepts \`task:<slug>\` / \`spec:<slug>\` / a bare \`<slug>\` (= task). With NO argument, LISTS every promotable item (the tasks in ${workFolderPrefix('tasks-backlog')} + the specs in ${workFolderPrefix('specs-proposed')} on the arbiter) so you can see what is staged waiting for promotion. Idempotent: promoting an already-pooled slug is a clean no-op success.`,
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option(
			'--cwd <dir>',
			'the repo/working clone whose arbiter remote the tree-less move is resolved FROM (default: cwd) — an ORIGIN SOURCE only; the move is published to the arbiter, never to this tree',
		)
		.option(
			'--arbiter <remote>',
			'the arbiter git remote the promotion is CAS-published to / the staging folders are listed from (default: origin)',
		)
		.action(async (rawItem: string | undefined, flags: PromoteFlags) => {
			const cwd = flags.cwd ?? process.cwd();
			const arbiter = flags.arbiter ?? 'origin';
			// `promote` is a HUMAN command (like `requeue`): the move/commit/push is
			// THEIRS — NOT the runner identity. Thread the ambient env explicitly.
			const env = process.env;
			const note = (message: string) => console.error(`>> ${message}`);

			// NO ARGUMENT → LIST what is promotable (read-only discovery).
			if (rawItem === undefined) {
				const listed = await listPromotable({cwd, arbiter, env});
				if (listed.error) {
					console.error(`error: ${listed.error}`);
					process.exit(1);
				}
				if (listed.items.length === 0) {
					console.log(
						`Nothing staged to promote on ${arbiter}/main (${workFolderPrefix('tasks-backlog')} and ${workFolderPrefix('specs-proposed')} are empty).`,
					);
					return;
				}
				console.log('Staged, awaiting promotion (run `promote <item>`):');
				for (const item of listed.items) {
					console.log(`  ${item.namespace}:${item.slug}`);
				}
				return;
			}

			// AN ITEM → promote it. `task:`/`spec:` are explicit; a bare slug defaults to
			// a task (mirrors `requeue`). An `obs:`/`observation:` prefix is rejected
			// (observations have no pool). A legacy ''prd:'' prefix is a DEAD namespace token
			// after the hard cutover — it resolves as a bare literal task slug, not a spec.
			const parsed = parseSlugArg(rawItem);
			if (parsed.explicit === 'observation') {
				console.error(
					`error: promote takes a task or spec, not an observation ('${rawItem}'). Observations have no agent pool.`,
				);
				process.exit(1);
			}
			// A `spec:` prefix produces the `spec` namespace (the dispatch + messages
			// speak `spec`); only bare/`task:` stays `task`.
			const namespace = parsed.explicit === 'spec' ? 'spec' : 'task';
			const slug = parsed.slug;
			const result =
				namespace === 'spec'
					? await promoteFromPreSpec({cwd, slug, arbiter, env, note})
					: await promoteFromPreBacklog({cwd, slug, arbiter, env, note});
			if (!result.moved) {
				console.error(`error: ${result.reasonNotMoved}`);
				process.exit(1);
			}
			const dest =
				namespace === 'spec'
					? workFolderPrefix('specs-ready')
					: workFolderPrefix('tasks-ready');
			console.log(
				`Promoted ${namespace} '${slug}' into the pool (${dest}); it is now ${
					namespace === 'spec' ? 'auto-taskable' : 'claimable'
				}.`,
			);
		});

	// NOTE: the legacy `release-advancing <item>` verb is RETIRED by the capstone
	// cut-over (task `cutover-retire-slicing-advancing-markers-and-trim-folder-sets`):
	// the `work/advancing/<entry>.md` marker is gone and an advance hold is now just
	// `action: advance` on the UNIFIED per-item lock, so `release-lock <item>` (below)
	// is the SOLE named human release for ALL holds (implement/task/advance).

	// `release-lock <item>` (task `release-lock-verb-and-gc-stuck-report`, spec
	// `ledger-status-per-item-lock-refs` US #14): the HUMAN-invoked named release of
	// a stuck/orphaned UNIFIED per-item lock (`refs/dorfl/lock/<entry>`) —
	// the GENERALISATION of `release-advancing` from the advancing-only marker to
	// the one lock per item (implement/task/advance × active/stuck). Same trust
	// model as `release-advancing` / `requeue`: a HUMAN asserts the lock is dead by
	// NAMING it; the tool never guesses liveness (there is NO heartbeat, NO
	// auto-sweep — the `gc --ledger` report only REPORTS lingering locks). Routes
	// through the existing leased-delete `releaseItemLock` (deleting the ref IS the
	// release; the parentless lock commit becomes gc-reclaimable). NEVER `--force`.
	// Idempotent: deleting an absent ref is a clean exit-0 "nothing to clear"
	// (`not-held`), NOT a failure — deleting the lock ref(s) is "all locks released"
	// and recoverable (the work is safe on the `work/<slug>` branches + `main`).
	//
	// ESCAPE HATCH (`--entry <literal>`, task
	// `release-lock-entry-escape-hatch-and-literal-entry-reporting`): the item
	// positional is OPTIONAL because a lock whose entry name is NOT derivable from
	// any current item-form (a PRE-CUTOVER `slice-<slug>` / `prd-<slug>` entry minted
	// before the slice→task / `prd-to-spec` vocabulary cutover) is UN-NAMEABLE through
	// the item-form path. `--entry` takes the literal `<entry>` VERBATIM (bypassing
	// the namespace mapping) so a human can still NAME + clear such an orphan without
	// the raw `git push origin --delete refs/dorfl/lock/…` plumbing. It reuses the
	// SAME leased-delete path (`releaseLiteralLockEntry` → the shared entry-keyed
	// core), so the trust model is unchanged: the human still asserts liveness.
	// EXACTLY ONE of {item positional, --entry} must be given.
	program
		.command('release-lock [item]')
		.helpGroup(HEADLINE_GROUP)
		.description(
			'Clear a NAMED stuck/orphaned UNIFIED per-item lock (refs/dorfl/lock/<entry>) by DELETING the ref on the arbiter — the recovery verb for a lock the system orphaned (a crashed build/task/advance that left the hold behind). The generalisation of `release-advancing` from the advancing marker to the ONE lock per item. Same trust model as `requeue`: a HUMAN asserts the lock is dead by NAMING it; the tool never guesses liveness (the lock has NO heartbeat, so there is NO automatic sweep / age-based reaper anywhere). Accepts the same item forms as the lock API: `task:<slug>` / `spec:<slug>` / `obs:<slug>` / a bare `<slug>` (= task). ESCAPE HATCH: `--entry <literal>` (no item positional) targets a LITERAL entry name directly, bypassing the namespace mapping — for a lock whose entry name is not derivable from any current item-form (a pre-vocabulary-cutover `slice-<slug>` / `prd-<slug>` prefix, or a future rename); this is the supported way to clear such orphans, so the raw `git push origin --delete refs/dorfl/lock/…` plumbing is no longer required. Idempotent — re-running on an already-cleared lock is a clean exit-0 no-op (deleting the lock ref is “all locks released”, recoverable). NEVER `--force`. Discoverable via `gc --ledger` (it REPORTS every lingering lock and, for a pre-cutover entry, the exact `release-lock --entry <literal>` invocation).',
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option(
			'--entry <literal>',
			'ESCAPE HATCH: the LITERAL lock-entry name (`refs/dorfl/lock/<literal>`) to release VERBATIM, bypassing the namespace mapping — for a lock whose entry name is not derivable from any current item-form (a pre-cutover `slice-<slug>` / `prd-<slug>` entry). Mutually exclusive with the item positional (give EXACTLY one). Validated to `[A-Za-z0-9._-]+` (no slashes/whitespace) so it cannot escape the lock namespace.',
		)
		.option(
			'--cwd <dir>',
			'the repo/working clone whose arbiter remote the lock ref is DELETED on (default: cwd)',
		)
		.option(
			'--arbiter <remote>',
			'the arbiter git remote the lock ref is deleted on (default: origin)',
		)
		.action(async (item: string | undefined, flags: ReleaseLockFlags) => {
			const cwd = flags.cwd ?? process.cwd();
			const arbiter = flags.arbiter ?? 'origin';
			// MUTUAL EXCLUSION: exactly one of {item positional, --entry}. BOTH or
			// NEITHER is a usage error (non-zero exit, actionable message) — the
			// item-form and the literal escape hatch are two ways to name ONE lock, not
			// combinable.
			if (item !== undefined && flags.entry !== undefined) {
				console.error(
					'error: give EITHER an item (task:<slug> / spec:<slug> / obs:<slug> / <slug>) OR --entry <literal>, not both.',
				);
				process.exit(1);
			}
			if (item === undefined && flags.entry === undefined) {
				console.error(
					'error: name the lock to release — an item (task:<slug> / spec:<slug> / obs:<slug> / <slug>) OR --entry <literal> for a pre-cutover entry with no current item-form.',
				);
				process.exit(1);
			}
			// The LITERAL escape-hatch path (`--entry`): take the entry name verbatim,
			// bypassing the namespace mapping, and reuse the SAME leased-delete core.
			const result =
				flags.entry !== undefined
					? await releaseLiteralLockEntry({
							entry: flags.entry,
							cwd,
							arbiter,
							env: process.env,
						})
					: await releaseItemLock({
							item: item as string,
							cwd,
							arbiter,
							env: process.env,
						});
			if (result.outcome === 'released') {
				console.log(
					`Released lock '${result.entry}' (${result.ref} deleted on ${arbiter}; the item itself was untouched — it rests on main / its work/<slug> branch).`,
				);
				return;
			}
			// IDEMPOTENT exit semantics: the release returns `not-held` when the
			// ref is ALREADY absent. For a HUMAN re-running the verb on an
			// already-cleared lock that is the CORRECT "nothing to clear" outcome —
			// deleting the lock ref(s) is "all locks released" and recoverable — so map
			// it to a clean exit-0 with an honest message (NOT a failure). The message
			// names the LITERAL entry (`refs/dorfl/lock/<entry>`) so an operator can
			// copy-paste it straight back into a `--entry` invocation.
			if (result.outcome === 'not-held') {
				console.log(
					`No lock to release for '${result.entry}' (${result.ref} is already absent on ${arbiter} — “all locks released”, recoverable).`,
				);
				return;
			}
			console.error(`error: ${result.message}`);
			process.exit(1);
		});

	// `migrate-stuck-locks` (spec `surface-stuck-as-questions-and-retire-stuck-lock-state`,
	// resolved decision #3, user story 5; task `migrate-existing-stuck-locks-one-shot`):
	// the ONE-SHOT ROLLOUT migration that converts every pre-existing `stuck` lock
	// ref (an item bounced under the OLD model, before `retire-stuck-lock-state`)
	// into the new resting shape (`needsAnswers:true` + `stuck`-kind sidecar on
	// `<arbiter>/main` + lock released) via the SAME surface-first-release-second
	// transition the new bounce uses. Idempotent (a re-run finds no legacy stuck
	// ref → clean no-op) and bare-arbiter-safe (a ref is a ref). Its own verb (not
	// folded into `gc --ledger`) because it is a one-shot rollout event with WRITE
	// semantics on `main`, distinct from `gc`'s report-oriented + terminal-orphan
	// reap surface — the two are different natures and their exit-code contracts
	// stay separate.
	program
		.command('migrate-stuck-locks')
		.helpGroup(ADVANCED_GROUP)
		.description(
			'ONE-SHOT rollout migration: convert every pre-existing `stuck` per-item lock ref (`refs/dorfl/lock/<entry>` written under the retired `stuck` lock state) into the new resting shape — a `needsAnswers:true` item body + a `stuck`-kind `work/questions/<entry>.md` sidecar on `<arbiter>/main`, with the lock ref released — via the SAME surface-first-release-second transition a fresh bounce uses. Idempotent: re-running finds no legacy `stuck` ref (the current lock module never writes `state: stuck`) and is a clean no-op. Bare-arbiter safe (a ref is a ref). Skips a pre-cutover `slice-*` / `prd-*` entry with no current item-form (clear those via `release-lock --entry <literal>`) and NEVER --force-deletes a lock. Exits non-zero only when a surface CAS lost the race or a read/plumbing fault prevented migration.',
		)
		.option(
			'--cwd <dir>',
			'the local repo/clone whose --arbiter remote the lock refs are read + mutated on (default: cwd); the working tree is never touched (the surface transition is tree-less)',
		)
		.option(
			'--arbiter <remote>',
			'the arbiter git remote the migration reads + mutates (default: origin)',
		)
		.action(async (flags: {cwd?: string; arbiter?: string}) => {
			const cwd = flags.cwd ?? process.cwd();
			const arbiter = flags.arbiter ?? 'origin';
			const note = (message: string) => console.error(`>> ${message}`);
			const report = await migrateStuckLocks({
				cwd,
				arbiter,
				env: process.env,
				note,
			});
			for (const line of formatMigrateStuckLocksReport(report)) {
				console.log(line);
			}
			if (migrateStuckLocksNeedsAttention(report)) {
				process.exit(1);
			}
		});

	// `drop <slug>` (spec `agentic-question-resolution-retire-disposition-vocabulary`,
	// US #5/#11; task `direct-delete-question-cli-helper`): the DIRECT "throw it
	// away" verb — `git rm` a source item AND its question sidecar (when present) in
	// ONE revertible commit, the reason in the commit MESSAGE (git history is the
	// archive). It does NOT round-trip through the decision engine or spawn an agent
	// (that is the SEPARATE agentic `dispose` verdict in apply-persist.ts);
	// this is the human/skill/CLI no-ceremony delete of decision 7. DISTINCT from
	// the existing `remote rm` (the hub-MIRROR deleter) — different concern, no
	// collision. A LOCAL one-commit primitive over the working tree (like apply): it
	// does NOT touch the arbiter; the human pushes/integrates the revertible commit
	// however they normally do.
	program
		.command('drop <slug>')
		.helpGroup(HEADLINE_GROUP)
		.description(
			'DIRECTLY delete a source item + its question sidecar (when present) in ONE revertible commit — the "I just want to throw this away" path that does NOT round-trip through the decision engine or any agent. Resolves the source by its namespaced identity (`task:<slug>` / `spec:<slug>` / `obs:<slug>` / a bare `<slug>` = task), `git rm`s the source AND its sidecar together, and records your --reason in the commit MESSAGE (git history is the archive). A single revertible commit, so a wrong delete is recoverable via `git revert`. DISTINCT from `remote rm` (the hub-mirror deleter). A LOCAL working-tree commit (like the apply rung); it does not touch the arbiter — push/integrate it as you normally would. If the named source is already gone it is a clean no-op (nothing to throw away).',
		)
		.option(
			'--cwd <dir>',
			'the working clone the revertible delete commit is made in (default: cwd)',
		)
		.option(
			'--reason <text>',
			'why you are throwing this away — recorded in the commit MESSAGE (git history is the archive). Optional; recorded as "(no reason given)" when omitted.',
		)
		.action((slug: string, flags: DropFlags) => {
			const cwd = flags.cwd ?? process.cwd();
			// `drop` is a DIRECT HUMAN action (like the apply rung's local commit): the
			// delete/commit is THEIRS, so thread the ambient env explicitly.
			const env = process.env;
			const note = (message: string) => console.error(`>> ${message}`);
			const result = dropSource({
				cwd,
				item: slug,
				reason: flags.reason,
				env,
				note,
			});
			if (result.outcome === 'not-found') {
				// Nothing to throw away (the source is already gone). A clean exit-0
				// no-op, NOT a failure — deleting something already absent is success.
				console.log(
					`Nothing to drop for '${result.item}' — no source item resolves by identity (already gone).`,
				);
				return;
			}
			console.log(
				`Dropped '${result.item}'${
					result.sidecarPath ? ' + its sidecar' : ''
				} in one revertible commit (${result.commit?.slice(
					0,
					8,
				)}; reason in the message). Recover with \`git revert\` if this was wrong.`,
			);
		});

	program
		.command('intake')
		.helpGroup(HEADLINE_GROUP)
		.description(
			`Front-of-funnel: turn a GitHub issue into the right work/ artifact. Reads issue #N + its comment thread via the issue seam (gh), runs a prompt→verdict decision, and dispatches it: a clear, small issue → a proposed ${workFolderPrefix('tasks-ready')}<slug>.md PR carrying an \`issue: N\` closure link (read by a future CI close-job; not \`Fixes #N\`). GATE-FREE — your explicit invocation IS the authorization (autoTask/autoBuild do NOT apply), exactly as \`do\`. A LOCAL one-shot AND the SAME command CI schedules. PER-OUTCOME integration modes (the artifact TYPE is decided at runtime): --merge/--propose set BOTH; --merge-spec/--propose-spec and --merge-task/--propose-task override per type; granular overrides the aggregate; unset ⇒ propose for both.`,
		)
		.argument(
			'<number>',
			'the GitHub issue number to intake (e.g. `intake 42`)',
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option(
			'--arbiter <remote>',
			'name of the arbiter git remote (default: per-repo/global defaultArbiter)',
		)
		.option(
			'--merge',
			'integrate BOTH outcomes (task AND spec) in merge mode (aggregate; overridden per type by --merge-*/--propose-*; mutually exclusive with --propose)',
		)
		.option(
			'--propose',
			'integrate BOTH outcomes (task AND spec) in propose mode (aggregate; default; overridden per type; mutually exclusive with --merge)',
		)
		.option(
			'--no-pr',
			'propose without opening a PR for intake emissions: push the branch but deliberately skip the review request (the explicit suppress-PR intent). Resolved flag > env > per-repo > global > default off.',
		)
		.option(
			'--merge-spec',
			'integrate a spec outcome in merge mode (granular; overrides --merge/--propose for a spec; mutually exclusive with --propose-spec)',
		)
		.option(
			'--propose-spec',
			'integrate a spec outcome in propose mode (granular; overrides --merge/--propose for a spec; mutually exclusive with --merge-spec)',
		)
		.option(
			'--merge-task',
			'integrate a task outcome in merge mode (granular; overrides --merge/--propose for a task; mutually exclusive with --propose-task)',
		)
		.option(
			'--propose-task',
			'integrate a task outcome in propose mode (granular; overrides --merge/--propose for a task; mutually exclusive with --merge-task)',
		)
		.option(
			'--origin-trust <trusted|untrusted>',
			"the author-trust verdict to STAMP onto the emitted spec/task (origin: issue + originTrust: <value>), so an untrusted origin survives the merge boundary and later forces the task's BUILD transition to propose. CI's intake.yml derives it from the SAME author_association case as the integration flags. UNSET (a local intake) ⇒ emitted unstamped (human/trusted) — the human running intake IS the checkpoint.",
		)
		.option(
			'--specs-land-in <where>',
			'where an intake-authored spec lands: `proposed` (staged, not auto-taskable) or `ready` (the auto-tasking pool). The EXPLICIT operator override at the top of the placement precedence (explicit flag > untrusted-origin forces staging > specsLandIn default > built-in). Resolved flag > env (DORFL_SPECS_LAND_IN) > per-repo > global > built-in.',
		)
		.option(
			'--tasks-land-in <where>',
			'where an intake-authored TASK (emitted DIRECTLY from an issue) lands: `backlog` (staged, not agent-eligible) or `ready` (the agent POOL). The task twin of --specs-land-in: the EXPLICIT operator override at the top of the placement precedence (explicit flag > configured default > built-in staging; the caller selects the trusted-vs-untrusted default from the origin-trust stamp). Resolved flag > env (DORFL_TASKS_LAND_IN) > per-repo > global > built-in.',
		)
		.option('--agent-cmd <cmd>', 'command to run the decision agent')
		.option(
			'--model <id>',
			'model the decision agent runs on (routing intent; resolved flag > env > per-repo > global > default)',
		)
		.option(
			'--intake-model <id>',
			'model the intake decision agent runs on (the builder-specific override of --model). Unset at every level inherits --model. Resolved flag > env > per-repo > global > fallback to model > default (unset).',
		)
		.option(
			'--harness <adapter>',
			'harness adapter that launches the decision agent: null (default) or pi',
		)
		.option(
			'--pi-bin <path>',
			'pi CLI binary the pi harness invokes (default: pi on PATH)',
		)
		.option(
			'--sessions-dir <dir>',
			'HOST-ONLY root folder under which the pi session file is generated',
		)
		.action(async (rawNumber: string, flags: IntakeFlags) => {
			const issueNumber = Number(rawNumber);
			if (
				rawNumber.trim() === '' ||
				!Number.isInteger(issueNumber) ||
				issueNumber < 1
			) {
				console.error(
					`error: intake takes a positive issue NUMBER (got '${rawNumber}').`,
				);
				process.exit(1);
			}
			const cwd = process.cwd();
			const {global, override} = loadGlobalAndOverride(flags.config);
			const resolved = resolveRepoConfig({
				repoPath: cwd,
				global,
				override,
				flags: {
					...harnessFlagOverrides(flags),
					// `--no-pr` (the PR-INTENT axis) rides the SAME chain.
					...noPRFlagOverrides(flags),
					// `--intake-model` rides the SAME chain (falls back to `model`
					// when unset at all levels via `applyModelFallbacks`).
					...(flags.intakeModel !== undefined
						? {intakeModel: flags.intakeModel}
						: {}),
				},
			});
			if (resolved.message) {
				console.error(`>> ${resolved.message}`);
			}
			const config = resolved.config;
			// Resolve the PER-OUTCOME integration modes (spec US #9): `intake` decides
			// the artifact TYPE at runtime, so a single --merge/--propose can't express
			// a type-conditional policy. The granular flags override the aggregate; an
			// UNSET type falls back to the per-repo/global `intakeIntegration ??
			// integration` (the INTAKE-DOCUMENT knob, twin of the tasking path's
			// `taskingIntegration ?? integration`; spec
			// `intake-integration-knob-and-specs-land-in-proposed-rename`). DECOUPLED
			// from the autonomy gates: `intake` is GATE-FREE, so autoTask/autoBuild are
			// NOT consulted for the document mode (the explicit invocation is its own
			// authorization; ADR untrusted-origin-carries-via-stamp-not-forced-staging).
			// `intake` owns only these KNOBS; WHICH knobs CI sets is CI's POLICY
			// (`runner-in-ci`), NOT here.
			let modes;
			try {
				modes = resolveIntakeIntegrationModes(
					flags,
					config.intakeIntegration ?? config.integration,
				);
			} catch (err) {
				console.error(
					`error: ${err instanceof Error ? err.message : String(err)}`,
				);
				process.exit(1);
			}
			// The ORIGIN-TRUST stamp (task `untrusted-origin-forces-build-propose`):
			// the CI shell passes `--origin-trust <trusted|untrusted>`; `intake` writes
			// it onto the emitted artifact (it does NOT resolve trust — the ~L296
			// boundary). UNSET ⇒ undefined ⇒ emit unstamped (a local intake is
			// human/trusted). An INVALID value FAILS LOUDLY (an autonomy/trust signal
			// must never be quietly ignored), mirroring the observation-triage enum.
			let originTrust: 'trusted' | 'untrusted' | undefined;
			if (flags.originTrust !== undefined) {
				if (
					flags.originTrust !== 'trusted' &&
					flags.originTrust !== 'untrusted'
				) {
					console.error(
						`error: --origin-trust must be 'trusted' or 'untrusted' (got '${flags.originTrust}').`,
					);
					process.exit(1);
				}
				originTrust = flags.originTrust;
			}
			const harness = createHarness({
				harness: config.harness,
				piBin: config.piBin,
			});
			// The OPERATOR's EXPLICIT spec-placement override (`--specs-land-in`), the
			// TOP of the placement precedence — mirrors `explicitTasksLandInFromFlag` on
			// the `do spec:` path. Fails loudly on a bad value.
			let explicitSpecsLandIn: 'proposed' | 'ready' | undefined;
			try {
				explicitSpecsLandIn = explicitSpecsLandInFromFlag(flags.specsLandIn);
			} catch (err) {
				console.error(
					`error: ${err instanceof Error ? err.message : String(err)}`,
				);
				process.exit(1);
			}
			// The OPERATOR's EXPLICIT task-placement override (`--tasks-land-in`), the
			// TOP of the placement precedence for a DIRECT-from-issue task emit — the
			// task twin of `explicitSpecsLandIn` above (reuses the same `do`-path
			// helper). Fails loudly on a bad value.
			let explicitTasksLandIn: 'backlog' | 'ready' | undefined;
			try {
				explicitTasksLandIn = explicitTasksLandInFromFlag(flags.tasksLandIn);
			} catch (err) {
				console.error(
					`error: ${err instanceof Error ? err.message : String(err)}`,
				);
				process.exit(1);
			}
			const result = await performIntake({
				issueNumber,
				cwd,
				arbiter: flags.arbiter ?? config.defaultArbiter,
				integration: modes,
				// The resolved cross-job CAS-retry cap (config `mergeRetries`). `intake`
				// has no `--merge-retries` flag today (task
				// `thread-merge-retries-cross-task-and-ratify-default` deliberately does
				// NOT add one — intake is unattended-CI-first, env + per-repo cover the
				// need); env + per-repo + global fold into `config.mergeRetries` via the
				// SAME chain, and unset falls through to the engine default.
				mergeRetries: config.mergeRetries,
				// The origin-trust stamp the CI shell passes IN (unset ⇒ unstamped).
				originTrust,
				noPR: config.noPR,
				// SPEC-PLACEMENT: the TRUSTED-side configured default (`specsLandIn`) +
				// the UNTRUSTED-side twin (`untrustedSpecsLandIn`, selected in
				// `dispatchSpec` when the stamp is untrusted) + the EXPLICIT
				// `--specs-land-in` override (top of the precedence). The placement
				// resolver no longer has an untrusted-forces-staging rung (ADR
				// `untrusted-origin-carries-via-stamp-not-forced-staging`); the caller
				// selects the trusted-vs-untrusted default from the stamp.
				specsLandIn: config.specsLandIn,
				untrustedSpecsLandIn: config.untrustedSpecsLandIn,
				explicitSpecsLandIn,
				// TASK-PLACEMENT (parity with the spec-placement block above; ADR
				// `untrusted-origin-carries-via-stamp-not-forced-staging`): the
				// TRUSTED-side default (`tasksLandIn`) + the UNTRUSTED-side twin
				// (`untrustedTasksLandIn`, selected in `dispatchTask` when the stamp is
				// untrusted) + the EXPLICIT `--tasks-land-in` override. Replaces the old
				// hardcoded `tasks-ready` path; the resolver picks backlog vs ready.
				tasksLandIn: config.tasksLandIn,
				untrustedTasksLandIn: config.untrustedTasksLandIn,
				explicitTasksLandIn,
				harness,
				agentCmd: config.agentCmd,
				model: config.intakeModel,
				sessionsDir: config.sessionsDir,
				// Host-only runner IDENTITY — scopes intake's `gh`/git ops (not the
				// decision/review AGENT launches); absent ⇒ ambient.
				identity: config.identity,
				note: (message) => console.error(`>> ${message}`),
			});
			if (result.exitCode !== 0) {
				console.error(`error: ${result.message}`);
			} else {
				console.error(`>> ${result.message}`);
			}
			process.exit(result.exitCode);
		});

	// The CI CLOSE-JOB driver (spec `runner-in-ci`, capability E; task
	// `install-ci-close-job-workflow`). The thin JOB the emitted close-job workflow
	// invokes on a merge to main: resolve which source issue(s) the landed work
	// closes (resolveClosingIssue), run the "spec complete?" query for the spec case
	// (prd-complete-query, done), and close via the IssueProvider seam — all
	// UNCHANGED engine pieces, CONSUMED not re-built (the Out-of-Scope fence). CI
	// owns ONLY the job + trigger. Local-runnable too (a manual catch-up close).
	program
		.command('close-merged-issues')
		.helpGroup(ADVANCED_GROUP)
		.description(
			'Close source issues whose work has landed on main (CI capability E, spec runner-in-ci). Resolves each closing issue from the work/ tree (resolveClosingIssue: a lone task closes its own `issue:`; a fanned task reaches the number via `task.spec: → spec issue:`), runs the existing "spec complete?" query for the spec case (closes ONLY when ALL its spec:<slug> tasks are in work/done/), and closes via the IssueProvider seam (atomic comment+close; NO direct gh). Re-implements NONE of the resolution/query/close — it WIRES them. Invoked by the emitted close-job workflow on a merge to main; DEGRADES (never crashes) on a missing/unauthenticated gh.',
		)
		.option(
			'--cwd <dir>',
			'the repo working dir whose work/ tree to scan (default: cwd)',
		)
		.option('--gh-bin <bin>', 'the gh CLI binary (default: gh on PATH)')
		.option('--json', 'output the raw result as JSON')
		.action(async (flags: CloseMergedIssuesFlags) => {
			const repoPath = flags.cwd ?? process.cwd();
			const result = await performCloseMergedIssues({
				repoPath,
				ghBin: flags.ghBin,
				env: process.env,
			});
			if (flags.json) {
				console.log(JSON.stringify(result, null, 2));
			} else {
				for (const c of result.candidates) {
					if (c.decision === 'closed') {
						console.error(
							`>> closed issue #${c.issueNumber} (${c.via} ${c.slug}).`,
						);
					} else if (c.decision === 'close-failed') {
						console.error(
							`>> issue #${c.issueNumber} (${c.via} ${c.slug}) NOT closed: ${c.reason}`,
						);
					} else {
						console.error(
							`>> issue #${c.issueNumber} (${c.via} ${c.slug}) left open (${c.decision}).`,
						);
					}
				}
				console.error(
					`>> close-merged-issues: closed ${result.closed.length} issue(s).`,
				);
			}
			// The close-job is a terminal CI tick: a degraded close is reported, not a
			// crash (exit 0), exactly like intake's bounce close.
			process.exit(0);
		});

	// The REGISTRY command group (ADR §1): the registered set of targets IS the
	// hub-mirror set on disk. `remote add --local` absorbs the old `arbiter init`;
	// `arbiter status` is folded into `status`. There is no standalone `arbiter`
	// command group, and no `roots`/`remotes` config field.
	const remote = program
		.command('remote')
		.helpGroup(HEADLINE_GROUP)
		.description(
			'The registry: the registered set of targets IS the hub mirrors on disk under workspacesDir/repos/ (no roots/remotes config). add/rm/ls/find manage that set. `remote add --local` provisions a bare arbiter (absorbing `arbiter init`); `arbiter status` is folded into `status`.',
		);

	remote
		.command('add <target>')
		.helpGroup(HEADLINE_GROUP)
		.description(
			'Register a target by creating its hub mirror (idempotent). <target> is the arbiter URL; with --local it is a WORKING REPO whose bare arbiter is provisioned under arbitersDir (~/git, precious DATA, NEVER ~/.dorfl) and THAT arbiter is registered (absorbing `arbiter init`). The project-identity guard refuses registering one project (same projectId tail) under a second key unless --force; --force REPLACES the existing mirror but STILL refuses if a worktree of the replaced mirror holds un-pushed work (data-loss guard).',
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option(
			'--local',
			'provision a local --bare arbiter from <target> (a working repo) and register it (absorbs `arbiter init`)',
		)
		.option(
			'--arbiter-remote <name>',
			`name of the arbiter remote to wire in the working repo on --local (default: ${DEFAULT_ARBITER_REMOTE})`,
		)
		.option(
			'--force',
			'REPLACE this project’s existing mirror (re-link remote ↔ bare arbiter deliberately); overrides the registration POLICY block ONLY — still refuses if a worktree of the replaced mirror holds un-pushed work (the data-loss block is never overridden)',
		)
		.action((target: string, flags: RemoteAddFlags) => {
			const config = resolveGlobalConfig(loadConfig(flags.config), {});
			try {
				const result = remoteAdd({
					target,
					local: flags.local,
					workspacesDir: config.workspacesDir,
					arbitersDir: config.arbitersDir,
					arbiterRemote: flags.arbiterRemote ?? DEFAULT_ARBITER_REMOTE,
					force: flags.force,
					note: (message) => console.error(`>> ${message}`),
				});
				if (result.arbiter) {
					const a = result.arbiter;
					console.log(
						a.created
							? `Provisioned bare arbiter at ${a.path}`
							: `Arbiter already exists at ${a.path} (not clobbered)`,
					);
					console.log(`Wired remote '${a.remote}' -> ${a.url}`);
				}
				console.log(
					result.created
						? `Registered '${result.key}' (${result.transport}) — hub mirror at ${result.mirrorPath}`
						: `'${result.key}' already registered (mirror at ${result.mirrorPath})`,
				);
			} catch (err) {
				if (err instanceof RegistryError) {
					console.error(`error: ${err.message}`);
					process.exit(1);
				}
				throw err;
			}
		});

	remote
		.command('rm <target>')
		.helpGroup(ADVANCED_GROUP)
		.description(
			'Delete a hub mirror by key (host/org/name) or origin URL. The ONLY mirror deleter — `gc` NEVER reaps mirrors. Plumbing tier.',
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.action((target: string, flags: RemoteRmFlags) => {
			const config = resolveGlobalConfig(loadConfig(flags.config), {});
			const result = remoteRm({target, workspacesDir: config.workspacesDir});
			if (!result.removed) {
				console.error(`error: no registered mirror matches '${target}'.`);
				process.exit(1);
			}
			console.log(`Removed mirror '${result.key}' (${result.path}).`);
		});

	remote
		.command('ls')
		.helpGroup(HEADLINE_GROUP)
		.description(
			'List every registered hub mirror with its origin URL + transport. The origin URL is read from each mirror (the key encoding is lossy — it drops scheme/transport), so it is authoritative, not reconstructed from the key.',
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option('--json', 'output the raw list as JSON')
		.action((flags: RemoteLsFlags) => {
			const config = resolveGlobalConfig(loadConfig(flags.config), {});
			const mirrors = listMirrors({workspacesDir: config.workspacesDir});
			if (flags.json) {
				console.log(JSON.stringify(mirrors, null, 2));
				return;
			}
			if (mirrors.length === 0) {
				console.log(
					'No registered mirrors. Use `remote add <url>` or `remote find <folder>`.',
				);
				return;
			}
			for (const m of mirrors) {
				console.log(
					`${m.key}   ${m.transport}   ${m.originUrl ?? '(no origin)'}`,
				);
			}
		});

	remote
		.command('find <folder>')
		.helpGroup(HEADLINE_GROUP)
		.description(
			`Discover work/-participating repos under <folder> (a populated ${workFolderPrefix('tasks-ready')}), then toggle-add the chosen ones via \`remote add\`. Interactive multi-select by default; --yes adds ALL discovered repos non-interactively.`,
		)
		.option('-c, --config <path>', 'config file path', defaultConfigPath())
		.option('--yes', 'add all discovered participating repos (no prompt)')
		.action(async (folder: string, flags: RemoteFindFlags) => {
			const config = resolveGlobalConfig(loadConfig(flags.config), {});
			const repos = findParticipatingRepos(folder);
			if (repos.length === 0) {
				console.log(`No work/-participating repos found under ${folder}.`);
				return;
			}
			const chosen = flags.yes ? repos : await promptMultiSelect(repos);
			if (chosen.length === 0) {
				console.log('Nothing selected; no mirrors added.');
				return;
			}
			for (const repoPath of chosen) {
				// Each discovered repo is registered as a LOCAL bare arbiter (it is a
				// working checkout on disk, not a remote URL) — the same path
				// `remote add --local` takes. The transport guard still applies.
				try {
					const result = remoteAdd({
						target: repoPath,
						local: true,
						workspacesDir: config.workspacesDir,
						arbitersDir: config.arbitersDir,
						arbiterRemote: DEFAULT_ARBITER_REMOTE,
						note: (message) => console.error(`>> ${message}`),
					});
					console.log(
						`${result.created ? 'Registered' : 'Already registered'} '${result.key}' (${repoPath}).`,
					);
				} catch (err) {
					if (err instanceof RegistryError) {
						console.error(`skipped ${repoPath}: ${err.message}`);
						continue;
					}
					throw err;
				}
			}
		});

	program
		.command('install-ci')
		.helpGroup(ADVANCED_GROUP)
		.description(
			'Scaffold the CI auth/setup foundation (a one-time, human-run SCAFFOLDER): write the shared composite setup action (`dorfl-setup`) + provider auth (models.json default, or auth.json + GH_PAT + OAuth refresh) and set the provider secrets via the GitHub seam. Interactive wizard, or `--config <file>` for a non-interactive reproduction; `--export-config` round-trips the config; `--fake` writes to `.fake/` (never `.github/`) and sets NO real secret (a snapshot dry-run).',
		)
		.option(
			'--config <file>',
			'non-interactive: load the CI config from this JSON file (skips the wizard)',
		)
		.option(
			'--export-config <file>',
			'write the gathered config as JSON to this path instead of generating artifacts',
		)
		.option(
			'--include-secrets',
			'(with --export-config) also gather + include the secret values in the export',
		)
		.option(
			'--fake',
			'snapshot mode: write artifacts to `.fake/` (NEVER `.github/`) and set NO real secret',
		)
		.option(
			'--repo <owner/repo>',
			'the GitHub repo to set secrets on (else auto-detected via gh)',
		)
		.option('--gh-bin <bin>', 'the gh CLI binary (default: gh on PATH)')
		.option('--cwd <dir>', 'the target repo working dir (default: cwd)')
		.option(
			'--install-source <registry|workspace>',
			'where the CI installs the CLI from: `registry` (npm install -g, the default) or `workspace` (build from the checked-out source + link onto PATH, for the self-hosting monorepo). Overrides auto-detection in both directions.',
		)
		.option(
			'--max-parallel <n>',
			'cap on CONCURRENT advance-lifecycle matrix legs (the propose/merge `max-parallel`). Each leg is a full agent session, so a large fan-out can exhaust the model provider rate limit + thrash the CAS. Default 2.',
		)
		.action(async (flags: InstallCiFlags) => {
			const workDir = flags.cwd ?? process.cwd();
			if (
				flags.installSource !== undefined &&
				flags.installSource !== 'registry' &&
				flags.installSource !== 'workspace'
			) {
				console.error(
					`install-ci: --install-source must be "registry" or "workspace" (got "${flags.installSource}")`,
				);
				process.exitCode = 1;
				return;
			}
			let maxParallel: number | undefined;
			if (flags.maxParallel !== undefined) {
				const n = Number(flags.maxParallel);
				if (!Number.isInteger(n) || n < 1) {
					console.error(
						`install-ci: --max-parallel must be a positive integer (got "${flags.maxParallel}")`,
					);
					process.exitCode = 1;
					return;
				}
				maxParallel = n;
			}

			const ctx = new GitHubCIContext({
				workDir,
				repo: flags.repo,
				ghBin: flags.ghBin,
			});
			// Discover the registered capability emitters (the directory-of-modules
			// seam: each capability self-registers from its own file under
			// `install-ci-capabilities/`, picked up here WITHOUT a shared-list edit).
			// This core task ships only a no-op reference (emits []); the sibling
			// capability tasks add self-registering modules that flow through here
			// automatically once landed. A no-op emitter contributes nothing.
			const capabilities = await loadCapabilityRegistry();
			const prompts = flags.config ? undefined : readlinePrompts();
			await installCI({
				ctx,
				fake: flags.fake === true,
				configFile: flags.config,
				exportConfig: flags.exportConfig,
				includeSecrets: flags.includeSecrets === true,
				installSource: flags.installSource as
					| 'registry'
					| 'workspace'
					| undefined,
				maxParallel,
				prompts,
				capabilities,
				log: (line) => console.error(line),
			});
		});

	// The `skills` group (ADR `skill-install-vendors-incur-agents-map`): install the
	// packaged dorfl skills (`from-idea`, `setup`, ...) into the OPERATOR's OWN
	// harness dirs. Distinct from any target-repo propagation (ADR
	// `methodology-and-skills` §6 — skills don't travel into target repos; only
	// `work/protocol/` does). Only `add` is exposed in this pass — `list`/`remove`
	// are deferred until we have a real use case (the vendored `install()` is
	// idempotent, so `add` alone covers upgrade + drift-repair; a future `remove`
	// would map onto the vendored `remove()` and is intentionally out of scope
	// here to keep the CLI surface minimal).
	const skills = program
		.command('skills')
		.helpGroup(HEADLINE_GROUP)
		.description(
			"Install the packaged dorfl skills (`from-idea`, `setup`, ...) into the operator's own agent harness(es). Installs into your OWN harness dirs (~/.agents/skills/ + per-harness symlinks) — this is operator tooling, NOT target-repo propagation (skills don't travel into `work/` repos; only `work/protocol/` does).",
		);

	skills
		.command('add')
		.helpGroup(HEADLINE_GROUP)
		.description(
			'Copy the packaged dorfl skills into the canonical `~/.agents/skills/` (global; `--local` scopes to <cwd>/.agents/skills/) and symlink each detected non-universal harness (Claude Code, Cursor, Windsurf, ...) to it. Idempotent; re-run to pick up new/updated skills.',
		)
		.option(
			'--local',
			'install project-locally into <cwd>/.agents/skills/ (and each detected harness\u2019s PROJECT dir) instead of globally into ~/.agents/skills/. Default: global.',
		)
		.action((flags: SkillsAddFlags) => {
			const result = installSkills({global: flags.local !== true});
			console.log(formatSkillsAddReport(result, flags.local === true));
		});

	return program;
}

interface SkillsAddFlags {
	/**
	 * `--local`: project-local install (canonical base `<cwd>/.agents/skills/`)
	 * instead of the global `~/.agents/skills/` default. Named to mirror the
	 * `remote add --local` sibling ('local' = "scope to here") and the vendored
	 * `install()`'s `global: false` semantic. Chosen over `--project` /
	 * `--here` / `--global` inversion for consistency with the existing verb.
	 */
	local?: boolean;
}

/**
 * Human-readable report for `dorfl skills add`. Prints the SOURCE the skills
 * were read from, each canonical install path (one per skill), and each
 * non-universal harness placement (symlink | copy) with its absolute path.
 * Universal harnesses read from the canonical dir directly and need no line.
 * Output goes to stdout; the shape is stable enough for a human to audit "what
 * landed where" but is NOT a machine contract (no JSON mode in this pass).
 */
export function formatSkillsAddReport(
	result: InstallSkillsResult,
	local: boolean,
): string {
	const lines: string[] = [];
	const scope = local ? 'project-local' : 'global';
	lines.push(`Installed dorfl skills (${scope}) from ${result.sourceDir}:`);
	if (result.paths.length === 0) {
		lines.push('  (no skills found in source)');
	} else {
		for (const p of result.paths.slice().sort()) {
			lines.push(`  ${p}`);
		}
	}
	if (result.agents.length === 0) {
		lines.push(
			'Harnesses: no non-universal harness detected (universal harnesses read from the canonical dir directly).',
		);
	} else {
		lines.push('Harnesses:');
		for (const a of result.agents.slice().sort((x, y) => {
			const byAgent = x.agent.localeCompare(y.agent);
			return byAgent !== 0 ? byAgent : x.path.localeCompare(y.path);
		})) {
			lines.push(`  ${a.agent}: ${a.mode} -> ${a.path}`);
		}
	}
	return lines.join('\n');
}

/**
 * A readline-backed {@link WizardPrompts} for the interactive `install-ci`
 * wizard. Prompts go to stderr (stdout is reserved for any machine output); a
 * non-TTY invocation falls back to defaults (or empty), so a piped run never
 * hangs — use `--config` for a fully non-interactive reproduction.
 */
function readlinePrompts(): WizardPrompts {
	const ask = (message: string, mask = false): Promise<string> =>
		new Promise((resolvePrompt) => {
			if (!process.stdin.isTTY) {
				resolvePrompt('');
				return;
			}
			const rl = createInterface({
				input: process.stdin,
				output: process.stderr,
			});
			void mask; // readline has no native masking; secrets are typed visibly
			rl.question(`${message} `, (answer) => {
				rl.close();
				resolvePrompt(answer);
			});
		});
	return {
		async input(message, opts) {
			const hint = opts?.default ? ` [${opts.default}]` : '';
			const answer = (await ask(`${message}${hint}`)).trim();
			return answer === '' && opts?.default ? opts.default : answer;
		},
		async password(message) {
			return (await ask(message, true)).trim();
		},
		async confirm(message, opts) {
			const hint = opts.default ? ' [Y/n]' : ' [y/N]';
			const answer = (await ask(`${message}${hint}`)).trim().toLowerCase();
			if (answer === '') return opts.default;
			return answer === 'y' || answer === 'yes';
		},
		async select(message, choices) {
			process.stderr.write(`${message}\n`);
			choices.forEach((c, i) => {
				process.stderr.write(`  [${i + 1}] ${c.name}\n`);
			});
			const answer = (await ask('Choose (number):')).trim();
			const n = Number(answer);
			if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
				return choices[n - 1].value;
			}
			return choices[0].value; // default to the first choice
		},
	};
}

/**
 * A minimal interactive multi-select toggle for `remote find`: list the
 * discovered repos numbered, let the user type the numbers to add (space/comma
 * separated; `all` for everything; blank for none). A non-interactive (no TTY)
 * invocation selects nothing — use `--yes` to add all without a prompt.
 */
function promptMultiSelect(repos: string[]): Promise<string[]> {
	return new Promise((resolvePrompt) => {
		if (!process.stdin.isTTY) {
			resolvePrompt([]);
			return;
		}
		const rl = createInterface({input: process.stdin, output: process.stderr});
		process.stderr.write('Discovered work/-participating repos:\n');
		repos.forEach((repo, i) => {
			process.stderr.write(`  [${i + 1}] ${repo}\n`);
		});
		rl.question('Add which? (numbers, `all`, or blank for none) ', (answer) => {
			rl.close();
			const trimmed = answer.trim().toLowerCase();
			if (trimmed === '') {
				resolvePrompt([]);
				return;
			}
			if (trimmed === 'all') {
				resolvePrompt([...repos]);
				return;
			}
			const picks = new Set<string>();
			for (const token of trimmed.split(/[\s,]+/)) {
				const n = Number(token);
				if (Number.isInteger(n) && n >= 1 && n <= repos.length) {
					picks.add(repos[n - 1]);
				}
			}
			resolvePrompt([...picks]);
		});
	});
}

/**
 * Run the CLI: build the program and parse argv. Split from {@link buildProgram}
 * so tests can build + introspect/parse the program WITHOUT triggering a real
 * argv parse + `process.exit` on import (the module-level bootstrap below only
 * fires when this file is the process entry point).
 *
 * BEFORE any command dispatch it runs the bootstrap SELF-FORWARD hook
 * ({@link maybeForward}): if the nearest repo `dorfl.json` declares a `dorflCmd`
 * (and we are not already the forwarded child / opted out), it execs that command
 * with the ORIGINAL argv + env inherited and exits with the child's code
 * (transparent passthrough). A declared-but-unusable `dorflCmd` FAILS LOUD. On
 * the run-self branch (no `dorflCmd`, opted out, or the forwarded child) it parses
 * the (opt-out-stripped) argv in-process, exactly as before. See
 * `bootstrap-forward.ts` for the full model + the injectable seam.
 */
export async function runCli(argv: string[] = process.argv): Promise<void> {
	const outcome = maybeForward({argv});
	if (outcome.kind === 'forwarded') {
		process.exit(outcome.exitCode);
	}
	if (outcome.kind === 'error') {
		console.error(outcome.message);
		process.exit(outcome.exitCode);
	}
	// run-self: parse the argv commander sees (with any `--no-forward` stripped,
	// since commander does not declare that bootstrap-level flag).
	const program = buildProgram();
	try {
		await program.parseAsync(outcome.argv);
	} catch (err: unknown) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

// Only bootstrap when invoked as the entry point (the installed `bin`), never on
// import (so `buildProgram`/`runCli` are import-safe for tests).
if (isCliEntryPoint()) {
	void runCli();
}

/**
 * True iff this module is the process entry point (the `dorfl` bin).
 * Resolves both sides through `realpathSync` so a bin SYMLINK (npm/pnpm install
 * a `node_modules/.bin/dorfl` link to `dist/cli.js`) still matches.
 */
function isCliEntryPoint(): boolean {
	const entry = process.argv[1];
	if (!entry) {
		return false;
	}
	try {
		const entryReal = realpathSync(entry);
		const selfReal = realpathSync(fileURLToPath(import.meta.url));
		return entryReal === selfReal;
	} catch {
		return false;
	}
}
