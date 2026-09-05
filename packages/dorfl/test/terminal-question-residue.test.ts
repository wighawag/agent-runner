import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {
	classifyTerminalQuestionResidue,
	reconcileTerminalQuestionResidue,
} from '../src/needs-attention.js';
import {reconcileTerminalState} from '../src/reconcile-terminal.js';
import {performClaim} from '../src/claim-cas.js';
import {parseFrontmatter} from '../src/frontmatter.js';
import {newSidecar, serialiseSidecar} from '../src/sidecar.js';
import {run} from '../src/git.js';
import {
	makeScratch,
	seedRepoWithArbiter,
	gitEnv,
	gitIn,
	fixtureFolderRel,
	rmrf,
	type Scratch,
} from './helpers/gitRepo.js';

const ARBITER = 'arbiter';
const MAIN = `${ARBITER}/main`;

let scratch: Scratch;
beforeEach(() => {
	scratch = makeScratch('dorfl-question-residue-');
});
afterEach(() => {
	scratch.cleanup();
});

/**
 * An UNANSWERED bounce sidecar, built with the REAL writer
 * (`newSidecar`/`serialiseSidecar`) rather than hand-rolled markdown, so the
 * fixture is byte-identical in shape to what the surface path actually writes.
 * The question is the empty-diff bounce's, with its destructive default.
 */
function unansweredSidecar(item: string): string {
	return serialiseSidecar(
		newSidecar(item, [
			{
				question: `the agent produced no change for ${item}. Cancel this item?`,
				context: 'the build produced an empty diff',
				default: 'yes',
				kind: 'stuck',
			},
		]),
	);
}

/** The same sidecar, but a human WROTE an answer into it and nothing ever
 * consumed it (the answered-but-undrained case seen in the field). */
function answeredSidecar(item: string): string {
	const model = newSidecar(item, [
		{
			question: `the agent produced no change for ${item}. Cancel this item?`,
			context: 'the build produced an empty diff',
			default: 'yes',
			kind: 'stuck',
		},
	]);
	model.entries[0].answer =
		'No - I re-dispatched it and it built fine. Close this sidecar.';
	return serialiseSidecar(model);
}

/** A task body with an explicit `needsAnswers` frontmatter value. */
function taskBody(slug: string, needsAnswers: boolean): string {
	return [
		'---',
		`title: ${slug}`,
		`slug: ${slug}`,
		`needsAnswers: ${needsAnswers}`,
		'blockedBy: []',
		'---',
		'',
		'## Prompt',
		'',
		'do the thing',
		'',
	].join('\n');
}

/**
 * Commit an arbitrary set of `work/` files straight onto the arbiter's `main`,
 * which is how we construct the exact residue states without paying for a real
 * bounce+rebuild cycle (the live corpus for this bug was cleaned up by hand, so
 * the states are constructed rather than inspected).
 */
function seedOnMain(
	arbiter: string,
	files: Record<string, string>,
	message = 'seed',
): void {
	const dest = join(
		scratch.root,
		`seed-${Math.random().toString(36).slice(2)}`,
	);
	const env = gitEnv();
	run('git', ['clone', '-q', `file://${arbiter}`, dest], scratch.root, {env});
	run('git', ['checkout', '-q', '-B', 'seed', 'origin/main'], dest, {env});
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(dest, rel);
		mkdirSync(join(abs, '..'), {recursive: true});
		writeFileSync(abs, content);
	}
	run('git', ['add', '-A'], dest, {env});
	run('git', ['commit', '-q', '-m', message], dest, {env});
	run('git', ['push', '-q', 'origin', 'seed:main'], dest, {env});
	rmrf(dest);
}

/** Does `path` exist on the arbiter's main, as seen from `repo`? */
function onMain(repo: string, path: string): boolean {
	gitIn(['fetch', '-q', ARBITER], repo);
	return (
		run('git', ['cat-file', '-e', `${MAIN}:${path}`], repo, {env: gitEnv()})
			.status === 0
	);
}

/** Read a file's content from the arbiter's main. */
function readOnMain(repo: string, path: string): string {
	gitIn(['fetch', '-q', ARBITER], repo);
	return run('git', ['show', `${MAIN}:${path}`], repo, {env: gitEnv()}).stdout;
}

const q = (name: string) => `work/questions/${name}`;
const at = (folder: string, slug: string) =>
	`work/${fixtureFolderRel(folder)}/${slug}.md`;

/**
 * REGRESSION for the stranded question state (observation
 * `a-rebuilt-task-leaves-its-bounce-question-asking-to-cancel-a-merged-task`).
 *
 * A bounce atomically writes BOTH halves of the question state: the sidecar AND
 * `needsAnswers:true` on the body. If the human disagrees, re-dispatches, and the
 * rebuild SUCCEEDS, neither half is cleared. The item comes to rest in
 * `tasks/done/` still carrying a question asking whether to CANCEL it, with a
 * destructive default, and a `needsAnswers` gate armed over shipped work.
 */
describe('terminal question residue - a rebuilt task drops its bounce question', () => {
	it('clears BOTH halves once the item rests in tasks/done/', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		// The state a successful rebuild leaves: body done-moved, sidecar + flag
		// never cleared.
		seedOnMain(arbiter, {
			[at('done', 'rebuilt')]: taskBody('rebuilt', true),
			[q('task-rebuilt.md')]: unansweredSidecar('task:rebuilt'),
		});
		gitIn(['fetch', '-q', ARBITER], repo);
		expect(onMain(repo, q('task-rebuilt.md'))).toBe(true);

		const res = await reconcileTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});

		expect(res.drained).toEqual(['task:rebuilt']);
		expect(res.unflagged).toEqual(['task:rebuilt']);
		// The stale question is GONE...
		expect(onMain(repo, q('task-rebuilt.md'))).toBe(false);
		// ...and the armed gate is disarmed on the terminal body.
		const body = readOnMain(repo, at('done', 'rebuilt'));
		expect(parseFrontmatter(body).needsAnswers).toBe(false);
	});

	it('is idempotent - a second pass over drained state is a clean no-op', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		seedOnMain(arbiter, {
			[at('done', 'twice')]: taskBody('twice', true),
			[q('task-twice.md')]: unansweredSidecar('task:twice'),
		});
		const opts = {
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		};
		expect((await reconcileTerminalQuestionResidue(opts)).drained).toEqual([
			'task:twice',
		]);
		const second = await reconcileTerminalQuestionResidue(opts);
		expect(second.drained).toEqual([]);
		expect(second.errors).toEqual([]);
	});
});

/**
 * THE TRAP. `needsAnswers:true` with NO sidecar is LEGAL and COMMON: an item
 * authored with open questions carries the flag and has no sidecar until
 * `surface` runs, and that flagged-but-unsurfaced item is precisely the `surface`
 * rung's INPUT. A pending sidecar on a live item is a human's outstanding
 * decision. Reconciling either would disarm gated work. The TERMINAL POSITION is
 * the discriminator, never the flag/sidecar disagreement on its own.
 */
describe('the negatives - a non-terminal item is never touched', () => {
	it('leaves a POOL item that has `needsAnswers: true` and NO sidecar alone', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		// The legal pre-surface state: flagged, unsurfaced, resting in the pool.
		seedOnMain(arbiter, {
			[at('backlog', 'unsurfaced')]: taskBody('unsurfaced', true),
		});

		const res = await reconcileTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});

		expect(res.drained).toEqual([]);
		expect(res.unflagged).toEqual([]);
		// THE FLAG SURVIVES. Clearing it would hand gated work to an agent.
		const body = readOnMain(repo, at('backlog', 'unsurfaced'));
		expect(parseFrontmatter(body).needsAnswers).toBe(true);
	});

	it('leaves a POOL item with a PENDING unanswered sidecar alone', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		// A live surfaced item: the human has not answered yet. This is a pending
		// human decision, and the classifier deliberately treats it as a no-op.
		seedOnMain(arbiter, {
			[at('backlog', 'pending')]: taskBody('pending', true),
			[q('task-pending.md')]: unansweredSidecar('task:pending'),
		});

		const res = await reconcileTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});

		expect(res.drained).toEqual([]);
		// Both halves survive intact.
		expect(onMain(repo, q('task-pending.md'))).toBe(true);
		const body = readOnMain(repo, at('backlog', 'pending'));
		expect(parseFrontmatter(body).needsAnswers).toBe(true);
	});
});

describe('the cancelled/ asymmetry and the answered-sidecar carve-out', () => {
	it('a CANCELLED item drops the stale sidecar but KEEPS its `needsAnswers` flag', async () => {
		// An item can be cancelled precisely BECAUSE its questions were never
		// answered, so there the flag is accurate history, not residue. The sidecar
		// still goes: it is an actionable prompt, with a destructive default, about
		// an item that is already gone.
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		seedOnMain(arbiter, {
			[at('cancelled', 'abandoned')]: taskBody('abandoned', true),
			[q('task-abandoned.md')]: unansweredSidecar('task:abandoned'),
		});

		const res = await reconcileTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});

		expect(res.drained).toEqual(['task:abandoned']);
		expect(res.unflagged).toEqual([]);
		expect(onMain(repo, q('task-abandoned.md'))).toBe(false);
		const body = readOnMain(repo, at('cancelled', 'abandoned'));
		expect(parseFrontmatter(body).needsAnswers).toBe(true);
	});

	it('NEVER discards a human ANSWER, even on a terminal item - it reports it instead', async () => {
		// One sidecar in the field had been answered in writing ("Close this
		// sidecar") and was still sitting there, which is evidence the drain does
		// not run on the human-answer path either. That is a SEPARATE defect; this
		// pass must not paper over it by destroying the evidence.
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		seedOnMain(arbiter, {
			[at('done', 'answered')]: taskBody('answered', true),
			[q('task-answered.md')]: answeredSidecar('task:answered'),
		});

		const report = await classifyTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});
		expect(report.drainable).toEqual([]);
		expect(report.answeredHeld.map((r) => r.item)).toEqual(['task:answered']);

		const res = await reconcileTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});
		expect(res.drained).toEqual([]);
		expect(res.answeredHeld).toEqual(['task:answered']);
		// The human's prose is still there, verbatim.
		expect(readOnMain(repo, q('task-answered.md'))).toMatch(
			/Close this sidecar/,
		);
	});
});

describe('ONE pass: the claim path settles the lock and the question state together', () => {
	it('a later claim drains an earlier item\u2019s stranded sidecar + flag', async () => {
		// The two defects share a moment (the done-move) and a blind spot, so they
		// are settled by one reconciliation on one write path, not two mechanisms.
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['next']);
		seedOnMain(arbiter, {
			[at('done', 'shipped')]: taskBody('shipped', true),
			[q('task-shipped.md')]: unansweredSidecar('task:shipped'),
		});
		expect(onMain(repo, q('task-shipped.md'))).toBe(true);

		// An ordinary next unit of work on an UNRELATED item.
		const claim = await performClaim({
			slug: 'next',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(claim.exitCode).toBe(0);

		expect(onMain(repo, q('task-shipped.md'))).toBe(false);
		expect(
			parseFrontmatter(readOnMain(repo, at('done', 'shipped'))).needsAnswers,
		).toBe(false);
	});

	it('the combined pass reports both halves', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		seedOnMain(arbiter, {
			[at('done', 'both')]: taskBody('both', true),
			[q('task-both.md')]: unansweredSidecar('task:both'),
		});

		const report = await reconcileTerminalState({
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});

		expect(report.questions.drained).toEqual(['task:both']);
		expect(report.locks.released).toEqual([]);
	});
});
