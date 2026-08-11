import {NullHarness, type Harness} from './harness.js';
import {launchWithOptionalWatch} from './agent-launch.js';
import {extractJsonObjectSpan} from './verdict-json.js';

/**
 * The **TRIAGE auto-disposition GATE** (spec `advance-loop`, task
 * `advance-rung-triage`, US #17) — the CONSERVATIVE, `observationTriage: 'auto'`-
 * gated exception to the question-gated default. On `classify=triage-observation`
 * AND `observationTriage` resolved to `'auto'`, the engine asks this gate whether
 * the observation is a NO-QUESTION case (one
 * a human would not plausibly disagree with): an EXACT DUPLICATE of an existing
 * item (→ suggest delete) or an UNAMBIGUOUS MAP onto an existing item. If so, the
 * engine auto-dispositions it WITHOUT surfacing a question; otherwise it falls back
 * to the always-allowed question-gated path (surface a promote/keep/delete
 * question and WAIT).
 *
 * The HIGH BAR is the whole point: the gate emits `auto: false` for ANYTHING that
 * is a judgement call. It NEVER auto-promotes (promotion is "is this worth
 * building?", always a human call) and NEVER auto-deletes a NON-duplicate signal
 * (the capture-bucket contract: an observation is left by deletion BY A HUMAN). So
 * the ONLY auto-dispositions this gate may return are:
 *
 *   - `duplicate` — an EXACT duplicate of an existing item → DISCHARGE the
 *     redundant note BY DELETION (it is a redundant copy of an already-captured
 *     signal, so nothing is lost); or
 *   - `map` — an UNAMBIGUOUS map onto an existing item → DISCHARGE the redundant
 *     note BY DELETION too (it is already covered by the item it maps onto, so it
 *     carries no unique signal; the mapping is recorded in the commit message).
 *     An AUTO disposition never RESTS a note (task
 *     `agentic-apply-retire-disposition-vocabulary`); the one path that KEEPS a
 *     note is the human-answered `resolve` verdict on the apply rung (ADR
 *     `resolve-settles-the-question-loop-not-the-note`).
 *
 * It is the DIRECT mirror of `surface-gate.ts`'s spawn→emit→parse seam, with a
 * narrower emitted payload (`{auto, …}` rather than `{questions}`). Production
 * launches a fresh-context agent through the EXISTING harness seam; tests stub a
 * canned decision (no real model). The auto-disposition WRITE (record + resolve)
 * is the engine's job (`triage-persist.ts`); this module only JUDGES.
 */

/** The conservative auto-disposition kinds the gate may return (US #17). */
export type TriageAutoKind =
	/** An EXACT duplicate of an existing item → recommend deletion (human deletes). */
	| 'duplicate'
	/** An UNAMBIGUOUS map onto an existing item → discharge the redundant note by deletion. */
	| 'map';

/**
 * What the triage gate EMITS: either a no-question auto-disposition (`auto: true`)
 * or the honest "this needs a human's judgement" (`auto: false`), in which case the
 * engine falls back to the always-allowed question-gated surface path.
 */
export type TriageEmit =
	| {
			auto: true;
			/** Which conservative no-question case (`duplicate` / `map`). */
			kind: TriageAutoKind;
			/** The existing item this observation duplicates / maps onto (`<namespace>:<slug>`). */
			existing: string;
			/** A short reason recorded with the disposition (orientation for the human). */
			reason: string;
	  }
	| {auto: false; reason?: string};

/** What the triage gate needs to judge ONE observation. */
export interface TriageGateInput {
	/** The namespaced observation identity (`observation:<slug>`). */
	item: string;
	/** The working clone/checkout the gate runs in. */
	cwd: string;
	/** The model the triage agent runs on (`undefined` ⇒ the harness default). */
	triageModel?: string;
	/** Environment for the triage-agent launch. */
	env?: NodeJS.ProcessEnv;
	/** The HOST-ONLY sessions root the triage session FILE is generated under. */
	sessionsDir?: string;
}

/**
 * The triage-gate SEAM: judge whether an observation is a conservative no-question
 * case and return the auto-disposition (or `auto: false`). Injected by tests (a
 * canned decision, no real model); production uses {@link harnessTriageGate}.
 * Mirrors `surface-gate.ts`'s `SurfaceGate` seam shape so the engine wiring is
 * testable as pure logic.
 */
export type TriageGate = (input: TriageGateInput) => Promise<TriageEmit>;

/** Raised when the triage agent ran but produced no parseable emit. */
export class TriageParseError extends Error {}

const AUTO_KINDS: ReadonlySet<string> = new Set<TriageAutoKind>([
	'duplicate',
	'map',
]);

/**
 * Parse the triage agent's emitted decision out of its textual output. The agent
 * emits a single `{auto, …}` JSON object (it may wrap it in prose / a fenced
 * block), so we extract the first JSON object carrying an `auto` field and
 * validate its shape. An `auto: true` decision MUST carry a recognised `kind` AND
 * a non-empty `existing` — a malformed "auto" is treated as `auto: false` (the
 * SAFE fallback: surface the question rather than auto-disposition on a half-baked
 * emit, never the reverse). Throws when no `auto` field is present at all (the
 * caller treats an unparseable emit as the safe question-gated path).
 */
export function parseTriageEmit(output: string): TriageEmit {
	const span = extractJsonObjectSpan(output, 'auto');
	if (span === undefined) {
		throw new TriageParseError(
			'triage agent produced no parseable {auto} result',
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(output.slice(span.start, span.end));
	} catch (err) {
		throw new TriageParseError(
			`triage emit was not valid JSON: ${(err as Error).message}`,
		);
	}
	return validateEmit(parsed);
}

/** Validate + normalise a parsed object into a {@link TriageEmit}. */
function validateEmit(parsed: unknown): TriageEmit {
	if (typeof parsed !== 'object' || parsed === null) {
		throw new TriageParseError('triage emit was not an object');
	}
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.auto !== 'boolean') {
		throw new TriageParseError(
			'triage emit had no boolean `auto` field (true ⇒ a no-question case; false ⇒ surface)',
		);
	}
	const reason = typeof obj.reason === 'string' ? obj.reason : '';
	if (obj.auto !== true) {
		return reason !== '' ? {auto: false, reason} : {auto: false};
	}
	// auto:true MUST carry a recognised kind + a non-empty existing target, else
	// fall back to the SAFE question-gated path (a malformed auto never wins).
	const kind = typeof obj.kind === 'string' ? obj.kind : '';
	const existing = typeof obj.existing === 'string' ? obj.existing : '';
	if (!AUTO_KINDS.has(kind) || existing.trim() === '') {
		return {
			auto: false,
			reason:
				'triage agent emitted auto:true but without a recognised kind / existing target — ' +
				'surfacing the question instead (the high bar is unmet)',
		};
	}
	return {
		auto: true,
		kind: kind as TriageAutoKind,
		existing,
		reason,
	};
}

/**
 * Render the triage-agent PROMPT: instruct a fresh-context agent to judge whether
 * the observation `item` is a CONSERVATIVE no-question case and to EMIT a single
 * `{auto, …}` JSON object. The bar is HIGH and the prompt states it plainly: emit
 * `auto: true` ONLY for an EXACT duplicate or an UNAMBIGUOUS map onto an existing
 * item — NEVER for a promotion (always a human "worth building?" call) and NEVER
 * to delete a non-duplicate signal. Anything that is a judgement call ⇒ `auto:
 * false` (the engine surfaces the question). Mirrors {@link buildSurfacePrompt}: a
 * fresh-context agent that EDITS nothing and EMITS one structured object.
 */
export function buildTriagePrompt(item: string): string {
	return [
		`You are a FRESH-CONTEXT observation TRIAGER. Judge the work/ observation`,
		`"${item}" against the CURRENT work/ items (tasks, prds, ADRs, other`,
		`observations) and decide whether it is a CONSERVATIVE NO-QUESTION case — one`,
		`a human would NOT plausibly disagree with. You write NOTHING — no file edit,`,
		`no \`git mv\`, no commit (the advance ENGINE acts on what you emit). You`,
		`JUDGE; the engine ACTS.`,
		``,
		`The bar is HIGH. Emit auto:true ONLY for:`,
		`  - "duplicate": this observation is an EXACT duplicate of an existing item`,
		`    (same signal, already captured) → the engine RECOMMENDS deletion (a human`,
		`    still deletes it, per the capture-bucket contract); or`,
		`  - "map": this observation UNAMBIGUOUSLY maps onto ONE existing item (it is`,
		`    already covered there) → the engine DISCHARGES the redundant note by`,
		`    deletion, recording the mapping in the commit message.`,
		``,
		`NEVER emit auto:true to PROMOTE (drafting a new task is "is this worth`,
		`building?" — ALWAYS a human call) and NEVER to DELETE a NON-duplicate signal`,
		`(the agent never auto-deletes a real signal). If there is ANY judgement —`,
		`anything a reasonable human might decide differently — emit auto:false and the`,
		`engine will surface a promote/keep/delete question for the human.`,
		``,
		`Output ONLY a single JSON object of one of these exact shapes (no prose`,
		`OUTSIDE it):`,
		`  {"auto": true, "kind": "duplicate", "existing": "<namespace>:<slug>", "reason": "…"}`,
		`  {"auto": true, "kind": "map", "existing": "<namespace>:<slug>", "reason": "…"}`,
		`  {"auto": false, "reason": "needs a human's promote/keep/delete judgement"}`,
		`\`existing\` is the namespaced identity of the item this duplicates / maps`,
		`onto. It is plain text inside the JSON string (escape newlines as \\n).`,
	].join('\n');
}

/** What a harness-backed triage gate needs to launch the triage agent. */
export interface HarnessTriageGateOptions {
	/** The harness seam used to launch the fresh-context triage agent. */
	harness?: Harness;
	/** The agent command the null/shell adapter shells out to (`{model}`-aware). */
	agentCmd?: string;
	/**
	 * Read the triage agent's textual output for parsing. Production reads
	 * `launched.output` (the ANSWER channel); tests inject `readOutput` to stub a
	 * canned emit string.
	 */
	readOutput?: (output: string | undefined) => string;
}

/**
 * The PRODUCTION triage gate: launch a fresh-context agent through the EXISTING
 * harness seam (routing an optional `triageModel` via `LaunchInput.model` — the
 * §13 model-routing intent, NOT a new mechanism), then parse the emitted `{auto,
 * …}`. The DIRECT mirror of `harnessSurfaceGate`: a SEPARATE harness launch (fresh
 * context) in the same checkout `cwd`, fed {@link buildTriagePrompt}; a DISTINCT
 * session id (`<item>-triage`) so its session never collides with a build / review
 * / surface session.
 */
export function harnessTriageGate(
	options: HarnessTriageGateOptions = {},
): TriageGate {
	const harness = options.harness ?? new NullHarness();
	const readOutput = options.readOutput ?? ((output) => output ?? '');
	return async (input: TriageGateInput): Promise<TriageEmit> => {
		const sessionId = `${input.item.replace(/:/g, '-')}-triage`;
		const launched = await launchWithOptionalWatch({
			harness,
			dir: input.cwd,
			slug: input.item,
			command: options.agentCmd ?? '',
			prompt: buildTriagePrompt(input.item),
			model: input.triageModel,
			sessionId,
			sessionsDir: input.sessionsDir,
			env: input.env,
		});
		if (!launched.ok) {
			throw new TriageParseError(
				`triage agent launch failed${launched.detail ? `: ${launched.detail}` : ''}`,
			);
		}
		return parseTriageEmit(readOutput(launched.output));
	};
}
