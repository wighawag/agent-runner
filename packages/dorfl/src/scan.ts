import type {Config} from './config.js';
import type {ConfigOverrideMap} from './config-override.js';
import {resolveEligibility, type EligibilityResult} from './eligibility.js';
import {
	ledgerRead,
	type LedgerReadyItem,
	type LedgerSpecPool,
	type LocalLedgerState,
} from './ledger-read.js';
import {listMirrors} from './registry.js';
import {
	fetchMirrorMainOrWarn,
	resolveRepoConfigFromMirror,
} from './repo-mirror.js';
import {resolveRepoConfig} from './repo-config.js';
import {taskableSpecs} from './select-priority.js';
import {
	lintLocalLedger,
	lintRefLedger,
	type DuplicateSlug,
} from './ledger-lint.js';
import {
	gatherLifecycleInPlace,
	gatherLifecycleMirror,
} from './lifecycle-gather.js';
import type {LifecyclePoolGates} from './lifecycle-pools.js';
import {
	heldTaskSlugs,
	listItemLockEntries,
	classifyTerminalItemLocks,
	reconcileTerminalItemLocks,
	type LockEntry,
} from './item-lock.js';

/**
 * The CREATE-side lifecycle gates for the propose-matrix lifecycle pool, derived
 * from a repo's resolved config. Maps the config's question-surfacing gate family
 * onto the boolean {@link LifecyclePoolGates} `buildLifecyclePools` takes:
 *
 *   - `observationTriage !== 'off'` ⇒ `triage` ON (BOTH `ask` and `auto` enumerate
 *     triage candidates into the matrix identically; the ask/auto distinction is a
 *     DISPOSITION concern enforced LATER by the triage rung itself, not by whether
 *     a leg exists — the matrix only decides "is there a leg at all?").
 *   - `surfaceBlockers` ⇒ `surface` ON.
 *
 * `apply` is NOT a gate (CONSUME is always-on; `buildLifecyclePools` enumerates
 * answered sidecars regardless), so a committed answer always applies even with
 * both create-gates calm — the same create-vs-consume invariant the autopick
 * drivers honour (ADR `ci-config-policy-and-gate-family` §4). Reused on BOTH the
 * mirror (`scan`) and in-place (`scanRepoPaths`) substrates so the propose matrix
 * agrees with the `advance -n` / `run` selection.
 */
export function lifecycleGatesFrom(config: {
	observationTriage: string;
	surfaceBlockers: boolean;
	/**
	 * Spec `staging-surface-and-apply-promote-safety` F2 — the gate that widens
	 * the SURFACE candidate set into STAGING (`tasks/backlog/` + `specs/proposed/`).
	 * Threaded here so the `scan --json` `lifecycle.surface[]` reflects the
	 * expanded pool and the CI matrix enumerates staging surface legs. BUILD/claim
	 * stays pool-only — only this lifecycle path widens.
	 */
	surfaceStaging: boolean;
}): LifecyclePoolGates {
	return {
		triage: config.observationTriage !== 'off',
		surface: config.surfaceBlockers === true,
		surfaceStaging: config.surfaceStaging === true,
	};
}

/**
 * A lifecycle item as it appears on a {@link RepoReport.lifecycle} sub-pool: the
 * bare `slug` plus, for surface/apply, the `namespace` discriminator the matrix
 * `jq` projects into a `task:`/`spec:`/`observation:` prefix. Triage items carry
 * only `{slug}` — the `obs:` prefix is fixed in the matrix `jq`.
 */
export interface ScannedTriageItem {
	slug: string;
}
/**
 * A surface/apply lifecycle item, with its namespace. SURFACE only ever carries
 * `needsAnswers` task/spec items (an observation with no sidecar goes to `triage`,
 * not `surface`). APPLY, however, ALSO carries an ANSWERED OBSERVATION: since the
 * classifier (`buildLifecyclePools`) routes an observation whose sidecar is
 * all-answered to `apply` (CONSUME, always-on), the projection MUST keep it here
 * so the CI enumerate `jq` (`.namespace + ":" + .slug`) emits an `observation:<slug>`
 * apply leg. Dropping it (the pre-`route-answered-observation-sidecar-to-apply-pool`
 * assumption that apply is task/spec-only) STRANDS every answered observation:
 * gone from `triage` AND absent from `apply`, so CI never schedules it.
 */
export interface ScannedBlockedItem {
	namespace: 'task' | 'spec' | 'observation';
	slug: string;
}

/**
 * The per-repo LIFECYCLE pool on `scan --json` (the `triage`/`surface`/`apply`
 * companion of `items[]`/`prds[]`), gated by the per-repo question-surfacing
 * config and computed by REUSING `lifecycle-gather.ts` → {@link buildLifecyclePools}
 * (NOT a forked predicate) so it AGREES with the `advance -n` / `run` selection.
 * This is what makes the propose-mode CI matrix enumerate the WHOLE answer-loop —
 * `obs:<slug>` triage legs, `task:`/`spec:<slug>` surface legs (`needsAnswers`, no
 * answered sidecar) AND `task:`/`spec:<slug>` apply legs (`needsAnswers`, answered
 * sidecar) — not only build/task legs
 * (`ci-propose-matrix-enumerates-lifecycle-items`). Inert by default: with
 * `observationTriage:off` + `surfaceBlockers:false` (the calm defaults) triage +
 * surface are empty; apply is the always-on consume pool.
 */
export interface ScannedLifecycle {
	/** Untriaged observations → `obs:<slug>` legs (gated by `observationTriage`). */
	triage: ScannedTriageItem[];
	/** `needsAnswers` task/spec items with no answered sidecar → surface legs (gated by `surfaceBlockers`). */
	surface: ScannedBlockedItem[];
	/**
	 * Items WITH an all-answered sidecar → apply legs (CONSUME, always-on). Carries
	 * `needsAnswers` tasks/prds AND answered OBSERVATIONS (namespace `'observation'`),
	 * so the matrix `jq` emits `task:`/`spec:`/`observation:` apply legs alike.
	 */
	apply: ScannedBlockedItem[];
}

/**
 * One agent-POOL task with its parsed gate/deps, before eligibility resolution.
 * This IS the read seam's resolved pool shape ({@link LedgerReadyItem}); the
 * `Ready` noun follows the agent-pool folder `work/tasks/ready/` (staging is
 * `work/tasks/backlog/`), per ADR `rename-task-pool-folder-todo-to-ready`.
 */
export type ReadyItem = LedgerReadyItem;

/** A pool item plus its resolved eligibility verdict. */
export interface ScannedItem extends ReadyItem {
	eligibility: EligibilityResult;
}

/**
 * A SPEC entry in `scan --json`'s taskable-spec pool — the SAME shape an eligible
 * task carries in `items[]` (a `slug` + an `eligibility.eligible` boolean), so
 * the propose-matrix `jq` filter mirrors the task one: `select(.eligibility.eligible)
 * | "spec:" + .slug`. "Eligible" here means TASKABLE — the per-repo `autoTask`
 * gate + the `humanOnly`/`needsAnswers`/`taskedAfter` predicates of `taskableSpecs`
 * (`autoslice-gate`'s pure predicate). Sits under {@link RepoReport.prds} (and
 * the cwd section's `repo.prds`), DISTINCT from the task-only `items[]` because
 * tasks and prds are different verbs and project to different `task:`/`spec:`
 * prefixes — a discriminator on `items[]` would pollute the surface other readers
 * already consume.
 */
export interface ScannedSpec {
	slug: string;
	eligibility: {eligible: boolean};
}

/** All scanned pool (`work/tasks/ready/`) items for one participating repo. */
export interface RepoReport {
	/**
	 * The repo identity for this row. In the registry model (`scan`) it is the
	 * hub-mirror PATH; for the working-tree scan (`run`, in-place) it is the
	 * working checkout path.
	 */
	path: string;
	items: ScannedItem[];
	/**
	 * The TASKABLE-SPEC pool for this repo (the `specs[]` companion of `items[]`):
	 * every spec in `work/specs/ready/` not already in `work/specs/tasked/`, each tagged with
	 * `eligibility.eligible` from {@link taskableSpecs} (the SAME `autoslice-gate`
	 * predicate the mirror-side pool scan uses — NOT a forked predicate). This is
	 * what makes the propose-mode CI matrix enumerate `spec:<slug>` legs for ready
	 * ungated prds alongside `task:<slug>` legs for eligible tasks (the
	 * `ci-propose-matrix-must-enumerate-sliceable-prds-not-only-slices` task): the
	 * propose `enumerate` `jq` unions both pools and emits one matrix leg per item.
	 * The `autoTask` gate still BINDS — a repo with `autoTask` off yields an
	 * all-`eligible:false` pool (so no `spec:` legs).
	 */
	specs: ScannedSpec[];
	/**
	 * The per-repo LIFECYCLE pool (the `triage`/`surface`/`apply` companion of
	 * `items[]`/`prds[]`): untriaged observations + `needsAnswers` tasks/prds split
	 * by sidecar answered-state, gated by this repo's `observationTriage` /
	 * `surfaceBlockers` config and computed by REUSING `lifecycle-gather.ts` (NOT a
	 * forked predicate). Surfaced on BOTH `repos[]` (mirror) and `cwd.repo`
	 * (in-place), the same dual-surface `items`/`prds` use, so the propose-mode CI
	 * matrix can enumerate the WHOLE answer-loop
	 * (`ci-propose-matrix-enumerates-lifecycle-items`). Inert with the calm-default
	 * gates (empty triage/surface; apply is the always-on consume pool).
	 */
	lifecycle: ScannedLifecycle;
	/**
	 * The one-slug-one-folder LINT result (spec `ledger-integrity` story 3): any
	 * slug present in MORE THAN ONE `work/` status folder in THIS repo's ledger.
	 * Empty ⇒ a clean ledger. Non-empty ⇒ a corrupt ledger the formatter WARNS
	 * about loudly and a human must resolve (never auto-fixed). Derived by listing
	 * folder residence, not from any index.
	 */
	ledgerDuplicates: DuplicateSlug[];
	/**
	 * The PER-ITEM LOCK in-flight view for this repo (spec
	 * `ledger-status-per-item-lock-refs` US #8; task
	 * `needs-attention-as-stuck-lock-state`): the held lock entries read from the
	 * repo's `refs/dorfl/lock/*` refs — `active` holds (in-progress) and
	 * `stuck` holds (needs-attention) + reasons. ADDITIVE to the folder-based pool
	 * view above (the interim dual-write half; eligibility/selection stay OFFLINE on
	 * `main` from the pool `tasks/ready/`, with held slugs SUBTRACTED — this field is the
	 * read-only surface, NOT a selection input). Empty on a repo with no held locks
	 * or when the lock refs could not be read (best-effort, see
	 * {@link listItemLockEntries}). Optional so older literals stay valid.
	 */
	lockHeld?: LockEntry[];
	/**
	 * Lock `<entry>` names whose item is already at REST in a terminal folder on
	 * this repo's `main`: finished work (typically a merged propose PR) whose lock
	 * has not been released yet. Reported SEPARATELY from {@link lockHeld}, and
	 * deliberately excluded from it, so completed work never reads as in-progress.
	 * `scan` is read-only and RELEASES nothing; these drain on the next claim, or
	 * under `scan --reconcile-locks`.
	 */
	staleLocks?: string[];
}

/** The full cross-repo scan result. */
export interface ScanReport {
	repos: RepoReport[];
	totalItems: number;
	totalEligible: number;
}

/**
 * Collect the set of slugs present in a repo's `work/done/`. Used to resolve
 * `blockedBy` (per-repo only). Falls back to the filename when an item has no
 * `slug` frontmatter. Resolves THROUGH the read seam's local-tree method
 * ({@link ledgerRead}) — the single insertion point for the `work/` state read.
 */
export function readDoneSlugs(repoPath: string): Set<string> {
	return ledgerRead.resolveLocalState({repoPath}).doneSlugs;
}

/**
 * Read and parse every `work/tasks/ready/*.md` (the agent POOL) for a repo, sorted
 * by slug. Resolves THROUGH the read seam's local-tree method
 * ({@link ledgerRead}).
 */
export function readReadyItems(repoPath: string): ReadyItem[] {
	return ledgerRead.resolveLocalState({repoPath}).ready;
}

/**
 * Resolve a per-repo `ScannedItem[]` from an already-resolved `work/` state +
 * the repo's `autoBuild` policy. The shared core of BOTH the registry scan
 * (mirror-ref state) and the working-tree scan (`run`/in-place) — neither learns
 * how the `work/` state was read; they just hand it here. Exported so the
 * MIRROR-SIDE pool scan (`mirror-pool-scan.ts`) scores the bare-mirror task pool
 * through the EXACT same eligibility path as in-place (`do-autopick`), not a fork.
 */
/**
 * Score a spec pool down to its TASKABLE subset, then label every spec with
 * `eligibility.eligible` (true ⇔ taskable). REUSES {@link taskableSpecs} —
 * the SAME `autoslice-gate` predicate the mirror-side `scanMirrorPool` + the
 * in-place `do-autopick` pool already run — so what is taskable does not
 * fork between the autopick paths and the propose-matrix `scan --json` pool.
 * The `autoTask` gate BINDS through that predicate; a config-less repo with
 * `autoTask` off yields an all-`eligible:false` pool (no `spec:` legs).
 */
export function scoreSpecs(
	repoPath: string,
	pool: LedgerSpecPool,
	autoTask: boolean,
	/**
	 * The held-SPEC set to SUBTRACT from the taskable pool (fix
	 * `propose-tasking-releases-lock-so-spec-is-retasked-and-pr-force-pushed-every-tick`):
	 * a spec whose `refs/dorfl/lock/spec-<slug>` is HELD is IN-FLIGHT (a propose-mode
	 * tasking PR is open, or a merge tasking is mid-flight) and must NOT be enumerated
	 * as taskable — otherwise CI re-tasks it every tick, force-pushing the open PR.
	 * Symmetric to {@link scoreItems}'s task held-slug subtraction (specs took NONE
	 * before this fix). Defaults empty (offline read — the caller supplies the set,
	 * fail-CLOSED for selection via {@link heldSpecSlugsStrict}, graceful for the
	 * surface).
	 */
	heldSpecSlugs: Set<string> = new Set(),
): ScannedSpec[] {
	const taskable = new Set(
		taskableSpecs({
			candidates: pool.specs
				.filter((p) => !heldSpecSlugs.has(p.slug))
				.map((p) => ({
					repoPath,
					slug: p.slug,
					humanOnly: p.humanOnly,
					needsAnswers: p.needsAnswers,
					taskedAfter: p.taskedAfter,
				})),
			taskedSlugs: pool.taskedSlugs,
			autoTask,
		}).map((p) => p.slug),
	);
	return pool.specs.map((p) => ({
		slug: p.slug,
		eligibility: {eligible: taskable.has(p.slug)},
	}));
}

/**
 * Project the shared {@link buildLifecyclePools} result (via `gatherLifecycle*`)
 * onto the `scan --json` {@link ScannedLifecycle} shape: triage items keep only
 * their `slug` (the `obs:` prefix is fixed in the matrix `jq`), surface/apply keep
 * `{namespace, slug}` so the `jq` projects the right `task:`/`spec:` prefix. NOT a
 * re-enumeration — a pure shape map over the already-gated pools.
 *
 * The pool items' `namespace` is the wider {@link SelectedNamespace}. SURFACE by
 * construction only carries `'task'`/`'spec'` (an observation with no sidecar is a
 * `triage` candidate, never `surface`), so it narrows + drops any non-task/spec
 * defensively. APPLY additionally admits `'observation'` (an answered observation
 * sidecar → apply), and it MUST be kept so the matrix `jq` emits its
 * `observation:<slug>` apply leg — narrowing it away here is exactly what stranded
 * answered observations (present in neither `triage` nor `apply`). Any OTHER
 * namespace is still dropped defensively.
 */
export function toScannedLifecycle(pools: {
	triage: {slug: string}[];
	surface: {namespace: string; slug: string}[];
	apply: {namespace: string; slug: string}[];
}): ScannedLifecycle {
	const BLOCKED_NAMESPACES = new Set(['task', 'spec', 'observation']);
	// SURFACE stays task/spec-only; APPLY additionally keeps an answered observation.
	const asBlocked = (
		items: {namespace: string; slug: string}[],
		allowObservation: boolean,
	): ScannedBlockedItem[] =>
		items
			.filter(
				(i) =>
					i.namespace === 'task' ||
					i.namespace === 'spec' ||
					(allowObservation && i.namespace === 'observation'),
			)
			.filter((i) => BLOCKED_NAMESPACES.has(i.namespace))
			.map((i) => ({
				namespace: i.namespace as 'task' | 'spec' | 'observation',
				slug: i.slug,
			}));
	return {
		triage: pools.triage.map((t) => ({slug: t.slug})),
		surface: asBlocked(pools.surface, false),
		apply: asBlocked(pools.apply, true),
	};
}

export function scoreItems(
	state: Pick<LocalLedgerState, 'ready' | 'doneSlugs'>,
	autoBuild: boolean,
	counts: {totalItems: number; totalEligible: number},
	heldSlugs: Set<string> = new Set(),
): ScannedItem[] {
	// HELD-SLUG SUBTRACTION (spec `ledger-status-per-item-lock-refs` US #15; task
	// `claim-acquires-unified-lock-no-body-move`): exclude any pool slug whose
	// per-item lock is currently held — the eligible pool is "in `tasks/ready/` on
	// `main` AND no lock held".
	//
	// LOAD-BEARING since the lock cut-over: the claim NO LONGER moves the body to
	// `in-progress/` (it stays at `tasks/ready/` on `main`, the held lock IS the
	// claim), so this subtraction is the ONLY thing keeping a claimed / in-flight
	// item out of the eligible pool, NOT the redundant belt-and-suspenders it was
	// while the body-move still removed claimed items. An ACTIVE (in-progress) lock
	// is a legitimate, primary claim signal here.
	//
	// FAIL-OPEN CAVEAT (known defect; selection should fail CLOSED): the held set
	// is gathered by the CALLER and is EMPTY when the lock read is
	// unavailable/offline, so a READ FAULT currently degrades to "subtract nothing"
	// and an in-flight item can leak back into the pool (re-claimed → empty diff →
	// spurious `stuck`). Now that the subtraction is load-bearing this is wrong for
	// SELECTION: a failed lock read must not re-make a held item eligible. See the
	// observation/task on fail-closed lock-read for selection.
	return state.ready
		.filter((item) => !heldSlugs.has(item.slug))
		.map((item) => {
			const eligibility = resolveEligibility({
				humanOnly: item.humanOnly,
				needsAnswers: item.needsAnswers,
				blockedBy: item.blockedBy,
				doneSlugs: state.doneSlugs,
				autoBuild,
			});
			counts.totalItems++;
			if (eligibility.eligible) {
				counts.totalEligible++;
			}
			return {...item, eligibility};
		});
}

/**
 * Read-only end-to-end scan over the REGISTRY (ADR §1): enumerate the registered
 * hub mirrors under `<workspacesDir>/repos/`, **fetch each mirror's `main` first**
 * (ADR §5/§6 — the remote is the source of truth in the registry model), then read
 * each one's full `work/` lifecycle from its BARE `main` ref through the read
 * seam's mirror method (mirrors have no working tree — `resolveLocalState`'s
 * `readdirSync` cannot read them), and resolve eligibility per item (autonomy
 * gate + per-repo `blockedBy`). Claims and runs nothing.
 *
 * **Fetch-first, never fatal:** the old "scan is always offline" invariant is
 * RETIRED (it was the roots-local model); `scan` now refreshes each mirror's
 * `main` before reading. A failed fetch (offline, dead arbiter) is NOT an error —
 * it WARNS via `warn` and falls back to that mirror's last-known `main`, so the
 * queue still reports (its freshness = the last successful fetch). This does NOT
 * change the ledger read STRATEGY (`claim-ledger-vs-protected-main.md`): the
 * offline read of `<mirror>/main:work/...` stays the single strategy — `scan`
 * merely ensures that ref is fresh before reading it.
 *
 * Discovery is the registered hub-mirror set, NOT a config `roots` walk (there is
 * no `roots`/`remotes` field). `scan`/`status` share the {@link listMirrors}
 * primitive; the per-repo `work/` read goes through the seam's mirror-ref method.
 *
 * The autonomy gate's `autoBuild` policy is resolved PER REPO. NOTE: a bare
 * mirror has no checked-out `dorfl.json`, so the per-repo file cannot be
 * read from it — the global/env-resolved policy applies (the per-repo override is
 * a working-checkout concern, served by {@link scanRepoPaths}).
 */
export async function scan(
	config: Config,
	options: {
		warn?: (message: string) => void;
		/**
		 * OPT-IN WRITE (`scan --reconcile-locks`). Omitted/`false` (the DEFAULT) keeps
		 * `scan` strictly READ-ONLY: stale terminal locks are classified and excluded
		 * from the in-flight surface, but nothing on any arbiter is touched. `true`
		 * additionally RELEASES them. Routine convergence does not need this, the
		 * claim path sweeps on every unit of work.
		 */
		reconcileLocks?: boolean;
		env?: NodeJS.ProcessEnv;
		/**
		 * The per-machine {@link ConfigOverrideMap} (from `loadConfigOverride`),
		 * threaded into the SAME per-repo resolution `do`/`run` use so the override
		 * applies to the registry-scan path too (ADR
		 * `per-machine-config-override-layer`). Default: empty (no override) —
		 * byte-identical to pre-override behaviour.
		 */
		override?: ConfigOverrideMap;
	} = {},
): Promise<ScanReport> {
	const mirrors = listMirrors({
		workspacesDir: config.workspacesDir,
		env: options.env,
	});

	const repos: RepoReport[] = [];
	const counts = {totalItems: 0, totalEligible: 0};

	for (const mirror of mirrors) {
		// Fetch-first (ADR §5/§6): refresh this mirror's `main` so the read below
		// sees the remote truth. Never fatal — a failed fetch WARNS and falls back to
		// the mirror's last-known `main` (the read strategy is unchanged).
		fetchMirrorMainOrWarn({
			mirrorPath: mirror.path,
			warn: options.warn,
			env: options.env,
		});
		// Read the full `work/` lifecycle from the mirror's bare `main` ref through
		// the read seam (git ls-tree/show; NOT a working-tree read).
		const state = await ledgerRead.resolveMirrorState({
			mirrorPath: mirror.path,
			env: options.env,
		});
		const autoBuild = resolveRepoConfig({
			repoPath: mirror.path,
			global: config,
			override: options.override,
		}).config.autoBuild;
		// Held-slug subtraction: a bare hub mirror's arbiter is its `origin`. Reads
		// the lock refs from the mirror's origin; non-fatal (empty set on any fault),
		// so the read-only scan degrades gracefully exactly as its config reads do.
		// CLASSIFY the mirror's held locks against its `main` (fix for the propose-path
		// lock leak; observation
		// `every-completed-task-leaves-its-lock-ref-reporting-in-progress`). A
		// `complete --propose` KEEPS its per-item lock held across the open PR and
		// defers the release to the PR merge, an event NO dorfl process is present
		// for (there is no merge hook and no daemon), so the release never fired and
		// every completed item stayed locked and reported in-progress for ever.
		//
		// `scan` is READ-ONLY (it says so in its own description) and stays that way:
		// we only CLASSIFY here, so a lock whose item has come to REST in a terminal
		// folder on `main` is reported as STALE instead of being listed as an
		// in-flight hold. The refs are drained by the paths that already write on
		// every unit of work (the claim path). Best-effort and never throws: any
		// fault treats every lock as HELD, so `scan` degrades to its previous
		// behaviour.
		//
		// Under the explicit `--reconcile-locks` opt-in, the ONE way `scan` writes
		// the same classification is applied instead of merely reported.
		//
		// A hub mirror is a BARE clone with no `refs/remotes/*` namespace, so its
		// copy of the arbiter's main is the plain `main` ref (the SAME ref
		// `lintRefLedger` below reads). Passing the default `origin/main` would fail
		// EVERY probe with `invalid object name` and silently classify every lock as
		// in-flight, making this a permanent no-op.
		const MIRROR_MAIN = {mainRef: 'main'};
		let staleLockEntries: string[];
		let lockHeld: LockEntry[];
		if (options.reconcileLocks === true) {
			const swept = await reconcileTerminalItemLocks(
				mirror.path,
				'origin',
				options.env,
				MIRROR_MAIN,
			);
			if (swept.released.length > 0) {
				options.warn?.(
					`${mirror.path}: released ${swept.released.length} stale per-item ` +
						'lock(s) whose item is terminal on main (the work landed; a ' +
						`propose PR merged out-of-band): ${swept.released.join(', ')}`,
				);
			}
			// Under an EXPLICIT drain request, a refusal must be reported.
			for (const e of swept.errors) {
				options.warn?.(
					`${mirror.path}: could not release '${e.entry}': ${e.message}`,
				);
			}
			staleLockEntries = [];
			lockHeld = swept.stillHeld;
		} else {
			const classified = await classifyTerminalItemLocks(
				mirror.path,
				'origin',
				options.env,
				MIRROR_MAIN,
			);
			staleLockEntries = classified.terminal.map((l) => l.entry);
			lockHeld = classified.inFlight;
		}
		const heldSlugs = await heldTaskSlugs(mirror.path, 'origin', options.env);
		// The PER-ITEM LOCK in-flight view (spec US #8; task
		// `needs-attention-as-stuck-lock-state`): ADDITIONALLY read the full held
		// lock entries (action × state + reason) from the mirror's lock refs, so the
		// scan surfaces held (in-progress) + stuck (needs-attention) items. Read from
		// the mirror's `origin` (the SAME handle the held-slug subtraction uses);
		// best-effort (empty list on any fault), so the read-only scan degrades
		// gracefully. This is a SURFACE only — eligibility/selection stay offline on
		// `main` (the subtraction above), not gated on this view.
		// `lockHeld` comes STRAIGHT from the classification above, so the stale ones
		// are already excluded (finished work is not an in-flight hold) and we avoid a
		// second `ls-remote` + fetch per mirror.
		// Spec pool — the TASKABLE-SPEC companion of the task pool above
		// (`ci-propose-matrix-must-enumerate-sliceable-prds-not-only-slices`). Resolve
		// `autoTask` PER REPO from the mirror's COMMITTED `dorfl.json`
		// (exactly as the mirror-side pool scan does — NOT forked); a read fault is
		// non-fatal (warn + global fall-back), since `scan` is read-only and must
		// degrade gracefully (ADR §5/§6).
		let repoAutoTask = config.autoTask;
		try {
			repoAutoTask = resolveRepoConfigFromMirror({
				mirrorPath: mirror.path,
				global: config,
				env: options.env,
				override: options.override,
			}).autoTask;
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			options.warn?.(
				`could not read the target repo's config from ${mirror.path}/main; ` +
					`resolving autoTask from global + default. ${reason}`,
			);
		}
		const specPool = await ledgerRead.resolveMirrorSpecPool({
			mirrorPath: mirror.path,
			env: options.env,
		});
		const specs = scoreSpecs(mirror.path, specPool, repoAutoTask);
		// The per-repo LIFECYCLE pool (`ci-propose-matrix-enumerates-lifecycle-items`),
		// gated by this mirror's question-surfacing config (resolved from its committed
		// `dorfl.json`, with the same non-fatal global fall-back as `autoTask`
		// above) and computed by REUSING `gatherLifecycleMirror` → `buildLifecyclePools`
		// (NOT a forked predicate), so it AGREES with the `run` selection.
		let repoLifecycleConfig = {
			observationTriage: config.observationTriage as string,
			surfaceBlockers: config.surfaceBlockers,
			surfaceStaging: config.surfaceStaging,
		};
		try {
			const resolved = resolveRepoConfigFromMirror({
				mirrorPath: mirror.path,
				global: config,
				env: options.env,
				override: options.override,
			});
			repoLifecycleConfig = {
				observationTriage: resolved.observationTriage,
				surfaceBlockers: resolved.surfaceBlockers,
				surfaceStaging: resolved.surfaceStaging,
			};
		} catch {
			// Non-fatal: a config read fault already WARNED on the `autoTask` read
			// above; fall back to the global-resolved gates (scan is read-only and must
			// degrade gracefully, ADR §5/§6).
		}
		const lifecycle = toScannedLifecycle(
			await gatherLifecycleMirror({
				mirrorPath: mirror.path,
				gates: lifecycleGatesFrom(repoLifecycleConfig),
				env: options.env,
			}),
		);
		// The one-slug-one-folder LINT (spec story 3): derive any slug residing in >1
		// status folder from the mirror's committed `main` tree (the SAME `ls-tree`
		// read the seam uses), so a corrupt ledger is surfaced LOUDLY by the formatter.
		const ledgerDuplicates = lintRefLedger('main', mirror.path, options.env);
		repos.push({
			path: mirror.path,
			items: scoreItems(state, autoBuild, counts, heldSlugs),
			specs,
			lifecycle,
			ledgerDuplicates,
			lockHeld,
			staleLocks: staleLockEntries,
		});
	}

	return {
		repos,
		totalItems: counts.totalItems,
		totalEligible: counts.totalEligible,
	};
}

/**
 * Read-only scan over an EXPLICIT set of working checkouts, used by the in-place
 * worker paths (`run`) that operate on a real checkout rather than the registry's
 * bare mirrors. This is a working-TREE read (it has nothing to fetch — the
 * checkout IS the local state); the fetch-first contract (ADR §5/§6) applies to
 * the REGISTRY `scan` above, which refreshes each bare mirror before reading.
 * Reads each repo's `work/` via the read seam's local-tree method and honours its
 * per-repo `dorfl.json` `autoBuild`. The registry `scan` above is the
 * mirror-ref counterpart; this is its working-tree sibling.
 */
export function scanRepoPaths(
	repoPaths: string[],
	config: Config,
	/**
	 * The HELD-SLUG set to SUBTRACT from each repo's pool (`tasks/ready/`) AND from
	 * the in-place lifecycle triage/surface/apply pools (spec
	 * `ledger-status-per-item-lock-refs` US #15; task
	 * `in-place-scan-subtracts-held-locked-slugs-from-propose-matrix`). Passed
	 * BOTH to {@link scoreItems} AND to {@link gatherLifecycleInPlace}, so a slug
	 * whose per-item lock is currently held (state `active`/`stuck`) never leaks
	 * into the propose matrix via EITHER the eligible-task pool OR a lifecycle
	 * leg — CI would otherwise enumerate a `task:<slug>` surface/apply leg that
	 * always loses the claim CAS.
	 *
	 * This is a WORKING-TREE, OFFLINE scan (it has no arbiter handle to fetch the
	 * lock refs from — that is the registry `scan`'s job), so the held set is
	 * supplied by the in-place CALLER (which knows its arbiter, e.g.
	 * `resolveCwdSection` reads it fail-CLOSED via `heldTaskSlugsStrict`) and
	 * DEFAULTS to empty. An empty default preserves the offline read while keeping
	 * the seam in place.
	 */
	heldSlugs: Set<string> = new Set(),
	/**
	 * The per-machine {@link ConfigOverrideMap} — threaded into the per-repo
	 * resolution so the override applies to the in-place scan path too. Default:
	 * empty (no override).
	 */
	override?: ConfigOverrideMap,
	/**
	 * The held-SPEC set to SUBTRACT from each repo's TASKABLE-spec pool (fix
	 * `propose-tasking-releases-lock-so-spec-is-retasked-and-pr-force-pushed-every-tick`):
	 * passed into {@link scoreSpecs} so a spec whose per-item lock is HELD (a
	 * propose-mode tasking PR is open, or a merge tasking is mid-flight) never leaks
	 * into the propose matrix's `spec:` legs — the SPEC counterpart of the `heldSlugs`
	 * task subtraction. Supplied by the in-place caller (offline scan has no arbiter
	 * handle); DEFAULTS empty.
	 */
	heldSpecSlugs: Set<string> = new Set(),
): ScanReport {
	const repos: RepoReport[] = [];
	const counts = {totalItems: 0, totalEligible: 0};

	for (const path of repoPaths) {
		const state = ledgerRead.resolveLocalState({repoPath: path});
		const resolved = resolveRepoConfig({
			repoPath: path,
			global: config,
			override,
		}).config;
		// Spec pool — the TASKABLE-SPEC companion of the task pool. Resolve
		// `autoTask` PER REPO from the working-tree `dorfl.json` (the same
		// way `autoBuild` is resolved); `taskableSpecs` (the SAME `autoslice-gate`
		// predicate the autopick paths run) decides what is taskable — no forked
		// predicate. This is what makes the propose-mode CI matrix enumerate `spec:`
		// legs (see `ci-propose-matrix-must-enumerate-sliceable-prds-not-only-slices`).
		const specPool = ledgerRead.resolveSpecPool({repoPath: path});
		const specs = scoreSpecs(path, specPool, resolved.autoTask, heldSpecSlugs);
		// The per-repo LIFECYCLE pool (`ci-propose-matrix-enumerates-lifecycle-items`),
		// gated by this working tree's `observationTriage` / `surfaceBlockers` (resolved
		// the same way as `autoBuild`/`autoTask`) and computed by REUSING
		// `gatherLifecycleInPlace` → `buildLifecyclePools` (NOT a forked predicate). CI
		// runs IN-PLACE, so this is the surface the propose matrix reads.
		const lifecycle = toScannedLifecycle(
			gatherLifecycleInPlace({
				repoPath: path,
				gates: lifecycleGatesFrom({
					observationTriage: resolved.observationTriage,
					surfaceBlockers: resolved.surfaceBlockers,
					surfaceStaging: resolved.surfaceStaging,
				}),
				// Held-slug subtraction on the LIFECYCLE side (task
				// `in-place-scan-subtracts-held-locked-slugs-from-propose-matrix`):
				// symmetric to the `scoreItems` subtraction above, so a held task never
				// leaks into a surface/apply leg either.
				heldSlugs,
			}),
		);
		// The one-slug-one-folder LINT over THIS working tree's `work/` ledger.
		const ledgerDuplicates = lintLocalLedger(path);
		repos.push({
			path,
			items: scoreItems(state, resolved.autoBuild, counts, heldSlugs),
			specs,
			lifecycle,
			ledgerDuplicates,
		});
	}

	return {
		repos,
		totalItems: counts.totalItems,
		totalEligible: counts.totalEligible,
	};
}
