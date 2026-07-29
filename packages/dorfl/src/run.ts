import {type Config, resolvePromptGuidance} from './config.js';
import {resolveRepoConfig} from './repo-config.js';
import type {ConfigOverrideMap} from './config-override.js';
import {scan, type ScanReport} from './scan.js';
import {selectCandidates, type Candidate} from './select.js';
import {performClaim, type ClaimCasResult} from './claim-cas.js';
import {updateJobRecord, encodeWorkId} from './workspace.js';
import {encodeRepoKey} from './repo-mirror.js';
import {run as runProcess} from './git.js';
import {mkdirSync, readFileSync, rmSync} from 'node:fs';
import {ledgerWrite} from './ledger-write.js';
import type {SurfaceToNeedsAttentionResult} from './needs-attention.js';
import {
	jobWorktreeStrategy,
	type IsolatedTree,
	type IsolationStrategy,
} from './isolation.js';
import {runConcurrent, createKeyedLock} from './concurrency.js';
import type {Harness} from './harness.js';
import {createHarness} from './pi-harness.js';
import {generateSessionPath} from './session-path.js';
import {
	resolveTask,
	buildAgentPrompt,
	resolveContinueContext,
	resolvePromptGuidanceForItem,
	PromptError,
} from './prompt.js';
import {type IntegrateResult, type ReviewProvider} from './integrator.js';
import {
	parseStopSentinel,
	isWorkBranchDiffEmpty,
	emptyDiffStopReason,
	emptyDiffDisposeEnvelope,
	type AgentStopKind,
} from './agent-stop.js';
import {surfaceStuckToNeedsAttention} from './needs-attention.js';
import {resolveItemPathByIdentity} from './item-path.js';
import {
	classifyFailureCause,
	failureCauseLabel,
	type FailureCause,
} from './failure-cause.js';
import {performIntegration} from './integration-core.js';
import {
	shouldFailProposePrIntent,
	PROPOSE_PR_INTENT_GH_UNAVAILABLE_MESSAGE,
} from './do-config.js';
import {
	checkGatePreconditions,
	detectLockfileOnDisk,
	detectLockfileOnMirrorMain,
} from './gate-readiness.js';
import {isGitHubArbiterUrl, GitHubProvider} from './github.js';
import {identityEnv, assertTransportAllowed} from './identity.js';
import type {ReviewGate} from './review-gate.js';
import type {BackoffOptions, Sleep} from './retry-backoff.js';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';

/** Is `repoPath` a BARE git repository (a registry hub mirror has no work tree)? */
function isBareRepo(
	repoPath: string,
	env: NodeJS.ProcessEnv | undefined,
): boolean {
	const result = runProcess(
		'git',
		['rev-parse', '--is-bare-repository'],
		repoPath,
		{env},
	);
	return result.status === 0 && result.stdout.trim() === 'true';
}

/**
 * The outcome of {@link claimAgainstRepo}: the claim result PLUS the path the
 * job-worktree strategy should resolve its mirror/arbiter URL from (`fromRepo`).
 * For an in-place checkout that is the checkout itself; for a bare registry
 * mirror it is the throwaway claim CLONE (whose `origin` IS the arbiter URL).
 */
interface RepoClaim {
	claim: ClaimCasResult;
	/** Pass as `jobWorktreeStrategy({fromRepo})` (kept alive until AFTER prepare). */
	fromRepo: string;
	/** Arbiter remote NAME valid inside `fromRepo` (in-place: configured; bare: `origin`). */
	strategyArbiter: string;
	/**
	 * Remove the throwaway claim clone (no-op for the in-place path). MUST be called
	 * only AFTER `strategy.prepare()` — the strategy resolves the mirror URL off
	 * `fromRepo`, so the clone must still exist at prepare time.
	 */
	cleanup(): void;
}

/**
 * Claim a slug against a repo that may be EITHER a working checkout (the in-place
 * test/`do` path) OR a BARE registry hub mirror (`run`'s production discovery).
 *
 * The claim CAS needs a NON-bare checkout with an `origin/main` tracking ref and
 * a work tree to commit in (a bare mirror cannot `git mv`/`git commit`). So for a
 * bare mirror we clone it into a throwaway claim dir under `workspace` and claim
 * THERE against `origin` (the mirror URL) — the EXACT pattern `do --remote` uses
 * (`do.ts` §2–3). For a non-bare checkout we claim in place against the configured
 * arbiter remote, unchanged. The returned `fromRepo` is what the job-worktree
 * strategy then resolves the mirror off (the claim clone, or the checkout).
 */
async function claimAgainstRepo(opts: {
	slug: string;
	repoPath: string;
	workspace: string;
	arbiter: string;
	env: NodeJS.ProcessEnv | undefined;
}): Promise<RepoClaim> {
	const {slug, repoPath, workspace, arbiter, env} = opts;
	if (!isBareRepo(repoPath, env)) {
		// In-place checkout: claim directly against the configured arbiter remote.
		const claim = await performClaim({slug, cwd: repoPath, arbiter, env});
		return {
			claim,
			fromRepo: repoPath,
			strategyArbiter: arbiter,
			cleanup: () => {},
		};
	}

	// Bare hub mirror (the registry): clone it into a throwaway claim dir and claim
	// there against `origin` (the mirror URL = the arbiter). Keyed per slug so two
	// in-flight jobs in the same mirror get DISTINCT claim clones (worktree
	// isolation — no shared mutable state across in-flight jobs).
	const mirrorUrl = runProcess(
		'git',
		['remote', 'get-url', 'origin'],
		repoPath,
		{
			env,
		},
	).stdout.trim();
	const url = mirrorUrl !== '' ? mirrorUrl : `file://${repoPath}`;
	const claimDir = join(
		workspace,
		'claim',
		`${encodeRepoKey(url).split('/').join('__')}__${slug}`,
	);
	rmSync(claimDir, {recursive: true, force: true});
	mkdirSync(dirname(claimDir), {recursive: true});
	runProcess('git', ['clone', '--quiet', url, claimDir], dirname(claimDir), {
		env,
	});
	const claim = await performClaim({
		slug,
		cwd: claimDir,
		arbiter: 'origin',
		env,
	});
	return {
		claim,
		fromRepo: claimDir,
		// Inside the clone the arbiter is `origin` (the mirror URL).
		strategyArbiter: 'origin',
		cleanup: () => rmSync(claimDir, {recursive: true, force: true}),
	};
}

/**
 * Resolve the arbiter URL for `repoPath` PRE-CLAIM, the SAME way
 * {@link claimAgainstRepo} derives the claim target. A BARE registry hub mirror's
 * arbiter is its `origin` remote URL (falling back to `file://${repoPath}` when it
 * has none); a working CHECKOUT's arbiter is the configured `arbiter` remote URL
 * (falling back to `file://${repoPath}`). Used by the PR-INTENT pre-flight guard
 * to know whether the arbiter is GitHub BEFORE the claim — it must not claim then
 * refuse (that would strand the item in-progress on main). Read-only; mutates
 * nothing.
 */
function arbiterUrlForRepo(opts: {
	repoPath: string;
	arbiter: string;
	env: NodeJS.ProcessEnv | undefined;
}): string {
	const {repoPath, arbiter, env} = opts;
	const remote = isBareRepo(repoPath, env) ? 'origin' : arbiter;
	const res = runProcess('git', ['remote', 'get-url', remote], repoPath, {env});
	const url = res.status === 0 ? res.stdout.trim() : '';
	return url !== '' ? url : `file://${repoPath}`;
}

/** What happened to one selected item across the whole pipeline. */
export type ItemStatus =
	| 'claimed-done' // tests green + rebased clean → integrated (pushed/merged)
	| 'lost-race' // claim exit 2 — skipped cleanly
	| 'claim-contended' // claim exit 3
	| 'claim-error' // claim exit 1 / unexpected
	| 'tests-failed' // claimed + ran, but gate red → routed to needs-attention
	| 'needs-attention' // rebase conflict at integrate time (ADR §10) — human must look
	| 'surface-unmoved' // the tree-less surface to needs-attention did NOT land on the arbiter (lost the CAS race / no arbiter) — the item is STILL in-progress on the arbiter; retry/resolve
	| 'agent-failed' // the agent ran but produced bad/empty output (the conservative generic), OR the cause is unknown
	| 'transient-infra' // a harness-surfaced model/connection outage (post-retry) or a git/provider outage — RETRY the same work (FAILURE-CAUSE axis)
	| 'needs-reauth' // a credential expired / was revoked (OAuth refresh) — retry cannot help; a human must RE-AUTH (FAILURE-CAUSE axis)
	| 'config-error' // a thrown CORE wiring/config error (e.g. review on, no reviewGate) — fix the WIRING, not the task (FAILURE-CAUSE axis)
	| 'agent-stopped'; // the agent DELIBERATELY stopped (task drifted) OR produced no change — gate + Gate-2 skipped

export interface ItemResult {
	repoPath: string;
	slug: string;
	status: ItemStatus;
	/** Integration outcome, when the item reached done. */
	integration?: IntegrateResult;
	detail?: string;
}

export interface RunOnceResult {
	claimedAndDone: number;
	skipped: number;
	failed: number;
	/** Items routed to needs-attention (rebase conflict, red gate). */
	needsAttention: number;
	items: ItemResult[];
}

/** The agent invocation: edits code in `cwd` to satisfy the prompt. */
export type Dorfl = (input: {
	cwd: string;
	prompt: string;
	slug: string;
	env?: NodeJS.ProcessEnv;
}) => {
	ok: boolean;
	detail?: string;
	/**
	 * The agent's FINAL SUMMARY (the harness seam's `LaunchResult.output`): the
	 * channel the propose-mode PR BODY is built from (mirrors `do`'s
	 * `DoDorfl.output`). Optional so a test agent may supply one; production
	 * surfaces the build agent's last assistant message. Absent ⇒ no body ⇒ the
	 * provider degrades to `--fill` (no regression).
	 */
	output?: string;
};

export interface RunOnceOptions {
	config: Config;
	/**
	 * Pre-computed scan report; if omitted, discovery falls back to the registry
	 * (the hub-mirror set, ADR §1). Callers that still operate on working checkouts
	 * (the CLI / its tests) inject an explicit `report` built from working-tree
	 * paths; the registry reframe landed in `run-daemon-reframe` (work/done/).
	 */
	report?: ScanReport;
	/**
	 * The execution working area (bare hub mirrors + per-job worktrees). Defaults
	 * to `config.workspacesDir`. STATE, not cache (ADR §3).
	 */
	workspace?: string;
	/**
	 * How to invoke the configured agent. When omitted, the work runs through the
	 * harness seam (null adapter by default) shelling out to `config.agentCmd`.
	 * Tests inject this to edit files directly without a real agent.
	 */
	dorfl?: Dorfl;
	/** The harness seam (ADR §5); defaults to the null adapter. */
	harness?: Harness;
	/**
	 * The PR/code review gate (Gate 2) SEAM, threaded into the shared
	 * `performIntegration` core. Tests inject a canned `approve`/`block` verdict
	 * (no real model); the CLI passes the production `harnessReviewGate()` ONLY
	 * when `config.review` resolves on. Unset ⇒ no review (the default). The core
	 * throws if `review` is on but this is absent — `runOneItem` guards that.
	 */
	reviewGate?: ReviewGate;
	/**
	 * An explicitly-injected, fully-formed review provider INSTANCE that overrides
	 * per-item auto-detection (tests / embedding). Forwarded to
	 * `performIntegration` as `providerInstance` (carrying title/body/url). Unset ⇒
	 * the core selects the provider PURELY from the arbiter URL (no override axis).
	 */
	provider?: ReviewProvider;
	/**
	 * The `gh` AUTH/AVAILABILITY PROBE the PR-INTENT pre-flight guard runs UP FRONT
	 * per item (propose + GitHub arbiter + `noPR` unset): `true` ⇒ `gh` CAN open a
	 * PR. The SAME signal in-place `do` (and `do --remote`) uses, run BEFORE the
	 * claim so no item is left claimed when `gh` is genuinely unauthed. The probe
	 * (not a config check) is the signal — an absent `providers.github` identity
	 * falls back to ambient `gh` auth, which the probe reports available, so the run
	 * PROCEEDS. Injectable so tests stub `gh` without a real binary; production
	 * defaults to `new GitHubProvider().available(repoPath, env)`.
	 */
	ghCanOpenPr?: (cwd: string, env: NodeJS.ProcessEnv | undefined) => boolean;
	/** Optional injectable PR opener for `integration: propose` (legacy bridge). */
	openPr?: (opts: {
		cwd: string;
		branch: string;
		env?: NodeJS.ProcessEnv;
	}) => void;
	/** Environment for git/agent child processes. */
	env?: NodeJS.ProcessEnv;
	/** Override agent-id generation (tests). Retained for API compat; unused for branch naming. */
	agentId?: () => string;
	/**
	 * Sink for non-fatal warnings (e.g. a repo's `dorfl.json` naming
	 * runner/host-only keys that were ignored). Defaults to a no-op so the core
	 * stays pure; the CLI wires this to stderr.
	 */
	onWarn?: (message: string) => void;
	/**
	 * The per-machine {@link ConfigOverrideMap} (from `loadConfigOverride`),
	 * threaded into the per-repo resolution `runOneItem` performs so the override
	 * applies to every tick item (ADR `per-machine-config-override-layer`).
	 * Default: empty (no override).
	 */
	override?: ConfigOverrideMap;
	/**
	 * Bounded-backoff bounds for the needs-attention route's git network ops
	 * (surface fetch+push, branch push). Defaults to the shared `DEFAULT_BACKOFF`.
	 * Threaded into the failure-routing seam so a degraded run gives up cleanly
	 * rather than hanging the tick.
	 */
	backoff?: BackoffOptions;
	/**
	 * Injectable sleep for that backoff — the SAME seam {@link runLoop} uses for
	 * its inter-tick sleep. Defaults to a real `setTimeout`. Tests inject a no-op
	 * so a fully-offline-arbiter failure route resolves with NO real waits.
	 */
	sleep?: Sleep;
}

/**
 * Run one supervised tick: claim up to `maxParallel` eligible items
 * (≤ `perRepoMax` per repo), run the agent on each in an isolated **job
 * worktree** (the shared execution substrate — hub mirror + worktree + seams),
 * gate on acceptance tests, rebase onto the latest arbiter main, and integrate
 * the green ones. The runner owns EVERY git-state transition (claim, done-move,
 * completion commit, integration); the agent only edits code. A lost race (claim
 * exit 2) is skipped cleanly; failing work never reaches `work/done/`; a rebase
 * conflict is aborted and routed to needs-attention (ADR §10).
 */
export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
	const config = options.config;
	// Default discovery is the REGISTRY (the hub-mirror set, ADR §1) — the reframe
	// that landed in `run-daemon-reframe` (work/done/). Callers that still operate
	// on WORKING CHECKOUTS (the CLI / its tests) inject an explicit `report` built
	// from working-tree paths ({@link scanRepoPaths}); without an injected report
	// we fall back to the registry scan (async).
	const report =
		options.report ?? (await scan(config, {override: options.override}));
	const candidates = selectCandidates(report, {
		maxParallel: config.maxParallel,
		perRepoMax: config.perRepoMax,
	});

	// The launch harness: an explicit injection wins (tests); otherwise build the
	// adapter the config selects (`harness: 'pi'` ⇒ the pi CLI; default ⇒ null,
	// shelling out to `agentCmd`). pi specifics stay behind the seam.
	const harness =
		options.harness ??
		createHarness({harness: config.harness, piBin: config.piBin});
	// An explicitly-injected provider INSTANCE (tests / embedding) wins over
	// per-item auto-detection; otherwise each item selects its own provider PURELY
	// from its arbiter URL (see runOneItem). This is the resolved provider OBJECT,
	// not a config override (there is none — the provider is arbiter-derived).
	const provider = options.provider;
	const workspace = options.workspace ?? config.workspacesDir;
	const env = options.env;

	// The per-repo claim serialiser: the ONLY shared-working-tree step in the
	// otherwise-concurrent tick is the claim (it prepares its micro-commit in the
	// repo's checkout/mirror). Two concurrent claims in ONE repo would corrupt each
	// other's HEAD/index, so we serialise the CLAIM per repo (cheap — mv + commit +
	// CAS push) while the agent run + the rebase-or-abort integration stay fully
	// concurrent in each job's OWN worktree. Distinct repos claim in parallel.
	const claimLock = createKeyedLock();

	// The per-repo INTEGRATE serialiser — the SIBLING of `claimLock`, the same
	// `createKeyedLock` primitive keyed on the same repo key. The land-on-`main`
	// TAIL of merge-mode integration (fetch+rebase → `${branch}:main` push) is a
	// shared-`main` step: two concurrent SAME-repo merge jobs both rebase onto the
	// same pre-merge base and the loser's plain push is non-fast-forward (today it
	// only works by benign timing). Serialising ONLY that tail per repo (the seam
	// is applied INSIDE `performIntegration`, around step 4–5, NOT the whole call —
	// the slow gate + Gate-2 review stay at the front, OUTSIDE the lock, so they
	// run concurrently) makes the loser re-fetch + rebase onto the winner's
	// now-advanced main, so its push is a clean fast-forward. Distinct repos
	// integrate in parallel (per-repo key); a genuine same-repo code conflict
	// routes exactly ONE job to needs-attention (it cannot both-land).
	//
	// This lock is the SIBLING-INTEGRATE serialiser ONLY. It does NOT cover the
	// claim-vs-integrate race: a sibling same-repo CLAIM advances `<arbiter>/main`
	// under the SEPARATE `claimLock` (above), which can land INSIDE this job's
	// integrate push window. That is closed independently by the integrator's
	// bounded re-rebase-and-retry on a non-fast-forward merge push (task
	// `run-fleet-claim-integrate-and-sibling-rebase-concurrency-safe`, Race 1) — the
	// two locks are NOT merged (merging would serialise the cheap claim behind the
	// slow gated integrate, killing run's parallelism), the retry handles the
	// cross-lock main-advance instead.
	const integrateLock = createKeyedLock();

	// GENUINELY CONCURRENT (ADR §3 — the whole point of `run`): run up to
	// `maxParallel` `runOneItem`s IN FLIGHT at once, capped at `perRepoMax`
	// concurrently per repo. The caps now bound ACTUAL in-flight execution, not just
	// selection (this replaced the old `for (const c) { await runOneItem }` loop
	// that ran selected candidates one-at-a-time). The substrate is parallel-ready —
	// each slug → a distinct `work/<slug>` branch → a distinct job worktree, and the
	// arbiter CAS serialises claims (a loser gets dropped) — so the only shared state
	// across in-flight jobs is read-only config; each job owns its own worktree.
	// Integration ordering is independent per job: each rebases-or-aborts onto a
	// moving `<arbiter>/main` on its own, and a conflict routes only THAT job to
	// needs-attention (the executor never lets one job's failure abort the others).
	const settled = await runConcurrent({
		items: candidates,
		maxInFlight: config.maxParallel,
		keyFor: (candidate) => candidate.repoPath,
		perKeyMax: config.perRepoMax,
		worker: (candidate) =>
			runOneItem(candidate, {
				config,
				override: options.override,
				workspace,
				dorfl: options.dorfl,
				harness,
				reviewGate: options.reviewGate,
				provider,
				ghCanOpenPr: options.ghCanOpenPr,
				openPr: options.openPr,
				env,
				onWarn: options.onWarn,
				backoff: options.backoff,
				sleep: options.sleep,
				claimLock,
				integrateLock,
			}),
	});
	// `runOneItem` is total (it maps every failure to an `ItemResult` and never
	// throws), so a captured `{error}` slot is a defensive last resort — surface it
	// as a claim-error item rather than crashing the whole tick.
	const items: ItemResult[] = settled.map((slot, i) =>
		'ok' in slot
			? slot.ok
			: {
					repoPath: candidates[i].repoPath,
					slug: candidates[i].slug,
					status: 'claim-error' as const,
					detail: (slot.error as Error)?.message ?? String(slot.error),
				},
	);

	const claimedAndDone = items.filter(
		(i) => i.status === 'claimed-done',
	).length;
	const skipped = items.filter(
		(i) => i.status === 'lost-race' || i.status === 'claim-contended',
	).length;
	const needsAttention = items.filter(
		(i) =>
			i.status === 'tests-failed' ||
			i.status === 'needs-attention' ||
			i.status === 'agent-stopped',
	).length;
	const failed = items.filter(
		(i) =>
			i.status === 'tests-failed' ||
			i.status === 'needs-attention' ||
			i.status === 'agent-stopped' ||
			i.status === 'agent-failed' ||
			// The FAILURE-CAUSE refinements of `agent-failed` count the SAME way (they
			// are the same agent/run-failure routed to needs-attention, just labelled
			// by cause).
			i.status === 'transient-infra' ||
			i.status === 'needs-reauth' ||
			i.status === 'config-error' ||
			// The surface to needs-attention did NOT land (lost the CAS race); the item
			// is still in-progress on the arbiter — a genuine FAILURE (not a clean
			// needs-attention), so it counts as failed, NOT in `needsAttention`.
			i.status === 'surface-unmoved' ||
			i.status === 'claim-error',
	).length;

	return {claimedAndDone, skipped, failed, needsAttention, items};
}

interface OneItemContext {
	config: Config;
	override?: ConfigOverrideMap;
	workspace: string;
	dorfl?: Dorfl;
	harness: Harness;
	/** The PR/code review gate (Gate 2) seam threaded into `performIntegration`. */
	reviewGate?: ReviewGate;
	/** An explicitly-injected provider that overrides per-item auto-detection. */
	provider?: ReviewProvider;
	/**
	 * The `gh` AUTH/AVAILABILITY PROBE the PR-INTENT pre-flight guard runs per item
	 * BEFORE the claim (see {@link RunOnceOptions.ghCanOpenPr}). Injectable for
	 * tests; production defaults to `new GitHubProvider().available(repoPath, env)`.
	 */
	ghCanOpenPr?: (cwd: string, env: NodeJS.ProcessEnv | undefined) => boolean;
	openPr?: (opts: {
		cwd: string;
		branch: string;
		env?: NodeJS.ProcessEnv;
	}) => void;
	env?: NodeJS.ProcessEnv;
	/**
	 * The INTEGRATION-PATH env (identity feature): the env for git/provider
	 * operations (claim, push, needs-attention surface, `gh`), derived from
	 * `config.identity` per-repo. Distinct from `env` (the AGENT launch env, which
	 * stays plain ambient — the runner, not the agent, acts as the identity). Set
	 * per-item in {@link runOneItem}; absent ⇒ falls back to `env` (no identity).
	 */
	gitEnv?: NodeJS.ProcessEnv;
	onWarn?: (message: string) => void;
	/** Bounded-backoff bounds for the needs-attention route's network ops. */
	backoff?: BackoffOptions;
	/** Injectable sleep for that backoff (tests; defaults to real `setTimeout`). */
	sleep?: Sleep;
	/**
	 * Per-repo claim serialiser (shared across the tick's in-flight jobs). The claim
	 * step mutates the repo's shared working tree, so it is serialised per repo;
	 * everything after the claim runs in this job's own worktree and stays
	 * concurrent. Optional so a direct `runOneItem` caller (none today) degrades to
	 * an un-contended lock.
	 */
	claimLock?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
	/**
	 * Per-repo INTEGRATE serialiser (shared across the tick's in-flight jobs), the
	 * SIBLING of {@link claimLock}. Threaded into `performIntegration` as the
	 * `integrateLock` seam, where it wraps ONLY the rebase-to-integrate TAIL (step
	 * 4 fetch+rebase → step 5 integrate), so same-repo merge jobs land on `main`
	 * one-at-a-time (the loser rebases onto the winner's advanced main ⇒ a clean
	 * fast-forward) while their gate + Gate-2 review still run concurrently.
	 * Cross-repo integration stays concurrent (keyed per repo). Optional so a
	 * direct `runOneItem` caller (none today) degrades to an un-contended lock.
	 */
	integrateLock?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
}

async function runOneItem(
	candidate: Candidate,
	ctx: OneItemContext,
): Promise<ItemResult> {
	const {slug, repoPath} = candidate;
	const base: ItemResult = {repoPath, slug, status: 'lost-race'};

	// Resolve THIS repo's effective config against its own `dorfl.json`
	// layered over the global config (flag > per-repo > global > default). Each
	// repo gets its own integration mode / arbiter, so repo A can be `merge`
	// while repo B is `propose` in one tick.
	const resolved = resolveRepoConfig({
		repoPath,
		global: ctx.config,
		override: ctx.override,
	});
	const config = resolved.config;
	if (resolved.message) {
		ctx.onWarn?.(resolved.message);
	}

	// The IDENTITY env for this repo's GIT + provider operations (claim, push,
	// integration, `gh`). Derived from the host-only `config.identity` (absent ⇒
	// `ctx.env` unchanged, byte-for-byte ambient). This is the INTEGRATION-PATH
	// env ONLY: the agent launch keeps the plain ambient `ctx.env` (the runner,
	// not the agent, acts as the configured identity — design point 4). The push-
	// time transport-coherence guard (`assertTransportAllowed`) fires before the
	// integration push (where the arbiter URL is known), turning a forbidden
	// transport into a clear error, never a silent wrong-account push.
	let gitEnv: NodeJS.ProcessEnv;
	try {
		gitEnv = identityEnv(config.identity, ctx.env ?? process.env);
	} catch (err) {
		// A configured identity that cannot be resolved (e.g. `tokenEnv` names an
		// unset env var) is a CONFIG error — fail THIS item cleanly (surfaced), never
		// crash the tick or silently fall back to an ambient credential.
		const message = (err as Error).message;
		ctx.onWarn?.(message);
		return {...base, status: 'config-error', detail: message};
	}
	// A per-ITEM context carrying `gitEnv` so the needs-attention save helpers
	// (`saveAgentFailure`/`saveAgentStop`) push under the identity too. We rebind a
	// COPY (never mutate the shared tick `ctx` — items run concurrently).
	ctx = {...ctx, gitEnv};

	// 0. PR-INTENT pre-flight guard — the AUTONOMOUS mirror of in-place `performDo`
	//    step 3c. The SAME predicate, run UP FRONT here (per-repo config resolved,
	//    BEFORE the claim) so a `propose` item on a GitHub arbiter that INTENDS a PR
	//    (`noPR` unset) fails fast when `gh` genuinely cannot open one, instead of
	//    letting integration silently degrade to manual-PR instructions. CRITICAL: the
	//    probe runs BEFORE the claim — claiming then refusing would strand the item
	//    in-progress on main (the claim precedes `prepare()`). The arbiter URL is
	//    derived from `repoPath` the SAME way `claimAgainstRepo` derives the claim
	//    target (`arbiterUrlForRepo`). The PROBE is the signal, NOT a config check —
	//    an absent `providers.github` identity falls back to AMBIENT `gh` auth (the
	//    probe reports it available), so a working ambient setup PROCEEDS. A true
	//    result returns a CLEAN PRE-CLAIM item result on the `config-error` failure-
	//    cause status (a wiring/config failure, NOT a task fault), with NO claim,
	//    build, or half-built needs-attention surface — and it never crashes the tick
	//    or aborts siblings (the result is returned; `runConcurrent` continues).
	//    REUSES the predicate + message so the in-place + autonomous paths cannot
	//    drift.
	{
		const arbiterUrl = arbiterUrlForRepo({
			repoPath,
			arbiter: config.defaultArbiter,
			env: gitEnv,
		});
		const probe =
			ctx.ghCanOpenPr ??
			((probeCwd, probeEnv) =>
				new GitHubProvider().available(probeCwd, probeEnv));
		if (
			shouldFailProposePrIntent({
				mode: config.integration,
				arbiterIsGitHub: isGitHubArbiterUrl(arbiterUrl),
				noPR: config.noPR,
				ghCanOpenPr: () => probe(repoPath, gitEnv),
			})
		) {
			return {
				...base,
				status: 'config-error',
				detail: PROPOSE_PR_INTENT_GH_UNAVAILABLE_MESSAGE,
			};
		}
	}

	// 0b. STATIC fresh-worktree-gate readiness guard — the fleet mirror of
	//     `performDo` step 3d / `performDoRemote` step 1c (task
	//     `do-fails-fast-when-acceptance-gate-statically-unrunnable`). When the
	//     fresh-worktree gate is ON AND `prepare` resolves to no commands AND a
	//     lockfile is present in the repo, the throwaway worktree the gate runs in
	//     will have no installed deps, so the gate cannot run. Fail this item
	//     CLEANLY before the claim (no claim, no isolate, no agent, no surface) so a
	//     fleet tick never burns a build to discover a STATIC config gap and never
	//     routes correct work to needs-attention for this reason. Surfaced on the
	//     same `config-error` axis the PR-intent guard above uses (a wiring/config
	//     fault, not a task fault). The repo discovery is either a working checkout
	//     (in-place tests) OR a BARE hub mirror (production fleet); detect the
	//     lockfile from whichever shape `repoPath` is. ALSO fails fast when
	//     `verify` is unset/all-blank (a MODE-INDEPENDENT stop — Dorfl has no
	//     default gate, so an unconfigured `verify` can never pass in any mode).
	{
		const lockfile =
			detectLockfileOnDisk(repoPath) ??
			detectLockfileOnMirrorMain(repoPath, gitEnv);
		const guard = checkGatePreconditions({
			freshWorktreeGate: config.freshWorktreeGate,
			prepare: config.prepare,
			verify: config.verify,
			lockfile,
		});
		if (guard !== undefined) {
			return {...base, status: 'config-error', detail: guard.message};
		}
	}

	// 1. Claim (the runner's first git-state transition) via the in-process CAS.
	//    `claimAgainstRepo` handles BOTH discovery shapes: a working CHECKOUT (the
	//    in-place test/`do` path — claim directly) and a BARE registry hub mirror
	//    (`run`'s production discovery — claim in a throwaway clone, since a bare
	//    repo cannot `git mv`/`git commit`; the SAME pattern `do --remote` uses). It
	//    returns the `fromRepo`/`strategyArbiter` the worktree strategy resolves its
	//    mirror off (kept alive until AFTER prepare). `performClaim` is async, so two
	//    awaited claims over one slug genuinely race — the arbiter ref-CAS picks the
	//    winner.
	const doClaim = () =>
		claimAgainstRepo({
			slug,
			repoPath,
			workspace: ctx.workspace,
			arbiter: config.defaultArbiter,
			env: gitEnv,
		});
	// Serialise the claim PER REPO (it prepares its micro-commit in a checkout/clone
	// of the repo) so two in-flight jobs in the same repo do not stomp on each
	// other; the arbiter CAS then picks the winner across machines. Different repos
	// (and everything AFTER the claim) run concurrently.
	const repoClaim = ctx.claimLock
		? await ctx.claimLock(repoPath, doClaim)
		: await doClaim();
	const claim = repoClaim.claim;
	if (claim.outcome === 'lost') {
		repoClaim.cleanup();
		return {...base, status: 'lost-race'};
	}
	if (claim.outcome === 'contended') {
		repoClaim.cleanup();
		return {...base, status: 'claim-contended'};
	}
	if (claim.outcome === 'usage-error') {
		repoClaim.cleanup();
		return {...base, status: 'claim-error', detail: claim.message};
	}

	// 2. Isolate via the isolation-strategy seam (ADR §3). `run` always selects
	//    the JOB-WORKTREE strategy: materialise the hub mirror + cut a per-job
	//    worktree off the freshly-fetched `<hub>/main` in the agents' area
	//    (ADR §1/§2). The seam yields a UNIFORM HANDLE (dir/branch/arbiterRemote/
	//    arbiterUrl + a strategy-appropriate teardown) that the post-claim pipeline
	//    below reads from — never a concrete `Job` — so the SAME steps serve the
	//    in-place strategy too (wired by `do-in-place`). The mirror is keyed off
	//    the arbiter URL resolved from this repo, so jobs reuse it (fetch, not
	//    re-clone) across the run.
	const strategy: IsolationStrategy = jobWorktreeStrategy({
		// In-place: the checkout. Bare-mirror: the throwaway claim CLONE (still alive)
		// — the strategy resolves the mirror URL off it at prepare time, then we drop it.
		fromRepo: repoClaim.fromRepo,
		arbiter: repoClaim.strategyArbiter,
		workspacesDir: ctx.workspace,
	});
	let tree: IsolatedTree | undefined;
	try {
		tree = strategy.prepare({slug, env: gitEnv});
		// The claim clone (bare-mirror path) has done its job: the mirror is
		// materialised + the worktree cut. Drop it (no-op for the in-place path).
		repoClaim.cleanup();

		// 2a. CONTINUE rebase conflict (ADR §14 + §10): a requeue kept a
		//     `work/<slug>` whose commits did not replay cleanly onto the current
		//     main at onboard-time (aborted, never auto-resolved). Route the item to
		//     needs-attention TREE-LESSLY via the SAME `#89` mechanism `requeue` uses
		//     for the reverse direction — the rebase was ABORTED, so this worktree's
		//     `work/<slug>` tip == the arbiter tip (the kept branch, unchanged,
		//     after-commit). The DURABLE artifact is that branch on the arbiter + the
		//     main surface (ADR §14: the job worktree is a disposable cache; recovery
		//     flows through the branch + lock surfaces, NOT by editing the
		//     worktree). So the surface is purely the lock amend to `state: stuck` +
		//     reason (post lock-cutover — no `in-progress/ → needs-attention/` folder
		//     move, no branch push, no worktree
		//     mutation). Because the branch is provably on the arbiter, the §4 reap
		//     predicate still HOLDS and this worktree is reaped — more §14-aligned.
		if (tree.continueRebaseConflict) {
			const reason =
				`continuing the kept ${tree.branch}: rebase onto the latest main ` +
				'conflicted (aborted, never auto-resolved) — run `requeue --reconcile` ' +
				'to non-destructively re-sync the mirror and retry the rebase (keeps ' +
				'the work). Last resort: `requeue --reset` DESTRUCTIVELY discards the ' +
				'branch and starts fresh.';
			updateJobRecord(tree.dir, {state: 'needs-attention', reason});
			const surfaced = await ledgerWrite.applyTreelessNeedsAttentionTransition({
				cwd: tree.dir,
				slug,
				reason,
				arbiter: tree.arbiterRemote,
				env: gitEnv,
			});
			if (!surfaced.moved) {
				return surfaceUnmovedItemResult({base, tree, slug, reason, surfaced});
			}
			return {...base, status: 'needs-attention', detail: reason};
		}

		// 2b. CONTINUE reconcile-push TERMINAL failure (the stale-lease-strand bug):
		//     the onboard reconcile push of the kept (already-committed) work branch
		//     FAILED terminally (stale-lease cap exhausted, or a non-stale-lease
		//     rejection / unreachable arbiter). The push helper THROWS; `createJob`
		//     CATCHES it and flags `continuePushFailure` so the tick does NOT crash
		//     leaving the task silently in-progress on the arbiter. Surface to
		//     needs-attention TREE-LESSLY via the SAME `#89` mechanism `requeue` uses —
		//     the kept branch already on the arbiter from the prior requeue
		//     (after-commit, recoverable), so the surface is purely the one-file ledger
		//     move + reason (no branch push, no worktree) — instead of running the agent.
		if (tree.continuePushFailure !== undefined) {
			const reason =
				`continuing the kept ${tree.branch}: publishing the rebased work branch ` +
				`to the arbiter failed terminally (${tree.continuePushFailure}) — the ` +
				'kept branch is left intact on the arbiter (recoverable); ' +
				'`requeue --reconcile` to non-destructively re-sync the mirror and ' +
				'retry once the churn settles (keeps the work). Last resort: ' +
				'`requeue --reset` DESTRUCTIVELY discards the branch and starts fresh.';
			updateJobRecord(tree.dir, {state: 'needs-attention', reason});
			const surfaced = await ledgerWrite.applyTreelessNeedsAttentionTransition({
				cwd: tree.dir,
				slug,
				reason,
				arbiter: tree.arbiterRemote,
				env: gitEnv,
			});
			if (!surfaced.moved) {
				return surfaceUnmovedItemResult({base, tree, slug, reason, surfaced});
			}
			return {...base, status: 'needs-attention', detail: reason};
		}

		// 3. Build the prompt — the SAME dual-use assembly `dorfl prompt`
		//    emits: the canonical wrapper (+ source spec) + the task's ## Prompt.
		let prompt: string;
		try {
			// CONTINUE-aware resolution: only on a continue (the job continued a kept
			// arbiter `work/<slug>`) may the task already be in `work/done/`; admit
			// `done/` ONLY behind the tip-vs-arbiter stranded gate (story 5). In a bare
			// hub mirror's worktree the refs are the LOCAL heads `work/<slug>` / `main`.
			const task = resolveTask(
				tree.dir,
				slug,
				tree.continued
					? {
							cwd: tree.dir,
							branchRef: tree.branch,
							mainRef: 'main',
							env: gitEnv,
						}
					: undefined,
			);
			// CONTINUE-mode (the `agent-prompt-continue-context` task): when the job
			// CONTINUED a kept arbiter `work/<slug>` (a requeue), inject the continue
			// block (prior diff + reason + handoff note). REUSE the SAME continue-
			// detection — in a bare hub mirror's worktree the refs are the LOCAL heads
			// `work/<slug>` and `main` (after `ensureMirror`'s mirror-style fetch).
			const continueContext = tree.continued
				? resolveContinueContext({
						cwd: tree.dir,
						slug,
						arbiter: tree.arbiterRemote,
						branchRef: tree.branch,
						mainRef: 'main',
						content: readFileSync(task.path, 'utf8'),
						env: gitEnv,
					})
				: undefined;
			// Thread the resolved per-repo nudge through the per-item override layer
			// (a task or spec may pin `promptGuidance.testFirst` in its frontmatter,
			// superseding the repo policy for THIS item) before the wrapper is built.
			const itemGuidance = resolvePromptGuidanceForItem({
				cwd: tree.dir,
				repoResolved: resolvePromptGuidance(config),
				taskContent: readFileSync(task.path, 'utf8'),
			});
			prompt = buildAgentPrompt(task.slug, task.spec, task.taskPrompt, {
				cwd: tree.dir,
				continueContext,
				promptGuidance: itemGuidance,
			});
		} catch (err) {
			if (err instanceof PromptError) {
				return await saveAgentFailure(base, tree, slug, err.message, ctx);
			}
			throw err;
		}

		// 4. Run the agent — via the injected runner (tests) or the harness seam
		//    (null adapter by default), shelling out to the configured agentCmd. The
		//    resolved per-repo `buildModel` (ADR §13, which inherits the general
		//    `model` when unset) flows through the seam to the adapter; a
		//    `{model}`-in-agentCmd misconfiguration surfaces as agent-failed.
		let agent: {ok: boolean; detail?: string; output?: string};
		try {
			agent = runAgent(
				ctx,
				tree,
				prompt,
				slug,
				config.agentCmd,
				config.buildModel,
				config.sessionsDir,
			);
		} catch (err) {
			return await saveAgentFailure(
				base,
				tree,
				slug,
				(err as Error).message,
				ctx,
			);
		}
		if (!agent.ok) {
			return await saveAgentFailure(
				base,
				tree,
				slug,
				agent.detail ?? `the agent failed to build '${slug}'.`,
				ctx,
			);
		}

		// 4b. HONOR a deliberate STOP (task `agent-stop-signal`) — the SAME detection
		//     in-place/remote `do` run, mirrored here. The agent exited cleanly but the
		//     CLAIM-PROTOCOL wrapper tells it to STOP on a DRIFTED/ambiguous task; an
		//     in-band sentinel carries its reason VERBATIM, and the empty-diff backstop
		//     catches a stop without one. Either routes to needs-attention (surfaced on
		//     the arbiter) and SKIPS the gate + Gate-2 (the whole `performIntegration`
		//     band) — a clean STOP is NOT "a build that changed nothing".
		const sentinel = parseStopSentinel(agent.output);
		const stopReason: {kind: AgentStopKind; reason: string} | undefined =
			sentinel !== undefined
				? {kind: 'sentinel', reason: sentinel.reason}
				: (await isWorkBranchDiffEmpty({
							cwd: tree.dir,
							arbiter: tree.arbiterRemote,
							env: gitEnv,
					  }))
					? {kind: 'empty-diff', reason: emptyDiffStopReason(slug)}
					: undefined;
		if (stopReason !== undefined) {
			return await saveAgentStop(
				base,
				tree,
				slug,
				stopReason.reason,
				stopReason.kind,
				ctx,
			);
		}

		// 5–7 (CONVERGED). The whole gate → review → done-move → commit → rebase →
		// integrate band — plus the needs-attention routing on any failure — now runs
		// through the SHARED `performIntegration` core (`integration-core.ts`, the
		// run/do convergence spec). `run` no longer forks its own gate / done-move /
		// completion commit / `Integrator`+`integrateWithRebase`: that closed all
		// three drift instances at once (the fleet now gets the review gate, the PR
		// title/body, AND the per-repo language-agnostic `verify` gate instead of the
		// old test-only `pnpm -r test` floor). The HEAD above (claim, isolate, agent,
		// failure-save) and the TAIL below (job record + worktree reap) stay here;
		// the band is what they share. `run` is ALWAYS autonomous, so it ALWAYS
		// passes `surfaceArbiter` (every failure surfaces on the arbiter's main +
		// pushes the branch). The injected `openPr` legacy bridge is forwarded to the
		// core unchanged; absent it the core selects the provider PURELY from the
		// arbiter URL (a GitHub remote ⇒ `gh pr create`). The per-repo `noPR` INTENT
		// (suppress the PR) rides separately — it does not pick a provider.
		//
		// `performIntegration` THROWS a plain `Error` for a misconfigured gate
		// (`review` on with no `reviewGate` wired) — `run`'s CLI always wires one when
		// `config.review` is on, so that is a defensive case, but it must NOT crash
		// the whole tick. We catch it and route the item through the same
		// work-preserving needs-attention seam an agent failure uses (`saveAgentFailure`)
		// so the worktree is handled and the run continues to the next item.
		// Push-time transport-coherence guard (identity feature): refuse a forbidden
		// transport for THIS arbiter's actual URL rather than silently pushing under
		// an ambient credential. A no-op when no identity is configured.
		try {
			assertTransportAllowed(config.identity, tree.arbiterUrl);
		} catch (err) {
			return await saveAgentFailure(
				base,
				tree,
				slug,
				(err as Error).message,
				ctx,
			);
		}

		let core;
		try {
			core = await performIntegration({
				cwd: tree.dir,
				// The arbiter remote name valid inside the isolated tree (job-worktree:
				// the mirror's clone remote `origin`), NOT the source repo's
				// `defaultArbiter` name.
				arbiter: tree.arbiterRemote,
				slug,
				// Claim no longer moves the body (task
				// `cutover-claim-body-stays-and-complete-sources-from-backlog`): a
				// freshly-built task RESTS in `tasks/ready/` on `main`, so the done-move
				// sources from there.
				source: 'tasks-ready',
				recovering: false,
				// `run` is ALWAYS autonomous → surface every failure on the arbiter's
				// main AND push the work branch (DATA, not a caller-identity flag).
				surfaceArbiter: tree.arbiterRemote,
				// The per-repo, language-agnostic gate (ADR §8) — the protocol-conformance
				// fix: `run` now honours `config.verify` instead of the deleted
				// `defaultTestGate`'s hardcoded `pnpm -r test`.
				verify: config.verify,
				// The per-repo ENV-PREP step (`prepare`), sequenced ONCE before the first
				// `verify` on the fresh job worktree so it has deps (a fresh worktree off
				// the mirror has no `node_modules`). Unset ⇒ a no-op; never baked into verify.
				prepare: config.prepare,
				// FRESH-WORKTREE GATE (task `gate-on-rebased-tip-fresh-worktree`): run the
				// acceptance gate against the REBASED tip in a clean throwaway worktree (the
				// tree that integrates) so a green gate provably describes the merged
				// artifact. Passed UNCONDITIONALLY (the resolved flag) at ANY `perRepoMax`:
				// the two PRE-EXISTING run-fleet same-repo races the gate's latency used to
				// make deterministic are now CLOSED on their own merits (task
				// `run-fleet-claim-integrate-and-sibling-rebase-concurrency-safe`) — RACE 1
				// (claim-vs-integrate non-fast-forward push) by the integrator's bounded
				// re-rebase-and-retry on the merge push, RACE 2 (sibling-slug divergent-base
				// ledger rebase) by the step-4 sibling-ledger reconciliation arm — so the
				// `perRepoMax === 1` downgrade is REMOVED and the fresh rebased-tip gate runs
				// on the `run` fleet at any same-repo parallelism. Single-job callers
				// (`do`/`--isolated`/`--remote`/`complete`) already pass it unconditionally.
				freshWorktreeGate: config.freshWorktreeGate,
				// The cross-job merge-serialiser CAS-retry cap (config `mergeRetries`) —
				// the git-alone FLOOR of the cross-job land queue (spec `land-time-reverify-
				// and-parallel-merge-ceiling` Story 5 / Applied Answer q1 (a)). Threaded
				// from the per-repo resolved config so a wide-matrix CI's raised cap actually
				// reaches the merge loop — across separate `run` fleet jobs the CAS loop IS
				// the queue (`integrateLock` only serialises sibling integrates in ONE process).
				mergeRetries: config.mergeRetries,
				// Gate 2 (PR/code review): the per-repo resolved flags ride from `config`;
				// only the gate SEAM is threaded through `ctx` (the CLI wires the prod
				// `harnessReviewGate()` only when `config.review` is on).
				review: config.review,
				reviewModel: config.reviewModel,
				reviewMaxRounds: config.reviewMaxRounds,
				reviewGate: ctx.reviewGate,
				mode: config.integration,
				// PR-INTENT: the per-repo `noPR` (suppress the PR even on an authed GitHub
				// arbiter). NOT a provider choice — the provider is purely arbiter-derived.
				noPR: config.noPR,
				// Provider: an injected `openPr` wins (legacy test bridge); otherwise the
				// core selects PURELY from the arbiter URL (a GitHub remote ⇒ `gh pr
				// create`, else push-only `none`). `providerInstance` (the resolved object
				// the `run` seam injects) STAYS — it is a DIFFERENT `provider`.
				providerInstance: ctx.provider,
				openPr: ctx.openPr,
				// The per-repo INTEGRATE serialiser (sibling of the claim lock): the
				// core applies it around ONLY the rebase-to-integrate TAIL, keyed on
				// the repo path (the same key the claim lock uses), so two same-repo
				// merge jobs land on `main` one-at-a-time. Absent on single-job paths.
				integrateLock: ctx.integrateLock,
				integrateLockKey: repoPath,
				// Half A/B: the synthesised single-line title + the agent's surfaced
				// final summary as the PR body (the core scaffolds the task-pointer
				// header). `title` is synthesised inside the core from the task's
				// frontmatter; `body` is the agent output (undefined ⇒ `--fill`).
				body: agent.output,
				env: gitEnv,
				// The review AGENT (Gate 2) launches AMBIENT — never the identity env
				// (an agent must not act as the bot; only the runner's git ops do).
				agentEnv: ctx.env,
			});
		} catch (err) {
			// A thrown core error (misconfigured gate, or an unexpected plumbing
			// failure) — SAVE the work + route to needs-attention, never crash the tick.
			return await saveAgentFailure(
				base,
				tree,
				slug,
				(err as Error).message,
				ctx,
			);
		}

		// TAIL: map the core's DATA outcome onto the job record + `ItemStatus`. The
		// core already ran the gate/review/move/commit/rebase/integrate AND did the
		// needs-attention routing; `run`'s tail does ONLY the job-record write + (in
		// `finally`) the worktree reap. `run` NEVER switches/ff/deletes branches
		// (that is `do`'s in-place tail; a job worktree is reaped, not switched).
		if (core.outcome === 'gate-failed') {
			updateJobRecord(tree.dir, {
				state: 'needs-attention',
				reason: core.reason,
			});
			return {...base, status: 'tests-failed', detail: core.reason};
		}
		if (core.outcome === 'review-unparseable') {
			// Gate 2 RAN but its verdict was UNPARSEABLE (malformed JSON). The core already
			// routed it work-preservingly (branch pushed + surfaced). FAILURE-CAUSE axis,
			// NOT a reviewer block: classify the parse-failure phrase the core recorded →
			// `transient-infra` (re-run the SAME work — the stochastic gate + the parser's
			// repair pass make a re-run far more likely to parse), the SAME
			// `classifyFailureCause` `do` uses, so the cross-path label agrees. The job
			// record carries the classified status; the worktree is retained by the §4 reap.
			const cause = classifyFailureCause(core.reason);
			updateJobRecord(tree.dir, {
				state: 'needs-attention',
				reason: core.reason,
			});
			return {
				...base,
				status: failureCauseToItemStatus(cause),
				detail: core.reason,
			};
		}
		if (
			core.outcome === 'prepare-failed' ||
			core.outcome === 'review-blocked' ||
			core.outcome === 'rebase-conflict' ||
			core.outcome === 'sidecar-violation' ||
			core.outcome === 'invariant-violation'
		) {
			// `sidecar-violation`: a co-located `<slug>/` sidecar sits beside a FLOWING
			// task/spec item (WORK-CONTRACT rule 8) — a HARD BLOCK before the durable
			// move (it would strand on `ready → done`). The core routed it to
			// needs-attention with an actionable relocate-to-`docs/spikes/<slug>/`
			// reason; the least-supervised caller MUST NOT fall through to success.
			// `prepare-failed`: the env-prep (install) step was red, so the env could
			// not be made ready and `verify` was NOT run — distinct from a `tests-failed`
			// red gate. Route it to needs-attention like the others (a human fixes the
			// prepare command, then re-runs); the core already surfaced the bounce.
			// `invariant-violation`: the one-slug-one-folder guard FAILED LOUD (the
			// arbiter already holds the slug in >1 status folder — a corrupt ledger).
			// The core integrated NOTHING. On the LEAST-supervised caller this MUST
			// NOT fall through to the SUCCESS branch (state:'done' / 'claimed-done'
			// with no prUrl) — that would misreport a refusal as a completed job, the
			// opposite of fail-loud. Route it to needs-attention like a rebase conflict
			// (a human resolves the duplicate, then re-runs); `complete.ts` mirrors this
			// refusal with exit 1.
			updateJobRecord(tree.dir, {
				state: 'needs-attention',
				reason: core.reason,
			});
			return {...base, status: 'needs-attention', detail: core.reason};
		}

		// SUCCESS: the core integrated. Record the PR/MR URL (when a provider opened
		// one) on the job, surfaced by `status`.
		const prUrl = core.integration?.url;
		updateJobRecord(tree.dir, {state: 'done', prUrl});
		return {...base, status: 'claimed-done', integration: core.integration};
	} finally {
		// Strategy-appropriate teardown via the uniform handle (ADR §4). Job-worktree:
		// re-apply the provably-safe deletion predicate and remove the worktree ONLY
		// if it holds (clean tree AND the branch tip reachable on the arbiter — merged
		// or pushed). One rule, no done-vs-failed special-casing: a claimed-done job
		// is on the arbiter → reaped; a tests-failed / needs-attention / un-pushed job
		// is NOT → retained (the worktree is the needs-attention signal; `gc` catches
		// up). In-place: a NO-OP (the checkout is never reaped). NEVER `--force` here.
		if (tree) {
			tree.teardown();
		}
	}
}

/**
 * Run the agent against the isolated tree. Prefers the injected `dorfl`
 * (tests / custom embeddings); otherwise launches `agentCmd` through the harness
 * seam (recording the PID in the job's harness block, when there is one).
 */
function runAgent(
	ctx: OneItemContext,
	tree: IsolatedTree,
	prompt: string,
	slug: string,
	agentCmd: string,
	model: string | undefined,
	sessionsDir: string | undefined,
): {ok: boolean; detail?: string; output?: string} {
	if (ctx.dorfl) {
		return ctx.dorfl({cwd: tree.dir, prompt, slug, env: ctx.env});
	}
	// Generate the full pi session-FILE path (task `session-path-pi-default`):
	// `<sessionsDir>/<work-id>-<unique>.jsonl`, or pi's per-cwd default folder when
	// `sessionsDir` is unset. The work-id (arbiter URL + slug) is `run`'s natural
	// unique-per-claim id. Threaded through the seam so the pi adapter passes
	// `--session <path>` (never `--session-dir` into the worktree).
	const session = generateSessionPath({
		sessionsDir,
		cwd: tree.dir,
		id: encodeWorkId(tree.arbiterUrl, slug),
	});
	const launched = ctx.harness.launch({
		dir: tree.dir,
		slug,
		command: agentCmd,
		prompt,
		// The model routing intent (ADR §13) — the adapter decides HOW it reaches
		// its tool (pi: `--model`; null/shell: `{model}` placeholder).
		model,
		session,
		env: ctx.env,
	});
	updateJobRecord(tree.dir, {harness: launched.record});
	// Surface the agent's FINAL SUMMARY (`LaunchResult.output`) — the source channel
	// for the propose-mode PR body — instead of dropping it (mirrors `do`'s
	// `runDoAgent`). Absent (no parseable assistant text) ⇒ undefined ⇒ `--fill`.
	return {ok: launched.ok, detail: launched.detail, output: launched.output};
}

/**
 * SAVE the partial work of a FAILED agent instead of dropping it (closing the
 * fifth-and-last instance of the recurring asymmetry —
 * `work/notes/observations/run-agent-failure-does-not-save-work.md`). `run`'s
 * agent-failure return points (prompt-assembly fail / `runAgent` throw /
 * `agent.ok === false`) used to BARE-RETURN `agent-failed`, leaving whatever the
 * agent edited only on the LOCAL work branch in the (disposable, possibly remote)
 * job worktree — not on the arbiter, so a requeue-continue on a DIFFERENT machine
 * (or after a `gc` reap) re-cut fresh off main and orphaned it.
 *
 * This mirrors `do.ts`'s `saveAgentFailure`: route the failure through the SAME
 * ledger write seam's needs-attention transition the gate-fail / integrate-
 * conflict bounces use — which (with the arbiter) saves the agent's work as a wip
 * commit, then — post lock-cutover — amends the item's per-item lock to
 * `state: stuck` with the failure detail as the reason on the lock entry
 * (OBSERVABLE; the `needs-attention/` folder move is retired), AND pushes the
 * `work/<slug>` branch (RECOVERABLE — the durable
 * artifact a requeue-continue lands the next agent on; continue-detection reads
 * <arbiter>/work/<slug> ahead of main). The push is best-effort — an unreachable
 * arbiter leaves the retained worktree + the local commits standing (the genuinely
 * un-pushed case). The status is the classified failure CAUSE (`transient-infra` /
 * `config-error` where knowable, else the conservative generic `agent-failed`);
 * only the work-preserving side-effect now matches the gate-fail path.
 */
async function saveAgentFailure(
	base: ItemResult,
	tree: IsolatedTree,
	slug: string,
	detail: string,
	ctx: OneItemContext,
): Promise<ItemResult> {
	// Classify the failure CAUSE (best-effort + conservative) from the surfaced
	// detail via the SAME `classifyFailureCause` `do` uses — so a thrown CORE config/
	// wiring error reads as `config-error` (NOT `agent-failed`) on BOTH paths, closing
	// the cross-path divergence; a harness-surfaced model/connection outage reads as
	// `transient-infra`; an unrecognised cause stays the generic `agent-failed`. The
	// cause LABEL prefixes the recorded reason so the cause is legible on the
	// needs-attention route; `agent-failed` keeps the historical "agent failed:"
	// prefix (no reason-prose regression).
	const cause = classifyFailureCause(detail);
	const reason = `${failureCauseLabel(cause)}: ${detail}`;
	updateJobRecord(tree.dir, {state: 'needs-attention', reason});
	await ledgerWrite.applyNeedsAttentionTransition({
		cwd: tree.dir,
		slug,
		reason,
		// Autonomous (`run`): surface on the arbiter's main AND push the work branch
		// (the seam does both now), so the fleet's failed-agent work is cross-machine
		// recoverable via requeue-continue. The route is fault-tolerant: a git outage
		// is retried with bounded backoff then gives up cleanly (never hangs the tick).
		arbiter: tree.arbiterRemote,
		env: ctx.gitEnv ?? ctx.env,
		backoff: ctx.backoff,
		sleep: ctx.sleep,
	});
	return {...base, status: failureCauseToItemStatus(cause), detail};
}

/**
 * Map a {@link FailureCause} onto the `run` {@link ItemStatus}. The cause names
 * ARE the status names (the FAILURE-CAUSE axis reuses the terminal vocabulary), so
 * this is identity — a single helper documents the mapping + keeps the `do`/`run`
 * sites symmetric (`do` has the twin `failureCauseToDoOutcome`).
 */
function failureCauseToItemStatus(cause: FailureCause): ItemStatus {
	return cause;
}

/**
 * Build the HONEST {@link ItemResult} for a CONTINUE-site surface that did NOT
 * land on the arbiter (`{moved: false}`). The tree-less stuck-lock amend (post
 * lock-cutover — `state: stuck` + reason, in place of the retired `in-progress/ →
 * needs-attention/` move) lost the CAS race against a busy arbiter (its
 * contention-retry cap exhausted) or had no arbiter to publish to, so the item is
 * STILL in-progress on the arbiter — reporting a clean `needs-attention` would
 * mislead (it claims the surface landed, when it did not). The DISTINCT
 * `surface-unmoved` status carries `reasonNotMoved` so the caller/human can tell
 * it apart from a successful surface and retry/resolve.
 *
 * The local job record was set to `state: 'needs-attention'` (its LOCAL intent,
 * recorded regardless of the arbiter move) right before the surface; on a
 * `moved: false` we OVERWRITE its reason so that local record does not
 * confusingly claim a landed surface either.
 */
function surfaceUnmovedItemResult(params: {
	base: ItemResult;
	tree: IsolatedTree;
	slug: string;
	reason: string;
	surfaced: SurfaceToNeedsAttentionResult;
}): ItemResult {
	const {base, tree, slug, reason, surfaced} = params;
	const detail =
		`'${slug}' could NOT be surfaced to needs-attention — the surface did not ` +
		`reach the arbiter's main; the item is still IN-PROGRESS on the arbiter ` +
		`(retry/resolve). ${surfaced.reasonNotMoved ?? reason}`;
	updateJobRecord(tree.dir, {state: 'needs-attention', reason: detail});
	return {...base, status: 'surface-unmoved', detail};
}

/**
 * Route a DELIBERATE agent STOP (task `agent-stop-signal`) to needs-attention
 * through the SAME work-preserving seam `saveAgentFailure` uses, but as the
 * DISTINCT `agent-stopped` status (NOT `agent-failed` — the agent did not error;
 * NOT `tests-failed`/`needs-attention` — there was no red gate / rebase conflict).
 * The agent's STOP reason is recorded VERBATIM; the job record names it honestly.
 * The `performIntegration` band (gate + Gate-2) is NEVER reached.
 */
async function saveAgentStop(
	base: ItemResult,
	tree: IsolatedTree,
	slug: string,
	reason: string,
	kind: AgentStopKind,
	ctx: OneItemContext,
): Promise<ItemResult> {
	updateJobRecord(tree.dir, {state: 'needs-attention', reason});
	// EMPTY-DIFF branch (spec resolved decision #2, task
	// `empty-diff-bounce-surfaces-dispose-defaulted-question`): surface a sidecar
	// carrying an engine-authored DISPOSE-DEFAULTED envelope question on
	// `<arbiter>/main` (via the PR-1 tree-less surface primitive) and release the
	// lock — NOT the general lock-stuck bounce path. "Nothing to do" is a
	// non-deterministic LLM judgement, so a blind requeue would infinite-loop;
	// the surfaced sidecar + `needsAnswers:true` on `main` parks the item as a
	// human-visible question a `dispose` answer settles to `tasks/cancelled/`.
	if (kind === 'empty-diff') {
		const item = `task:${slug}`;
		const itemPath = resolveItemPathByIdentity(tree.dir, item);
		if (itemPath !== undefined) {
			await surfaceStuckToNeedsAttention({
				cwd: tree.dir,
				slug,
				item,
				itemPath,
				reason,
				envelope: emptyDiffDisposeEnvelope({item, reason}),
				arbiter: tree.arbiterRemote,
				env: ctx.gitEnv ?? ctx.env,
			});
			return {...base, status: 'agent-stopped', detail: reason};
		}
		// Fallthrough (body missing) — fall through to the lock-stuck bounce below.
	}
	await ledgerWrite.applyNeedsAttentionTransition({
		cwd: tree.dir,
		slug,
		reason,
		// Autonomous (`run`): surface on the arbiter's main AND push the work branch
		// (the seam does both), so the stopped item is cross-machine visible/recoverable.
		arbiter: tree.arbiterRemote,
		env: ctx.gitEnv ?? ctx.env,
		backoff: ctx.backoff,
		sleep: ctx.sleep,
	});
	return {...base, status: 'agent-stopped', detail: reason};
}

/** A throwaway default workspace under the OS temp dir (CLI convenience). */
export function defaultRunWorkspace(): string {
	return join(tmpdir(), 'dorfl-workspace');
}

/**
 * One supervised TICK over the registry, as a swappable unit. Today the tick IS
 * `runOnce` (claim+build+integrate a concurrent batch of eligible TASKS). The
 * loop ({@link runLoop}) is deliberately written against this signature — NOT
 * against `runOnce` directly — so the advance-loop spec can later swap the tick
 * (build / task / triage / surface / apply) WITHOUT re-architecting the loop
 * (the forward-pointer: the loop owns concurrency/scheduling, the tick owns one
 * item's work). The loop never reaches inside a tick.
 */
export type RunTick = (options: RunOnceOptions) => Promise<RunOnceResult>;

export interface RunLoopOptions extends RunOnceOptions {
	/**
	 * Stop after this many ticks. Unset ⇒ no iteration bound (the forever daemon,
	 * the future system service). A bounded session (an operator's stop discipline,
	 * absorbing the retired `watch` verb) sets this and/or `maxDurationMs`.
	 */
	maxIterations?: number;
	/**
	 * Stop once this many ms of wall-clock have elapsed (checked before each tick
	 * AND before each inter-tick sleep). Unset ⇒ no duration bound.
	 */
	maxDurationMs?: number;
	/**
	 * Pause between ticks (ms). Default 0 (back-to-back). The loop sleeps via the
	 * injectable {@link RunLoopOptions.sleep} so tests need not wait real time.
	 */
	intervalMs?: number;
	/** The tick to loop. Defaults to {@link runOnce}; tests/advance-loop inject. */
	tick?: RunTick;
	/** Clock seam (tests). Defaults to `Date.now`. */
	now?: () => number;
	/** Sleep seam (tests). Defaults to a real `setTimeout`. */
	sleep?: (ms: number) => Promise<void>;
	/**
	 * Cooperative stop signal, polled before each tick. When it returns true the
	 * loop ends cleanly after the current tick. The CLI wires this to a SIGINT/
	 * SIGTERM flag so the long-running daemon shuts down gracefully; tests use it to
	 * end an otherwise-forever loop deterministically.
	 */
	stop?: () => boolean;
	/** Called once per completed tick with its result + 1-based index (CLI logging). */
	onTick?: (result: RunOnceResult, iteration: number) => void;
}

/** Aggregate outcome of a {@link runLoop} session. */
export interface RunLoopResult {
	/** Number of ticks actually executed. */
	iterations: number;
	/** Why the loop ended. */
	stoppedBy: 'max-iterations' | 'max-duration' | 'signal';
	/** Sum of `claimedAndDone` across all ticks. */
	claimedAndDone: number;
	/** Sum of `skipped` across all ticks. */
	skipped: number;
	/** Sum of `failed` across all ticks. */
	failed: number;
	/** Sum of `needsAttention` across all ticks. */
	needsAttention: number;
	/** Each tick's result, in order. */
	ticks: RunOnceResult[];
}

const realSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `run` (no flag) — the cross-repo, parallel, **forever-looping daemon** (ADR §3):
 * loop the supervised concurrent tick over the registry until a stop bound
 * (max-iterations / max-duration / a stop signal) or forever (the future system
 * service). Each tick claims + runs a CONCURRENT batch ({@link runOnce}’s
 * `maxParallel`/`perRepoMax` in-flight execution), integrates, then the loop
 * continues. This absorbs the retired `watch` verb’s bounded-session + surface-
 * failures behaviour: a stuck item (timeout / red gate / rebase conflict) is
 * routed through the EXISTING ledger needs-attention seam INSIDE the tick
 * (`runOneItem` → `applyNeedsAttentionTransition`, surfaced on `main`) — the loop
 * does NOT infinite-retry it and adds NO bespoke failure reporting; it just keeps
 * ticking. `run --once` is exactly ONE tick (call {@link runOnce} directly, the
 * debug/test affordance — NOT the CI path; CI is `do`).
 *
 * The loop owns ONLY scheduling (when/whether to tick); the TICK owns one batch’s
 * work — kept separable so advance-loop can swap the tick later (see {@link
 * RunTick}).
 */
export async function runLoop(options: RunLoopOptions): Promise<RunLoopResult> {
	const tick = options.tick ?? runOnce;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? realSleep;
	const intervalMs = options.intervalMs ?? 0;
	const start = now();
	const deadline =
		options.maxDurationMs !== undefined
			? start + options.maxDurationMs
			: undefined;

	// The per-tick options are the RunOnceOptions subset of RunLoopOptions; the
	// loop-only knobs (bounds / seams / callbacks) are not forwarded to the tick.
	const tickOptions: RunOnceOptions = {
		config: options.config,
		report: options.report,
		workspace: options.workspace,
		dorfl: options.dorfl,
		harness: options.harness,
		reviewGate: options.reviewGate,
		provider: options.provider,
		openPr: options.openPr,
		env: options.env,
		agentId: options.agentId,
		onWarn: options.onWarn,
	};

	const ticks: RunOnceResult[] = [];
	let stoppedBy: RunLoopResult['stoppedBy'] = 'max-iterations';

	// eslint-disable-next-line no-constant-condition
	while (true) {
		// Stop-condition checks BEFORE running a tick (so a zero-iteration / already-
		// expired / pre-signalled session does no work).
		if (options.stop?.()) {
			stoppedBy = 'signal';
			break;
		}
		if (
			options.maxIterations !== undefined &&
			ticks.length >= options.maxIterations
		) {
			stoppedBy = 'max-iterations';
			break;
		}
		if (deadline !== undefined && now() >= deadline) {
			stoppedBy = 'max-duration';
			break;
		}

		const result = await tick(tickOptions);
		ticks.push(result);
		options.onTick?.(result, ticks.length);

		// Re-check the bounds AFTER the tick so we never sleep past a stop condition.
		if (
			options.maxIterations !== undefined &&
			ticks.length >= options.maxIterations
		) {
			stoppedBy = 'max-iterations';
			break;
		}
		if (deadline !== undefined && now() >= deadline) {
			stoppedBy = 'max-duration';
			break;
		}
		if (options.stop?.()) {
			stoppedBy = 'signal';
			break;
		}

		if (intervalMs > 0) {
			await sleep(intervalMs);
		}
	}

	return {
		iterations: ticks.length,
		stoppedBy,
		claimedAndDone: ticks.reduce((n, t) => n + t.claimedAndDone, 0),
		skipped: ticks.reduce((n, t) => n + t.skipped, 0),
		failed: ticks.reduce((n, t) => n + t.failed, 0),
		needsAttention: ticks.reduce((n, t) => n + t.needsAttention, 0),
		ticks,
	};
}
