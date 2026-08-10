import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {join} from 'node:path';
import {mkdirSync, writeFileSync, appendFileSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
	formatWatchEvent,
	lastAssistantText,
	lastAssistantTurn,
	isOutputCappedTurn,
	SessionTailer,
} from '../src/watch-session.js';
import {makeScratch, type Scratch} from './helpers/gitRepo.js';

/**
 * `do --watch` observer tests (tasks `do-watch` + `do-watch-session-log-format`).
 *
 * The watcher tails the pi `--session-dir` SESSION-PERSISTENCE log, whose records
 * are `{"type":"message", "message":{role, content[]}}` — NOT pi's `--mode json`
 * STREAM events (`tool_start`/`message_end`/`agent_end`). The earlier classifier
 * matched the stream vocabulary, so every session-log line fell through to skip
 * and `do --watch` was silently a no-op. These tests pin the CORRECT shape using
 * a REAL session-log-shaped fixture (`test/fixtures/pi-session-log.jsonl`):
 *
 *   1. `formatWatchEvent` — the pure classifier over the SESSION-LOG shape: an
 *      assistant `message` emits its `content[]` `text` and `▶ <name>` for each
 *      `toolCall`; everything else (`session`/`model_change`/user/toolResult/…) is
 *      skipped. "Finished" is NOT a log event — it is emitted on PROCESS EXIT.
 *   2. `SessionTailer` — tails a GROWING `.jsonl`, surfaces those events live, and
 *      emits `✓ agent finished` once on `stop()` (the process-exit hook).
 */

// The raw ANSI marker coloured output must contain (and plain must not).
const ESC = '\u001b[';

const FIXTURE = fileURLToPath(
	new URL('./fixtures/pi-session-log.jsonl', import.meta.url),
);

/** Parse the real fixture into lines (drop the trailing blank). */
function fixtureLines(): string[] {
	return readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
}

describe('formatWatchEvent — the pi SESSION-LOG classifier (not --mode json stream)', () => {
	it('an assistant message emits its text parts then a ▶ marker per toolCall', () => {
		// A real-shaped record: a thinking block (skipped), two text parts
		// (concatenated), then a toolCall named "read".
		const record = JSON.stringify({
			type: 'message',
			message: {
				role: 'assistant',
				content: [
					{type: 'thinking', thinking: 'IGNORED'},
					{type: 'text', text: 'Reading the prd, '},
					{type: 'text', text: 'then the PRD.'},
					{type: 'toolCall', name: 'read', arguments: {path: 'x'}},
				],
			},
		});
		expect(formatWatchEvent(record, false)).toEqual([
			'Reading the prd, then the PRD.',
			'▶ read x',
		]);
	});

	it('handles the toolName/args toolCall variant (tc.name||tc.toolName)', () => {
		const record = JSON.stringify({
			type: 'message',
			message: {
				role: 'assistant',
				content: [{type: 'toolCall', toolName: 'edit', args: {path: 'y'}}],
			},
		});
		expect(formatWatchEvent(record, false)).toEqual(['▶ edit y']);
	});

	it('a toolCall with no name falls back to "tool"', () => {
		const record = JSON.stringify({
			type: 'message',
			message: {role: 'assistant', content: [{type: 'toolCall'}]},
		});
		expect(formatWatchEvent(record, false)).toEqual(['▶ tool']);
	});

	it("shows a bash toolCall's command after the name", () => {
		const record = JSON.stringify({
			type: 'message',
			message: {
				role: 'assistant',
				content: [
					{
						type: 'toolCall',
						name: 'bash',
						arguments: {command: 'pnpm -r build'},
					},
				],
			},
		});
		expect(formatWatchEvent(record, false)).toEqual(['▶ bash pnpm -r build']);
	});

	it("shows a grep toolCall's pattern (its high-signal arg, not path)", () => {
		const record = JSON.stringify({
			type: 'message',
			message: {
				role: 'assistant',
				content: [
					{
						type: 'toolCall',
						name: 'grep',
						arguments: {pattern: 'toolName', path: 'src'},
					},
				],
			},
		});
		expect(formatWatchEvent(record, false)).toEqual(['▶ grep toolName']);
	});

	it('truncates a long detail to 64 chars + an ellipsis, collapsing whitespace', () => {
		const command = 'echo ' + 'a'.repeat(200);
		const record = JSON.stringify({
			type: 'message',
			message: {
				role: 'assistant',
				content: [{type: 'toolCall', name: 'bash', arguments: {command}}],
			},
		});
		const [line] = formatWatchEvent(record, false);
		// `▶ bash ` prefix (7 chars) + 64 detail chars + the ellipsis.
		expect(line).toBe(`▶ bash ${'echo ' + 'a'.repeat(59)}…`);
		expect(line.endsWith('…')).toBe(true);
	});

	it('collapses embedded newlines in a multi-line command to one line', () => {
		const record = JSON.stringify({
			type: 'message',
			message: {
				role: 'assistant',
				content: [
					{type: 'toolCall', name: 'bash', arguments: {command: 'a\nb\n c'}},
				],
			},
		});
		expect(formatWatchEvent(record, false)).toEqual(['▶ bash a b c']);
	});

	it('an unmapped tool probes generic keys (path/command/pattern/query)', () => {
		const record = JSON.stringify({
			type: 'message',
			message: {
				role: 'assistant',
				content: [
					{type: 'toolCall', name: 'websearch', arguments: {query: 'pi 0.73'}},
				],
			},
		});
		expect(formatWatchEvent(record, false)).toEqual(['▶ websearch pi 0.73']);
	});

	it('shows just the name when the toolCall carries no informative arg', () => {
		const record = JSON.stringify({
			type: 'message',
			message: {
				role: 'assistant',
				content: [{type: 'toolCall', name: 'read', arguments: {}}],
			},
		});
		expect(formatWatchEvent(record, false)).toEqual(['▶ read']);
	});

	it('tolerates an assistant message whose content is a plain string', () => {
		const record = JSON.stringify({
			type: 'message',
			message: {role: 'assistant', content: 'All done.'},
		});
		expect(formatWatchEvent(record, false)).toEqual(['All done.']);
	});

	it('SKIPS a user message', () => {
		const record = JSON.stringify({
			type: 'message',
			message: {role: 'user', content: [{type: 'text', text: 'the prompt'}]},
		});
		expect(formatWatchEvent(record, false)).toEqual([]);
	});

	it('SKIPS a toolResult message (tool results are not surfaced)', () => {
		const record = JSON.stringify({
			type: 'message',
			message: {
				role: 'toolResult',
				toolCallId: 'x',
				toolName: 'read',
				content: [{type: 'text', text: 'file body'}],
			},
		});
		expect(formatWatchEvent(record, false)).toEqual([]);
	});

	it('SKIPS the non-message record types (session/model_change/thinking_level_change)', () => {
		expect(
			formatWatchEvent(JSON.stringify({type: 'session', id: 'a'}), false),
		).toEqual([]);
		expect(
			formatWatchEvent(
				JSON.stringify({type: 'model_change', modelId: 'm'}),
				false,
			),
		).toEqual([]);
		expect(
			formatWatchEvent(
				JSON.stringify({type: 'thinking_level_change', thinkingLevel: 'off'}),
				false,
			),
		).toEqual([]);
	});

	it('does NOT treat the absent --mode json stream events as anything (tool_start/message_end/agent_end skipped)', () => {
		// These are the WRONG vocabulary the old classifier matched — in the
		// session log they never occur, and must classify as skip.
		expect(
			formatWatchEvent(
				JSON.stringify({type: 'tool_start', tool: 'edit'}),
				false,
			),
		).toEqual([]);
		expect(
			formatWatchEvent(JSON.stringify({type: 'agent_end'}), false),
		).toEqual([]);
	});

	it('skips blank lines and malformed JSON (a half-written trailing line) — never throws', () => {
		expect(formatWatchEvent('', false)).toEqual([]);
		expect(formatWatchEvent('   ', false)).toEqual([]);
		expect(() =>
			formatWatchEvent('{"type":"message","message":{"role":"assi', false),
		).not.toThrow();
		expect(
			formatWatchEvent('{"type":"message","message":{"role":"assi', false),
		).toEqual([]);
	});

	it('emits ANSI colour for the ▶ tool marker when color=true, plain otherwise', () => {
		const record = JSON.stringify({
			type: 'message',
			message: {
				role: 'assistant',
				content: [{type: 'toolCall', name: 'edit'}],
			},
		});
		const [coloured] = formatWatchEvent(record, true);
		expect(coloured).toContain(ESC);
		const [plain] = formatWatchEvent(record, false);
		expect(plain).not.toContain(ESC);
	});

	it('surfaces a REAL session-log fixture: tool starts + assistant text, other records skipped', () => {
		const surfaced = fixtureLines().flatMap((line) =>
			formatWatchEvent(line, false),
		);
		// The fixture has: session, model_change, thinking_level_change, a user
		// message, an assistant (text+text+read toolCall), a toolResult, an
		// assistant (text + edit toolCall), and a content-as-string assistant.
		expect(surfaced).toEqual([
			"I'll start by reading the task prd, then its source PRD.",
			'▶ read work/in-progress/do-watch-session-log-format.md',
			'Now editing the file.',
			'▶ edit src/watch-session.ts',
			'All done — the build is green.',
		]);
	});
});

describe('lastAssistantText — the shared last-assistant-text reader (one parser)', () => {
	/** Join records into a `.jsonl` body (one JSON object per line). */
	function jsonl(records: unknown[]): string {
		return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
	}

	it('returns the LAST assistant turn, concatenating its multi-part text', () => {
		const log = jsonl([
			{type: 'session', id: 'a'},
			{
				type: 'message',
				message: {role: 'user', content: [{type: 'text', text: 'the prompt'}]},
			},
			{
				type: 'message',
				message: {
					role: 'assistant',
					content: [{type: 'text', text: 'an EARLIER turn'}],
				},
			},
			{
				type: 'message',
				message: {
					role: 'assistant',
					content: [
						{type: 'thinking', thinking: 'IGNORED'},
						{type: 'text', text: 'My final '},
						{type: 'text', text: 'answer.'},
					],
				},
			},
		]);
		expect(lastAssistantText(log)).toBe('My final answer.');
	});

	it('takes a plain-string assistant content as the text', () => {
		const log = jsonl([
			{type: 'message', message: {role: 'assistant', content: 'All done.'}},
		]);
		expect(lastAssistantText(log)).toBe('All done.');
	});

	it('skips a tool-call-only assistant turn (no text), using the last TEXT turn', () => {
		const log = jsonl([
			{
				type: 'message',
				message: {
					role: 'assistant',
					content: [{type: 'text', text: 'verdict'}],
				},
			},
			{
				type: 'message',
				message: {
					role: 'assistant',
					content: [{type: 'toolCall', name: 'read'}],
				},
			},
		]);
		// The tool-only turn is not an answer; the earlier text turn is the answer.
		expect(lastAssistantText(log)).toBe('verdict');
	});

	it('returns undefined when the only assistant turn is tool-calls (no text)', () => {
		const log = jsonl([
			{
				type: 'message',
				message: {
					role: 'assistant',
					content: [{type: 'toolCall', name: 'bash'}],
				},
			},
		]);
		expect(lastAssistantText(log)).toBeUndefined();
	});

	it('returns undefined for an empty / assistant-text-less log', () => {
		expect(lastAssistantText('')).toBeUndefined();
		expect(
			lastAssistantText(
				jsonl([
					{type: 'session', id: 'a'},
					{type: 'message', message: {role: 'user', content: 'hi'}},
				]),
			),
		).toBeUndefined();
	});

	it('skips malformed / half-written trailing lines without throwing', () => {
		const log =
			JSON.stringify({
				type: 'message',
				message: {role: 'assistant', content: 'kept'},
			}) + '\n{"type":"message","message":{"role":"assi';
		expect(() => lastAssistantText(log)).not.toThrow();
		expect(lastAssistantText(log)).toBe('kept');
	});
});

let scratch: Scratch;
beforeEach(() => {
	scratch = makeScratch('dorfl-watch-');
});
afterEach(() => {
	scratch.cleanup();
});

/** Wait until `predicate()` holds (polling), or fail after `timeoutMs`. */
async function waitFor(
	predicate: () => boolean,
	timeoutMs = 2000,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('waitFor timed out');
		}
		await new Promise((r) => setTimeout(r, 10));
	}
}

describe('SessionTailer — tails the KNOWN session-file path (no stale-sibling race)', () => {
	it('tails the EXACT given file, ignoring a pre-existing newer sibling in the same dir', async () => {
		// The stale-sibling race the fix eliminates: a PRIOR run's log sits in the
		// same dir (newer mtime). The tailer must read the KNOWN path, NOT the
		// newest sibling.
		const dir = join(scratch.root, 'session');
		mkdirSync(dir, {recursive: true});
		const stale = join(dir, 'prior-run.jsonl');
		writeFileSync(
			stale,
			JSON.stringify({
				type: 'message',
				message: {role: 'assistant', content: 'STALE prior run'},
			}) + '\n',
		);
		const known = join(dir, 'this-run.jsonl');

		const surfaced: string[] = [];
		const tailer = new SessionTailer({
			sessionFile: known,
			color: false,
			sink: (line) => surfaced.push(line),
			pollIntervalMs: 10,
		});
		tailer.start();
		// pi writes the KNOWN file a moment after launch.
		await new Promise((r) => setTimeout(r, 30));
		writeFileSync(
			known,
			JSON.stringify({
				type: 'message',
				message: {role: 'assistant', content: 'THIS run'},
			}) + '\n',
		);
		await waitFor(() => surfaced.length >= 1);
		await tailer.stop();
		// Only the KNOWN file's content is surfaced; the stale sibling is never read.
		expect(surfaced).toEqual(['THIS run', '✓ agent finished']);
	});
});

describe('SessionTailer — concurrent tail of a GROWING session .jsonl', () => {
	it('surfaces assistant text + tool starts as the file grows; skips the rest', async () => {
		const dir = join(scratch.root, 'session');
		mkdirSync(dir, {recursive: true});
		const log = join(dir, 'session.jsonl');
		writeFileSync(log, ''); // log exists before the agent writes events.

		const surfaced: string[] = [];
		const tailer = new SessionTailer({
			sessionFile: log,
			color: false,
			sink: (line) => surfaced.push(line),
			pollIntervalMs: 10,
		});
		tailer.start();

		// Append real-shaped records one-by-one (the live, growing log).
		appendFileSync(log, JSON.stringify({type: 'session', id: 'a'}) + '\n'); // skip
		appendFileSync(
			log,
			JSON.stringify({
				type: 'message',
				message: {role: 'user', content: [{type: 'text', text: 'prompt'}]},
			}) + '\n', // skip
		);
		appendFileSync(
			log,
			JSON.stringify({
				type: 'message',
				message: {
					role: 'assistant',
					content: [
						{type: 'text', text: 'on it'},
						{type: 'toolCall', name: 'read'},
					],
				},
			}) + '\n',
		);
		appendFileSync(
			log,
			JSON.stringify({
				type: 'message',
				message: {role: 'toolResult', toolName: 'read', content: 'body'},
			}) + '\n', // skip
		);

		await waitFor(() => surfaced.length >= 2);
		await tailer.stop();

		// The final drain plus stop() append the process-exit finished line.
		expect(surfaced).toEqual(['on it', '▶ read', '✓ agent finished']);
	});

	it('emits "✓ agent finished" once on stop() — PROCESS EXIT, not a log event', async () => {
		const dir = join(scratch.root, 'session');
		mkdirSync(dir, {recursive: true});
		const log = join(dir, 'session.jsonl');
		writeFileSync(log, '');

		const surfaced: string[] = [];
		const tailer = new SessionTailer({
			sessionFile: log,
			color: false,
			sink: (line) => surfaced.push(line),
			pollIntervalMs: 10,
		});
		tailer.start();
		// No log events at all — finished is still emitted on exit.
		await tailer.stop();
		expect(surfaced).toEqual(['✓ agent finished']);
		// stop() is idempotent and does NOT re-emit finished.
		await tailer.stop();
		expect(surfaced).toEqual(['✓ agent finished']);
	});

	it('buffers a partial trailing line until its newline arrives (split write)', async () => {
		const dir = join(scratch.root, 'session');
		mkdirSync(dir, {recursive: true});
		const log = join(dir, 'session.jsonl');
		writeFileSync(log, '');

		const surfaced: string[] = [];
		const tailer = new SessionTailer({
			sessionFile: log,
			color: false,
			sink: (line) => surfaced.push(line),
			pollIntervalMs: 10,
		});
		tailer.start();

		// Write an assistant toolCall record in two halves; newline in the second.
		appendFileSync(
			log,
			'{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall",',
		);
		await new Promise((r) => setTimeout(r, 30));
		expect(surfaced).toEqual([]); // nothing surfaced from the partial line yet.
		appendFileSync(log, '"name":"bash"}]}}\n');

		await waitFor(() => surfaced.length >= 1);
		await tailer.stop();
		expect(surfaced).toEqual(['▶ bash', '✓ agent finished']);
	});

	it('waits for the log to APPEAR, then tails it (pi creates it once it starts)', async () => {
		const dir = join(scratch.root, 'session');
		mkdirSync(dir, {recursive: true});
		const log = join(dir, 'session.jsonl');
		// NB: the log does NOT exist yet when the tailer starts.

		const surfaced: string[] = [];
		const tailer = new SessionTailer({
			sessionFile: log,
			color: false,
			sink: (line) => surfaced.push(line),
			pollIntervalMs: 10,
		});
		tailer.start();

		await new Promise((r) => setTimeout(r, 30));
		writeFileSync(
			log,
			JSON.stringify({
				type: 'message',
				message: {role: 'assistant', content: 'hello'},
			}) + '\n',
		);

		await waitFor(() => surfaced.length >= 1);
		await tailer.stop();
		expect(surfaced).toEqual(['hello', '✓ agent finished']);
	});

	it('a final drain on stop() catches events written just before exit', async () => {
		const dir = join(scratch.root, 'session');
		mkdirSync(dir, {recursive: true});
		const log = join(dir, 'session.jsonl');
		writeFileSync(log, '');

		const surfaced: string[] = [];
		const tailer = new SessionTailer({
			sessionFile: log,
			color: false,
			sink: (line) => surfaced.push(line),
			pollIntervalMs: 1000, // long poll → only the stop() drain will catch it.
		});
		tailer.start();
		appendFileSync(
			log,
			JSON.stringify({
				type: 'message',
				message: {role: 'assistant', content: 'late'},
			}) + '\n',
		);
		await tailer.stop(); // the final drain must surface it.
		expect(surfaced).toEqual(['late', '✓ agent finished']);
	});
});

describe('lastAssistantTurn — stop_reason + usage (the output-cap signal)', () => {
	/** One assistant record carrying stop_reason + usage. */
	function turn(
		text: string,
		extra: {stop_reason?: unknown; usage?: unknown} = {},
	): string {
		return (
			JSON.stringify({
				type: 'message',
				message: {
					role: 'assistant',
					content: [{type: 'text', text}],
					...extra,
				},
			}) + '\n'
		);
	}

	it("returns the text + the last turn's stop_reason + usage.output_tokens", () => {
		const log =
			turn('first', {stop_reason: 'end_turn', usage: {output: 10}}) +
			turn('final', {stop_reason: 'max_tokens', usage: {output_tokens: 16384}});
		const t = lastAssistantTurn(log);
		expect(t.text).toBe('final');
		expect(t.stopReason).toBe('max_tokens');
		expect(t.outputTokens).toBe(16384);
		// lastAssistantText still returns just the text (backward compat).
		expect(lastAssistantText(log)).toBe('final');
	});

	it('reads `usage.output` (the pi-session shape) OR `usage.output_tokens`', () => {
		const a = turn('a', {usage: {output: 4096}});
		expect(lastAssistantTurn(a).outputTokens).toBe(4096);
		const b = turn('b', {usage: {output_tokens: 8192}});
		expect(lastAssistantTurn(b).outputTokens).toBe(8192);
	});

	it('treats stop_reason null/None as a cap signal (the truncated-turn shape)', () => {
		expect(isOutputCappedTurn({stopReason: null, outputTokens: 16384})).toBe(
			true,
		);
		// `None` (the string pi emits) is also a cap signal.
		expect(isOutputCappedTurn({stopReason: 'None', outputTokens: 16384})).toBe(
			true,
		);
		// `max_tokens` (the standard API cap) is a cap signal.
		expect(
			isOutputCappedTurn({stopReason: 'max_tokens', outputTokens: 16384}),
		).toBe(true);
	});

	it('a natural turn-end (end_turn / tool_use) is NOT a cap signal', () => {
		expect(
			isOutputCappedTurn({stopReason: 'end_turn', outputTokens: 100}),
		).toBe(false);
		expect(
			isOutputCappedTurn({stopReason: 'tool_use', outputTokens: 100}),
		).toBe(false);
	});

	it('a cap signal with NO produced tokens is NOT a cap (nothing was emitted)', () => {
		expect(isOutputCappedTurn({stopReason: null, outputTokens: 0})).toBe(false);
		expect(
			isOutputCappedTurn({stopReason: null, outputTokens: undefined}),
		).toBe(false);
	});

	it('detects the cap-truncation shape end-to-end from a session log', () => {
		// A run that ended with stop_reason null + usage.output 16384 (the
		// reproduced defect's transcript shape).
		const log = turn('{"verdict": "block", "findings": [', {
			stop_reason: null,
			usage: {output: 16384},
		});
		const t = lastAssistantTurn(log);
		expect(isOutputCappedTurn(t)).toBe(true);
		expect(t.outputTokens).toBe(16384);
		expect(t.stopReason).toBeNull();
		// And the text itself is the truncated (unparseable) body.
		expect(t.text).not.toMatch(/\}/);
	});

	it('a turn with no stop_reason/usage yields undefined signals (not a cap)', () => {
		const log = turn('answer'); // no stop_reason/usage
		const t = lastAssistantTurn(log);
		expect(t.text).toBe('answer');
		expect(t.stopReason).toBeUndefined();
		expect(t.outputTokens).toBeUndefined();
		expect(isOutputCappedTurn(t)).toBe(false);
	});
});
