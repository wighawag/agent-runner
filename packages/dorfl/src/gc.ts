import {existsSync, lstatSync, readdirSync, rmSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {git, run} from './git.js';
import {encodeRepoKey, readOriginUrl} from './repo-mirror.js';
import {
	JOB_RECORD_FILENAME,
	jobRecordPath,
	readJobRecord,
	removeJobRecord,
	type JobRecord,
} from './workspace.js';
import {parseWorkBranchRef, workBranchRef} from './slug-namespace.js';
import {terminalMainPaths} from './item-lock.js';
import type {SidecarType} from './sidecar.js';

/**
 * The **reaper** for job worktrees, governed by the **provably-safe deletion
 * predicate** (ADR §4 in `docs/adr/execution-substrate-decisions.md`, the
 * authoritative source). Split out of `agent-workspaces` so the substrate stays
 * thin; this module owns deletion.
 *
 * A job's worktree is removed (auto, at end-of-job; or by `gc`) **iff**:
 *
 *   1. its working tree is **clean** (no uncommitted changes), AND
 *   2. its branch tip is **reachable on the arbiter** — either merged into
 *      `<arbiter>/main` (`git merge-base --is-ancestor <tip> <arbiter>/main`),
 *      OR pushed as an up-to-date branch (`<arbiter>/<branch>` tip == local tip).
 *
 * Both hold ⇒ the worktree is genuinely redundant (reconstructible from the
 * arbiter) ⇒ remove. Otherwise ⇒ **retain for the human** (a retained worktree
 * is a reliable "needs attention" signal that dovetails with `watch`'s
 * surface-failures rail).
 *
 * The trigger is **provable safety, not "success"**: a successful-but-unpushed
 * job is retained; a job whose commits are on the arbiter is reaped. One rule,
 * no done-vs-failed special-casing. Removal is always `git worktree remove`
 * (+ prune), NEVER a bare `rm -rf` (which would leave a dangling worktree
 * registration on the hub).
 *
 * `--force` overrides the predicate (discard un-saved work) — it must be loud
 * and explicit, NEVER the default.
 */

/** The arbiter remote name valid INSIDE a job worktree (ADR §2: cut from the
 * bare hub mirror whose clone remote is `origin`). */
const ARBITER_REMOTE = 'origin';

/**
 * Why a job's worktree was retained (not provably safe to remove). The reaper
 * surfaces exactly one of these per retained job (the FIRST failing clause, in
 * predicate order: dirty tree dominates, then arbiter-reachability).
 */
export type RetainReason =
	| 'dirty-tree' // uncommitted changes in the working tree
	| 'unmerged-commits' // clean, but the branch tip is NOT on the arbiter at all
	| 'branch-not-pushed'; // clean + a remote branch exists, but its tip != local tip

/** Human-readable text for each retain reason (used in `gc` reports). */
export const RETAIN_REASON_TEXT: Record<RetainReason, string> = {
	'dirty-tree': 'dirty tree (uncommitted changes)',
	'unmerged-commits': 'unmerged commits (branch tip not on the arbiter)',
	'branch-not-pushed': 'branch not pushed (remote tip differs from local tip)',
};

/** How a job's branch tip is reachable on the arbiter (when it is). */
export type ReachableVia = 'merged' | 'pushed';

/** The result of applying the deletion-safety predicate to one job worktree. */
export interface SafetyVerdict {
	/** True iff the worktree is provably safe to remove (clean AND reachable). */
	safe: boolean;
	/** When `safe`, HOW the tip is reachable on the arbiter. */
	reachableVia?: ReachableVia;
	/** When NOT `safe`, why it was retained. */
	reason?: RetainReason;
}

export interface EvaluateSafetyInput {
	/** The job worktree directory to evaluate. */
	dir: string;
	/** The work branch checked out there (`work/<slug>`). */
	branch: string;
	/**
	 * The arbiter remote name valid inside the worktree. Defaults to `origin`
	 * (the bare hub mirror's clone remote — ADR §2). Tests with a different
	 * layout can override it.
	 */
	arbiter?: string;
	/**
	 * Drop the CLEAN-TREE half of the predicate, keeping ONLY the
	 * reachable-on-arbiter half. A worktree whose durable branch is provably on
	 * the arbiter is then safe to reap EVEN WHEN its tree has incidental churn
	 * (uncommitted doc-churn / artefacts) — because the durable artefact is the
	 * PUSHED branch, not the worktree files.
	 *
	 * Scoped, deliberate opt-in for the FAILURE-return path of `performDoRemote`,
	 * where the needs-attention seam has ALREADY surfaced the item + pushed the
	 * branch, so we KNOW the work is safe. The reachability half is NEVER dropped
	 * (we never reap work not yet on the arbiter — never lose work). The default
	 * (`false`) keeps the full clean-AND-reachable predicate the clean-completion
	 * path and `gc`'s default sweep use unchanged.
	 */
	reachableOnly?: boolean;
	env?: NodeJS.ProcessEnv;
}

/**
 * Apply the provably-safe deletion predicate (ADR §4) to ONE job worktree:
 *
 *   1. the working tree must be **clean** (no uncommitted changes), AND
 *   2. the branch tip must be **reachable on the arbiter** — merged
 *      (`merge-base --is-ancestor <tip> <arbiter>/main`) OR pushed
 *      (`<arbiter>/<branch>` tip == local tip).
 *
 * Reaches out to the arbiter (a `git fetch`) so the remote-tracking refs reflect
 * the live arbiter before checking reachability. Never mutates the worktree.
 * Pure verdict — the caller decides whether to reap.
 */
export function evaluateDeletionSafety(
	input: EvaluateSafetyInput,
): SafetyVerdict {
	const env = input.env;
	const arbiter = input.arbiter ?? ARBITER_REMOTE;

	// 1. Clean tree? Dirty dominates (we never reap over uncommitted work) —
	//    UNLESS `reachableOnly` was opted into (the failure path, where the branch
	//    is already pushed so the durable artefact is the branch, not the tree).
	if (input.reachableOnly !== true && !isWorkingTreeClean(input.dir, env)) {
		return {safe: false, reason: 'dirty-tree'};
	}

	// Refresh the arbiter's refs so reachability is checked against the LIVE
	// arbiter (not a stale local mirror). A job worktree is cut from a bare hub
	// mirror whose `origin` remote has NO fetch refspec (so `origin/main` /
	// `origin/<branch>` would not otherwise resolve) — so we fetch the two refs
	// we need EXPLICITLY into remote-tracking refs (the same technique
	// `integrator.rebaseOntoArbiterMain` uses). A plain `git fetch origin` would
	// instead try to clobber the checked-out branch on a mirror. Best-effort: an
	// unreachable arbiter leaves the local refs in place and the predicate reads
	// as not-reachable → retain (the safe direction).
	fetchTracking(input.dir, arbiter, 'main', env);
	fetchTracking(input.dir, arbiter, input.branch, env);

	const localTip = revParse(input.dir, 'HEAD', env);

	// 2a. Merged: the tip is provably on <arbiter>/main — either a plain
	//     ancestor (fast path) OR squash-aware-equivalent (the durable done/
	//     dropped record is on main AND the branch carries nothing main lacks).
	const arbiterMainRef = `refs/remotes/${arbiter}/main`;
	const reapIdentity = reapIdentityFromBranch(input.branch);
	if (
		reapIdentity !== undefined
			? isProvablyMergedForReap({
					cwd: input.dir,
					tip: localTip,
					arbiterMain: arbiterMainRef,
					namespace: reapIdentity.namespace,
					slug: reapIdentity.slug,
					env,
				})
			: isAncestor(input.dir, localTip, arbiterMainRef, env)
	) {
		return {safe: true, reachableVia: 'merged'};
	}

	// 2b. Pushed: <arbiter>/<branch> exists AND its tip == the local tip.
	const remoteTip = revParseOrUndefined(
		input.dir,
		`refs/remotes/${arbiter}/${input.branch}`,
		env,
	);
	if (remoteTip !== undefined && remoteTip === localTip) {
		return {safe: true, reachableVia: 'pushed'};
	}

	// Clean, but NOT on the arbiter: distinguish "a remote branch exists but its
	// tip differs (un-pushed amend)" from "no remote presence at all".
	if (remoteTip !== undefined) {
		return {safe: false, reason: 'branch-not-pushed'};
	}
	return {safe: false, reason: 'unmerged-commits'};
}

export interface ReapInput extends EvaluateSafetyInput {
	/**
	 * The bare hub mirror the worktree was cut from. `git worktree remove` +
	 * `prune` are run there (the worktree's registration lives on the mirror).
	 */
	mirrorPath: string;
	/**
	 * Override the predicate: remove the worktree even when NOT provably safe
	 * (discard un-saved work). Loud + explicit — NEVER the default (ADR §4).
	 */
	force?: boolean;
}

export interface ReapResult {
	/** True iff the worktree was actually removed. */
	removed: boolean;
	/** The verdict the decision was based on. */
	verdict: SafetyVerdict;
	/** True iff removal happened only because `force` overrode the predicate. */
	forced: boolean;
}

/**
 * Auto-reap ONE job worktree iff the predicate holds (or `force` overrides):
 * `git worktree remove` then `git worktree prune` on the hub mirror — NEVER a
 * bare `rm -rf` (ADR §4). Returns whether it removed the worktree + the verdict
 * it acted on (so the caller can report a retained job's reason).
 *
 * Used at end-of-job (the runner calls it after integrating) and by `gc` (the
 * catch-up when auto-reap didn't run). A job whose work is NOT on the arbiter is
 * never removed here (force is the only override, and it is explicit).
 */
export function reapJob(input: ReapInput): ReapResult {
	const verdict = evaluateDeletionSafety(input);
	const force = input.force === true;
	if (!verdict.safe && !force) {
		return {removed: false, verdict, forced: false};
	}
	removeWorktree(input.mirrorPath, input.dir, input.branch, input.env);
	return {removed: true, verdict, forced: !verdict.safe};
}

/** One job the `gc` sweep evaluated. */
export interface GcJob {
	/** Absolute path to the job worktree. */
	dir: string;
	/** The work slug (from the record, else derived from the dir name). */
	slug: string;
	/** The work branch (`work/<slug>`). */
	branch: string;
	/** The per-job record, when present. */
	record?: JobRecord;
}

/** A worktree `gc` reaped (provably safe, or forced). */
export interface ReapedJob extends GcJob {
	verdict: SafetyVerdict;
	/** True iff removed only because `--force` overrode the predicate. */
	forced: boolean;
}

/** A worktree `gc` retained, with the human-readable reason it kept it. */
export interface RetainedJob extends GcJob {
	reason: RetainReason;
	/** Human-readable reason text (`RETAIN_REASON_TEXT[reason]`). */
	reasonText: string;
}

export interface GcOptions {
	/** The execution working area (config `workspacesDir`, default `~/.dorfl`). */
	workspacesDir: string;
	/**
	 * SCOPE the sweep to a SINGLE arbiter: only worktrees whose hub mirror's
	 * `origin` encodes to this hub key ({@link encodeRepoKey}) are considered.
	 * This is the DEFAULT operating mode of the `gc` CLI (the arbiter resolved
	 * from the cwd) — a `gc` run from repo A must NEVER touch repo B's worktrees.
	 *
	 * When UNSET the sweep is GLOBAL (every arbiter under `workspacesDir/work/*`).
	 * Global is the destructive, cross-repo mode: the CLI only reaches it behind
	 * the explicit + loud `--all-arbiters` flag, NEVER by defaulting here.
	 */
	arbiterKey?: string;
	/**
	 * Override the predicate for EVERY job: discard un-saved work. Loud +
	 * explicit (the CLI guards it behind a confirmation) — NEVER the default.
	 */
	force?: boolean;
	/** Sink for human-readable progress notes (per reaped / retained job). */
	note?: (message: string) => void;
	env?: NodeJS.ProcessEnv;
}

/**
 * An ORPHAN `<workspacesDir>/work/*` entry `gc` swept: a path git never
 * registered as a worktree and that carries NO job record — a dangling symlink,
 * or a bare directory left by a run that crashed BEFORE `git worktree add`
 * registered it (an early `spawn git ENOENT`). It holds no durable work, so it is
 * always safe to remove; sweeping it self-heals a half-set-up claim instead of
 * leaving it to wedge the next `worktree add` ("already exists") until a human
 * `rm`s it. Reported SEPARATELY from reaped jobs (it was never a real job).
 */
export interface SweptOrphan {
	/** Absolute path to the orphan entry that was removed. */
	dir: string;
	/** Whether the orphan was a dangling symlink or an un-registered directory. */
	kind: 'dangling-symlink' | 'orphan-dir';
}

export interface GcResult {
	/** The worktrees reaped this sweep (provably safe, or forced). */
	reaped: ReapedJob[];
	/** The worktrees retained, each with a clear reason. */
	retained: RetainedJob[];
	/** Record-less orphan `work/*` entries swept (dangling symlinks / orphan dirs). */
	sweptOrphans: SweptOrphan[];
}

/**
 * Re-apply the deletion-safety predicate across every `<workspacesDir>/work/*`
 * job (ADR §4): reap the provably-safe ones, RETAIN the rest and report each
 * with a clear reason. This is the safety-net catch-up for when auto-reap didn't
 * run (a runner crash/kill left the worktree behind).
 *
 * `force: true` overrides the predicate for every job (discard un-saved work) —
 * loud + explicit (the CLI confirms first), NEVER the default. A job whose work
 * is NOT on the arbiter is never auto-removed without `force`.
 *
 * SCOPE: when `arbiterKey` is set the sweep considers ONLY worktrees belonging
 * to that arbiter (the CLI's default, resolved from the cwd) — so a `gc` in repo
 * A cannot reap repo B's worktrees. An UNSET `arbiterKey` sweeps GLOBALLY across
 * every arbiter (the CLI reaches that only behind the loud `--all-arbiters`).
 */
export function gc(options: GcOptions): GcResult {
	const note = options.note ?? (() => {});
	const env = options.env;
	const arbiterKey = options.arbiterKey;
	const reaped: ReapedJob[] = [];
	const retained: RetainedJob[] = [];

	// First, self-heal any record-less ORPHAN `work/*` entry (a dangling symlink
	// or a dir git never registered) so a half-set-up claim does not linger unseen
	// by the job loop below and wedge the next `worktree add`. Orphans carry NO
	// durable work and are NOT any repo's real worktree (no record ⇒ no mirror to
	// attribute to an arbiter), so the arbiter scope does not gate them — they are
	// bounded, worthless residue either way.
	const sweptOrphans = sweepOrphans(options.workspacesDir, note);

	for (const job of discoverJobs(options.workspacesDir)) {
		const mirrorPath = resolveMirrorPath(options.workspacesDir, job);

		// ARBITER SCOPE (the default `gc` mode): when `arbiterKey` is set, consider
		// ONLY worktrees whose mirror `origin` encodes to that hub key — a `gc` run
		// from repo A must never reap repo B's worktrees. A job whose mirror origin
		// is unreadable (a malformed mirror) is SKIPPED under scope (the safe
		// direction: we cannot prove it belongs to this arbiter, so leave it).
		if (
			arbiterKey !== undefined &&
			jobArbiterKey(mirrorPath, env) !== arbiterKey
		) {
			continue;
		}

		const result = reapJob({
			dir: job.dir,
			branch: job.branch,
			mirrorPath,
			force: options.force,
			env,
		});

		if (result.removed) {
			reaped.push({...job, verdict: result.verdict, forced: result.forced});
			note(
				result.forced
					? `Reaped ${job.slug} (FORCED — discarded un-saved work).`
					: `Reaped ${job.slug} (${result.verdict.reachableVia}).`,
			);
			continue;
		}

		const reason = result.verdict.reason ?? 'unmerged-commits';
		const reasonText = RETAIN_REASON_TEXT[reason];
		retained.push({...job, reason, reasonText});
		note(`Retained ${job.slug}: ${reasonText}.`);
	}

	return {reaped, retained, sweptOrphans};
}

/**
 * Sweep record-less ORPHAN entries under `<workspacesDir>/work/*`: a DANGLING
 * SYMLINK (its target gone) or a directory with NO job record at either the
 * sibling or legacy in-tree location. These are the residue of a run that
 * crashed BETWEEN creating the `work/<id>` path and registering it as a git
 * worktree (or writing its record) — e.g. an early `spawn git ENOENT`. They hold
 * no durable work, are invisible to {@link discoverJobs} (which requires a
 * record), and block the next same-id `worktree add`. Removing them is a bounded
 * `rmSync` of ONE path each (never a registered worktree — those carry a record
 * and go through the reap predicate). Best-effort per entry.
 */
function sweepOrphans(
	workspacesDir: string,
	note: (message: string) => void,
): SweptOrphan[] {
	const workDir = join(workspacesDir, 'work');
	if (!existsSync(workDir)) {
		return [];
	}
	const swept: SweptOrphan[] = [];
	for (const entry of readdirSync(workDir)) {
		if (entry.endsWith('.json')) {
			continue; // a sibling record file, not a work-id entry
		}
		const dir = join(workDir, entry);
		let link;
		try {
			link = lstatSync(dir);
		} catch {
			continue; // vanished under us
		}
		const isSymlink = link.isSymbolicLink();
		const targetExists = existsSync(dir); // follows the link; false ⇒ dangling
		const hasRecord =
			existsSync(jobRecordPath(dir)) ||
			(targetExists && existsSync(join(dir, JOB_RECORD_FILENAME)));
		// Orphan iff: a dangling symlink (target gone), OR a record-less entry that
		// is not a live directory git could own (a stray symlink-to-elsewhere, or a
		// dir with no record). A record-bearing entry is a real job → leave it to the
		// reap predicate above.
		const danglingSymlink = isSymlink && !targetExists;
		if (hasRecord) {
			continue;
		}
		if (!danglingSymlink) {
			// A record-less real directory: only sweep it if git does not track it as a
			// worktree here. `discoverJobs` already skips it (no record), and a
			// registered worktree always has our record, so a record-less dir is an
			// orphan. But be conservative: skip a NON-symlink dir that is not empty of
			// a `.git` pointer only when it looks like a crashed pre-register dir.
			if (isSymlink && targetExists) {
				// symlink to a live path but no record → still an orphan link
			} else if (!link.isDirectory()) {
				continue; // not a dir, not a dangling link — leave alone
			} else if (existsSync(join(dir, '.git'))) {
				continue; // has a git pointer but no record: leave for a human (rare)
			}
		}
		try {
			rmSync(dir, {recursive: true, force: true});
			const kind = danglingSymlink ? 'dangling-symlink' : 'orphan-dir';
			swept.push({dir, kind});
			note(`Swept orphan work entry ${entry} (${kind}).`);
		} catch {
			// best-effort: a permission error surfaces on the next add attempt
		}
	}
	return swept;
}

/**
 * Discover every job worktree under `<workspacesDir>/work/*` (the flat layout —
 * ADR §2). The per-job record is a SIBLING of the worktree dir
 * (`<work-id>.json` next to `<work-id>/`, {@link jobRecordPath}) — OUTSIDE the
 * checked-out tree so it can never be swept into a commit — so a work-id dir is
 * a job iff its sibling record file exists (with a LEGACY fallback to an in-tree
 * record left by an old binary, via {@link readJobRecord}). The branch comes
 * from the record (falling back to `work/<derived-slug>`).
 */
export function discoverJobs(workspacesDir: string): GcJob[] {
	const workDir = join(workspacesDir, 'work');
	if (!existsSync(workDir)) {
		return [];
	}
	const jobs: GcJob[] = [];
	for (const entry of readdirSync(workDir)) {
		const dir = join(workDir, entry);
		let isDir: boolean;
		try {
			isDir = statSync(dir).isDirectory();
		} catch {
			continue;
		}
		if (!isDir) {
			continue; // skip the sibling `<work-id>.json` record files themselves
		}
		// A job iff a record exists — the sibling path first, then the legacy
		// in-tree path (an old-binary worktree). Mirrors `readJobRecord`'s order.
		if (
			!existsSync(jobRecordPath(dir)) &&
			!existsSync(join(dir, JOB_RECORD_FILENAME))
		) {
			continue; // not a job worktree (no record at either location)
		}
		const record = readJobRecord(dir);
		const slug = record?.slug ?? deriveSlug(entry);
		// The job record carries the (already-namespaced) branch — the SOURCE OF
		// TRUTH. Only when a record is missing/legacy do we synthesise a fallback;
		// the flat work-id dir name cannot recover the type, so default to the
		// overwhelmingly-common `task` namespace (a recordless worktree is a rare
		// legacy/corrupt case).
		const branch = record?.branch ?? workBranchRef('task', slug);
		jobs.push({dir, slug, branch, record});
	}
	return jobs;
}

/** Derive a slug from a flat work-id dir name (`host__org__repo__slug`). */
function deriveSlug(workId: string): string {
	const parts = workId.split('__');
	return parts[parts.length - 1] || workId;
}

/**
 * The hub mirror a job worktree was cut from. We do NOT reconstruct it from the
 * encoded repo key (the key may not round-trip the arbiter URL): a worktree's
 * `.git` file points at its mirror's `worktrees/<id>` admin dir, so we read the
 * mirror's common dir directly from the worktree (robust + layout-agnostic).
 */
function resolveMirrorPath(workspacesDir: string, job: GcJob): string {
	const common = run(
		'git',
		['rev-parse', '--path-format=absolute', '--git-common-dir'],
		job.dir,
	);
	const dir = common.stdout.trim();
	if (common.status === 0 && dir !== '') {
		return dir;
	}
	// Fallback: the repos hub under the workspaces dir (best-effort).
	return join(workspacesDir, 'repos');
}

/**
 * The hub KEY ({@link encodeRepoKey}) of the arbiter a job worktree belongs to,
 * read from its hub mirror's `origin` URL (the arbiter URL the mirror was cloned
 * from). This is the SAME identity `do --isolated` / `ensureMirror` key a repo's
 * arbiter under (`mirrorPath` = `<workspacesDir>/repos/<key>.git`), so a `gc`
 * scoped to the cwd's arbiter key matches exactly the worktrees cut for that
 * arbiter. Returns `undefined` when the mirror `origin` cannot be read (a
 * malformed mirror) — the caller then treats the job as NOT belonging to the
 * scoped arbiter (the safe direction under a scoped sweep).
 */
function jobArbiterKey(
	mirrorPath: string,
	env: NodeJS.ProcessEnv | undefined,
): string | undefined {
	const originUrl = readOriginUrl(mirrorPath, env);
	return originUrl === undefined ? undefined : encodeRepoKey(originUrl);
}

/** One distinct arbiter with worktrees under the work area (for the loud
 * `--all-arbiters` banner). */
export interface WorkspaceArbiter {
	/** The hub key ({@link encodeRepoKey}) — or `undefined` for a malformed mirror. */
	key?: string;
	/** The arbiter `origin` URL of the hub mirror, when readable. */
	url?: string;
}

/**
 * Enumerate the DISTINCT arbiters that currently own a worktree under
 * `<workspacesDir>/work/*` — i.e. the set a GLOBAL (`--all-arbiters`) sweep would
 * touch. Reads each discovered job's hub mirror `origin` URL and de-duplicates
 * by hub key. Used ONLY to print the loud banner before a cross-arbiter sweep;
 * the sweep itself re-derives per-job scope in {@link gc}.
 */
export function enumerateWorkspaceArbiters(
	workspacesDir: string,
	env: NodeJS.ProcessEnv | undefined,
): WorkspaceArbiter[] {
	const seen = new Map<string, WorkspaceArbiter>();
	for (const job of discoverJobs(workspacesDir)) {
		const mirrorPath = resolveMirrorPath(workspacesDir, job);
		const url = readOriginUrl(mirrorPath, env);
		const key = url === undefined ? undefined : encodeRepoKey(url);
		const dedupe = key ?? `path:${mirrorPath}`;
		if (!seen.has(dedupe)) {
			seen.set(dedupe, {key, url});
		}
	}
	return [...seen.values()];
}

/**
 * The hub KEY ({@link encodeRepoKey}) of the arbiter reachable from a working
 * repo `cwd` via its `<arbiter>` remote (default `origin`), i.e. `encodeRepoKey`
 * of `git -C <cwd> remote get-url <arbiter>`. This is how the `gc` CLI resolves
 * the DEFAULT scope from the current directory — the SAME arbiter-resolution the
 * mirror / `do --isolated` path uses (`ensureMirror`'s `fromRepo` + `arbiter`).
 * Returns `undefined` when `cwd` is not a git repo or has no such remote (the
 * CLI then errors rather than silently going global).
 */
export function resolveArbiterKeyFromCwd(
	cwd: string,
	arbiter: string,
	env: NodeJS.ProcessEnv | undefined,
): string | undefined {
	const res = run('git', ['remote', 'get-url', arbiter], cwd, {env});
	if (res.status !== 0) {
		return undefined;
	}
	const url = res.stdout.trim();
	return url === '' ? undefined : encodeRepoKey(url);
}

/**
 * True iff the working tree has NO uncommitted WORK (tracked, staged, or
 * untracked). The agent's edits and any untracked artefacts count: untracked
 * work is still un-saved work.
 *
 * The `.dorfl-job.json` exclusion below is now INERT: the per-job record
 * lives at a SIBLING path OUTSIDE the worktree, so it can no longer appear in
 * the worktree's `git status` at all. It used to be load-bearing (the record
 * was written INSIDE the worktree, so a perfectly-saved job would otherwise read
 * as "dirty" purely because the runner wrote its own state file there). It is
 * kept as a harmless no-op that still names the record for a hypothetical
 * old-binary worktree whose record is still in-tree (the read-fallback case);
 * removing it would only risk regressing that edge with no upside. The
 * `work/`-ledger exclusion is a SEPARATE concern and stays.
 */
function isWorkingTreeClean(
	dir: string,
	env: NodeJS.ProcessEnv | undefined,
): boolean {
	// `status --porcelain` prints one line per change; empty ⇒ clean. Includes
	// staged, unstaged, and untracked files.
	const res = run('git', ['status', '--porcelain'], dir, {env});
	if (res.status !== 0) {
		// Can't determine cleanliness ⇒ treat as dirty (the safe direction).
		return false;
	}
	const lines = res.stdout
		.split('\n')
		.map((l) => l.trimEnd())
		.filter((l) => l !== '');
	// Each porcelain line is `XY <path>` (path starts at column 3). Drop the
	// runner's own job-record line; any remaining change ⇒ genuinely dirty.
	const work = lines.filter((l) => l.slice(3).trim() !== JOB_RECORD_FILENAME);
	return work.length === 0;
}

/**
 * Fetch a single arbiter head into its remote-tracking ref EXPLICITLY
 * (`+refs/heads/<head>:refs/remotes/<arbiter>/<head>`). A bare hub mirror has no
 * fetch refspec, so this is the only way the remote-tracking ref exists; it is
 * also harmless on a normal clone. Best-effort: the arbiter may be unreachable
 * (offline) or the head may not exist there — either way the local ref simply
 * stays absent/stale and the predicate reads as not-reachable → retain.
 */
function fetchTracking(
	dir: string,
	arbiter: string,
	head: string,
	env: NodeJS.ProcessEnv | undefined,
): void {
	run(
		'git',
		[
			'fetch',
			'--quiet',
			arbiter,
			`+refs/heads/${head}:refs/remotes/${arbiter}/${head}`,
		],
		dir,
		{env},
	);
}

/**
 * Extract the `{namespace, slug}` identity a reap decision needs from a work
 * branch ref (`work/[<producer>-]<type>-<slug>`). Returns `undefined` for a
 * non-namespaced branch — the caller then falls back to the ancestry-only
 * fast-path (the squash-aware fallback has no anchor without an identity to
 * look up on `<arbiter>/main`, so the safe direction is the strict old rule).
 */
function reapIdentityFromBranch(
	branch: string,
): {namespace: SidecarType; slug: string} | undefined {
	const parsed = parseWorkBranchRef(branch);
	if (parsed === undefined) {
		return undefined;
	}
	// `SlugNamespace` and `SidecarType` share the same three members
	// (`'task' | 'spec' | 'observation'`); the cast is structural.
	return {namespace: parsed.namespace as SidecarType, slug: parsed.slug};
}

/** Input for {@link isProvablyMergedForReap}. */
export interface ProvablyMergedForReapInput {
	/** The local repo the git predicates run in. */
	cwd: string;
	/** The candidate branch tip (a 40-hex sha or a resolvable ref). */
	tip: string;
	/**
	 * The arbiter's main as a ref RESOLVABLE INSIDE `cwd` — a fetched
	 * remote-tracking ref (`refs/remotes/<arbiter>/main`) or short-form
	 * (`<arbiter>/main`). Callers are responsible for the fetch (best-effort;
	 * an unresolvable ref reads as not-provable ⇒ false).
	 */
	arbiterMain: string;
	/**
	 * The item's type (task/spec/observation) — used to look up the durable
	 * terminal records on `<arbiter>/main`. Reap decisions on a
	 * `work/<type>-<slug>` branch pass the parsed type from
	 * {@link parseWorkBranchRef}.
	 */
	namespace: SidecarType;
	/** The item's bare slug — the anchor for the squash-aware fallback. */
	slug: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * The **squash-aware, provably-merged predicate** used to decide reap-safety
 * across the workspace: `gc.ts`'s worktree reaper, `reap-branches.ts`'s remote
 * `work/*` sweep, `integrator.ts`'s post-merge remote-head reap, and
 * `complete.ts`'s local-branch reap. ONE decision point so the two rules can
 * never drift apart, and NEVER `--force` — a merged-for-reap ref needs none.
 *
 * A remote/local `work/<slug>` branch is reapable iff EITHER:
 *
 *   1. **Fast path (unchanged).** `git merge-base --is-ancestor <tip>
 *      <arbiter>/main` succeeds — the fast-forward / true-merge land case.
 *   2. **Squash-aware fallback (new).** BOTH of the following hold:
 *      - the item is TERMINAL on `<arbiter>/main` — i.e. the matching
 *        {@link terminalMainPaths} (`work/tasks/done/<slug>.md` or
 *        `work/tasks/cancelled/<slug>.md` for a task; `work/specs/tasked/…`
 *        or `work/specs/dropped/…` for a spec) exists in the fetched main
 *        tree; AND
 *      - the branch carries NOTHING main lacks — either `git diff --quiet
 *        <arbiter>/main <tip>` reads clean (content-equal / content-subset)
 *        OR `git cherry <arbiter>/main <tip>` reports every commit as
 *        already applied by patch-id (`-` on every line, catching
 *        rebase-lands the tree check misses).
 *
 * Grounding: the durable `<arbiter>/main` record is authoritative. It is what
 * `complete` writes FIRST, so if the terminal record is there the item's work
 * is at rest, and a branch that carries nothing main lacks has no in-flight
 * work to protect. The safety floor is unchanged: NEVER reap an in-flight /
 * unmerged branch (no terminal record ⇒ retain), NEVER reap a branch carrying
 * commits main lacks (content check fails ⇒ retain), NEVER `--force`.
 *
 * This is the branch-side twin of the lock-side terminal-on-main recovery
 * (`isTerminalOnMain` in `item-lock.ts`): same anchor, different subject.
 */
export function isProvablyMergedForReap(
	input: ProvablyMergedForReapInput,
): boolean {
	const {cwd, tip, arbiterMain, namespace, slug, env} = input;

	// 1. Fast path — the fast-forward / true-merge land case. Cheap: one
	//    `git merge-base --is-ancestor`.
	if (isAncestor(cwd, tip, arbiterMain, env)) {
		return true;
	}

	// 2. Squash-aware fallback. Anchor: the durable terminal record on
	//    `<arbiter>/main`. No terminal record ⇒ the item is still in-flight (or
	//    an observation, which has no terminal folder) ⇒ retain (never reap
	//    in-flight work).
	if (!terminalRecordOnMain(cwd, arbiterMain, namespace, slug, env)) {
		return false;
	}

	// 2a. Content-subset: `git diff --quiet <arbiterMain> <tip>` clean ⇒ the
	//     two trees are identical, so the branch carries nothing main lacks
	//     (the incident shape: the branch is a since-lagged snapshot of a
	//     squash-landed item, no new content on it).
	const diff = run('git', ['diff', '--quiet', arbiterMain, tip], cwd, {env});
	if (diff.status === 0) {
		return true;
	}

	// 2b. Patch-id equivalence via `git cherry <upstream> <head>`: every commit
	//     reachable from `<tip>` but not `<arbiterMain>` is reported as `-`
	//     (already applied upstream by patch-id). This catches rebase-lands
	//     where the tree diff is non-empty but every commit is already on main
	//     under a different sha.
	const cherry = run('git', ['cherry', arbiterMain, tip], cwd, {env});
	if (cherry.status === 0) {
		const lines = cherry.stdout
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l !== '');
		if (lines.length > 0 && lines.every((l) => l.startsWith('- '))) {
			return true;
		}
	}

	return false;
}

/** True iff `<arbiterMain>` carries ANY of the item's durable terminal records
 * ({@link terminalMainPaths}). Best-effort: `cat-file -e` is a cheap tree
 * probe; an unresolvable `<arbiterMain>` reads as no-record ⇒ retain (the safe
 * direction). Observations have no terminal folder ⇒ always false. */
function terminalRecordOnMain(
	cwd: string,
	arbiterMain: string,
	namespace: SidecarType,
	slug: string,
	env: NodeJS.ProcessEnv | undefined,
): boolean {
	for (const path of terminalMainPaths(namespace, slug)) {
		const res = run('git', ['cat-file', '-e', `${arbiterMain}:${path}`], cwd, {
			env,
		});
		if (res.status === 0) {
			return true;
		}
	}
	return false;
}

/**
 * True iff `ancestor` is an ancestor of (or equal to) `descendant`, both
 * resolved IN the local repo `dir` (`git merge-base --is-ancestor`). The
 * low-level fast-path building block for {@link isProvablyMergedForReap} —
 * reap-safety decisions across the workspace go through the squash-aware
 * wrapper, never this raw predicate. EXPORTED so callers that legitimately
 * need pure ancestry (non-reap idempotency checks, claim-reachability guards)
 * keep the one shared implementation.
 */
export function isAncestor(
	dir: string,
	ancestor: string,
	descendant: string,
	env: NodeJS.ProcessEnv | undefined,
): boolean {
	const res = run(
		'git',
		['merge-base', '--is-ancestor', ancestor, descendant],
		dir,
		{env},
	);
	return res.status === 0;
}

/** Resolve a ref to its 40-hex sha (throws if it doesn't resolve). */
function revParse(
	dir: string,
	ref: string,
	env: NodeJS.ProcessEnv | undefined,
): string {
	return git(['rev-parse', '--verify', '--quiet', ref], dir, {env}).trim();
}

/** Resolve a ref to its sha, or `undefined` if it doesn't resolve. */
function revParseOrUndefined(
	dir: string,
	ref: string,
	env: NodeJS.ProcessEnv | undefined,
): string | undefined {
	const res = run('git', ['rev-parse', '--verify', '--quiet', ref], dir, {env});
	if (res.status !== 0) {
		return undefined;
	}
	const sha = res.stdout.trim();
	return sha === '' ? undefined : sha;
}

/**
 * Remove a job worktree the contract-safe way: `git worktree remove` then
 * `git worktree prune` on the hub mirror, plus dropping the now-orphaned work
 * branch AND the now-orphaned per-job record (a SIBLING of the worktree since
 * the relocation — it no longer goes away WITH the worktree dir, so we delete it
 * explicitly so a reaped job leaves no `<work-id>.json` litter). NEVER a bare
 * `rm -rf` of the WORKTREE (ADR §4): a raw delete leaves a dangling worktree
 * registration on the hub. Best-effort on prune/branch-drop/record (idempotent
 * re-runs of `gc` must not error on an already-clean hub).
 */
function removeWorktree(
	mirrorPath: string,
	dir: string,
	branch: string,
	env: NodeJS.ProcessEnv | undefined,
): void {
	git(['worktree', 'remove', '--force', dir], mirrorPath, {env});
	removeJobRecord(dir);
	try {
		git(['worktree', 'prune'], mirrorPath, {env});
	} catch {
		// best-effort
	}
	try {
		git(['branch', '-D', branch], mirrorPath, {env});
	} catch {
		// branch may already be gone
	}
}
