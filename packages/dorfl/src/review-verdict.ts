/**
 * The UNIFIED review-verdict type + parser + the shared JSON-verdict-contract
 * prompt helper for the runner-invoked **review discipline**
 * (`work/protocol/REVIEW-PROTOCOL.md`, source-of-truth
 * `skills/setup/protocol/REVIEW-PROTOCOL.md`).
 *
 * This is the keystone of the `runner-invoked-disciplines-into-protocol` spec
 * (task 1, D4): every runner-invoked review prompt builder
 * ({@link buildReviewPrompt}, {@link buildTaskAcceptancePrompt} in
 * `review-gate.ts`; {@link buildLoneTaskReviewPrompt} in `intake.ts`;
 * {@link buildTaskReviewPrompt} in `tasker-review-loop.ts`) POINTS at
 * `REVIEW-PROTOCOL.md` for the discipline + calls {@link verdictContractPrompt}
 * for the JSON-emitted-shape prose. None of them re-inlines the lenses or the
 * verdict contract; this module is the single home.
 *
 * The PARSER is the source of truth for the EMITTED SHAPE (D2):
 * `REVIEW-PROTOCOL.md` mirrors what `parseReviewVerdict` enforces (a
 * fixture-matches-doc test pins the two together). Discipline content is owned
 * by the doc; enforced shape is owned by the parser.
 */

import {extractJsonObjectSpan} from './verdict-json.js';
import {resolveProtocolDoc} from './prompt.js';

/** A single review finding — the `severity`/`question`/`context` triple. */
export interface ReviewFinding {
	/** Whether this finding blocks (keeps the work out of "ready") or is a nit. */
	severity: 'blocking' | 'non-blocking';
	/** The question / defect, with enough context to act. */
	question: string;
	/** The relevant excerpt, `file:line`, or reasoning. */
	context?: string;
}

/**
 * A full-content edit the review agent wants applied (the improver loop's
 * between-passes step). `path` is repo-relative; `content` is the FULL
 * replacement file body. The runner writes it; the agent does no disk/git.
 */
export interface TaskEdit {
	/** Repo-relative path of the candidate task file to write. */
	path: string;
	/**
	 * The full replacement content for that file, emitted INLINE. LEGACY / small-edit
	 * form. UNBOUNDED: a large decomposition's worth of full-file bodies in ONE JSON
	 * object shares the model's capped response with the verdict, so a rich spec can
	 * cap-truncate the response before the verdict closes (observation
	 * `tasker-review-edits-payload-caps-the-verdict-response`). The tasker improver loop
	 * now asks the agent to WRITE each edited body to a scratch file and reference it by
	 * `src` instead (see {@link src}) so the verdict is obtainable independent of edit
	 * size. Kept (optional) so a small inline edit + the existing tests still work.
	 */
	content?: string;
	/**
	 * Repo-relative path to a SCRATCH file the agent WROTE the full replacement body
	 * to (the runner reads it, applies it through the SAME scope fence, then deletes
	 * it). The DECOUPLED form: the verdict JSON carries only PATHS, so its size is
	 * bounded by the NUMBER of edits, not the total body size — a large decomposition
	 * can no longer cap-truncate the verdict. The agent writes the scratch file itself
	 * (it runs in the job worktree and has the `write` tool); the runner applies /
	 * commits. Exactly one of {@link content} / {@link src} carries the body.
	 */
	src?: string;
}

/**
 * A task the review judged UNCERTAIN — emit it `needsAnswers: true` with the
 * questions in its body. Used by the tasker improver loop's non-converge sink.
 */
export interface UncertainTask {
	/** Repo-relative path of the uncertain candidate task. */
	path: string;
	/** The open questions to record in the task body. */
	questions: string[];
}

/**
 * The UNIFIED review verdict — one type across all four runner-invoked review
 * call sites. The required fields (`verdict`, `findings`) are common; the
 * optional channels are caller-specific (each builder's prompt names which
 * channels to fill). The parser tolerates any subset; routing code reads only
 * the channels its caller asked for.
 */
export interface ReviewVerdict {
	/** `approve` lets the artifact proceed; `block` routes to needs-attention. */
	verdict: 'approve' | 'block';
	/** The findings the agent surfaced (may be empty on an approve). */
	findings: ReviewFinding[];
	/**
	 * For the PR/code review gate: the deliberately-authored, human-readable
	 * REVIEW prose the in-core PR-comment poster posts. Advisory only — never
	 * gates the verdict (routing uses ONLY `verdict`/`findings`).
	 */
	review?: string;
	/** For the tasker improver loop: full-content edits to apply between passes. */
	edits?: TaskEdit[];
	/**
	 * For the lone-task review: a single in-memory full-replacement task BODY
	 * (the markdown AFTER the frontmatter), applied before the next round.
	 */
	edit?: string;
	/** For the lone-task review: open question(s) carried into the ASK comment. */
	questions?: string[];
	/** For the tasker improver loop: specific tasks to emit `needsAnswers: true`. */
	uncertainTasks?: UncertainTask[];
	/** For the tasker improver loop: route the WHOLE spec to needs-attention. */
	decompositionUnclear?: {questions: string[]};
}

/** Raised when the review agent ran but produced no parseable verdict. */
export class ReviewParseError extends Error {}

/**
 * Raised when the review agent's output was TRUNCATED at the model's output cap
 * before it could emit a complete verdict — a DISTINCT, named failure class so it is
 * never mis-reported as a generic "produced no parseable result" (which reads as a
 * flake and invites a blind retry, burning a second full tasking run).
 *
 * It is a SUBCLASS of {@link ReviewParseError} so every existing
 * `catch (ReviewParseError)` site (the tasker-review loop's bounce routing) still
 * catches it UNIFORMLY and routes to needs-attention — NEVER a silent approve. The
 * only thing that changes is the MESSAGE: it names the cap and the token count so
 * an operator knows the structural cause (the edits payload is unbounded and
 * shared the capped response with the verdict) rather than chasing a model flake.
 *
 * Detected at the harness seam: the adapter surfaces the last assistant turn's
 * `stop_reason` (null / `None` / `max_tokens` — the turn did not end naturally) and
 * its `usage.output` token count; the gate throws this when a parse fails AND that
 * cap signal is present. When the adapter CANNOT see the signal (the null/shell
 * adapter, or a future adapter without usage telemetry), the parse still fails as a
 * generic {@link ReviewParseError} — still needs-attention, never a silent approve.
 */
export class ReviewOutputCappedError extends ReviewParseError {
	/** The output token count the agent reached when the cap hit (the observed `usage.output`). */
	readonly outputTokens: number;
	constructor(outputTokens: number) {
		super(
			`review agent output hit the model output cap (${outputTokens} tokens) ` +
				'and was truncated before emitting its verdict',
		);
		this.name = 'ReviewOutputCappedError';
		this.outputTokens = outputTokens;
	}
}

/**
 * Parse the unified review verdict out of the review agent's textual output.
 * The agent may wrap the JSON object in prose / a fenced block, so the first
 * JSON object carrying a `verdict` field is extracted via the shared
 * {@link extractJsonObjectSpan}, JSON-parsed, and validated. The verdict shape
 * is the source of truth for what `REVIEW-PROTOCOL.md` describes (D2).
 *
 * Throws {@link ReviewParseError} on: no JSON object, invalid JSON, or a
 * `verdict` not in `{approve, block}`. The caller treats any throw as
 * needs-attention — NEVER a silent approve.
 */
export function parseReviewVerdict(output: string): ReviewVerdict {
	const span = extractJsonObjectSpan(output);
	if (span === undefined) {
		throw new ReviewParseError(
			'review agent produced no parseable {verdict, findings} result',
		);
	}
	const slice = output.slice(span.start, span.end);
	let parsed: unknown;
	try {
		// STRICT FIRST: already-valid JSON parses here and is returned UNTOUCHED —
		// the repair pass never runs for it (no chance to alter a correct payload).
		parsed = JSON.parse(slice);
	} catch (strictErr) {
		// ONE lenient repair pass for the CONTROL-CHAR class (raw newline / tab / CR /
		// other C0 char left unescaped inside a string field, common on large diffs +
		// weaker models). The repair is NARROW: it only escapes control chars INSIDE
		// strings; it NEVER touches JSON structure or token values (no trailing-comma
		// stripping, no quoting bare tokens, no coercion), so it can never launder a
		// genuinely-malformed or meaningfully-WRONG verdict into a false approve/block.
		// A still-failing parse re-throws the ORIGINAL strict error (so direction-1's
		// `runGate2Review` catch routes it to needs-attention, never a silent approve).
		// NOTE the boundary: this does NOT fix an unescaped inner double-quote (which
		// mis-bounds the extracted span before repair even runs); that class is handled
		// by routing (direction 1) + the tightened contract (direction 3).
		try {
			parsed = JSON.parse(repairJsonControlChars(slice));
		} catch {
			throw new ReviewParseError(
				`review verdict was not valid JSON: ${(strictErr as Error).message}`,
			);
		}
	}
	// A repaired parse STILL flows through validation, so a repaired
	// `{"verdict":"maybe"}` (valid JSON, invalid VALUE) still throws here — the
	// repair recovers SYNTAX, never bypasses the verdict-VALUE contract.
	return validateVerdict(parsed);
}

/**
 * The NARROW lenient repair (direction 2): walk the extracted JSON slice and
 * escape any raw control char (a C0 char `< 0x20`, which JSON forbids inside a
 * string literal) that appears INSIDE a string. OUTSIDE a string the structure
 * is left byte-for-byte untouched. Escape-tracking is load-bearing: an escaped
 * `\"` must NOT be read as the string's closing quote (or a following raw
 * newline would be mis-handled). This recovers ONLY the control-char class; it
 * performs NO structural change and NO token coercion, so it cannot turn a real
 * reject into a false approve.
 */
function repairJsonControlChars(text: string): string {
	let out = '';
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const code = ch.charCodeAt(0);
		if (inString) {
			if (escaped) {
				out += ch;
				escaped = false;
				continue;
			}
			if (ch === '\\') {
				out += ch;
				escaped = true;
				continue;
			}
			if (ch === '"') {
				out += ch;
				inString = false;
				continue;
			}
			if (code < 0x20) {
				if (ch === '\n') out += '\\n';
				else if (ch === '\t') out += '\\t';
				else if (ch === '\r') out += '\\r';
				else out += '\\u' + code.toString(16).padStart(4, '0');
				continue;
			}
			out += ch;
			continue;
		}
		if (ch === '"') {
			inString = true;
		}
		out += ch;
	}
	return out;
}

function validateVerdict(parsed: unknown): ReviewVerdict {
	if (typeof parsed !== 'object' || parsed === null) {
		throw new ReviewParseError('review verdict was not an object');
	}
	const obj = parsed as Record<string, unknown>;
	const verdict = obj.verdict;
	if (verdict !== 'approve' && verdict !== 'block') {
		throw new ReviewParseError(
			`review verdict was not 'approve' or 'block' (got ${JSON.stringify(verdict)})`,
		);
	}
	const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
	const findings: ReviewFinding[] = rawFindings.map((f) => {
		const item = (typeof f === 'object' && f !== null ? f : {}) as Record<
			string,
			unknown
		>;
		const severity = item.severity === 'blocking' ? 'blocking' : 'non-blocking';
		return {
			severity,
			question: typeof item.question === 'string' ? item.question : '',
			...(typeof item.context === 'string' ? {context: item.context} : {}),
		};
	});
	const edits = parseEdits(obj.edits);
	const uncertainTasks = parseUncertainTasks(obj.uncertainTasks);
	const decompositionUnclear = parseDecompositionUnclear(
		obj.decompositionUnclear,
	);
	const questions = Array.isArray(obj.questions)
		? obj.questions.filter((q): q is string => typeof q === 'string')
		: [];
	return {
		verdict,
		findings,
		...(typeof obj.review === 'string' ? {review: obj.review} : {}),
		...(typeof obj.edit === 'string' ? {edit: obj.edit} : {}),
		...(edits.length > 0 ? {edits} : {}),
		...(questions.length > 0 ? {questions} : {}),
		...(uncertainTasks.length > 0 ? {uncertainTasks} : {}),
		...(decompositionUnclear ? {decompositionUnclear} : {}),
	};
}

function parseEdits(raw: unknown): TaskEdit[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: TaskEdit[] = [];
	for (const e of raw) {
		if (typeof e !== 'object' || e === null) {
			continue;
		}
		const item = e as Record<string, unknown>;
		if (typeof item.path !== 'string') {
			continue;
		}
		// The body is either inline `content` (legacy / small edits) OR a `src` scratch
		// path the agent wrote (the decoupled form — see TaskEdit). Carry whichever
		// is present; the runner resolves it. An edit with NEITHER is dropped (no body
		// to apply) — but a path-only edit is also tolerated as a no-op marker so a
		// verdict that names a path it did not actually rewrite does not crash the loop.
		const edit: TaskEdit = {path: item.path};
		if (typeof item.content === 'string') {
			edit.content = item.content;
		}
		if (typeof item.src === 'string') {
			edit.src = item.src;
		}
		out.push(edit);
	}
	return out;
}

function parseUncertainTasks(raw: unknown): UncertainTask[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: UncertainTask[] = [];
	for (const u of raw) {
		if (typeof u !== 'object' || u === null) {
			continue;
		}
		const item = u as Record<string, unknown>;
		if (typeof item.path !== 'string') {
			continue;
		}
		const questions = Array.isArray(item.questions)
			? item.questions.filter((q): q is string => typeof q === 'string')
			: [];
		out.push({path: item.path, questions});
	}
	return out;
}

function parseDecompositionUnclear(
	raw: unknown,
): {questions: string[]} | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const item = raw as Record<string, unknown>;
	const questions = Array.isArray(item.questions)
		? item.questions.filter((q): q is string => typeof q === 'string')
		: [];
	return {questions};
}

/**
 * The shared JSON-verdict-contract prompt block — ONE function, called by all
 * four review-prompt builders. Returns the prose describing the unified
 * {@link ReviewVerdict} emitted shape (the prose mirrors what
 * {@link parseReviewVerdict} enforces; D2). Per-builder framing (who you are,
 * what you are reviewing, which optional channels to fill) stays in each
 * builder; this block is the single source of truth for the shape.
 *
 * The block is intentionally generous about optional channels — each caller's
 * prompt names which ones it wants. Unused channels are ignored by the parser.
 */
export function verdictContractPrompt(): string {
	return [
		'## Your output \u2014 ONE single JSON object (no prose OUTSIDE it)',
		'',
		'Emit a single JSON object of this exact shape (see',
		'`work/protocol/REVIEW-PROTOCOL.md` \u2192 "Your output" for the prose-described',
		'contract this mirrors). The example below is EXPANDED over several lines for',
		'READABILITY, but you MUST emit it MINIFIED \u2014 ONE single line, no newlines',
		'between the keys:',
		'',
		'```json',
		'{"verdict": "approve" | "block",',
		' "findings": [',
		'   {"severity": "blocking" | "non-blocking", "question": "\u2026", "context": "\u2026"}',
		' ],',
		' "review": "<the human-readable PR-comment prose, when the caller asks for it>",',
		' "edits": [ {"path": "work/tasks/backlog/<slug>.md", "src": "<scratch path you wrote the full body to>"} ],',
		'       // (inline "content": "<full replacement>" is the legacy small-edit form —',
		'       //  the tasker loop writes the body to a scratch file + references it by',
		'       //  "src" so the edits payload cannot cap-truncate this verdict)',
		' "edit": "<single in-memory replacement body, for the lone-task review>",',
		' "questions": ["<open question for the human>"],',
		' "uncertainTasks": [ {"path": "work/tasks/backlog/<slug>.md", "questions": ["\u2026"]} ],',
		' "decompositionUnclear": {"questions": ["\u2026"]}}',
		'```',
		'',
		'- `verdict` MUST be exactly `approve` or `block`. Use `block` with at least',
		'  one blocking finding when the artifact does not deliver / drifts / hides',
		'  a defect a human reviewer would flag; otherwise `approve`.',
		"- `findings` is required (may be empty). Each finding's `severity` is",
		'  `blocking` (keeps the item out of "ready") or `non-blocking` (a nit /',
		'  future improvement). Give each `question` enough context to act WITHOUT',
		'  re-deriving it. `context` is the relevant excerpt, `file:line`, or',
		'  reasoning.',
		'- The optional channels (`review`, `edits`, `edit`, `questions`,',
		'  `uncertainTasks`, `decompositionUnclear`) are OPT-IN: only fill the ones',
		"  the caller's framing names. Unused channels are ignored.",
		'',
		parseableJsonContractPrompt('verdict', 'review'),
	].join('\n');
}

/**
 * The shared "emit DEFENSIVE, parseable, minified JSON" contract block — the
 * hard-won discipline that stops a weak model from stranding the run with an
 * unparseable emit (a dropped escape on an inner `"`, a raw newline in a string,
 * an over-long field). It was learned on the Gate-2 verdict seam
 * (observation `gate2-review-verdict-json-parse-crash-on-large-diffs`) and is
 * now SHARED so EVERY agent→JSON→dispatch seam carries it, not just the verdict
 * gate: {@link verdictContractPrompt} appends it, and so does the SURFACE gate's
 * `buildSurfacePrompt` (observation
 * `surface-rung-agent-emits-no-parseable-questions` — the same class of failure
 * on the surface rung, where the prompt previously lacked this hardening AND
 * showed a multi-line example that invited pretty-printing).
 *
 * @param emitNoun what the emitted object is called in prose (`verdict` /
 *   `result`) — only the wording differs; the discipline is identical.
 * @param longestField the name of the field most likely to be long (the one to
 *   length-cap), or undefined to omit the length-cap bullet.
 */
export function parseableJsonContractPrompt(
	emitNoun = 'verdict',
	longestField?: string,
): string {
	const lengthCap =
		longestField === undefined
			? []
			: [
					`- Keep the LONGEST field (\`${longestField}\`) under ~1500 characters; say`,
					'  less, not more. A long, multi-paragraph field is exactly what corrupts',
					'  the JSON.',
				];
	return [
		'### Keep the JSON PARSEABLE (this is where weak models fail)',
		'',
		`A malformed ${emitNoun} strands the work, so emit DEFENSIVELY:`,
		'- Emit it MINIFIED: ONE single line, no pretty-printing, no blank lines.',
		'- INSIDE every string value, do NOT use a literal double-quote `"`. If you',
		'  must quote something in prose, PARAPHRASE it or use SINGLE quotes \u2014 a',
		`  dropped escape on an inner \`"\` is the #1 cause of an unparseable ${emitNoun}.`,
		'- Keep every string field SHORT and SINGLE-LINE. Do NOT embed a raw newline,',
		'  tab, or other control char in a string; if you genuinely need a break, write',
		'  the two characters `\\n` (a backslash then n), never a real newline.',
		...lengthCap,
	].join('\n');
}

/**
 * The shared prompt block that POINTS the spawned agent at the in-band review
 * discipline doc (`work/protocol/REVIEW-PROTOCOL.md` in the set-up target repo,
 * or the vendored fallback) instead of re-inlining the lenses. The four review
 * builders call this so the discipline content lives in ONE place
 * (`REVIEW-PROTOCOL.md`), never duplicated in the prompt builders.
 */
export function reviewDisciplinePrompt(): string {
	return [
		'## The review discipline',
		'',
		'Run the review discipline defined in `work/protocol/REVIEW-PROTOCOL.md`',
		'(the in-band, protocol-native review protocol every set-up repo carries;',
		'the human-facing pointer is `skills/review/SKILL.md`). Apply its lenses',
		'IN ORDER, ENDING in the destination check ("if this is built/merged',
		'exactly as written, do we end up with the system the spec/task',
		'goal describes?"). Be ADVERSARIAL; verify against what ACTUALLY LANDED',
		'(the bytes on disk), not intent. Weight findings by REAL impact \u2014 the',
		'lenses find candidates, impact decides severity (a technically-true nit',
		'no one would hit is not a block). Flag, do not guess.',
	].join('\n');
}

/**
 * Resolve `REVIEW-PROTOCOL.md` in the target repo / vendored fallback / dev
 * walk \u2014 a thin alias around {@link resolveProtocolDoc} for callers (and
 * tests) that want to assert the doc is reachable. The four builders themselves
 * do NOT call this (they reference the path BY NAME in the prompt prose, so the
 * spawned agent reads its repo's own `work/protocol/REVIEW-PROTOCOL.md`), but
 * keeping the helper here lets the resolver test cover the protocol-doc set in
 * one place.
 */
export function resolveReviewProtocolPath(
	cwd?: string,
	override?: string,
): string {
	return resolveProtocolDoc('REVIEW-PROTOCOL.md', cwd, override);
}
