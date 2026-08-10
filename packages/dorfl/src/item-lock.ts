import {randomUUID} from 'node:crypto';
import {runAsync, type RunResult} from './git.js';
import {
	resolveSidecarIdentity,
	sidecarPathFor,
	type SidecarType,
} from './sidecar.js';
import {parseFrontmatter} from './frontmatter.js';
import {workItemRel} from './work-layout.js';

/**
 * The **unified item-lock module** (spec `ledger-status-per-item-lock-refs`, ADR
 * `ledger-status-on-per-item-lock-refs`). The runner's ONE lock primitive: ONE
 * lock per item, on a PER-ITEM hidden ref `refs/dorfl/lock/<entry>`,
 * acquired by an ATOMIC create-only push and released by DELETING the ref, with a
 * two-axis (`action` × `state`) entry. It collapses the old transient status
 * folders (`in-progress`, `needs-attention`, `tasking`, `advancing`) into ONE
 * lock keyed by item identity; `in-progress` = lock held active for `implement`,
 * `needs-attention` = lock held `stuck`.
 *
 * It GENERALISES the green tracer that proved the dangerous core end-to-end on a
 * bare `file://` arbiter (the tracer is now this file). The one production
 * difference from the tracer is the IDENTITY SEAM: callers pass a NAMESPACED item
 * identity (`task:<slug>` / `spec:<slug>` / `observation:<slug>` / `obs:<slug>`,
 * or a bare `<slug>` = task), and this module derives the type-encoded lock
 * `<entry>` (`<type>-<slug>`) through {@link resolveSidecarIdentity} — the SAME
 * single source of truth the sidecar (`work/questions/<type>-<slug>.md`) and the
 * work branch (`work/<type>-<slug>`) already use. There is deliberately NO second
 * identity scheme: a task, a spec,
 * and an observation that share a slug get DISTINCT lock refs, and the SAME item
 * under different actions shares ONE ref (so implement / task / advance on one
 * item are mutually exclusive by construction).
 *
 * It is NOT yet wired into claim/task/advance — those are separate, dependent
 * tasks — and deliberately does NOT touch `main`.
 *
 * WHY a per-item ref (not a marker on `main` or a tree on one shared ref):
 *   - **No false contention, no retry.** The ONLY writer that can contend on item
 *     X's lock is another writer FOR X — a GENUINE conflict the loser SHOULD lose.
 *     Two writers for DIFFERENT items touch DIFFERENT refs and never serialise. So
 *     acquire needs NO refetch-retry budget (contrast the shared-`main` CAS, which
 *     falsely-contends under parallelism and exhausts its retry cap → exit 3).
 *   - **Self-cleaning, no storage growth.** Acquire CREATES the ref; release
 *     DELETES it (not "empties" it), so the live ref set = currently-held items
 *     only. The lock commit is PARENTLESS (no `main` parent), so on ref-delete it
 *     is immediately unreachable and reclaimed by normal git gc — and the lock ref
 *     is fully decoupled from `main`'s object graph.
 *   - **Branch-inheritance impossible.** Nothing is in `main`'s tree, so a work
 *     branch cut from `main` inherits no lock state.
 *   - **Provider-agnostic.** A ref is a ref: the create-only / delete pushes work
 *     identically on a `--bare file://` arbiter and a real remote.
 *
 * ATOMICITY is the `--force-with-lease=<ref>:` (EMPTY expected) create-only push:
 * the arbiter accepts it ONLY if the ref is still absent; a racer who lost finds
 * the ref present and is rejected. No nonce gymnastics are needed here (unlike the
 * shared-`main` CAS) because the ref NAME is the identity — two acquires for the
 * same item race the SAME ref, and ref-level create-only is itself the mutex.
 */

/** The ref namespace for per-item locks. HIDDEN (not `refs/heads/*`): invisible
 * in the GitHub UI, not swept by branch automation, not fetched by a default
 * clone. Deletion = "all locks released" (recoverable; work is on the work
 * branches + `main`). */
export const LOCK_REF_PREFIX = 'refs/dorfl/lock';

/**
 * The single IDENTITY SEAM for the lock: derive the type-encoded lock `<entry>`
 * (`<type>-<slug>`) from a NAMESPACED item identity, through the shared
 * {@link resolveSidecarIdentity} resolver (the single source of truth, which the
 * sidecar filename + the advancing-lock marker also key onto). Accepts the same
 * forms as that resolver: `task:<slug>` / `spec:<slug>` / `observation:<slug>` /
 * `obs:<slug>`, or a bare `<slug>` (= task). Acquire/release/read ALL key
 * through THIS function, so there is one — and only one — addressing scheme.
 */
export function lockEntryFor(item: string): string {
	const {type, slug} = resolveSidecarIdentity(item);
	return `${type}-${slug}`;
}

/** The lock ref for a type-encoded `<entry>` (`<type>-<slug>`). */
export function itemLockRef(entry: string): string {
	return `${LOCK_REF_PREFIX}/${entry}`;
}

/**
 * The character class a LITERAL lock-entry name must match to be addressable
 * through `release-lock --entry <literal>` (task
 * `release-lock-entry-escape-hatch-and-literal-entry-reporting`): a NON-EMPTY run
 * of `[A-Za-z0-9._-]` — the SAME shape the minting side produces (`<type>-<slug>`,
 * and the pre-cutover `slice-<slug>` / `prd-<slug>` entries it must be able to
 * name). It deliberately EXCLUDES `/` and whitespace so a literal can never escape
 * the `refs/dorfl/lock/` namespace (a `/` would address a different ref path; a
 * space would break the push refspec). This is the ONLY validation the `--entry`
 * escape hatch performs before the git operation — the entry name is taken
 * literally otherwise, bypassing the namespace mapping the item-form path uses.
 */
export function isValidLockEntryName(entry: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(entry);
}

/** WHAT holds the lock — the three mutually-exclusive actions over one item. */
export type LockAction = 'implement' | 'task' | 'advance';

/**
 * Health of the hold. Post-CONTRACT step (task `retire-stuck-lock-state`, spec
 * `surface-stuck-as-questions-and-retire-stuck-lock-state`) this collapses to a
 * single value: `active` = the in-flight hold. The formerly-second value
 * `stuck` (needs-attention) is RETIRED — a bounce now SURFACES a question
 * sidecar + `needsAnswers:true` on `<arbiter>/main` and RELEASES the lock, so a
 * parked item is a `needsAnswers:true` pool item on `main`, NEVER a `stuck`
 * lock. The `state` field is kept (single-value) so serialised entries continue
 * to round-trip and downstream readers still see a stable shape. The `reason`
 * and `questions` fields that USED to ride on a `stuck` entry are gone — that
 * prose lives on the surfaced sidecar on `main`, not on the lock entry.
 */
export type LockState = 'active';

/**
 * The lock entry: `action` × `state` (the state axis is now degenerate — see
 * {@link LockState}) plus the holder/since stamps. Post-CONTRACT step (task
 * `retire-stuck-lock-state`) it carries NO `reason`/`questions` — the sole
 * parked-item mechanism is the surfaced `needsAnswers:true` sidecar on
 * `<arbiter>/main`.
 */
export interface LockEntry {
	entry: string;
	action: LockAction;
	state: LockState;
	holder: string;
	since: string;
}

/** Outcome of an acquire attempt. `acquired` = we hold it; `lost` = someone else
 * does (a genuine same-item conflict). `error` = environment/usage. */
export type AcquireOutcome = 'acquired' | 'lost' | 'error';
export type ReleaseOutcome = 'released' | 'not-held' | 'error';

export interface AcquireResult {
	outcome: AcquireOutcome;
	/** The type-encoded lock entry (`<type>-<slug>`) the acquire keyed onto. */
	entry: string;
	ref: string;
	message: string;
}
export interface ReleaseResult {
	outcome: ReleaseOutcome;
	/** The type-encoded lock entry (`<type>-<slug>`) the release keyed onto. */
	entry: string;
	ref: string;
	message: string;
}

/**
 * Outcome of an AMEND-style transition (resume-crash-orphan / requeue) — the
 * lock-entry STATE MACHINE's interior moves. Post-CONTRACT step (task
 * `retire-stuck-lock-state`) the `mark-stuck` transition + the `wrong-state`
 * verdict are retired with the `stuck` state itself.
 *   - `transitioned` — we won the CAS; the entry is now at the target state
 *                      (or removed, for requeue).
 *   - `not-held`     — there is no entry to transition (the move's precondition
 *                      is a held entry; absent ⇒ illegal here).
 *   - `lost`         — the leased CAS was rejected because a CONCURRENT writer
 *                      changed the ref between our read and our push (a genuine
 *                      same-item race).
 *   - `error`        — environment/usage (missing item, …).
 */
export type TransitionOutcome = 'transitioned' | 'not-held' | 'lost' | 'error';

export interface TransitionResult {
	outcome: TransitionOutcome;
	/** The type-encoded lock entry (`<type>-<slug>`) the transition keyed onto. */
	entry: string;
	ref: string;
	message: string;
	/** The lock entry AFTER a successful `transitioned` (absent for requeue's removal). */
	lock?: LockEntry;
}

function gitSoft(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<RunResult> {
	return runAsync('git', args, cwd, {env});
}
async function gitHard(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<RunResult> {
	const r = await runAsync('git', args, cwd, {env});
	if (r.status !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed (exit ${r.status}): ${r.stderr.trim()}`,
		);
	}
	return r;
}

/**
 * Serialise a lock entry to the ref's blob body (markdown frontmatter, like the
 * advancing marker, so it round-trips and is previewable). Post-CONTRACT step
 * (task `retire-stuck-lock-state`) the body carries ONLY the identity block —
 * no `## Reason` / `## Questions` sections, because the retired `stuck` state
 * was the only state that populated them. {@link parseLockEntry} is the inverse
 * and tolerates a legacy body with those headings by ignoring them.
 */
export function serialiseLockEntry(e: LockEntry): string {
	return [
		'---',
		`entry: ${e.entry}`,
		`action: ${e.action}`,
		`state: ${e.state}`,
		`holder: ${e.holder}`,
		`since: ${e.since}`,
		'---',
		'',
		`Lock held for \`${e.entry}\` (${e.action}/${e.state}).`,
		'',
	].join('\n');
}

/**
 * Build a PARENTLESS commit whose tree contains the single lock-entry blob, and
 * return its sha. Parentless (no `-p`) so it is decoupled from `main` and becomes
 * unreachable the instant the ref is deleted (gc reclaims it). Uses plumbing
 * (`hash-object` → `mktree` → `commit-tree`), never the working tree/index/HEAD,
 * so it is safe to call from any worktree.
 */
async function buildLockCommit(
	entry: LockEntry,
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<string> {
	const body = serialiseLockEntry(entry);
	const blob = (
		await gitHardInput(['hash-object', '-w', '--stdin'], cwd, env, body)
	).stdout.trim();
	// One tree entry: `lock.md` → the blob.
	const treeInput = `100644 blob ${blob}\tlock.md\n`;
	const tree = (
		await gitHardInput(['mktree'], cwd, env, treeInput)
	).stdout.trim();
	const message = `lock: ${entry.entry} (${entry.action}/${entry.state})`;
	// PARENTLESS commit (no -p): the lock graph never joins main's history.
	const commit = (
		await gitHard(['commit-tree', tree, '-m', message], cwd, env)
	).stdout.trim();
	return commit;
}

/** `gitHard` variant that pipes `input` to stdin (for hash-object/mktree). */
async function gitHardInput(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
	input: string,
): Promise<RunResult> {
	const r = await runAsync('git', args, cwd, {env, input});
	if (r.status !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed (exit ${r.status}): ${r.stderr.trim()}`,
		);
	}
	return r;
}
export interface AcquireOptions {
	/**
	 * The NAMESPACED item identity to lock (`task:<slug>` / `spec:<slug>` /
	 * `observation:<slug>` / `obs:<slug>`, or a bare `<slug>` = task). Resolved to
	 * the type-encoded lock `<entry>` through {@link lockEntryFor}.
	 */
	item: string;
	action: LockAction;
	cwd: string;
	arbiter?: string;
	holder?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * Acquire the per-item lock atomically: build a parentless lock commit and push it
 * to `refs/dorfl/lock/<entry>` with `--force-with-lease=<ref>:` (the EMPTY
 * expected value = create-only). The arbiter accepts ONLY if the ref is still
 * absent. A racer who lost finds the ref present → its lease fails → `lost`. No
 * retry loop: a rejection here is a GENUINE same-item conflict, not false
 * contention.
 */
export async function acquireItemLock(
	opts: AcquireOptions,
): Promise<AcquireResult> {
	const arbiter = opts.arbiter ?? 'origin';
	const env = opts.env;
	const cwd = opts.cwd;
	if (!opts.item) {
		return {outcome: 'error', entry: '', ref: '', message: 'missing item'};
	}
	const entry = lockEntryFor(opts.item);
	const ref = itemLockRef(entry);
	try {
		// Fetch the current lock refs (PRUNED) so the lease sees the real arbiter
		// state — `--prune` keeps the local `refs/dorfl/lock/*` namespace from
		// accumulating refs the arbiter has deleted (observation
		// `gc-ledger-reports-mirror-stale-lock-refs-as-arbiter-state`).
		await gitHard(
			[
				'fetch',
				'--prune',
				'--quiet',
				arbiter,
				`+${LOCK_REF_PREFIX}/*:${LOCK_REF_PREFIX}/*`,
			],
			cwd,
			env,
		);
		const holder = opts.holder ?? (await resolveHolder(cwd, env));
		const commit = await buildLockCommit(
			{
				entry,
				action: opts.action,
				state: 'active',
				holder,
				since: new Date().toISOString(),
			},
			cwd,
			env,
		);
		// CREATE-ONLY push: --force-with-lease=<ref>: (empty) succeeds iff ref absent.
		const push = await gitSoft(
			['push', arbiter, `${commit}:${ref}`, `--force-with-lease=${ref}:`],
			cwd,
			env,
		);
		if (push.status === 0) {
			return {outcome: 'acquired', entry, ref, message: `locked ${entry}`};
		}
		// Rejected: the ref already exists (held by someone for the SAME item).
		return {
			outcome: 'lost',
			entry,
			ref,
			message: `'${entry}' is already locked (held by another). Back off.`,
		};
	} catch (err) {
		return {
			outcome: 'error',
			entry,
			ref,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

export interface ReleaseOptions {
	/** The NAMESPACED item identity (same forms as {@link AcquireOptions.item}). */
	item: string;
	cwd: string;
	arbiter?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * Release the per-item lock by DELETING the ref (`git push <arbiter>
 * :refs/dorfl/lock/<entry>`). Deleting (not emptying) is what makes the
 * lock set self-cleaning: a released item has NO ref, and its parentless commit
 * becomes unreachable for gc. Idempotent: deleting an absent ref is `not-held`.
 */
export async function releaseItemLock(
	opts: ReleaseOptions,
): Promise<ReleaseResult> {
	if (!opts.item) {
		return {outcome: 'error', entry: '', ref: '', message: 'missing item'};
	}
	return releaseLockEntry(
		lockEntryFor(opts.item),
		opts.cwd,
		opts.arbiter ?? 'origin',
		opts.env,
	);
}

/**
 * The ONE entry-keyed release core shared by BOTH the item-form path
 * ({@link releaseItemLock}, which derives the `<entry>` through the namespace
 * mapping) AND the LITERAL escape hatch ({@link releaseLiteralLockEntry}, which
 * takes the `<entry>` verbatim). It fetches the lock refs, checks the ref, and
 * performs the SAME leased delete (`--force-with-lease=<ref>:<cur>`) with the SAME
 * `not-held` / `released` / `error` semantics — there is deliberately NO second
 * delete mechanism (task `release-lock-entry-escape-hatch-and-literal-entry-reporting`).
 * The ONLY difference between the two callers is HOW the `<entry>` is obtained.
 */
async function releaseLockEntry(
	entry: string,
	cwd: string,
	arbiter: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<ReleaseResult> {
	const ref = itemLockRef(entry);
	try {
		// `--prune` so a lock already released on the arbiter reads as not-held
		// (its stale local ref is pruned) rather than as a phantom hold
		// (observation `gc-ledger-reports-mirror-stale-lock-refs-as-arbiter-state`).
		await gitHard(
			[
				'fetch',
				'--prune',
				'--quiet',
				arbiter,
				`+${LOCK_REF_PREFIX}/*:${LOCK_REF_PREFIX}/*`,
			],
			cwd,
			env,
		);
		const held =
			(await gitSoft(['rev-parse', '--verify', '--quiet', ref], cwd, env))
				.status === 0;
		if (!held) {
			return {
				outcome: 'not-held',
				entry,
				ref,
				message: `'${entry}' not locked`,
			};
		}
		// Delete the ref on the arbiter. Lease on the current value guards against a
		// concurrent change between our fetch and the delete.
		const cur = (await gitHard(['rev-parse', ref], cwd, env)).stdout.trim();
		const del = await gitSoft(
			['push', arbiter, '--delete', ref, `--force-with-lease=${ref}:${cur}`],
			cwd,
			env,
		);
		if (del.status === 0) {
			// Drop our local copy of the ref too (best-effort).
			await gitSoft(['update-ref', '-d', ref], cwd, env);
			return {outcome: 'released', entry, ref, message: `released ${entry}`};
		}
		return {
			outcome: 'error',
			entry,
			ref,
			message: `release push rejected: ${del.stderr.trim()}`,
		};
	} catch (err) {
		return {
			outcome: 'error',
			entry,
			ref,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

export interface ReleaseLiteralOptions {
	/**
	 * The LITERAL lock-entry name (`<type>-<slug>`, or a pre-cutover
	 * `slice-<slug>` / `prd-<slug>`) to release VERBATIM — taken as-is, bypassing
	 * the namespace mapping {@link lockEntryFor} applies. MUST pass
	 * {@link isValidLockEntryName}.
	 */
	entry: string;
	cwd: string;
	arbiter?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * The `release-lock --entry <literal>` ESCAPE HATCH (task
 * `release-lock-entry-escape-hatch-and-literal-entry-reporting`): release a lock
 * whose `<entry>` name is NOT derivable from any CURRENT item-form — a lock minted
 * BEFORE the slice→task / `prd-to-spec` vocabulary cutover (`slice-<slug>`,
 * `prd-<slug>`), which the item-form path can no longer name because there is no
 * item-form that produces those entries anymore.
 *
 * It takes the `<entry>` LITERALLY (bypassing {@link lockEntryFor} /
 * {@link resolveSidecarIdentity}, the namespace mapping the item-form path uses)
 * and targets `refs/dorfl/lock/<entry>` directly, then reuses the SAME entry-keyed
 * leased-delete core {@link releaseItemLock} uses ({@link releaseLockEntry}) — the
 * SAME lock-lease acquisition, push, absent-is-success no-op, exit codes, and
 * mirror handling. There is NO second delete path.
 *
 * The trust model is UNCHANGED: a human still asserts the lock is dead by NAMING
 * it; the only thing `--entry` drops is the assumption that the entry name is
 * derivable from a current item-form. Rejects (`error`) an `<entry>` that fails
 * {@link isValidLockEntryName} BEFORE any git operation, so a literal can never
 * escape the `refs/dorfl/lock/` namespace.
 */
export async function releaseLiteralLockEntry(
	opts: ReleaseLiteralOptions,
): Promise<ReleaseResult> {
	const entry = opts.entry ?? '';
	if (!isValidLockEntryName(entry)) {
		return {
			outcome: 'error',
			entry,
			ref: '',
			message: `invalid --entry '${entry}': a lock-entry name must be a non-empty run of [A-Za-z0-9._-] (no slashes, no whitespace) so it cannot escape the ${LOCK_REF_PREFIX}/ namespace.`,
		};
	}
	return releaseLockEntry(entry, opts.cwd, opts.arbiter ?? 'origin', opts.env);
}

/** Outcome of a GUARDED release ({@link releaseHeldItemLock}): the caller HELD the
 * lock, so an absent ref is NOT benign — it is `vanished` (the ref was deleted
 * under us, an abort signal). */
export type ReleaseHeldOutcome = 'released' | 'vanished' | 'error';

export interface ReleaseHeldResult {
	outcome: ReleaseHeldOutcome;
	/** The type-encoded lock entry (`<type>-<slug>`) the release keyed onto. */
	entry: string;
	ref: string;
	message: string;
}

/**
 * GUARDED release for a runner that KNOWS it acquired and HELD the lock (spec
 * `ledger-status-per-item-lock-refs` US #13): unlike {@link releaseItemLock} —
 * whose `not-held` is a BENIGN idempotent case the complete/tasking/needs-attention
 * callers tolerate (the body may predate the lock, or a crash-recovery may have
 * already cleared it) — here the absence of OUR ref is an ABORT SIGNAL. A held
 * runner whose own lock VANISHED mid-build (someone `release-lock`-ed it, or a
 * `gc`/recovery cleared it) must DETECT it on release and route to
 * needs-attention rather than silently "clean-release" a lock it no longer holds:
 * the work it just did was NOT protected by the exclusion it thought it had.
 *
 * So this maps {@link releaseItemLock}'s `not-held` to a DISTINCT `vanished`
 * outcome the caller branches on (abort / needs-attention), while a genuine
 * `released` is the happy path and `error` stays `error`. It is otherwise the
 * SAME leased delete (no second mechanism): a clean `released` deletes the ref we
 * held. Use this ONLY where the caller provably HELD the lock (the in-flight
 * runner's own release); the tolerant idempotent callers keep using
 * {@link releaseItemLock}.
 */
export async function releaseHeldItemLock(
	opts: ReleaseOptions,
): Promise<ReleaseHeldResult> {
	const rel = await releaseItemLock(opts);
	if (rel.outcome === 'not-held') {
		return {
			outcome: 'vanished',
			entry: rel.entry,
			ref: rel.ref,
			message: `'${rel.entry}' lock VANISHED before our release (the ref is gone) — our hold was lost mid-build; abort / route to needs-attention rather than clean-release.`,
		};
	}
	return {
		outcome: rel.outcome,
		entry: rel.entry,
		ref: rel.ref,
		message: rel.message,
	};
}

/**
 * Fetch the lock refs and return the held entry + its current ref sha, or
 * `undefined` when the item is at REST (no ref). Shared read-before-CAS step for
 * the amend-style transitions (mark-stuck / resume / requeue): they all need BOTH
 * the current entry (to check the state precondition + carry forward `action` /
 * `holder` / `since`) and the current sha (to lease the CAS on it).
 */
async function fetchHeldEntry(
	entry: string,
	ref: string,
	cwd: string,
	arbiter: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<{lock: LockEntry; sha: string} | undefined> {
	// `--prune` so a lock RELEASED on the arbiter (its ref deleted there) is PRUNED
	// locally — otherwise the stale local ref survives and `rev-parse`/`show` below
	// read it as still held (observation
	// `gc-ledger-reports-mirror-stale-lock-refs-as-arbiter-state`).
	await gitHard(
		[
			'fetch',
			'--prune',
			'--quiet',
			arbiter,
			`+${LOCK_REF_PREFIX}/*:${LOCK_REF_PREFIX}/*`,
		],
		cwd,
		env,
	);
	const rev = await gitSoft(
		['rev-parse', '--verify', '--quiet', ref],
		cwd,
		env,
	);
	if (rev.status !== 0 || rev.stdout.trim() === '') {
		return undefined;
	}
	const sha = rev.stdout.trim();
	const show = await gitSoft(['show', `${ref}:lock.md`], cwd, env);
	const lock = show.status === 0 ? parseLockEntry(show.stdout) : undefined;
	if (!lock) {
		return undefined;
	}
	return {lock, sha};
}

/**
 * AMEND the held entry in place via a leased CAS: build a NEW parentless commit
 * carrying `next` and push it to the SAME ref with `--force-with-lease=<ref>:<sha>`
 * (the sha we just read). The arbiter accepts ONLY if the ref is unchanged since
 * our read — a concurrent writer who moved it makes our lease fail (`lost`). No
 * retry loop: a rejection is a genuine same-item race the caller should lose.
 */
async function amendHeldEntry(
	next: LockEntry,
	ref: string,
	expectedSha: string,
	cwd: string,
	arbiter: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<TransitionResult> {
	const commit = await buildLockCommit(next, cwd, env);
	const push = await gitSoft(
		[
			'push',
			arbiter,
			`${commit}:${ref}`,
			`--force-with-lease=${ref}:${expectedSha}`,
		],
		cwd,
		env,
	);
	if (push.status === 0) {
		// Move our local copy to the new commit too (best-effort) so a subsequent
		// read in the same clone sees the amended entry without a refetch.
		await gitSoft(['update-ref', ref, commit], cwd, env);
		return {
			outcome: 'transitioned',
			entry: next.entry,
			ref,
			message: `${next.entry} → ${next.action}/${next.state}`,
			lock: next,
		};
	}
	return {
		outcome: 'lost',
		entry: next.entry,
		ref,
		message: `'${next.entry}' lock changed concurrently (CAS lost). Back off.`,
	};
}

/** Verdict of the SHARED leased delete {@link leasedDeleteLockRef}: `deleted` (the
 * ref was removed), `lost` (a concurrent change moved the ref between the read and
 * the delete — the lease was REJECTED, never `--force`d), or `error`. */
export type LeasedDeleteOutcome = 'deleted' | 'lost' | 'error';

/**
 * The ONE leased-delete CLEAR path shared by every code path that removes a held
 * lock ref by lease (the recovery {@link reconcileItemLockAgainstMain}, the
 * human-invoked {@link reapStaleItemLocks} sweep, …): delete `ref` on the arbiter
 * with `--force-with-lease=<ref>:<expectedSha>`, so the arbiter accepts ONLY if the
 * ref is UNCHANGED since the caller read `expectedSha`. A concurrent writer who
 * moved the ref (e.g. a racer who just marked it `stuck`) makes the lease FAIL →
 * `lost` (reported, NEVER force-deleted). On success the local copy is dropped too
 * (best-effort). It is the SAME leased delete `release-lock` / requeue use — there
 * is no second clear mechanism.
 */
async function leasedDeleteLockRef(
	ref: string,
	expectedSha: string,
	cwd: string,
	arbiter: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<LeasedDeleteOutcome> {
	const del = await gitSoft(
		[
			'push',
			arbiter,
			'--delete',
			ref,
			`--force-with-lease=${ref}:${expectedSha}`,
		],
		cwd,
		env,
	);
	if (del.status !== 0) {
		return 'lost';
	}
	// Drop our local copy of the ref too (best-effort) so a subsequent read in the
	// same clone does not see the now-deleted lock.
	await gitSoft(['update-ref', '-d', ref], cwd, env);
	return 'deleted';
}

/**
 * COMPATIBILITY SHIM (post `retire-stuck-lock-state`): the `stuck` lock STATE
 * is retired — there is no `active → stuck` amend to perform any more, and no
 * live path calls this. It is kept exported as a NO-OP that returns success
 * (`transitioned` when a held entry is present, `not-held` otherwise) so
 * downstream test suites that USED to seed a "stuck" scenario via this
 * primitive continue to build. A shim'd `stuck` lock does NOT actually flip
 * state; the lock stays `active` (which is the only admitted state) and any
 * assertion that keys off `state === 'stuck'` is now vacuously false — the
 * point of the migration.
 */
export interface MarkStuckOptions {
	item: string;
	reason?: string;
	questions?: string[];
	cwd: string;
	arbiter?: string;
	env?: NodeJS.ProcessEnv;
}
export async function markStuckItemLock(
	opts: MarkStuckOptions,
): Promise<TransitionResult> {
	const arbiter = opts.arbiter ?? 'origin';
	const env = opts.env;
	const cwd = opts.cwd;
	if (!opts.item) {
		return {outcome: 'error', entry: '', ref: '', message: 'missing item'};
	}
	const entry = lockEntryFor(opts.item);
	const ref = itemLockRef(entry);
	try {
		const held = await fetchHeldEntry(entry, ref, cwd, arbiter, env);
		if (!held) {
			return {
				outcome: 'not-held',
				entry,
				ref,
				message: `'${entry}' not locked (mark-stuck is a no-op shim post retire-stuck-lock-state)`,
			};
		}
		return {
			outcome: 'transitioned',
			entry,
			ref,
			message: `'${entry}' left active (mark-stuck is a no-op shim post retire-stuck-lock-state; a parked item is now a needsAnswers:true sidecar on main)`,
			lock: held.lock,
		};
	} catch (err) {
		return {
			outcome: 'error',
			entry,
			ref,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

export interface ResumeOptions {
	/** The NAMESPACED item identity (same forms as {@link AcquireOptions.item}). */
	item: string;
	cwd: string;
	arbiter?: string;
	/** Optionally reassign the holder on resume (a human/continue picks it up). */
	holder?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * resume (crash-orphan recovery only, post `retire-stuck-lock-state`): with the
 * `stuck` lock state retired, the ONLY thing to "resume" is the crash-window
 * orphan the ordered bounce transition (surface-FIRST-release-SECOND) leaves
 * when the surface lands on `<arbiter>/main` but the release never runs. If the
 * held lock is `active` AND the item is SURFACED on `<arbiter>/main`
 * (`needsAnswers:true` + sidecar) AND not terminal, `main` is authoritative:
 * clear the ref via the SHARED leased delete (never `--force`) so the lock
 * converges rather than dangling forever. Every OTHER combination is a no-op
 * from this verb's perspective: an in-flight active hold that is NOT surfaced
 * is a healthy build (`wrong-state` — nothing to resume); no lock is
 * `not-held`. There is no `stuck → active` transition anymore: a parked item
 * is a `needsAnswers:true` pool item on `main`, drained by answering the
 * sidecar (via the apply rung), not by "resuming" a lock.
 */
export async function resumeItemLock(
	opts: ResumeOptions,
): Promise<TransitionResult> {
	const arbiter = opts.arbiter ?? 'origin';
	const env = opts.env;
	const cwd = opts.cwd;
	if (!opts.item) {
		return {outcome: 'error', entry: '', ref: '', message: 'missing item'};
	}
	const entry = lockEntryFor(opts.item);
	const ref = itemLockRef(entry);
	try {
		const held = await fetchHeldEntry(entry, ref, cwd, arbiter, env);
		if (!held) {
			return {
				outcome: 'not-held',
				entry,
				ref,
				message: `'${entry}' not locked`,
			};
		}
		const {type, slug} = resolveSidecarIdentity(opts.item);
		// Refresh `<arbiter>/main` so the surfaced-on-main probe reads the live
		// snapshot rather than a stale local tracking ref.
		await gitSoft(['fetch', '--quiet', arbiter], cwd, env);
		const terminalOnMain = await isTerminalOnMain(
			type,
			slug,
			arbiter,
			cwd,
			env,
		);
		if (
			!terminalOnMain &&
			(await isItemSurfacedOnMain(type, slug, opts.item, arbiter, cwd, env))
		) {
			const cleared = await leasedDeleteLockRef(
				ref,
				held.sha,
				cwd,
				arbiter,
				env,
			);
			if (cleared === 'deleted') {
				return {
					outcome: 'transitioned',
					entry,
					ref,
					message: `cleared the crash-window orphan lock for '${entry}' (item is SURFACED on ${arbiter}/main via needsAnswers + sidecar; the surface landed but the release never ran) — answer the question sidecar to drain it.`,
				};
			}
			return {
				outcome: 'lost',
				entry,
				ref,
				message: `'${entry}' crash-orphan clear lost the CAS race (concurrent writer); back off and re-run.`,
			};
		}
		return {
			outcome: 'not-held',
			entry,
			ref,
			message: `'${entry}' is active and not surfaced on ${arbiter}/main — nothing to resume (a healthy in-flight hold; a parked item is drained via its needsAnswers sidecar).`,
		};
	} catch (err) {
		return {
			outcome: 'error',
			entry,
			ref,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * requeue: give up on a held lock and return the item to the pool by REMOVING
 * the entry. Post-CONTRACT step (task `retire-stuck-lock-state`) there is NO
 * `stuck` state to guard against — the held lock is always `active`, so
 * requeue works on any held entry (a leased delete; a concurrent change ⇒
 * `lost`). The body never moved (it rests in the pool on `main`), so requeue
 * is purely "release the lock"; the kept `work/<slug>` branch remains for
 * recovery.
 */
export async function requeueItemLock(
	opts: ReleaseOptions,
): Promise<TransitionResult> {
	const arbiter = opts.arbiter ?? 'origin';
	const env = opts.env;
	const cwd = opts.cwd;
	if (!opts.item) {
		return {outcome: 'error', entry: '', ref: '', message: 'missing item'};
	}
	const entry = lockEntryFor(opts.item);
	const ref = itemLockRef(entry);
	try {
		const held = await fetchHeldEntry(entry, ref, cwd, arbiter, env);
		if (!held) {
			return {
				outcome: 'not-held',
				entry,
				ref,
				message: `'${entry}' not locked`,
			};
		}
		const del = await gitSoft(
			[
				'push',
				arbiter,
				'--delete',
				ref,
				`--force-with-lease=${ref}:${held.sha}`,
			],
			cwd,
			env,
		);
		if (del.status === 0) {
			await gitSoft(['update-ref', '-d', ref], cwd, env);
			return {
				outcome: 'transitioned',
				entry,
				ref,
				message: `requeued ${entry} (lock released, body still in pool)`,
			};
		}
		return {
			outcome: 'lost',
			entry,
			ref,
			message: `'${entry}' lock changed concurrently (CAS lost). Back off.`,
		};
	} catch (err) {
		return {
			outcome: 'error',
			entry,
			ref,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Read the current lock entry for an item from the arbiter (the `status`/`scan`
 * read path): fetch the lock refs, read `lock.md` from the ref's tree. Returns
 * `undefined` when the item is not locked.
 */
export async function readItemLock(
	opts: ReleaseOptions,
): Promise<LockEntry | undefined> {
	const arbiter = opts.arbiter ?? 'origin';
	const env = opts.env;
	const cwd = opts.cwd;
	const ref = itemLockRef(lockEntryFor(opts.item));
	// `--prune` so a lock RELEASED on the arbiter (its ref deleted there) is PRUNED
	// locally — otherwise the stale local `refs/dorfl/lock/<entry>` would survive
	// and `git show <ref>:lock.md` below would read it as still held (observation
	// `gc-ledger-reports-mirror-stale-lock-refs-as-arbiter-state`). After the prune,
	// a released lock's ref is gone locally ⇒ `show` fails ⇒ `undefined` (not locked).
	await gitHard(
		[
			'fetch',
			'--prune',
			'--quiet',
			arbiter,
			`+${LOCK_REF_PREFIX}/*:${LOCK_REF_PREFIX}/*`,
		],
		cwd,
		env,
	);
	const show = await gitSoft(['show', `${ref}:lock.md`], cwd, env);
	if (show.status !== 0) {
		return undefined;
	}
	return parseLockEntry(show.stdout);
}

/**
 * The DURABLE-`main` terminal record paths for an item, by its type — the
 * authoritative resting records the cross-substrate reconciliation reads. An
 * item is TERMINAL on `main` iff ANY of these paths exists on `<arbiter>/main`.
 * The won't-proceed terminal is PER-REGIME (the slug-collision correctness fix:
 * a dropped task and a dropped spec sharing a slug used to collide on one
 * bare-slug `work/dropped/<slug>.md`):
 *   - a TASK: `work/tasks/done/<slug>.md` (completed) OR
 *     `work/tasks/cancelled/<slug>.md` (the task regime's won't-proceed terminal).
 *   - a SPEC: `work/specs/tasked/<slug>.md` (tasked) OR `work/specs/dropped/<slug>.md`
 *     (the spec regime's won't-proceed terminal).
 *   - an OBSERVATION: NONE. A note has no durable terminal folder — it leaves by
 *     deletion (its absence, not a terminal record, is the end state). A promoted
 *     observation becomes a NEW task/spec with its own ref.
 */
export function terminalMainPaths(type: SidecarType, slug: string): string[] {
	const file = `${slug}.md`;
	switch (type) {
		case 'task':
			return [workItemRel('done', file), workItemRel('cancelled', file)];
		// The parent-spec regime's durable terminals (`specs/tasked` tasked,
		// `specs/dropped` won't-proceed) — a `spec:<slug>` lock resolves to these
		// `work/specs/*` records.
		case 'spec':
			return [
				workItemRel('specs-tasked', file),
				workItemRel('specs-dropped', file),
			];
		case 'observation':
			return [];
	}
}

/** The outcome of a cross-substrate reconciliation of one item's lock against
 * the authoritative `main` durable record (spec `ledger-status-per-item-lock-refs`
 * US #9/#10; ADR `ledger-status-on-per-item-lock-refs`). Post-CONTRACT step
 * (task `retire-stuck-lock-state`) the two `stuck`-flavoured outcomes
 * (`cleared-stuck-terminal`, `kept-stuck`) are gone with the state itself; a
 * parked item is now a `needsAnswers:true` pool item on `main`, so the
 * `cleared-stale` verdict now ALSO covers the crash-window orphan (active +
 * surfaced-on-main). */
export type ReconcileOutcome =
	| 'cleared-stale' // `main` is terminal OR surfaced-on-main + the lock was `active` (stranded/orphan) → cleared
	| 'kept-in-flight' // `main` is NOT terminal + a lock is held `active` → the normal in-flight state, kept
	| 'no-lock' // there is no lock to reconcile (already at rest)
	| 'error'; // environment/usage problem (best-effort; never throws)

export interface ReconcileResult {
	outcome: ReconcileOutcome;
	/** The type-encoded lock entry (`<type>-<slug>`) reconciled. */
	entry: string;
	ref: string;
	/** Whether `<arbiter>/main` shows the item terminal (per {@link terminalMainPaths}:
	 * a task at `tasks/done`/`tasks/cancelled`, a spec at `specs/tasked`/`specs/dropped`). */
	terminalOnMain: boolean;
	message: string;
}

/**
 * Reconcile ONE item's per-item lock against the AUTHORITATIVE `main` durable
 * record — the heart of complete's cross-substrate crash-safety (spec
 * `ledger-status-per-item-lock-refs` US #9/#10; ADR
 * `ledger-status-on-per-item-lock-refs`; the design trail's Amendment 6).
 *
 * complete's order is hold lock → land the DURABLE `main` move FIRST → release
 * the lock SECOND. A crash BETWEEN the move and the release leaves a
 * terminal-on-`main` item (a completed/cancelled task or a tasked/dropped spec,
 * per {@link terminalMainPaths}) with a STILL-HELD lock — a stale lock with no
 * in-flight work behind it. This is the recovery that converges it.
 *
 * THE RECOVERY RULE (the `main` record is authoritative over an ORPHAN lock,
 * broadened by task `reaper-reap-terminal-stuck-lock-orphans`; ADR
 * `ledger-status-on-per-item-lock-refs` § Addendum 2026-07-10):
 *   - `main` is TERMINAL + the held lock is `active` → STRANDED (the crash was
 *     after the durable move, before the release) → CLEAR it (`cleared-stale`).
 *   - `main` is TERMINAL + the held lock is `stuck`  → CRASH-ORPHAN (`done` +
 *     `stuck` LEGITIMATELY co-existed during a rebase-conflict bounce, US #10,
 *     but the item then reached its terminal folder by ANY path — human finish,
 *     re-drive, manual fixup+merge — leaving the stuck lock as an orphan the
 *     `main` record supersedes) → CLEAR it (`cleared-stuck-terminal`).
 *   - `main` is NOT terminal + the held lock is `stuck` → the GENUINE
 *     human-attention case (`kept-stuck`); NEVER auto-cleared here (a human
 *     resolves via `resume`/`requeue`/`release-lock`). This is the invariant
 *     the contract loosening MUST preserve.
 *   - `main` is NOT terminal + the held lock is `active` → the NORMAL in-flight
 *     state (`kept-in-flight`); the lock is doing its job, leave it.
 *   - no lock at all                                     → `no-lock` (at rest).
 *
 * Best-effort + idempotent: it NEVER throws (a fetch/read fault degrades to
 * `error`, leaving the lock untouched — the safe direction), and re-running it
 * on an already-reconciled item is a clean `no-lock`. The clear is the SAME
 * leased delete {@link releaseItemLock} uses, so it cannot race off a concurrent
 * change.
 *
 * BROADENED CONTRACT (leased-delete-rejection arm, task
 * `reaper-no-lock-outcome-benign-not-lost`, promote-slice follow-up
 * `reconcile-item-lock-broadened-contract-audit`, review 2026-06-20): when the
 * SHARED leased delete is REJECTED (the arbiter ref moved between our read and
 * our write) this function performs an EXTRA `git ls-remote <arbiter> <ref>`
 * round-trip to distinguish the two rejection sub-cases, and applies to ALL
 * callers — NOT only the reaper:
 *   - REMOTE REF IS EMPTY (a concurrent reaper / release-lock / requeue cleared
 *     the SAME stale lock first): the desired end state — benign. This function
 *     ALSO `git update-ref -d`s the LOCAL stale tracking ref as a SIDE-EFFECT
 *     (so a subsequent read in this clone sees the correct deleted state; a
 *     non-pruning fetch would otherwise leave a dangling local ref), then
 *     returns `no-lock`. Note the outcome-shape change: this rejection USED TO
 *     surface as `error` — it now surfaces as `no-lock` for EVERY caller. A
 *     caller that keys recovery / surfacing off `error` on this arm must be
 *     audited (see the follow-up task's `## Decisions` block).
 *   - REMOTE REF STILL EXISTS AT A DIFFERENT SHA (a genuine concurrent mutation
 *     — e.g. a racer just marked it `stuck`): back off rather than force —
 *     `error`.
 * Because the function name reads "reconcile" (read-style), the local
 * `update-ref -d` is a deliberate SIDE-EFFECT on the local clone's refs — it
 * only fires on this specific rejection arm and is otherwise invisible.
 */
export async function reconcileItemLockAgainstMain(
	opts: ReleaseOptions,
): Promise<ReconcileResult> {
	const arbiter = opts.arbiter ?? 'origin';
	const env = opts.env;
	const cwd = opts.cwd;
	if (!opts.item) {
		return {
			outcome: 'error',
			entry: '',
			ref: '',
			terminalOnMain: false,
			message: 'missing item',
		};
	}
	const {type, slug} = resolveSidecarIdentity(opts.item);
	const entry = lockEntryFor(opts.item);
	const ref = itemLockRef(entry);
	try {
		// One fetch refreshes BOTH the lock refs and `<arbiter>/main` so the lock and
		// the durable record are read from the SAME live arbiter snapshot. `--prune`
		// keeps the local lock namespace from accumulating refs the arbiter deleted
		// (observation `gc-ledger-reports-mirror-stale-lock-refs-as-arbiter-state`).
		await gitHard(
			[
				'fetch',
				'--prune',
				'--quiet',
				arbiter,
				`+${LOCK_REF_PREFIX}/*:${LOCK_REF_PREFIX}/*`,
			],
			cwd,
			env,
		);
		await gitHard(['fetch', '--quiet', arbiter], cwd, env);

		const held = await fetchHeldEntry(entry, ref, cwd, arbiter, env);
		const terminalOnMain = await isTerminalOnMain(
			type,
			slug,
			arbiter,
			cwd,
			env,
		);
		if (!held) {
			return {
				outcome: 'no-lock',
				entry,
				ref,
				terminalOnMain,
				message: `'${entry}' has no lock to reconcile`,
			};
		}
		if (!terminalOnMain) {
			// Post-`retire-stuck-lock-state`: the held lock is ALWAYS `active`. The
			// split is now solely on whether the item is SURFACED on `<arbiter>/main`
			// (`needsAnswers:true` + sidecar):
			//   - surfaced   ⇒ the CRASH-WINDOW ORPHAN the ordered bounce transition
			//     (surface-FIRST-release-SECOND) leaves when step 1 lands but step 2
			//     never runs. `main` is authoritative — CLEAR via the SHARED leased
			//     delete (`cleared-stale`).
			//   - not surfaced ⇒ the NORMAL in-flight hold (`kept-in-flight`).
			const surfaced = await isItemSurfacedOnMain(
				type,
				slug,
				opts.item,
				arbiter,
				cwd,
				env,
			);
			if (surfaced) {
				const cleared = await leasedDeleteLockRef(
					ref,
					held.sha,
					cwd,
					arbiter,
					env,
				);
				if (cleared === 'deleted') {
					return {
						outcome: 'cleared-stale',
						entry,
						ref,
						terminalOnMain,
						message: `cleared the crash-window orphan lock for '${entry}' (item is SURFACED on ${arbiter}/main via needsAnswers:true + sidecar; the surface landed but the release never ran)`,
					};
				}
				// Leased delete rejected: fall through to the shared rejection
				// arm below (same distinguish-then-report shape).
				const remote = await gitSoft(['ls-remote', arbiter, ref], cwd, env);
				const remoteEmpty = remote.status === 0 && remote.stdout.trim() === '';
				if (remoteEmpty) {
					await gitSoft(['update-ref', '-d', ref], cwd, env);
					return {
						outcome: 'no-lock',
						entry,
						ref,
						terminalOnMain,
						message: `'${entry}' has no lock to reconcile (already cleared by another reaper / release-lock / requeue)`,
					};
				}
				return {
					outcome: 'error',
					entry,
					ref,
					terminalOnMain,
					message: `crash-orphan clear for '${entry}' rejected (changed concurrently to a different value); a racer may have moved the ref. Re-run after re-checking.`,
				};
			}
			return {
				outcome: 'kept-in-flight',
				entry,
				ref,
				terminalOnMain,
				message: `'${entry}' is in flight (held, not terminal on ${arbiter}/main)`,
			};
		}
		// Terminal on `main` + a held (active) lock = an ORPHAN over a
		// durably-completed item. Clear via the SHARED leased delete.
		const cleared = await leasedDeleteLockRef(ref, held.sha, cwd, arbiter, env);
		if (cleared === 'deleted') {
			return {
				outcome: 'cleared-stale',
				entry,
				ref,
				terminalOnMain,
				message: `cleared the stale lock for '${entry}' (terminal on ${arbiter}/main; the durable record is authoritative)`,
			};
		}
		// The leased delete was REJECTED. Distinguish two sub-cases at the recovery
		// boundary so callers (the reaper) can route them differently:
		//   (a) the remote ref is ALREADY GONE — a concurrent reaper / release-lock /
		//       requeue cleared the SAME stale lock first. The desired end state;
		//       benign — we report `no-lock` (the existing "already at rest" verdict).
		//   (b) the remote ref still exists but at a DIFFERENT sha than we leased
		//       against — a genuine concurrent mutation (e.g. a racer just marked it
		//       `stuck`). Back off rather than force; this is the real `error`.
		const remote = await gitSoft(['ls-remote', arbiter, ref], cwd, env);
		const remoteEmpty = remote.status === 0 && remote.stdout.trim() === '';
		if (remoteEmpty) {
			// Drop our stale local copy too — a non-pruning fetch left it pointing at
			// the now-gone sha; with it gone locally a subsequent read in this clone
			// sees the correct (deleted) state.
			await gitSoft(['update-ref', '-d', ref], cwd, env);
			return {
				outcome: 'no-lock',
				entry,
				ref,
				terminalOnMain,
				message: `'${entry}' has no lock to reconcile (already cleared by another reaper / release-lock / requeue)`,
			};
		}
		return {
			outcome: 'error',
			entry,
			ref,
			terminalOnMain,
			message: `stale-lock clear for '${entry}' rejected (changed concurrently to a different value); a racer may have moved the ref. Re-run after re-checking.`,
		};
	} catch (err) {
		return {
			outcome: 'error',
			entry,
			ref,
			terminalOnMain: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * The READ-ONLY classifier behind {@link reconcileItemLockAgainstMain}: it derives
 * the SAME {@link ReconcileOutcome} verdict, but NEVER mutates the arbiter — it
 * does NOT clear a stale-active lock, it only REPORTS that the lock IS
 * reconcilable. This is what the `gc --ledger` stuck-lock report keys off (the
 * forward-pointer's wiring): per the no-auto-sweep ADR rule, the plain report
 * surfaces a stale-active lock as `cleared-stale`-eligible WITHOUT clearing it —
 * a human still asserts the clear via `release-lock` (or runs complete's recovery,
 * which DOES clear via {@link reconcileItemLockAgainstMain}). The classification
 * is identical so the report and the recovery never disagree about WHAT a lock is;
 * only the ACTION differs (report vs clear).
 *
 * A `cleared-stale` outcome here therefore means "would be cleared by recovery /
 * `release-lock`" (the lock is terminal-on-`main` + `active` = stale), NOT that
 * anything was cleared. Best-effort + never throws (a fetch/read fault degrades to
 * `error`).
 */
export async function classifyItemLockAgainstMain(
	opts: ReleaseOptions,
): Promise<ReconcileResult> {
	const arbiter = opts.arbiter ?? 'origin';
	const env = opts.env;
	const cwd = opts.cwd;
	if (!opts.item) {
		return {
			outcome: 'error',
			entry: '',
			ref: '',
			terminalOnMain: false,
			message: 'missing item',
		};
	}
	const {type, slug} = resolveSidecarIdentity(opts.item);
	const entry = lockEntryFor(opts.item);
	const ref = itemLockRef(entry);
	try {
		// `--prune` keeps the local lock namespace from accumulating refs the
		// arbiter deleted (observation `gc-ledger-reports-mirror-stale-lock-refs-as-arbiter-state`).
		await gitHard(
			[
				'fetch',
				'--prune',
				'--quiet',
				arbiter,
				`+${LOCK_REF_PREFIX}/*:${LOCK_REF_PREFIX}/*`,
			],
			cwd,
			env,
		);
		await gitHard(['fetch', '--quiet', arbiter], cwd, env);
		const held = await fetchHeldEntry(entry, ref, cwd, arbiter, env);
		const terminalOnMain = await isTerminalOnMain(
			type,
			slug,
			arbiter,
			cwd,
			env,
		);
		if (!held) {
			return {
				outcome: 'no-lock',
				entry,
				ref,
				terminalOnMain,
				message: `'${entry}' has no lock to reconcile`,
			};
		}
		if (!terminalOnMain) {
			// Post-`retire-stuck-lock-state`: the held lock is ALWAYS `active`. If the
			// item is SURFACED on `<arbiter>/main` (`needsAnswers:true` + sidecar),
			// the lock is a CRASH-WINDOW ORPHAN (reconcilable, NOT auto-cleared by
			// the report); otherwise it is the normal in-flight hold.
			const surfaced = await isItemSurfacedOnMain(
				type,
				slug,
				opts.item,
				arbiter,
				cwd,
				env,
			);
			if (surfaced) {
				return {
					outcome: 'cleared-stale',
					entry,
					ref,
					terminalOnMain,
					message: `'${entry}' is a CRASH-WINDOW ORPHAN — SURFACED on ${arbiter}/main (needsAnswers:true + sidecar) but the release never ran; reconcilable, auto-reapable by 'gc --ledger --reap-stale-locks' (NOT auto-cleared by the report)`,
				};
			}
			return {
				outcome: 'kept-in-flight',
				entry,
				ref,
				terminalOnMain,
				message: `'${entry}' is in flight (held, not terminal on ${arbiter}/main)`,
			};
		}
		// Terminal on `main` + a held (active) lock = an ORPHAN over a
		// durably-completed item. Unlike `reconcileItemLockAgainstMain` we do NOT
		// clear it here — the report only names it as reconcilable; the reaper (or
		// a human) asserts the clear (no auto-sweep from the report path).
		return {
			outcome: 'cleared-stale',
			entry,
			ref,
			terminalOnMain,
			message: `'${entry}' is terminal on ${arbiter}/main — reconcilable (stale); auto-reapable by 'gc --ledger --reap-stale-locks' (NOT auto-cleared by the report)`,
		};
	} catch (err) {
		return {
			outcome: 'error',
			entry,
			ref,
			terminalOnMain: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

/** One lingering lock in the `gc --ledger` orphaned-lock REPORT: the held entry
 * plus the read-only cross-substrate {@link ReconcileOutcome} classification of
 * it against the authoritative `main` durable record. Reported, NEVER cleared
 * by the report itself. */
export interface LockReportEntry {
	/** The full held lock entry (action × state + holder/since). */
	lock: LockEntry;
	/** The lock ref (`refs/dorfl/lock/<entry>`). */
	ref: string;
	/**
	 * The READ-ONLY {@link classifyItemLockAgainstMain} verdict:
	 *   - `kept-in-flight` — a normal in-flight hold (active, not terminal on `main`).
	 *   - `cleared-stale`  — the lock is reconcilable: terminal on `main` (stranded)
	 *     OR non-terminal + SURFACED (`needsAnswers:true` + sidecar) = crash-window
	 *     orphan; a reaper (or `release-lock`) clears it (NOT auto-cleared by the
	 *     report — no auto-sweep here).
	 *   - `error`          — a per-item classification fault (kept verbatim).
	 */
	reconcile: ReconcileOutcome;
}

/** True iff a {@link ReconcileOutcome} names an ORPHAN class the
 * `--reap-stale-locks` sweep can auto-clear via the shared leased delete.
 * Post-`retire-stuck-lock-state` this is just `cleared-stale`. */
export function isReapableTerminalOrphan(outcome: ReconcileOutcome): boolean {
	return outcome === 'cleared-stale';
}

/** The `gc --ledger` stuck/orphaned-lock REPORT (spec
 * `ledger-status-per-item-lock-refs` US #14): every lingering per-item lock on the
 * arbiter, each classified read-only against `main`. An EMPTY list = no locks held
 * (an absent ref namespace reads as `[]`, the recoverable "all locks released"
 * state — US #12). The report NEVER clears anything. */
export interface ItemLockReport {
	locks: LockReportEntry[];
}

/**
 * Build the `gc --ledger` stuck/orphaned-lock REPORT (spec
 * `ledger-status-per-item-lock-refs` US #12/#13/#14; ADR
 * `ledger-status-on-per-item-lock-refs`): enumerate every per-item lock currently
 * held on the arbiter ({@link listItemLockEntries} — held active + stuck, with
 * holder/since/reason) and classify EACH read-only against the authoritative
 * `main` durable record via {@link classifyItemLockAgainstMain} (the wiring the
 * `complete-lock-then-durable-main-move-crash-safe` task's
 * `reconcileItemLockAgainstMain` had no production caller for). This is the
 * generalisation of the (now-retired) advancing-marker report from advancing-only
 * to the UNIFIED lock (the `gc --ledger` stuck-lock report).
 *
 * It is a REPORT, never a sweep: it CLEARS nothing (no liveness heartbeat, no
 * auto-sweep — the same trust model as the advancing report; a human asserts a
 * lock is dead via `release-lock`). A stale-active lock over a terminal-on-`main`
 * item is surfaced as `cleared-stale`-eligible ("reconcilable") but left in place.
 *
 * Best-effort + degrades safely: an absent lock-ref namespace ⇒ an EMPTY report
 * ({@link listItemLockEntries} returns `[]`) — so a deleted lock ref reads as "all
 * locks released" (recoverable; work is safe on the `work/<slug>` branches +
 * `main`).
 */
export async function reportItemLocks(
	cwd: string,
	arbiter = 'origin',
	env?: NodeJS.ProcessEnv,
): Promise<ItemLockReport> {
	const entries = await listItemLockEntries(cwd, arbiter, env);
	const locks: LockReportEntry[] = [];
	for (const lock of entries) {
		const ref = itemLockRef(lock.entry);
		// Read-only classification against `main` — NEVER clears (the report is
		// advisory; a human asserts the clear via `release-lock`).
		const verdict = await classifyItemLockAgainstMain({
			item: itemFromLockEntry(lock.entry),
			cwd,
			arbiter,
			env,
		});
		locks.push({lock, ref, reconcile: verdict.outcome});
	}
	return {locks};
}

/**
 * Format the `gc --ledger` stuck/orphaned-lock REPORT for the terminal: one block
 * per lingering lock (entry, action/state, holder, since, the stuck `reason`, the
 * read-only `main`-reconciliation note, and a copy-pasteable `release-lock`
 * hint). An EMPTY report yields NO lines (a clean lock set is silent here, like
 * the duplicate-slug surface). It REPORTS only — the matching wording makes the
 * no-auto-sweep contract explicit (a human asserts a lock is dead).
 */
/**
 * Does the `gc --ledger` lock report contain a lock that NEEDS HUMAN ATTENTION
 * (spec US#14/#21; ADR `ledger-status-on-per-item-lock-refs`: this surface is the
 * STUCK / crash-orphaned lock, NOT every held one)? TRUE iff some lock is
 * `kept-stuck` (terminal-on-`main` + stuck) or `cleared-stale`-eligible
 * (terminal-on-`main` + a stale active orphan). A `kept-in-flight` (active,
 * non-terminal) lock is the NORMAL in-flight state of a healthy concurrent build
 * (read by `status` as healthy) and does NOT count — so a routine `gc --ledger`
 * health check whose only locks are healthy in-flight holds exits 0. This is the
 * fail-loud EXIT predicate for the gc lock surface (the report itself still lists
 * every held lock, in-flight ones informationally).
 */
export function itemLockReportNeedsAttention(report: ItemLockReport): boolean {
	return report.locks.some((l) => isReapableTerminalOrphan(l.reconcile));
}

export function formatItemLockReport(report: ItemLockReport): string[] {
	if (report.locks.length === 0) {
		return [];
	}
	const lines = [
		`Per-item locks: ${report.locks.length} lock(s) held on the arbiter ` +
			'(REPORT only — no automatic sweep; the lock has no liveness heartbeat, so ' +
			'a human asserts a stuck/stale lock is dead via `release-lock`):',
	];
	for (const {lock, reconcile} of report.locks) {
		lines.push(`  ${lock.entry}  [${lock.action}/${lock.state}]`);
		lines.push(
			`    holder: ${lock.holder || '(unknown)'}  since: ${lock.since || '(unknown)'}`,
		);
		lines.push(`    ${reconcileNote(reconcile)}`);
		// The copy-pasteable clear hint. An entry that reverse-derives to a CURRENT
		// item-form (`task-`/`spec-`/`observation-`) points at `release-lock <item>`.
		// A PRE-CUTOVER entry (`slice-<slug>` / `prd-<slug>`) has NO current item-form,
		// so it is UN-NAMEABLE that way — print ONLY the literal entry name and hint at
		// the `release-lock --entry <literal>` escape hatch (task
		// `release-lock-entry-escape-hatch-and-literal-entry-reporting`).
		if (hasCurrentItemForm(lock.entry)) {
			lines.push(
				`    resolve (if the lock is dead): \`dorfl release-lock ${itemFromLockEntry(
					lock.entry,
				)}\` (never --force).`,
			);
		} else {
			lines.push(
				`    # no current item-form; clear with: dorfl release-lock --entry ${lock.entry}`,
			);
		}
	}
	return lines;
}

/** The human-readable line for a lock's read-only `main`-reconciliation verdict. */
function reconcileNote(reconcile: ReconcileOutcome): string {
	switch (reconcile) {
		case 'kept-in-flight':
			return 'in flight (held, not terminal on main) — normal; left untouched.';
		case 'cleared-stale':
			return 'STALE / crash-window orphan (reconcilable) — auto-reapable by --reap-stale-locks (NOT auto-cleared by the report).';
		case 'no-lock':
			return 'no lock (already at rest).';
		case 'error':
			return 'reconciliation against main could not be determined (left untouched — the safe direction).';
	}
}

/** Per-lock outcome of the human-invoked {@link reapStaleItemLocks} SWEEP.
 * Post-`retire-stuck-lock-state` the `stuck`-flavoured verdicts
 * (`reaped-stuck-terminal`, `kept-stuck`) are gone with the state itself.
 *   - `reaped`         — a `cleared-stale` lock cleared via the SHARED leased delete.
 *   - `already-reaped` — BENIGN: the lock was already gone by the time the sweep
 *                        re-read the ref (`no-lock`).
 *   - `kept-in-flight` — left untouched (active, non-terminal, not surfaced — a
 *                        healthy build).
 *   - `lost`           — a reapable-orphan candidate whose leased delete was REJECTED
 *                        (the ref changed concurrently to a DIFFERENT value);
 *                        REPORTED, never `--force`d.
 *   - `error`          — a per-item classification/clear fault (left untouched). */
export type ReapOutcome =
	| 'reaped'
	| 'already-reaped'
	| 'kept-in-flight'
	| 'lost'
	| 'error';

/** One lock's disposition in the {@link ReapReport}. */
export interface ReapEntry {
	/** The full lock entry as the report saw it (action × state + holder/since). */
	lock: LockEntry;
	/** The lock ref (`refs/dorfl/lock/<entry>`). */
	ref: string;
	/** What the sweep DID with this lock. */
	outcome: ReapOutcome;
	/** A human-readable note (the clear message, or why it was kept). */
	message: string;
}

/** The result of {@link reapStaleItemLocks}: every held lock with what the sweep
 * did to it, plus convenience counts. A lock NEEDS HUMAN ATTENTION after the sweep
 * iff it is `kept-stuck` or `lost` (a `cleared-stale` whose leased delete lost the
 * race); a `kept-in-flight` is the normal healthy state and does NOT. */
export interface ReapReport {
	entries: ReapEntry[];
	/** Count of `cleared-stale` locks reaped (terminal-on-main + active, OR
	 * non-terminal + surfaced = crash-window orphan). */
	reaped: number;
	/** BENIGN already-reaped count: the sweep found the ref already gone (`no-lock`). */
	alreadyReaped: number;
	kept: number;
	lost: number;
}

/**
 * The OPT-IN `gc --ledger --reap-stale-locks` SWEEP (spec
 * `ledger-status-per-item-lock-refs` US #14): a human asserting "clear the dead
 * TERMINAL locks now", so one command sweeps every orphaned terminal lock instead
 * of N hand-run `release-lock`s. It is the WRITE twin of {@link reportItemLocks}
 * (the default report-only surface): it enumerates the SAME held locks, classifies
 * each read-only, and for EXACTLY the `cleared-stale` class (terminal-on-`main` +
 * `active` = stranded) performs the SHARED leased delete via
 * {@link reconcileItemLockAgainstMain} (the recovery's clear, re-checked fresh per
 * item) — there is NO parallel clear mechanism.
 *
 * SCOPE FENCE (the trust model the default preserves; broadened by task
 * `reaper-reap-terminal-stuck-lock-orphans`; ADR
 * `ledger-status-on-per-item-lock-refs` § Addendum 2026-07-10):
 *   - it clears the TWO terminal-on-`main` ORPHAN classes ONLY: `cleared-stale`
 *     (terminal + `active` = stranded between move and release) AND
 *     `cleared-stuck-terminal` (terminal + `stuck` = crash-orphan the auto-reaper
 *     used to leave forever). A `kept-stuck` (STUCK + NON-terminal — the
 *     genuine human-attention case) and a `kept-in-flight` (`active` +
 *     non-terminal — a healthy build) are NEVER reaped, even here. Because each
 *     clear goes through {@link reconcileItemLockAgainstMain}, which RE-reads +
 *     RE-classifies before deleting, a lock whose item was un-completed on
 *     `main` between the report and the sweep is still safe (reconcile returns
 *     `kept-*`, not a delete).
 *   - the clear is a LEASED delete: a concurrent change to the ref makes it REJECT
 *     (`lost`), reported — never a blind `--force`.
 *
 * The DEFAULT `gc --ledger` (no flag) never calls this: it stays report-only,
 * fail-loud, delete-nothing. This is gated behind the explicit `--reap-stale-locks`
 * flag (a human authorising the clear), exactly as `release-lock`'s trust model.
 */
export async function reapStaleItemLocks(
	cwd: string,
	arbiter = 'origin',
	env?: NodeJS.ProcessEnv,
): Promise<ReapReport> {
	const report = await reportItemLocks(cwd, arbiter, env);
	const entries: ReapEntry[] = [];
	let reaped = 0;
	let alreadyReaped = 0;
	let kept = 0;
	let lost = 0;
	for (const {lock, ref, reconcile} of report.locks) {
		const item = itemFromLockEntry(lock.entry);
		if (isReapableTerminalOrphan(reconcile)) {
			// Re-check + clear through the recovery's SHARED leased delete. Reconcile
			// re-reads the live ref, so a lock that turned in-flight since the
			// report is left alone; a concurrent change to the ref makes the lease
			// lose.
			const rec = await reconcileItemLockAgainstMain({
				item,
				cwd,
				arbiter,
				env,
			});
			if (rec.outcome === 'cleared-stale') {
				reaped++;
				entries.push({lock, ref, outcome: 'reaped', message: rec.message});
			} else if (rec.outcome === 'no-lock') {
				alreadyReaped++;
				entries.push({
					lock,
					ref,
					outcome: 'already-reaped',
					message: rec.message,
				});
			} else if (rec.outcome === 'kept-in-flight') {
				kept++;
				entries.push({lock, ref, outcome: rec.outcome, message: rec.message});
			} else {
				lost++;
				entries.push({lock, ref, outcome: 'lost', message: rec.message});
			}
			continue;
		}
		if (reconcile === 'kept-in-flight') {
			kept++;
			entries.push({
				lock,
				ref,
				outcome: reconcile,
				message: reconcileNote(reconcile),
			});
		} else {
			// no-lock / error from the classifier — nothing to reap; surface verbatim.
			lost++;
			entries.push({
				lock,
				ref,
				outcome: 'error',
				message: reconcileNote(reconcile),
			});
		}
	}
	return {entries, reaped, alreadyReaped, kept, lost};
}

/**
 * Does a {@link reapStaleItemLocks} sweep leave a lock that STILL needs human
 * attention? TRUE iff some entry is `kept-stuck` (a stuck lock the reaper rightly
 * left) or `lost`/`error` (a `cleared-stale` whose leased delete lost the race, or
 * an unresolvable fault). A `reaped` (successfully cleared) or a `kept-in-flight`
 * (healthy build) lock does NOT count — so a sweep that cleared every stale lock
 * and left only healthy in-flight holds exits 0. This is the post-sweep analogue of
 * {@link itemLockReportNeedsAttention}.
 */
export function reapReportNeedsAttention(report: ReapReport): boolean {
	// EXIT-CODE CONTRACT: the reaper exits 0 when all stale locks are reaped and
	// only healthy in-flight locks remain; exits 1 when a delete genuinely lost
	// the race / errored. An `already-reaped` is BENIGN. Post-`retire-stuck-
	// lock-state` there is no `kept-stuck` outcome to trip this.
	return report.entries.some(
		(e) => e.outcome === 'lost' || e.outcome === 'error',
	);
}

/**
 * Format the `gc --ledger --reap-stale-locks` sweep for the terminal: a header
 * line with the reaped/kept counts, then one line per lock (what was reaped vs
 * kept vs lost). An EMPTY sweep (no locks held) yields NO lines (silent, like the
 * report). The wording keeps the no-blind-force contract explicit.
 */
export function formatReapReport(report: ReapReport): string[] {
	if (report.entries.length === 0) {
		return [];
	}
	const lines = [
		`Per-item lock sweep (--reap-stale-locks): reaped ${report.reaped} stale ` +
			`lock(s), kept ${report.kept} (in-flight, never reaped)` +
			(report.alreadyReaped > 0
				? `, ${report.alreadyReaped} already reaped by another sweep (no-lock — benign, the desired end state)`
				: '') +
			(report.lost > 0
				? `, ${report.lost} could not be cleared (lease lost / error — reported, NEVER forced)`
				: '') +
			':',
	];
	for (const {lock, outcome, message} of report.entries) {
		const tag =
			outcome === 'reaped'
				? '[reaped]              '
				: outcome === 'already-reaped'
					? '[already]             '
					: outcome === 'lost'
						? '[lost]                '
						: outcome === 'error'
							? '[error]               '
							: '[kept]                ';
		lines.push(
			`  ${tag} ${lock.entry}  [${lock.action}/${lock.state}]  ${message}`,
		);
	}
	return lines;
}

/**
 * Convert a type-encoded lock `<entry>` (`<type>-<slug>`) back into the namespaced
 * item form (`<namespace>:<slug>`) that {@link lockEntryFor} /
 * {@link resolveSidecarIdentity} accept — so the report's suggested `release-lock`
 * command is copy-pasteable and the classifier can re-key off the SAME identity.
 * Unknown prefixes fall back to the raw entry (still copyable). The inverse of
 * {@link lockEntryFor} for the three known namespaces.
 */
export function itemFromLockEntry(entry: string): string {
	// The lock-entry prefixes: `spec` is the parent-spec type token (the legacy
	// ''prd'' token is GONE after the hard cutover), so a `spec-<slug>` lock entry
	// round-trips back to its namespaced `spec:<slug>` form (the inverse of
	// `lockEntryFor('spec:<slug>')`).
	for (const prefix of CURRENT_ITEM_FORM_PREFIXES) {
		const tag = `${prefix}-`;
		if (entry.startsWith(tag)) {
			return `${prefix}:${entry.slice(tag.length)}`;
		}
	}
	return entry;
}

/** The CURRENT lock-entry type prefixes an `<entry>` can reverse-derive to an
 * item-form (`<type>:<slug>`). After the slice→task / `prd-to-spec` vocabulary
 * cutover these are `task`/`spec`/`observation` ONLY — a pre-cutover `slice-`/
 * `prd-` prefix is NOT here, so its entry has NO current item-form. */
const CURRENT_ITEM_FORM_PREFIXES = ['task', 'spec', 'observation'] as const;

/**
 * Does `<entry>` reverse-derive to a CURRENT item-form (`<type>:<slug>`), i.e.
 * does it carry a known post-cutover type prefix (`task-`/`spec-`/`observation-`)?
 * FALSE for a pre-cutover `slice-<slug>` / `prd-<slug>` entry (task
 * `release-lock-entry-escape-hatch-and-literal-entry-reporting`): such an entry is
 * UN-NAMEABLE through the item-form `release-lock <item>` path and must be cleared
 * via the `release-lock --entry <literal>` escape hatch instead. This is the
 * predicate the `gc --ledger` report keys off to decide whether to print the
 * copy-pasteable item-form hint or the literal-`--entry` hint.
 */
export function hasCurrentItemForm(entry: string): boolean {
	return CURRENT_ITEM_FORM_PREFIXES.some((p) => entry.startsWith(`${p}-`));
}

/**
 * True iff `<arbiter>/main` shows the item SURFACED as a needs-attention
 * question (PR-2a classifier fold, task
 * `bounce-atomic-cutover-retire-stuck-lock`, spec
 * `surface-stuck-as-questions-and-retire-stuck-lock-state`): the item body
 * carries `needsAnswers: true` in its frontmatter AND a matching sidecar
 * (`work/questions/<type>-<slug>.md`) exists on `<arbiter>/main`. This is the
 * on-`main`-authoritative signature of the ordered bounce transition
 * (surface-to-main FIRST, release SECOND) that a crash BETWEEN steps 1 and 2
 * leaves behind: the surface commit landed but the lock ref release never ran.
 *
 * Best-effort + degrades safely (`false` on any read fault or absent body):
 * the recovery direction is to DECIDE the lock is NOT surfaced (fall through
 * to `kept-in-flight`) when we cannot prove the surface — never a
 * false-positive clear.
 */
async function isItemSurfacedOnMain(
	type: SidecarType,
	slug: string,
	item: string,
	arbiter: string,
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<boolean> {
	const sidecar = sidecarPathFor(item);
	const sidecarExists =
		(await gitSoft(['cat-file', '-e', `${arbiter}/main:${sidecar}`], cwd, env))
			.status === 0;
	if (!sidecarExists) {
		return false;
	}
	// Probe the two bounce body-folder candidates (D1 order) for a body carrying
	// `needsAnswers: true`. Kept in sync with `resolveBounceItemBodyPathOnMain`
	// in `needs-attention.ts`; duplicated here (a small closed list) to avoid a
	// cyclic import between `item-lock.ts` and `needs-attention.ts`.
	const candidates =
		type === 'task'
			? [
					workItemRel('tasks-ready', `${slug}.md`),
					workItemRel('tasks-backlog', `${slug}.md`),
				]
			: type === 'spec'
				? [
						workItemRel('specs-ready', `${slug}.md`),
						workItemRel('specs-proposed', `${slug}.md`),
					]
				: [workItemRel('observations', `${slug}.md`)];
	for (const path of candidates) {
		const show = await gitSoft(['show', `${arbiter}/main:${path}`], cwd, env);
		if (show.status !== 0) {
			continue;
		}
		if (parseFrontmatter(show.stdout).needsAnswers === true) {
			return true;
		}
	}
	return false;
}

/** True iff `<arbiter>/main` shows the item TERMINAL — any of
 * {@link terminalMainPaths} present in `<arbiter>/main`'s tree. */
async function isTerminalOnMain(
	type: SidecarType,
	slug: string,
	arbiter: string,
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<boolean> {
	for (const path of terminalMainPaths(type, slug)) {
		const exists =
			(await gitSoft(['cat-file', '-e', `${arbiter}/main:${path}`], cwd, env))
				.status === 0;
		if (exists) {
			return true;
		}
	}
	return false;
}

/** List the entries (`<type>-<slug>`) currently locked on the arbiter (the
 * stuck-lock report / `status` read path). */
export async function listItemLocks(
	cwd: string,
	arbiter = 'origin',
	env?: NodeJS.ProcessEnv,
): Promise<string[]> {
	// `--prune` so a lock RELEASED on the arbiter (its ref deleted there) is PRUNED
	// locally — a bare `git fetch +refs/dorfl/lock/*:refs/dorfl/lock/*` (force, NO
	// `--prune`) leaves local refs the arbiter has since DELETED, so `for-each-ref`
	// would list locks that no longer exist (observation
	// `gc-ledger-reports-mirror-stale-lock-refs-as-arbiter-state`). After the pruned
	// fetch the local `refs/dorfl/lock/*` namespace EXACTLY matches the arbiter's, so
	// `for-each-ref` reads the arbiter's actual lock set. The refs are materialized
	// LOCALLY (not just `ls-remote`) because callers like `migrateStuckLocks` read a
	// lock's body via `git show <ref>:lock.md` after this. A fault THROWS (fail-closed
	// for the SELECTION path via {@link heldTaskSlugsStrict}; the graceful
	// {@link heldTaskSlugs}/{@link heldSpecSlugs} twins catch it).
	await gitHard(
		[
			'fetch',
			'--prune',
			'--quiet',
			arbiter,
			`+${LOCK_REF_PREFIX}/*:${LOCK_REF_PREFIX}/*`,
		],
		cwd,
		env,
	);
	const out = await gitSoft(
		['for-each-ref', '--format=%(refname)', `${LOCK_REF_PREFIX}/*`],
		cwd,
		env,
	);
	if (out.status !== 0) {
		return [];
	}
	return out.stdout
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.startsWith(`${LOCK_REF_PREFIX}/`))
		.map((l) => l.slice(`${LOCK_REF_PREFIX}/`.length))
		.sort();
}

/**
 * Read the FULL lock entries currently held on the arbiter — the `status`/`scan`
 * in-flight read path (spec `ledger-status-per-item-lock-refs` US #8; task
 * `needs-attention-as-stuck-lock-state`). One fetch of the lock refs, then read
 * each held entry's `lock.md` blob, returning the parsed {@link LockEntry} for
 * every ref (so a caller can surface `active` (in-progress) and `stuck`
 * (needs-attention) holds + their reasons WITHOUT N fetches). Sorted by `entry`.
 * Best-effort: a fetch/read fault yields an EMPTY list, so the read-only
 * `status`/`scan` views degrade to "no in-flight locks" rather than erroring
 * (parity with {@link heldTaskSlugs}).
 */
export async function listItemLockEntries(
	cwd: string,
	arbiter = 'origin',
	env?: NodeJS.ProcessEnv,
): Promise<LockEntry[]> {
	try {
		// Read the arbiter DIRECTLY (`git ls-remote`) for the AUTHORITATIVE lock ref
		// set — NOT the local `refs/dorfl/lock/*` refs (observation
		// `gc-ledger-reports-mirror-stale-lock-refs-as-arbiter-state`): a bare
		// `git fetch +refs/dorfl/lock/*:refs/dorfl/lock/*` (force, NO `--prune`)
		// leaves local refs the arbiter has since DELETED, so `for-each-ref` would
		// report locks that no longer exist — and `gc --ledger`'s entire purpose is
		// to name locks a human should delete, so it MUST NOT name locks that do not
		// exist. `ls-remote` lists ONLY the refs that ACTUALLY exist on the arbiter
		// right now; the report is bounded by THAT set, never by accumulated local
		// state. A fault degrades to an EMPTY report (US #12 — recoverable), exactly
		// as an absent lock-ref namespace reads; an arbiter with no locks returns
		// exit 0 + empty output ⇒ `[]`.
		const ls = await gitSoft(
			['ls-remote', arbiter, `${LOCK_REF_PREFIX}/*`],
			cwd,
			env,
		);
		if (ls.status !== 0) {
			return [];
		}
		const refs = ls.stdout
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l !== '')
			.map((l) => l.split(/\s+/)[1])
			.filter((ref) => ref.startsWith(`${LOCK_REF_PREFIX}/`))
			.sort();
		if (refs.length === 0) {
			return [];
		}
		// Materialize the objects AND keep the local `refs/dorfl/lock/*` namespace
		// PRUNED to match the arbiter (best-effort). The list above is already
		// bounded by `ls-remote`, so a fetch fault here can only UNDER-report (skip
		// content), never name a non-existent ref — the safe direction.
		await gitSoft(
			[
				'fetch',
				'--prune',
				'--quiet',
				arbiter,
				`+${LOCK_REF_PREFIX}/*:${LOCK_REF_PREFIX}/*`,
			],
			cwd,
			env,
		);
		const entries: LockEntry[] = [];
		for (const ref of refs) {
			const show = await gitSoft(['show', `${ref}:lock.md`], cwd, env);
			if (show.status !== 0) {
				continue;
			}
			const lock = parseLockEntry(show.stdout);
			if (lock) {
				entries.push(lock);
			}
		}
		return entries;
	} catch {
		return [];
	}
}

/**
 * List the TASK slugs currently lock-held on the arbiter — the held-slug set the
 * `ready/` pool readers SUBTRACT (spec `ledger-status-per-item-lock-refs` US #15;
 * task `claim-acquires-unified-lock-no-body-move`). Enumerates {@link listItemLocks}
 * and keeps only the `task-<slug>` entries (a spec/observation lock does not gate
 * the TASK pool), mapping each to its bare `<slug>`.
 *
 * LOAD-BEARING since the lock cut-over: the claim NO LONGER moves the body to
 * `in-progress/` (it stays in the pool on `main`; the held lock IS the claim), so
 * this held-slug set is the ONLY signal that keeps a claimed / in-flight item out
 * of the eligible pool, NOT the redundant subtraction it was while the body-move
 * still removed claimed items.
 *
 * GRACEFUL (fail-OPEN) by design — this is the SURFACE reader: a fetch fault
 * yields an EMPTY set so the read-only `status`/`scan` views degrade to "no
 * in-flight locks" rather than erroring. That is WRONG for SELECTION (an empty set
 * on a read FAULT lets a continuously-held in-flight item leak back into the
 * eligible pool → re-claimed → empty diff → spurious `stuck`). The SELECTION path
 * must instead use {@link heldTaskSlugsStrict}, which THROWS on a read fault so
 * the caller can fail CLOSED (refuse to enumerate an untrusted pool) rather than
 * subtract nothing. This graceful variant delegates to the strict one and only
 * swallows the fault.
 */
export async function heldTaskSlugs(
	cwd: string,
	arbiter = 'origin',
	env?: NodeJS.ProcessEnv,
): Promise<Set<string>> {
	try {
		return await heldTaskSlugsStrict(cwd, arbiter, env);
	} catch {
		return new Set();
	}
}

/**
 * STRICT (fail-CLOSED) twin of {@link heldTaskSlugs} for the SELECTION path: read
 * the held TASK slugs from the arbiter and THROW on any read fault (offline / dead
 * arbiter / unreadable lock refs) instead of degrading to an empty set. The
 * held-lock set lives ONLY on the arbiter and is the LOAD-BEARING signal that
 * keeps a claimed / in-flight item out of the eligible pool, so a SELECTION read
 * that cannot reach the arbiter must NOT pretend "no locks held" — it must fail so
 * the caller refuses to enumerate a pool it cannot trust (the
 * `scan-cwd-selection-pool-read-local-skips-held-lock-subtraction-offline-must-fail`
 * decision: offline selection FAILS, there is no `--local` fallback). The
 * read-only surface keeps the graceful {@link heldTaskSlugs}.
 */
export async function heldTaskSlugsStrict(
	cwd: string,
	arbiter = 'origin',
	env?: NodeJS.ProcessEnv,
): Promise<Set<string>> {
	// `listItemLocks` fetches the lock refs with `gitHard` (throws on a failed
	// fetch) and returns the held entries; we do NOT swallow that throw here.
	const entries = await listItemLocks(cwd, arbiter, env);
	const prefix = 'task-';
	return new Set(
		entries
			.filter((e) => e.startsWith(prefix))
			.map((e) => e.slice(prefix.length)),
	);
}

/**
 * List the SPEC slugs currently lock-held on the arbiter — the held-SPEC set the
 * TASKABLE-spec pool readers SUBTRACT (fix
 * `propose-tasking-releases-lock-so-spec-is-retasked-and-pr-force-pushed-every-tick`).
 * The SPEC analogue of {@link heldTaskSlugsStrict}: enumerates {@link listItemLocks}
 * and keeps only the `spec-<slug>` entries (a task/observation lock does not gate
 * the SPEC pool), mapping each to its bare `<slug>`.
 *
 * LOAD-BEARING for the propose-mode tasking loop: an `advance spec:<slug> --propose`
 * that opens a PR now KEEPS the `spec:<slug>` lock HELD across the open PR (the
 * durable `specs/ready → specs/tasked` move lives only on the branch, so `main`
 * residence does NOT yet signal tasked-ness). This held-spec set is the ONLY thing
 * that keeps such an in-flight spec out of the taskable pool — WITHOUT it the spec
 * is re-tasked every tick and its PR force-pushed. Symmetric to the task-pool
 * subtraction; the same fail-open/fail-closed split applies (see
 * {@link heldSpecSlugs} vs this strict twin).
 */
export async function heldSpecSlugsStrict(
	cwd: string,
	arbiter = 'origin',
	env?: NodeJS.ProcessEnv,
): Promise<Set<string>> {
	const entries = await listItemLocks(cwd, arbiter, env);
	const prefix = 'spec-';
	return new Set(
		entries
			.filter((e) => e.startsWith(prefix))
			.map((e) => e.slice(prefix.length)),
	);
}

/**
 * GRACEFUL (fail-OPEN) twin of {@link heldSpecSlugsStrict} for read-only SURFACE
 * paths and the local autopick driver: a fetch fault yields an EMPTY set rather
 * than throwing (the follow-on tasking-lock CAS is the load-bearing safety net
 * locally, exactly as {@link heldTaskSlugs} relies on the claim CAS). The SELECTION
 * path that must refuse an untrusted pool uses the strict twin.
 */
export async function heldSpecSlugs(
	cwd: string,
	arbiter = 'origin',
	env?: NodeJS.ProcessEnv,
): Promise<Set<string>> {
	try {
		return await heldSpecSlugsStrict(cwd, arbiter, env);
	} catch {
		return new Set();
	}
}

/**
 * Parse a serialised lock entry body back into a {@link LockEntry} — the exact
 * inverse of {@link serialiseLockEntry}. Post-`retire-stuck-lock-state` a lock
 * entry whose serialised state is not the single admitted `'active'` value
 * (e.g. a legacy `state: stuck` blob written by an older binary before the
 * one-shot migration ran) is COERCED to `'active'` on read — the state is
 * degenerate, and a lingering stuck ref is left for the migration/recovery
 * verbs to clear via `main`-authoritative reconciliation rather than surfaced
 * as a second live state.
 */
export function parseLockEntry(body: string): LockEntry | undefined {
	const normalized = body.replace(/\r\n/g, '\n');
	const fm = /^---\n([\s\S]*?)\n---/.exec(normalized);
	if (!fm) {
		return undefined;
	}
	const fields: Record<string, string> = {};
	for (const line of fm[1].split('\n')) {
		const m = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
		if (m) {
			fields[m[1]] = m[2];
		}
	}
	if (!fields.entry || !fields.action || !fields.state) {
		return undefined;
	}
	return {
		entry: fields.entry,
		action: fields.action as LockAction,
		state: 'active',
		holder: fields.holder ?? '',
		since: fields.since ?? '',
	};
}

/**
 * Advisory holder id: git user.name, else $USER, else a uuid fragment. Exported
 * as {@link resolveLockHolder} so callers (e.g. claim's stale-lock self-heal) can
 * resolve THE SAME holder string the lock would stamp, to compare against a held
 * entry's `holder` without duplicating the resolution order.
 */
export async function resolveLockHolder(
	cwd: string,
	env?: NodeJS.ProcessEnv,
): Promise<string> {
	return resolveHolder(cwd, env);
}

/** Advisory holder id: git user.name, else $USER, else a uuid fragment. */
async function resolveHolder(
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<string> {
	const name = await gitSoft(['config', 'user.name'], cwd, env);
	if (name.status === 0 && name.stdout.trim() !== '') {
		return name.stdout.trim();
	}
	const e = env ?? process.env;
	return e.USER ?? e.USERNAME ?? randomUUID().slice(0, 8);
}
