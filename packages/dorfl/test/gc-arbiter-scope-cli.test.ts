import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {existsSync, mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {buildProgram} from '../src/cli.js';
import {createJob, type Job} from '../src/workspace.js';
import {git} from '../src/git.js';
import {
	makeScratch,
	seedRepoWithArbiter,
	gitEnv,
	type Scratch,
} from './helpers/gitRepo.js';

/**
 * CLI-surface behaviour for `gc`'s ARBITER SCOPE change (this task): `gc` is now
 * arbiter-scoped by DEFAULT (the arbiter resolved from the cwd), with a loud
 * `--all-arbiters` opt-in for the old global sweep and a REFUSAL when no arbiter
 * is resolvable and neither flag is given.
 *
 * House style: a throwaway workspacesDir under a TEMP scratch (`--workspace`),
 * `--config` pointed at a NONEXISTENT path so it reads pure defaults (never the
 * developer's real `~/.config/dorfl/config.json`). We assert the real default
 * `~/.dorfl` work area is NEVER referenced (every path stays under scratch).
 */

let scratch: Scratch;
beforeEach(() => {
	scratch = makeScratch('dorfl-gc-arbiter-scope-cli-');
});
afterEach(() => {
	scratch.cleanup();
});

function workspacesDir(): string {
	return join(scratch.root, 'agents-area');
}

/** The real default work area this test MUST NOT touch. */
const REAL_DEFAULT_WORKSPACES = join(homedir(), '.dorfl');

// Captured ONCE at module load: whether the real ~/.dorfl exists on this machine.
// The scoped/global tests below must not CHANGE this (they only ever operate on
// the temp --workspace), so we assert the flag is stable rather than a fixed
// value (a dev machine may legitimately have a real ~/.dorfl).
const realDefaultExistedBefore = existsSync(REAL_DEFAULT_WORKSPACES);

/** A config path that does not exist ⇒ `loadConfig` returns pure defaults. */
function noConfig(): string {
	return join(scratch.root, 'no-such-config.json');
}

/**
 * Materialise a REAL job worktree under `workspacesDir()` cut from a fresh local
 * `--bare` arbiter, holding an un-pushed commit (so a FORCED sweep would reap it,
 * and a scoped sweep that excludes it leaves un-saved work intact). Returns the
 * job plus its arbiter URL + a working "operator checkout" whose `origin` remote
 * points at that arbiter (the cwd `gc` resolves scope from).
 */
function seedArbiterJob(label: string): {
	job: Job;
	url: string;
	operatorRepo: string;
} {
	const subRoot = join(scratch.root, `arb-${label}`);
	const {arbiter} = seedRepoWithArbiter(subRoot, [label]);
	const url = `file://${arbiter}`;
	const job = createJob({
		url,
		slug: label,
		workspacesDir: workspacesDir(),
		env: gitEnv(),
	});
	// An un-pushed commit: the worktree now holds un-saved work.
	git(['commit', '-q', '--allow-empty', '-m', 'un-pushed work'], job.dir, {
		env: gitEnv(),
	});
	// The operator checkout: a plain repo whose `origin` IS this arbiter, so the
	// cwd→arbiter resolution keys onto exactly this job's worktrees.
	const operatorRepo = join(scratch.root, `operator-${label}`);
	git(['init', '-q', '-b', 'main', operatorRepo], scratch.root, {
		env: gitEnv(),
	});
	git(['remote', 'add', 'origin', url], operatorRepo, {env: gitEnv()});
	return {job, url, operatorRepo};
}

/** Drive argv through the program; capture stdout + stderr + the exit code. */
async function runCli(
	argv: string[],
	cwd: string,
): Promise<{out: string; err: string; code: number | undefined}> {
	const program = buildProgram();
	program.exitOverride();
	let out = '';
	let err = '';
	let code: number | undefined;
	const origErr = console.error;
	const origLog = console.log;
	const origExit = process.exit;
	const origCwd = process.cwd();
	console.error = (msg?: unknown) => {
		err += String(msg ?? '') + '\n';
	};
	console.log = (msg?: unknown) => {
		out += String(msg ?? '') + '\n';
	};
	(process as {exit: unknown}).exit = ((c?: number) => {
		code = c ?? 0;
		throw new Error(`__exit__:${code}`);
	}) as typeof process.exit;
	process.chdir(cwd);
	try {
		await program.parseAsync(['node', 'dorfl', ...argv]);
	} catch {
		// the exit shim / commander exitOverride throws — captured above.
	} finally {
		console.error = origErr;
		console.log = origLog;
		process.exit = origExit;
		process.chdir(origCwd);
	}
	return {out, err, code};
}

describe('gc CLI grammar — the scope flags are registered', () => {
	it('carries --all-arbiters alongside --arbiter/--force/--yes', () => {
		const program = buildProgram();
		const gc = program.commands.find((c) => c.name() === 'gc');
		expect(gc).toBeDefined();
		const flags = gc!.options.map((o) => o.flags);
		expect(flags.some((f) => f.startsWith('--all-arbiters'))).toBe(true);
		expect(flags.some((f) => f.startsWith('--arbiter'))).toBe(true);
		expect(flags.some((f) => f.startsWith('--force'))).toBe(true);
		expect(flags.some((f) => f.startsWith('--yes'))).toBe(true);
	});
});

describe('gc CLI — DEFAULT scope (cwd arbiter) does not touch other arbiters', () => {
	it('gc --force --yes from repo A reaps A but leaves repo B\u2019s un-pushed worktree', async () => {
		const a = seedArbiterJob('repo-a');
		const b = seedArbiterJob('repo-b');
		// Sanity: both worktrees exist and live under the scratch workspaces area.
		expect(existsSync(a.job.dir)).toBe(true);
		expect(existsSync(b.job.dir)).toBe(true);

		const {code, err} = await runCli(
			[
				'gc',
				'--config',
				noConfig(),
				'--workspace',
				workspacesDir(),
				'--force',
				'--yes',
			],
			a.operatorRepo,
		);

		// A clean sweep returns from the action WITHOUT an explicit exit (code
		// undefined); only the error paths call process.exit(1).
		expect(code ?? 0).toBe(0);
		// A (the cwd's arbiter) is reaped; B is out of scope entirely.
		expect(existsSync(a.job.dir)).toBe(false);
		expect(existsSync(b.job.dir)).toBe(true);
		// It did NOT announce a global cross-arbiter sweep.
		expect(err).not.toMatch(/all-arbiters/i);
		// The real default work area was never in play (temp workspace only) — the
		// sweep operated entirely under scratch, so the real ~/.dorfl is unchanged.
		expect(a.job.dir.startsWith(workspacesDir())).toBe(true);
		expect(existsSync(REAL_DEFAULT_WORKSPACES)).toBe(realDefaultExistedBefore);
	});
});

describe('gc CLI — --all-arbiters restores the loud GLOBAL sweep', () => {
	it('reaps across EVERY arbiter and prints a banner naming them first', async () => {
		const a = seedArbiterJob('repo-a');
		const b = seedArbiterJob('repo-b');

		const {code, err} = await runCli(
			[
				'gc',
				'--config',
				noConfig(),
				'--workspace',
				workspacesDir(),
				'--all-arbiters',
				'--force',
				'--yes',
			],
			// Run it from somewhere with NO arbiter of its own to prove --all-arbiters
			// does not depend on the cwd resolving one.
			scratch.root,
		);

		expect(code ?? 0).toBe(0);
		// The loud banner named the global scope + the arbiters before acting.
		expect(err).toMatch(
			/all-arbiters: operating GLOBALLY across ALL arbiters/i,
		);
		expect(err).toMatch(/arbiters in scope:/i);
		// Both arbiters' worktrees are reaped (the old global behaviour).
		expect(existsSync(a.job.dir)).toBe(false);
		expect(existsSync(b.job.dir)).toBe(false);
	});
});

describe('gc CLI — no resolvable cwd arbiter REFUSES (never silently global)', () => {
	it('errors, reaps nothing, when neither --arbiter nor --all-arbiters is given', async () => {
		const a = seedArbiterJob('repo-a');
		const b = seedArbiterJob('repo-b');
		// A cwd that is not inside any repo with an arbiter remote.
		const bare = join(scratch.root, 'no-arbiter-here');
		mkdirSync(bare, {recursive: true});

		const {code, err} = await runCli(
			[
				'gc',
				'--config',
				noConfig(),
				'--workspace',
				workspacesDir(),
				'--force',
				'--yes',
			],
			bare,
		);

		expect(code).toBe(1);
		expect(err).toMatch(/ARBITER-SCOPED/i);
		expect(err).toMatch(/--all-arbiters/);
		// It refused BEFORE sweeping — nothing was reaped in either arbiter.
		expect(existsSync(a.job.dir)).toBe(true);
		expect(existsSync(b.job.dir)).toBe(true);
	});

	it('--arbiter <url> targets a SPECIFIC arbiter regardless of cwd', async () => {
		const a = seedArbiterJob('repo-a');
		const b = seedArbiterJob('repo-b');
		const bare = join(scratch.root, 'somewhere-else');
		mkdirSync(bare, {recursive: true});

		const {code} = await runCli(
			[
				'gc',
				'--config',
				noConfig(),
				'--workspace',
				workspacesDir(),
				'--arbiter',
				b.url, // a direct URL → keyed onto repo B's worktrees
				'--force',
				'--yes',
			],
			bare,
		);

		expect(code ?? 0).toBe(0);
		// Only B (explicitly targeted) is reaped; A is untouched.
		expect(existsSync(b.job.dir)).toBe(false);
		expect(existsSync(a.job.dir)).toBe(true);
	});
});
