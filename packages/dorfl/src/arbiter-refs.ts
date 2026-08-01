import {runAsync} from './git.js';

/**
 * **The ONE arbiter-ref refresh + authoritative-read seam** (observation
 * `checkpoint-path-reports-its-own-write-as-absent`).
 *
 * Every "did my own write land?" / "is the branch on the arbiter?" question in
 * the checkpoint + surface paths used to be answered the same wrong way: run a
 * PLAIN `git fetch <arbiter>`, then `git rev-parse <arbiter>/<branch>` — i.e.
 * read a REMOTE-TRACKING ref (`refs/remotes/<arbiter>/…`) and trust it. That is
 * unsound in the configuration dorfl itself creates for `--isolated` runs, and
 * it produced two field defects where dorfl reported its OWN successful write as
 * absent:
 *
 *  1. A job worktree is `git worktree add`ed from the BARE HUB MIRROR
 *     (`workspace.ts` `createJob` → `repo-mirror.ts` `ensureMirror`), whose
 *     `origin` carries the MIRROR-style refspec `+refs/heads/*:refs/heads/*`.
 *     So a plain fetch there writes `refs/heads/main`, and **never populates**
 *     `refs/remotes/origin/main` at all. `rev-parse origin/main` then returns
 *     whatever a PRIOR explicit-refspec fetch happened to leave behind — a value
 *     that PREDATES the write being verified. A push that genuinely landed reads
 *     back as "not our commit ⇒ rejected".
 *  2. Worse, in that same worktree a plain `git fetch origin` **fails outright**
 *     (`fatal: refusing to fetch into branch 'refs/heads/work/<slug>' checked out
 *     at …`), because the mirror refspec's destination IS the branch the worktree
 *     has checked out. So it refreshes NOTHING, and a follow-up
 *     `rev-parse <arbiter>/work/<slug>` fails against a ref that never existed —
 *     reported as "no work branch on <arbiter>" while the branch (and an hour of
 *     agent work) sits on the arbiter.
 *
 * Both call sites now route through this module, which fixes the class rather
 * than the two instances:
 *
 *   - {@link refreshArbiterRefs} prune-fetches with an EXPLICIT, per-branch
 *     refspec into the `refs/remotes/<arbiter>/…` namespace the readers actually
 *     read, tolerating the checked-out-branch refusal instead of being silently
 *     defeated by it.
 *   - {@link resolveArbiterBranch} answers the sha question from the ARBITER
 *     ITSELF (`git ls-remote`), so no local ref-namespace/refspec accident can
 *     make a landed write look absent. The local tracking ref is only a FALLBACK,
 *     used when the arbiter cannot be reached at all.
 *
 * The `ls-remote`-is-authoritative stance is not new — it is the same one
 * `continue-branch.ts` (`branchAheadOfArbiter`), `workspace.ts`, `integrator.ts`
 * and `reap-branches.ts` already take for continue-detection and branch reaping.
 * This module makes it the SHARED default for the post-write verification too,
 * instead of each site re-deciding.
 */

/** How a {@link ResolvedArbiterBranch} sha was obtained — the read's PROVENANCE. */
export type ArbiterRefAuthority =
	/** Read from the arbiter itself (`git ls-remote`): AUTHORITATIVE. */
	| 'arbiter'
	/**
	 * The arbiter could not be reached (offline / broken remote), so the local
	 * remote-tracking ref was used. Best-effort: it may be stale, so a caller
	 * deciding "did MY write land?" must NOT treat a mismatch here as proof of
	 * a loss (see {@link ResolvedArbiterBranch.trustworthy}).
	 */
	| 'local-fallback'
	/** Neither the arbiter nor any local ref has this branch. */
	| 'absent';

/** The resolved state of ONE branch on the arbiter (a single, coherent read). */
export interface ResolvedArbiterBranch {
	/** The unqualified branch name that was resolved (e.g. `main`, `work/task-x`). */
	branch: string;
	/** Its sha, or `undefined` when the branch exists nowhere we could look. */
	sha?: string;
	/** Where {@link sha} came from. */
	authority: ArbiterRefAuthority;
	/**
	 * True iff the arbiter answered (`authority` is `arbiter` or `absent` off a
	 * REACHABLE arbiter). When false the read is a stale-capable local fallback,
	 * so a mismatch proves nothing and callers must not report a loss from it.
	 */
	trustworthy: boolean;
	/** The `ls-remote` stderr when the arbiter could not be reached (diagnostics). */
	unreachableDetail?: string;
}

/** The explicit refspec that maps an arbiter branch into the namespace we READ. */
function trackingRefspec(arbiter: string, branch: string): string {
	return `+refs/heads/${branch}:refs/remotes/${arbiter}/${branch}`;
}

/**
 * PRUNE-FETCH the named arbiter branches into `refs/remotes/<arbiter>/<branch>`
 * — the namespace every reader in this codebase actually reads — using an
 * EXPLICIT per-branch refspec.
 *
 * Three properties matter, and all three are the reason this is not just
 * `git fetch <arbiter>`:
 *
 *  - **Explicit refspec.** A bare-hub-mirror worktree's `origin` maps
 *    `+refs/heads/*:refs/heads/*`, so a plain fetch never writes
 *    `refs/remotes/<arbiter>/*`. Naming the destination makes the refresh work
 *    identically in a normal clone AND in a mirror worktree.
 *  - **`--prune`.** A branch DELETED on the arbiter (a `requeue --reset`, a
 *    merge-reap, a cross-machine `gc`) must disappear from our view too;
 *    otherwise a stale tracking ref answers a liveness question with a ghost.
 *  - **Per-branch and SOFT.** Fetching branch-at-a-time means the one refspec
 *    git refuses (the destination that is checked out in THIS worktree — see the
 *    module doc) cannot abort the refresh of the others, which is exactly how the
 *    single combined fetch silently refreshed nothing. Every failure is
 *    tolerated and reported rather than thrown: this is a REFRESH, and the
 *    authoritative answer comes from {@link resolveArbiterBranch} anyway.
 *
 * Returns the branches that could not be refreshed (for diagnostics only — a
 * caller should not gate on it, because the authoritative read does not depend
 * on the refresh succeeding).
 */
export async function refreshArbiterRefs(params: {
	cwd: string;
	arbiter: string;
	/** Unqualified branch names to refresh (e.g. `['main', 'work/task-x']`). */
	branches: readonly string[];
	env?: NodeJS.ProcessEnv;
}): Promise<{failed: string[]}> {
	const {cwd, arbiter, branches, env} = params;
	const failed: string[] = [];
	for (const branch of branches) {
		const fetched = await runAsync(
			'git',
			[
				'fetch',
				'--quiet',
				'--prune',
				arbiter,
				trackingRefspec(arbiter, branch),
			],
			cwd,
			{env},
		);
		if (fetched.status !== 0) {
			failed.push(branch);
		}
	}
	return {failed};
}

/**
 * Resolve ONE branch's sha on the arbiter, ARBITER-AUTHORITATIVELY.
 *
 * `git ls-remote --heads <arbiter> <branch>` asks the arbiter directly, so the
 * answer cannot be defeated by a local refspec/namespace accident — which is the
 * whole point: this is the read a post-write verification uses to decide whether
 * its OWN push landed, and that decision must never be made from a view that
 * predates the push.
 *
 * Decision order:
 *   - `ls-remote` exits 0 with a sha ⇒ `{sha, authority: 'arbiter'}` (trustworthy).
 *   - `ls-remote` exits 0 with EMPTY output ⇒ the arbiter genuinely does not have
 *     the branch ⇒ `{authority: 'absent'}` (trustworthy: a definite "no").
 *   - `ls-remote` exits non-zero (unreachable / no such remote) ⇒ fall back to the
 *     local `refs/remotes/<arbiter>/<branch>`, flagged `trustworthy: false` so a
 *     caller cannot mistake a stale local read for proof of anything.
 *
 * Always call {@link refreshArbiterRefs} first when the caller ALSO needs the
 * objects locally (a CAS base, a `merge-base` / `rev-list` comparison): a sha
 * from `ls-remote` names a commit this repo may not have yet.
 */
export async function resolveArbiterBranch(params: {
	cwd: string;
	arbiter: string;
	branch: string;
	env?: NodeJS.ProcessEnv;
}): Promise<ResolvedArbiterBranch> {
	const {cwd, arbiter, branch, env} = params;
	const ls = await runAsync(
		'git',
		['ls-remote', '--heads', arbiter, branch],
		cwd,
		{env},
	);
	if (ls.status === 0) {
		// `<sha>\t<ref>` lines. `--heads <branch>` can match several refs when the
		// name is a glob-ish prefix, so take the line whose ref is EXACTLY ours.
		const sha = ls.stdout
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line !== '')
			.map((line) => line.split(/\s+/))
			.find(([, ref]) => ref === `refs/heads/${branch}`)?.[0];
		if (sha !== undefined && sha !== '') {
			return {branch, sha, authority: 'arbiter', trustworthy: true};
		}
		// Reachable arbiter that does NOT have the branch: a definite, trustworthy
		// "absent" (a stale local ref must not be able to resurrect it).
		return {branch, authority: 'absent', trustworthy: true};
	}
	// Unreachable arbiter: best-effort local read, explicitly NOT trustworthy.
	const local = await runAsync(
		'git',
		[
			'rev-parse',
			'--verify',
			'--quiet',
			`refs/remotes/${arbiter}/${branch}^{commit}`,
		],
		cwd,
		{env},
	);
	const localSha = local.status === 0 ? local.stdout.trim() : '';
	const unreachableDetail =
		ls.stderr.trim() || `git ls-remote exit ${ls.status}`;
	if (localSha !== '') {
		return {
			branch,
			sha: localSha,
			authority: 'local-fallback',
			trustworthy: false,
			unreachableDetail,
		};
	}
	return {
		branch,
		authority: 'absent',
		trustworthy: false,
		unreachableDetail,
	};
}
