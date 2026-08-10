import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {join} from 'node:path';
import {existsSync, writeFileSync} from 'node:fs';
import {
	encodeRepoKey,
	mirrorPath,
	ensureMirror,
	ensureMirrorMain,
	mirrorMainSha,
	readRepoConfigFromMirrorMain,
} from '../src/repo-mirror.js';
import {git, run} from '../src/git.js';
import {acquireItemLock, itemLockRef, lockEntryFor} from '../src/item-lock.js';
import {
	makeScratch,
	seedRepoWithArbiter,
	gitEnv,
	gitIn,
	type Scratch,
} from './helpers/gitRepo.js';

let scratch: Scratch;
beforeEach(() => {
	scratch = makeScratch('dorfl-mirror-');
});
afterEach(() => {
	scratch.cleanup();
});

describe('encodeRepoKey', () => {
	it('encodes an ssh URL: drop scheme/user/.git, dot→dash per segment, hierarchical', () => {
		expect(encodeRepoKey('git@github.com:wighawag/dorfl.git')).toBe(
			'github-com/wighawag/dorfl',
		);
	});

	it('encodes an https URL', () => {
		expect(encodeRepoKey('https://github.com/wighawag/dorfl.git')).toBe(
			'github-com/wighawag/dorfl',
		);
	});

	it('is stable with or without the .git suffix', () => {
		expect(encodeRepoKey('https://github.com/wighawag/dorfl')).toBe(
			encodeRepoKey('https://github.com/wighawag/dorfl.git'),
		);
	});

	it('replaces dots per segment, not across the whole path (lossless)', () => {
		// A host AND an org both containing dots must each be dashed independently.
		expect(encodeRepoKey('git@my.host.io:my.org/some.repo.git')).toBe(
			'my-host-io/my-org/some-repo',
		);
	});

	it('encodes an ssh:// URL with an explicit port', () => {
		expect(
			encodeRepoKey('ssh://git@gitlab.example.com:2222/group/sub/proj.git'),
		).toBe('gitlab-example-com/group/sub/proj');
	});

	it('encodes a file:// bare arbiter URL', () => {
		expect(encodeRepoKey('file:///home/me/git/host.com/org/repo.git')).toBe(
			'home/me/git/host-com/org/repo',
		);
	});

	it('encodes a plain local path to a bare repo', () => {
		expect(encodeRepoKey('/srv/git/org/repo.git')).toBe('srv/git/org/repo');
	});

	it('is deterministic: same input → same key', () => {
		const url = 'git@github.com:wighawag/dorfl.git';
		expect(encodeRepoKey(url)).toBe(encodeRepoKey(url));
	});
});

describe('mirrorPath', () => {
	it('locates <workspacesDir>/repos/<key>.git', () => {
		const p = mirrorPath(
			'/home/me/.dorfl',
			'git@github.com:wighawag/dorfl.git',
		);
		expect(p).toBe('/home/me/.dorfl/repos/github-com/wighawag/dorfl.git');
	});

	it('lives under workspacesDir, never ~/.cache', () => {
		const p = mirrorPath('/home/me/.dorfl', 'https://github.com/o/r.git');
		expect(p.startsWith('/home/me/.dorfl/')).toBe(true);
		expect(p).not.toMatch(/\.cache/);
	});
});

describe('ensureMirror', () => {
	it('creates a bare mirror under workspacesDir/repos/<key>.git when absent', () => {
		const {arbiter} = seedRepoWithArbiter(scratch.root, ['feat']);
		const url = `file://${arbiter}`;
		const workspacesDir = join(scratch.root, '.dorfl');

		const result = ensureMirror({url, workspacesDir, env: gitEnv()});

		expect(result.created).toBe(true);
		expect(result.fetched).toBe(false);
		expect(result.path).toBe(mirrorPath(workspacesDir, url));
		expect(existsSync(result.path)).toBe(true);
		// It is a bare repo (no working tree).
		const isBare = git(['rev-parse', '--is-bare-repository'], result.path, {
			env: gitEnv(),
		}).trim();
		expect(isBare).toBe('true');
		// It has the arbiter's main.
		expect(result.mainSha).toMatch(/^[0-9a-f]{40}$/);
	});

	it('on a second call fetches and reuses the same mirror (no re-clone)', () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['feat']);
		const url = `file://${arbiter}`;
		const workspacesDir = join(scratch.root, '.dorfl');

		const first = ensureMirror({url, workspacesDir, env: gitEnv()});
		expect(first.created).toBe(true);

		// Drop a sentinel inside the bare mirror; a re-clone would wipe it.
		const sentinel = join(first.path, 'SENTINEL');
		writeFileSync(sentinel, 'do-not-reclone\n');

		// Advance the arbiter's main with a new commit.
		writeFileSync(join(repo, 'NEW.md'), '# new\n');
		gitIn(['add', '-A'], repo);
		gitIn(['commit', '-q', '-m', 'advance main'], repo);
		gitIn(['push', '-q', 'arbiter', 'main'], repo);

		const second = ensureMirror({url, workspacesDir, env: gitEnv()});

		// Reused the same path; fetched (not created); sentinel survived.
		expect(second.created).toBe(false);
		expect(second.fetched).toBe(true);
		expect(second.path).toBe(first.path);
		expect(existsSync(sentinel)).toBe(true);
		// The fetched main reflects the new commit.
		expect(second.mainSha).not.toBe(first.mainSha);
	});

	it('is idempotent: repeated calls without remote changes keep the same main', () => {
		const {arbiter} = seedRepoWithArbiter(scratch.root, ['feat']);
		const url = `file://${arbiter}`;
		const workspacesDir = join(scratch.root, '.dorfl');

		const a = ensureMirror({url, workspacesDir, env: gitEnv()});
		const b = ensureMirror({url, workspacesDir, env: gitEnv()});
		const c = ensureMirror({url, workspacesDir, env: gitEnv()});
		expect(b.created).toBe(false);
		expect(c.created).toBe(false);
		expect(a.mainSha).toBe(b.mainSha);
		expect(b.mainSha).toBe(c.mainSha);
	});

	it('resolves the remote URL from a repo when given fromRepo + arbiter remote', () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['feat']);
		const workspacesDir = join(scratch.root, '.dorfl');

		const result = ensureMirror({
			fromRepo: repo,
			arbiter: 'arbiter',
			workspacesDir,
			env: gitEnv(),
		});
		expect(result.created).toBe(true);
		expect(result.path).toBe(mirrorPath(workspacesDir, `file://${arbiter}`));
		expect(result.mainSha).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe('ensureMirrorMain — main-only, no-prune mirror-ensure for the config read', () => {
	it('creates the bare mirror when absent (like ensureMirror)', () => {
		const {arbiter} = seedRepoWithArbiter(scratch.root, ['feat']);
		const url = `file://${arbiter}`;
		const workspacesDir = join(scratch.root, '.dorfl');

		const result = ensureMirrorMain({url, workspacesDir, env: gitEnv()});

		expect(result.created).toBe(true);
		expect(result.fetched).toBe(false);
		expect(result.path).toBe(mirrorPath(workspacesDir, url));
		expect(existsSync(result.path)).toBe(true);
		expect(result.mainSha).toMatch(/^[0-9a-f]{40}$/);
	});

	it('on reuse refreshes ONLY main (no-prune), reflecting the new arbiter main', () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['feat']);
		const url = `file://${arbiter}`;
		const workspacesDir = join(scratch.root, '.dorfl');

		const first = ensureMirrorMain({url, workspacesDir, env: gitEnv()});
		expect(first.created).toBe(true);

		writeFileSync(join(repo, 'NEW.md'), '# new\n');
		gitIn(['add', '-A'], repo);
		gitIn(['commit', '-q', '-m', 'advance main'], repo);
		gitIn(['push', '-q', 'arbiter', 'main'], repo);

		const second = ensureMirrorMain({url, workspacesDir, env: gitEnv()});
		expect(second.created).toBe(false);
		expect(second.fetched).toBe(true);
		expect(second.path).toBe(first.path);
		expect(second.mainSha).not.toBe(first.mainSha);
	});

	/**
	 * The load-bearing regression (the task's defect #1): a stale job worktree with
	 * a checked-out `work/<other-slug>` branch in the mirror BLOCKS the all-heads
	 * pruning fetch (`ensureMirror`) — git refuses to fetch into a checked-out
	 * branch — but does NOT block the main-only no-prune `ensureMirrorMain`.
	 */
	it('a checked-out work/<other-slug> worktree does NOT block ensureMirror (main still refreshes; the checked-out head is left untouched)', () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['feat']);
		const url = `file://${arbiter}`;
		const workspacesDir = join(scratch.root, '.dorfl');
		const env = gitEnv();

		// Seed an arbiter branch `work/other` (a different task's work branch).
		gitIn(['switch', '-q', '-c', 'work/other', 'main'], repo);
		writeFileSync(join(repo, 'OTHER.md'), '# other\n');
		gitIn(['add', '-A'], repo);
		gitIn(['commit', '-q', '-m', 'other work'], repo);
		gitIn(['push', '-q', 'arbiter', 'work/other'], repo);
		gitIn(['switch', '-q', 'main'], repo);

		// Create the mirror with the all-heads fetch (so it carries `work/other`
		// locally), then check that branch out in a stale worktree — modelling a
		// previous failed run's un-reaped job worktree.
		const mirror = ensureMirror({url, workspacesDir, env});
		const stale = join(scratch.root, 'stale-worktree');
		gitIn(['worktree', 'add', stale, 'work/other'], mirror.path);

		// Advance the arbiter's `work/other` so the next all-heads fetch would try to
		// UPDATE the checked-out local branch (which git refuses).
		gitIn(['switch', '-q', 'work/other'], repo);
		writeFileSync(join(repo, 'OTHER.md'), '# other v2\n');
		gitIn(['add', '-A'], repo);
		gitIn(['commit', '-q', '-m', 'other work v2'], repo);
		gitIn(['push', '-q', 'arbiter', 'work/other'], repo);
		gitIn(['switch', '-q', 'main'], repo);

		// SHARED-MIRROR SIBLING-WORKTREE SAFETY (task
		// `cutover-claim-body-stays-and-complete-sources-from-backlog`): `ensureMirror`
		// no longer FAILS when a sibling worktree holds a `work/<slug>` head checked
		// out (git refuses to update THAT head, but the all-heads fetch is now
		// BEST-EFFORT, so every OTHER ref — incl. `main` — still updates). Before this
		// task the claim's body-move serialised same-repo jobs enough to hide the
		// overlap; with claim no longer writing `main` they run concurrently and a
		// throwing ensure would crash a sibling job's onboard.
		const otherBefore = gitIn(['rev-parse', 'work/other'], mirror.path).trim();
		const result = ensureMirror({url, workspacesDir, env});
		expect(result.fetched).toBe(true);
		expect(result.mainSha).toMatch(/^[0-9a-f]{40}$/);
		// The checked-out `work/other` head was NOT updated (git refused that ONE ref),
		// but the ensure did not throw.
		expect(gitIn(['rev-parse', 'work/other'], mirror.path).trim()).toBe(
			otherBefore,
		);

		// The narrowed config-read path (main-only, no-prune) is likewise NOT blocked.
		const readResult = ensureMirrorMain({url, workspacesDir, env});
		expect(readResult.fetched).toBe(true);
		expect(readResult.mainSha).toMatch(/^[0-9a-f]{40}$/);
	});

	it('the config read SUCCEEDS through ensureMirrorMain even with a checked-out work/<other-slug>', () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['feat'], {
			repoConfig: {harness: 'pi', verify: 'echo gate'},
		});
		const url = `file://${arbiter}`;
		const workspacesDir = join(scratch.root, '.dorfl');
		const env = gitEnv();

		// A different task's work branch, on the arbiter + checked out in a stale
		// worktree on the mirror.
		gitIn(['switch', '-q', '-c', 'work/other', 'main'], repo);
		writeFileSync(join(repo, 'OTHER.md'), '# other\n');
		gitIn(['add', '-A'], repo);
		gitIn(['commit', '-q', '-m', 'other work'], repo);
		gitIn(['push', '-q', 'arbiter', 'work/other'], repo);
		gitIn(['switch', '-q', 'main'], repo);

		const mirror = ensureMirror({url, workspacesDir, env});
		const stale = join(scratch.root, 'stale-worktree');
		gitIn(['worktree', 'add', stale, 'work/other'], mirror.path);
		gitIn(['switch', '-q', 'work/other'], repo);
		writeFileSync(join(repo, 'OTHER.md'), '# other v2\n');
		gitIn(['add', '-A'], repo);
		gitIn(['commit', '-q', '-m', 'other v2'], repo);
		gitIn(['push', '-q', 'arbiter', 'work/other'], repo);
		gitIn(['switch', '-q', 'main'], repo);

		// Refresh main via the narrowed ensure, then read the config — it resolves the
		// per-repo `harness`/`verify` instead of failing into global+default.
		const result = ensureMirrorMain({url, workspacesDir, env});
		const content = readRepoConfigFromMirrorMain(result.path, env);
		expect(content).toBeDefined();
		const parsed = JSON.parse(content as string) as Record<string, unknown>;
		expect(parsed.harness).toBe('pi');
		expect(parsed.verify).toBe('echo gate');
	});
});

describe('mirrorMainSha', () => {
	it('returns the mirror main after a fetch (the fresh arbiter main)', () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['feat']);
		const url = `file://${arbiter}`;
		const workspacesDir = join(scratch.root, '.dorfl');
		const result = ensureMirror({url, workspacesDir, env: gitEnv()});

		const arbiterMain = gitIn(['rev-parse', 'main'], repo).trim();
		expect(mirrorMainSha(result.path, gitEnv())).toBe(arbiterMain);
		expect(result.mainSha).toBe(arbiterMain);
	});
});

// --- gc-ledger-reports-mirror-stale-lock-refs-as-arbiter-state (mirror prune) --
//
// Regression: `ensureMirror` fetched only `refs/heads/*` (and `main`), NEVER
// `refs/dorfl/lock/*`, so a lock released on the arbiter (its ref deleted there)
// survived on the mirror indefinitely. Any reader that read the mirror's local
// lock refs (the `gc --ledger` report, `status`/`scan`) then reported locks that
// did not exist on the arbiter. `ensureMirror` now PRUNES the per-item lock
// namespace against the arbiter on every sync, so released locks cannot
// accumulate on the mirror.

describe('ensureMirror — prunes refs/dorfl/lock/* against the arbiter (no stale accumulation)', () => {
	it('a lock released on the arbiter is PRUNED from the mirror on the next sync', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['feat']);
		const url = `file://${arbiter}`;
		const workspacesDir = join(scratch.root, '.dorfl');

		// Create the mirror.
		const first = ensureMirror({url, workspacesDir, env: gitEnv()});
		expect(first.created).toBe(true);

		// Acquire a lock on the arbiter (the real ref lands on the arbiter).
		const acq = await acquireItemLock({
			item: 'task:feat',
			action: 'implement',
			cwd: repo,
			arbiter: 'arbiter',
			env: gitEnv(),
		});
		expect(acq.outcome).toBe('acquired');
		const entry = lockEntryFor('task:feat');
		const ref = itemLockRef(entry);

		// Pull the lock ref INTO the mirror's local refs/dorfl/lock/* (the
		// accumulated state a pre-fix unpruned sync left behind on the mirror).
		run('git', ['fetch', '-q', 'origin', `+${ref}:${ref}`], first.path, {
			env: gitEnv(),
		});
		const mirrorHeld = run(
			'git',
			['rev-parse', '--verify', '--quiet', ref],
			first.path,
			{env: gitEnv()},
		);
		expect(mirrorHeld.status).toBe(0); // the mirror now holds the lock ref

		// Release the lock on the ARBITER ONLY (delete the ref on the arbiter; the
		// mirror's local copy is left stale — the defect's accumulated state).
		run('git', ['push', '-q', 'arbiter', `:${ref}`], repo, {env: gitEnv()});
		// The arbiter no longer holds it ...
		const arbiterHeld = run('git', ['ls-remote', 'origin', ref], first.path, {
			env: gitEnv(),
		});
		expect(arbiterHeld.stdout.trim()).toBe('');
		// ... but the mirror's STALE local ref is still there before the sync.
		const staleBefore = run(
			'git',
			['rev-parse', '--verify', '--quiet', ref],
			first.path,
			{env: gitEnv()},
		);
		expect(staleBefore.status).toBe(0);

		// Re-sync the mirror. ensureMirror now PRUNES refs/dorfl/lock/* against the
		// arbiter, so the released lock's ref is REMOVED from the mirror.
		const second = ensureMirror({url, workspacesDir, env: gitEnv()});
		expect(second.fetched).toBe(true);
		const staleAfter = run(
			'git',
			['rev-parse', '--verify', '--quiet', ref],
			first.path,
			{env: gitEnv()},
		);
		expect(staleAfter.status).not.toBe(0); // pruned — the mirror no longer holds it
	});
});
