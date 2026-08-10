import {existsSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {git, run} from './git.js';
import type {Config, PartialConfig} from './config.js';
import type {ConfigOverrideMap} from './config-override.js';
import {
	REPO_CONFIG_FILENAME,
	REPO_CONFIG_FILENAME_LEGACY,
	loadRepoConfigFromContent,
	resolveRepoConfigFromLoaded,
	type LoadedRepoConfig,
} from './repo-config.js';
import {encodeRepoKey} from './repo-key.js';
import {LOCK_REF_PREFIX} from './item-lock.js';

export {encodeRepoKey} from './repo-key.js';

/**
 * Read a bare hub mirror's `origin` URL (`git -C <mirror> remote get-url
 * origin`). Returns the trimmed URL, or `undefined` when the mirror has no
 * `origin` or the read fails (a malformed mirror). The single helper both the
 * registry enumeration (`remote ls`) and the per-machine override layer (the
 * hub-key lookup in {@link resolveRepoConfigFromMirror}) use; defining it here
 * avoids duplicating the `git remote get-url origin` call across modules.
 */
export function readOriginUrl(
	mirrorDir: string,
	env: NodeJS.ProcessEnv | undefined,
): string | undefined {
	const result = run('git', ['remote', 'get-url', 'origin'], mirrorDir, {env});
	if (result.status !== 0) {
		return undefined;
	}
	const url = result.stdout.trim();
	return url === '' ? undefined : url;
}

/**
 * The shared **hub-mirror primitive**: one bare mirror per repo under
 * `<workspacesDir>/repos/<key>.git`, re-fetched from the arbiter. Both the
 * autonomous job runner (`agent-workspaces`) and the human `work-on` build on
 * it: a job worktree and a human worktree are both cut from the mirror's
 * freshly-fetched `main`, so they always branch off the latest arbiter main
 * (ADR §2).
 *
 * This module does NOT create worktrees, claim, or run anything — it only
 * locates / creates / fetches the mirror. It is STATE, not cache (ADR §3): it
 * lives under `~/.dorfl/` (config `workspacesDir`), never `~/.cache`.
 */

/**
 * The on-disk location of the bare hub mirror for `url`:
 * `<workspacesDir>/repos/<key>.git`. Lives under `workspacesDir` (default
 * `~/.dorfl`), never `~/.cache` (ADR §3).
 */
export function mirrorPath(workspacesDir: string, url: string): string {
	return join(workspacesDir, 'repos', `${encodeRepoKey(url)}.git`);
}

export interface EnsureMirrorOptions {
	/**
	 * The arbiter remote URL to mirror. Either `url` OR (`fromRepo` + `arbiter`)
	 * must be given; if both, `url` wins.
	 */
	url?: string;
	/** A working repo to resolve the remote URL from (with `arbiter`). */
	fromRepo?: string;
	/** Remote name in `fromRepo` whose URL to mirror (default `origin`). */
	arbiter?: string;
	/** The execution working area (config `workspacesDir`, default `~/.dorfl`). */
	workspacesDir: string;
	env?: NodeJS.ProcessEnv;
}

export interface EnsureMirrorResult {
	/** Absolute path to the bare mirror. */
	path: string;
	/** The resolved arbiter URL the mirror tracks. */
	url: string;
	/** True iff the mirror did not exist and was just created. */
	created: boolean;
	/** True iff an existing mirror was fetched (not created). */
	fetched: boolean;
	/** The mirror's freshly-fetched `main` tip (40-hex sha). */
	mainSha: string;
}

/**
 * Locate the bare hub mirror for the arbiter; create it (`git clone --bare`) if
 * absent, or `git fetch` it if present. Idempotent: a second call fetches and
 * reuses the same mirror (it never re-clones, so any local mirror state — e.g.
 * other branches/objects — survives). Returns the mirror path and its
 * freshly-fetched `main`, so callers (job worktrees, human worktrees) always
 * branch off the latest arbiter main.
 */
export function ensureMirror(options: EnsureMirrorOptions): EnsureMirrorResult {
	const env = options.env;
	const url = resolveUrl(options);
	const path = mirrorPath(options.workspacesDir, url);

	let created = false;
	let fetched = false;
	if (existsSync(path)) {
		// Reuse: fetch the latest from the arbiter into the existing bare mirror.
		//
		// `main` is the authoritative base every worktree branches off — fetch it
		// HARD (prune), and it can never collide with a checked-out branch (`main` is
		// never a job worktree branch).
		git(
			['fetch', '--prune', 'origin', '+refs/heads/main:refs/heads/main'],
			path,
			{
				env,
			},
		);
		// SHARED-MIRROR SIBLING-WORKTREE SAFETY (task
		// `cutover-claim-body-stays-and-complete-sources-from-backlog`): two SAME-repo
		// `run` jobs share ONE bare mirror, and each `git worktree add`s its own LOCAL
		// `work/<slug>` head. The remaining all-heads fetch (which brings down each
		// arbiter `work/<slug>` so continue-detection can read it as a local head) tries
		// to UPDATE every such head; git REFUSES to fetch into a SIBLING's `work/<slug>`
		// head while that sibling worktree has it checked out (`fatal: refusing to fetch
		// into branch ... checked out`) and exits non-zero — EVEN THOUGH it still updated
		// every OTHER ref (incl. main, above, and THIS job's own `work/<slug>`). Before
		// this task the claim's body-move serialised the jobs enough to hide the
		// overlap; with claim no longer writing `main` the jobs run concurrently and it
		// surfaces. So this all-heads fetch is BEST-EFFORT (soft): a sibling's
		// checked-out head being refused must NOT fail the whole ensure — the refs we
		// need (main + this job's own head) are already updated, and continue-detection
		// is arbiter-authoritative (`ls-remote` in `createJob`) anyway. A genuinely
		// unrelated failure (e.g. an unreachable arbiter) ALSO degrades to best-effort
		// here, but `main` (the hard fetch above) already succeeded, so the worktree
		// materialisation has its base; the per-branch onboard reads still fail loudly
		// downstream if a needed ref is genuinely absent.
		run('git', ['fetch', 'origin', '+refs/heads/*:refs/heads/*'], path, {env});
		// PRUNE the per-item LOCK namespace against the arbiter (observation
		// `gc-ledger-reports-mirror-stale-lock-refs-as-arbiter-state`): the all-heads
		// fetch above covers only `refs/heads/*`, so `refs/dorfl/lock/*` was never
		// pruned here and released locks accumulated on the mirror indefinitely — a
		// `gc --ledger` (or any `status`/`scan` read) that reads the mirror then
		// reported locks that no longer exist on the arbiter. Best-effort (soft):
		// an unreachable arbiter leaves the existing lock refs in place (the
		// read-side `listItemLocks`/`listItemLockEntries` read the arbiter DIRECTLY
		// via `ls-remote`, so this is the proactive keep-the-mirror-clean pass, not
		// the load-bearing one).
		run(
			'git',
			[
				'fetch',
				'--prune',
				'origin',
				`+${LOCK_REF_PREFIX}/*:${LOCK_REF_PREFIX}/*`,
			],
			path,
			{env},
		);
		fetched = true;
	} else {
		// First time: a bare mirror clone (shared object store, cheap).
		mkdirSync(dirname(path), {recursive: true});
		git(['clone', '--quiet', '--bare', url, path], dirname(path), {env});
		created = true;
	}

	return {path, url, created, fetched, mainSha: mirrorMainSha(path, env)};
}

/**
 * Locate the bare hub mirror for the arbiter and refresh ONLY its `main`,
 * WITHOUT the all-heads `--prune` fetch {@link ensureMirror} does. Clones the
 * mirror (`git clone --bare`) if absent — a fresh clone has no local worktrees,
 * so the all-heads clone refspec cannot collide with any checked-out branch —
 * but on REUSE refreshes via {@link fetchMirrorMain} (main-only, no-prune).
 *
 * This is the MIRROR-ENSURE for the no-checkout CONFIG READ (`do --remote`/
 * `do --isolated` per-repo `dorfl.json`): `git show main:dorfl.json`
 * only needs `main`, and using the pruning all-heads fetch here would let a
 * `work/<slug>` branch CHECKED OUT in some other (stale) job worktree block the
 * fetch (`git refuses to fetch into branch … checked out`), throwing the config
 * read into its global+default fallback. Narrowing the config-read fetch to
 * main-only (no-prune) means a checked-out worktree branch can NEVER block it
 * (the read-path `scan`/`status`/mirror-pool-scan already use main-only fetches
 * for exactly this reason — ADR §6).
 *
 * Does NOT replace {@link ensureMirror}: the build's worktree MATERIALISATION
 * still legitimately needs the all-heads fetch (continue-detection wants the
 * kept `work/<slug>` head as a local mirror ref). This is only for the read.
 */
export function ensureMirrorMain(
	options: EnsureMirrorOptions,
): EnsureMirrorResult {
	const env = options.env;
	const url = resolveUrl(options);
	const path = mirrorPath(options.workspacesDir, url);

	let created = false;
	let fetched = false;
	if (existsSync(path)) {
		// Reuse: refresh ONLY `main`, no-prune, so a `work/<slug>` branch checked
		// out in some other worktree can never block this fetch.
		fetchMirrorMain(path, env);
		fetched = true;
	} else {
		// First time: a bare mirror clone (no local worktrees yet, so the clone's
		// own refspec can collide with nothing).
		mkdirSync(dirname(path), {recursive: true});
		git(['clone', '--quiet', '--bare', url, path], dirname(path), {env});
		created = true;
	}

	return {path, url, created, fetched, mainSha: mirrorMainSha(path, env)};
}

/** Resolve the arbiter URL from `url`, or from `fromRepo` + `arbiter` remote. */
function resolveUrl(options: EnsureMirrorOptions): string {
	if (options.url && options.url.trim() !== '') {
		return options.url.trim();
	}
	if (options.fromRepo) {
		const remote = options.arbiter ?? 'origin';
		return git(['remote', 'get-url', remote], options.fromRepo, {
			env: options.env,
		}).trim();
	}
	throw new Error(
		'ensureMirror requires either `url` or `fromRepo` (with `arbiter`).',
	);
}

/**
 * Fetch ONLY `main` from the arbiter into an existing bare mirror, WITHOUT
 * `--prune`. Use this when the mirror also holds LOCAL-ONLY branches that must
 * survive (e.g. the `work/<slug>` branches of live worktrees): the full
 * mirror-style `+refs/heads/*:refs/heads/*` fetch in {@link ensureMirror} prunes
 * any local head absent on the arbiter, which would delete (and corrupt) a
 * checked-out `work/<slug>` worktree branch. This refreshes `main` to the latest
 * arbiter tip while leaving every other local ref untouched. Returns the fresh
 * `main` tip.
 */
export function fetchMirrorMain(
	mirrorDir: string,
	env?: NodeJS.ProcessEnv,
): string {
	git(['fetch', 'origin', '+refs/heads/main:refs/heads/main'], mirrorDir, {
		env,
	});
	return mirrorMainSha(mirrorDir, env);
}

/**
 * Read the target repo's COMMITTED `dorfl.json` from the bare hub
 * mirror's `main` (`git show main:dorfl.json`) — the per-repo config
 * layer for the NO-CHECKOUT paths (`do --remote`). The committed file is a
 * tracked file on `<arbiter>/main`, so it is reachable from the mirror without a
 * worktree. Returns the raw file CONTENT, or `undefined` when the repo has no
 * `dorfl.json` on `main` (a config-less repo — the caller then resolves to
 * exactly global + default, byte-identical to before this layer existed).
 *
 * This is the task's ONE genuinely-new seam: sourcing the bytes from the arbiter
 * instead of the cwd. The parse / allow-reject filtering stays in
 * {@link loadRepoConfigFromContent} (the existing per-repo machinery), so the
 * host-only key rejection is identical however the bytes were sourced.
 *
 * A `git show` failure that is NOT "path missing on main" (a corrupt mirror, an
 * absent `main`) is propagated — it is a genuine plumbing fault, not a
 * config-less repo. The missing-path case (`git show` exit ≠ 0 naming the path)
 * is read as `undefined` (no file = no per-repo layer).
 */
export function readRepoConfigFromMirrorMain(
	mirrorDir: string,
	env?: NodeJS.ProcessEnv,
): string | undefined {
	// Prefer the plain `dorfl.json`; fall back to the legacy `dorfl.json` when the
	// preferred name is absent on `main` (a repo that committed the dotfile before
	// dual-support). A genuine read fault on the FIRST attempt propagates; a
	// path-missing on the first falls through to the legacy attempt.
	const preferred = showConfigOnMain(mirrorDir, REPO_CONFIG_FILENAME, env);
	if (preferred !== undefined) {
		return preferred;
	}
	return showConfigOnMain(mirrorDir, REPO_CONFIG_FILENAME_LEGACY, env);
}

/**
 * `git show main:<filename>` in a mirror, returning the bytes, or `undefined`
 * when the PATH is absent on `main` (the expected config-less / wrong-name case).
 * A genuine fault (unresolvable `main` / bad object) throws.
 */
function showConfigOnMain(
	mirrorDir: string,
	filename: string,
	env?: NodeJS.ProcessEnv,
): string | undefined {
	const spec = `main:${filename}`;
	const res = run('git', ['show', spec], mirrorDir, {env});
	if (res.status === 0) {
		return res.stdout;
	}
	// `git show main:<path>` exits non-zero both when the PATH is absent on main
	// (the config-less repo — expected, → undefined) and when `main`/the object is
	// unresolvable (a genuine fault — propagate). git words the former as
	// "...does not exist in 'main'" / "exists on disk, but not in" / "path ...
	// does not exist"; the latter as an invalid-object/unknown-revision error.
	const stderr = res.stderr;
	const pathMissing =
		/does not exist in|exists on disk, but not in|fatal: path/i.test(stderr) ||
		/did not match any file/i.test(stderr);
	if (pathMissing) {
		return undefined;
	}
	throw new Error(
		`git show ${spec} failed in ${mirrorDir} (exit ${res.status}): ${stderr.trim()}`,
	);
}

/**
 * Resolve a repo's effective {@link Config} for a NO-CHECKOUT path by layering its
 * COMMITTED `dorfl.json` (read from the bare hub mirror's `main` via
 * {@link readRepoConfigFromMirrorMain}) into the SAME
 * `flag > env > per-repo > global > default` chain a working checkout uses
 * ({@link resolveRepoConfigFromLoaded}). This is the reusable core of `do
 * --remote`'s inline per-repo resolution (`resolveRemoteRepoConfig` in `cli.ts`):
 * the mirror is assumed ALREADY ensured + fetched by the caller (the read paths
 * fetch-first), so this only READS its `main` config and layers it.
 *
 * Resilient: a config-less repo (no file on `main`) resolves to exactly
 * global + flags (byte-identical to the no-per-repo behaviour). A genuine
 * read fault is propagated by {@link readRepoConfigFromMirrorMain}; a caller that
 * must never block on a fault (a read-only scan) catches + falls back to
 * global + flags itself.
 */
export function resolveRepoConfigFromMirror(options: {
	/** The bare hub mirror directory whose `main:dorfl.json` to read. */
	mirrorPath: string;
	/** The global + default config layer (from `loadConfig`/`mergeConfig`). */
	global: Config;
	/** Optional flag overrides (highest precedence). */
	flags?: PartialConfig;
	env?: NodeJS.ProcessEnv;
	/**
	 * The per-machine override map (from `loadConfigOverride`), inserted between
	 * the committed per-repo file and env in the precedence chain. The hub key is
	 * derived from the mirror's own `origin` URL (via {@link readOriginUrl}); if
	 * unresolvable, the hub-key bucket is skipped and only the `"*"` bucket
	 * applies. Default: empty map (no override applied) — byte-identical to the
	 * pre-override behaviour.
	 */
	override?: ConfigOverrideMap;
}): Config {
	const {mirrorPath, global, flags, env, override} = options;
	const content = readRepoConfigFromMirrorMain(mirrorPath, env);
	const label = `${mirrorPath}#main:${REPO_CONFIG_FILENAME}`;
	const loaded: LoadedRepoConfig =
		content === undefined
			? {path: label, config: {}, rejected: []}
			: loadRepoConfigFromContent(content, label);
	// The hub key for the override lookup comes from the mirror's OWN `origin`
	// URL (the more reliable source for a no-checkout path — the mirror is what
	// the runner actually operates on). Unresolvable ⇒ hub-key lookup skipped
	// (graceful degrade); the `"*"` bucket still applies.
	const arbiterUrl = readOriginUrl(mirrorPath, env);
	return resolveRepoConfigFromLoaded(loaded, {
		global,
		flags,
		override,
		...(arbiterUrl !== undefined ? {arbiterUrl} : {}),
	}).config;
}

/** The bare mirror's `main` tip (40-hex sha), as freshly fetched. */
export function mirrorMainSha(
	mirrorDir: string,
	env?: NodeJS.ProcessEnv,
): string {
	return git(['rev-parse', 'main'], mirrorDir, {env}).trim();
}

/**
 * Fetch-first for the READ paths (`scan`/`status`, ADR
 * `command-surface-and-journeys` §5/§6): refresh a registered mirror's `main`
 * before reading its `work/` tree, so the read sees the remote truth (the
 * registry model makes the remote the source of truth). It is a thin wrapper
 * over {@link fetchMirrorMain} (the load-bearing main-only, no-prune fetch — it
 * must NOT be the pruning `ensureMirror` fetch, which would delete live
 * worktrees' `work/<slug>` branches, ADR §6).
 *
 * **Never errors out: warn + fall back to last-known.** A failed fetch (offline,
 * a vanished origin, a dead arbiter) is NOT fatal for a read — `scan`/`status`
 * must still report from the mirror's last-known `main`. On failure it routes a
 * human-readable note through `warn` and returns `false`; on success it returns
 * `true`. The freshness of the read then reflects the last SUCCESSFUL fetch.
 */
export function fetchMirrorMainOrWarn(options: {
	/** The bare hub mirror directory whose `main` to refresh. */
	mirrorPath: string;
	/** Sink for the fall-back warning when the fetch fails. */
	warn?: (message: string) => void;
	env?: NodeJS.ProcessEnv;
}): boolean {
	try {
		fetchMirrorMain(options.mirrorPath, options.env);
		return true;
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		options.warn?.(
			`could not fetch mirror at ${options.mirrorPath}; ` +
				`reading last-known state (offline). ${reason}`,
		);
		return false;
	}
}
