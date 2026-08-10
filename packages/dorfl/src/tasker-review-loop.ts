import {readFileSync, readdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {
	workFolderPrefix,
	workFolderPath,
	workItemRel,
	stripWorkFolderPrefix,
	isWorkItemFile,
} from './work-layout.js';
import {NullHarness, type Harness} from './harness.js';
import {launchWithOptionalWatch} from './agent-launch.js';
import {
	parseReviewVerdict,
	ReviewParseError,
	ReviewOutputCappedError,
	reviewDisciplinePrompt,
	verdictContractPrompt,
	type ReviewFinding,
	type ReviewVerdict,
	type TaskEdit,
	type UncertainTask,
} from './review-verdict.js';

// Re-export the shared TaskEdit + UncertainTask sub-shapes (callers consume
// them via the tasker-loop entry-point). The verdict ITSELF is the unified
// ReviewVerdict from `review-verdict.ts` — TaskReviewVerdict is removed (task
// `review-protocol-doc-and-shared-machinery`).
export type {TaskEdit, UncertainTask} from './review-verdict.js';
export {parseReviewVerdict as parseTaskReviewVerdict} from './review-verdict.js';
export {ReviewOutputCappedError as TaskReviewOutputCappedError} from './review-verdict.js';

/**
 * The SCRATCH directory the review agent writes full-replacement task bodies to
 * (the DECOUPLED edits channel — see {@link TaskEdit.src}). Sibling of `backlog/`
 * under `work/tasks/`; NOT a {@link WorkFolderKey}, so it is never scanned by
 * {@link newOrChangedBacklog} (which reads `work/tasks/backlog/` only) and never
 * appears as a candidate task. The runner reads each `src` file, applies it to the
 * target `work/tasks/backlog/<name>.md` through the SAME scope fence, then DELETES
 * it — so the integrate's `git add -A` never sweeps the scratch into the commit. A
 * start-of-loop clean (see {@link cleanReviewEditsScratch}) reaps any stragglers a
 * crashed prior run left behind.
 */
export const REVIEW_EDITS_SCRATCH_DIR = 'work/tasks/.review-edits';

/**
 * **The tasker review→edit→re-review→converge LOOP** (`slicer-review-edit-loop`,
 * GATES spec `work/specs/ready/review.md` RESOLVED DESIGN — Shape 2 / insertion point A).
 *
 * On the `do spec:<slug>` tasking path (`tasking.ts`/`performTask`), AFTER the
 * agent produces a candidate set of `work/tasks/backlog/<slug>.md` tasks and BEFORE the
 * runner finalises/lands them, this loop RUNS the `review` SKILL
 * (`skills/review/SKILL.md`), APPLIES its findings as EDITS to the candidate task
 * files, then re-reviews — until a pass finds NO NEW blocking issue (the natural
 * terminator) or the `taskerLoopMax` hard cap is hit. It is an IMPROVER, NOT a one-shot
 * gate: tasks measurably keep getting better when reviewed, so the findings feed
 * back into edits, repeatedly. The destination/goal check is part of the SAME
 * review pass (it can itself trigger edits — which is why it is a loop).
 *
 * Two axes (the M×N grid from the idea file):
 *   - **N** — the in-context multipass: ONE agent reviews AND edits in a single
 *     context, accumulating findings across angle-switched passes. `taskerLoopMax` caps
 *     N so the loop can never run forever.
 *
 *     ⚠️ ASPIRATION-VS-BUILT (2026-06-10): the "single context" wording above is the
 *     spec's ASPIRATION, NOT what this module does at runtime. The ACTUAL N loop is
 *     RUNNER-DRIVEN and PER-PASS: `runOneExecution` does `for (pass …) { gate(…);
 *     applyEdits(…to disk…) }` — ONE agent LAUNCH per pass, the runner writing the
 *     agent's edits to the candidate task FILES (`work/tasks/backlog/`) between passes, the
 *     next pass's agent re-reading the edited files. Accumulation is via DISK +
 *     re-launch, NOT one agent retaining context. `spec/review.md` §Shape 2 is internally
 *     contradictory on this (single-context headline vs "edit the files" operative spec);
 *     this code implements the operative reading. See
 *     `work/findings/review-edit-loop-single-context-is-unbuilt-aspiration-vs-per-pass-disk-impl.md`.
 *     (Relevant to intake: PR #62's lone-task loop mirrors this per-pass STRUCTURE but
 *     accumulates IN-MEMORY, because intake must not write to `work/tasks/backlog/` pre-emit.)
 *   - **M** — fresh-context re-executions: a fresh context is simply a NEW EXECUTION
 *     of that same loop in a fresh harness launch (like the Gate-2 reviewer). The
 *     loop is implemented ONCE; M is invoking it again. `M=1` is the cheap default;
 *     `M=k` runs k independent fresh loops.
 *
 * This module wires the loop + edit-application + verdict routing AROUND the
 * `review` SKILL — it does NOT re-author the protocol (the lenses + the destination
 * check live in the skill). The agent makes the review/edit JUDGEMENTS through the
 * {@link TaskReviewGate} seam; this module applies the edits to disk and routes
 * the final verdict to the THREE outcomes (folded in from the deleted
 * `autotask-confidence`, decision B):
 *
 *   - **converge** (a pass found no NEW blocking issue) → the improved tasks land
 *     claimable.
 *   - **a specific uncertain task** → emit it `needsAnswers: true` with the
 *     questions in its body (created, not agent-buildable until a human answers).
 *   - **the whole decomposition unclear / `taskerLoopMax` exhausted with blockers** →
 *     mark the spec stuck on its per-item lock (post lock-cutover — `state: stuck`
 *     with the questions as the reason, no `work/needs-attention/` folder write),
 *     emitting NO guessed tasks.
 *
 * The verdict sink itself (the git transitions for those three outcomes) is the
 * caller's (`tasking.ts`): this module decides WHICH outcome and prepares the
 * edits/questions; the runner owns every git-state transition (the agent does no
 * git, here as everywhere).
 */

/**
 * Backwards-compatible alias for {@link ReviewFinding}. Existing imports keep
 * compiling; new code should reach for `ReviewFinding` from `review-verdict.ts`.
 */
export type TaskReviewFinding = ReviewFinding;

/**
 * The tasker-loop verdict shape is now the UNIFIED {@link ReviewVerdict}
 * (task `review-protocol-doc-and-shared-machinery`). The tasker consumes the
 * `edits` / `uncertainTasks` / `decompositionUnclear` channels; other review
 * callers consume different channels of the same wide type. This alias keeps
 * existing imports compiling; the standalone `TaskReviewVerdict` is retired.
 */
export type TaskReviewVerdict = ReviewVerdict;

/** What the review gate needs to launch a fresh-context review+edit pass. */
export interface TaskReviewGateInput {
	/** The spec slug whose candidate tasks are under review. */
	slug: string;
	/** The working clone/checkout the loop runs in (candidate tasks live here). */
	cwd: string;
	/** Repo-relative paths of the candidate tasks currently on disk. */
	candidateTasks: string[];
	/** Which review PASS this is (1-based) within the current fresh context (the N). */
	pass: number;
	/** Which fresh-context EXECUTION this is (1-based) — the M. */
	execution: number;
	/**
	 * The model the IMPROVER-loop REVIEW agent runs on (de-correlated from the
	 * tasker; the `--tasker-loop-model` family). `undefined` ⇒ no forced model.
	 * Flows through `LaunchInput.model` / `substituteModel`. DISTINCT from the
	 * acceptance gate's `reviewModel`.
	 */
	taskerLoopModel?: string;
	/** The HOST-ONLY sessions root the review session FILE is generated under. */
	sessionsDir?: string;
	/** Environment for the review-agent launch. */
	env?: NodeJS.ProcessEnv;
}

/**
 * The tasker-review-loop SEAM: run ONE fresh-context review+edit pass of the
 * candidate tasks and return a parsed verdict (incl. the edits to apply). Injected
 * by tests (a canned verdict+edits, no real model); production uses
 * {@link harnessTaskReviewGate}. Mirrors `do`'s `DoDorfl` / Gate-2's
 * `ReviewGate` injectable-seam shape so the loop wiring is testable as pure logic.
 */
export type TaskReviewGate = (
	input: TaskReviewGateInput,
) => Promise<TaskReviewVerdict>;

/** The terminal disposition of the loop — the three RESOLVED-DESIGN outcomes. */
export type LoopOutcome =
	/** A pass found no NEW blocking issue: the improved tasks land claimable. */
	| 'converged'
	/** `taskerLoopMax` hit with blockers → specific uncertain task(s) → needsAnswers. */
	| 'uncertain-tasks'
	/** `taskerLoopMax` hit / decomposition unclear → route the spec to needs-attention. */
	| 'decomposition-unclear';

/** The result of running the loop — the disposition the caller's sink routes. */
export interface RunTaskReviewLoopResult {
	/** Which of the three outcomes the loop reached. */
	outcome: LoopOutcome;
	/**
	 * The candidate tasks as they stand AFTER all applied edits, keyed by
	 * repo-relative path → final content. The caller commits these (on
	 * `converged`/`uncertain-tasks`) — on `decomposition-unclear` it emits NO
	 * tasks, so this is informational only.
	 */
	tasks: Record<string, string>;
	/**
	 * On `uncertain-tasks`: the specific tasks to emit `needsAnswers: true` with
	 * the questions recorded in their bodies. Empty otherwise.
	 */
	uncertainTasks: UncertainTask[];
	/**
	 * On `decomposition-unclear`: the questions to record as the spec's
	 * needs-attention reason (no guessed tasks emitted). Empty otherwise.
	 */
	specQuestions: string[];
	/** How many review passes ran in total across all M executions. */
	passes: number;
	/** How many fresh-context executions (M) ran. */
	executions: number;
	/** Human-readable summary of the terminal condition. */
	message: string;
}

export interface RunTaskReviewLoopOptions {
	/** The spec slug whose candidate tasks are being improved. */
	slug: string;
	/** The working clone/checkout the loop runs in. */
	cwd: string;
	/** The review+edit gate seam (tests inject a canned verdict; production: harness). */
	gate: TaskReviewGate;
	/**
	 * **The SCOPING FENCE (the requeue fix).** A snapshot of `work/tasks/backlog/` taken
	 * BEFORE this tasking run produced its candidate tasks (filename → content;
	 * the `before` map `performTask` already computes at step 3). The loop reviews,
	 * edits, and flags ONLY the tasks that are NEW or CHANGED vs this snapshot —
	 * i.e. THIS run's own output — NEVER the pre-existing, already-landed tasks
	 * that share the same `work/tasks/backlog/` directory (the normal steady state). On a
	 * populated backlog this is what keeps the loop from editing / `needsAnswers`-
	 * flagging unrelated tasks and sweeping them into the runner-owned tasking
	 * commit. Omitted ⇒ an EMPTY snapshot (every `work/tasks/backlog/*.md` is treated as
	 * this run's output — the legacy whole-directory behaviour, kept only for the
	 * degenerate empty-backlog case / direct callers that pass none).
	 */
	before?: Map<string, string>;
	/**
	 * The HARD CAP on in-context review passes (N) per fresh context. Reaching it
	 * with unresolved blockers REJECTS via the sink (never an infinite loop). The
	 * natural terminator (no new blocking issue) usually fires first.
	 */
	taskerLoopMax: number;
	/**
	 * How many fresh-context EXECUTIONS (M) to run — each a NEW launch of the same
	 * loop in a fresh context. Default 1 (the cheap degenerate case). `M>1` runs M
	 * independent fresh loops; the first that converges wins, else the last
	 * execution's blocking verdict is routed.
	 */
	executions?: number;
	/** The model the improver-loop review agent runs on (de-correlation; `--tasker-loop-model`). */
	taskerLoopModel?: string;
	/** The HOST-ONLY sessions root for the review session file. */
	sessionsDir?: string;
	/** Environment for child processes. */
	env?: NodeJS.ProcessEnv;
	/** Sink for human-readable progress notes. */
	note?: (message: string) => void;
}

/**
 * Run the tasker review→edit→converge loop over the candidate tasks currently on
 * disk under `work/tasks/backlog/`. Implements the loop ONCE; M (fresh-context
 * re-executions) is just invoking the inner loop again with a fresh launch.
 *
 * Within ONE execution (the N): run the gate (a review+edit pass), APPLY its edits
 * to the candidate task files, then re-review — until `verdict === 'approve'` (no
 * NEW blocking issue → converged) or the pass count reaches `taskerLoopMax`. On the cap
 * with a still-`block` verdict, ROUTE per the verdict's channels:
 *   - `decompositionUnclear` set ⇒ `decomposition-unclear` (spec → needs-attention,
 *     no guessed tasks);
 *   - else `uncertainTasks` (or, as a floor, every candidate task) ⇒
 *     `uncertain-tasks` (those tasks emitted `needsAnswers: true` + questions).
 *
 * With `executions > 1`, the WHOLE loop is re-run in a fresh context; the first
 * execution that converges short-circuits and lands, otherwise the LAST
 * execution's blocking routing is taken (a persistent block across M fresh
 * contexts is a strong signal).
 */
export async function runTaskReviewLoop(
	options: RunTaskReviewLoopOptions,
): Promise<RunTaskReviewLoopResult> {
	const note = options.note ?? (() => {});
	const executions = Math.max(1, options.executions ?? 1);
	const taskerLoopMax = Math.max(1, options.taskerLoopMax);
	// The SCOPING FENCE: review/edit/flag ONLY this run's own new-or-changed
	// tasks, never pre-existing landed ones (the requeue fix). No snapshot ⇒ an
	// empty one (the legacy whole-directory behaviour for the empty-backlog case).
	const before = options.before ?? new Map<string, string>();
	// Reap any review-edits SCRATCH a crashed prior run left behind, so the
	// integrate's `git add -A` never sweeps stragglers into this run's commit. The
	// loop deletes each `src` it applies too; this is the crash-recovery backstop.
	cleanReviewEditsScratch(options.cwd);

	let totalPasses = 0;
	let last: SingleExecutionResult | undefined;
	for (let m = 1; m <= executions; m++) {
		if (executions > 1) {
			note(`Tasker review loop — fresh context ${m}/${executions}.`);
		}
		const exec = await runOneExecution({
			slug: options.slug,
			cwd: options.cwd,
			gate: options.gate,
			taskerLoopMax,
			execution: m,
			before,
			taskerLoopModel: options.taskerLoopModel,
			sessionsDir: options.sessionsDir,
			env: options.env,
			note,
		});
		totalPasses += exec.passes;
		last = exec;
		if (exec.converged) {
			note(
				`Tasker review loop converged after ${exec.passes} pass(es)` +
					(executions > 1 ? ` in fresh context ${m}/${executions}` : '') +
					'; the improved tasks land.',
			);
			return {
				outcome: 'converged',
				tasks: readCandidates(options.cwd, before),
				uncertainTasks: [],
				specQuestions: [],
				passes: totalPasses,
				executions: m,
				message:
					`Tasked '${options.slug}' — the review→edit loop converged ` +
					`(${totalPasses} pass(es), ${m} fresh context(s)); no new blocking ` +
					'issue. The improved tasks land claimable.',
			};
		}
	}

	// Every execution hit `taskerLoopMax` with unresolved blockers — REJECT via the
	// sink. The LAST execution's verdict carries the routing channels.
	const verdict = last!.lastVerdict;
	if (verdict.decompositionUnclear) {
		const questions = verdict.decompositionUnclear.questions;
		note(
			`Tasker review loop did not converge within taskerLoopMax=${taskerLoopMax} ` +
				`across ${executions} fresh context(s); the whole decomposition is ` +
				'unclear — routing the spec to needs-attention (no guessed tasks).',
		);
		return {
			outcome: 'decomposition-unclear',
			tasks: readCandidates(options.cwd, before),
			uncertainTasks: [],
			specQuestions: questions,
			passes: totalPasses,
			executions,
			message:
				`The decomposition of '${options.slug}' is still unclear after ` +
				`taskerLoopMax=${taskerLoopMax} review pass(es) across ${executions} fresh ` +
				'context(s); routing the spec to needs-attention with the open ' +
				'questions, emitting no guessed tasks.',
		};
	}

	// A specific-task rejection: emit the uncertain task(s) `needsAnswers: true`.
	// SCOPED to THIS run's own output (the requeue fix): an agent-named uncertain
	// task that is NOT one of this run's new-or-changed tasks is DROPPED (the
	// agent must never flag a pre-existing landed task). Floor: if the agent named
	// none (or named only out-of-scope ones) but still blocks, treat THIS run's own
	// candidates as uncertain — never land a task the loop could not approve, never
	// silently drop the rejection, but never escape to unrelated tasks.
	const ownPaths = new Set(newOrChangedBacklog(options.cwd, before));
	const named = (verdict.uncertainTasks ?? []).filter((u) => {
		const normalized = u.path.replace(/\\/g, '/');
		if (ownPaths.has(normalized)) {
			return true;
		}
		note(
			`Dropped an uncertain-task flag on ${u.path} — not one of THIS run’s ` +
				'own candidate tasks (the loop never flags pre-existing landed tasks).',
		);
		return false;
	});
	const uncertain =
		named.length > 0
			? named
			: [...ownPaths].sort().map((path) => ({
					path,
					questions: blockingQuestions(verdict),
				}));
	note(
		`Tasker review loop did not converge within taskerLoopMax=${taskerLoopMax} across ` +
			`${executions} fresh context(s); emitting ${uncertain.length} uncertain ` +
			'task(s) with needsAnswers + questions.',
	);
	return {
		outcome: 'uncertain-tasks',
		tasks: readCandidates(options.cwd, before),
		uncertainTasks: uncertain,
		specQuestions: [],
		passes: totalPasses,
		executions,
		message:
			`Tasking '${options.slug}' did not converge after taskerLoopMax=${taskerLoopMax} ` +
			`review pass(es) across ${executions} fresh context(s); ` +
			`${uncertain.length} task(s) emitted needsAnswers: true with the open ` +
			'questions in their bodies (a human must answer before they are buildable).',
	};
}

/** The outcome of ONE fresh-context execution of the inner (N) loop. */
interface SingleExecutionResult {
	/** True iff a pass found no NEW blocking issue (the natural terminator). */
	converged: boolean;
	/** The last verdict seen (carries the routing channels on a non-converge). */
	lastVerdict: TaskReviewVerdict;
	/** How many review passes ran in this execution. */
	passes: number;
}

/** Run ONE fresh-context execution of the in-context (N) review→edit loop. */
async function runOneExecution(params: {
	slug: string;
	cwd: string;
	gate: TaskReviewGate;
	taskerLoopMax: number;
	execution: number;
	before: Map<string, string>;
	taskerLoopModel?: string;
	sessionsDir?: string;
	env?: NodeJS.ProcessEnv;
	note: (message: string) => void;
}): Promise<SingleExecutionResult> {
	const {slug, cwd, gate, taskerLoopMax, execution, before, note} = params;
	let lastVerdict: TaskReviewVerdict = {verdict: 'block', findings: []};
	let passes = 0;
	for (let pass = 1; pass <= taskerLoopMax; pass++) {
		// SCOPED: only THIS run's own new-or-changed tasks are reviewed — a task
		// the loop CREATED in an earlier pass is new-vs-`before` so it is in scope;
		// a pre-existing landed task is unchanged so it is NOT (the requeue fix).
		const candidateTasks = newOrChangedBacklog(cwd, before);
		const verdict = await gate({
			slug,
			cwd,
			candidateTasks,
			pass,
			execution,
			taskerLoopModel: params.taskerLoopModel,
			sessionsDir: params.sessionsDir,
			env: params.env,
		});
		passes = pass;
		lastVerdict = verdict;

		// APPLY the edits to the candidate task files (the improver step) — the
		// runner writes the agent's full-content edits; the agent does no disk/git.
		// SCOPED to this run's own output: an edit may improve a task THIS run
		// produced or CREATE a new candidate, but NEVER overwrite a pre-existing
		// landed task (the requeue fix).
		if (verdict.edits && verdict.edits.length > 0) {
			applyEdits(cwd, verdict.edits, before, note);
		}

		if (verdict.verdict === 'approve') {
			return {converged: true, lastVerdict: verdict, passes};
		}
		note(
			`Tasker review pass ${pass}/${taskerLoopMax} (context ${execution}) found ` +
				`${blockingCount(verdict)} blocking issue(s); ` +
				`${verdict.edits?.length ?? 0} edit(s) applied — re-reviewing.`,
		);
	}
	return {converged: false, lastVerdict, passes};
}

/**
 * Apply the review agent's full-content edits to the candidate task files. ONLY
 * paths under `work/tasks/backlog/` are written — the loop improves the CANDIDATE TASKS,
 * never escapes to other parts of the tree (a defensive scope fence; the runner,
 * not the agent, performs the write). An edit may CREATE a new candidate task file
 * (e.g. the review split one task into two) — that is in-scope.
 *
 * **SCOPED to this run's own output (the requeue fix).** Beyond the
 * `work/tasks/backlog/` prefix fence, an edit is only applied when its target is THIS
 * run's own task: either a path NOT present in the `before` snapshot (a task this
 * run created, or a new file the review is splitting out) OR one this run already
 * changed vs `before`. A pre-existing, unchanged landed task (present in `before`
 * with identical content) is REFUSED — the loop must never edit an unrelated,
 * already-landed task and sweep it into the runner-owned tasking commit.
 */
function applyEdits(
	cwd: string,
	edits: TaskEdit[],
	before: Map<string, string>,
	note: (message: string) => void,
): void {
	for (const edit of edits) {
		const normalized = edit.path.replace(/\\/g, '/');
		const filename = stripWorkFolderPrefix(normalized, 'tasks-backlog');
		if (filename === undefined || normalized.includes('..')) {
			note(
				`Skipped a review edit outside ${workFolderPrefix('tasks-backlog')} (${edit.path}) — the ` +
					'loop only improves candidate tasks.',
			);
			continue;
		}
		// Resolve the edit BODY: inline `content` (legacy / small edits) OR a `src`
		// scratch file the agent wrote (the decoupled form — see TaskEdit.src). The
		// `src` form keeps the verdict JSON bounded by the NUMBER of edits, not the
		// total body size, so a large decomposition can no longer cap-truncate the
		// verdict. A path-only edit with no resolvable body is a no-op marker.
		const body = resolveEditBody(cwd, edit, note);
		if (body === undefined) {
			continue;
		}
		// A pre-existing task this run did NOT touch must not be overwritten: it is
		// in `before` and the current on-disk content still equals the snapshot.
		if (before.has(filename)) {
			const abs = join(cwd, normalized);
			let current: string | undefined;
			try {
				current = readFileSync(abs, 'utf8');
			} catch {
				current = undefined;
			}
			if (current !== undefined && current === before.get(filename)) {
				note(
					`Skipped a review edit to the pre-existing landed task ${edit.path} ` +
						'— the loop only improves THIS run’s own candidate tasks.',
				);
				continue;
			}
		}
		const abs = join(cwd, normalized);
		writeFileSync(abs, body);
	}
}

/**
 * Resolve an edit's full-replacement BODY: inline `content` (legacy) takes
 * precedence, else read the `src` scratch file the agent wrote. Returns
 * `undefined` when there is no body to apply (neither channel present, or `src`
 * missing / outside the scratch fence / unreadable). The `src` is fenced to
 * {@link REVIEW_EDITS_SCRATCH_DIR} (no `..`) so the agent cannot pull an arbitrary
 * repo file in as the edit body. A read `src` is DELETED after reading so the
 * integrate's `git add -A` never sweeps the scratch into the commit.
 */
function resolveEditBody(
	cwd: string,
	edit: TaskEdit,
	note: (message: string) => void,
): string | undefined {
	if (edit.content !== undefined) {
		return edit.content;
	}
	if (edit.src === undefined) {
		return undefined;
	}
	const src = edit.src.replace(/\\/g, '/');
	if (src.includes('..') || !src.startsWith(REVIEW_EDITS_SCRATCH_DIR + '/')) {
		note(
			`Skipped a review edit whose src is outside ${REVIEW_EDITS_SCRATCH_DIR}/ (${edit.src}) — ` +
				'the scratch body must live under the review-edits scratch dir.',
		);
		return undefined;
	}
	const srcAbs = join(cwd, src);
	let body: string | undefined;
	try {
		body = readFileSync(srcAbs, 'utf8');
	} catch {
		note(
			`Skipped a review edit whose src scratch file is missing/unreadable (${edit.src}) — ` +
				'the agent did not write it before emitting the verdict.',
		);
		return undefined;
	}
	// Reap the scratch file now the body is in hand — never let it survive to the
	// integrate's `git add -A` (best-effort; a missing file is already gone).
	try {
		rmSync(srcAbs, {force: true});
	} catch {
		// Best-effort: a failure to delete does not block the apply.
	}
	return body;
}

/**
 * Best-effort reap of the {@link REVIEW_EDITS_SCRATCH_DIR} (a crashed prior run may
 * have left scratch bodies behind; the integrate's `git add -A` would otherwise
 * sweep them into the next tasking commit). Called at the START of a loop run.
 * Never throws — a missing/unreadable dir is the normal steady state.
 */
function cleanReviewEditsScratch(cwd: string): void {
	try {
		rmSync(join(cwd, REVIEW_EDITS_SCRATCH_DIR), {recursive: true, force: true});
	} catch {
		// Best-effort.
	}
}

/**
 * Repo-relative paths of the `work/tasks/backlog/*.md` files that are NEW or CHANGED vs
 * the `before` snapshot — exactly THIS tasking run's own output (the requeue-fix
 * scoping fence). A pre-existing task present in `before` with identical content
 * is excluded; a file the loop created (absent from `before`) or improved (content
 * differs) is included. Mirrors `tasking.ts`'s `newOrChangedBacklog`.
 */
function newOrChangedBacklog(
	cwd: string,
	before: Map<string, string>,
): string[] {
	const dir = workFolderPath(cwd, 'tasks-backlog');
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const name of entries) {
		if (!isWorkItemFile(name)) {
			continue;
		}
		const content = readFileSync(join(dir, name), 'utf8');
		if (before.get(name) !== content) {
			out.push(workItemRel('tasks-backlog', name));
		}
	}
	return out.sort();
}

/**
 * THIS run's candidate tasks keyed by repo-relative path → current content —
 * scoped to the new-or-changed set (never the pre-existing landed tasks).
 */
function readCandidates(
	cwd: string,
	before: Map<string, string>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rel of newOrChangedBacklog(cwd, before)) {
		out[rel] = readFileSync(join(cwd, rel), 'utf8');
	}
	return out;
}

/** Count blocking findings in a verdict. */
function blockingCount(verdict: TaskReviewVerdict): number {
	return verdict.findings.filter((f) => f.severity === 'blocking').length;
}

/** The blocking findings' questions (the floor questions for an unnamed rejection). */
function blockingQuestions(verdict: TaskReviewVerdict): string[] {
	const blocking = verdict.findings.filter((f) => f.severity === 'blocking');
	const source = blocking.length > 0 ? blocking : verdict.findings;
	return source.map((f) =>
		f.context ? `${f.question} (${f.context})` : f.question,
	);
}

// --- The production harness-backed gate ------------------------------------

/** What a harness-backed task-review gate needs to launch the review agent. */
export interface HarnessTaskReviewGateOptions {
	/** The harness seam used to launch the fresh-context review+edit agent. */
	harness?: Harness;
	/** The agent command the null/shell adapter shells out to (`{model}`-aware). */
	agentCmd?: string;
	/**
	 * Read the review agent's textual output for parsing. Production reads
	 * `launched.output` (the harness seam's ANSWER channel, task
	 * `harness-agent-output`); tests inject `readOutput` to stub a canned verdict
	 * string. Defaults to the launch's `output` verbatim.
	 */
	readOutput?: (output: string | undefined) => string;
}

/**
 * Backwards-compatible alias for {@link ReviewParseError} — unified across all
 * review callers. New code should reach for `ReviewParseError` directly.
 */
export const TaskReviewParseError = ReviewParseError;
export type TaskReviewParseError = ReviewParseError;

/**
 * The PRODUCTION tasker-review gate: launch the `review` SKILL as a fresh-context
 * agent through the EXISTING harness seam (a fresh context per pass = a fresh
 * launch, like the Gate-2 reviewer), routing the `reviewModel` override via
 * `LaunchInput.model` (the §13 model-routing intent — NOT a new mechanism), then
 * parse the emitted `{verdict, findings, edits, …}`.
 *
 * The agent makes the review/edit JUDGEMENTS (it runs the skill's lenses + the
 * destination check and proposes edits); this gate only launches it and parses its
 * verdict. The runner (the loop) applies the edits to disk and routes the verdict —
 * the agent does no git / no escaping disk writes.
 */
export function harnessTaskReviewGate(
	options: HarnessTaskReviewGateOptions = {},
): TaskReviewGate {
	const harness = options.harness ?? new NullHarness();
	const readOutput = options.readOutput ?? ((output) => output ?? '');
	return async (input: TaskReviewGateInput): Promise<ReviewVerdict> => {
		const launched = await launchWithOptionalWatch({
			harness,
			dir: input.cwd,
			slug: input.slug,
			command: options.agentCmd ?? '',
			prompt: buildTaskReviewPrompt(input),
			model: input.taskerLoopModel,
			// A DISTINCT session id per pass + fresh context so launches never collide.
			sessionId: `task-review-${input.slug}-m${input.execution}-n${input.pass}`,
			sessionsDir: input.sessionsDir,
			env: input.env,
		});
		if (!launched.ok) {
			throw new ReviewParseError(
				`task review agent launch failed${
					launched.detail ? `: ${launched.detail}` : ''
				}`,
			);
		}
		// CAP-TRUNCATION NAMING (observation
		// `tasker-review-edits-payload-caps-the-verdict-response`): attempt the parse
		// FIRST so a verdict that DID complete (even on a capped turn — e.g. the cap
		// hit trailing prose after the JSON closed) is HONORED, not discarded. Only
		// when the parse FAILS AND the adapter surfaced an output-cap signal do we
		// re-throw the NAMED {@link ReviewOutputCappedError} (a subclass of
		// ReviewParseError, so the bounce routing still catches it — NEVER a silent
		// approve). A parse failure with no cap signal stays the generic
		// ReviewParseError (the adapter could not see the signal — still
		// needs-attention, still never a silent approve).
		try {
			return parseReviewVerdict(readOutput(launched.output));
		} catch (err) {
			if (
				launched.outputCapped !== undefined &&
				(err instanceof ReviewParseError ||
					err instanceof ReviewOutputCappedError)
			) {
				throw new ReviewOutputCappedError(launched.outputCapped);
			}
			throw err;
		}
	};
}

/**
 * Render the task-review-loop PROMPT: instruct a fresh-context agent to run the
 * `review` SKILL on the candidate tasks for `slug` (the lenses IN ORDER, ENDING in
 * the destination/goal check — which may itself trigger edits), and to EMIT a
 * single JSON object carrying the verdict, the findings, the EDITS to apply, and
 * the routing channels (so {@link parseTaskReviewVerdict} can read it). The skill
 * carries the protocol; this prompt frames the artifact (a candidate decomposition)
 * + the required output shape (incl. the improver `edits` and the two non-converge
 * routing channels).
 */
export function buildTaskReviewPrompt(input: TaskReviewGateInput): string {
	const list = input.candidateTasks.map((p) => `  - ${p}`).join('\n');
	return [
		`You are a FRESH-CONTEXT reviewer in the TASKER review→edit→converge LOOP`,
		`(insertion point A). Review the CANDIDATE TASKS just produced for the spec`,
		`"${input.slug}":`,
		list || '  (no candidate tasks found)',
		``,
		reviewDisciplinePrompt(),
		``,
		`Read the source spec (${workItemRel('specs-ready', `${input.slug}.md`)}) and review the candidate`,
		`decomposition ADVERSARIALLY. Review the WHOLE SET — graph coherence / gaps /`,
		`overlap / goal-composition (dependency-graph coherence, set-level gaps,`,
		`overlapping/duplicated tasks, and "does the set compose into the spec goal")`,
		`— not just per-task well-formedness. The DESTINATION CHECK ("if every task`,
		`is built exactly as written, do we end up with the system the spec describes?")`,
		`is PART OF this pass and may ITSELF trigger edits — that is why this is a`,
		`loop, not a one-shot gate.`,
		``,
		`This is review pass ${input.pass} (fresh context ${input.execution}). You`,
		`do NOT run git. For the EDITS, WRITE each full-replacement task body to a`,
		`SCRATCH file under ${REVIEW_EDITS_SCRATCH_DIR}/ and reference it by path in the`,
		`"edits" channel — do NOT inline the body in the JSON, and do NOT edit the`,
		`candidate task files directly (the runner applies your scratch body to the`,
		`candidate task through its scope fence + deletes the scratch; on a review`,
		`failure the tasker's original candidates stay pristine for recovery). This`,
		`keeps the verdict JSON bounded by the NUMBER of edits, not the total body size,`,
		`so a large decomposition cannot cap-truncate the verdict. Tasks`,
		`measurably keep improving when reviewed, so propose edits that fix the`,
		`findings; converge when a pass finds NO NEW blocking issue.`,
		``,
		verdictContractPrompt(),
		``,
		`Fill the channels appropriate to THIS caller (the tasker improver loop):`,
		`  - "edits" — for each candidate task file you want to rewrite, WRITE the full`,
		`    replacement body to ${REVIEW_EDITS_SCRATCH_DIR}/<name>.md (the runner reads`,
		`    it, applies it to work/tasks/backlog/<name>.md, then deletes the scratch),`,
		`    and emit {"path": "work/tasks/backlog/<name>.md", "src": "${REVIEW_EDITS_SCRATCH_DIR}/<name>.md"}.`,
		`    Do NOT put the body in "content" — that shares the capped response with`,
		`    the verdict and cap-truncates it on a large set.`,
		`  - "uncertainTasks" — specific tasks you cannot make buildable (each gets`,
		`    \`needsAnswers: true\` with the questions in its body).`,
		`  - "decompositionUnclear" — the WHOLE decomposition is unsound (the spec is`,
		`    routed to needs-attention; emit no guessed tasks).`,
		`Do NOT fill "review" / "edit" / "questions" — those are other callers'`,
		`channels. Flag, do not guess: a flagged question costs one human glance; a`,
		`guessed task ships wrong-but-compiling work.`,
		``,
		`TASK \`humanOnly\` IS NARROW. Only edit a task to add \`humanOnly: true\``,
		`when building THAT task is genuinely never-for-agents BY NATURE (secrets/`,
		`release/security/AGENTS.md prohibition) — a \`humanOnly\` task is not agent-`,
		`claimable EVEN from the pool \`work/tasks/ready/\`. Do NOT stamp \`humanOnly\` to`,
		`mean "a human should review this first": that is the POSITION's job — every`,
		`candidate task is BIRTHED STAGED in \`work/tasks/backlog/\` (not eligible) and a`,
		`human promotes the approved ones into the pool.`,
		`Review-first is the staging position; the overloaded "stamp \`humanOnly\` for`,
		`review" reading is retired.`,
	].join('\n');
}

// Parsing of the tasker-loop verdict is now the SHARED `parseReviewVerdict`
// from `review-verdict.ts` (re-exported above as `parseTaskReviewVerdict` for
// backwards compatibility). The unified parser validates the SAME shape this
// loop's prompt asks for; routing reads `findings` / `edits` /
// `uncertainTasks` / `decompositionUnclear` off the unified `ReviewVerdict`,
// identical to the old typed-narrow validator.
