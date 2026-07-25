import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {git} from '../src/git.js';
import {
	createJob,
	readJobRecord,
	jobWorktreePath,
	type Job,
} from '../src/workspace.js';
import {
	evaluateDeletionSafety,
	reapJob,
	gc,
	discoverJobs,
	resolveArbiterKeyFromCwd,
	enumerateWorkspaceArbiters,
} from '../src/gc.js';
import {encodeRepoKey} from '../src/repo-mirror.js';
import {
	makeScratch,
	seedRepoWithArbiter,
	gitEnv,
	type Scratch,
} from './helpers/gitRepo.js';

let scratch: Scratch;
beforeEach(() => {
	scratch = makeScratch('dorfl-gc-');
});
afterEach(() => {
	scratch.cleanup();
});

/**
 * Set up a job worktree cut from a bare hub mirror against a local `--bare`
 * arbiter — the real substrate (`createJob`). `slug` becomes branch `work/<slug>`.
 *
 * Each job lives under its OWN arbiter (a fresh `seedRepoWithArbiter` in a
 * dedicated subroot) but a SHARED `workspacesDir`, so multiple distinct jobs
 * coexist under `<workspacesDir>/work/*` for a `gc` sweep without a sibling's
 * mirror fetch pruning another's in-flight work branch (that prune-interference
 * is a substrate concern, not the reaper's).
 */
function setupJob(slug: string): {
	job: Job;
	url: string;
	workspacesDir: string;
} {
	const subRoot = join(scratch.root, `arb-${slug}`);
	const {arbiter} = seedRepoWithArbiter(subRoot, [slug]);
	const url = `file://${arbiter}`;
	const workspacesDir = join(scratch.root, '.dorfl');
	const job = createJob({url, slug, workspacesDir, env: gitEnv()});
	return {job, url, workspacesDir};
}

/** Commit a new file on the job's work branch (advances the tip past main). */
function commitWork(job: Job, filename = 'work.txt'): string {
	writeFileSync(join(job.dir, filename), 'agent work\n');
	git(['add', '-A'], job.dir, {env: gitEnv()});
	git(['commit', '-q', '-m', 'agent work'], job.dir, {env: gitEnv()});
	return git(['rev-parse', 'HEAD'], job.dir, {env: gitEnv()}).trim();
}

/**
 * Push the work branch to the arbiter under its own ref (the "pushed" path).
 * Inside a mirror-cut worktree `origin` IS the arbiter; the predicate does its
 * own explicit-refspec fetch, so no fetch is needed here.
 */
function pushBranch(job: Job): void {
	git(['push', '-q', 'origin', `${job.branch}:${job.branch}`], job.dir, {
		env: gitEnv(),
	});
}

/** Merge the work branch into the arbiter's main (the "merged" path). */
function mergeToArbiterMain(job: Job): void {
	git(['push', '-q', 'origin', `${job.branch}:main`], job.dir, {env: gitEnv()});
}

describe('evaluateDeletionSafety — predicate', () => {
	it('SAFE (merged): clean tree + tip is an ancestor of arbiter/main', () => {
		const {job} = setupJob('feat');
		commitWork(job);
		mergeToArbiterMain(job);

		const verdict = evaluateDeletionSafety({
			dir: job.dir,
			branch: job.branch,
			env: gitEnv(),
		});
		expect(verdict.safe).toBe(true);
		expect(verdict.reachableVia).toBe('merged');
	});

	it('SAFE (pushed): clean tree + arbiter/<branch> tip == local tip', () => {
		const {job} = setupJob('feat');
		commitWork(job);
		pushBranch(job);

		const verdict = evaluateDeletionSafety({
			dir: job.dir,
			branch: job.branch,
			env: gitEnv(),
		});
		expect(verdict.safe).toBe(true);
		expect(verdict.reachableVia).toBe('pushed');
	});

	it('RETAIN (unmerged): clean tree but the tip is NOT on the arbiter at all', () => {
		const {job} = setupJob('feat');
		commitWork(job); // committed locally, never pushed/merged

		const verdict = evaluateDeletionSafety({
			dir: job.dir,
			branch: job.branch,
			env: gitEnv(),
		});
		expect(verdict.safe).toBe(false);
		expect(verdict.reason).toBe('unmerged-commits');
	});

	it('RETAIN (dirty): uncommitted changes dominate, even if the tip is merged', () => {
		const {job} = setupJob('feat');
		commitWork(job);
		mergeToArbiterMain(job);
		// Now dirty the tree AFTER the work is safely on the arbiter.
		writeFileSync(join(job.dir, 'scratch.txt'), 'uncommitted\n');

		const verdict = evaluateDeletionSafety({
			dir: job.dir,
			branch: job.branch,
			env: gitEnv(),
		});
		expect(verdict.safe).toBe(false);
		expect(verdict.reason).toBe('dirty-tree');
	});

	it('the per-job record (now OUT of the worktree) does NOT count as a dirty tree', () => {
		const {job} = setupJob('feat');
		// The record lives at a SIBLING of the worktree (out of the tree), so it can
		// never appear in the worktree's `git status` — the cleanliness check is
		// structurally unaffected by it.
		writeFileSync(join(job.dir, 'work.txt'), 'agent work\n');
		git(['add', 'work.txt'], job.dir, {env: gitEnv()});
		git(['commit', '-q', '-m', 'agent work'], job.dir, {env: gitEnv()});
		mergeToArbiterMain(job);
		// Sanity: the record is the sibling, NOT inside the worktree.
		expect(existsSync(`${job.dir}.json`)).toBe(true);
		expect(existsSync(join(job.dir, '.dorfl-job.json'))).toBe(false);

		const verdict = evaluateDeletionSafety({
			dir: job.dir,
			branch: job.branch,
			env: gitEnv(),
		});
		expect(verdict.safe).toBe(true);
		expect(verdict.reachableVia).toBe('merged');
	});

	it('RETAIN (branch-not-pushed): a remote branch exists but its tip differs (un-pushed amend)', () => {
		const {job} = setupJob('feat');
		commitWork(job);
		pushBranch(job);
		// Amend locally AFTER pushing → remote tip now lags the local tip.
		writeFileSync(join(job.dir, 'work.txt'), 'amended work\n');
		git(['commit', '-q', '-a', '--amend', '--no-edit'], job.dir, {
			env: gitEnv(),
		});

		const verdict = evaluateDeletionSafety({
			dir: job.dir,
			branch: job.branch,
			env: gitEnv(),
		});
		expect(verdict.safe).toBe(false);
		expect(verdict.reason).toBe('branch-not-pushed');
	});
});

describe('reapJob — auto-reap at end-of-job', () => {
	it('removes a provably-safe worktree via git worktree remove (+ prune), never rm -rf', () => {
		const {job} = setupJob('feat');
		commitWork(job);
		mergeToArbiterMain(job);

		const result = reapJob({
			dir: job.dir,
			branch: job.branch,
			mirrorPath: job.mirror.path,
			env: gitEnv(),
		});

		expect(result.removed).toBe(true);
		expect(result.forced).toBe(false);
		expect(existsSync(job.dir)).toBe(false);
		// The relocated sibling record is removed too — no `<work-id>.json` orphan.
		expect(existsSync(`${job.dir}.json`)).toBe(false);
		// The worktree registration is gone from the hub (proper removal, not rm -rf).
		const list = git(['worktree', 'list', '--porcelain'], job.mirror.path, {
			env: gitEnv(),
		});
		expect(list).not.toContain(job.dir);
	});

	it('NEVER removes a job whose work is not on the arbiter (retained = needs-attention)', () => {
		const {job} = setupJob('feat');
		commitWork(job); // unmerged, unpushed

		const result = reapJob({
			dir: job.dir,
			branch: job.branch,
			mirrorPath: job.mirror.path,
			env: gitEnv(),
		});

		expect(result.removed).toBe(false);
		expect(result.verdict.reason).toBe('unmerged-commits');
		expect(existsSync(job.dir)).toBe(true);
	});

	it('--force overrides the predicate (discards un-saved work) and is marked forced', () => {
		const {job} = setupJob('feat');
		commitWork(job); // unmerged, unpushed — would normally be retained

		const result = reapJob({
			dir: job.dir,
			branch: job.branch,
			mirrorPath: job.mirror.path,
			force: true,
			env: gitEnv(),
		});

		expect(result.removed).toBe(true);
		expect(result.forced).toBe(true);
		expect(existsSync(job.dir)).toBe(false);
	});
});

describe('reapJob — reachableOnly (the FAILURE-path predicate loosening)', () => {
	/**
	 * The failure path's stance (defect #2): a churn-dirty worktree whose durable
	 * branch is PROVABLY on the arbiter is REAPED — the durable artefact is the
	 * pushed branch, not the worktree files — so it cannot linger to poison the
	 * next build. NOT marked forced (it IS provably safe under this predicate).
	 */
	it('REAPS a churn-dirty worktree when the branch IS on the arbiter (pushed)', () => {
		const {job} = setupJob('feat');
		commitWork(job);
		pushBranch(job);
		// Incidental churn AFTER the durable branch is safely pushed.
		writeFileSync(join(job.dir, 'scratch.txt'), 'doc churn\n');

		// The standard (clean-AND-reachable) predicate RETAINS it (dirty dominates).
		const standard = reapJob({
			dir: job.dir,
			branch: job.branch,
			mirrorPath: job.mirror.path,
			env: gitEnv(),
		});
		expect(standard.removed).toBe(false);
		expect(standard.verdict.reason).toBe('dirty-tree');
		expect(existsSync(job.dir)).toBe(true);

		// The failure-path (reachableOnly) predicate REAPS it — reachability holds,
		// the clean-tree half is dropped, and it is NOT forced.
		const loosened = reapJob({
			dir: job.dir,
			branch: job.branch,
			mirrorPath: job.mirror.path,
			reachableOnly: true,
			env: gitEnv(),
		});
		expect(loosened.removed).toBe(true);
		expect(loosened.forced).toBe(false);
		expect(loosened.verdict.reachableVia).toBe('pushed');
		expect(existsSync(job.dir)).toBe(false);
	});

	it('REAPS a churn-dirty worktree when the branch is MERGED into arbiter main', () => {
		const {job} = setupJob('feat');
		commitWork(job);
		mergeToArbiterMain(job);
		writeFileSync(join(job.dir, 'scratch.txt'), 'doc churn\n');

		const result = reapJob({
			dir: job.dir,
			branch: job.branch,
			mirrorPath: job.mirror.path,
			reachableOnly: true,
			env: gitEnv(),
		});
		expect(result.removed).toBe(true);
		expect(result.forced).toBe(false);
		expect(existsSync(job.dir)).toBe(false);
	});

	/**
	 * NEVER lose work: reachableOnly drops the clean-tree half but KEEPS the
	 * reachability half — a worktree whose work is NOT yet on the arbiter is still
	 * RETAINED, even under the failure-path predicate.
	 */
	it('RETAINS a worktree whose work is NOT on the arbiter even with reachableOnly (never lose work)', () => {
		const {job} = setupJob('feat');
		commitWork(job); // committed locally, never pushed/merged
		writeFileSync(join(job.dir, 'scratch.txt'), 'doc churn\n');

		const result = reapJob({
			dir: job.dir,
			branch: job.branch,
			mirrorPath: job.mirror.path,
			reachableOnly: true,
			env: gitEnv(),
		});
		expect(result.removed).toBe(false);
		expect(result.verdict.reason).toBe('unmerged-commits');
		expect(existsSync(job.dir)).toBe(true);
	});
});

describe('discoverJobs', () => {
	it('finds each work/* dir whose SIBLING record (<work-id>.json) exists', () => {
		const a = setupJob('a');
		const b = setupJob('b');
		const workspacesDir = a.workspacesDir;

		const jobs = discoverJobs(workspacesDir);
		const slugs = jobs.map((j) => j.slug).sort();
		expect(slugs).toEqual(['a', 'b']);
		const dirs = jobs.map((j) => j.dir).sort();
		expect(dirs).toEqual([a.job.dir, b.job.dir].sort());
	});

	it('still discovers a LEGACY old-binary job whose record is in-tree (migration fallback)', () => {
		const {job, workspacesDir} = setupJob('legacy');
		// Simulate an old-binary worktree: move the record back INSIDE the tree.
		const sibling = `${job.dir}.json`;
		const body = readFileSync(sibling, 'utf8');
		rmSync(sibling);
		writeFileSync(join(job.dir, '.dorfl-job.json'), body);

		const jobs = discoverJobs(workspacesDir);
		const found = jobs.find((j) => j.slug === 'legacy');
		expect(found).toBeDefined();
		expect(found?.dir).toBe(job.dir);
		expect(found?.record?.slug).toBe('legacy');
	});

	it('returns [] when the work area does not exist', () => {
		expect(discoverJobs(join(scratch.root, 'nope'))).toEqual([]);
	});
});

describe('gc — re-apply the predicate across work/*', () => {
	it('reaps the provably-safe jobs and retains the rest with a clear reason', () => {
		// Three independent jobs (own arbiters) sharing one workspacesDir: one
		// merged (reap), one pushed (reap), one unmerged (retain).
		const merged = setupJob('merged');
		const pushed = setupJob('pushed');
		const unmerged = setupJob('unmerged');
		const workspacesDir = merged.workspacesDir;

		commitWork(merged.job);
		mergeToArbiterMain(merged.job);
		commitWork(pushed.job);
		pushBranch(pushed.job);
		commitWork(unmerged.job);

		const notes: string[] = [];
		const result = gc({
			workspacesDir,
			env: gitEnv(),
			note: (m) => notes.push(m),
		});

		const reapedSlugs = result.reaped.map((j) => j.slug).sort();
		expect(reapedSlugs).toEqual(['merged', 'pushed']);
		expect(existsSync(merged.job.dir)).toBe(false);
		expect(existsSync(pushed.job.dir)).toBe(false);

		expect(result.retained).toHaveLength(1);
		expect(result.retained[0].slug).toBe('unmerged');
		expect(result.retained[0].reason).toBe('unmerged-commits');
		expect(result.retained[0].reasonText).toContain('unmerged commits');
		expect(existsSync(unmerged.job.dir)).toBe(true);

		// The retained one is reported with a reason in the notes.
		expect(notes.some((n) => /Retained unmerged:/.test(n))).toBe(true);
	});

	it('reports each retained reason distinctly (dirty vs unmerged)', () => {
		const dirty = setupJob('dirty');
		const unmerged = setupJob('unmerged');
		const workspacesDir = dirty.workspacesDir;

		commitWork(dirty.job);
		mergeToArbiterMain(dirty.job);
		writeFileSync(join(dirty.job.dir, 'scratch.txt'), 'uncommitted\n');
		commitWork(unmerged.job);

		const result = gc({workspacesDir, env: gitEnv()});
		expect(result.reaped).toHaveLength(0);
		const byslug = Object.fromEntries(
			result.retained.map((j) => [j.slug, j.reason]),
		);
		expect(byslug.dirty).toBe('dirty-tree');
		expect(byslug.unmerged).toBe('unmerged-commits');
	});

	it('--force reaps every job loudly (discarding un-saved work)', () => {
		const {job, workspacesDir} = setupJob('unmerged');
		commitWork(job);

		const notes: string[] = [];
		const result = gc({
			workspacesDir,
			force: true,
			env: gitEnv(),
			note: (m) => notes.push(m),
		});

		expect(result.reaped).toHaveLength(1);
		expect(result.reaped[0].forced).toBe(true);
		expect(existsSync(job.dir)).toBe(false);
		expect(notes.some((n) => /FORCED/.test(n))).toBe(true);
	});

	it('is idempotent: a second sweep over an already-reaped area is a no-op', () => {
		const {job, workspacesDir} = setupJob('merged');
		commitWork(job);
		mergeToArbiterMain(job);

		const first = gc({workspacesDir, env: gitEnv()});
		expect(first.reaped).toHaveLength(1);
		const second = gc({workspacesDir, env: gitEnv()});
		expect(second.reaped).toHaveLength(0);
		expect(second.retained).toHaveLength(0);
	});
});

describe('gc — ARBITER SCOPE (a gc for repo A must not touch repo B)', () => {
	/**
	 * The incident this scope closes: a `gc` (especially `--force --yes`) run to
	 * reap ONE arbiter's stale worktree used to sweep GLOBALLY and could
	 * irreversibly discard an UNRELATED arbiter's un-pushed work. Scoped to the
	 * cwd's arbiter key, a sweep now only considers that arbiter's worktrees.
	 */
	it('DEFAULT (arbiterKey set): reaps ONLY the scoped arbiter, leaving the other arbiter untouched', () => {
		// Two jobs under DISTINCT arbiters, one shared workspacesDir. Job A is
		// un-merged (would be reaped by --force); job B holds un-pushed work.
		const a = setupJob('repo-a');
		const b = setupJob('repo-b');
		const workspacesDir = a.workspacesDir;
		commitWork(a.job);
		commitWork(b.job); // un-pushed work in repo B — must NEVER be discarded by A's gc

		const arbiterKeyA = encodeRepoKey(a.job.mirror.url);

		// A FORCED, arbiter-A-scoped sweep: reaps A, but B is out of scope entirely.
		const result = gc({
			workspacesDir,
			arbiterKey: arbiterKeyA,
			force: true,
			env: gitEnv(),
		});

		const touched = [
			...result.reaped.map((j) => j.slug),
			...result.retained.map((j) => j.slug),
		];
		expect(touched).toEqual(['repo-a']);
		expect(result.reaped.map((j) => j.slug)).toEqual(['repo-a']);
		expect(existsSync(a.job.dir)).toBe(false); // A reaped
		expect(existsSync(b.job.dir)).toBe(true); // B's un-pushed work UNTOUCHED
	});

	it('GLOBAL (arbiterKey unset): the old cross-arbiter behaviour still reaps every arbiter', () => {
		const a = setupJob('repo-a');
		const b = setupJob('repo-b');
		const workspacesDir = a.workspacesDir;
		commitWork(a.job);
		commitWork(b.job);

		const result = gc({workspacesDir, force: true, env: gitEnv()});
		const reaped = result.reaped.map((j) => j.slug).sort();
		expect(reaped).toEqual(['repo-a', 'repo-b']);
		expect(existsSync(a.job.dir)).toBe(false);
		expect(existsSync(b.job.dir)).toBe(false);
	});

	it('a non-matching arbiterKey reaps NOTHING (no arbiter\u2019s worktrees in scope)', () => {
		const a = setupJob('repo-a');
		const b = setupJob('repo-b');
		const workspacesDir = a.workspacesDir;
		commitWork(a.job);
		commitWork(b.job);

		const result = gc({
			workspacesDir,
			arbiterKey: 'no-such-host/nobody/nothing',
			force: true,
			env: gitEnv(),
		});
		expect(result.reaped).toHaveLength(0);
		expect(result.retained).toHaveLength(0);
		expect(existsSync(a.job.dir)).toBe(true);
		expect(existsSync(b.job.dir)).toBe(true);
	});

	it('enumerateWorkspaceArbiters lists each distinct arbiter (for the loud --all-arbiters banner)', () => {
		const a = setupJob('repo-a');
		setupJob('repo-b');
		const workspacesDir = a.workspacesDir;

		const arbiters = enumerateWorkspaceArbiters(workspacesDir, gitEnv());
		const keys = arbiters.map((x) => x.key).sort();
		expect(keys).toHaveLength(2);
		// Distinct keys, both readable (no malformed mirrors).
		expect(keys.every((k) => typeof k === 'string')).toBe(true);
	});
});

describe('resolveArbiterKeyFromCwd — the cwd\u2192arbiter resolution the CLI scopes on', () => {
	it('resolves a repo\u2019s remote to the SAME key its worktrees are keyed under', () => {
		const {job, url} = setupJob('feat');
		// The repo the operator runs `gc` from: give it an `origin` remote pointing
		// at the SAME arbiter URL the mirror was cut from.
		const repo = join(scratch.root, 'operator-checkout');
		git(['init', '-q', '-b', 'main', repo], scratch.root, {env: gitEnv()});
		git(['remote', 'add', 'origin', url], repo, {env: gitEnv()});

		const key = resolveArbiterKeyFromCwd(repo, 'origin', gitEnv());
		expect(key).toBe(encodeRepoKey(job.mirror.url));
	});

	it('returns undefined when there is no such remote (the CLI then errors, never goes global)', () => {
		const repo = join(scratch.root, 'no-remote');
		git(['init', '-q', '-b', 'main', repo], scratch.root, {env: gitEnv()});
		expect(resolveArbiterKeyFromCwd(repo, 'origin', gitEnv())).toBeUndefined();
	});

	it('returns undefined when cwd is not a git repo at all', () => {
		const notRepo = join(scratch.root, 'plain-dir');
		mkdirSync(notRepo, {recursive: true});
		expect(
			resolveArbiterKeyFromCwd(notRepo, 'origin', gitEnv()),
		).toBeUndefined();
	});
});

describe('gc — record sanity', () => {
	it('a retained job keeps a readable record (status/needs-attention can read it)', () => {
		const {job} = setupJob('feat');
		commitWork(job);
		gc({workspacesDir: join(scratch.root, '.dorfl'), env: gitEnv()});
		const record = readJobRecord(job.dir);
		expect(record?.slug).toBe('feat');
	});
});

describe('gc — orphan self-heal (half-set-up claim residue)', () => {
	it('sweeps a DANGLING work/ symlink that git never registered (the manual-rm case)', () => {
		const workspacesDir = join(scratch.root, '.dorfl');
		const workDir = join(workspacesDir, 'work');
		mkdirSync(workDir, {recursive: true});
		// A dangling symlink: exactly the residue observed (`work/<id> -> claim/<id>`
		// where the claim target is gone), invisible to discoverJobs (no record).
		const orphan = join(workDir, 'github-com__wighawag__richelieu__');
		symlinkSync(join(workspacesDir, 'claim', 'gone'), orphan);

		const result = gc({workspacesDir, env: gitEnv()});
		expect(result.sweptOrphans).toHaveLength(1);
		expect(result.sweptOrphans[0].kind).toBe('dangling-symlink');
		expect(existsSync(orphan)).toBe(false);
	});

	it('sweeps a record-less orphan DIRECTORY (crashed before worktree add / record write)', () => {
		const workspacesDir = join(scratch.root, '.dorfl');
		const workDir = join(workspacesDir, 'work');
		const orphan = join(workDir, 'host__org__repo__slug');
		mkdirSync(orphan, {recursive: true});
		writeFileSync(join(orphan, 'leftover.txt'), 'partial\n');

		const result = gc({workspacesDir, env: gitEnv()});
		expect(result.sweptOrphans.map((o) => o.kind)).toContain('orphan-dir');
		expect(existsSync(orphan)).toBe(false);
	});

	it('does NOT sweep a real job worktree (it carries a record) — retains un-merged work', () => {
		const {job, workspacesDir} = setupJob('keepme');
		commitWork(job); // un-merged → the reap predicate RETAINS it
		const result = gc({workspacesDir, env: gitEnv()});
		expect(result.sweptOrphans).toHaveLength(0);
		expect(existsSync(job.dir)).toBe(true);
	});
});

describe('createJob — self-heals a leftover path blocking worktree add', () => {
	it('recreates over a record-less orphan DIR left by a prior crashed attempt', () => {
		const subRoot = join(scratch.root, 'arb-recreate');
		const {arbiter} = seedRepoWithArbiter(subRoot, ['recreate']);
		const url = `file://${arbiter}`;
		const workspacesDir = join(scratch.root, '.dorfl');
		// Simulate a prior run that created the work-id DIR but crashed BEFORE
		// `git worktree add` registered it (e.g. an early spawn git ENOENT).
		const dir = jobWorktreePath(workspacesDir, url, 'recreate');
		mkdirSync(dir, {recursive: true});
		writeFileSync(join(dir, 'stale.txt'), 'half\n');

		// createJob must self-heal (clear the orphan) and succeed — no manual rm.
		const job = createJob({
			url,
			slug: 'recreate',
			workspacesDir,
			env: gitEnv(),
		});
		expect(existsSync(join(job.dir, '.git'))).toBe(true);
		expect(readJobRecord(job.dir)?.slug).toBe('recreate');
		expect(existsSync(join(job.dir, 'stale.txt'))).toBe(false);
	});
});
