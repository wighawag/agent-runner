import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {resolveCwdSection, cwdSectionDisposition} from '../src/cwd-section.js';
import {formatReport, formatCwdSection} from '../src/format.js';
import {status, formatStatus} from '../src/status.js';
import {scan} from '../src/scan.js';
import {mergeConfig} from '../src/config.js';
import {mirrorPath} from '../src/repo-mirror.js';
import {acquireItemLock, markStuckItemLock} from '../src/item-lock.js';
import {formatCwdSection as formatCwd} from '../src/format.js';
import {makeScratch, gitIn, type Scratch} from './helpers/gitRepo.js';

let scratch: Scratch;
beforeEach(() => {
	scratch = makeScratch('dorfl-cwd-section-');
});
afterEach(() => {
	scratch.cleanup();
});

function workspacesDir(): string {
	return join(scratch.root, '.dorfl');
}

function config() {
	return mergeConfig({workspacesDir: workspacesDir(), autoBuild: true});
}

/** A minimal task body for `work/tasks/ready/<slug>.md`. */
function task(slug: string, extra: Record<string, string> = {}): string {
	const lines = ['---', `title: ${slug}`, `slug: ${slug}`];
	for (const [k, v] of Object.entries(extra)) {
		lines.push(`${k}: ${v}`);
	}
	lines.push('blockedBy: []', '---', '', 'body');
	return lines.join('\n');
}

/**
 * Build a participating working repo with a sibling local `--bare` arbiter wired
 * as the `arbiter` remote, seeding the given backlog tasks. Returns the repo +
 * arbiter paths.
 */
function seedCwdRepo(
	backlog: Record<string, string>,
	opts: {dir?: string} = {},
): {repo: string; arbiter: string} {
	const repo = join(scratch.root, opts.dir ?? 'project');
	mkdirSync(join(repo, 'work', 'tasks', 'ready'), {recursive: true});
	gitIn(['init', '-q', '-b', 'main'], repo);
	for (const [file, content] of Object.entries(backlog)) {
		writeFileSync(join(repo, 'work', 'tasks', 'ready', file), content);
	}
	writeFileSync(join(repo, 'README.md'), '# project\n');
	gitIn(['add', '-A'], repo);
	gitIn(['commit', '-q', '-m', 'seed'], repo);

	const arbiter = join(scratch.root, `${opts.dir ?? 'project'}.git`);
	gitIn(['clone', '-q', '--bare', repo, arbiter], scratch.root);
	gitIn(['remote', 'add', 'arbiter', `file://${arbiter}`], repo);
	gitIn(['fetch', '-q', 'arbiter'], repo);
	return {repo, arbiter};
}

/** Register the cwd repo's arbiter as a hub mirror (so it is "also registered"). */
function registerArbiterAsMirror(arbiter: string): string {
	const url = `file://${arbiter}`;
	const dest = mirrorPath(workspacesDir(), url);
	mkdirSync(dirname(dest), {recursive: true});
	gitIn(['clone', '-q', '--bare', url, dest], dirname(dest));
	return dest;
}

/** Add an UNPUSHED commit on the cwd repo's local `main` (diverges from arbiter). */
function addUnpushedCommit(repo: string): void {
	writeFileSync(join(repo, 'unpushed.txt'), 'local only\n');
	gitIn(['add', '-A'], repo);
	gitIn(['commit', '-q', '-m', 'unpushed local work'], repo);
}

describe('resolveCwdSection — cwd participation', () => {
	it('reports a participating cwd as a separate local section with its own count', async () => {
		const {repo} = seedCwdRepo({
			'a.md': task('a'),
			'b.md': task('b', {humanOnly: 'true'}),
		});
		const section = await resolveCwdSection({cwd: repo, config: config()});
		expect(section.participating).toBe(true);
		expect(section.path).toBe(repo);
		expect(section.totalItems).toBe(2);
		expect(section.repo?.items.map((i) => i.slug).sort()).toEqual(['a', 'b']);
	});

	it('returns {participating:false} OUTSIDE a participating repo (no section)', async () => {
		const notRepo = join(scratch.root, 'empty');
		mkdirSync(notRepo, {recursive: true});
		const section = await resolveCwdSection({cwd: notRepo, config: config()});
		expect(section.participating).toBe(false);
		expect(section.repo).toBeUndefined();
	});
});

describe('resolveCwdSection: stranded question state is REPORTED, never cleared', () => {
	/**
	 * `status` is READ-ONLY: it must SURFACE a stranded `needsAnswers` gate on a
	 * shipped item (so the residue is visible) while writing nothing. The gate can
	 * outlive its sidecar, so the report must cover the flag-only shape too, not
	 * just a stale sidecar.
	 */
	it('names a terminal item whose needsAnswers gate is armed with NO sidecar', async () => {
		const {repo} = seedCwdRepo({'a.md': task('a')});
		// A shipped task still carrying the gate, with no sidecar beside it.
		const done = join(repo, 'work', 'tasks', 'done');
		mkdirSync(done, {recursive: true});
		writeFileSync(
			join(done, 'shipped.md'),
			task('shipped', {needsAnswers: 'true'}),
		);
		gitIn(['add', '-A'], repo);
		gitIn(['commit', '-q', '-m', 'ship it'], repo);
		gitIn(['push', '-q', 'arbiter', 'main:main'], repo);

		const section = await resolveCwdSection({
			cwd: repo,
			config: config(),
			lockArbiterRemote: 'arbiter',
		});

		expect(section.staleQuestions).toContain('task:shipped');
		// READ-ONLY: the gate is still armed on `main` after a status read.
		expect(
			gitIn(['show', 'arbiter/main:work/tasks/done/shipped.md'], repo),
		).toMatch(/needsAnswers: true/);
		// And it is rendered for the human.
		const out = formatCwdSection(section).join('\n');
		expect(out).toMatch(/question state not yet cleared/);
		expect(out).toMatch(/task:shipped/);
	});

	it('does NOT name a pool item that merely carries the gate', async () => {
		// The legal pre-surface state: flagged, unsurfaced, resting in the pool.
		const {repo} = seedCwdRepo({'a.md': task('a', {needsAnswers: 'true'})});
		gitIn(['push', '-q', 'arbiter', 'main:main'], repo);

		const section = await resolveCwdSection({
			cwd: repo,
			config: config(),
			lockArbiterRemote: 'arbiter',
		});

		expect(section.staleQuestions ?? []).toEqual([]);
	});
});

describe('resolveCwdSection — fetch-first + divergence (main-divergence-guard framing)', () => {
	it('fetches the cwd arbiter first and reports a clean (in-sync) divergence', async () => {
		const {repo} = seedCwdRepo({'a.md': task('a')});
		const section = await resolveCwdSection({cwd: repo, config: config()});
		expect(section.arbiter?.configured).toBe(true);
		expect(section.arbiter?.fetched).toBe(true);
		expect(section.arbiter?.ahead).toBe(0);
		expect(section.arbiter?.behind).toBe(0);
	});

	it('shows local main AHEAD of the arbiter when there is unpushed work', async () => {
		const {repo} = seedCwdRepo({'a.md': task('a')});
		addUnpushedCommit(repo);
		const section = await resolveCwdSection({cwd: repo, config: config()});
		expect(section.arbiter?.ahead).toBe(1);
		const out = formatCwdSection(section).join('\n');
		expect(out).toMatch(/1 commit ahead \(unpushed\)/);
		expect(out).toMatch(/arbiter\/main/);
	});

	it('the DIVERGENCE line warns + falls back offline, but SELECTION fails closed (the held-lock read throws)', async () => {
		const {repo} = seedCwdRepo({'a.md': task('a')});
		// Point the coordination (lock) arbiter at a path that does not exist ⇒ the
		// held-lock fetch fails.
		gitIn(
			['remote', 'set-url', 'arbiter', 'file:///nonexistent/gone.git'],
			repo,
		);
		const warnings: string[] = [];
		// The SELECTION pool needs the coordination arbiter's held-lock set; an
		// unreachable (but configured) lock remote makes eligibility UNKNOWN, so the
		// section THROWS rather than emit a confident-but-wrong eligible pool (offline
		// selection fails; there is NO --local fallback). The divergence fetch still
		// warned first.
		await expect(
			resolveCwdSection({
				cwd: repo,
				config: config(),
				arbiterRemote: 'arbiter',
				lockArbiterRemote: 'arbiter',
				warn: (m) => warnings.push(m),
			}),
		).rejects.toThrow();
		expect(warnings.some((w) => /fetch|offline|last-known/i.test(w))).toBe(
			true,
		);
	});
});

describe('resolveCwdSection — held-lock subtraction (SELECTION is remote-authoritative)', () => {
	it('SUBTRACTS an in-flight (lock-held) task from the cwd eligible pool', async () => {
		const {repo} = seedCwdRepo({'a.md': task('a'), 'b.md': task('b')});
		// Hold the per-item lock for `a` on the coordination arbiter (the `arbiter`
		// remote this fixture wires). `a` is in-flight and must NOT be eligible.
		const held = await acquireItemLock({
			item: 'task:a',
			action: 'implement',
			cwd: repo,
			arbiter: 'arbiter',
		});
		expect(held.outcome).toBe('acquired');

		const section = await resolveCwdSection({
			cwd: repo,
			config: config(),
			lockArbiterRemote: 'arbiter',
		});
		// `a`'s lock is held → subtracted from the pool entirely; only `b` remains.
		expect(section.repo?.items.map((i) => i.slug).sort()).toEqual(['b']);
		expect(section.totalItems).toBe(1);
		expect(section.totalEligible).toBe(1);
	});

	it('reads locks from the COORDINATION remote, not the DIVERGENCE remote (the origin-is-arbiter shape)', async () => {
		// The exact production shape that broke CI: the repo's arbiter IS its only
		// remote, and there is NO separate `arbiter`-named divergence remote. The
		// held-lock read must still find the lock via the coordination remote, NOT
		// silently subtract nothing because the divergence remote is absent.
		const {repo} = seedCwdRepo({'a.md': task('a'), 'b.md': task('b')});
		// Rename the wired remote `arbiter` -> `origin` so there is no `arbiter` remote
		// at all (divergence resolution returns undefined), exactly like this repo.
		gitIn(['remote', 'rename', 'arbiter', 'origin'], repo);
		const held = await acquireItemLock({
			item: 'task:a',
			action: 'implement',
			cwd: repo,
			arbiter: 'origin',
		});
		expect(held.outcome).toBe('acquired');

		// No lockArbiterRemote override → defaults to `origin` (the coordination
		// arbiter), even though the `arbiter`-named divergence remote does not exist.
		const section = await resolveCwdSection({cwd: repo, config: config()});
		expect(section.arbiter).toBeUndefined(); // no `arbiter` divergence remote
		expect(section.repo?.items.map((i) => i.slug).sort()).toEqual(['b']);
		expect(section.totalEligible).toBe(1);
	});

	it('subtracts NOTHING when no locks are held (every ready task stays eligible)', async () => {
		const {repo} = seedCwdRepo({'a.md': task('a'), 'b.md': task('b')});
		const section = await resolveCwdSection({
			cwd: repo,
			config: config(),
			lockArbiterRemote: 'arbiter',
		});
		expect(section.repo?.items.map((i) => i.slug).sort()).toEqual(['a', 'b']);
		expect(section.totalEligible).toBe(2);
	});
});

describe('resolveCwdSection — in-flight/stuck SURFACE (held item is not invisible)', () => {
	// The regression this guards: the cwd path gained the held-slug SUBTRACTION
	// (selection fix) WITHOUT the matching in-flight/stuck SURFACE the mirror path
	// already has, so a held/stuck `tasks/ready/` slug vanished from every bucket
	// with nothing explaining why. The fix attaches `lockHeld` to the cwd
	// `RepoReport` (via the SAME `listItemLockEntries` primitive) and renders it.
	it('surfaces a held (active) cwd item on .cwd.repo.lockHeld AND excludes it from items[]', async () => {
		const {repo} = seedCwdRepo({'a.md': task('a'), 'b.md': task('b')});
		const held = await acquireItemLock({
			item: 'task:a',
			action: 'implement',
			cwd: repo,
			arbiter: 'arbiter',
		});
		expect(held.outcome).toBe('acquired');

		const section = await resolveCwdSection({
			cwd: repo,
			config: config(),
			lockArbiterRemote: 'arbiter',
		});
		// SELECTION unchanged: `a` is still subtracted from the eligible pool.
		expect(section.repo?.items.map((i) => i.slug).sort()).toEqual(['b']);
		// SURFACE added: `a` is now visible as an in-flight lock entry.
		expect(section.repo?.lockHeld?.map((e) => e.entry)).toEqual(['task-a']);
		expect(section.repo?.lockHeld?.[0].state).toBe('active');
	});

	it('renders a held (active) cwd item in the in-flight block (post retire-stuck-lock-state: no `stuck` state, no reason on the entry)', async () => {
		const {repo} = seedCwdRepo({
			'apply-rung-merge-disposition.md': task('apply-rung-merge-disposition'),
		});
		await acquireItemLock({
			item: 'task:apply-rung-merge-disposition',
			action: 'implement',
			cwd: repo,
			arbiter: 'arbiter',
		});
		// The shim `markStuckItemLock` no-ops post-retirement (kept for source
		// compat of tests that used to seed a stuck lock). The lock stays active.
		const shim = await markStuckItemLock({
			item: 'task:apply-rung-merge-disposition',
			reason: 'ignored',
			cwd: repo,
			arbiter: 'arbiter',
		});
		expect(shim.outcome).toBe('transitioned');

		const section = await resolveCwdSection({
			cwd: repo,
			config: config(),
			lockArbiterRemote: 'arbiter',
		});
		expect(section.repo?.items).toEqual([]);
		const entry = section.repo?.lockHeld?.[0];
		expect(entry?.entry).toBe('task-apply-rung-merge-disposition');
		expect(entry?.state).toBe('active');

		const out = formatCwd(section).join('\n');
		expect(out).toContain('In progress (lock held');
		expect(out).toContain('task-apply-rung-merge-disposition');
		expect(out).toContain('in-progress');
	});

	it('omits lockHeld when no lock is held (no empty block on a calm repo)', async () => {
		const {repo} = seedCwdRepo({'a.md': task('a')});
		const section = await resolveCwdSection({
			cwd: repo,
			config: config(),
			lockArbiterRemote: 'arbiter',
		});
		expect(section.repo?.lockHeld).toBeUndefined();
		expect(formatCwd(section).join('\n')).not.toContain(
			'In progress (lock held',
		);
	});
});

describe('resolveCwdSection — registry de-dup', () => {
	it('marks the cwd as also-registered when its arbiter is a registered mirror', async () => {
		const {repo, arbiter} = seedCwdRepo({'a.md': task('a')});
		const mirror = registerArbiterAsMirror(arbiter);
		const section = await resolveCwdSection({cwd: repo, config: config()});
		expect(section.alsoRegistered).toBe(true);
		expect(section.registeredMirrorPath).toBe(mirror);
	});

	it('is NOT also-registered when the cwd arbiter is absent from the registry', async () => {
		const {repo} = seedCwdRepo({'a.md': task('a')});
		const section = await resolveCwdSection({cwd: repo, config: config()});
		expect(section.alsoRegistered).toBe(false);
	});
});

describe('formatReport — cwd-local section is distinct + de-duped (scan)', () => {
	it('renders a labelled local section ABOVE the registry, each with its OWN count', async () => {
		const {repo} = seedCwdRepo({'a.md': task('a'), 'b.md': task('b')});
		const section = await resolveCwdSection({cwd: repo, config: config()});
		// An (unrelated) empty registry.
		const registry = await scan(config());
		const out = formatReport(registry, section);
		expect(out).toContain('This repo (local working tree)');
		expect(out).toContain(repo);
		// Distinct sections, never one merged grand total.
		expect(out).toContain('Local total: 2 items');
		expect(out).not.toMatch(/Summary: 2 item/);
	});

	it('an UNREGISTERED participating cwd shows the self-registration hint, not the dead-end', async () => {
		const {repo} = seedCwdRepo({'a.md': task('a')});
		const section = await resolveCwdSection({cwd: repo, config: config()});
		const registry = await scan(config()); // empty registry
		const out = formatReport(registry, section);
		expect(out).not.toContain('No participating repos found.');
		expect(out.toLowerCase()).toContain('not registered');
		expect(out.toLowerCase()).toContain('remote add . --local');
	});

	it('a cwd that is ALSO registered is de-duped (shown once, marked, not a second row)', async () => {
		const {repo, arbiter} = seedCwdRepo({'a.md': task('a')});
		const mirror = registerArbiterAsMirror(arbiter);
		const section = await resolveCwdSection({cwd: repo, config: config()});
		const registry = await scan(config());
		const out = formatReport(registry, section);
		// Marked once in the local section…
		expect(out).toContain('(also registered)');
		// …and its registry row is dropped (the mirror path appears only in the
		// local section's path line, not as a separate registry repo row).
		const occurrences = out.split(mirror).length - 1;
		expect(occurrences).toBe(0);
	});

	it('OUTSIDE a participating repo, the registry-only empty-state is unchanged', async () => {
		const notRepo = join(scratch.root, 'empty');
		mkdirSync(notRepo, {recursive: true});
		const section = await resolveCwdSection({cwd: notRepo, config: config()});
		const registry = await scan(config()); // empty registry
		const out = formatReport(registry, section);
		expect(out).toContain('No participating repos found.');
	});
});

describe('cwdSectionDisposition — FETCH-FREE pre-check (skip-redundant-cwd)', () => {
	it('a participating cwd with NO registered mirror: resolve it (participating, not registered)', () => {
		const {repo} = seedCwdRepo({'a.md': task('a')});
		const d = cwdSectionDisposition({cwd: repo, config: config()});
		expect(d.participating).toBe(true);
		expect(d.alsoRegistered).toBe(false);
	});

	it('a participating cwd that IS a registered mirror: skip it (alsoRegistered=true)', () => {
		const {repo, arbiter} = seedCwdRepo({'a.md': task('a')});
		registerArbiterAsMirror(arbiter);
		const d = cwdSectionDisposition({cwd: repo, config: config()});
		expect(d.participating).toBe(true);
		expect(d.alsoRegistered).toBe(true);
	});

	it('a non-participating cwd: not participating (nothing to resolve)', () => {
		const notRepo = join(scratch.root, 'empty');
		mkdirSync(notRepo, {recursive: true});
		const d = cwdSectionDisposition({cwd: notRepo, config: config()});
		expect(d.participating).toBe(false);
		expect(d.alsoRegistered).toBe(false);
	});

	it('agrees with resolveCwdSection.alsoRegistered (NOT a forked predicate)', async () => {
		const {repo, arbiter} = seedCwdRepo({'a.md': task('a')});
		registerArbiterAsMirror(arbiter);
		const d = cwdSectionDisposition({cwd: repo, config: config()});
		const section = await resolveCwdSection({cwd: repo, config: config()});
		expect(d.alsoRegistered).toBe(section.alsoRegistered);
	});
});

describe('formatStatus — cwd-local section renders distinctly', () => {
	it('shows the cwd local section in status when participating', async () => {
		const {repo} = seedCwdRepo({'a.md': task('a')});
		const section = await resolveCwdSection({cwd: repo, config: config()});
		const report = await status({
			workspacesDir: workspacesDir(),
			cwd: section,
		});
		expect(report.cwd?.participating).toBe(true);
		const out = formatStatus(report);
		expect(out).toContain('This repo (local working tree)');
		expect(out).toContain(repo);
		expect(out).toContain('Local total: 1 item');
	});

	it('status without a cwd section is unchanged (no local block)', async () => {
		const report = await status({workspacesDir: workspacesDir()});
		const out = formatStatus(report);
		expect(out).not.toContain('This repo (local working tree)');
	});
});
