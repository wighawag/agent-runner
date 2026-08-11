import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {join} from 'node:path';
import {mkdirSync, writeFileSync, existsSync, readFileSync} from 'node:fs';
import {parseFrontmatter, setNeedsAnswersMarker} from '../src/frontmatter.js';
import {performAdvanceAuto} from '../src/advance-drivers.js';
import type {ApplyDecider} from '../src/apply-decide.js';
import type {DecisionVerdict} from '../src/decision-engine.js';
import {mergeConfig} from '../src/config.js';
import {
	newSidecar,
	serialiseSidecar,
	type SidecarModel,
} from '../src/sidecar.js';
import {
	makeScratch,
	gitIn,
	seedRepoWithArbiter,
	pathOnArbiterMain,
	type Scratch,
} from './helpers/gitRepo.js';
import type {
	AcquireAdvancingLockResult,
	ReleaseAdvancingLockResult,
} from '../src/advancing-lock.js';

/**
 * `followup-nits-route-answered-observation-sidecar-to-apply-pool` — the missing
 * end-to-end acceptance test (source task's acceptance criterion (c)) for the
 * full CLASSIFIER → APPLY → AGENTIC-DECIDE chain on an ANSWERED OBSERVATION.
 *
 * The classifier + mirror-gather parity tests (`lifecycle-pools.test.ts` +
 * `advance-autopick-lifecycle-mirror.test.ts`) already pin the routing rule
 * (an answered-sidecar observation → APPLY, ungated). This test proves the
 * downstream half: given only an answered-observation sidecar on disk (BOTH
 * create-gates off — the calm-at-rest interim), `performAdvanceAuto` MUST
 * auto-select the observation into the APPLY pool via `buildLifecyclePools`,
 * run the apply rung's agentic decision, and materialise the chosen artifact
 * while atomically removing the source + sidecar.
 *
 * House pattern: throwaway git repos + a real local arbiter (the only arbiter
 * race), an injected `applyDecide` for a deterministic verdict, and the SAME
 * assertion helpers the existing mint-task apply tests use
 * (`pathOnArbiterMain`) — end-to-end through the driver (`performAdvanceAuto`)
 * to prove the classifier feeds the apply rung, not just that the apply rung
 * works on an explicit `obs:<slug>` arg.
 */

let scratch: Scratch;
beforeEach(() => {
	scratch = makeScratch('dorfl-answered-obs-apply-e2e-');
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
 * Seed an OBSERVATION at `work/notes/observations/<slug>.md` with `needsAnswers`
 * true, plus a FULLY-ANSWERED sidecar at `work/questions/observation-<slug>.md`.
 * The observation is committed onto the repo's `main` so the arbiter path can
 * observe it there. No `triaged:` marker — the normal path an answered
 * observation lands on in the field.
 */
function seedAnsweredObservationOnMain(
	repo: string,
	slug: string,
): {itemPath: string; sidecarPath: string} {
	const itemPath = `work/notes/observations/${slug}.md`;
	mkdirSync(join(repo, 'work', 'notes', 'observations'), {recursive: true});
	writeFileSync(
		join(repo, itemPath),
		[
			'---',
			`title: ${slug}`,
			'date: 2026-07-10',
			'needsAnswers: true',
			'---',
			'',
			'A captured signal awaiting triage.',
			'',
		].join('\n'),
	);
	let model: SidecarModel = newSidecar(`observation:${slug}`, [
		{question: 'What becomes of this signal?'},
	]);
	model = {
		...model,
		entries: model.entries.map((e) => ({...e, answer: 'mint a task for it'})),
	};
	const sidecarPath = `work/questions/observation-${slug}.md`;
	mkdirSync(join(repo, 'work', 'questions'), {recursive: true});
	writeFileSync(join(repo, sidecarPath), serialiseSidecar(model));
	return {itemPath, sidecarPath};
}

/** An apply-decider stub: returns the given canned verdict, records call count. */
function spyDecide(verdict: DecisionVerdict): {
	decide: ApplyDecider;
	calls: {count: number};
} {
	const box = {count: 0};
	const decide: ApplyDecider = async () => {
		box.count++;
		return verdict;
	};
	return {decide, calls: box};
}

describe('answered observation apply — end-to-end through the driver (classifier → apply → agentic-decide)', () => {
	it('mint-task: `performAdvanceAuto` auto-selects the answered observation via `buildLifecyclePools` (BOTH create-gates OFF), runs the apply rung, mints the task on arbiter/main, and DELETES the observation + sidecar in the same commit', async () => {
		// Seed an answered observation onto the repo (no other work — the observation
		// is the ONLY candidate the classifier can enumerate).
		const seeded = seedRepoWithArbiter(scratch.root, []);
		const {itemPath, sidecarPath} = seedAnsweredObservationOnMain(
			seeded.repo,
			'e2e-mint',
		);
		gitIn(['add', '-A'], seeded.repo);
		gitIn(['commit', '-q', '-m', 'seed answered observation'], seeded.repo);
		gitIn(['push', '-q', 'arbiter', 'main'], seeded.repo);

		const {decide, calls} = spyDecide({
			outcome: 'task',
			taskBody:
				'## What to build\n\nDISTINCT-E2E-MARKER carried from the human answer.\n',
		});

		const result = await performAdvanceAuto({
			cwd: seeded.repo,
			arbiter: 'arbiter',
			applyDecide: decide,
			acquireLock: async () => ACQUIRED,
			releaseLock: async () => RELEASED,
			// BOTH create-gates OFF (the calm interim default); the answered
			// observation must STILL be selected — APPLY is CONSUME, always-on.
			lifecycleGates: {triage: false, surface: false},
			// A calm config: no build/task autonomy, no observationTriage — the ONLY
			// way the observation can be picked is via the apply sub-pool.
			config: mergeConfig({
				autoBuild: false,
				autoTask: false,
				observationTriage: 'off',
			}),
			count: 5,
		});

		expect(result.exitCode).toBe(0);
		expect(result.results).toHaveLength(1);
		const only = result.results[0];
		expect(only.exitCode).toBe(0);
		expect(only.outcome).toBe('advanced');
		expect(only.rung).toBe('apply');
		// The agentic decider was consulted exactly once — the apply rung DID reach
		// the agentic-decide seam (classifier → apply → decide, wired through).
		expect(calls.count).toBe(1);
		// The DECIDED ARTIFACT materialised on arbiter/main: a self-contained task
		// keyed on the observation's slug, carrying the drafted body.
		expect(pathOnArbiterMain(seeded.repo, 'work/tasks/ready/e2e-mint.md')).toBe(
			true,
		);
		const taskBody = gitIn(
			['show', 'arbiter/main:work/tasks/ready/e2e-mint.md'],
			seeded.repo,
		);
		expect(taskBody).toContain('DISTINCT-E2E-MARKER');
		// Source observation + sidecar are REMOVED — on arbiter/main (the create
		// commit) AND locally (the working checkout was refreshed to the new tip).
		expect(pathOnArbiterMain(seeded.repo, itemPath)).toBe(false);
		expect(pathOnArbiterMain(seeded.repo, sidecarPath)).toBe(false);
		expect(existsSync(join(seeded.repo, itemPath))).toBe(false);
		expect(existsSync(join(seeded.repo, sidecarPath))).toBe(false);
	});

	it('dispose-source: `performAdvanceAuto` on an answered observation + a `dispose` verdict discharges by deletion — source + sidecar removed in one revertible commit, no artifact on the work board', async () => {
		// The dispose-source verdict is the local-only path (no arbiter mint), so it
		// exercises the classifier → apply → decide → `applyAnsweredQuestions`
		// discharge branch end-to-end without needing an arbiter round-trip.
		const seeded = seedRepoWithArbiter(scratch.root, []);
		const {itemPath, sidecarPath} = seedAnsweredObservationOnMain(
			seeded.repo,
			'e2e-del',
		);
		gitIn(['add', '-A'], seeded.repo);
		gitIn(['commit', '-q', '-m', 'seed answered observation'], seeded.repo);

		const {decide} = spyDecide({
			outcome: 'dispose',
			disposeReason: 'DISTINCT-E2E-DISPOSE-REASON — the answer says drop it',
		});
		const result = await performAdvanceAuto({
			cwd: seeded.repo,
			arbiter: 'arbiter',
			applyDecide: decide,
			acquireLock: async () => ACQUIRED,
			releaseLock: async () => RELEASED,
			lifecycleGates: {triage: false, surface: false},
			config: mergeConfig({
				autoBuild: false,
				autoTask: false,
				observationTriage: 'off',
			}),
			count: 5,
		});

		expect(result.exitCode).toBe(0);
		expect(result.results).toHaveLength(1);
		expect(result.results[0].outcome).toBe('advanced');
		expect(result.results[0].rung).toBe('apply');
		// Discharge-by-deletion: source + sidecar are gone locally, the reason
		// rides the commit message (git history = archive).
		expect(existsSync(join(seeded.repo, itemPath))).toBe(false);
		expect(existsSync(join(seeded.repo, sidecarPath))).toBe(false);
		expect(gitIn(['log', '-1', '--format=%B', 'HEAD'], seeded.repo)).toContain(
			'DISTINCT-E2E-DISPOSE-REASON',
		);
	});

	it('resolve: `performAdvanceAuto` on an answered observation + a `resolve` verdict settles the loop WITHOUT minting and RETAINS the note — answers harvested into the body, `needsAnswers` cleared, sidecar deleted, no task/spec/adr created, note file kept', async () => {
		// The resolve verdict is the local-only "mint nothing, keep the note" path
		// (task `apply-decide-resolve-verdict-mint-nothing`). It routes to the
		// EXISTING resolve-fully branch of `applyAnsweredQuestions`, so it needs no
		// arbiter round-trip — it exercises the classifier → apply → decide →
		// `applyAnsweredQuestions` resolve-fully chain end-to-end.
		const seeded = seedRepoWithArbiter(scratch.root, []);
		const {itemPath, sidecarPath} = seedAnsweredObservationOnMain(
			seeded.repo,
			'e2e-resolve',
		);
		gitIn(['add', '-A'], seeded.repo);
		gitIn(['commit', '-q', '-m', 'seed answered observation'], seeded.repo);

		const {decide, calls} = spyDecide({
			outcome: 'resolve',
			resolveReason: 'acknowledged; keep this on record, no artifact to mint',
		});
		const result = await performAdvanceAuto({
			cwd: seeded.repo,
			arbiter: 'arbiter',
			applyDecide: decide,
			acquireLock: async () => ACQUIRED,
			releaseLock: async () => RELEASED,
			lifecycleGates: {triage: false, surface: false},
			config: mergeConfig({
				autoBuild: false,
				autoTask: false,
				observationTriage: 'off',
			}),
			count: 5,
		});

		expect(result.exitCode).toBe(0);
		expect(result.results).toHaveLength(1);
		expect(result.results[0].outcome).toBe('advanced');
		expect(result.results[0].rung).toBe('apply');
		// The agentic decider was consulted exactly once.
		expect(calls.count).toBe(1);

		// The NOTE is RETAINED (not deleted, unlike the `dispose` sibling) and now
		// carries the harvested answers; the sidecar is GONE and the flag is cleared.
		expect(existsSync(join(seeded.repo, itemPath))).toBe(true);
		expect(existsSync(join(seeded.repo, sidecarPath))).toBe(false);
		const body = readFileSync(join(seeded.repo, itemPath), 'utf8');
		expect(body).toContain('## Applied answers');
		expect(body).toContain('mint a task for it');
		expect(parseFrontmatter(body).needsAnswers).toBe(false);

		// NOTHING was minted: no task, spec, or adr materialised for this slug.
		expect(
			existsSync(join(seeded.repo, 'work/tasks/ready/e2e-resolve.md')),
		).toBe(false);
		expect(
			existsSync(join(seeded.repo, 'work/specs/proposed/e2e-resolve.md')),
		).toBe(false);
		expect(existsSync(join(seeded.repo, 'docs/adr'))).toBe(false);
	});

	it('resolve is TERMINAL for the triage loop: a SECOND full advance cycle (triage gate ON) over the resolved note is a NO-OP — no re-triage, no fresh sidecar, the same question is never re-asked', async () => {
		// The re-triage loop (source: rocketh `observation:any-casts-in-deploy-proxy-
		// diamond` — surface → answer → resolve → surface the BYTE-IDENTICAL question
		// again). Cycle 1 resolves the note; cycle 2 runs the SAME driver with the
		// triage create-gate ON (the state a consumer repo actually runs in) and must
		// find nothing to do.
		const seeded = seedRepoWithArbiter(scratch.root, []);
		const {itemPath, sidecarPath} = seedAnsweredObservationOnMain(
			seeded.repo,
			'e2e-two-cycles',
		);
		gitIn(['add', '-A'], seeded.repo);
		gitIn(['commit', '-q', '-m', 'seed answered observation'], seeded.repo);

		const {decide} = spyDecide({
			outcome: 'resolve',
			resolveReason: 'ratified; the note stays as the standing record',
		});

		// --- CYCLE 1: the answered sidecar applies with a `resolve` verdict. ---
		const first = await performAdvanceAuto({
			cwd: seeded.repo,
			arbiter: 'arbiter',
			applyDecide: decide,
			acquireLock: async () => ACQUIRED,
			releaseLock: async () => RELEASED,
			lifecycleGates: {triage: true, surface: false},
			config: mergeConfig({
				autoBuild: false,
				autoTask: false,
				observationTriage: 'ask',
			}),
			count: 5,
		});
		expect(first.exitCode).toBe(0);
		expect(first.results.map((r) => r.rung)).toEqual(['apply']);
		expect(existsSync(join(seeded.repo, itemPath))).toBe(true);
		expect(existsSync(join(seeded.repo, sidecarPath))).toBe(false);

		// --- CYCLE 2: the SAME driver, same gates, over the resolved note. ---
		// A surface gate that THROWS: reaching it at all is the bug (the triage rung
		// must never spawn a question agent for an already-resolved note).
		const second = await performAdvanceAuto({
			cwd: seeded.repo,
			arbiter: 'arbiter',
			applyDecide: decide,
			surfaceGate: async () => {
				throw new Error('the surface agent must not be reached on cycle 2');
			},
			acquireLock: async () => ACQUIRED,
			releaseLock: async () => RELEASED,
			lifecycleGates: {triage: true, surface: false},
			config: mergeConfig({
				autoBuild: false,
				autoTask: false,
				observationTriage: 'ask',
			}),
			count: 5,
		});

		// The second cycle is a NO-OP, not a re-surface: NO fresh sidecar, the flag
		// stays cleared, and the body carries exactly ONE applied-answers record.
		expect(second.exitCode).toBe(0);
		expect(second.results.every((r) => r.outcome === 'no-op')).toBe(true);
		expect(existsSync(join(seeded.repo, sidecarPath))).toBe(false);
		const body = readFileSync(join(seeded.repo, itemPath), 'utf8');
		expect(parseFrontmatter(body).needsAnswers).toBe(false);
		expect(body.match(/## Applied answers/g)?.length ?? 0).toBe(1);
		// What made cycle 2 calm is a DURABLE settled marker, not luck of ordering.
		expect(parseFrontmatter(body).triaged).toBe('resolve');
	});

	it('settling is not silencing: a GENUINELY NEW answered question on an already-resolved note still routes to APPLY (the marker never strands an answer)', async () => {
		// The other half of the acceptance: stopping the RE-ask must not stop a NEW
		// ask. A settled note with a freshly-answered sidecar is still consumed — the
		// answered sidecar dominates the `triaged:` marker (ADR
		// `answered-observation-sidecar-dominates-triaged-marker`), proven here
		// end-to-end through the driver rather than at the pool unit alone.
		const seeded = seedRepoWithArbiter(scratch.root, []);
		const {itemPath, sidecarPath} = seedAnsweredObservationOnMain(
			seeded.repo,
			'e2e-new-question',
		);
		gitIn(['add', '-A'], seeded.repo);
		gitIn(['commit', '-q', '-m', 'seed answered observation'], seeded.repo);

		const gates = {
			cwd: seeded.repo,
			arbiter: 'arbiter',
			acquireLock: async () => ACQUIRED,
			releaseLock: async () => RELEASED,
			lifecycleGates: {triage: true, surface: false},
			config: mergeConfig({
				autoBuild: false,
				autoTask: false,
				observationTriage: 'ask' as const,
			}),
			count: 5,
		};

		// Resolve it once (it comes to rest stamped `triaged: resolve`).
		await performAdvanceAuto({
			...gates,
			applyDecide: spyDecide({
				outcome: 'resolve',
				resolveReason: 'kept as the standing record',
			}).decide,
		});
		expect(
			parseFrontmatter(readFileSync(join(seeded.repo, itemPath), 'utf8'))
				.triaged,
		).toBe('resolve');

		// A human (or a later surfacer) asks something NEW about the settled note and
		// answers it — the state the marker must NOT swallow. Written the way the
		// surface persist writes it: the sidecar AND `needsAnswers:true` together, so
		// invariant 1 (`needsAnswers:false ⟺ no active sidecar`) holds throughout.
		let fresh: SidecarModel = newSidecar('observation:e2e-new-question', [
			{question: 'has the residue been acted on yet?'},
		]);
		fresh = {
			...fresh,
			entries: fresh.entries.map((e) => ({
				...e,
				answer: 'yes — mint the follow-up task now',
			})),
		};
		writeFileSync(join(seeded.repo, sidecarPath), serialiseSidecar(fresh));
		writeFileSync(
			join(seeded.repo, itemPath),
			setNeedsAnswersMarker(
				readFileSync(join(seeded.repo, itemPath), 'utf8'),
				true,
			),
		);
		gitIn(['add', '-A'], seeded.repo);
		gitIn(['commit', '-q', '-m', 'a NEW answered question'], seeded.repo);

		const {decide, calls} = spyDecide({
			outcome: 'task',
			taskBody: '## What to build\n\nFOLLOW-UP-FROM-A-SETTLED-NOTE.\n',
		});
		const third = await performAdvanceAuto({...gates, applyDecide: decide});

		// The settled note was still SELECTED and APPLIED: the new answer is acted on,
		// never stranded behind the marker.
		expect(third.exitCode).toBe(0);
		expect(third.results.map((r) => r.rung)).toEqual(['apply']);
		expect(calls.count).toBe(1);
		expect(
			pathOnArbiterMain(seeded.repo, 'work/tasks/ready/e2e-new-question.md'),
		).toBe(true);
	});
});
