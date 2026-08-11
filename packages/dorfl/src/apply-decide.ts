import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {NullHarness, type Harness} from './harness.js';
import {launchWithOptionalWatch} from './agent-launch.js';
import {parseSidecar, sidecarPathFor, type SidecarModel} from './sidecar.js';
import {
	type DecisionDecider,
	type DecisionOutcome,
	type DecisionVerdict,
	parseDecisionVerdict,
} from './decision-engine.js';

/**
 * The **AGENTIC apply DECIDER** (spec
 * `agentic-question-resolution-retire-disposition-vocabulary` US #1/#2/#3, task
 * `agentic-apply-retire-disposition-vocabulary`) — the input-ADAPTER + prompt +
 * production decider for the apply rung's call into the SHARED
 * `decide(input, allowedOutcomes)` engine (`decision-engine.ts`). It is the apply
 * rung's analogue of intake's decision seam and `surface-gate.ts` / `triage-gate.ts`:
 * the agent JUDGES (reads the human's answer(s) + the SOURCE item and returns a
 * verdict); the engine VALIDATES it against the allowed set; the apply rung ACTS.
 *
 * This is the SUBSUME of the old disposition vocabulary: there is no longer a
 * `disposition=` token the surface rung stamps and the apply rung executes. When a
 * fully-answered OBSERVATION reaches the apply rung, this decider reads the answer
 * + the source's FULL context (body, type, surrounding signal — decision 3, the
 * analogue of intake reading the whole issue thread) and returns ONE of the LAUNCH
 * outcomes the apply rung allows. The artifact-type SELECTION (task vs spec) comes
 * from the agent's VERDICT, NOT a human `promote-*` field.
 *
 * **The allowed set** (the SUBSET the apply rung passes to `decide`):
 * `{task | spec | adr | dispose | resolve | ask}` \u2014 i.e. `{mint-task | mint-spec |
 * mint-adr | dispose-source | resolve-no-mint | ask-follow-up}`. The `dispose`
 * verdict replaced the older `delete` token (task
 * `apply-disposition-delete-to-dispose-regime-polymorphic`, spec
 * `surface-stuck-as-questions-and-retire-stuck-lock-state` decision #5): the
 * disposal is now REGIME-POLYMORPHIC (observation \u2192 `git rm`, task \u2192
 * `git mv` to `tasks/cancelled/`, spec \u2192 `git mv` to `specs/dropped/`), so a
 * task can no longer be hard-deleted by the apply rung. `resolve` was added
 * by the task `apply-decide-resolve-verdict-mint-nothing` so the decider can
 * honestly handle "the human answered, keep the note on record, mint nothing"
 * (previously it had no valid verdict for that case and looped on `ask`,
 * re-surfacing an already-answered question every tick). Its MEANING was SHARPENED
 * by ADR `resolve-settles-the-question-loop-not-the-note`: `resolve` settles the
 * QUESTION-LOOP on a note that REMAINS a live signal (and the persist stamps
 * `triaged:` so the triage rung stops re-asking it, closing a second re-ask loop
 * the first fix left open); a note whose SIGNAL is finished is `dispose`, not
 * `resolve` — a dead note kept and stamped "resolved" is exactly the
 * backward-artifact-in-a-forward-bucket the work contract forbids. `adr` was DEFERRED at the
 * keystone launch (no
 * ADR-mint path existed yet) and is now WIRED by the follow-on task
 * `agentic-apply-mint-adr-route`, which added the {@link
 * import('./mint-adr.js').mintAdr} route and widened this set. Intake's set is
 * UNCHANGED (`{task | spec | ask | bounce}`) \u2014 the engine stays outcome-AGNOSTIC
 * (SPEC decision 14), so widening this caller's subset does NOT touch intake or the
 * engine's superset union.
 *
 * The INPUT adapter ({@link buildApplyDecisionInput}) sits HERE in the caller, not
 * in the engine (the engine threads `input` opaquely) \u2014 decision 3: the input
 * adapter is per-front-door and NOT forced to be shared with intake's issue-thread
 * adapter.
 */

/**
 * The allowed-outcome set the apply rung permits. `adr` is now INCLUDED (task
 * `agentic-apply-mint-adr-route` widened the keystone's launch subset, which had
 * deferred it). The engine's superset still carries `adr` either way (it is
 * outcome-agnostic); this is purely the CALLER's permitted subset.
 */
export const APPLY_ALLOWED_OUTCOMES: readonly DecisionOutcome[] = [
	'task',
	'spec',
	'adr',
	'dispose',
	'resolve',
	'ask',
];

/**
 * The input the apply decider reads: the answered source item + its answered
 * sidecar. The decision is grounded in the source's FULL context (body, type,
 * surrounding signal), not just the latest answer text (decision 3).
 */
export interface ApplyDecisionInput {
	/** The namespaced source identity (`observation:<slug>` at launch). */
	item: string;
	/** The source item's type. */
	type: SidecarModel['type'];
	/** The source item's body (full context for the decision). */
	itemBody: string;
	/** The answered sidecar model (the human's recorded answers + the questions). */
	sidecar: SidecarModel;
	/** The working clone/checkout the decision runs in. */
	cwd: string;
	/** The model the apply-decision agent runs on (`undefined` \u21d2 the harness default). */
	model?: string;
	/** Environment for the decision-agent launch. */
	env?: NodeJS.ProcessEnv;
	/** The HOST-ONLY sessions root the decision session FILE is generated under. */
	sessionsDir?: string;
}

/**
 * The apply-decider SEAM: read the apply input and return a {@link DecisionVerdict}.
 * Injected by tests (a CANNED verdict, no real model); production uses
 * {@link harnessApplyDecider}. It is the apply rung's {@link DecisionDecider}
 * specialised to {@link ApplyDecisionInput}.
 */
export type ApplyDecider = DecisionDecider<ApplyDecisionInput>;

/**
 * Build the apply-decision INPUT for an answered source item: read its body (from
 * the working tree) + parse its answered sidecar. The adapter boundary the engine
 * never sees (it threads this opaquely to the decider). Returns `undefined` when
 * there is no sidecar or no item file (the apply rung handles those upstream).
 */
export function buildApplyDecisionInput(opts: {
	item: string;
	type: SidecarModel['type'];
	itemPath: string;
	cwd: string;
	model?: string;
	env?: NodeJS.ProcessEnv;
	sessionsDir?: string;
}): ApplyDecisionInput | undefined {
	const sidecarAbs = join(opts.cwd, sidecarPathFor(opts.item));
	if (!existsSync(sidecarAbs)) {
		return undefined;
	}
	const itemAbs = join(opts.cwd, opts.itemPath);
	if (!existsSync(itemAbs)) {
		return undefined;
	}
	let sidecar: SidecarModel;
	try {
		sidecar = parseSidecar(readFileSync(sidecarAbs, 'utf8'));
	} catch {
		return undefined;
	}
	return {
		item: opts.item,
		type: opts.type,
		itemBody: readFileSync(itemAbs, 'utf8'),
		sidecar,
		cwd: opts.cwd,
		model: opts.model,
		env: opts.env,
		sessionsDir: opts.sessionsDir,
	};
}

/**
 * Render the apply-decision agent PROMPT: instruct a fresh-context agent to read
 * the human's recorded ANSWER(S) + the SOURCE item and emit a single
 * `{outcome, \u2026}` verdict ({@link parseDecisionVerdict} reads it). The agent decides
 * what to DO with the answered signal \u2014 mint a self-contained task, mint a SPEC,
 * mint an ADR, DISPOSE the source (regime-polymorphic: an observation is
 * git-rm-ed, a task is `git mv`-ed to `tasks/cancelled/`, a spec to
 * `specs/dropped/`), resolve it (settle the loop, mint nothing, KEEP the note),
 * or ask one BATCH of follow-up questions \u2014
 * grounded in the source's full context. It writes NOTHING (the engine acts on
 * the verdict).
 *
 * Mirrors {@link import('./surface-gate.js').buildSurfacePrompt} /
 * {@link import('./intake.js').buildIntakeDecisionSpec}: a fresh-context agent that
 * EDITS nothing and EMITS one structured object the ENGINE routes/persists.
 */
export function buildApplyDecisionPrompt(input: ApplyDecisionInput): string {
	const answers = input.sidecar.entries
		.map((e) => `- ${e.question.trim()}\n  ANSWER: ${e.answer.trim()}`)
		.join('\n');
	return [
		`You are a FRESH-CONTEXT decision agent for the answered work/ item`,
		`"${input.item}" (type: ${input.type}). The human has answered every open`,
		`question; decide what to DO with this signal, grounded in the source's FULL`,
		`context (its body + type + the answers), NOT just the latest answer text.`,
		`You write NOTHING \u2014 no file edit, no git, no commit (the advance ENGINE acts`,
		`on what you emit). You JUDGE; the engine ACTS.`,
		``,
		`The source item body:`,
		`---`,
		input.itemBody.trim(),
		`---`,
		``,
		`The human's answers:`,
		answers,
		``,
		`Choose ONE outcome and emit a single JSON object (no prose OUTSIDE it):`,
		`  - "task": mint a SELF-CONTAINED task from this signal. Carry the answer(s)`,
		`    + any remaining open-question scoping into the drafted body so the task is`,
		`    buildable on its own. The taskBody MUST include a "## What to build" section`,
		`    AND a "## Prompt" section (a blockquoted, self-contained instruction a fresh`,
		`    agent can start from) — a task with no "## Prompt" is NOT dispatchable and the`,
		`    build refuses it. Emit {"outcome":"task","taskSlug":"\u2026",`,
		`    "taskTitle":"\u2026","taskBody":"\u2026 (markdown AFTER the frontmatter)"}.`,
		`  - "spec": mint a SPEC from this signal (a larger, coherent piece of work).`,
		`    Emit {"outcome":"spec","specSlug":"\u2026","specTitle":"\u2026","specBody":"\u2026"}.`,
		`  - "adr": the answer SETTLES an architectural decision worth recording. Mint`,
		`    a self-contained ADR (docs/adr/, the context/decision/why shape) carrying`,
		`    the WHY from the answer(s). Emit {"outcome":"adr","adrSlug":"\u2026",`,
		`    "adrTitle":"\u2026","adrBody":"\u2026 (markdown AFTER the frontmatter)"}.`,
		`  - "dispose": the answer means this signal should be DISPOSED. Emit`,
		`    {"outcome":"dispose","disposeReason":"\u2026"}. REGIME-POLYMORPHIC on the`,
		`    SOURCE type: an OBSERVATION is git-rm-ed in a single revertible commit`,
		`    (reason rides the message, git history is the archive); a TASK is git-mv-ed`,
		`    to \`tasks/cancelled/\` (RETAINED, reason recorded in the moved body's`,
		`    \`reason:\` frontmatter); a SPEC is git-mv-ed to \`specs/dropped/\` (RETAINED).`,
		`    A task can NEVER be hard-deleted by the apply rung \u2014 dispose is the`,
		`    only path off the board.`,
		`  - "resolve": the answer SETTLES the QUESTION-LOOP and there is NOTHING to`,
		`    mint (no task/spec/adr), AND the note is STILL A LIVE SIGNAL worth keeping`,
		`    in the inbox \u2014 e.g. a standing map of a known gap, or accepted residue the`,
		`    answer explicitly says to keep on record until it is acted on. The answers`,
		`    are harvested into the item body, the loop is cleared, and the note is`,
		`    RETAINED and STAMPED as triaged, so it is never re-asked this question.`,
		`    Emit {"outcome":"resolve","resolveReason":"\u2026"}.`,
		`    PICK BETWEEN "resolve" AND "dispose" ON LIVENESS, NOT ON POLITENESS: both`,
		`    close the loop and mint nothing, and the ONLY question is whether the note`,
		`    is still a live signal AFTER this answer. If the answer means the signal is`,
		`    FINISHED (the thing was fixed, it was already covered elsewhere, it is`,
		`    obsolete, or its whole content is now carried by a task/spec/ADR/commit),`,
		`    that note stops being live \u2014 emit "dispose", NOT "resolve". "resolve" is`,
		`    only correct when the note still carries a signal nothing else records.`,
		`    Do NOT use "resolve" as a soft "dispose": a note kept only to show it was`,
		`    handled is a backward artifact in a forward bucket.`,
		`  - "ask": you need more from the human before acting. Emit`,
		`    {"outcome":"ask","question":"\u2026"} \u2014 ask everything you still need as ONE`,
		`    batch (never a drip); the engine appends it and re-pauses.`,
		``,
		`Do NOT emit any other outcome. It is plain text inside the JSON string`,
		`(escape newlines as \\n).`,
	].join('\n');
}

/** What a harness-backed apply decider needs to launch the decision agent. */
export interface HarnessApplyDeciderOptions {
	/** The harness seam used to launch the fresh-context decision agent. */
	harness?: Harness;
	/** The agent command the null/shell adapter shells out to (`{model}`-aware). */
	agentCmd?: string;
	/**
	 * Read the decision agent's textual output for parsing. Production reads
	 * `launched.output` (the ANSWER channel); tests inject `readOutput` to stub a
	 * canned verdict string.
	 */
	readOutput?: (output: string | undefined) => string;
}

/**
 * The PRODUCTION apply decider: launch a fresh-context agent through the EXISTING
 * harness seam (routing an optional `model` via `LaunchInput.model` \u2014 the \u00a713
 * model-routing intent, NOT a new mechanism), then PARSE the emitted verdict via
 * the SHARED {@link parseDecisionVerdict}. The DIRECT mirror of
 * `harnessSurfaceGate` / `harnessTriageGate`: a SEPARATE harness launch (fresh
 * context) in the same checkout `cwd`, fed {@link buildApplyDecisionPrompt}; a
 * DISTINCT session id (`<item>-apply-decide`) so its session never collides with a
 * build / review / surface / triage session.
 */
export function harnessApplyDecider(
	options: HarnessApplyDeciderOptions = {},
): ApplyDecider {
	const harness = options.harness ?? new NullHarness();
	const readOutput = options.readOutput ?? ((output) => output ?? '');
	return async (input: ApplyDecisionInput): Promise<DecisionVerdict> => {
		const sessionId = `${input.item.replace(/:/g, '-')}-apply-decide`;
		const launched = await launchWithOptionalWatch({
			harness,
			dir: input.cwd,
			slug: input.item,
			command: options.agentCmd ?? '',
			prompt: buildApplyDecisionPrompt(input),
			model: input.model,
			sessionId,
			sessionsDir: input.sessionsDir,
			env: input.env,
		});
		if (!launched.ok) {
			throw new Error(
				`apply-decision agent launch failed${launched.detail ? `: ${launched.detail}` : ''}`,
			);
		}
		return parseDecisionVerdict(readOutput(launched.output));
	};
}
