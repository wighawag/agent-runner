import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {dirname, join} from 'node:path';
import {run} from './git.js';
import {pidAlive} from './harness.js';
import {processGroupAlive} from './reap-agent-tree.js';

/**
 * **The per-WORKING-TREE writer sentinel** (observation
 * `checkpoint-releases-lock-while-predecessor-agent-still-writes`).
 *
 * The per-item lock (`item-lock.ts`) guards the ITEM: it answers "who owns this
 * task?" and it is what claim / requeue / bounce move around. Nothing guarded the
 * WORKING TREE. Those are different resources, and the deadline checkpoint is
 * exactly where they come apart: the checkpoint releases the item lock so the
 * next tick can continue the task, but the tree the previous agent was editing is
 * reused by the successor. If the predecessor is still alive, two agents write to
 * one tree.
 *
 * The primary fix is to reap the predecessor and VERIFY it is gone before the
 * lock moves (`reap-agent-tree.ts`). This sentinel is the INDEPENDENT backstop:
 * even if a live writer survives by some route the reap did not cover (a
 * deliberately `setsid`-ed grandchild, a stale run from a crashed runner, an
 * operator manually re-driving an item), a second agent physically cannot onboard
 * into a tree that already has a LIVE holder. It is deliberately keyed on the
 * TREE, not on the item: two different items sharing one worktree is just as
 * unsafe as two attempts at the same item.
 *
 * ## Where the sentinel lives, and why not in the tree
 *
 * It is written to the worktree's PRIVATE git directory (`git rev-parse
 * --absolute-git-dir`, which for a linked worktree is
 * `.../.git/worktrees/<name>/`), NOT to a file inside the working tree. That
 * placement is load-bearing:
 *
 *  - it is per-worktree (linked worktrees each get their own git dir), which is
 *    precisely the granularity we are guarding;
 *  - it can never appear in `git status`, so it cannot be mistaken for agent work,
 *    cannot be swept into a commit by a `git add -A`, and needs no new exclusion
 *    in the empty-diff backstop / `gc`'s cleanliness predicate (unlike
 *    `.dorfl-job.json`, which each of those has to filter out by name);
 *  - it is removed with the worktree, so it cannot outlive what it guards.
 *
 * ## Liveness, not presence
 *
 * A pid file that only records presence becomes a permanent blocker the first
 * time a runner is `kill -9`ed. So the holder is checked for LIVENESS (its
 * process group first, falling back to its pid) and a dead holder's sentinel is
 * treated as stale and taken over. Only a genuinely live foreign writer refuses.
 */

/** The sentinel filename inside the worktree's private git directory. */
export const WRITER_SENTINEL_FILENAME = 'dorfl-writer.json';

/** The recorded holder of a worktree's writer sentinel. */
export interface WorktreeWriter {
	/** The runner process that owns the agent writing in this tree. */
	pid: number;
	/** The agent's process GROUP, when the harness spawned a killable one. */
	pgid?: number;
	/** The item being built in this tree (diagnostics: names the other writer). */
	slug: string;
	/** ISO timestamp of acquisition (diagnostics: how long it has been held). */
	startedAt: string;
}

/** The outcome of trying to become a worktree's sole writer. */
export type WorktreeWriterLock =
	| {
			acquired: true;
			/** Release the sentinel. Idempotent, and safe if it was already stolen. */
			release(): void;
	  }
	| {
			acquired: false;
			/** The LIVE holder that refused us (when it could be parsed). */
			holder?: WorktreeWriter;
			/** Human-readable refusal, naming the other writer. */
			reason: string;
	  };

/**
 * The worktree's PRIVATE git directory, or `undefined` when `dir` is not a git
 * worktree (in which case there is no sentinel location and the caller proceeds
 * unguarded rather than failing — this is a backstop, not a gate).
 */
function worktreeGitDir(
	dir: string,
	env: NodeJS.ProcessEnv | undefined,
): string | undefined {
	const result = run('git', ['rev-parse', '--absolute-git-dir'], dir, {env});
	if (result.status !== 0) {
		return undefined;
	}
	const path = result.stdout.trim();
	return path === '' ? undefined : path;
}

/** The sentinel path for `dir`, or `undefined` when `dir` is not a worktree. */
export function writerSentinelPath(
	dir: string,
	env?: NodeJS.ProcessEnv,
): string | undefined {
	const gitDir = worktreeGitDir(dir, env);
	return gitDir === undefined
		? undefined
		: join(gitDir, WRITER_SENTINEL_FILENAME);
}

/** Read + parse the sentinel, or `undefined` when absent/corrupt. */
export function readWorktreeWriter(
	dir: string,
	env?: NodeJS.ProcessEnv,
): WorktreeWriter | undefined {
	const path = writerSentinelPath(dir, env);
	if (path === undefined || !existsSync(path)) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as WorktreeWriter;
		return typeof parsed?.pid === 'number' ? parsed : undefined;
	} catch {
		// A corrupt sentinel records nothing we can trust; treat it as absent so it
		// self-heals on the next acquire rather than wedging the worktree forever.
		return undefined;
	}
}

/**
 * Is the recorded holder still running? Prefers the agent's process GROUP (which
 * survives the group leader's death and so catches exactly the orphaned-writer
 * case this exists for), and falls back to the runner pid.
 */
export function writerAlive(holder: WorktreeWriter): boolean {
	if (holder.pgid !== undefined && processGroupAlive(holder.pgid)) {
		return true;
	}
	return pidAlive(holder.pid);
}

/**
 * Claim `dir` as the SOLE agent-writable working tree for `slug`.
 *
 * Refuses when a DIFFERENT, still-LIVE writer holds it — the second-agent case
 * the observation describes. A dead holder's sentinel is stale and is taken over
 * silently (a `kill -9`ed runner must not poison the worktree forever), and our
 * OWN pid re-acquiring is a no-op re-entry rather than a refusal.
 *
 * When `dir` is not a git worktree there is nowhere private to record the
 * sentinel; that is reported as acquired with a no-op release, because this is a
 * defence-in-depth backstop and must never become a new way for a legitimate run
 * to fail.
 */
export function acquireWorktreeWriterLock(params: {
	dir: string;
	slug: string;
	/** The agent's process group, when known (the strongest liveness anchor). */
	pgid?: number;
	env?: NodeJS.ProcessEnv;
}): WorktreeWriterLock {
	const {dir, slug, pgid, env} = params;
	const path = writerSentinelPath(dir, env);
	if (path === undefined) {
		return {acquired: true, release: () => {}};
	}

	const existing = readWorktreeWriter(dir, env);
	if (
		existing !== undefined &&
		existing.pid !== process.pid &&
		writerAlive(existing)
	) {
		return {
			acquired: false,
			holder: existing,
			reason:
				`worktree ${dir} already has a LIVE agent writer: pid ${existing.pid}` +
				(existing.pgid !== undefined ? ` (group ${existing.pgid})` : '') +
				` building '${existing.slug}' since ${existing.startedAt}. Refusing to ` +
				`onboard '${slug}' into the same working tree: two live agents in one ` +
				'tree can clobber each other’s edits, and the second can commit the ' +
				'first’s half-finished work under a message describing something else. ' +
				'Wait for it to exit, or kill it, then retry.',
		};
	}

	const record: WorktreeWriter = {
		pid: process.pid,
		...(pgid !== undefined ? {pgid} : {}),
		slug,
		startedAt: new Date().toISOString(),
	};
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

	let released = false;
	return {
		acquired: true,
		release: (): void => {
			if (released) {
				return;
			}
			released = true;
			// Only remove a sentinel that is still OURS: if it was stolen as stale by
			// another runner, deleting it would silently un-guard that runner's tree.
			const current = readWorktreeWriter(dir, env);
			if (current === undefined || current.pid === process.pid) {
				rmSync(path, {force: true});
			}
		},
	};
}
