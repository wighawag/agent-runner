import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {
	acquireItemLock,
	releaseItemLock,
	releaseHeldItemLock,
	markStuckItemLock,
	listItemLocks,
	listItemLockEntries,
	readItemLock,
	reportItemLocks,
	formatItemLockReport,
	itemLockReportNeedsAttention,
	classifyItemLockAgainstMain,
	itemFromLockEntry,
	itemLockRef,
	lockEntryFor,
} from '../src/item-lock.js';
import {
	makeScratch,
	seedRepoWithArbiter,
	gitEnv,
	type Scratch,
	fixtureFolderRel,
	rmrf,
} from './helpers/gitRepo.js';
import {run} from '../src/git.js';

/**
 * Regression for `release-lock-verb-and-gc-stuck-report` (PRD
 * `ledger-status-per-item-lock-refs` US #12/#13/#14): generalising the landed
 * advancing-only human-recovery surface (`release-advancing` + the
 * `gc --ledger` advancing-marker report) to the UNIFIED per-item lock.
 *
 *   - `release-lock <item>` (via `releaseItemLock`) clears a NAMED unified lock by
 *     DELETING the ref; idempotent; an absent ref = "all locks released".
 *   - `reportItemLocks` lists lingering locks (held + stuck) with holder/since/
 *     reason and a read-only `main`-reconciliation classification, and CLEARS
 *     nothing (no auto-sweep, no heartbeat).
 *   - the report wires the read-only twin of `reconcileItemLockAgainstMain`
 *     (`classifyItemLockAgainstMain`) to distinguish a held/stuck lock from a
 *     stale-active lock over a terminal-on-`main` item WITHOUT clearing.
 *   - an ABSENT lock-ref namespace reads as "no locks held" ([]).
 *   - a runner whose OWN lock VANISHED mid-build detects it on release
 *     (`releaseHeldItemLock` → `vanished`) and aborts rather than clean-releasing.
 */

const ARBITER = 'arbiter';

let scratch: Scratch;
beforeEach(() => {
	scratch = makeScratch('dorfl-release-lock-gc-');
});
afterEach(() => {
	scratch.cleanup();
});

/** Does the arbiter currently HOLD the per-item lock ref for `entry`? */
function lockRefOnArbiter(arbiter: string, entry: string): boolean {
	const r = run(
		'git',
		['ls-remote', `file://${arbiter}`, itemLockRef(entry)],
		scratch.root,
		{env: gitEnv()},
	);
	return r.status === 0 && r.stdout.trim() !== '';
}

/** Push a `work/<folder>/<slug>.md` straight onto `<arbiter>/main` via a throwaway
 * clone (a durable terminal record landing without the lock release — a crash
 * BETWEEN the main move and the lock release). */
function seedTerminalOnArbiter(
	arbiter: string,
	folder: string,
	slug: string,
): void {
	const dest = join(scratch.root, `seed-term-${folder}-${slug}`);
	const env = gitEnv();
	run('git', ['clone', '-q', `file://${arbiter}`, dest], scratch.root, {env});
	run('git', ['checkout', '-q', '-B', `seed/${slug}`, 'origin/main'], dest, {
		env,
	});
	const dir = join(dest, 'work', fixtureFolderRel(folder));
	mkdirSync(dir, {recursive: true});
	writeFileSync(join(dir, `${slug}.md`), `${folder}: ${slug}\n`);
	run('git', ['add', '-A'], dest, {env});
	run('git', ['commit', '-q', '-m', `${folder}: ${slug}`], dest, {env});
	run('git', ['push', '-q', 'origin', `seed/${slug}:main`], dest, {env});
	rmrf(dest);
}

describe('release-lock — clears a NAMED unified lock (generalises release-advancing)', () => {
	it('clears a named lock entry by DELETING the ref (covers US #14)', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['stuck']);
		// Plant the lock by running the normal acquire path — the shape a crashed
		// build/task/advance leaves behind (a held ref with no matching release).
		const acq = await acquireItemLock({
			item: 'task:stuck',
			action: 'implement',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(acq.outcome).toBe('acquired');
		expect(lockRefOnArbiter(arbiter, 'task-stuck')).toBe(true);

		// The human-invoked release names + clears the lock (deleting the ref).
		const rel = await releaseItemLock({
			item: 'task:stuck',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(rel.outcome).toBe('released');
		expect(rel.entry).toBe('task-stuck');
		// SELF-CLEANING: release DELETED the ref (the lock set is now empty).
		expect(lockRefOnArbiter(arbiter, 'task-stuck')).toBe(false);

		// The item itself was NEVER moved — the borrow is a lock, not a transition.
		run('git', ['fetch', '-q', ARBITER], repo, {env: gitEnv()});
		const inBacklog = run(
			'git',
			['cat-file', '-e', `${ARBITER}/main:work/tasks/ready/stuck.md`],
			repo,
			{env: gitEnv()},
		);
		expect(inBacklog.status).toBe(0);
	});

	it('is IDEMPOTENT: a re-run on an already-cleared lock is not-held (exit-0 "nothing to clear")', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, ['twice']);
		await acquireItemLock({
			item: 'task:twice',
			action: 'implement',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		const first = await releaseItemLock({
			item: 'task:twice',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(first.outcome).toBe('released');
		// The second release finds the ref already absent — a clean idempotent
		// no-op the CLI maps to exit-0 "all locks released, recoverable".
		const second = await releaseItemLock({
			item: 'task:twice',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(second.outcome).toBe('not-held');
		expect(second.entry).toBe('task-twice');
	});

	it('the suggested item form round-trips through the identity seam (copy-pasteable hint)', () => {
		// The report suggests `release-lock <item>`; the item form must be the SAME
		// the lock API accepts (the inverse of lockEntryFor for the known namespaces).
		expect(itemFromLockEntry('task-foo')).toBe('task:foo');
		// a `spec-<slug>` lock entry round-trips back to its `spec:<slug>` identity.
		expect(itemFromLockEntry('spec-bar')).toBe('spec:bar');
		expect(itemFromLockEntry('observation-baz')).toBe('observation:baz');
		// HARD CUTOVER: the legacy `prd-<slug>` entry prefix is GONE — it is no longer
		// a known namespace, so it falls back to the raw entry (still copyable).
		expect(itemFromLockEntry('prd-bar')).toBe('prd-bar');
	});
});

describe('gc --ledger orphan-lock report — REPORTS lingering locks, NEVER clears', () => {
	it('lists held + stuck locks with holder/since/reason, and does NOT clear them', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, [
			'building',
			'jammed',
		]);
		// One active (in-progress) lock and one stuck (needs-attention) lock.
		await acquireItemLock({
			item: 'task:building',
			action: 'implement',
			cwd: repo,
			arbiter: ARBITER,
			holder: 'alice',
			env: gitEnv(),
		});
		await acquireItemLock({
			item: 'task:jammed',
			action: 'implement',
			cwd: repo,
			arbiter: ARBITER,
			holder: 'bob',
			env: gitEnv(),
		});
		// Post-`retire-stuck-lock-state`: the shim mark-stuck is a no-op; both
		// locks stay ACTIVE. The report lists every held lock — no reason on the
		// entry any more (that lives on the surfaced sidecar on main).
		await markStuckItemLock({
			item: 'task:jammed',
			reason: 'ignored',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});

		const report = await reportItemLocks(repo, ARBITER, gitEnv());
		expect(report.locks.map((l) => l.lock.entry).sort()).toEqual([
			'task-building',
			'task-jammed',
		]);
		const jammed = report.locks.find((l) => l.lock.entry === 'task-jammed');
		expect(jammed?.lock.state).toBe('active');
		expect(jammed?.lock.holder).toBe('bob');
		const building = report.locks.find((l) => l.lock.entry === 'task-building');
		expect(building?.lock.state).toBe('active');
		expect(building?.lock.holder).toBe('alice');

		// CRITICAL: the report did NOT clear anything (no auto-sweep, no heartbeat).
		expect(lockRefOnArbiter(arbiter, 'task-building')).toBe(true);
		expect(lockRefOnArbiter(arbiter, 'task-jammed')).toBe(true);

		const lines = formatItemLockReport(report);
		const text = lines.join('\n');
		expect(text).toMatch(/Per-item locks: 2 lock\(s\)/);
		expect(text).toMatch(/no automatic sweep/);
		expect(text).toMatch(/holder: bob/);
		expect(text).toMatch(/dorfl release-lock task:jammed/);
		expect(text).toMatch(/never --force/);
	});

	it('an EMPTY lock set is a clean report (no lock section)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, ['idle']);
		const report = await reportItemLocks(repo, ARBITER, gitEnv());
		expect(report.locks).toEqual([]);
		expect(formatItemLockReport(report)).toEqual([]);
	});

	it('classifies a held + non-terminal lock as in-flight (left untouched)', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['live']);
		await acquireItemLock({
			item: 'task:live',
			action: 'implement',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		const report = await reportItemLocks(repo, ARBITER, gitEnv());
		expect(report.locks).toHaveLength(1);
		expect(report.locks[0].reconcile).toBe('kept-in-flight');
		expect(lockRefOnArbiter(arbiter, 'task-live')).toBe(true);
	});

	it('wires reconcile (read-only): a STALE-active lock over a terminal-on-main item is reported "reconcilable" but NOT cleared', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['done-ish']);
		await acquireItemLock({
			item: 'task:done-ish',
			action: 'implement',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		// Simulate the crash between the durable main-move and the lock release: the
		// item is now terminal on main (work/tasks/done/) but the active lock lingers.
		seedTerminalOnArbiter(arbiter, 'done', 'done-ish');

		// The read-only classifier names it as stale (cleared-stale-eligible) but
		// MUST NOT clear it (the report's no-auto-sweep contract).
		const verdict = await classifyItemLockAgainstMain({
			item: 'task:done-ish',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(verdict.outcome).toBe('cleared-stale');
		expect(verdict.terminalOnMain).toBe(true);
		// The lock is STILL held — classification did not delete the ref.
		expect(lockRefOnArbiter(arbiter, 'task-done-ish')).toBe(true);

		const report = await reportItemLocks(repo, ARBITER, gitEnv());
		expect(report.locks).toHaveLength(1);
		expect(report.locks[0].reconcile).toBe('cleared-stale');
		// Reported, not swept.
		expect(lockRefOnArbiter(arbiter, 'task-done-ish')).toBe(true);
		const text = formatItemLockReport(report).join('\n');
		expect(text).toMatch(/STALE/);
		expect(text).toMatch(/NOT auto-cleared/);
	});

	it('a held ACTIVE lock over a terminal-on-main item is reported as reconcilable (`cleared-stale`), NOT cleared by the report itself', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['bounced']);
		await acquireItemLock({
			item: 'task:bounced',
			action: 'implement',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		seedTerminalOnArbiter(arbiter, 'done', 'bounced');

		const report = await reportItemLocks(repo, ARBITER, gitEnv());
		expect(report.locks).toHaveLength(1);
		expect(report.locks[0].reconcile).toBe('cleared-stale');
		expect(lockRefOnArbiter(arbiter, 'task-bounced')).toBe(true);
	});
});

describe('gc --ledger EXIT scoping — fail loud only on the ATTENTION verdicts', () => {
	// The fail-loud gc exit (PRD US#14/#21; ADR: this surface is the STUCK /
	// crash-orphaned lock, NOT every held one) is scoped via
	// itemLockReportNeedsAttention: a healthy in-flight `active` lock must NOT make a
	// routine `gc --ledger` health check exit non-zero, while a stuck or stale-active
	// (terminal-on-main orphan) lock must.
	it('a healthy in-flight (active, non-terminal) lock does NOT need attention (gc exits 0)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, ['live']);
		await acquireItemLock({
			item: 'task:live',
			action: 'implement',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		const report = await reportItemLocks(repo, ARBITER, gitEnv());
		expect(report.locks[0].reconcile).toBe('kept-in-flight');
		// The lock IS reported (informational) but does NOT trip the fail-loud exit.
		expect(itemLockReportNeedsAttention(report)).toBe(false);
	});

	it('a STALE-active lock over a terminal-on-main item NEEDS attention (gc exits 1)', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['orphan']);
		await acquireItemLock({
			item: 'task:orphan',
			action: 'implement',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		seedTerminalOnArbiter(arbiter, 'done', 'orphan');
		const report = await reportItemLocks(repo, ARBITER, gitEnv());
		expect(report.locks[0].reconcile).toBe('cleared-stale');
		expect(itemLockReportNeedsAttention(report)).toBe(true);
	});

	it('a held ACTIVE lock over a terminal-on-main item NEEDS attention (`cleared-stale`, gc exits 1)', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['stuck-term']);
		await acquireItemLock({
			item: 'task:stuck-term',
			action: 'implement',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		seedTerminalOnArbiter(arbiter, 'done', 'stuck-term');
		const report = await reportItemLocks(repo, ARBITER, gitEnv());
		expect(report.locks[0].reconcile).toBe('cleared-stale');
		expect(itemLockReportNeedsAttention(report)).toBe(true);
		expect(lockRefOnArbiter(arbiter, 'stuck-term')).toBe(false);
		// (Guard silences an unused-import warning; the ref-existence check above is
		// symbolic — the real assertion is the reconcile verdict + needs-attention.)
	});

	it('an empty report needs no attention (gc exits 0)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, ['none']);
		const report = await reportItemLocks(repo, ARBITER, gitEnv());
		expect(report.locks).toHaveLength(0);
		expect(itemLockReportNeedsAttention(report)).toBe(false);
	});
});

describe('absent lock ref = "no locks held" ([]) — deletion is recoverable', () => {
	it('an absent lock-ref namespace reads as the empty list (all locks released)', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, ['safe']);
		// No lock ever acquired — the namespace is absent.
		expect(await listItemLocks(repo, ARBITER, gitEnv())).toEqual([]);
		const report = await reportItemLocks(repo, ARBITER, gitEnv());
		expect(report.locks).toEqual([]);
	});

	it('deleting the lock ref(s) leaves the work safe on main (the item never moved)', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['recoverable']);
		await acquireItemLock({
			item: 'task:recoverable',
			action: 'implement',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		// Delete the lock ref (the accidental-deletion / release scenario).
		await releaseItemLock({
			item: 'task:recoverable',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		// "All locks released" — and the body is still safe on main (never moved).
		expect(await listItemLocks(repo, ARBITER, gitEnv())).toEqual([]);
		run('git', ['fetch', '-q', ARBITER], repo, {env: gitEnv()});
		expect(
			run(
				'git',
				['cat-file', '-e', `${ARBITER}/main:work/tasks/ready/recoverable.md`],
				repo,
				{env: gitEnv()},
			).status,
		).toBe(0);
	});
});

describe('vanished-own-lock — a held runner detects the missing ref and aborts', () => {
	it('releaseHeldItemLock returns `vanished` (not a clean `released`) when our own ref is gone', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['midbuild']);
		// The runner acquires + HOLDS the lock (in-flight build).
		const acq = await acquireItemLock({
			item: 'task:midbuild',
			action: 'implement',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(acq.outcome).toBe('acquired');

		// Mid-build, someone else clears the lock out from under us (a human
		// `release-lock`, or a recovery/gc) — our own ref VANISHES.
		await releaseItemLock({
			item: 'task:midbuild',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(lockRefOnArbiter(arbiter, 'task-midbuild')).toBe(false);

		// The held runner's guarded release DETECTS the missing ref and reports
		// `vanished` (an abort / needs-attention signal), NOT a silent clean
		// `released` — its hold was lost mid-build, so the exclusion it relied on
		// was not in force.
		const rel = await releaseHeldItemLock({
			item: 'task:midbuild',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(rel.outcome).toBe('vanished');
		expect(rel.entry).toBe('task-midbuild');
		expect(rel.message).toMatch(/VANISHED/);
	});

	it('a held runner whose lock is still present releases cleanly (the happy path)', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['cleanfinish']);
		await acquireItemLock({
			item: 'task:cleanfinish',
			action: 'implement',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		const rel = await releaseHeldItemLock({
			item: 'task:cleanfinish',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(rel.outcome).toBe('released');
		expect(lockRefOnArbiter(arbiter, 'task-cleanfinish')).toBe(false);
	});
});

// --- gc-ledger-reports-mirror-stale-lock-refs-as-arbiter-state ----------------
//
// Regression: `listItemLocks`/`listItemLockEntries`/`reportItemLocks` used to
// `git fetch +refs/dorfl/lock/*:refs/dorfl/lock/*` (force, NO --prune) then read
// the LOCAL `refs/dorfl/lock/*` via `for-each-ref`. A lock RELEASED on the
// arbiter (its ref deleted there) survived locally indefinitely, so the ledger
// reported locks that did not exist on the arbiter — and printed a
// `release-lock <item>` for each, which then failed with "(stale info)" /
// "already absent on origin". A report whose purpose is to name locks a human
// should delete must not name locks that do not exist. The readers now read the
// arbiter DIRECTLY via `ls-remote` (the authoritative set), so a stale local
// ref can never be reported.

describe('gc --ledger — never reports a stale local lock ref the arbiter no longer holds', () => {
	/** Plant a STALE local `refs/dorfl/lock/<entry>` ref the arbiter no longer holds. */
	async function plantStaleLocalLockRef(
		repo: string,
		arbiter: string,
		item: string,
	): Promise<void> {
		// Acquire the lock on the arbiter (the real ref lands on the arbiter).
		const acq = await acquireItemLock({
			item,
			action: 'implement',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(acq.outcome).toBe('acquired');
		// Fetch the lock ref into the repo's LOCAL refs (the accumulated state a
		// pre-fix unpruned sync left behind).
		run(
			'git',
			['fetch', '-q', ARBITER, '+refs/dorfl/lock/*:refs/dorfl/lock/*'],
			repo,
			{env: gitEnv()},
		);
		// Delete the ref on the ARBITER ONLY (simulate a release that happened on
		// the arbiter — e.g. on another machine, or earlier in the session — but
		// never pruned the local/mirror ref).
		run(
			'git',
			['push', '-q', ARBITER, `:refs/dorfl/lock/${lockEntryFor(item)}`],
			repo,
			{
				env: gitEnv(),
			},
		);
	}

	it('listItemLocks reads the arbiter DIRECTLY (ls-remote) — a stale local ref is NOT listed', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['ghost']);
		await plantStaleLocalLockRef(repo, arbiter, 'task:ghost');
		// The arbiter no longer holds the lock ...
		expect(lockRefOnArbiter(arbiter, 'task-ghost')).toBe(false);
		// ... but the repo's LOCAL ref is still there (the accumulated stale state).
		const localRef = run(
			'git',
			['rev-parse', '--verify', '--quiet', 'refs/dorfl/lock/task-ghost'],
			repo,
			{env: gitEnv()},
		);
		expect(localRef.status).toBe(0);
		// listItemLocks reads the arbiter DIRECTLY → the stale local ref is NOT listed.
		expect(await listItemLocks(repo, ARBITER, gitEnv())).toEqual([]);
	});

	it('listItemLockEntries + reportItemLocks do NOT name the stale lock (the report must not name locks that do not exist)', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['ghost']);
		await plantStaleLocalLockRef(repo, arbiter, 'task:ghost');
		expect(lockRefOnArbiter(arbiter, 'task-ghost')).toBe(false);
		// The full-entry reader returns NO entry for the stale ref.
		expect(await listItemLockEntries(repo, ARBITER, gitEnv())).toEqual([]);
		// And the gc --ledger REPORT names no lock (so it prints no `release-lock`
		// hint for a lock that does not exist on the arbiter).
		const report = await reportItemLocks(repo, ARBITER, gitEnv());
		expect(report.locks).toEqual([]);
		expect(formatItemLockReport(report)).toEqual([]);
		expect(itemLockReportNeedsAttention(report)).toBe(false);
	});

	it('readItemLock returns undefined for a stale local ref (the --prune fetch prunes it, then show fails)', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['ghost']);
		await plantStaleLocalLockRef(repo, arbiter, 'task:ghost');
		expect(lockRefOnArbiter(arbiter, 'task-ghost')).toBe(false);
		// Before: the stale local ref would make readItemLock report the item held.
		const held = await readItemLock({
			item: 'task:ghost',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(held).toBeUndefined();
		// The --prune fetch inside readItemLock REAPED the stale local ref.
		const localRefAfter = run(
			'git',
			['rev-parse', '--verify', '--quiet', 'refs/dorfl/lock/task-ghost'],
			repo,
			{env: gitEnv()},
		);
		expect(localRefAfter.status).not.toBe(0);
	});

	it('a REAL held lock (still on the arbiter) IS still reported (the fix does not drop live locks)', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['live']);
		await acquireItemLock({
			item: 'task:live',
			action: 'implement',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(lockRefOnArbiter(arbiter, 'task-live')).toBe(true);
		// A genuinely held lock IS listed + reported.
		expect(await listItemLocks(repo, ARBITER, gitEnv())).toEqual(['task-live']);
		const entries = await listItemLockEntries(repo, ARBITER, gitEnv());
		expect(entries.map((e) => e.entry)).toEqual(['task-live']);
		const report = await reportItemLocks(repo, ARBITER, gitEnv());
		expect(report.locks.map((l) => l.lock.entry)).toEqual(['task-live']);
	});
});
