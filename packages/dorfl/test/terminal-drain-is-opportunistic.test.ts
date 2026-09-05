import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdirSync, writeFileSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
import {performClaim} from '../src/claim-cas.js';
import {reconcileTerminalState} from '../src/reconcile-terminal.js';
import {newSidecar, serialiseSidecar} from '../src/sidecar.js';
import {run} from '../src/git.js';
import {
	makeScratch,
	seedRepoWithArbiter,
	gitEnv,
	gitIn,
	rmrf,
	type Scratch,
} from './helpers/gitRepo.js';
let scratch: Scratch;
beforeEach(() => {
	scratch = makeScratch('b1-');
});
afterEach(() => {
	scratch.cleanup();
});
function seedResidue(arbiter: string) {
	const env = gitEnv();
	const dest = join(scratch.root, 'seed');
	run('git', ['clone', '-q', `file://${arbiter}`, dest], scratch.root, {env});
	run('git', ['checkout', '-q', '-B', 's', 'origin/main'], dest, {env});
	for (const [rel, c] of Object.entries({
		'work/tasks/done/shipped.md': '---\nneedsAnswers: true\n---\n',
		'work/questions/task-shipped.md': serialiseSidecar(
			newSidecar('task:shipped', [
				{question: 'cancel?', context: 'x', default: 'yes', kind: 'stuck'},
			]),
		),
	})) {
		const abs = join(dest, rel);
		mkdirSync(join(abs, '..'), {recursive: true});
		writeFileSync(abs, c as string);
	}
	run('git', ['add', '-A'], dest, {env});
	run('git', ['commit', '-q', '-m', 'seed'], dest, {env});
	run('git', ['push', '-q', 'origin', 's:main'], dest, {env});
	rmrf(dest);
}
/** Make the arbiter REFUSE every write to refs/heads/main (a protected branch). */
function protectMain(arbiter: string) {
	const hook = join(arbiter, 'hooks', 'pre-receive');
	mkdirSync(join(arbiter, 'hooks'), {recursive: true});
	writeFileSync(
		hook,
		'#!/bin/sh\nwhile read o n r; do case "$r" in refs/heads/main) echo "protected" >&2; exit 1;; esac; done\nexit 0\n',
	);
	chmodSync(hook, 0o755);
}
describe('the drain is opportunistic hygiene: a fault never fails the caller', () => {
	it('claims successfully when main is PROTECTED and the drain cannot land', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['next']);
		seedResidue(arbiter);
		protectMain(arbiter);
		gitIn(['fetch', '-q', 'arbiter'], repo);
		const claim = await performClaim({
			slug: 'next',
			cwd: repo,
			arbiter: 'arbiter',
			env: gitEnv(),
		});
		// The claim, which is the caller's REAL work, is unaffected.
		expect(claim.exitCode).toBe(0);
		expect(claim.outcome).toBe('claimed');
		const lock = run(
			'git',
			['ls-remote', `file://${arbiter}`, 'refs/dorfl/lock/task-next'],
			scratch.root,
			{env: gitEnv()},
		).stdout.trim();
		expect(lock).not.toBe('');
		// ...and the residue is left EXACTLY as it was (the safe direction).
		gitIn(['fetch', '-q', 'arbiter'], repo);
		expect(
			run(
				'git',
				['cat-file', '-e', 'arbiter/main:work/questions/task-shipped.md'],
				repo,
				{env: gitEnv()},
			).status,
		).toBe(0);
	});
	it('a D/F scratch-ref conflict is REPORTED, never thrown (it must not fail a claim)', async () => {
		// The concrete fault a review found: a pre-existing loose ref at
		// `refs/dorfl/question-drain` makes the scratch ref `.../batch` un-creatable,
		// and the git plumbing inside the plan throws. Unguarded, that propagated out
		// of the claim path and surfaced as exit 1 / usage-error WITH NO LOCK TAKEN,
		// i.e. an unrelated hygiene fault refusing the operator's actual work.
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['next']);
		seedResidue(arbiter);
		gitIn(['fetch', '-q', 'arbiter'], repo);
		const head = run('git', ['rev-parse', 'HEAD'], repo, {
			env: gitEnv(),
		}).stdout.trim();
		run('git', ['update-ref', 'refs/dorfl/question-drain', head], repo, {
			env: gitEnv(),
		});

		const claim = await performClaim({
			slug: 'next',
			cwd: repo,
			arbiter: 'arbiter',
			env: gitEnv(),
		});

		expect(claim.exitCode).toBe(0);
		expect(claim.outcome).toBe('claimed');
		const lock = run(
			'git',
			['ls-remote', `file://${arbiter}`, 'refs/dorfl/lock/task-next'],
			scratch.root,
			{env: gitEnv()},
		).stdout.trim();
		expect(lock).not.toBe('');
	});

	it('reconcileTerminalState never throws, even against a broken cwd', async () => {
		const notARepo = join(scratch.root, 'nope');
		mkdirSync(notARepo, {recursive: true});
		const r = await reconcileTerminalState({
			cwd: notARepo,
			arbiter: 'arbiter',
			env: gitEnv(),
		});
		expect(r.locks.released).toEqual([]);
		expect(r.questions.drained).toEqual([]);
	});
});
