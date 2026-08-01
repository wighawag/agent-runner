import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {
	advanceRegistrySetRunTick,
	type AdvanceRegistrySetRunTickDeps,
} from '../src/advance-loop-driver.js';
import {runLoop, runOnce, type Dorfl} from '../src/run.js';
import {ensureMirror} from '../src/repo-mirror.js';
import {scanRepoPaths} from '../src/scan.js';
import {mergeConfig, type Config} from '../src/config.js';
import type {AdvanceContext} from '../src/advance.js';
import type {AdvanceTickOptions} from '../src/advance-drivers.js';
import type {SurfaceGate, SurfaceEmit} from '../src/surface-gate.js';
import type {DoOptions, DoDorfl} from '../src/do.js';
import {
	makeScratch,
	isolatePiAgentDir,
	seedRepoWithArbiter,
	existsOnArbiterMain,
	pathOnArbiterMain,
	gitEnv,
	gitIn,
	type Scratch,
	type SeededRepo,
} from './helpers/gitRepo.js';

/**
 * `run-uses-advance-tick` — plain `run` (no flag) drives the REGISTRY-SET ADVANCE
 * tick (the precursor `advance-loop-driver-registry-set-job-worktrees`'s
 * {@link advanceRegistrySet}) as its per-item unit, via the deliberate `RunTick`
 * swap seam. It proves:
 *
 *   1. {@link advanceRegistrySetRunTick} conforms to `RunTick` and `runLoop`
 *      DRIVES it over the whole registry (multi-mirror), draining each mirror's
 *      eligible pool — the SAME `scan(config)` discovery + per-job-worktree
 *      isolation `runOnce` uses;
 *   2. under calm gates (observationTriage off, surfaceBlockers off) the
 *      registry-set advance tick is OBSERVABLE-OUTCOME-equivalent to plain
 *      `run`'s build tick (`runOnce`) over the SAME fixture (same discovery,
 *      same worktree isolation, same integration; touch no observations, surface
 *      no questions);
 *   3. with a gate flipped (surfaceBlockers on) plain `run`'s advance tick ALSO
 *      performs the lifecycle (a needsAnswers task is surfaced — the tree-less
 *      ledger move, no build worktree);
 *   4. no regression in build/integrate/needs-attention (a failing item routes
 *      to needs-attention, the loop survives and keeps ticking).
 *
 * House style: throwaway projects + local `--bare` arbiters, REGISTERED as hub
 * mirrors under a TEMP `workspacesDir` (the agents' area) via `ensureMirror`,
 * `isolatePiAgentDir` pointing pi's session storage at scratch, and a STUBBED
 * agent (injected `dorfl` edits files directly). Real git, writes main,
 * materialises worktrees — sequential project.
 */

let scratch: Scratch;
let restorePiAgentDir: () => void;
beforeEach(() => {
	scratch = makeScratch('dorfl-run-uses-advance-tick-');
	restorePiAgentDir = isolatePiAgentDir(scratch.root);
});
afterEach(() => {
	restorePiAgentDir();
	scratch.cleanup();
});

const PASS = 'exit 0';

function workspacesDir(): string {
	return join(scratch.root, 'agents-area');
}

function remoteUrl(arbiter: string): string {
	return `file://${arbiter}`;
}

function seedAndRegister(
	name: string,
	slugs: string[],
	opts: Parameters<typeof seedRepoWithArbiter>[2] = {},
): {seed: SeededRepo; mirrorPath: string; originUrl: string} {
	const root = join(scratch.root, name);
	const seed = seedRepoWithArbiter(root, slugs, opts);
	const originUrl = remoteUrl(seed.arbiter);
	const mirror = ensureMirror({
		url: originUrl,
		workspacesDir: workspacesDir(),
		env: gitEnv(),
	});
	return {seed, mirrorPath: mirror.path, originUrl};
}

function config(overrides: Partial<Config> = {}): Config {
	return mergeConfig({
		defaultArbiter: 'origin',
		workspacesDir: workspacesDir(),
		maxParallel: 4,
		perRepoMax: 2,
		integration: 'merge',
		agentCmd: 'true',
		verify: PASS,
		autoBuild: true,
		autoTask: true,
		...overrides,
	});
}

// DISJOINT-file agents (each slug writes its OWN `${slug}.txt`) so the two
// same-repo jobs in the outcome-equivalence tests touch DIFFERENT paths. With the
// fresh rebased-tip gate now ON at any perRepoMax, two same-repo worktrees can be
// cut from the same base concurrently; a SHARED `agent-output.txt` would then be a
// GENUINE add/add code conflict (correctly routing ONE job to needs-attention),
// breaking the both-land outcome-equivalence the tests assert. Disjoint files keep
// the equivalence about the DRIVER, not about conflict resolution.
const editingDoAgent: DoDorfl = ({cwd, slug}) => {
	writeFileSync(join(cwd, `${slug}.txt`), `work done for ${slug}\n`);
	return {ok: true};
};

const editingRunAgent: Dorfl = ({cwd, slug}) => {
	writeFileSync(join(cwd, `${slug}.txt`), `work done for ${slug}\n`);
	return {ok: true};
};

/**
 * The per-mirror advance CONTEXT factory the CLI shapes (here in-test): a
 * tree-less working clone of the mirror's arbiter for the surface/triage/apply
 * rungs + the build/task `doOptions` base. The registry-set worktree `doDriver`
 * is injected by `advanceRegistrySet` itself, on top of this.
 */
function contextForFactory(opts: {
	dorfl?: DoDorfl;
	surfaceGate?: SurfaceGate;
}): (input: {
	mirrorPath: string;
	originUrl: string;
}) => Omit<AdvanceTickOptions, 'arg' | 'doDriver'> {
	return ({originUrl}) => {
		const cwd = join(
			scratch.root,
			'treeless-cwd',
			originUrl.replace(/[^a-zA-Z0-9]/g, '_'),
		);
		gitIn(['clone', '-q', originUrl, cwd], scratch.root);
		const doOptions: Omit<DoOptions, 'arg'> = {
			cwd,
			arbiter: 'origin',
			integration: 'merge',
			verify: PASS,
			autoTask: true,
			dorfl: opts.dorfl ?? editingDoAgent,
			env: gitEnv(),
		};
		const context: AdvanceContext = {
			cwd,
			arbiter: 'origin',
			doOptions,
			surfaceGate: opts.surfaceGate,
		};
		return context;
	};
}

function deps(
	over: Partial<AdvanceRegistrySetRunTickDeps> = {},
	ctxOpts: Parameters<typeof contextForFactory>[0] = {},
): AdvanceRegistrySetRunTickDeps {
	return {
		config: config(),
		workspace: workspacesDir(),
		contextFor: contextForFactory(ctxOpts),
		...over,
	};
}

describe('advanceRegistrySetRunTick — plain `run` drives the registry-set advance tick', () => {
	it('conforms to RunTick and runLoop drains the WHOLE registry (multi-mirror)', async () => {
		const a = seedAndRegister('repo-a', ['a1', 'a2']);
		const b = seedAndRegister('repo-b', ['b1']);

		const tick = advanceRegistrySetRunTick(deps());
		expect(typeof tick).toBe('function');

		const summary = await runLoop({
			config: config(),
			tick,
			maxIterations: 1,
			sleep: async () => {},
			env: gitEnv(),
		});

		expect(summary.iterations).toBe(1);
		// a1, a2, b1 all advanced (built + integrated) this one tick.
		expect(summary.claimedAndDone).toBe(3);
		expect(summary.failed).toBe(0);
		expect(existsOnArbiterMain(a.seed.repo, 'done', 'a1')).toBe(true);
		expect(existsOnArbiterMain(a.seed.repo, 'done', 'a2')).toBe(true);
		expect(existsOnArbiterMain(b.seed.repo, 'done', 'b1')).toBe(true);
	});
});

describe('advanceRegistrySetRunTick — calm-gates OUTCOME-equivalence to plain run`s build tick', () => {
	it(
		'the registry-set advance tick matches runOnce over the SAME fixture',
		{timeout: 30000},
		async () => {
			// UNIVERSE 1 — plain `run`'s build tick (`runOnce`) over working checkouts.
			const runRoot = join(scratch.root, 'u1');
			const runSeed = seedRepoWithArbiter(runRoot, ['eq1', 'eq2']);
			const runCfg = config({defaultArbiter: 'arbiter'});
			const runResult = await runOnce({
				config: runCfg,
				report: scanRepoPaths([runSeed.repo], runCfg),
				workspace: join(scratch.root, 'u1-ws'),
				dorfl: editingRunAgent,
				env: gitEnv(),
			});

			// UNIVERSE 2 — plain `run` on the registry-set advance tick (calm gates).
			const adv = seedAndRegister('u2', ['eq1', 'eq2']);
			const advSummary = await runLoop({
				config: config(),
				tick: advanceRegistrySetRunTick(deps()),
				maxIterations: 1,
				sleep: async () => {},
				env: gitEnv(),
			});

			// SAME count built-and-integrated.
			expect(runResult.claimedAndDone).toBe(2);
			expect(advSummary.claimedAndDone).toBe(2);
			expect(advSummary.failed).toBe(0);

			// SAME integration result; neither path surfaced a question.
			for (const slug of ['eq1', 'eq2']) {
				expect(existsOnArbiterMain(runSeed.repo, 'done', slug)).toBe(true);
				expect(existsOnArbiterMain(adv.seed.repo, 'done', slug)).toBe(true);
				expect(existsOnArbiterMain(adv.seed.repo, 'backlog', slug)).toBe(false);
			}
			expect(existsSync(join(adv.seed.repo, 'work', 'questions'))).toBe(false);
		},
	);
});

describe('advanceRegistrySetRunTick — a gate flip makes plain `run` perform the lifecycle', () => {
	it(
		'surfaceBlockers on ⇒ a needsAnswers task is SURFACED under the loop (tree-less, no build worktree)',
		{timeout: 30000},
		async () => {
			const blockedSlug = 'blocked';
			const {seed} = seedAndRegister('lifecycle', [blockedSlug], {
				needsAnswers: true,
			});
			const emit: SurfaceEmit = {
				item: `task:${blockedSlug}`,
				questions: [{question: 'which approach?'}],
			};
			const surfaceGate: SurfaceGate = async () => emit;

			const summary = await runLoop({
				config: config(),
				tick: advanceRegistrySetRunTick(
					deps(
						// The CLI wires this from `surfaceBlockers` — flip the surface pool ON.
						{lifecycleGates: {surface: true}},
						{surfaceGate},
					),
				),
				maxIterations: 1,
				sleep: async () => {},
				env: gitEnv(),
			});

			// The surface rung ADVANCED the blocked task (surfaced, not built).
			expect(summary.claimedAndDone).toBe(1);
			const treelessCwd = join(
				scratch.root,
				'treeless-cwd',
				remoteUrl(seed.arbiter).replace(/[^a-zA-Z0-9]/g, '_'),
			);
			expect(
				existsSync(
					join(treelessCwd, 'work', 'questions', `task-${blockedSlug}.md`),
				),
			).toBe(true);
		},
	);
});

describe('advanceRegistrySetRunTick — no regression in needs-attention routing', () => {
	it(
		'a failing build is SURFACED for a human; the loop survives and keeps ticking',
		{timeout: 30000},
		async () => {
			const {seed} = seedAndRegister('fail', ['willfail']);
			const failingAgent: DoDorfl = () => ({
				ok: false,
				detail: 'the agent failed to build',
			});

			const summary = await runLoop({
				config: config(),
				tick: advanceRegistrySetRunTick(deps({}, {dorfl: failingAgent})),
				maxIterations: 1,
				sleep: async () => {},
				env: gitEnv(),
			});

			// The loop ran its tick and ended cleanly (no crash) — the invariant this
			// test exists for.
			expect(summary.iterations).toBe(1);

			// The failing build is SURFACED (a `stuck`-kind sidecar + `needsAnswers:true`
			// on the item, then the lock released) and that CLEAN surface is GREEN — the
			// PR-2b D3 semantics `saveAgentFailure` already encodes (`exitCode: routed.moved
			// ? 0 : 1`): the item was successfully parked for a human, which is a completed
			// advance, not a failure of the runner.
			//
			// These counts were INVERTED before the Defect-1 fix (observation
			// `checkpoint-path-reports-its-own-write-as-absent`): the surface commit landed
			// on `main`, but the post-write verification read a view predating its own push
			// and reported `moved: false`, so the bounce looked like a FAILED surface
			// (`exitCode: 1` ⇒ `needsAttention: 1`) and the lock was never released. The
			// surface working correctly is what moves these numbers.
			expect(summary.claimedAndDone).toBe(1);
			expect(summary.needsAttention).toBe(0);
			expect(summary.failed).toBe(0);

			// The routing genuinely happened: the human-facing question is on the arbiter.
			expect(
				pathOnArbiterMain(seed.repo, 'work/questions/task-willfail.md'),
			).toBe(true);
		},
	);
});
