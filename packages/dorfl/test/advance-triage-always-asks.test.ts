import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {join} from 'node:path';
import {mkdirSync, writeFileSync, existsSync, readFileSync} from 'node:fs';
import {performAdvance} from '../src/advance.js';
import type {SurfaceGate, SurfaceEmit} from '../src/surface-gate.js';
import type {ApplyDecider} from '../src/apply-decide.js';
import type {DecisionVerdict} from '../src/decision-engine.js';
import {parseSidecar} from '../src/sidecar.js';
import {parseFrontmatter} from '../src/frontmatter.js';
import {
	newSidecar,
	serialiseSidecar,
	type SidecarModel,
} from '../src/sidecar.js';
import {
	makeScratch,
	gitIn,
	seedRepoWithArbiter,
	existsOnArbiterMain,
	type Scratch,
} from './helpers/gitRepo.js';
import type {
	AcquireAdvancingLockResult,
	ReleaseAdvancingLockResult,
} from '../src/advancing-lock.js';

/**
 * TRIAGE ALWAYS ASKS (the "no limbo, ever" redesign).
 *
 * The old design delegated the triage QUESTION to the flaky `surface-questions`
 * LLM agent and, when the agent emitted EMPTY (or flaked with "no parseable
 * emit"), errored out with a loud "limbo" usage-error. That crashed
 * advance-lifecycle legs on decisions-records / rationale notes / any observation
 * the agent judged had "nothing to ask", and on any malformed-frontmatter file.
 *
 * The redesign: the triage rung ALWAYS surfaces a DETERMINISTIC, engine-built
 * triage question ("What should become of this observation? resolve / promote /
 * delete / duplicate"). The LLM surfacer is ADDITIVE ONLY — it may add extra
 * pointed questions it extracts from the body, but it can NEVER zero out the
 * triage question and its flake/empty is NON-FATAL. So:
 *   - a record / markerless / malformed-frontmatter observation gets the triage
 *     question in a sidecar and exits 0 (the human triages it via the sidecar,
 *     exactly what sidecars are for) — NOT a crash;
 *   - the AUTO gate (observationTriage:'auto') still short-circuits ONLY the
 *     conservative duplicate/map cases BEFORE surfacing (a separate LLM);
 *   - the APPLY path (answer-handling) is unchanged.
 */

let scratch: Scratch;
beforeEach(() => {
	scratch = makeScratch('dorfl-advance-triage-asks-');
});
afterEach(() => {
	scratch.cleanup();
});

const ACQUIRED: AcquireAdvancingLockResult = {
	exitCode: 0,
	outcome: 'acquired',
	message: 'locked',
};
const RELEASED: ReleaseAdvancingLockResult = {
	exitCode: 0,
	outcome: 'released',
	message: 'released',
};

/**
 * Seed an observation with a chosen frontmatter shape. `frontmatter: 'none'`
 * writes NO fence at all (a bare `#`-heading record — the shape that used to
 * crash); `'partial'` writes only `title`/`date` (no `type`/`status`/marker);
 * `'full'` writes a normal observation block. `triaged`/`needsAnswers` are added
 * when given.
 */
function seedObservation(
	repo: string,
	slug: string,
	opts: {
		frontmatter?: 'none' | 'partial' | 'full';
		triaged?: string;
		needsAnswers?: boolean;
		/**
		 * Add a non-empty `## Open questions` block so the surface rung's
		 * decision-record short-circuit (task
		 * `surface-short-circuit-already-triaged-observations-and-harden-skill-empty-emit`)
		 * does NOT fire — use this in tests that need the surface-questions agent
		 * to be dispatched (e.g. "agent flakes", "agent adds extras").
		 */
		provokesAgent?: boolean;
	} = {},
): {itemPath: string} {
	const itemPath = `work/notes/observations/${slug}.md`;
	mkdirSync(join(repo, 'work', 'notes', 'observations'), {recursive: true});
	const shape = opts.frontmatter ?? 'full';
	const tail =
		opts.provokesAgent === true
			? ['## Open questions', '', '- Is this the right layer?', '']
			: [];
	const body = [
		'',
		`# ${slug}`,
		'',
		'A durable note recorded here.',
		'',
		...tail,
	];
	let lines: string[];
	if (shape === 'none') {
		lines = body;
	} else {
		const fm: string[] = ['---'];
		if (shape === 'full') {
			fm.push('type: observation', 'status: spotted', `spotted: 2026-07-12`);
		} else {
			fm.push(`title: ${slug}`, 'date: 2026-07-12');
		}
		if (opts.needsAnswers !== undefined) {
			fm.push(`needsAnswers: ${opts.needsAnswers}`);
		}
		if (opts.triaged !== undefined) {
			fm.push(`triaged: ${opts.triaged}`);
		}
		fm.push('---');
		lines = [...fm, ...body];
	}
	writeFileSync(join(repo, itemPath), lines.join('\n'));
	return {itemPath};
}

/** A throwaway repo with one seeded observation of a chosen shape. */
function seedRepoWith(
	slug: string,
	opts: Parameters<typeof seedObservation>[2] = {},
): {repo: string; itemPath: string} {
	const repo = join(scratch.root, 'project');
	mkdirSync(repo, {recursive: true});
	gitIn(['init', '-q', '-b', 'main'], repo);
	const {itemPath} = seedObservation(repo, slug, opts);
	gitIn(['add', '-A'], repo);
	gitIn(['commit', '-q', '-m', 'seed observation'], repo);
	return {repo, itemPath};
}

/** A surface gate stub with a canned emit + a flag to simulate a FLAKE (throw). */
function spySurface(opts: {emit?: SurfaceEmit; throwErr?: string} = {}): {
	gate: SurfaceGate;
	spawns: string[];
} {
	const spawns: string[] = [];
	const gate: SurfaceGate = async (input) => {
		spawns.push(input.item);
		if (opts.throwErr !== undefined) {
			throw new Error(opts.throwErr);
		}
		return {item: input.item, questions: [], ...(opts.emit ?? {})};
	};
	return {gate, spawns};
}

function spyDecide(verdict: DecisionVerdict): ApplyDecider {
	return async () => verdict;
}

function readSidecar(repo: string, slug: string): SidecarModel {
	return parseSidecar(
		readFileSync(
			join(repo, 'work', 'questions', `observation-${slug}.md`),
			'utf8',
		),
	);
}

describe('advance triage — ALWAYS surfaces a deterministic triage question (no limbo)', () => {
	it('a RECORD the agent has NOTHING to ask about ⇒ triage question surfaced, exit 0 (was: loud limbo error)', async () => {
		const {repo} = seedRepoWith('decisions-record');
		// The agent honestly emits EMPTY (a record has no open judgement of its own).
		const {gate, spawns} = spySurface({emit: {questions: []}});

		const notes: string[] = [];
		const result = await performAdvance({
			arg: 'obs:decisions-record',
			cwd: repo,
			surfaceGate: gate,
			acquireLock: async () => ACQUIRED,
			releaseLock: async () => RELEASED,
			note: (m) => notes.push(m),
		});

		expect(result.exitCode).toBe(0);
		expect(result.outcome).toBe('advanced');
		expect(result.rung).toBe('triage-observation');
		// The sidecar exists and carries the deterministic triage question as q1.
		const sc = readSidecar(repo, 'decisions-record');
		expect(sc.entries.length).toBeGreaterThanOrEqual(1);
		expect(sc.entries[0].question.toLowerCase()).toContain('become');
		// NO limbo error anywhere.
		expect(result.message.toLowerCase()).not.toContain('limbo');
		expect(notes.join('\n').toLowerCase()).not.toContain('limbo');
	});

	it('the agent FLAKES (no parseable emit) ⇒ STILL surfaces the triage question, exit 0 (was: crash)', async () => {
		// `provokesAgent` so the short-circuit does NOT fire — we want the flake path.
		const {repo} = seedRepoWith('flaky-target', {provokesAgent: true});
		const {gate, spawns} = spySurface({
			throwErr: 'surface agent produced no parseable {questions} result',
		});

		const result = await performAdvance({
			arg: 'obs:flaky-target',
			cwd: repo,
			surfaceGate: gate,
			acquireLock: async () => ACQUIRED,
			releaseLock: async () => RELEASED,
		});

		expect(spawns).toEqual(['observation:flaky-target']);
		expect(result.exitCode).toBe(0);
		expect(result.outcome).toBe('advanced');
		const sc = readSidecar(repo, 'flaky-target');
		expect(sc.entries[0].question.toLowerCase()).toContain('become');
	});

	it('MALFORMED frontmatter (no fence at all, bare `#` record) ⇒ triage question surfaced, never crashes on shape', async () => {
		const {repo} = seedRepoWith('no-frontmatter', {frontmatter: 'none'});
		const {gate} = spySurface({emit: {questions: []}});

		const result = await performAdvance({
			arg: 'obs:no-frontmatter',
			cwd: repo,
			surfaceGate: gate,
			acquireLock: async () => ACQUIRED,
			releaseLock: async () => RELEASED,
		});

		expect(result.exitCode).toBe(0);
		expect(result.outcome).toBe('advanced');
		expect(
			existsSync(
				join(repo, 'work', 'questions', 'observation-no-frontmatter.md'),
			),
		).toBe(true);
	});

	it('the agent DOES add extra questions ⇒ ONE sidecar: q1 = triage question, then the extras', async () => {
		// `provokesAgent` so the short-circuit does NOT fire — we want the agent to add extras.
		const {repo} = seedRepoWith('rich-note', {provokesAgent: true});
		const {gate} = spySurface({
			emit: {
				questions: [
					{question: 'Is the CLI surface right?'},
					{question: 'Should the exit code be 2?'},
				],
			},
		});

		const result = await performAdvance({
			arg: 'obs:rich-note',
			cwd: repo,
			surfaceGate: gate,
			acquireLock: async () => ACQUIRED,
			releaseLock: async () => RELEASED,
		});

		expect(result.exitCode).toBe(0);
		const sc = readSidecar(repo, 'rich-note');
		expect(sc.entries.length).toBe(3);
		// q1 = the deterministic triage question; then the agent's two extras.
		expect(sc.entries[0].question.toLowerCase()).toContain('become');
		expect(sc.entries[1].question).toBe('Is the CLI surface right?');
		expect(sc.entries[2].question).toBe('Should the exit code be 2?');
	});

	it('a RE-tick when the sidecar already exists ⇒ does NOT duplicate the triage question', async () => {
		const {repo} = seedRepoWith('resurface');
		const {gate} = spySurface({emit: {questions: []}});
		const opts = {
			arg: 'obs:resurface',
			cwd: repo,
			surfaceGate: gate,
			acquireLock: async () => ACQUIRED,
			releaseLock: async () => RELEASED,
		};
		// First tick creates the sidecar with the triage question.
		await performAdvance(opts);
		const first = readSidecar(repo, 'resurface');
		expect(first.entries.length).toBe(1);
		// Second tick (still empty agent) must NOT append a duplicate triage q.
		await performAdvance(opts);
		const second = readSidecar(repo, 'resurface');
		expect(second.entries.length).toBe(1);
	});

	it('a SETTLED observation (`triaged:` set) ⇒ NOT enumerated as a triage candidate (no question, no spawn)', async () => {
		const {repo} = seedRepoWith('settled', {triaged: 'resolve'});
		const {gate, spawns} = spySurface({emit: {questions: []}});

		const result = await performAdvance({
			arg: 'obs:settled',
			cwd: repo,
			surfaceGate: gate,
			acquireLock: async () => ACQUIRED,
			releaseLock: async () => RELEASED,
		});

		// A settled observation is a calm no-op — it is NOT a triage candidate, so
		// the triage question is NOT surfaced. (An explicit obs: on a settled item
		// still classifies as settled/no-op.)
		expect(result.exitCode).toBe(0);
		expect(result.outcome).toBe('no-op');
		expect(spawns).toEqual([]);
		expect(
			existsSync(join(repo, 'work', 'questions', 'observation-settled.md')),
		).toBe(false);
	});

	// ADR `resolve-settles-the-question-loop-not-the-note` — the LEGACY arm. Notes
	// resolved-and-KEPT before the apply rung stamped `triaged:` still rest with NO
	// marker, which is byte-identical (to the classifier) to a never-triaged note.
	// They carry the ENGINE-WRITTEN `## Applied answers` record, which is proof the
	// engine already applied a human's answers, so the triage rung back-stamps the
	// marker instead of re-asking a question the human has already answered.
	it('a LEGACY resolved-and-kept note (`## Applied answers`, no `triaged:` marker) ⇒ back-stamped + no-op, NOT re-asked', async () => {
		const {repo, itemPath} = seedRepoWith('legacy-resolved');
		// Reproduce the pre-fix end-state exactly: needsAnswers cleared, no sidecar,
		// answers harvested into the body, and NO `triaged:` marker.
		writeFileSync(
			join(repo, itemPath),
			[
				'---',
				'title: legacy-resolved',
				'needsAnswers: false',
				'---',
				'',
				'A standing record of a known gap.',
				'',
				'## Applied answers 2026-08-11',
				'',
				'### q1: What should become of this observation?',
				'',
				'Keep (resolve, note stays) — it is the only record of these choices.',
				'',
			].join('\n'),
		);
		gitIn(['add', '-A'], repo);
		gitIn(['commit', '-q', '-m', 'legacy resolved-and-kept note'], repo);
		const {gate, spawns} = spySurface({emit: {questions: []}});

		const result = await performAdvance({
			arg: 'obs:legacy-resolved',
			cwd: repo,
			surfaceGate: gate,
			acquireLock: async () => ACQUIRED,
			releaseLock: async () => RELEASED,
		});

		expect(result.exitCode).toBe(0);
		expect(result.outcome).toBe('no-op');
		expect(spawns).toEqual([]);
		// No question was surfaced — and the note now carries the marker, so the NEXT
		// tick drops it at the pool (this arm can never fire twice).
		expect(
			existsSync(
				join(repo, 'work', 'questions', 'observation-legacy-resolved.md'),
			),
		).toBe(false);
		const body = readFileSync(join(repo, itemPath), 'utf8');
		expect(parseFrontmatter(body).triaged).toBe('resolve');
		// The stamp is committed (not left dirty), so the tree-less publish carries it.
		expect(gitIn(['status', '--porcelain'], repo).trim()).toBe('');

		// And it is IDEMPOTENT: a second tick finds the marker and stays a no-op.
		const again = await performAdvance({
			arg: 'obs:legacy-resolved',
			cwd: repo,
			surfaceGate: gate,
			acquireLock: async () => ACQUIRED,
			releaseLock: async () => RELEASED,
		});
		expect(again.outcome).toBe('no-op');
		expect(spawns).toEqual([]);
	});
});

describe('advance triage — the answer path (apply) is unchanged', () => {
	it('an ANSWERED triage sidecar ⇒ the agentic apply verdict fires (promote → new backlog task)', async () => {
		const seeded = seedRepoWithArbiter(scratch.root, []);
		seedObservation(seeded.repo, 'happy', {needsAnswers: true});
		let model: SidecarModel = newSidecar('observation:happy', [
			{question: 'What should become of this observation?'},
		]);
		model = {
			...model,
			entries: model.entries.map((e) => ({...e, answer: 'promote to a task'})),
		};
		mkdirSync(join(seeded.repo, 'work', 'questions'), {recursive: true});
		writeFileSync(
			join(seeded.repo, 'work', 'questions', 'observation-happy.md'),
			serialiseSidecar(model),
		);
		gitIn(['add', '-A'], seeded.repo);
		gitIn(['commit', '-q', '-m', 'seed answered observation'], seeded.repo);
		gitIn(['push', '-q', 'arbiter', 'main'], seeded.repo);

		const result = await performAdvance({
			arg: 'obs:happy',
			cwd: seeded.repo,
			arbiter: 'arbiter',
			applyDecide: spyDecide({outcome: 'task'}),
			acquireLock: async () => ACQUIRED,
			releaseLock: async () => RELEASED,
		});

		expect(result.exitCode).toBe(0);
		expect(result.outcome).toBe('advanced');
		expect(result.rung).toBe('apply');
		expect(existsOnArbiterMain(seeded.repo, 'backlog', 'happy')).toBe(true);
	});
});
