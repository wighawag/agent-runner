import {open, type FileHandle} from 'node:fs/promises';

/**
 * The **`do --watch` observer** (tasks `do-watch` + `do-watch-session-log-format`)
 * — a READ-ONLY concurrent tail of the pi session `.jsonl` event log, restoring
 * for `do` the live agent-conversation view `ar-run.sh --watch` gave.
 *
 * `ar-run.sh --watch` piped `pi -p --mode json | jq` to surface the high-signal
 * events; `do` runs the agent CAPTURED through the harness seam, so that live
 * view was lost. The pi adapter writes a session `.jsonl` at the KNOWN file path
 * the caller generated (`--session <path>`, task `session-path-pi-default`) —
 * but that is pi's SESSION-PERSISTENCE log, a DIFFERENT format from the
 * `--mode json` STREAM `ar-run.sh` piped. The tailer is pointed at that EXACT
 * path (no newest-by-mtime dir guessing), so the stale-sibling race is gone.
 *
 * Studied (task `pi-harness-polish`, finding
 * `work/notes/findings/pi-harness-channels.md`, pinned against pi 0.73.1 +
 * session format v3): tailing the session file is deliberately the CHOSEN
 * channel for `--watch`, not just what was easiest to reuse. `--mode json`'s
 * STDOUT event vocabulary would be lower-latency but it is unversioned, would
 * fork a second parser away from pi-remote's `session-pool.ts` reference walk
 * this classifier mirrors, and the vocabulary-drift risk that already bit
 * `do --watch` once applies MORE to it than to the versioned+migrated session
 * file. Revisit only if pi's session format changes.
 *
 * A session-log record is `{"type":"message", "message":{role, content[]}}` (or a
 * `session`/`model_change`/`thinking_level_change` preamble record). The earlier
 * classifier matched the STREAM vocabulary (`tool_start`/`message_end`/`agent_end`),
 * none of which occur in the session log — so every line fell through to skip and
 * `do --watch` was silently a no-op. This module tails the growing session log and
 * surfaces the same high-signal level `ar-run.sh --watch` gave, read off the
 * SESSION-LOG shape:
 *
 *   - an `assistant` `message` → its `content[]` `text` parts, then
 *     `▶ <name> <detail>` (cyan) per `content[]` `toolCall` part, where
 *     `<detail>` is the high-signal argument for that tool (a `read`'s path, a
 *     `bash`'s command, …), truncated to 64 chars with a trailing `…`;
 *   - `✓ agent finished` (green) on PROCESS EXIT — the session log has no
 *     `agent_end` event, so the tailer emits it once on `stop()`;
 *   - everything else (`session`/`model_change`/user messages/tool results/…) →
 *     skipped.
 *
 * The classifier mirrors pi-remote's `session-pool.ts` reference parser (`type` →
 * `role` → `content[]` block walk over `thinking`/`text`/`toolCall`, incl.
 * `tc.name||tc.toolName` and content-as-string). The JSONL is parsed in TS (NO
 * `jq` — that bash dependency is part of what `do` replaces). It is a PURE
 * OBSERVER: it only READS the log; it never changes the run's outcome, gate,
 * integration, git, or exit code. Colour is honoured ONLY on a TTY / when
 * `NO_COLOR` is unset (the same rule as `output.ts`), threaded in by the caller
 * as a boolean.
 */

// The same conventional ANSI codes `ar-run.sh`'s jq filter emitted (cyan tool
// marker, green finished marker, reset). Colour is applied ONLY when the caller
// passes `color: true` (its TTY/NO_COLOR decision); plain otherwise.
const CYAN = '\u001b[36m';
const GREEN = '\u001b[32m';
const RESET = '\u001b[0m';

/** Wrap `text` in `code` + reset when `color`, else return it unchanged. */
function paint(text: string, color: boolean, code: string): string {
	return color ? `${code}${text}${RESET}` : text;
}

/**
 * The max width of a tool-call DETAIL string (the `read <path>` / `bash <cmd>`
 * argument summary appended after the tool name). A longer detail is truncated
 * to this many characters with a trailing `…`, so a giant `bash` heredoc or a
 * long path never floods the live view with one enormous line.
 */
const MAX_DETAIL_LENGTH = 64;

/** Truncate `text` to {@link MAX_DETAIL_LENGTH} chars, appending `…` when cut. */
function truncateDetail(text: string): string {
	// Collapse any embedded newlines/tabs to single spaces first: a multi-line
	// `bash` command must stay ONE line in the tail view.
	const oneLine = text.replace(/\s+/g, ' ').trim();
	if (oneLine.length <= MAX_DETAIL_LENGTH) {
		return oneLine;
	}
	return `${oneLine.slice(0, MAX_DETAIL_LENGTH)}…`;
}

/**
 * The FIRST non-empty string among `keys` in a tool-call's arguments object, or
 * `undefined` when the args are absent / none of the keys carry a string. The
 * args live under `arguments` (pi's canonical key) OR `args` (the variant seen
 * in some session records), mirroring the `name || toolName` defensiveness used
 * for the tool name itself.
 */
function firstArgString(
	part: Record<string, unknown>,
	keys: readonly string[],
): string | undefined {
	const rawArgs =
		(typeof part.arguments === 'object' && part.arguments) ||
		(typeof part.args === 'object' && part.args) ||
		undefined;
	if (!rawArgs || rawArgs === null) {
		return undefined;
	}
	const args = rawArgs as Record<string, unknown>;
	for (const key of keys) {
		const value = args[key];
		if (typeof value === 'string' && value !== '') {
			return value;
		}
	}
	return undefined;
}

/**
 * The high-signal ARGUMENT to show after a tool name, chosen per tool so the
 * `▶ <name>` marker reads like the agent's actual action (`▶ read work/x.md`,
 * `▶ bash pnpm -r build`). The mapping mirrors this harness's own tool set
 * (read/edit/write/grep/find/ls take a `path`; bash a `command`; grep a
 * `pattern`; find/ls a `pattern`/`path`); any unmapped tool falls back to a
 * generic `path`/`command`/`pattern`/`query` probe so a new tool still shows
 * *something* useful. Returns `''` when no informative arg is present.
 */
function toolCallDetail(name: string, part: Record<string, unknown>): string {
	const byTool: Record<string, readonly string[]> = {
		read: ['path'],
		edit: ['path'],
		write: ['path'],
		ls: ['path'],
		find: ['pattern', 'path'],
		grep: ['pattern', 'path'],
		bash: ['command'],
	};
	const keys = byTool[name] ?? ['path', 'command', 'pattern', 'query', 'file'];
	const detail = firstArgString(part, keys);
	return detail === undefined ? '' : truncateDetail(detail);
}

/**
 * A structural view of the pi SESSION-LOG records we classify. It mirrors the
 * `@earendil-works/pi-coding-agent` `SessionEntry` / `SessionMessageEntry`
 * shapes (`type:"message"` with a nested `message.role` + `message.content`) but
 * is declared locally so the observer needs no runtime dependency on that
 * package's (heavy) type tree — dorfl does not otherwise depend on it.
 * The content blocks are read defensively (like pi-remote's reference parser,
 * which casts them via `as any`): a content part may be a `text`, a `thinking`,
 * or a `toolCall` (whose name is `name` OR `toolName`), or the whole content may
 * be a plain string.
 */
interface SessionLogRecord {
	type?: unknown;
	message?: {
		role?: unknown;
		content?: unknown;
		/** The Anthropic-API turn-termination reason (mirrored by pi into the session log). */
		stop_reason?: unknown;
		/** The turn's token usage (mirrored by pi). `output` OR `output_tokens` is the produced-token count. */
		usage?: unknown;
	};
}

/** The green `✓ agent finished` line, emitted on PROCESS EXIT (not a log event). */
export function finishedLine(color: boolean): string {
	return paint('✓ agent finished', color, GREEN);
}

/**
 * A one-line VISUAL BOUNDARY banner the caller prints between two tailed agent
 * streams (e.g. the build stream and the Gate-2 review stream — task
 * `watch-review-session`), so a watching human knows the first stream ended and
 * the next began. Reuses this module's colour rule (cyan, the same marker hue as
 * the `▶ <tool>` lines) so it reads as part of the same live view. Pure: returns
 * the string; the caller routes it to the watch sink.
 */
export function boundaryLine(label: string, color: boolean): string {
	return paint(`▶ ${label}`, color, CYAN);
}

/**
 * Parse ONE pi SESSION-LOG `.jsonl` line and return the high-signal lines to
 * surface — or `[]` to SKIP it. This is the pure, unit-testable classifier,
 * mirroring pi-remote's `session-pool.ts` block walk:
 *
 *   - a `{type:"message", message:{role:"assistant", content}}` record → for each
 *     `content[]` part: a `text` part yields its text (parts concatenated into
 *     ONE line, like the old `jq` `.content[]` select); a `toolCall` part yields
 *     `▶ <name> <detail>` (cyan; `name` OR `toolName`, defaulting to `tool`;
 *     `<detail>` is the per-tool argument summary, truncated to 64 chars with a
 *     `…`); a `thinking` part (and anything else) is skipped. A plain-string
 *     `content` yields one text line.
 *   - everything else (`session`/`model_change`/`thinking_level_change`, user
 *     messages, tool results, blank/malformed lines) → `[]` (skipped).
 *
 * "Finished" is NOT a record here — the session log has no `agent_end`; the
 * tailer emits {@link finishedLine} on process exit instead.
 *
 * Malformed JSON is skipped (not thrown): a partially-written trailing line in a
 * growing log must not crash the observer.
 */
export function formatWatchEvent(line: string, color: boolean): string[] {
	const trimmed = line.trim();
	if (trimmed === '') {
		return [];
	}
	let event: unknown;
	try {
		event = JSON.parse(trimmed);
	} catch {
		// A half-written trailing line in a growing log — skip, never throw.
		return [];
	}
	if (typeof event !== 'object' || event === null) {
		return [];
	}
	const record = event as SessionLogRecord;
	if (record.type !== 'message') {
		return [];
	}
	const message = record.message;
	if (!message || message.role !== 'assistant') {
		// Skip user turns, tool results, and any non-assistant message.
		return [];
	}
	return assistantLines(message.content, color);
}

/**
 * Walk an assistant `message.content` into the lines to surface, mirroring
 * pi-remote's `session-pool.ts` reference parser. The `text` parts are
 * concatenated into a SINGLE leading line (so a multi-part assistant turn reads
 * as one sentence, as `ar-run.sh --watch` showed it); each `toolCall` part adds a
 * `▶ <name> <detail>` line after it (`<detail>` = the tool's high-signal
 * argument, truncated to 64 chars). A plain-string content yields the single
 * text line.
 * `thinking` parts and any other block type are skipped.
 */
function assistantLines(content: unknown, color: boolean): string[] {
	if (typeof content === 'string') {
		return content === '' ? [] : [content];
	}
	if (!Array.isArray(content)) {
		return [];
	}
	const lines: string[] = [];
	const text = assistantContentText(content);
	for (const part of content) {
		if (typeof part !== 'object' || part === null) {
			continue;
		}
		const p = part as Record<string, unknown>;
		if (p.type === 'toolCall') {
			const name =
				(typeof p.name === 'string' && p.name !== '' && p.name) ||
				(typeof p.toolName === 'string' && p.toolName !== '' && p.toolName) ||
				'tool';
			const detail = toolCallDetail(name, p);
			const label = detail === '' ? name : `${name} ${detail}`;
			lines.push(paint(`▶ ${label}`, color, CYAN));
		}
		// `text` is collected by assistantContentText; `thinking` and any other
		// block type are skipped.
	}
	return text === '' ? lines : [text, ...lines];
}

/**
 * Concatenate the `text` parts of ONE assistant `message.content` (the answer
 * text, with tool/thinking blocks dropped) — the single source of truth for
 * "what did the assistant SAY" shared by the {@link assistantLines} watch view
 * and the {@link lastAssistantText} output reader (task `harness-agent-output`).
 * A plain-string content is itself the text. Returns `''` when there is no text.
 */
function assistantContentText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	const textParts: string[] = [];
	for (const part of content) {
		if (typeof part !== 'object' || part === null) {
			continue;
		}
		const p = part as Record<string, unknown>;
		if (p.type === 'text' && typeof p.text === 'string') {
			textParts.push(p.text);
		}
	}
	return textParts.join('');
}

/**
 * Extract the **last assistant message's text** from a pi session `.jsonl`
 * (task `harness-agent-output`) — the agent's final ANSWER, surfaced through
 * the harness seam as `LaunchResult.output`. A thin delegate to
 * {@link lastAssistantTurn} (one walk, returning the `.text`); the turn reader
 * ALSO carries the `stop_reason`/`usage` the pi adapter uses for the
 * `LaunchResult.outputCapped` cap-truncation signal.
 *
 * Kept as a PURE `string → string | undefined` function on purpose: the pi
 * adapter reads the session file and passes the JSONL text in, but a future
 * stream/HTTP-shaped harness (opencode-style) can accumulate its own event
 * stream into the same JSONL-shaped text and reuse this reader unchanged — the
 * file shape does NOT leak through the `LaunchResult.output` seam (Option C).
 * See `work/notes/findings/pi-harness-channels.md` (task `pi-harness-polish`).
 *
 * Returns `undefined` when the log has no assistant text at all — an absent log,
 * a malformed/short log, or a run whose only assistant turn was tool-calls (no
 * `text` part). A tool-only assistant turn is NOT a final answer, so a LATER
 * text turn (if any) wins; with no text turn anywhere the result is `undefined`.
 *
 * Malformed/blank lines are skipped (never thrown): a partially-written trailing
 * line in a just-closed log must not crash the reader.
 */
export function lastAssistantText(jsonl: string): string | undefined {
	return lastAssistantTurn(jsonl).text;
}

/**
 * The last assistant turn's TEXT + its Anthropic-API turn-termination signal
 * (`stop_reason` + `usage.output`/`usage.output_tokens` token count). Reused by
 * the pi adapter to populate BOTH `LaunchResult.output` (the `.text`) AND
 * `LaunchResult.outputCapped` (the cap-truncation signal — see
 * {@link isOutputCappedTurn}). One walk over the `.jsonl`, not two. `text` is the
 * LAST assistant turn carrying non-empty text (a tool-only turn does not
 * supersede it); `stopReason`/`outputTokens` come from THAT same last-text turn when
 * the record carries them, else `undefined`. Returns an all-`undefined` object
 * for an empty / assistant-text-less log.
 */
export interface LastAssistantTurn {
	/** The last assistant turn's concatenated `text` parts (its answer). */
	text?: string;
	/** The turn's `stop_reason` (raw — `null`, `'end_turn'`, `'max_tokens'`, …). */
	stopReason?: string | null;
	/** The turn's produced output-token count (`usage.output` OR `usage.output_tokens`). */
	outputTokens?: number;
}

export function lastAssistantTurn(jsonl: string): LastAssistantTurn {
	let lastText: string | undefined;
	let lastStopReason: string | null | undefined = undefined;
	let lastOutputTokens: number | undefined = undefined;
	for (const line of jsonl.split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') {
			continue;
		}
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue; // a half-written / malformed line — skip, never throw.
		}
		if (typeof event !== 'object' || event === null) {
			continue;
		}
		const record = event as SessionLogRecord;
		if (record.type !== 'message') {
			continue;
		}
		const message = record.message;
		if (!message || message.role !== 'assistant') {
			continue;
		}
		const text = assistantContentText(message.content);
		if (text !== '') {
			lastText = text; // a later text turn supersedes an earlier one.
			lastStopReason = readStopReason(message.stop_reason);
			lastOutputTokens = readOutputTokens(message.usage);
		}
	}
	return {
		text: lastText,
		stopReason: lastStopReason,
		outputTokens: lastOutputTokens,
	};
}

/**
 * Is this assistant turn's signal an OUTPUT-CAP truncation — the turn did NOT
 * end naturally? `stop_reason` `null`/`None`/`undefined` (the turn was cut off) OR
 * `'max_tokens'` (the model hit its output-token cap), together with a positive
 * produced-token count. The `null`/`None` form is what pi's session log records
 * when the `--print` run is truncated before the turn closes (observation
 * `tasker-review-edits-payload-caps-the-verdict-response`); `'max_tokens'` is the
 * standard API cap signal. Both name the same structural cause: the verdict never
 * finished.
 */
export function isOutputCappedTurn(turn: LastAssistantTurn): boolean {
	const cappedReason =
		turn.stopReason === null ||
		turn.stopReason === undefined ||
		turn.stopReason === 'None' ||
		turn.stopReason === 'max_tokens';
	return cappedReason && (turn.outputTokens ?? 0) > 0;
}

/** Read `stop_reason` defensively as a string-or-null (pi may emit `None`/`null`). */
function readStopReason(raw: unknown): string | null | undefined {
	if (raw === null) {
		return null;
	}
	if (typeof raw === 'string') {
		return raw;
	}
	return undefined;
}

/** Read the produced output-token count from `usage.output` OR `usage.output_tokens`. */
function readOutputTokens(raw: unknown): number | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const usage = raw as Record<string, unknown>;
	const value = usage.output ?? usage.output_tokens;
	return typeof value === 'number' ? value : undefined;
}

export interface SessionTailerOptions {
	/**
	 * The EXACT pi session `.jsonl` file path to tail. The caller generated this
	 * BEFORE pi launched (`--session <path>`, task `session-path-pi-default`) and
	 * passed the SAME path to the adapter, so the tailer reads the run's own log
	 * — no newest-by-mtime dir guessing, no stale-sibling race. The file does NOT
	 * yet exist when the tailer starts (pi creates it asynchronously after spawn);
	 * the tailer polls until it appears (ENOENT is tolerated as "not yet").
	 */
	sessionFile: string;
	/** Emit ANSI colour (the caller's TTY/`NO_COLOR` decision). */
	color: boolean;
	/** Where formatted high-signal lines are written (defaults to stderr). */
	sink?: (line: string) => void;
	/** How often (ms) to poll for new bytes / the log's appearance. */
	pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 100;

/**
 * A concurrent, READ-ONLY tail of the pi session `.jsonl`. It polls the KNOWN
 * session-file path (which the pi adapter creates only once pi starts) until it
 * appears, then reads newly-appended bytes, splits them into complete lines, and
 * surfaces each via {@link formatWatchEvent}. A partial trailing line is
 * buffered until its newline arrives, so an event split across two reads is
 * never mis-parsed.
 *
 * It is a pure observer: nothing it does feeds back into the run. `start()`
 * begins polling; `stop()` performs one final drain (to catch events written
 * just before the agent exited), emits the `✓ agent finished` line ONCE (the
 * session log has no `agent_end` — process exit IS the finish signal), and
 * releases the file handle. Created and driven by `do --watch` ALONGSIDE the
 * (async) agent launch; `stop()` runs when that launch returns (i.e. the agent
 * process exited).
 */
export class SessionTailer {
	private readonly sessionFile: string;
	private readonly color: boolean;
	private readonly sink: (line: string) => void;
	private readonly pollIntervalMs: number;

	private handle: FileHandle | undefined;
	private offset = 0;
	private pending = '';
	private timer: NodeJS.Timeout | undefined;
	private polling = false;
	private stopped = false;
	private finishedEmitted = false;

	constructor(options: SessionTailerOptions) {
		this.sessionFile = options.sessionFile;
		this.color = options.color;
		this.sink = options.sink ?? ((line) => process.stderr.write(`${line}\n`));
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	}

	/** Begin polling for the known session file and tailing its new bytes. */
	start(): void {
		if (this.timer !== undefined || this.stopped) {
			return;
		}
		this.timer = setInterval(() => {
			void this.poll();
		}, this.pollIntervalMs);
		// `unref` so an orphaned timer never keeps the process alive past the run.
		this.timer.unref?.();
	}

	/**
	 * Stop tailing: one final drain (events written right before the agent exited
	 * must still be surfaced), emit the `✓ agent finished` line ONCE (process exit
	 * is the finish signal — the session log carries no `agent_end`), then release
	 * the handle. Idempotent: a second `stop()` re-emits nothing.
	 */
	async stop(): Promise<void> {
		const wasStopped = this.stopped;
		this.stopped = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		if (!wasStopped) {
			await this.drain();
		}
		if (this.handle !== undefined) {
			await this.handle.close();
			this.handle = undefined;
		}
		if (!this.finishedEmitted) {
			this.finishedEmitted = true;
			this.sink(finishedLine(this.color));
		}
	}

	/** One poll tick: ensure the handle is open, then drain new bytes. */
	private async poll(): Promise<void> {
		if (this.polling) {
			return; // a slow read must not overlap the next tick.
		}
		this.polling = true;
		try {
			await this.drain();
		} catch {
			// A transient read error (the log being rotated/created) — try next tick.
		} finally {
			this.polling = false;
		}
	}

	/** Open the log if not yet open, read appended bytes, surface whole lines. */
	private async drain(): Promise<void> {
		if (this.handle === undefined) {
			// Open the KNOWN path. pi creates it ASYNCHRONOUSLY after spawn, so until
			// it exists `open` throws ENOENT — treat that as "not yet" and retry next
			// tick (NEVER open once at start(), which would race the file into being).
			try {
				this.handle = await open(this.sessionFile, 'r');
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
					return; // file not written yet — wait for it.
				}
				throw err; // a real error — bubble to poll's try/catch (next-tick retry).
			}
		}
		const stats = await this.handle.stat();
		if (stats.size <= this.offset) {
			return; // no new bytes.
		}
		const length = stats.size - this.offset;
		const buffer = Buffer.alloc(length);
		const {bytesRead} = await this.handle.read(buffer, 0, length, this.offset);
		this.offset += bytesRead;
		this.pending += buffer.toString('utf8', 0, bytesRead);
		this.flushLines();
	}

	/** Split the buffer on newlines, surfacing each COMPLETE line; keep the rest. */
	private flushLines(): void {
		let newlineIndex = this.pending.indexOf('\n');
		while (newlineIndex !== -1) {
			const line = this.pending.slice(0, newlineIndex);
			this.pending = this.pending.slice(newlineIndex + 1);
			// A single record may surface MULTIPLE lines (assistant text + each of
			// its tool starts), or none (skipped record types).
			for (const formatted of formatWatchEvent(line, this.color)) {
				this.sink(formatted);
			}
			newlineIndex = this.pending.indexOf('\n');
		}
	}
}
