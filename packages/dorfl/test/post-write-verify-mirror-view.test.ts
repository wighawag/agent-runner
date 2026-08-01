import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {existsSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ledgerWrite} from '../src/ledger-write.js';
import {refreshArbiterRefs, resolveArbiterBranch} from '../src/arbiter-refs.js';
import {surfaceStuckToNeedsAttention} from '../src/needs-attention.js';
import {parseSidecar} from '../src/sidecar.js';
import {parseFrontmatter} from '../src/frontmatter.js';
import {
	makeScratch,
	seedRepoWithArbiter,
	gitEnv,
	gitIn,
	type Scratch,
} from './helpers/gitRepo.js';
import {run} from '../src/git.js';

/**
 * DEFECT 1 (observation `checkpoint-path-reports-its-own-write-as-absent`): the
 * post-write state check reported dorfl's OWN successful write as absent.
 *
 * Both field instances shared one root cause: the check read a REMOTE-TRACKING
 * ref (`refs/remotes/<arbiter>/…`) after a PLAIN `git fetch <arbiter>`. That is
 * unsound in the configuration `--isolated` runs actually use — a job worktree
 * cut from the BARE HUB MIRROR, whose `origin` carries the mirror refspec
 * `+refs/heads/*:refs/heads/*`. There, a plain fetch never populates
 * `refs/remotes/<arbiter>/*` (and, when the worktree has a `work/<slug>` branch
 * checked out, FAILS outright with `refusing to fetch into branch …`), so the
 * verification compared a fresh sha against a view PREDATING its own push.
 *
 * Consequences in the field: a surface commit that LANDED was reported
 * "treating as rejected", retried five times (landing five commits with the
 * identical subject), and then declared "did not land on origin/main" with a
 * recommendation to run an unnecessary recovery command.
 *
 * ## The configuration matrix
 *
 * Every case below runs against BOTH:
 *   - `plain-clone` — an ordinary working clone with a normal
 *     `+refs/heads/*:refs/remotes/<arbiter>/*` refspec (the shape the original
 *     tests used, and the shape that ACCIDENTALLY passed);
 *   - `bare-mirror-worktree` — a `git worktree` cut from a bare mirror with the
 *     mirror refspec and a `work/<slug>` branch checked out, with NO
 *     `refs/remotes/<arbiter>/*` namespace and NO registry entry. This is the
 *     configuration the defects were observed in, and the one where `dorfl
 *     status` also reports "no 'arbiter' remote configured in this repo".
 *
 * The bare-mirror case is the regression guard: it FAILS against the old
 * plain-fetch + `rev-parse <arbiter>/main` verification and passes against the
 * arbiter-authoritative one.
 */

let scratch: Scratch;
beforeEach(() => {
	scratch = makeScratch('dorfl-postwrite-verify-');
});
afterEach(() => {
	scratch.cleanup();
});

/** One entry in the configuration matrix. */
interface Fixture {
	/** The cwd the product code runs in. */
	cwd: string;
	/** The arbiter REMOTE NAME as known to `cwd`. */
	arbiter: string;
	/** Path to the bare arbiter repo (for direct assertions). */
	arbiterPath: string;
}

/** An ordinary working clone: `arbiter` remote, standard fetch refspec. */
function plainClone(slug: string): Fixture {
	const seeded = seedRepoWithArbiter(scratch.root, [slug]);
	return {cwd: seeded.repo, arbiter: 'arbiter', arbiterPath: seeded.arbiter};
}

/**
 * The configuration the defects were observed in: a bare HUB MIRROR of the
 * arbiter (mirror refspec, exactly `repo-mirror.ts`'s `ensureMirror`), plus a
 * job worktree cut from it with `work/task-<slug>` checked out, exactly
 * `workspace.ts`'s `createJob`. The repo is NOT in any registry and the worktree
 * has no `refs/remotes/origin/*` namespace at all.
 */
function bareMirrorWorktree(slug: string): Fixture {
	const seeded = seedRepoWithArbiter(scratch.root, [slug]);
	const mirror = join(scratch.root, 'hub-mirror.git');
	gitIn(
		['clone', '-q', '--bare', `file://${seeded.arbiter}`, mirror],
		scratch.root,
	);
	// The mirror-style refspec `ensureMirror` configures.
	gitIn(
		['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'],
		mirror,
	);
	gitIn(['fetch', '-q', 'origin'], mirror);
	const dir = join(scratch.root, 'job-worktree');
	gitIn(
		['worktree', 'add', '-q', dir, '-b', `work/task-${slug}`, 'main'],
		mirror,
	);
	return {cwd: dir, arbiter: 'origin', arbiterPath: seeded.arbiter};
}

const MATRIX: Array<[string, (slug: string) => Fixture]> = [
	['plain-clone', plainClone],
	[
		'bare-mirror-worktree (unregistered, no `arbiter` remote)',
		bareMirrorWorktree,
	],
];

/** Commits on the arbiter's `main`, newest first. */
function arbiterMainSubjects(arbiterPath: string): string[] {
	const log = run('git', ['log', '--format=%s', 'main'], arbiterPath, {
		env: gitEnv(),
	});
	return log.stdout
		.split('\n')
		.map((s) => s.trim())
		.filter((s) => s !== '');
}

/** The arbiter's current `refs/heads/main` sha. */
function arbiterMainSha(arbiterPath: string): string {
	return run('git', ['rev-parse', 'main'], arbiterPath, {
		env: gitEnv(),
	}).stdout.trim();
}

describe.each(MATRIX)(
	'post-write verification and surface idempotence [%s]',
	(_label, makeFixture) => {
		it('reports a GREEN push as published — never as "did not land"', async () => {
			const slug = 'verify-green-push';
			const {cwd, arbiter, arbiterPath} = makeFixture(slug);
			const env = gitEnv();

			// Build a real transition commit off the arbiter's main, tree-lessly.
			await refreshArbiterRefs({cwd, arbiter, branches: ['main'], env});
			const base = run('git', ['rev-parse', `${arbiter}/main`], cwd, {
				env,
			}).stdout.trim();
			expect(base).not.toBe('');
			const blob = run('git', ['hash-object', '-w', '--stdin'], cwd, {
				env,
				input: 'landed\n',
			}).stdout.trim();
			const index = join(scratch.root, 'scratch.index');
			const withIndex = {...env, GIT_INDEX_FILE: index};
			run('git', ['read-tree', base], cwd, {env: withIndex});
			run(
				'git',
				['update-index', '--add', '--cacheinfo', `100644,${blob},landed.txt`],
				cwd,
				{env: withIndex},
			);
			const tree = run('git', ['write-tree'], cwd, {
				env: withIndex,
			}).stdout.trim();
			const commit = run(
				'git',
				['commit-tree', tree, '-p', base, '-m', 'transition under test'],
				cwd,
				{env},
			).stdout.trim();
			const ref = 'refs/dorfl/test/verify';
			run('git', ['update-ref', ref, commit], cwd, {env});

			const notes: string[] = [];
			const result = await ledgerWrite.applyTransition({
				kind: 'needs-attention',
				arbiter,
				localBranch: ref,
				expectedBase: base,
				head: commit,
				cwd,
				env,
				note: (m) => notes.push(m),
			});

			// The write DID land on the arbiter...
			expect(arbiterMainSha(arbiterPath)).toBe(result.publishedHead);
			// ...so the verifier must say so.
			expect(result.kind).toBe('published');
			// And it must NOT have emitted the "not our commit / rejected" line about
			// its own successful write.
			expect(notes.join('\n')).not.toMatch(/treating as rejected/);
		});

		it('surfaces a stuck item in EXACTLY ONE commit, with no retry', async () => {
			const slug = 'surface-once';
			const {cwd, arbiter, arbiterPath} = makeFixture(slug);
			const env = gitEnv();
			const before = arbiterMainSubjects(arbiterPath).length;

			const notes: string[] = [];
			const surfaced = await surfaceStuckToNeedsAttention({
				cwd,
				slug,
				arbiter,
				reason: 'acceptance gate failed',
				env,
				note: (m) => notes.push(m),
			});

			expect(surfaced.surfaced).toBe(true);
			expect(surfaced.reasonNotSurfaced).toBeUndefined();

			// The retry loop must NOT have fired: no contention note, no "did not
			// land" terminal message.
			const log = notes.join('\n');
			expect(log).not.toMatch(/refetch and retry/);
			expect(log).not.toMatch(/treating as rejected/);
			expect(log).not.toMatch(/did not land/);

			// EXACTLY ONE commit landed (the field bug landed five).
			const subjects = arbiterMainSubjects(arbiterPath);
			expect(subjects.length).toBe(before + 1);
			expect(
				subjects.filter((s) => s.startsWith(`surface task:${slug} (stuck)`)),
			).toHaveLength(1);
		});

		it('is IDEMPOTENT at the commit level: re-surfacing the same bounce adds no commit', async () => {
			const slug = 'surface-idempotent';
			const {cwd, arbiter, arbiterPath} = makeFixture(slug);
			const env = gitEnv();
			const reason = 'acceptance gate failed the same way';

			const first = await surfaceStuckToNeedsAttention({
				cwd,
				slug,
				arbiter,
				reason,
				env,
			});
			expect(first.surfaced).toBe(true);
			const afterFirst = arbiterMainSubjects(arbiterPath).length;
			const shaAfterFirst = arbiterMainSha(arbiterPath);

			// Re-run the SAME surface (what the broken retry loop did five times).
			const second = await surfaceStuckToNeedsAttention({
				cwd,
				slug,
				arbiter,
				reason,
				env,
			});
			expect(second.surfaced).toBe(true);

			// No additional commit, and main did not move at all.
			expect(arbiterMainSubjects(arbiterPath).length).toBe(afterFirst);
			expect(arbiterMainSha(arbiterPath)).toBe(shaAfterFirst);

			// And the sidecar still carries exactly ONE copy of the bounce question.
			await refreshArbiterRefs({cwd, arbiter, branches: ['main'], env});
			const sidecar = run(
				'git',
				['show', `${arbiter}/main:work/questions/task-${slug}.md`],
				cwd,
				{env},
			);
			expect(sidecar.status).toBe(0);
			const model = parseSidecar(sidecar.stdout);
			expect(model.entries.filter((e) => e.context === reason)).toHaveLength(1);
		});

		it('still surfaces a DIFFERENT bounce reason for the same item', async () => {
			// The idempotence must be a de-duplication, not a swallow: a genuinely
			// new bounce reason has to reach the human.
			const slug = 'surface-second-reason';
			const {cwd, arbiter, arbiterPath} = makeFixture(slug);
			const env = gitEnv();

			await surfaceStuckToNeedsAttention({
				cwd,
				slug,
				arbiter,
				reason: 'first failure',
				env,
			});
			const afterFirst = arbiterMainSubjects(arbiterPath).length;

			const second = await surfaceStuckToNeedsAttention({
				cwd,
				slug,
				arbiter,
				reason: 'a DIFFERENT failure',
				env,
			});
			expect(second.surfaced).toBe(true);
			expect(arbiterMainSubjects(arbiterPath).length).toBe(afterFirst + 1);

			await refreshArbiterRefs({cwd, arbiter, branches: ['main'], env});
			const sidecar = run(
				'git',
				['show', `${arbiter}/main:work/questions/task-${slug}.md`],
				cwd,
				{env},
			).stdout;
			const model = parseSidecar(sidecar);
			expect(model.entries.map((e) => e.context)).toEqual(
				expect.arrayContaining(['first failure', 'a DIFFERENT failure']),
			);
		});

		it('leaves the surfaced item flagged needsAnswers on the arbiter', async () => {
			const slug = 'surface-flags-body';
			const {cwd, arbiter} = makeFixture(slug);
			const env = gitEnv();
			await surfaceStuckToNeedsAttention({
				cwd,
				slug,
				arbiter,
				reason: 'gate failed',
				env,
			});
			await refreshArbiterRefs({cwd, arbiter, branches: ['main'], env});
			const body = run(
				'git',
				['show', `${arbiter}/main:work/tasks/ready/${slug}.md`],
				cwd,
				{env},
			);
			expect(body.status).toBe(0);
			expect(parseFrontmatter(body.stdout).needsAnswers).toBe(true);
		});
	},
);

describe('arbiter-refs: the shared refresh + authoritative read', () => {
	it('resolves a branch the local tracking namespace does NOT have', async () => {
		// The exact read that used to fail: in a bare-mirror worktree there is no
		// `refs/remotes/origin/work/task-<slug>`, so `rev-parse` answered "absent"
		// for a branch sitting on the arbiter with an hour of work on it.
		const slug = 'authoritative-read';
		const {cwd, arbiter} = bareMirrorWorktree(slug);
		const env = gitEnv();

		writeFileSync(join(cwd, 'work-product.txt'), 'an hour of agent work\n');
		gitIn(['add', '-A'], cwd);
		gitIn(['commit', '-q', '-m', 'agent work'], cwd);
		gitIn(['push', '-q', 'origin', `work/task-${slug}`], cwd);

		// The OLD probe: a plain fetch (which errors here) + a tracking-ref read.
		const plainFetch = run('git', ['fetch', '--quiet', arbiter], cwd, {env});
		expect(plainFetch.status).not.toBe(0);
		expect(plainFetch.stderr).toMatch(/refusing to fetch into branch/);
		const staleProbe = run(
			'git',
			[
				'rev-parse',
				'--verify',
				'--quiet',
				`${arbiter}/work/task-${slug}^{commit}`,
			],
			cwd,
			{env},
		);
		expect(staleProbe.status).not.toBe(0); // the false "no work branch" answer.

		// The NEW read is arbiter-authoritative and finds it.
		const resolved = await resolveArbiterBranch({
			cwd,
			arbiter,
			branch: `work/task-${slug}`,
			env,
		});
		expect(resolved.authority).toBe('arbiter');
		expect(resolved.trustworthy).toBe(true);
		expect(resolved.sha).toBeTruthy();
	});

	it('reports a genuinely absent branch as a TRUSTWORTHY absence', async () => {
		const slug = 'genuinely-absent';
		const {cwd, arbiter} = plainClone(slug);
		const resolved = await resolveArbiterBranch({
			cwd,
			arbiter,
			branch: 'work/task-never-pushed',
			env: gitEnv(),
		});
		expect(resolved.authority).toBe('absent');
		expect(resolved.trustworthy).toBe(true);
		expect(resolved.sha).toBeUndefined();
	});

	it('flags an UNREACHABLE arbiter as untrustworthy rather than absent', async () => {
		// The dangerous direction: an unreadable arbiter must never be reported as
		// "there is nothing to continue from", because acting on that discards work.
		const slug = 'unreachable-arbiter';
		const {cwd} = plainClone(slug);
		const resolved = await resolveArbiterBranch({
			cwd,
			arbiter: 'no-such-remote',
			branch: 'work/task-x',
			env: gitEnv(),
		});
		expect(resolved.trustworthy).toBe(false);
		expect(resolved.unreachableDetail).toBeTruthy();
	});

	it('prune-fetches into the tracking namespace even from a bare-mirror worktree', async () => {
		const slug = 'refresh-populates';
		const {cwd, arbiter} = bareMirrorWorktree(slug);
		const env = gitEnv();
		expect(
			existsSync(join(cwd, '.git')) || existsSync(join(cwd, '.git/')),
		).toBe(true);

		// Nothing in the tracking namespace to begin with.
		const before = run(
			'git',
			['rev-parse', '--verify', '--quiet', `${arbiter}/main`],
			cwd,
			{env},
		);
		expect(before.status).not.toBe(0);

		await refreshArbiterRefs({cwd, arbiter, branches: ['main'], env});

		const after = run('git', ['rev-parse', `${arbiter}/main`], cwd, {env});
		expect(after.status).toBe(0);
		expect(after.stdout.trim()).toHaveLength(40);
	});
});
