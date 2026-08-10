import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {rmrf} from './helpers/gitRepo.js';
import {join} from 'node:path';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {
	runTaskReviewLoop,
	parseTaskReviewVerdict,
	buildTaskReviewPrompt,
	harnessTaskReviewGate,
	REVIEW_EDITS_SCRATCH_DIR,
	type TaskReviewGate,
	type TaskReviewVerdict,
} from '../src/tasker-review-loop.js';
import {
	ReviewOutputCappedError,
	ReviewParseError,
} from '../src/review-verdict.js';
import type {Harness, LaunchResult, LaunchInput} from '../src/harness.js';

/**
 * Pure-logic tests for the tasker review→edit→converge LOOP
 * (`slicer-review-edit-loop`). These exercise the loop MECHANICS — the in-context
 * (N) review→edit→re-review, the `taskerLoopMax` hard cap, the M fresh-context
 * re-executions, the edit-application to candidate task files, and the three
 * verdict-routing outcomes — with a STUBBED review gate (no real model, no
 * network, no harness). Candidate task files live under a temp
 * `work/tasks/backlog/` tree (the STAGING folder per task
 * `pre-backlog-staging-folder-and-promote-step-a`); nothing touches the real
 * `~/.dorfl/` or `~/.pi/`.
 */

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'tasker-review-loop-'));
	mkdirSync(join(cwd, 'work', 'tasks', 'backlog'), {recursive: true});
});
afterEach(() => {
	rmrf(cwd);
});

/** Seed a candidate task file under `work/tasks/backlog/` (the STAGING folder). */
function seedCandidate(name: string, body = 'draft'): string {
	const rel = `work/tasks/backlog/${name}.md`;
	writeFileSync(
		join(cwd, rel),
		`---\nslug: ${name}\nprd: it\n---\n\n## Prompt\n\n> ${body}\n`,
	);
	return rel;
}

/** A snapshot (filename → content) of `work/tasks/backlog/` — the loop's `before` fence. */
function snapshotBacklog(): Map<string, string> {
	const dir = join(cwd, 'work', 'tasks', 'backlog');
	const snap = new Map<string, string>();
	for (const name of readdirSync(dir)) {
		if (name.toLowerCase().endsWith('.md')) {
			snap.set(name, readFileSync(join(dir, name), 'utf8'));
		}
	}
	return snap;
}

/** A gate that returns a scripted sequence of verdicts (one per pass). */
function scriptedGate(
	verdicts: TaskReviewVerdict[],
	calls: Array<{pass: number; execution: number}> = [],
): TaskReviewGate {
	let i = 0;
	return async (input) => {
		calls.push({pass: input.pass, execution: input.execution});
		const v = verdicts[Math.min(i, verdicts.length - 1)];
		i++;
		return v;
	};
}

describe('runTaskReviewLoop — converging (findings → edits → clean)', () => {
	it('applies the agent edits to the candidate task files and re-reviews until clean', async () => {
		seedCandidate('child', 'draft');
		const calls: Array<{pass: number; execution: number}> = [];
		const gate = scriptedGate(
			[
				// Pass 1: block + an edit improving the candidate.
				{
					verdict: 'block',
					findings: [
						{severity: 'blocking', question: 'the prompt is too thin'},
					],
					edits: [
						{
							path: 'work/tasks/backlog/child.md',
							content:
								'---\nslug: child\nprd: it\n---\n\n## Prompt\n\n> improved\n',
						},
					],
				},
				// Pass 2: no new blocking issue — converge.
				{verdict: 'approve', findings: []},
			],
			calls,
		);
		const result = await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate,
			taskerLoopMax: 3,
		});
		expect(result.outcome).toBe('converged');
		expect(result.passes).toBe(2);
		expect(result.executions).toBe(1);
		// The edit was APPLIED to disk (the runner wrote it; the agent does no disk).
		expect(
			readFileSync(join(cwd, 'work/tasks/backlog/child.md'), 'utf8'),
		).toMatch(/> improved/);
		// Two in-context passes ran in ONE fresh context.
		expect(calls).toEqual([
			{pass: 1, execution: 1},
			{pass: 2, execution: 1},
		]);
	});

	it('converges immediately on a first-pass approve (the cheap natural terminator)', async () => {
		seedCandidate('child');
		const result = await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate: scriptedGate([{verdict: 'approve', findings: []}]),
			taskerLoopMax: 3,
		});
		expect(result.outcome).toBe('converged');
		expect(result.passes).toBe(1);
	});

	it('an edit may CREATE a new candidate task (review split one into two)', async () => {
		seedCandidate('child');
		const result = await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate: scriptedGate([
				{
					verdict: 'block',
					findings: [{severity: 'blocking', question: 'split this'}],
					edits: [
						{
							path: 'work/tasks/backlog/child-b.md',
							content: '---\nslug: child-b\nprd: it\n---\n\n## Prompt\n\n> b\n',
						},
					],
				},
				{verdict: 'approve', findings: []},
			]),
			taskerLoopMax: 3,
		});
		expect(result.outcome).toBe('converged');
		expect(Object.keys(result.tasks)).toContain(
			'work/tasks/backlog/child-b.md',
		);
	});

	it('REFUSES an edit outside work/tasks/backlog/ (defensive scope fence)', async () => {
		seedCandidate('child');
		const escaped = join(cwd, 'work', 'specs', 'ready', 'it.md');
		mkdirSync(join(cwd, 'work', 'specs', 'ready'), {recursive: true});
		writeFileSync(escaped, 'original PRD');
		await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate: scriptedGate([
				{
					verdict: 'block',
					findings: [{severity: 'blocking', question: 'x'}],
					edits: [{path: 'work/specs/ready/it.md', content: 'HIJACKED'}],
				},
				{verdict: 'approve', findings: []},
			]),
			taskerLoopMax: 3,
		});
		// The escaping edit was NOT applied — only candidate tasks are improved.
		expect(readFileSync(escaped, 'utf8')).toBe('original PRD');
	});
});

describe('runTaskReviewLoop — scoping fence (only THIS run’s own tasks)', () => {
	// The requeue fix: on a POPULATED backlog (the normal steady state), the loop
	// must review/edit/flag ONLY the tasks new-or-changed since the `before`
	// snapshot — never the pre-existing, already-landed tasks that share the dir.

	it('reviews ONLY the run’s own candidate tasks (pre-existing ones are not passed to the gate)', async () => {
		// Two pre-existing LANDED tasks already in the backlog.
		seedCandidate('landed-a', 'landed a');
		seedCandidate('landed-b', 'landed b');
		const before = snapshotBacklog();
		// THIS run produces one new task on top.
		seedCandidate('mine', 'mine');
		let seen: string[] = [];
		const gate: TaskReviewGate = async (input) => {
			seen = input.candidateTasks;
			return {verdict: 'approve', findings: []};
		};
		const result = await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate,
			before,
			taskerLoopMax: 3,
		});
		expect(result.outcome).toBe('converged');
		// The gate only saw THIS run's own task — never the pre-existing landed ones.
		expect(seen).toEqual(['work/tasks/backlog/mine.md']);
		// The returned tasks set is likewise scoped to the run's own output.
		expect(Object.keys(result.tasks)).toEqual(['work/tasks/backlog/mine.md']);
	});

	it('REFUSES an edit to a pre-existing landed task (untouched on disk)', async () => {
		const landedRel = seedCandidate('landed', 'ORIGINAL landed content');
		const before = snapshotBacklog();
		seedCandidate('mine', 'mine');
		await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate: scriptedGate([
				{
					verdict: 'block',
					findings: [
						{severity: 'blocking', question: 'hijack the landed task'},
					],
					edits: [{path: landedRel, content: 'HIJACKED'}],
				},
				{verdict: 'approve', findings: []},
			]),
			before,
			taskerLoopMax: 3,
		});
		// The pre-existing landed task was NOT overwritten by the loop.
		expect(readFileSync(join(cwd, landedRel), 'utf8')).toMatch(
			/ORIGINAL landed content/,
		);
	});

	it('the uncertain-tasks FLOOR flags only the run’s own tasks (not pre-existing)', async () => {
		seedCandidate('landed', 'landed');
		const before = snapshotBacklog();
		seedCandidate('mine', 'mine');
		const result = await runTaskReviewLoop({
			slug: 'it',
			cwd,
			// Block with NO named uncertain task → the floor maps the run's own set.
			gate: scriptedGate([
				{
					verdict: 'block',
					findings: [{severity: 'blocking', question: 'broadly unclear'}],
				},
			]),
			before,
			taskerLoopMax: 1,
		});
		expect(result.outcome).toBe('uncertain-tasks');
		// Only THIS run's task is flagged — the pre-existing landed one is untouched.
		expect(result.uncertainTasks.map((u) => u.path)).toEqual([
			'work/tasks/backlog/mine.md',
		]);
	});

	it('an edit that IMPROVES the run’s own task still applies (in-scope)', async () => {
		seedCandidate('landed', 'landed');
		const before = snapshotBacklog();
		const mineRel = seedCandidate('mine', 'draft');
		await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate: scriptedGate([
				{
					verdict: 'block',
					findings: [{severity: 'blocking', question: 'thin'}],
					edits: [
						{
							path: mineRel,
							content:
								'---\nslug: mine\nprd: it\n---\n\n## Prompt\n\n> IMPROVED\n',
						},
					],
				},
				{verdict: 'approve', findings: []},
			]),
			before,
			taskerLoopMax: 3,
		});
		expect(readFileSync(join(cwd, mineRel), 'utf8')).toMatch(/IMPROVED/);
	});
});

describe('runTaskReviewLoop — taskerLoopMax cap rejects via the sink', () => {
	it('persistent block → uncertain-tasks (specific tasks needsAnswers + questions)', async () => {
		seedCandidate('child');
		const gate = scriptedGate([
			{
				verdict: 'block',
				findings: [{severity: 'blocking', question: 'still unclear'}],
				uncertainTasks: [
					{
						path: 'work/tasks/backlog/child.md',
						questions: ['what is the seam?'],
					},
				],
			},
		]);
		const result = await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate,
			taskerLoopMax: 2,
		});
		expect(result.outcome).toBe('uncertain-tasks');
		// The cap was hit (2 passes), never an infinite loop.
		expect(result.passes).toBe(2);
		expect(result.uncertainTasks).toEqual([
			{path: 'work/tasks/backlog/child.md', questions: ['what is the seam?']},
		]);
	});

	it('persistent block with NO named task → ALL candidates treated as uncertain (floor)', async () => {
		seedCandidate('a');
		seedCandidate('b');
		const result = await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate: scriptedGate([
				{
					verdict: 'block',
					findings: [{severity: 'blocking', question: 'broadly unclear'}],
				},
			]),
			taskerLoopMax: 1,
		});
		expect(result.outcome).toBe('uncertain-tasks');
		// Never silently drops the rejection: every candidate is flagged.
		expect(result.uncertainTasks.map((u) => u.path).sort()).toEqual([
			'work/tasks/backlog/a.md',
			'work/tasks/backlog/b.md',
		]);
		// The floor questions come from the blocking findings.
		for (const u of result.uncertainTasks) {
			expect(u.questions).toEqual(['broadly unclear']);
		}
	});

	it('decomposition-unclear → route the PRD to needs-attention (no guessed tasks)', async () => {
		seedCandidate('child');
		const result = await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate: scriptedGate([
				{
					verdict: 'block',
					findings: [
						{severity: 'blocking', question: 'the whole shape is wrong'},
					],
					decompositionUnclear: {
						questions: ['should this even be one PRD?'],
					},
				},
			]),
			taskerLoopMax: 2,
		});
		expect(result.outcome).toBe('decomposition-unclear');
		expect(result.specQuestions).toEqual(['should this even be one PRD?']);
		// No uncertain tasks emitted on this outcome.
		expect(result.uncertainTasks).toEqual([]);
	});
});

describe('runTaskReviewLoop — M fresh-context re-executions', () => {
	it('M>1 runs the loop in fresh contexts; the first that converges wins', async () => {
		seedCandidate('child');
		const calls: Array<{pass: number; execution: number}> = [];
		// Execution 1 never converges (always blocks); execution 2 converges pass 1.
		let exec = 0;
		const gate: TaskReviewGate = async (input) => {
			calls.push({pass: input.pass, execution: input.execution});
			if (input.execution === 1) {
				return {
					verdict: 'block',
					findings: [{severity: 'blocking', question: 'nope'}],
				};
			}
			exec = input.execution;
			return {verdict: 'approve', findings: []};
		};
		const result = await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate,
			taskerLoopMax: 2,
			executions: 3,
		});
		expect(result.outcome).toBe('converged');
		// Stopped at execution 2 (the first to converge) — execution 3 never ran.
		expect(result.executions).toBe(2);
		expect(exec).toBe(2);
		// Execution 1 ran its full taskerLoopMax (2 passes), execution 2 converged pass 1.
		expect(calls).toEqual([
			{pass: 1, execution: 1},
			{pass: 2, execution: 1},
			{pass: 1, execution: 2},
		]);
	});

	it('a persistent block across ALL M fresh contexts routes the last verdict', async () => {
		seedCandidate('child');
		const gate = scriptedGate([
			{
				verdict: 'block',
				findings: [{severity: 'blocking', question: 'persistently unclear'}],
				decompositionUnclear: {questions: ['unanswerable']},
			},
		]);
		const result = await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate,
			taskerLoopMax: 1,
			executions: 2,
		});
		expect(result.outcome).toBe('decomposition-unclear');
		expect(result.executions).toBe(2);
		// 1 pass × 2 executions = 2 total passes (never an infinite loop).
		expect(result.passes).toBe(2);
	});

	it('degenerate M=1 is exactly one loop', async () => {
		seedCandidate('child');
		const calls: Array<{pass: number; execution: number}> = [];
		await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate: scriptedGate([{verdict: 'approve', findings: []}], calls),
			taskerLoopMax: 3,
			executions: 1,
		});
		expect(calls).toEqual([{pass: 1, execution: 1}]);
	});
});

describe('parseTaskReviewVerdict — reads the agent verdict (incl. edits + routing)', () => {
	it('parses a verdict embedded in surrounding prose / a fence', async () => {
		const output = [
			'Here is my review:',
			'```json',
			JSON.stringify({
				verdict: 'block',
				findings: [{severity: 'blocking', question: 'q', context: 'c'}],
				edits: [{path: 'work/tasks/backlog/x.md', content: 'new'}],
				uncertainTasks: [
					{path: 'work/tasks/backlog/y.md', questions: ['why?']},
				],
				decompositionUnclear: {questions: ['whole?']},
			}),
			'```',
		].join('\n');
		const v = parseTaskReviewVerdict(output);
		expect(v.verdict).toBe('block');
		expect(v.findings).toEqual([
			{severity: 'blocking', question: 'q', context: 'c'},
		]);
		expect(v.edits).toEqual([
			{path: 'work/tasks/backlog/x.md', content: 'new'},
		]);
		expect(v.uncertainTasks).toEqual([
			{path: 'work/tasks/backlog/y.md', questions: ['why?']},
		]);
		expect(v.decompositionUnclear).toEqual({questions: ['whole?']});
	});

	it('throws when there is no parseable verdict (never a silent approve)', () => {
		expect(() => parseTaskReviewVerdict('no json here')).toThrow();
	});

	it('throws on a verdict that is not approve/block', () => {
		expect(() =>
			parseTaskReviewVerdict('{"verdict": "maybe", "findings": []}'),
		).toThrow();
	});
});

describe('buildTaskReviewPrompt — frames the artifact + the output shape', () => {
	it('names the candidate tasks, the destination check, and the JSON shape', () => {
		const prompt = buildTaskReviewPrompt({
			slug: 'it',
			cwd: '/tmp/x',
			candidateTasks: ['work/tasks/backlog/child.md'],
			pass: 1,
			execution: 1,
		});
		expect(prompt).toMatch(/review.*skill/i);
		expect(prompt).toMatch(/DESTINATION CHECK/);
		// The candidate-task path is echoed verbatim from `candidateTasks` (the new
		// `tasks/backlog` staging path). The prompt's PROSE folder mentions (e.g. the
		// `work/tasks/backlog/<slug>.md` template hints) are CLI/prompt prose owned by
		// the vocabulary-cutover sibling task, not this notes/tasks path flip.
		expect(prompt).toMatch(/work\/tasks\/backlog\/child\.md/);
		expect(prompt).toMatch(/"verdict"/);
		expect(prompt).toMatch(/"edits"/);
		// The loop is framed as an IMPROVER, not a one-shot gate.
		expect(prompt).toMatch(/loop, not a one-shot gate/);
	});

	it('explicitly NAMES the whole-SET lenses (graph coherence / gaps / overlap / goal-composition)', () => {
		const prompt = buildTaskReviewPrompt({
			slug: 'it',
			cwd: '/tmp/x',
			candidateTasks: ['work/tasks/backlog/child.md'],
			pass: 1,
			execution: 1,
		});
		// US #3 of tasking-coherence: the set-level lens must be NAMED, not only
		// implied by the destination check.
		expect(prompt).toMatch(/WHOLE SET/);
		expect(prompt).toMatch(/graph coherence/i);
		expect(prompt).toMatch(/gaps/i);
		expect(prompt).toMatch(/overlap/i);
		expect(prompt).toMatch(/goal-composition/i);
	});
});

// --- The DECOUPLED edits channel (write-to-scratch + reference by path) -------

describe('applyEdits via `src` (the DECOUPLED edits channel)', () => {
	it('reads the edit body from the agent-written scratch file, applies it, then DELETES the scratch', async () => {
		const mine = seedCandidate('child', 'draft');
		const scratchRel = `${REVIEW_EDITS_SCRATCH_DIR}/child.md`;
		// The agent writes the FULL replacement body to the scratch dir DURING the
		// review pass (the start-of-loop clean has already reaped any stragglers),
		// then emits a `src` reference (the verdict JSON stays tiny — no inline
		// content). Simulate that by writing the scratch inside the gate.
		const gate: TaskReviewGate = async (input) => {
			if (input.pass === 1) {
				mkdirSync(join(cwd, REVIEW_EDITS_SCRATCH_DIR), {recursive: true});
				writeFileSync(
					join(cwd, scratchRel),
					'---\nslug: child\nprd: it\n---\n\n## Prompt\n\n> IMPROVED via scratch\n',
				);
				return {
					verdict: 'block',
					findings: [{severity: 'blocking', question: 'thin'}],
					edits: [{path: mine, src: scratchRel}],
				};
			}
			return {verdict: 'approve', findings: []};
		};
		await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate,
			taskerLoopMax: 3,
		});
		// The scratch body was APPLIED to the candidate task.
		expect(readFileSync(join(cwd, mine), 'utf8')).toMatch(
			/IMPROVED via scratch/,
		);
		// The scratch file was REAPED (never swept into a later integrate commit).
		let scratchGone = true;
		try {
			readFileSync(join(cwd, scratchRel), 'utf8');
			scratchGone = false;
		} catch {
			/* expected: reaped */
		}
		expect(scratchGone).toBe(true);
	});

	it('REFUSES a `src` outside the review-edits scratch dir (no arbitrary-file read)', async () => {
		const mine = seedCandidate('child', 'draft');
		const secret = join(cwd, 'work', 'specs', 'ready', 'it.md');
		mkdirSync(join(cwd, 'work', 'specs', 'ready'), {recursive: true});
		writeFileSync(secret, 'SECRET PRD');
		await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate: scriptedGate([
				{
					verdict: 'block',
					findings: [{severity: 'blocking', question: 'x'}],
					edits: [{path: mine, src: 'work/specs/ready/it.md'}],
				},
				{verdict: 'approve', findings: []},
			]),
			taskerLoopMax: 3,
		});
		// The escaping src was NOT applied — the candidate keeps its draft body.
		expect(readFileSync(join(cwd, mine), 'utf8')).toMatch(/> draft/);
		expect(readFileSync(secret, 'utf8')).toBe('SECRET PRD');
	});

	it('a `src` scratch file the agent did NOT write is skipped (no crash, no clobber)', async () => {
		const mine = seedCandidate('child', 'draft');
		await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate: scriptedGate([
				{
					verdict: 'block',
					findings: [{severity: 'blocking', question: 'x'}],
					edits: [{path: mine, src: `${REVIEW_EDITS_SCRATCH_DIR}/missing.md`}],
				},
				{verdict: 'approve', findings: []},
			]),
			taskerLoopMax: 3,
		});
		expect(readFileSync(join(cwd, mine), 'utf8')).toMatch(/> draft/);
	});

	it('inline `content` still works (the legacy small-edit form is kept)', async () => {
		const mine = seedCandidate('child', 'draft');
		await runTaskReviewLoop({
			slug: 'it',
			cwd,
			gate: scriptedGate([
				{
					verdict: 'block',
					findings: [{severity: 'blocking', question: 'thin'}],
					edits: [
						{
							path: mine,
							content:
								'---\nslug: child\nprd: it\n---\n\n## Prompt\n\n> INLINE improved\n',
						},
					],
				},
				{verdict: 'approve', findings: []},
			]),
			taskerLoopMax: 3,
		});
		expect(readFileSync(join(cwd, mine), 'utf8')).toMatch(/INLINE improved/);
	});
});

describe('buildTaskReviewPrompt — the decoupled edits channel (no inline content)', () => {
	it('tells the agent to WRITE edit bodies to the scratch dir + reference by `src`', () => {
		const prompt = buildTaskReviewPrompt({
			slug: 'it',
			cwd: '/tmp/x',
			candidateTasks: ['work/tasks/backlog/child.md'],
			pass: 1,
			execution: 1,
		});
		expect(prompt).toContain(REVIEW_EDITS_SCRATCH_DIR);
		expect(prompt).toMatch(/"src"/);
		expect(prompt).toMatch(/do NOT inline the body in the JSON/i);
		expect(prompt).toMatch(/cap-truncate/i);
	});
});

// --- CAP-TRUNCATION detection at the harness seam (the named failure) --------

/** A stub Harness whose `launch` returns a canned LaunchResult (no real model). */
function stubHarness(result: Partial<LaunchResult>): Harness {
	return {
		adapter: 'stub',
		launch: (_input: LaunchInput): LaunchResult => ({
			ok: true,
			record: {adapter: 'stub'},
			...result,
		}),
		launchInteractive: () => {
			throw new Error('not supported');
		},
		isAlive: () => false,
	};
}

describe('harnessTaskReviewGate — names cap-truncation; never a silent approve', () => {
	it('a parse failure WITH an output-cap signal throws the NAMED ReviewOutputCappedError', async () => {
		const gate = harnessTaskReviewGate({
			harness: stubHarness({
				output: '{"verdict": "block", "findings": [', // truncated mid-object
				outputCapped: 16384,
			}),
			agentCmd: 'echo',
		});
		const cwd2 = mkdtempSync(join(tmpdir(), 'tasker-review-cap-'));
		try {
			await expect(
				gate({
					slug: 'it',
					cwd: cwd2,
					candidateTasks: ['work/tasks/backlog/child.md'],
					pass: 1,
					execution: 1,
				}),
			).rejects.toThrow(ReviewOutputCappedError);
			// And the message NAMES the cap + the token count, not a generic parse error.
			await expect(
				gate({
					slug: 'it',
					cwd: cwd2,
					candidateTasks: ['work/tasks/backlog/child.md'],
					pass: 1,
					execution: 2,
				}),
			).rejects.toThrow(/hit the model output cap \(16384 tokens\)/);
		} finally {
			rmrf(cwd2);
		}
	});

	it('a verdict that DID complete on a capped turn is HONORED (priority 1: verdict obtainable)', async () => {
		// Even though the adapter signals a cap, if the JSON verdict actually closed
		// the gate returns it (the verdict is obtainable independent of edit size).
		const complete = JSON.stringify({verdict: 'approve', findings: []});
		const gate = harnessTaskReviewGate({
			harness: stubHarness({output: complete, outputCapped: 16384}),
			agentCmd: 'echo',
		});
		const cwd2 = mkdtempSync(join(tmpdir(), 'tasker-review-cap-'));
		try {
			const verdict = await gate({
				slug: 'it',
				cwd: cwd2,
				candidateTasks: ['work/tasks/backlog/child.md'],
				pass: 1,
				execution: 1,
			});
			expect(verdict.verdict).toBe('approve');
		} finally {
			rmrf(cwd2);
		}
	});

	it('a parse failure with NO cap signal stays the generic ReviewParseError (not mis-named)', async () => {
		const gate = harnessTaskReviewGate({
			harness: stubHarness({output: 'totally unparseable prose'}),
			agentCmd: 'echo',
		});
		const cwd2 = mkdtempSync(join(tmpdir(), 'tasker-review-cap-'));
		try {
			const err = await gate({
				slug: 'it',
				cwd: cwd2,
				candidateTasks: ['work/tasks/backlog/child.md'],
				pass: 1,
				execution: 1,
			}).then(
				() => undefined,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(ReviewParseError);
			expect(err).not.toBeInstanceOf(ReviewOutputCappedError);
			expect((err as Error).message).toMatch(/no parseable/);
		} finally {
			rmrf(cwd2);
		}
	});

	it('a failed launch (ok=false) throws a ReviewParseError naming the launch failure', async () => {
		const gate = harnessTaskReviewGate({
			harness: stubHarness({ok: false, detail: 'pi crashed'}),
			agentCmd: 'echo',
		});
		const cwd2 = mkdtempSync(join(tmpdir(), 'tasker-review-cap-'));
		try {
			await expect(
				gate({
					slug: 'it',
					cwd: cwd2,
					candidateTasks: ['work/tasks/backlog/child.md'],
					pass: 1,
					execution: 1,
				}),
			).rejects.toThrow(/task review agent launch failed.*pi crashed/);
		} finally {
			rmrf(cwd2);
		}
	});
});

describe('ReviewOutputCappedError — is a ReviewParseError subclass (uniform bounce routing)', () => {
	it('is a ReviewParseError so every existing catch routes it to needs-attention', () => {
		const err = new ReviewOutputCappedError(16384);
		expect(err).toBeInstanceOf(ReviewParseError);
		expect(err.outputTokens).toBe(16384);
		expect(err.message).toMatch(/16384 tokens/);
		expect(err.name).toBe('ReviewOutputCappedError');
	});
});
