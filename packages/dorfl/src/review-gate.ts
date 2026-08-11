import {NullHarness, substituteModel, type Harness} from './harness.js';
import {launchWithOptionalWatch} from './agent-launch.js';
import {boundaryLine} from './watch-session.js';
import {workItemRel} from './work-layout.js';
import {
	parseReviewVerdict,
	ReviewParseError,
	reviewDisciplinePrompt,
	verdictContractPrompt,
	type ReviewFinding,
	type ReviewVerdict,
} from './review-verdict.js';

export {
	parseReviewVerdict,
	ReviewParseError,
	type ReviewFinding,
	type ReviewVerdict,
} from './review-verdict.js';

/**
 * **Gate 2 — the PR/code review gate** (GATES spec `work/specs/tasked/review.md`), the
 * JUDGEMENT layer that rides ON TOP of the deterministic `verify` floor (ADR §8).
 *
 * After the green `verify` and BEFORE the done-move, `complete`/`do` invoke the
 * `review` SKILL (`skills/review/SKILL.md`) as a **fresh-context** agent — its
 * OWN harness launch, never the builder's session — to read the diff against the
 * task it claims and EMIT a verdict. The verdict is then ROUTED by the caller
 * (`complete.ts`): `approve` → done-move/commit/integrate; `block` → the SAME
 * `needs-attention` machinery the red gate uses (never a merge).
 *
 * This module is the SEAM (the {@link ReviewGate} function type) + its
 * production harness-backed implementation ({@link harnessReviewGate}). The seam
 * is injectable exactly like `do`'s `dorfl`: tests stub a canned
 * `approve`/`block` verdict (no real model); production launches the review agent
 * through the EXISTING harness seam ({@link Harness}/`LaunchInput`), routing the
 * `reviewModel` override through `LaunchInput.model` / {@link substituteModel} —
 * NOT a new model/launch mechanism (the §13 model-routing intent).
 *
 * Determinism boundary (ADR §8), explicit: review is a JUDGEMENT gate, never a
 * replacement for `verify`. `verify` stays the non-skippable model-free floor;
 * review runs ON TOP, only when `review` resolves on.
 */

/** What the review gate needs to launch a fresh-context review of one task. */
export interface ReviewGateInput {
	/** The slug under review (the task the diff claims to deliver). */
	slug: string;
	/** The working clone/checkout the gate runs in (the prepared work branch). */
	cwd: string;
	/**
	 * The model the REVIEW agent runs on (`reviewModel`, de-correlated from the
	 * builder). `undefined` ⇒ no forced model (the harness's own default). Flows
	 * to the launch through `LaunchInput.model` / {@link substituteModel}.
	 */
	reviewModel?: string;
	/** Which review ROUND this is (1-based), for the revise↔review loop bound. */
	round: number;
	/**
	 * `--watch`: tail the REVIEW agent's pi session `.jsonl` live, the SAME way the
	 * build agent's is tailed (task `watch-review-session`). Threaded in from the
	 * caller's `CompleteOptions`/`DoOptions` so the production gate
	 * ({@link harnessReviewGate}) can route its launch through the shared
	 * {@link launchWithOptionalWatch} helper. OFF (the default) ⇒ the gate does a
	 * plain sync `launch`, byte-identical to before. A pure observer — it never
	 * changes the verdict.
	 */
	watch?: boolean;
	/** Where the tailed review lines are written (defaults to stderr). */
	watchSink?: (line: string) => void;
	/** Emit ANSI colour in the tailed review lines (the caller's TTY decision). */
	color?: boolean;
	/**
	 * The HOST-ONLY sessions root the review session FILE is generated under
	 * (resolved `config.sessionsDir`). `undefined` ⇒ pi's per-cwd default. Same
	 * bridge the build launch uses; the review launch passes a DISTINCT session id
	 * (`<slug>-review`) under it so its session never collides with the build's.
	 */
	sessionsDir?: string;
	/** Environment for the review-agent launch. */
	env?: NodeJS.ProcessEnv;
}

/**
 * The review-gate SEAM: run a fresh-context review of the slug's diff and return
 * a parsed verdict. Injected by tests (a canned verdict, no real model);
 * production uses {@link harnessReviewGate}. Mirrors `do`'s `DoDorfl`
 * injectable-seam shape so the gate wiring is testable as pure logic.
 */
export type ReviewGate = (input: ReviewGateInput) => Promise<ReviewVerdict>;

/**
 * Render the review-agent PROMPT: instruct a fresh-context agent to apply the
 * **review discipline** (`work/protocol/REVIEW-PROTOCOL.md`) to the code
 * changes on this work branch against the task that specified them, and to
 * EMIT a single unified `ReviewVerdict` JSON object (so
 * {@link parseReviewVerdict} can read it). The discipline body (the lenses +
 * the destination check) lives in `REVIEW-PROTOCOL.md` — NOT inlined here —
 * and the JSON-emitted-shape contract comes from
 * {@link verdictContractPrompt}, the ONE shared helper called by all four
 * review-prompt builders (task `review-protocol-doc-and-shared-machinery`).
 *
 * This builder owns ONLY the PER-BUILDER framing: who you are (Gate 2 — PR/code
 * review), what you are reviewing (code-vs-its-task, the diff on this work
 * branch), and which optional verdict channels to fill (the `review` prose for
 * the in-core PR-comment poster; an in-scope DECISION ratification hunt; a
 * conceptual-coherence check). The shared discipline body and the verdict
 * contract are NOT duplicated here.
 */
export function buildReviewPrompt(slug: string): string {
	return [
		`You are a FRESH-CONTEXT reviewer (Gate 2 — PR/code review). Review the`,
		`code changes on this work branch AGAINST the task that specified them`,
		`(work/in-progress/${slug}.md or work/done/${slug}.md) and its source spec.`,
		``,
		reviewDisciplinePrompt(),
		``,
		`The acceptance gate (Gate 1 — build + tests + format) has ALREADY passed`,
		`and is GREEN before you run (review runs only on a green gate), so ASSUME`,
		`it is green and do NOT re-run build/tests/format — that is settled. You may`,
		`still READ and reason about the tests for coverage/judgement; just do not`,
		`re-execute the suite. Spend your budget on JUDGEMENT.`,
		`Do NOT edit any files, run no git — you EMIT a verdict only.`,
		``,
		`ALSO HUNT for IN-SCOPE DECISIONS THE TASK DID NOT SPECIFY — a non-obvious`,
		`design choice the agent made on its own while building: a CROSS-TASK`,
		`INTERACTION (a choice affecting another command/flag/task's behaviour), a new`,
		`ERROR/REFUSAL, or a user-visible DEFAULT. The agent SHOULD have recorded these`,
		`in a "## Decisions" block in its report, which the runner transcribes into the`,
		`done record (work/tasks/done/<slug>.md) and which also rides the PR description.`,
		`START from that block (ratify`,
		`each entry) AND hunt for any it MISSED. Flag EACH such decision as a finding`,
		`for the human to RATIFY: "non-blocking" by DEFAULT (the build proceeds; the`,
		`human ratifies or reverses), escalating to "blocking" ONLY if the decision looks`,
		`WRONG or is genuinely load-bearing-and-hard-to-reverse. An un-recorded in-scope`,
		`decision is NOT itself a block, it is a ratification finding. Do NOT raise a`,
		`finding about WHERE the rationale was written (the done record, the commit body`,
		`and the PR body are the RUNNER's to author, never the builder's): review the`,
		`DECISION, not the filing. If rationale is missing entirely, that is the`,
		`ratification finding above.`,
		``,
		`ALSO CHECK CONCEPTUAL COHERENCE — does this diff fit the system's existing`,
		`LANGUAGE? For each concept / flag / config key / status / verb it introduces or`,
		`touches: (a) is the term used CONSISTENTLY with how it is already defined`,
		`elsewhere (CONTEXT.md glossary + the ADRs + the code), not silently re-meaning`,
		`an existing word or meaning two things in two places? (b) is the concept at the`,
		`RIGHT LAYER (e.g. a policy gate on the autonomous-SELECTION step vs the explicit`,
		`VERB someone typed)? (c) does it DUPLICATE/overlap an existing concept it should`,
		`reuse or rename instead of forking? A mechanism that is correct in isolation but`,
		`INCOHERENT against the system's language is a defect — BLOCK if it re-means or`,
		`forks a load-bearing concept or sits at the wrong layer; otherwise flag it as a`,
		`coherence finding.`,
		``,
		verdictContractPrompt(),
		``,
		`Fill the "review" field: a human-readable REVIEW that gets posted as a`,
		`comment on the PR — write it FOR a human landing there, NOT as scratch`,
		`thinking. LEAD with the verdict ("Approved" or "Blocked") and then give the`,
		`lenses' reasoning and the destination check ("merged as written, do we reach`,
		`the task/spec goal?"). Write it deliberately; do NOT narrate your process`,
		`("Let me check…"). Keep it TIGHT: aim for a few short sentences and DO NOT`,
		`exceed ~1500 characters — a long, multi-paragraph field is exactly what`,
		`corrupts the JSON on large diffs; say less, not more. It is plain text inside`,
		`the JSON string (escape any newline as \\n; better, keep it to ONE line). Do`,
		`NOT fill "edits"/"edit"/`,
		`"questions"/"uncertainTasks"/"decompositionUnclear" — those channels are`,
		`for other review callers (the tasker loop / the lone-task review), not this`,
		`code-review gate.`,
	].join('\n');
}

/** What a harness-backed review gate needs to launch the review agent. */
export interface HarnessReviewGateOptions {
	/** The harness seam used to launch the fresh-context review agent. */
	harness?: Harness;
	/** The agent command the null/shell adapter shells out to (`{model}`-aware). */
	agentCmd?: string;
	/**
	 * Read the review agent's textual output for parsing. The harness now surfaces
	 * the agent's final assistant message in `LaunchResult.output` (task
	 * `harness-agent-output`, Option C) — the ANSWER channel, distinct from
	 * `detail` (the failure/`stderr` channel). Production reads `launched.output`;
	 * tests inject `readOutput` to stub a canned verdict string. The reader is
	 * passed the launch's `output` and returns the text to parse.
	 */
	readOutput?: (output: string | undefined) => string;
}

/**
 * The PRODUCTION review gate: launch the `review` SKILL as a fresh-context agent
 * through the EXISTING harness seam, routing the `reviewModel` override via
 * `LaunchInput.model` (the §13 model-routing intent — NOT a new mechanism), then
 * parse the emitted `{verdict, findings}`.
 *
 * It is a SEPARATE harness launch (fresh context = not the builder's session) in
 * the same checkout `cwd` (the prepared, gated work branch). The launch is fed
 * {@link buildReviewPrompt}; the model flows through `LaunchInput.model`, which
 * each adapter injects natively (pi: `--model`; null/shell: the `{model}`
 * placeholder via {@link substituteModel}). auth/keys stay the harness's job.
 */
export function harnessReviewGate(
	options: HarnessReviewGateOptions = {},
): ReviewGate {
	const harness = options.harness ?? new NullHarness();
	const readOutput = options.readOutput ?? ((output) => output ?? '');
	return async (input: ReviewGateInput): Promise<ReviewVerdict> => {
		// When watching, print the build→review BOUNDARY banner so the human knows
		// the build stream ended and the review stream is beginning (reuses the watch
		// formatting; task `watch-review-session`). A pure observability line.
		if (input.watch === true) {
			const sink =
				input.watchSink ??
				((line: string) => process.stderr.write(`${line}\n`));
			sink(
				boundaryLine(
					`review gate — reviewing ${input.slug}…`,
					input.color ?? false,
				),
			);
		}
		// The SAME shared launch helper the BUILD launch uses (task
		// `watch-review-session`) — NOT a copy of the watch block. When `watch` is on
		// (pi harness), it tails the review session `.jsonl` live; OFF, it does a
		// plain sync `launch`, byte-identical to before. The review uses a DISTINCT
		// session id (`<slug>-review`) so it never collides with the build session.
		const launched = await launchWithOptionalWatch({
			harness,
			dir: input.cwd,
			slug: input.slug,
			command: options.agentCmd ?? '',
			prompt: buildReviewPrompt(input.slug),
			// The reviewModel override rides the EXISTING model-routing seam.
			model: input.reviewModel,
			sessionId: `${input.slug}-review`,
			sessionsDir: input.sessionsDir,
			watch: input.watch,
			watchSink: input.watchSink,
			color: input.color,
			env: input.env,
		});
		if (!launched.ok) {
			throw new ReviewParseError(
				`review agent launch failed${launched.detail ? `: ${launched.detail}` : ''}`,
			);
		}
		// Read the verdict from the agent's ANSWER channel (`output`), NOT `detail`
		// (which is empty on success). An empty/absent output → parseReviewVerdict
		// throws ReviewParseError → needs-attention (never a silent approve).
		return parseReviewVerdict(readOutput(launched.output));
	};
}

/**
 * Render the TASK-SET acceptance-gate PROMPT — the task-path mirror of
 * {@link buildReviewPrompt} (task `slice-acceptance-gate`). Instead of
 * reviewing a code diff against ONE task, this instructs a FRESH-CONTEXT
 * agent to review the WHOLE candidate SET of tasks produced for spec `slug`,
 * using the **review discipline**'s SET-OF-TASKS lens (coherence / dependency
 * graph / gaps + overlap / "if every task is built exactly as written, do we
 * reach the system the spec describes, and is each task
 * correct-if-implemented?"). It emits the SAME unified `ReviewVerdict` shape
 * so {@link parseReviewVerdict} reads it identically.
 *
 * This is a TERMINAL, ONE-SHOT accept/reject gate (it runs BEFORE the task
 * set integrates) — NOT the tasker IMPROVER loop (`tasker-review-loop.ts`),
 * which EDITS tasks between passes. This prompt explicitly forbids editing.
 *
 * Per-builder framing only — the discipline body lives in
 * `work/protocol/REVIEW-PROTOCOL.md`; the JSON shape comes from
 * {@link verdictContractPrompt}.
 */
export function buildTaskAcceptancePrompt(slug: string): string {
	return [
		`You are a FRESH-CONTEXT reviewer (the task-SET ACCEPTANCE GATE). Review`,
		`the candidate tasks this tasking run produced for the spec "${slug}" — the`,
		`new/changed candidate task files on this work branch — AGAINST their source`,
		`spec (${workItemRel('specs-ready', `${slug}.md`)} — the held spec stays in specs/ready/ while it is being`,
		`tasked).`,
		``,
		reviewDisciplinePrompt(),
		``,
		`Review the WHOLE SET as a SET, not each task in isolation. The set-level`,
		`framings the review discipline names:`,
		`  - COHERENCE — do the tasks speak the spec's (and the system's) language`,
		`    consistently; no task re-means or forks a concept another task/the spec`,
		`    already owns?`,
		`  - DEPENDENCY GRAPH — is the \`blockedBy\`/ordering graph sound (acyclic, the`,
		`    keystone first, each task's stated blockers really land its premise)?`,
		`  - GAPS + OVERLAP — does the set COVER the spec with no missing piece, and`,
		`    without two tasks doing the same work or fighting over the same seam?`,
		`  - CORRECT-IF-IMPLEMENTED — if EVERY task is built EXACTLY as written, do we`,
		`    reach the system the spec describes, and is each task individually`,
		`    correct-if-implemented (no task that compiles but builds the wrong thing)?`,
		``,
		`This is a TERMINAL one-shot accept/reject gate: do NOT edit any task, do NOT`,
		`run git — you EMIT a verdict only (the tasker improver loop, a SEPARATE`,
		`concept, is what edits tasks; this gate does not).`,
		``,
		verdictContractPrompt(),
		``,
		`Fill the "review" field: a human-readable REVIEW of the SET — write it FOR a`,
		`human deciding whether to land these tasks. LEAD with the verdict`,
		`("Approved" or "Blocked") and then give the lenses' reasoning and the`,
		`destination check. Do NOT fill the improver-loop channels ("edits",`,
		`"uncertainTasks", "decompositionUnclear") — this is a terminal gate, not the`,
		`loop.`,
	].join('\n');
}

/**
 * The PRODUCTION task-SET acceptance gate (task `slice-acceptance-gate`): the
 * task-path mirror of {@link harnessReviewGate}. It launches the `review` SKILL
 * as a fresh-context agent through the SAME harness seam, routing the
 * `reviewModel` override via `LaunchInput.model`, then parses the emitted
 * `{verdict, findings}` — IDENTICAL machinery to the build gate, differing ONLY
 * in the PROMPT ({@link buildTaskAcceptancePrompt}, a task-SET review) and in
 * being driven ONE-SHOT by the caller (the tasking path passes
 * `reviewMaxRounds: 1`).
 *
 * Reuses the `ReviewGate` seam type verbatim so `performIntegration`'s review
 * block runs it with no shape change. The review uses a DISTINCT session id
 * (`<slug>-task-acceptance`) so it never collides with the build review session
 * OR the tasker improver loop's review session. NAME: `harnessTaskAcceptanceGate`
 * (the ACCEPTANCE gate), DISTINCT from `tasker-review-loop.ts`'s
 * `harnessTaskReviewGate` (the IMPROVER loop seam, which EDITS tasks) — the two
 * are non-overlapping concepts (gate = terminal pass/fail; loop = review→edit).
 */
export function harnessTaskAcceptanceGate(
	options: HarnessReviewGateOptions = {},
): ReviewGate {
	const harness = options.harness ?? new NullHarness();
	const readOutput = options.readOutput ?? ((output) => output ?? '');
	return async (input: ReviewGateInput): Promise<ReviewVerdict> => {
		if (input.watch === true) {
			const sink =
				input.watchSink ??
				((line: string) => process.stderr.write(`${line}\n`));
			sink(
				boundaryLine(
					`task acceptance gate — reviewing ${input.slug}…`,
					input.color ?? false,
				),
			);
		}
		const launched = await launchWithOptionalWatch({
			harness,
			dir: input.cwd,
			slug: input.slug,
			command: options.agentCmd ?? '',
			prompt: buildTaskAcceptancePrompt(input.slug),
			model: input.reviewModel,
			sessionId: `${input.slug}-task-acceptance`,
			sessionsDir: input.sessionsDir,
			watch: input.watch,
			watchSink: input.watchSink,
			color: input.color,
			env: input.env,
		});
		if (!launched.ok) {
			throw new ReviewParseError(
				`task acceptance gate launch failed${launched.detail ? `: ${launched.detail}` : ''}`,
			);
		}
		return parseReviewVerdict(readOutput(launched.output));
	};
}

/**
 * Format a review's BLOCKING findings into a needs-attention reason string —
 * recorded in the item body when the gate routes a `block` (the SAME body-prose
 * mechanism the red gate's reason uses; WORK-CONTRACT rule 3). Non-blocking
 * findings are omitted from the reason (they do not block). On exhaustion of
 * `reviewMaxRounds`, {@link reviewRoundsExhaustedReason} is used instead.
 */
export function formatBlockReason(verdict: ReviewVerdict): string {
	const blocking = verdict.findings.filter((f) => f.severity === 'blocking');
	const lines = (blocking.length > 0 ? blocking : verdict.findings).map((f) => {
		const ctx = f.context ? ` (${f.context})` : '';
		return `- ${f.question}${ctx}`;
	});
	const head = 'PR/code review (Gate 2) blocked this work:';
	return lines.length > 0 ? `${head}\n${lines.join('\n')}` : head;
}

/**
 * The needs-attention reason when Gate 2 does not reach a UNANIMOUS approve —
 * either a round returned a (terminal) block, or not all `reviewMaxRounds` rounds
 * corroborated the approve.
 */
export function reviewRoundsExhaustedReason(maxRounds: number): string {
	return (
		`PR/code review (Gate 2) did not reach a unanimous approve across ` +
		`reviewMaxRounds=${maxRounds} round(s) (a block is terminal and is never ` +
		`re-rolled); forcing needs-attention (never silently merged or looped).`
	);
}
