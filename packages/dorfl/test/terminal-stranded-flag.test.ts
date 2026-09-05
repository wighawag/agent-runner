import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {
	classifyTerminalQuestionResidue,
	reconcileTerminalQuestionResidue,
	surfaceStuckToNeedsAttention,
} from '../src/needs-attention.js';
import {emptyDiffDisposeEnvelope} from '../src/agent-stop.js';
import {sweepOrphanSidecars} from '../src/orphan-sidecar.js';
import {performClaim} from '../src/claim-cas.js';
import {parseFrontmatter} from '../src/frontmatter.js';
import {newSidecar, serialiseSidecar, sidecarPathFor} from '../src/sidecar.js';
import {run, git} from '../src/git.js';
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
	scratch = makeScratch('dorfl-stranded-flag-');
});
afterEach(() => {
	scratch.cleanup();
});

/**
 * THE DEFECT THIS FILE EXISTS FOR: the half the sidecar-anchored drain cannot see.
 *
 * A bounce writes BOTH halves of the question state atomically (sidecar +
 * `needsAnswers:true`). The paired residue (both halves surviving onto a
 * terminal item) is drained by `terminal-question-residue.test.ts`. But the two
 * halves can be SEPARATED, and in the one order that sweep is blind to: the
 * SIDECAR goes first and the FLAG is left behind.
 *
 * Three routes reach it, none exotic:
 *
 *   1. **An item that was never surfaced at all.** `needsAnswers:true` with no
 *      sidecar is the LEGAL authored state (the tasker sets it on an uncertain
 *      task, `tasking.ts`), and the flag is only a WARNING on the human claim
 *      path, so a human can answer the questions in conversation, build the
 *      task and complete it. The flag then rides the done-move into
 *      `tasks/done/` and no sidecar ever existed to anchor a sweep on.
 *   2. **A human tidying `work/questions/` by hand**, the obvious manual
 *      clean-up for the paired residue, which deletes precisely the half the
 *      sidecar-anchored sweep needs to find the other one.
 *   3. **The paired drain's own defense-in-depth guard**: it removes the sidecar
 *      unconditionally but SKIPS the flag clear on a body it cannot annotate,
 *      producing this exact state and then being unable to see it again.
 *
 * Note the scope: `tasks/done/` ONLY. `specs/tasked/` is a terminal residence
 * but NOT a closed question loop: WORK-CONTRACT makes a bare flag there a legal
 * DRIFT gate and `lifecycle-gather.ts` feeds it to the surface rung, so it is
 * excluded, and the negatives below pin that.
 *
 * The flag is the HARMFUL half (a gate over shipped work, and the state an item
 * would be re-opened into), so a sweep that clears it only while its sidecar
 * survives settles the cosmetic half and leaves the load-bearing one, with no
 * mechanism anywhere able to reach it afterwards.
 */

/** An UNANSWERED bounce sidecar, built with the REAL writer. */
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

/** The same sidecar, but carrying a human's written ANSWER. */
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

function seedOnMain(arbiter: string, files: Record<string, string>): void {
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
	run('git', ['commit', '-q', '-m', 'seed'], dest, {env});
	run('git', ['push', '-q', 'origin', 'seed:main'], dest, {env});
	rmrf(dest);
}

function onMain(repo: string, path: string): boolean {
	gitIn(['fetch', '-q', ARBITER], repo);
	return (
		run('git', ['cat-file', '-e', `${MAIN}:${path}`], repo, {env: gitEnv()})
			.status === 0
	);
}
function readOnMain(repo: string, path: string): string {
	gitIn(['fetch', '-q', ARBITER], repo);
	return run('git', ['show', `${MAIN}:${path}`], repo, {env: gitEnv()}).stdout;
}
function flagOnMain(repo: string, path: string): unknown {
	return parseFrontmatter(readOnMain(repo, path)).needsAnswers;
}

const q = (name: string) => `work/questions/${name}`;
const at = (folder: string, slug: string) =>
	`work/${fixtureFolderRel(folder)}/${slug}.md`;

describe('stranded needsAnswers gate on a terminal item (no sidecar left)', () => {
	it('CLEARS the armed gate on a task at rest in tasks/done/', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		// The bounce wrote both halves; the human then deleted the stale sidecar by
		// hand (the documented tidy-up) and the gate was left armed over shipped work.
		seedOnMain(arbiter, {
			[at('done', 'shipped')]: taskBody('shipped', true),
		});
		expect(flagOnMain(repo, at('done', 'shipped'))).toBe(true);

		const report = await classifyTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});
		expect(report.staleFlags.map((r) => r.item)).toEqual(['task:shipped']);

		const res = await reconcileTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});

		// Reported as unflagged, never as `drained` (no sidecar was deleted).
		expect(res.unflagged).toEqual(['task:shipped']);
		expect(res.drained).toEqual([]);
		expect(res.errors).toEqual([]);
		expect(flagOnMain(repo, at('done', 'shipped'))).toBe(false);
	});

	it('drains on the CLAIM path, the same pass as the paired residue', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['next']);
		seedOnMain(arbiter, {
			[at('done', 'stranded')]: taskBody('stranded', true),
		});

		const claim = await performClaim({
			slug: 'next',
			cwd: repo,
			arbiter: ARBITER,
			env: gitEnv(),
		});
		expect(claim.exitCode).toBe(0);

		expect(flagOnMain(repo, at('done', 'stranded'))).toBe(false);
	});

	it('finds the residue when dorfl is run from a SUBDIRECTORY', async () => {
		// `git grep` resolves its pathspecs against the PROCESS CWD, unlike the
		// `ls-tree`/`cat-file` probes beside it which are tree-relative. Without the
		// `:(top,literal)` pathspecs this half is a silent no-op whenever a command
		// is run from anywhere but the repo root.
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		seedOnMain(arbiter, {[at('done', 'subdir')]: taskBody('subdir', true)});
		const sub = join(repo, 'work', 'tasks');
		mkdirSync(sub, {recursive: true});

		const res = await reconcileTerminalQuestionResidue({
			cwd: sub,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});

		expect(res.unflagged).toEqual(['task:subdir']);
		expect(flagOnMain(repo, at('done', 'subdir'))).toBe(false);
	});

	it('finds a residue body whose path is NON-ASCII', async () => {
		// git C-quotes non-ASCII paths by default, and a quoted line fails the
		// folder-prefix test, so such a body would be silently skipped for ever.
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		seedOnMain(arbiter, {
			[at('done', 'café-ünicøde')]: taskBody('café-ünicøde', true),
		});

		const res = await reconcileTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});

		expect(res.unflagged).toEqual(['task:café-ünicøde']);
		expect(flagOnMain(repo, at('done', 'café-ünicøde'))).toBe(false);
	});

	it('finds a gate written as a QUOTED or upper-case value', async () => {
		// `toBoolean` unquotes and lower-cases, so `needsAnswers: 'True'` is a real
		// armed gate. The candidate grep must not read tighter than the parser.
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		const quoted = taskBody('quoted', true).replace(
			'needsAnswers: true',
			"needsAnswers: 'True'",
		);
		seedOnMain(arbiter, {[at('done', 'quoted')]: quoted});
		expect(flagOnMain(repo, at('done', 'quoted'))).toBe(true);

		const res = await reconcileTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});

		expect(res.unflagged).toEqual(['task:quoted']);
		expect(flagOnMain(repo, at('done', 'quoted'))).toBe(false);
	});

	it('is idempotent - a second pass is a clean no-op', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		seedOnMain(arbiter, {[at('done', 'twice')]: taskBody('twice', true)});
		const opts = {cwd: repo, arbiter: ARBITER, mainRef: MAIN, env: gitEnv()};

		expect((await reconcileTerminalQuestionResidue(opts)).unflagged).toEqual([
			'task:twice',
		]);
		const second = await reconcileTerminalQuestionResidue(opts);
		expect(second.unflagged).toEqual([]);
		expect(second.errors).toEqual([]);
	});
});

/**
 * THE NEGATIVES. Each is a state a careless widening of the sweep destroys, and
 * together they are the reason the discriminator is POSITION rather than the
 * flag/sidecar disagreement.
 */
describe('the negatives - what the stranded-flag sweep must never touch', () => {
	it('leaves a POOL item with a bare flag and no sidecar alone (the surface rung\u2019s input)', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		seedOnMain(arbiter, {
			[at('backlog', 'unsurfaced')]: taskBody('unsurfaced', true),
		});

		const res = await reconcileTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});

		expect(res.unflagged).toEqual([]);
		// Clearing this would hand gated work to an agent.
		expect(flagOnMain(repo, at('backlog', 'unsurfaced'))).toBe(true);
	});

	it('leaves a STAGING item with a bare flag alone', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		seedOnMain(arbiter, {
			[at('pre-backlog', 'staged')]: taskBody('staged', true),
		});

		const res = await reconcileTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});

		expect(res.unflagged).toEqual([]);
		expect(flagOnMain(repo, at('pre-backlog', 'staged'))).toBe(true);
	});

	it('leaves a POOL item with a PENDING unanswered sidecar alone', async () => {
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
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
		expect(res.unflagged).toEqual([]);
		expect(onMain(repo, q('task-pending.md'))).toBe(true);
		expect(flagOnMain(repo, at('backlog', 'pending'))).toBe(true);
	});

	it('leaves a TASKED SPEC alone: a bare flag there is a legal DRIFT gate', async () => {
		// WORK-CONTRACT, "A SPEC that has drifted AFTER it was TASKED": setting
		// `needsAnswers: true` while the spec STAYS in `specs/tasked/` is legal and
		// means "tasked, but drifted - do not RE-task or rely on it until
		// reconciled". `lifecycle-gather.ts` enumerates tasked resting specs
		// UNCONDITIONALLY and routes a bare flag to the SURFACE rung, so this is a
		// LIVE gate with a rung that will run - not residue. Clearing it would let a
		// stale spec be re-tasked.
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		seedOnMain(arbiter, {
			[at('prd-tasked', 'drifted')]: taskBody('drifted', true),
		});

		const report = await classifyTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});
		expect(report.staleFlags).toEqual([]);

		const res = await reconcileTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});

		expect(res.unflagged).toEqual([]);
		expect(flagOnMain(repo, at('prd-tasked', 'drifted'))).toBe(true);
	});

	it('leaves a TASKED SPEC’s PENDING sidecar and flag alone', async () => {
		// The same contract clause, with the drift already surfaced. Both halves are
		// live inputs to a rung that will run, so neither may be drained.
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		seedOnMain(arbiter, {
			[at('prd-tasked', 'drifted2')]: taskBody('drifted2', true),
			[q('spec-drifted2.md')]: unansweredSidecar('spec:drifted2'),
		});

		const res = await reconcileTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});

		expect(res.drained).toEqual([]);
		expect(res.unflagged).toEqual([]);
		expect(onMain(repo, q('spec-drifted2.md'))).toBe(true);
		expect(flagOnMain(repo, at('prd-tasked', 'drifted2'))).toBe(true);
	});

	it('KEEPS the flag on a CANCELLED item (accurate history, not residue)', async () => {
		// An item can be cancelled precisely BECAUSE its questions went unanswered.
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		seedOnMain(arbiter, {
			[at('cancelled', 'abandoned')]: taskBody('abandoned', true),
		});

		const res = await reconcileTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});

		expect(res.unflagged).toEqual([]);
		expect(flagOnMain(repo, at('cancelled', 'abandoned'))).toBe(true);
	});

	it('does NOT clear the gate of a terminal item whose sidecar carries a human ANSWER', async () => {
		// The answered-sidecar carve-out must not be bypassable through the
		// flag-only path: clearing the gate would half-settle an item whose answer
		// nothing has applied yet.
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		seedOnMain(arbiter, {
			[at('done', 'answered')]: taskBody('answered', true),
			[q('task-answered.md')]: answeredSidecar('task:answered'),
		});

		const res = await reconcileTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});

		expect(res.drained).toEqual([]);
		expect(res.unflagged).toEqual([]);
		expect(res.answeredHeld).toEqual(['task:answered']);
		// The human's prose survives verbatim, and so does the gate.
		expect(readOnMain(repo, q('task-answered.md'))).toMatch(
			/Close this sidecar/,
		);
		expect(flagOnMain(repo, at('done', 'answered'))).toBe(true);
	});

	it('does not report a body it could not actually annotate as unflagged', async () => {
		// A duplicate-key body: the marker writer replaces the FIRST occurrence, the
		// parser reads the LAST, so the gate survives the rewrite. Reporting it as
		// cleared would be "reports success while the defect remains" - the exact
		// failure this change exists to correct - repeated on every claim for ever.
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		const body = [
			'---',
			'title: dup',
			'needsAnswers: false',
			'needsAnswers: true',
			'---',
			'',
			'## Prompt',
			'',
			'do the thing',
			'',
		].join('\n');
		seedOnMain(arbiter, {[at('done', 'dup')]: body});
		expect(flagOnMain(repo, at('done', 'dup'))).toBe(true);

		const res = await reconcileTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});

		// The gate genuinely survived, so it must NOT be claimed as cleared.
		expect(flagOnMain(repo, at('done', 'dup'))).toBe(true);
		expect(res.unflagged).toEqual([]);
	});

	it('does not mistake a body that merely MENTIONS needsAnswers for a flagged one', async () => {
		// The enumeration shortlists with `git grep`; the decision is the parsed
		// frontmatter. Bodies discussing the flag in prose are common in this repo.
		const {repo, arbiter} = seedRepoWithArbiter(scratch.root, ['keeper']);
		const body = taskBody('prose', false).replace(
			'do the thing',
			'Discussion: an item with needsAnswers: true is build-ineligible.',
		);
		seedOnMain(arbiter, {[at('done', 'prose')]: body});

		const report = await classifyTerminalQuestionResidue({
			cwd: repo,
			arbiter: ARBITER,
			mainRef: MAIN,
			env: gitEnv(),
		});

		expect(report.staleFlags).toEqual([]);
		// The body is left byte-identical (no pointless commit over prose).
		expect(readOnMain(repo, at('done', 'prose'))).toBe(body);
	});
});

/**
 * THE ORPHAN SWEEP'S GUARD, which this change must not disturb. `gc`'s reaper
 * keys on "is the SOURCE ITEM gone", NOT on "is the item terminal": a terminal
 * item is a durable RESTING record that still EXISTS, so its sidecar is not an
 * orphan. Treating terminal as gone would delete live sidecars (and any human
 * answer they carry): the 2026-07-12 false positive.
 */
describe('the orphan sweep keeps its terminal-is-not-orphan guard', () => {
	function seedPlainRepo(): string {
		const repo = join(scratch.root, 'orphan-project');
		mkdirSync(repo, {recursive: true});
		git(['init', '-q', '-b', 'main'], repo, {env: gitEnv()});
		writeFileSync(join(repo, 'README.md'), '# project\n');
		git(['add', '-A'], repo, {env: gitEnv()});
		git(['commit', '-q', '-m', 'seed'], repo, {env: gitEnv()});
		return repo;
	}
	function write(repo: string, rel: string, content: string): void {
		const abs = join(repo, rel);
		mkdirSync(join(abs, '..'), {recursive: true});
		writeFileSync(abs, content);
		git(['add', '-A'], repo, {env: gitEnv()});
		git(['commit', '-q', '-m', `write ${rel}`], repo, {env: gitEnv()});
	}

	it('STILL reaps a sidecar whose source item was deleted out-of-band', () => {
		const repo = seedPlainRepo();
		write(
			repo,
			sidecarPathFor('task:vanished'),
			unansweredSidecar('task:vanished'),
		);
		// No body anywhere: the source is gone.

		const result = sweepOrphanSidecars({cwd: repo, env: gitEnv()});

		expect(result.reaped.map((r) => r.item)).toEqual(['task:vanished']);
		expect(existsSync(join(repo, sidecarPathFor('task:vanished')))).toBe(false);
	});

	it('does NOT reap a sidecar merely because its item reached a terminal', () => {
		const repo = seedPlainRepo();
		write(repo, at('done', 'resting'), taskBody('resting', true));
		write(
			repo,
			sidecarPathFor('task:resting'),
			answeredSidecar('task:resting'),
		);

		const result = sweepOrphanSidecars({cwd: repo, env: gitEnv()});

		expect(result.reaped).toEqual([]);
		expect(result.retained.map((r) => r.item)).toContain('task:resting');
		expect(existsSync(join(repo, sidecarPathFor('task:resting')))).toBe(true);
	});
});

/**
 * END-TO-END through the REAL bounce writer, so the fixtures above cannot drift
 * from what the surface path actually produces. The previous attempt at this
 * defect was verified only against hand-built fixtures, which is how a passing
 * suite coexisted with live residue.
 */
describe('end to end: the real bounce, then a successful rebuild', () => {
	it('clears the gate on a never-surfaced item that was simply built and completed', async () => {
		// Route 1: the LEGAL authored state (flagged, no sidecar) rides the done-move
		// into a success terminal. No bounce, no sidecar, ever.
		const {repo} = seedRepoWithArbiter(scratch.root, ['authored', 'next'], {
			needsAnswers: true,
		});
		const env = gitEnv();
		expect(flagOnMain(repo, at('backlog', 'authored'))).toBe(true);
		expect(onMain(repo, q('task-authored.md'))).toBe(false);

		gitIn(['fetch', '-q', ARBITER], repo);
		gitIn(['switch', '-q', '-C', 'work/task-authored', MAIN], repo);
		mkdirSync(join(repo, 'work', 'tasks', 'done'), {recursive: true});
		gitIn(['mv', at('backlog', 'authored'), at('done', 'authored')], repo);
		gitIn(['commit', '-q', '-m', 'feat(authored): build it; done'], repo);
		gitIn(['push', '-q', ARBITER, 'work/task-authored:main'], repo);
		expect(flagOnMain(repo, at('done', 'authored'))).toBe(true);

		const claim = await performClaim({
			slug: 'next',
			cwd: repo,
			arbiter: ARBITER,
			env,
		});
		expect(claim.exitCode).toBe(0);

		expect(flagOnMain(repo, at('done', 'authored'))).toBe(false);
	});

	it('drains both halves once the item rests in tasks/done/', async () => {
		const {repo} = seedRepoWithArbiter(scratch.root, ['rebuilt', 'next']);
		const env = gitEnv();

		// The REAL bounce: sidecar + needsAnswers:true, atomically, one commit.
		const bounce = await surfaceStuckToNeedsAttention({
			cwd: repo,
			slug: 'rebuilt',
			item: 'task:rebuilt',
			reason: 'the agent produced no change (empty diff)',
			envelope: emptyDiffDisposeEnvelope({
				item: 'task:rebuilt',
				reason: 'empty diff',
			}),
			arbiter: ARBITER,
			env,
		});
		expect(bounce.surfaced).toBe(true);
		expect(onMain(repo, q('task-rebuilt.md'))).toBe(true);
		expect(flagOnMain(repo, at('backlog', 'rebuilt'))).toBe(true);

		// The human disagrees and re-dispatches; the rebuild SUCCEEDS and the body
		// is done-moved. Nobody answers the sidecar.
		gitIn(['fetch', '-q', ARBITER], repo);
		gitIn(['switch', '-q', '-C', 'work/task-rebuilt', MAIN], repo);
		mkdirSync(join(repo, 'work', 'tasks', 'done'), {recursive: true});
		gitIn(['mv', at('backlog', 'rebuilt'), at('done', 'rebuilt')], repo);
		gitIn(['commit', '-q', '-m', 'feat(rebuilt): build it; done'], repo);
		gitIn(['push', '-q', ARBITER, 'work/task-rebuilt:main'], repo);

		expect(onMain(repo, at('done', 'rebuilt'))).toBe(true);
		expect(flagOnMain(repo, at('done', 'rebuilt'))).toBe(true);

		// The reconciling path: an ordinary next unit of work.
		const claim = await performClaim({
			slug: 'next',
			cwd: repo,
			arbiter: ARBITER,
			env,
		});
		expect(claim.exitCode).toBe(0);

		expect(onMain(repo, q('task-rebuilt.md'))).toBe(false);
		expect(flagOnMain(repo, at('done', 'rebuilt'))).toBe(false);
	});
});
