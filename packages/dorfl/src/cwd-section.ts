import {run, runAsync, localMainDivergence} from './git.js';
import {isParticipatingRepo} from './detect.js';
import {scanRepoPaths, type RepoReport} from './scan.js';
import {arbiterStatus} from './arbiter.js';
import {listMirrors} from './registry.js';
import {encodeRepoKey, mirrorPath} from './repo-mirror.js';
import {
	heldTaskSlugsStrict,
	heldSpecSlugsStrict,
	listItemLockEntries,
	classifyTerminalItemLocks,
	reconcileTerminalItemLocks,
	type LockEntry,
} from './item-lock.js';
import {
	classifyTerminalQuestionResidue,
	reconcileTerminalQuestionResidue,
} from './needs-attention.js';
import type {Config} from './config.js';
import type {ConfigOverrideMap} from './config-override.js';

/**
 * The CWD-LOCAL section of `scan`/`status` (the `scan-status-read-cwd-repo`
 * task). When a command runs INSIDE a participating repo, it ALSO reports that
 * CURRENT repo as a clearly-labelled, separately-counted LOCAL section, in
 * addition to (NEVER merged into) the cross-repo REGISTRY view.
 *
 * The consistency rule this module enforces (do not violate):
 *
 *   - The local section reads the LOCAL WORKING TREE (`scanRepoPaths([cwd])`) —
 *     your possibly-uncommitted / unpushed / diverged state — NOT the bare
 *     mirror-ref the registry reads. The two reads have DIFFERENT freshness +
 *     storage models, so they are kept VISUALLY + SEMANTICALLY distinct, each
 *     with its OWN count. A merged grand total would be true in NEITHER model.
 *   - **The SELECTION pool is REMOTE-AUTHORITATIVE + FAILS CLOSED offline.** The
 *     held-lock set (`refs/dorfl/lock/*`) lives ONLY on the arbiter, and it is the
 *     LOAD-BEARING signal that keeps a claimed / in-flight item out of the
 *     eligible pool (the body no longer moves on claim). So the cwd pool reads the
 *     held set from the arbiter (`heldTaskSlugsStrict`) and SUBTRACTS it before
 *     reporting eligibility — exactly as the registry `scan()` does. When the cwd
 *     repo has a configured arbiter but that read cannot reach it, eligibility is
 *     UNKNOWN and the section THROWS rather than emit a confident-but-wrong pool
 *     (the
 *     `scan-cwd-selection-pool-read-local-skips-held-lock-subtraction-offline-must-fail`
 *     decision: offline selection fails; there is NO `--local` fallback). This is
 *     the SELECTION concern; the divergence line is the SURFACE concern and keeps
 *     its graceful warn+last-known behaviour.
 *   - **Fetch-first ALSO for the cwd** (the maintainer's explicit ask): the cwd
 *     repo's arbiter is fetched BEFORE the divergence is computed (the local
 *     working tree is the LEAST authoritative view), reusing the
 *     `scan-status-fetch-first` fetch+warn+fallback discipline — a failed fetch
 *     WARNS and falls back to last-known, NEVER errors out (a read-only command
 *     must degrade, ADR §5/§6).
 *   - The divergence-vs-arbiter is shown with the `main-divergence-guard` framing
 *     (`local main is N commits ahead of <arbiter>/main` = unpushed).
 *   - **De-dup:** if the cwd repo is ALSO registered, it is shown ONCE in the
 *     local section marked "(also registered)" and its registry row is dropped
 *     from the registry list — so the same repo never appears as two mystery
 *     rows with possibly-disagreeing states.
 *
 * The registry model is UNCHANGED by this: `scan`/`status` are read-only DISPLAY
 * surfaces; the daemon (`run`) + the arbiter CAS still claim against the REGISTRY
 * only. Showing the cwd changes nothing about where claims happen.
 */

/** The cwd repo's arbiter, as resolved for the local section's divergence line. */
export interface CwdArbiter {
	/** The arbiter remote name inspected (e.g. `arbiter` / `origin`). */
	remote: string;
	/** True iff the cwd repo has a remote with that name. */
	configured: boolean;
	/** The arbiter's URL, when configured. */
	url?: string;
	/**
	 * True iff the cwd repo's arbiter `main` was FRESHLY FETCHED before the
	 * divergence was computed. False ⇒ the fetch failed (offline / no arbiter) and
	 * the divergence reflects the last-known arbiter ref (a warning was emitted).
	 */
	fetched: boolean;
	/** Commits local `main` is AHEAD of `<arbiter>/main` (unpushed). */
	ahead: number;
	/** Commits local `main` is BEHIND `<arbiter>/main` (needs a pull/rebase). */
	behind: number;
}

/** The cwd-local section report (one repo: the current working tree). */
export interface CwdSection {
	/** Absolute path to the cwd repo. */
	path: string;
	/**
	 * True iff the cwd is a participating repo (a `work/` tree with lifecycle
	 * content in any pool — see {@link isParticipatingRepo}, NOT `tasks/ready/`
	 * alone). When false, every other field is absent — there is NO local section.
	 */
	participating: boolean;
	/** The cwd repo's `work/` lifecycle, read from the LOCAL WORKING TREE. */
	repo?: RepoReport;
	/** Total backlog item count for the cwd (its OWN count, never merged). */
	totalItems?: number;
	/** Eligible item count for the cwd (its OWN count). */
	totalEligible?: number;
	/**
	 * True iff the cwd repo is ALSO in the registry (its arbiter URL keys to a
	 * registered hub mirror). When true the cwd is de-duped: shown once here,
	 * marked "(also registered)", and its registry row is dropped.
	 */
	alsoRegistered?: boolean;
	/**
	 * The registered hub-mirror PATH the cwd de-dups against (so the registry view
	 * can drop that row). Present only when {@link alsoRegistered} is true.
	 */
	registeredMirrorPath?: string;
	/** The cwd repo's arbiter + divergence (fetch-first). Absent when no arbiter. */
	arbiter?: CwdArbiter;
	/**
	 * Lock `<entry>` names whose item is already at REST in a terminal folder on
	 * `<arbiter>/main`, finished work (typically a merged propose PR) whose lock
	 * has not been released yet. These are STALE, not in flight, and are reported
	 * separately from {@link RepoReport.lockHeld} so completed work never reads as
	 * in-progress. Purely a CLASSIFICATION: `status` releases nothing (it is
	 * read-only). They are released automatically by the next claim, or on demand
	 * via `--reconcile-locks` / `dorfl gc --ledger --reap-stale-locks`.
	 */
	staleLocks?: string[];
	/**
	 * Lock `<entry>` names this call actually RELEASED. Populated ONLY under the
	 * explicit `reconcileLocks` opt-in (`status --reconcile-locks`), which is the
	 * one way this otherwise read-only resolver writes to the arbiter. Empty/absent
	 * ⇒ nothing was written.
	 */
	reconciledLocks?: string[];
	/**
	 * Items resting in a TERMINAL folder on `main` that still carry question state
	 * (a stale bounce sidecar, and often a stranded `needsAnswers:true` gate over
	 * shipped work). Reported so the residue is visible; `status` clears nothing.
	 * These drain on the next claim.
	 */
	staleQuestions?: string[];
	/**
	 * Terminal items whose sidecar carries a human's ANSWER that was never applied.
	 * Deliberately NEVER auto-drained (the answer is prose the tool did not
	 * author), so it is surfaced for a human instead.
	 */
	unappliedAnswers?: string[];
}

/** True iff the working repo has a git remote with name `remote`. The held-lock
 * read targets the COORDINATION arbiter (default `origin`); we only attempt it
 * when that remote actually exists, so a repo with no coordination remote keeps
 * the empty held set rather than failing on a `git remote get-url` miss. */
function remoteExists(
	cwd: string,
	remote: string,
	env: NodeJS.ProcessEnv | undefined,
): boolean {
	return run('git', ['remote', 'get-url', remote], cwd, {env}).status === 0;
}

/** The verdict of the FETCH-FREE cwd pre-check {@link cwdSectionDisposition}. */
export interface CwdDisposition {
	/** True iff the cwd is a participating repo (a `work/` tree with lifecycle
	 * content in any pool — see {@link isParticipatingRepo}, NOT `tasks/ready/`
	 * alone). */
	participating: boolean;
	/**
	 * True iff the cwd's arbiter URL keys to a registered hub mirror. When true the
	 * registry view ALREADY covers this repo, so a default `scan`/`status` should
	 * SKIP resolving the (expensive, fetch-first) cwd section entirely — the registry
	 * row represents it, and re-reading the cwd would just re-fetch the SAME arbiter
	 * `main` + lock refs the registry loop already fetched (the redundant-fetch the
	 * `scan-here-and-skip-redundant-cwd` decision eliminates). Meaningful only when
	 * {@link participating}.
	 */
	alsoRegistered: boolean;
}

/**
 * The FETCH-FREE pre-check that decides whether a DEFAULT `scan`/`status` should
 * pay for the cwd section at all. It does NO network I/O: it reads whether the cwd
 * participates (local `readdirSync`) and resolves the cwd's arbiter URL via the
 * fetch-free {@link arbiterStatus} (a local `git remote get-url`), then asks the
 * fetch-free {@link resolveRegistration} (local {@link listMirrors} key match)
 * whether that URL is already a registered mirror.
 *
 * The CLI gates on this BEFORE calling {@link resolveCwdSection}: a participating
 * cwd that is ALSO registered is skipped (the registry already covers it, and the
 * cwd read would only re-fetch the same arbiter), while a participating cwd with
 * NO mirror is resolved + shown standalone so a mirror-less repo you are standing
 * in is never invisible. `--here` bypasses this gate (it ALWAYS resolves the cwd,
 * and only the cwd).
 */
export function cwdSectionDisposition(input: {
	cwd: string;
	config: Config;
	/** The DIVERGENCE/arbiter remote whose URL keys the registration check. */
	arbiterRemote?: string;
	env?: NodeJS.ProcessEnv;
}): CwdDisposition {
	if (!isParticipatingRepo(input.cwd)) {
		return {participating: false, alsoRegistered: false};
	}
	// Fetch-free: arbiterStatus reads the local remote config only (no fetch).
	const status = arbiterStatus({
		cwd: input.cwd,
		remote: input.arbiterRemote,
		env: input.env,
	});
	const {alsoRegistered} = resolveRegistration({
		arbiterUrl: status.url,
		config: input.config,
		env: input.env,
	});
	return {participating: true, alsoRegistered};
}

/** Inputs to {@link resolveCwdSection}. */
export interface ResolveCwdSectionOptions {
	/** The current working directory to inspect (the candidate cwd repo). */
	cwd: string;
	/** Resolved global config (for `workspacesDir` + per-repo `autoBuild`). */
	config: Config;
	/**
	 * The per-machine {@link ConfigOverrideMap}. Threaded into the local
	 * working-tree scan so the cwd section's eligibility reflects the per-machine
	 * override (consistent with the autopick / advance paths). Default: none.
	 */
	override?: ConfigOverrideMap;
	/**
	 * The arbiter remote name to fetch + diff against (the SURFACE/divergence
	 * remote). Defaults to the same remote `status`'s arbiter section resolves
	 * (`arbiter`); the CLI passes the configured value.
	 */
	arbiterRemote?: string;
	/**
	 * The COORDINATION arbiter remote where the per-item lock refs
	 * (`refs/dorfl/lock/*`) live — the remote the held-lock SUBTRACTION reads. This
	 * is the SAME remote `claim`/`do`/`complete` push locks to, which defaults to
	 * `origin` (NOT the `arbiter`-named DIVERGENCE remote above — a repo can use
	 * `origin` as its arbiter and have no `arbiter` remote at all, exactly this
	 * repo's shape). Decoupled so the held-lock read targets the real coordination
	 * arbiter even when the divergence remote is absent. Default `origin`.
	 */
	lockArbiterRemote?: string;
	/**
	 * OPT-IN WRITE (`status --reconcile-locks`). `false`/omitted (the DEFAULT)
	 * keeps this resolver strictly READ-ONLY: stale locks are classified and
	 * REPORTED via {@link CwdSection.staleLocks}, and nothing on the arbiter is
	 * touched. `true` additionally RELEASES the locks whose item is terminal on
	 * `<arbiter>/main`, reporting them via {@link CwdSection.reconciledLocks}.
	 * Not needed for routine convergence, the claim path already sweeps on every
	 * unit of work; this is the manual "drain them now" lever.
	 */
	reconcileLocks?: boolean;
	/** Sink for the fetch-first fall-back warning (warn + last-known, never error). */
	warn?: (message: string) => void;
	env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the cwd-local section for `scan`/`status`. Returns
 * `{participating: false}` when the cwd is NOT a participating repo (the callers
 * then render only the registry view, unchanged). When participating it:
 *
 *   1. FETCHES the cwd repo's arbiter first (warn + fall back to last-known on
 *      failure — never errors), then computes the divergence vs `<arbiter>/main`;
 *   2. reads the COORDINATION arbiter's HELD-LOCK set (the remote where
 *      `refs/dorfl/lock/*` live, default `origin`; fail-closed: throws when that
 *      remote exists but is unreachable) to SUBTRACT in-flight items from the pool;
 *   3. reads the cwd's `work/` lifecycle from the LOCAL WORKING TREE
 *      (`scanRepoPaths([cwd])`) with that held set subtracted;
 *   4. de-dups against the registry (is the cwd's arbiter URL a registered
 *      mirror?).
 *
 * It MUTATES nothing but the arbiter fetch (a read refresh, same as the registry
 * fetch-first); it never claims/moves/integrates.
 */
export async function resolveCwdSection(
	options: ResolveCwdSectionOptions,
): Promise<CwdSection> {
	const {cwd, config, warn, env} = options;

	if (!isParticipatingRepo(cwd)) {
		return {path: cwd, participating: false};
	}

	// 1. The cwd repo's arbiter + fetch-first divergence. We resolve the arbiter
	//    via the SAME `arbiterStatus` the dashboard's arbiter section uses; if it
	//    is configured we fetch it BEFORE diffing (the local tree is the least
	//    authoritative view) — warn + fall back to last-known on failure. Resolved
	//    FIRST (before the pool read) so the held-lock subtraction below reads that
	//    same arbiter's lock refs.
	const arbiter = await resolveCwdArbiter({
		cwd,
		remote: options.arbiterRemote,
		warn,
		env,
	});

	// 2. The held-lock set to SUBTRACT from the cwd pool (the SELECTION fix). The
	//    lock refs live on the COORDINATION arbiter (`refs/dorfl/lock/*`) — the SAME
	//    remote `claim`/`do` use, default `origin` — NOT the `arbiter`-named
	//    DIVERGENCE remote resolved above (this repo has no `arbiter` remote; its
	//    arbiter IS `origin`). So we read the held set from the coordination remote
	//    and FAIL CLOSED on a read fault (`heldTaskSlugsStrict` throws): an offline /
	//    unreachable arbiter makes the eligible pool UNKNOWN, and we must NOT emit a
	//    confident-but-wrong pool (which CI would enumerate into doomed claim legs).
	//    A repo with NO coordination remote configured has nothing to subtract and
	//    nothing to fail against — it keeps the empty set.
	const lockRemote = options.lockArbiterRemote ?? 'origin';
	const hasLockRemote = remoteExists(cwd, lockRemote, env);

	// 2a. CLASSIFY the held locks against `main` (fix for the propose-path lock
	//     leak; observation
	//     `every-completed-task-leaves-its-lock-ref-reporting-in-progress`).
	//     `complete --propose` deliberately keeps the lock HELD across the open PR
	//     and promises it is "released when the PR merges (reconciled against
	//     main)", but NO dorfl process runs when a human clicks merge on GitHub,
	//     and there is no daemon, so that release could never fire. Every completed
	//     propose item therefore kept its lock ref and was reported in-progress for
	//     ever.
	//
	//     `status` is READ-ONLY and stays that way: by DEFAULT this only
	//     CLASSIFIES, splitting the held locks into genuinely in-flight ones and
	//     ones whose item has come to REST in a terminal folder on
	//     `<arbiter>/main`. That alone fixes the MIS-REPORTING half of the bug
	//     finished work stops reading as in-progress, without this command
	//     mutating the arbiter. The REF is drained by the paths that already write
	//     on every unit of work (the claim path), or on demand here via the
	//     explicit `reconcileLocks` opt-in below.
	//
	//     The terminal test is the item's POSITION ON MAIN, never a branch or a
	//     PR, so an item on an OPEN PR (body still in the pool on `main`) stays
	//     in-flight, as does a genuinely stuck one. Ordered BEFORE the held-slug
	//     reads below so, under the opt-in, the subtraction and the in-flight
	//     surface both see the reconciled truth in the SAME run.
	//
	//     Best-effort by construction: neither call throws, and every uncertainty
	//     resolves to KEEP, so an offline or push-denied checkout degrades to the
	//     previous behaviour.
	//
	//     The cwd is a WORKING CLONE, so the arbiter's main is the remote-tracking
	//     ref `<lockRemote>/main`, which is the default. (A bare hub mirror would
	//     need `mainRef: 'main'`; see the mirror callers in `status`/`scan`.)
	let staleLocks: string[] = [];
	let reconciledLocks: string[] = [];
	// The in-flight entries, taken straight from the classification so the surface
	// below needs no second `ls-remote` + fetch. `undefined` = not read at all.
	let inFlightLocks: LockEntry[] | undefined;
	if (hasLockRemote) {
		if (options.reconcileLocks === true) {
			// The ONLY write this resolver performs, and only when explicitly asked.
			const swept = await reconcileTerminalItemLocks(cwd, lockRemote, env);
			reconciledLocks = swept.released;
			inFlightLocks = swept.stillHeld;
			// Under an EXPLICIT drain request a refusal must be reported: the operator
			// asked for these to go away, so silence would be a lie. (On the claim
			// path the same errors are ignored on purpose: there the sweep is
			// opportunistic hygiene, not something the operator asked for.)
			for (const e of swept.errors) {
				options.warn?.(`could not release lock '${e.entry}': ${e.message}`);
			}
		} else {
			const classified = await classifyTerminalItemLocks(cwd, lockRemote, env);
			staleLocks = classified.terminal.map((l) => l.entry);
			inFlightLocks = classified.inFlight;
		}
	}

	// 2b. The OTHER half of the same terminal residue: a bounced-then-rebuilt item
	//     whose sidecar + `needsAnswers` flag were never cleared (observation
	//     `a-rebuilt-task-leaves-its-bounce-question-asking-to-cancel-a-merged-task`).
	//     READ-ONLY here, exactly like the lock half: `status` reports it and the
	//     claim path drains it. Best-effort; a fault yields an empty report.
	let staleQuestions: string[] = [];
	let unappliedAnswers: string[] = [];
	if (hasLockRemote && options.reconcileLocks !== true) {
		const residue = await classifyTerminalQuestionResidue({
			cwd,
			arbiter: lockRemote,
			mainRef: `${lockRemote}/main`,
			env,
		});
		staleQuestions = residue.drainable.map((r) => r.item);
		unappliedAnswers = residue.answeredHeld.map((r) => r.item);
	} else if (hasLockRemote) {
		// Under the explicit opt-in the question residue is DRAINED alongside the
		// locks, through the one shared pass.
		const drained = await reconcileTerminalQuestionResidue({
			cwd,
			arbiter: lockRemote,
			mainRef: `${lockRemote}/main`,
			env,
			note: options.warn,
		});
		unappliedAnswers = drained.answeredHeld;
		for (const e of drained.errors) {
			options.warn?.(`could not drain questions for '${e.item}': ${e.message}`);
		}
	}

	const heldSlugs = hasLockRemote
		? await heldTaskSlugsStrict(cwd, lockRemote, env)
		: new Set<string>();
	// The held-SPEC set (fix
	// `propose-tasking-releases-lock-so-spec-is-retasked-and-pr-force-pushed-every-tick`):
	// a spec whose `spec-<slug>` lock is held has an in-flight tasking PR (propose keeps
	// the lock across the open PR). SUBTRACT it from the taskable pool so CI does not
	// re-task it every tick. Read fail-CLOSED from the SAME coordination remote as the
	// task held set (SELECTION must not enumerate an untrusted pool).
	const heldSpecSlugs = hasLockRemote
		? await heldSpecSlugsStrict(cwd, lockRemote, env)
		: new Set<string>();

	// 3. The cwd's `work/` lifecycle from the LOCAL WORKING TREE (not a mirror ref),
	//    with the arbiter-read held set SUBTRACTED so in-flight (lock-held) items are
	//    not reported eligible. Thread the per-machine override so the cwd section's
	//    eligibility matches what `do`/`advance` autopick will actually select.
	const localReport = scanRepoPaths(
		[cwd],
		config,
		heldSlugs,
		options.override,
		heldSpecSlugs,
	);
	const repo = localReport.repos[0];

	// 3b. The PER-ITEM LOCK in-flight SURFACE for the cwd (spec
	//     `ledger-status-per-item-lock-refs` US #8). The subtraction above removes a
	//     held slug from the eligible `items[]` pool; on its OWN that leaves a
	//     held/stuck cwd item in a BLIND SPOT — gone from every bucket with nothing
	//     explaining why (the regression this fixes). The registry/mirror `scan`
	//     attaches `lockHeld` to each `RepoReport` so a held item still shows up
	//     in-progress/stuck; the cwd `RepoReport` from `scanRepoPaths` did not. So we
	//     read the SAME held lock entries (action × state + reason/questions) via the
	//     SAME `listItemLockEntries` primitive the mirror path uses (NOT a second
	//     reader) and attach them, making `.cwd.repo.lockHeld` symmetric with
	//     `.repos[].lockHeld`.
	//
	//     This is a SURFACE only, and it is INTENTIONALLY graceful (best-effort,
	//     empty on any fault — exactly as `listItemLockEntries` is on the mirror
	//     side): a read fault degrades to "no in-flight locks shown", it must NOT
	//     fail the section. The SELECTION subtraction above stays STRICT
	//     (`heldTaskSlugsStrict`, fail-closed) — the two reads have deliberately
	//     different fault models (selection fails closed; the surface degrades).
	//     Read from the SAME coordination remote the subtraction used. A repo with no
	//     coordination remote has no lock refs to read — empty surface.
	if (repo !== undefined && inFlightLocks !== undefined) {
		// Taken STRAIGHT from the classification in 2a, so the stale ones are already
		// excluded. This is the reporting half of the propose-lock-leak fix: a lock
		// whose item is already at REST on `main` is finished work, NOT an in-flight
		// hold, so it must not appear under "In progress" (the symptom being fixed:
		// completed tasks reported in-progress for ever). It is surfaced under
		// `staleLocks` instead. Reusing that result also avoids a second `ls-remote` +
		// fetch and the TOCTOU window between two separate reads.
		if (inFlightLocks.length > 0) {
			repo.lockHeld = inFlightLocks;
		}
	}

	// 4. De-dup: is the cwd's arbiter URL a registered hub mirror? Compare the
	//    cwd's mirror KEY (from its arbiter URL) against the registry's keys.
	const {alsoRegistered, registeredMirrorPath} = resolveRegistration({
		arbiterUrl: arbiter?.url,
		config,
		env,
	});

	return {
		path: cwd,
		participating: true,
		repo,
		staleLocks,
		reconciledLocks,
		staleQuestions,
		unappliedAnswers,
		totalItems: localReport.totalItems,
		totalEligible: localReport.totalEligible,
		alsoRegistered,
		...(registeredMirrorPath !== undefined ? {registeredMirrorPath} : {}),
		...(arbiter !== undefined ? {arbiter} : {}),
	};
}

/**
 * Resolve the cwd repo's arbiter + divergence. Reuses `arbiterStatus` to find
 * the arbiter remote/URL, FETCHES its `main` first (warn + fall back to
 * last-known on failure — NEVER errors, ADR §5/§6), then reads the divergence of
 * local `main` vs `<arbiter>/main` in both directions. Returns `undefined` when
 * no arbiter remote is configured (no divergence line to show).
 */
async function resolveCwdArbiter(input: {
	cwd: string;
	remote?: string;
	warn?: (message: string) => void;
	env?: NodeJS.ProcessEnv;
}): Promise<CwdArbiter | undefined> {
	const {cwd, env} = input;
	const status = arbiterStatus({cwd, remote: input.remote, env});
	if (!status.configured) {
		return undefined;
	}
	const remote = status.remote;

	// Fetch-first ALSO for the cwd (the maintainer's explicit ask): refresh the
	// arbiter's `main` before diffing, reusing scan-status-fetch-first's
	// fetch+warn+fallback. A failed fetch is NOT fatal — warn + last-known.
	let fetched = false;
	const fetch = await runAsync('git', ['fetch', '--quiet', remote], cwd, {env});
	if (fetch.status === 0) {
		fetched = true;
	} else {
		input.warn?.(
			`could not fetch the cwd repo's arbiter '${remote}'; ` +
				'computing local divergence from last-known (offline). ' +
				fetch.stderr.trim(),
		);
	}

	const {ahead, behind} = await localMainDivergence(cwd, remote, env);
	return {
		remote,
		configured: true,
		url: status.url,
		fetched,
		ahead,
		behind,
	};
}

/**
 * De-dup helper: is the cwd repo (identified by its arbiter URL) ALSO registered
 * in the registry? The registry keys a mirror off its arbiter URL via
 * `encodeRepoKey`/`mirrorPath`, so we encode the cwd's arbiter URL the same way
 * and look for a matching registered mirror (by key, robust to the lossy URL).
 * Returns whether it is registered + the matching mirror path (so the registry
 * view can drop that row). With no arbiter URL there is nothing to match.
 */
function resolveRegistration(input: {
	arbiterUrl: string | undefined;
	config: Config;
	env?: NodeJS.ProcessEnv;
}): {alsoRegistered: boolean; registeredMirrorPath?: string} {
	const {arbiterUrl, config, env} = input;
	if (arbiterUrl === undefined || arbiterUrl.trim() === '') {
		return {alsoRegistered: false};
	}
	const cwdKey = encodeRepoKey(arbiterUrl);
	const cwdMirrorPath = mirrorPath(config.workspacesDir, arbiterUrl);
	for (const mirror of listMirrors({
		workspacesDir: config.workspacesDir,
		env,
	})) {
		if (mirror.key === cwdKey || mirror.path === cwdMirrorPath) {
			return {alsoRegistered: true, registeredMirrorPath: mirror.path};
		}
	}
	return {alsoRegistered: false};
}
