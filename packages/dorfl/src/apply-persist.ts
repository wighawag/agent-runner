import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {run, type RunResult} from './git.js';
import {setFrontmatterMarker} from './frontmatter.js';
import {applyAtomic, type ApplyAtomicResult} from './sidecar-apply.js';
import {
	allAnswered,
	appendQuestions,
	parseSidecar,
	resolveSidecarIdentity,
	sidecarPathFor,
	type NewQuestion,
	type SidecarEntry,
	type SidecarModel,
	type SidecarType,
} from './sidecar.js';
import {
	APPLY_LIFECYCLE_FOLDERS,
	resolveItemPathByIdentity,
} from './item-path.js';
import {workItemRel} from './work-layout.js';

/**
 * The engine-owned APPLY PERSIST (spec `advance-loop`, task `advance-rung-apply`;
 * AGENTIC apply, task `agentic-apply-retire-disposition-vocabulary`) — the half of
 * the APPLY rung the ENGINE owns. On `classify=apply` (ALL sidecar entries
 * answered), it applies the HUMAN's answers to the item ATOMICALLY (item body +
 * sidecar in ONE commit, via the sidecar contract's {@link applyAtomic}), then
 * EITHER:
 *
 *   - **append / re-pause** — when the apply has NEW questions to ask: append
 *     `qN+1…`, stay `needsAnswers:true`, re-pause (the "all answered?" flips back
 *     to false); OR
 *   - **dispose** — when the caller decided the SOURCE should be DISPOSED
 *     (`dispose` set): REGIME-POLYMORPHIC on the source's type (task
 *     `apply-disposition-delete-to-dispose-regime-polymorphic`, spec
 *     `surface-stuck-as-questions-and-retire-stuck-lock-state` decision #5):
 *     an OBSERVATION is `git rm`-ed with its sidecar in one revertible commit
 *     (reason in the message, git history = archive); a TASK is `git mv`-ed to
 *     `tasks/cancelled/` (RETAINED, `reason:` written into the moved body); a
 *     SPEC is `git mv`-ed to `specs/dropped/` (RETAINED). A task can NEVER be
 *     hard-deleted from here — dispose is the only path off the board; OR
 *   - **resolve fully** (the default) — clear `needsAnswers` + DELETE the sidecar
 *     in the SAME atomic commit (the invariant `needsAnswers:false ⟺ no active
 *     sidecar`); the item advances toward build by its normal lifecycle. For an
 *     OBSERVATION this ALSO stamps the `triaged:` settled marker (see
 *     {@link TRIAGED_RESOLVE}) in that same commit — the note is KEPT, so it needs
 *     a durable record that its triage question-loop is CLOSED or the triage rung
 *     re-asks it forever (ADR `resolve-settles-the-question-loop-not-the-note`).
 *
 * **The disposition vocabulary is GONE** (task
 * `agentic-apply-retire-disposition-vocabulary`): the apply rung no longer reads a
 * per-entry `disposition=` token and no longer runs a most-decisive picker. A
 * sidecar entry is BINARY (no-answer | answered); what to DO with a fully-answered
 * OBSERVATION is decided by the AGENTIC apply decision in the advance tick
 * (`advance.ts` `applyRung` over the shared `decide` engine), which then routes
 * here (re-pause / dispose / resolve / via `promoteObservation` for a mint).
 *
 * What the retirement removed was the human-stamped `disposition=`/`promote-*`
 * TOKEN vocabulary, NOT the settled AXIS: a note that the `resolve` verdict KEEPS
 * still rests as `triaged: resolve` + `needsAnswers:false` + no sidecar. That is
 * the one resting state a note has, and it says "the question-loop is settled",
 * NOT "the signal is finished" (a finished signal is `dispose`d — it leaves the
 * inbox by deletion).
 *
 * The work-item (task/spec) terminal MOVES (`tasks/cancelled`, `specs/dropped`) and
 * the stuck (lock `state: stuck`) LIFECYCLE state are a SEPARATE lifecycle concern (a
 * task/spec is dropped by its own lifecycle, not by a question answer) — they are
 * NOT routed from here any more (they were the removed disposition vocabulary).
 *
 * It is the SIBLING of {@link import('./surface-persist.js').persistSurfacedQuestions}:
 * that is the SURFACE rung's one-commit primitive (append-or-create + set
 * `needsAnswers`); this is the APPLY rung's (apply answers + resolve / re-pause /
 * dispose). Kept file-orthogonal so the rung bodies land in different tasks.
 *
 * **NEVER invents an answer (US #4).** The apply rung applies ONLY what the human
 * authored — the recorded `answer:` text. It does NOT fill, guess, or author an
 * answer; a SUBSET-answered sidecar is not even classified `apply` (the classifier
 * NO-OPs), so this is only ever called with a fully-answered sidecar. **ALWAYS
 * allowed (no gate)** — applying a human's answer is never gated, even with every
 * autonomy flag off (the engine, not this module, enforces the no-gate
 * sequencing).
 *
 * Like the surface persist, this is the LOCAL one-commit primitive over a working
 * tree (the throwaway-git-repo test pattern). The `advancing` CAS lock that makes
 * it WINNER-ONLY is held by `performAdvance` BEFORE this is called; this module
 * does NOT race the arbiter — that is the lock's job.
 */

// Re-export the extracted neutral resolver so existing importers of
// `apply-persist.ts` keep working (the resolver now LIVES in `item-path.ts`, a
// non-hot module the sibling CLI / gc-sweep tasks import without touching this
// rewritten file).
export {APPLY_LIFECYCLE_FOLDERS, resolveItemPathByIdentity};

/** Marker that opens the applied-answers record in an item body. */
const APPLIED_HEADING = '## Applied answers';

/**
 * The `triaged:` settled-marker VALUE the resolve-fully path stamps on a KEPT
 * OBSERVATION (ADR `resolve-settles-the-question-loop-not-the-note`).
 *
 * The `resolve` verdict is the ONE apply terminal that RETAINS an observation in
 * the inbox. Every other terminal removes it from the triage pool by MOVING or
 * DELETING the file (mint → `git rm` + the new artifact; dispose → `git rm` /
 * terminal folder), so only this one needs an in-file record that the note has
 * been through triage. Without it the resolved note is byte-indistinguishable, to
 * the classifier's two signals (`needsAnswers` + sidecar), from a note that was
 * NEVER triaged: `needsAnswers:false` + no sidecar ⇒ ANALYSE ⇒ `triage-observation`
 * ⇒ the engine-built triage question is surfaced AGAIN, and the human is asked
 * something they already answered (observed live in the `rocketh` consumer repo:
 * surface → answer → resolve → the byte-identical question re-surfaced).
 *
 * The marker is the axis the READ side already models end-to-end — `frontmatter.ts`
 * parses it, `ledger-read.ts` carries it, `lifecycle-pools.ts` drops a marked
 * observation out of the CREATE-side triage pool, and `advance.ts`'s triage rung
 * no-ops on it for an explicit `obs:<slug>`. Only the WRITER was missing.
 *
 * It does NOT strand a later answer: an ANSWERED sidecar dominates the marker (ADR
 * `answered-observation-sidecar-dominates-triaged-marker`), so a genuinely NEW
 * question about a settled note still routes to apply and is still answerable.
 */
export const TRIAGED_RESOLVE = 'resolve';

/**
 * The STRUCTURAL fence the templates wrap the transient open-questions block in
 * — an HTML-comment marker pair, mirroring the existing `<!-- dorfl-…
 * -->` style in `sidecar.ts`. Apply's reconcile (full-resolution route only)
 * strips everything between the OPEN and CLOSE markers (inclusive) when it folds
 * answers in and clears `needsAnswers`, so the resolved item body reads as
 * resolved (no leftover "these are still open" prose above `## Applied answers`).
 *
 * The strip is STRUCTURAL (marker-pair based), NOT a heading-text regex — the
 * spec's D1 decision: a `## Open questions` heading match would be fragile to
 * author wording (`## Open questions (clear needsAnswers when resolved)` vs.
 * `## Open questions`). Items authored WITHOUT the markers are left untouched
 * (backward compat — no marker ⇒ nothing to strip ⇒ identical bytes).
 *
 * The sibling task `templates-mark-transient-open-questions-block` introduces
 * the markers in the spec/task templates; this task exports the constants so
 * the two tasks agree on the literal byte sequence.
 */
export const OPEN_QUESTIONS_MARKER_OPEN = '<!-- open-questions -->';
export const OPEN_QUESTIONS_MARKER_CLOSE = '<!-- /open-questions -->';

/**
 * Does this item body carry the ENGINE-WRITTEN applied-answers record?
 *
 * Only {@link applyAnsweredQuestions} writes this heading, and only after a human
 * answered EVERY open question on the item, so its presence is PROOF the engine
 * has applied a human's answers here — not a prose heuristic. The triage rung uses
 * it as the legacy back-fill trigger for notes resolved-and-kept before the
 * `triaged:` stamp existed (ADR `resolve-settles-the-question-loop-not-the-note`).
 */
export function hasAppliedAnswersRecord(body: string): boolean {
	return new RegExp(`^${APPLIED_HEADING}\\b`, 'm').test(
		body.replace(/\r\n/g, '\n'),
	);
}

export interface ApplyAnsweredQuestionsOptions {
	/** Working clone/worktree the apply commits in. */
	cwd: string;
	/** The namespaced item identity (`task:foo` / `spec:bar` / `observation:baz`). */
	item: string;
	/**
	 * The item file path RELATIVE to `cwd` (e.g. `work/backlog/foo.md`). The
	 * sidecar path is derived from the identity, NOT from this path (identity-keyed,
	 * folder-agnostic). The apply rewrites THIS file + the sidecar and commits them
	 * together.
	 */
	itemPath: string;
	/**
	 * NEW follow-up questions the apply has (the agentic `ask-follow-up` verdict, or
	 * a caller-supplied batch). When non-empty, the apply APPENDS them (`qN+1…`,
	 * never mutating an answered entry) and RE-PAUSES (`needsAnswers:true` stays) —
	 * the "all answered?" flips back to false. Empty/omitted ⇒ resolve the item (or
	 * dispose it, when `dispose` is set).
	 */
	appendQuestions?: NewQuestion[];
	/**
	 * DISPOSE the SOURCE (the agentic `dispose` verdict, or a direct disposal):
	 * REGIME-POLYMORPHIC on the source's type (task
	 * `apply-disposition-delete-to-dispose-regime-polymorphic`, spec
	 * `surface-stuck-as-questions-and-retire-stuck-lock-state` decision #5):
	 *   - OBSERVATION → `git rm` the source + its answered sidecar in a STANDALONE
	 *     revertible commit, the `reason` recorded in the commit message (git
	 *     history is the archive; notes leave by deletion, decision 12);
	 *   - TASK → `git mv` the source to the task regime's won't-proceed terminal
	 *     `tasks/cancelled/` (RETAINED, `reason:` written into the moved body's
	 *     frontmatter); the sidecar is `git rm`-ed in the same commit;
	 *   - SPEC → `git mv` the source to `specs/dropped/` (RETAINED); sidecar
	 *     `git rm`-ed in the same commit.
	 * A TASK can NEVER be hard-deleted through this option — dispose is the only
	 * path off the board, true by construction (there is no `delete: true` escape
	 * hatch here). Fires DIRECT (no preview/confirm — decision 12). Mutually
	 * exclusive with `appendQuestions` (re-pause and dispose cannot both happen on
	 * one apply); when both are given the re-pause wins (you cannot dispose a
	 * source you are still asking about).
	 */
	dispose?: {reason: string};
	/** Advisory committer id for the commit subject. Defaults to git user.name. */
	by?: string;
	/** Environment for child git processes. */
	env?: NodeJS.ProcessEnv;
	/** Sink for human-readable progress notes. */
	note?: (message: string) => void;
}

/** The terminal an apply reached. */
export type ApplyTerminal =
	/** Resolved fully: needsAnswers cleared + sidecar deleted (the default). */
	| 'resolved'
	/** New questions appended; stayed needsAnswers:true and re-paused. */
	| 'repaused'
	/**
	 * The SOURCE (an OBSERVATION) was disposed BY DELETION (the agentic `dispose`
	 * verdict on an observation, or a direct disposal): the source (+ its answered
	 * sidecar) were `git rm`-ed in a STANDALONE revertible commit, the reason in
	 * the commit message (git history = archive). Notes leave by being GONE —
	 * there is no resting marker. This is the apply rung applying the human's
	 * RATIFIED answer (human-authored, not a unilateral agent destruction of a
	 * live signal). Preserved verbatim as `'deleted'` for observation disposals;
	 * see {@link ApplyTerminal | 'disposed'} for the task/spec branches.
	 */
	| 'deleted'
	/**
	 * The SOURCE (a TASK or SPEC) was DISPOSED to its regime's won't-proceed
	 * terminal (task `apply-disposition-delete-to-dispose-regime-polymorphic`,
	 * spec `surface-stuck-as-questions-and-retire-stuck-lock-state` decision #5):
	 * a task `git mv`-ed to `tasks/cancelled/`, a spec `git mv`-ed to
	 * `specs/dropped/`. The file is RETAINED (git history + terminal folder is
	 * the archive), with the human's `reason:` written into the moved body's
	 * frontmatter and the answered sidecar `git rm`-ed in the same commit.
	 */
	| 'disposed'
	/**
	 * The item file was GONE by the time apply tried to write (a concurrent
	 * promote/terminal-move/delete between capture and write). Apply exited
	 * CLEAN: no commit, no ghost file at the stale path. The matching benign
	 * skip the surface/triage rungs already use (`advance.ts` `vanishedSkip`),
	 * extended into the apply rung by the F3a folder-agnostic resolver.
	 */
	| 'vanished';

export interface ApplyAnsweredQuestionsResult {
	/** The terminal the apply reached. */
	outcome: ApplyTerminal;
	/** The commit sha the apply produced. */
	commit?: string;
	/** The sidecar path (relative to `cwd`) the apply touched. */
	sidecarPath: string;
	/** The item path (relative to `cwd`) after the apply. */
	itemPath: string;
	/** A human-readable summary. */
	message: string;
}

/** Raised for usage errors (a missing repo, an unreadable item, a subset apply). */
export class ApplyPersistError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ApplyPersistError';
	}
}

function gitSoft(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): RunResult {
	return run('git', args, cwd, {env});
}

function gitHard(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): RunResult {
	const result = run('git', args, cwd, {env});
	if (result.status !== 0) {
		throw new ApplyPersistError(
			`git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr.trim()}`,
		);
	}
	return result;
}

function resolveBy(cwd: string, env: NodeJS.ProcessEnv | undefined): string {
	const name = gitSoft(['config', 'user.name'], cwd, env);
	if (name.status === 0 && name.stdout.trim() !== '') {
		return name.stdout.trim();
	}
	const e = env ?? process.env;
	return e.USER ?? e.USERNAME ?? '';
}

/** Read the item body from the tree (committed) then the working-tree file. */
function readItem(
	itemAbs: string,
	cwd: string,
	itemPath: string,
	env: NodeJS.ProcessEnv | undefined,
): string {
	const show = gitSoft(['show', `:${itemPath}`], cwd, env);
	if (show.status === 0) {
		return show.stdout;
	}
	try {
		return readFileSync(itemAbs, 'utf8');
	} catch {
		throw new ApplyPersistError(
			`cannot read item body for '${itemPath}' (the apply rung needs the item file)`,
		);
	}
}

/** Read + parse the existing sidecar (from the working file). */
function readSidecar(
	cwd: string,
	item: string,
): {model: SidecarModel; path: string} {
	const path = sidecarPathFor(item);
	const abs = join(cwd, path);
	if (!existsSync(abs)) {
		throw new ApplyPersistError(
			`no sidecar at ${path} for ${item} — the apply rung needs an answered sidecar`,
		);
	}
	return {model: parseSidecar(readFileSync(abs, 'utf8')), path};
}

/**
 * Render the applied-answers record appended to the item body. PURELY the human's
 * recorded answers (verbatim) under a dated heading — NEVER an invented or
 * paraphrased answer. Append-only (a prior record stays); the body is the durable
 * home of what the human decided.
 */
function appliedAnswersBlock(entries: SidecarEntry[]): string {
	const date = new Date().toISOString().slice(0, 10);
	const lines: string[] = ['', `${APPLIED_HEADING} ${date}`, ''];
	for (const entry of entries) {
		lines.push(`### ${entry.id}: ${entry.question.trim()}`);
		lines.push('');
		lines.push(entry.answer.trim());
		lines.push('');
	}
	return lines.join('\n');
}

/** Append the applied-answers record to an item body (append-only). */
function withAppliedAnswers(body: string, entries: SidecarEntry[]): string {
	const base = body.replace(/\s*$/, '');
	return `${base}\n${appliedAnswersBlock(entries)}`;
}

/**
 * Strip ALL marker-fenced open-questions blocks from an item body — the FULL
 * RESOLUTION reconcile step (spec `apply-reconciles-stale-open-questions`,
 * decisions D1 / D3). Removes each `<!-- open-questions -->` … `<!--
 * /open-questions -->` pair (markers included) plus the blank lines that
 * flanked it, so the answers in `## Applied answers` no longer sit beneath a
 * stale "these are still open" section.
 *
 * Behavioural choices (recorded in the done note):
 *   - strips EVERY well-formed marker pair, not just the first (an authoring
 *     template may legitimately fence more than one transient block — e.g.
 *     open-questions plus an autonomy-note — and partial strips would re-create
 *     the same drift the reconcile exists to prevent);
 *   - FAIL-SAFE on a malformed fence (a lone opener with no matching closer):
 *     the regex simply doesn't match, the body is returned unchanged. A
 *     fail-loud throw would block the apply commit on a template authoring bug;
 *     leaving the body intact preserves the answer-application invariant and
 *     surfaces the stale block to a human reviewer instead;
 *   - collapses runs of 3+ newlines down to 2 after a strip, so removing a
 *     block doesn't leave a triple-blank gap between the surrounding paragraphs.
 *
 * Called ONLY from the full-resolution path. The re-pause path (follow-up
 * questions appended, `needsAnswers` stays true) NEVER calls this — the
 * open-questions block is still legitimately open there (D3).
 */
function stripOpenQuestionsBlocks(body: string): string {
	const escOpen = OPEN_QUESTIONS_MARKER_OPEN.replace(
		/[.*+?^${}()|[\]\\]/g,
		'\\$&',
	);
	const escClose = OPEN_QUESTIONS_MARKER_CLOSE.replace(
		/[.*+?^${}()|[\]\\]/g,
		'\\$&',
	);
	const re = new RegExp(
		`\\n*[ \\t]*${escOpen}[\\s\\S]*?${escClose}[ \\t]*\\n*`,
		'g',
	);
	if (!re.test(body)) return body;
	return body.replace(re, '\n\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Apply a FULLY-ANSWERED sidecar's answers to its item ATOMICALLY, then route it.
 * The keystone APPLY rung the advance engine dispatches into once the classifier
 * said `apply` (all entries answered) AND the `advancing` lock was won.
 *
 * The decision (the human's recorded intent + the caller's routing — NEVER an
 * invention):
 *
 *   1. **append / re-pause** — `appendQuestions` is non-empty: append `qN+1…`,
 *      keep `needsAnswers:true`, re-pause (one commit, body + sidecar).
 *   2. **dispose** — `dispose` is set (the `dispose` verdict): REGIME-POLYMORPHIC
 *      on the source's type — an OBSERVATION is `git rm`-ed with its sidecar in
 *      a standalone revertible commit (reason in the message); a TASK is `git
 *      mv`-ed to `tasks/cancelled/` (`reason:` written into the moved body,
 *      sidecar `git rm`-ed in the same commit); a SPEC is `git mv`-ed to
 *      `specs/dropped/` (same shape as the task branch).
 *   3. **resolve fully** (the default) — clear `needsAnswers` + delete the sidecar
 *      in ONE commit; the item advances toward build by its normal lifecycle.
 */
export function applyAnsweredQuestions(
	options: ApplyAnsweredQuestionsOptions,
): ApplyAnsweredQuestionsResult {
	const {cwd, item, itemPath: capturedItemPath, env} = options;
	const note = options.note ?? (() => {});

	if (gitSoft(['rev-parse', '--git-dir'], cwd, env).status !== 0) {
		throw new ApplyPersistError('not inside a git repository');
	}

	const {model, path: sidecarPath} = readSidecar(cwd, item);

	// FOLDER-AGNOSTIC at WRITE-TIME (F3a, spec
	// `staging-surface-and-apply-promote-safety`): re-resolve the item's CURRENT
	// path by IDENTITY, mirroring the sidecar's already-folder-agnostic
	// resolution. The captured `itemPath` is ADVISORY — a concurrent `promote`
	// (`tasks/backlog → tasks/ready`, `specs/proposed → specs/ready`) may have
	// moved the item between capture and now, and we MUST write the post-move
	// path, never the stale one. If the item has vanished entirely, exit CLEAN
	// (no commit, no ghost file) — the matching benign skip the surface/triage
	// rungs already use.
	const resolvedItemPath = resolveItemPathByIdentity(cwd, item);
	if (resolvedItemPath === undefined) {
		const message =
			`apply ${item}: item file is gone (captured '${capturedItemPath}' is ` +
			`stale and no current path resolves by identity) — exiting clean (no ` +
			`commit), the apply rung does not recreate a vanished item.`;
		note(message);
		return {
			outcome: 'vanished',
			sidecarPath,
			itemPath: capturedItemPath,
			message,
		};
	}
	const itemPath = resolvedItemPath;

	// NEVER invent an answer: the apply only ever runs on a FULLY-answered sidecar
	// (the classifier NO-OPs a subset). Assert the boundary so a mis-call is loud,
	// not a silent invention of an answer for an unanswered entry.
	if (!allAnswered(model)) {
		throw new ApplyPersistError(
			`refusing to apply ${item}: the sidecar has unanswered entries — a subset ` +
				'is a classifier NO-OP, never an apply (the rung NEVER invents an answer)',
		);
	}

	const itemAbs = join(cwd, itemPath);
	const baseBody = readItem(itemAbs, cwd, itemPath, env);
	const by = options.by || resolveBy(cwd, env);

	// (1) APPEND / RE-PAUSE: the apply has new questions. Append them (`qN+1…`,
	// never mutating an answered entry), stay needsAnswers:true, re-pause. Re-pause
	// WINS over a dispose — you cannot dispose a source you are still asking
	// about.
	const followups = options.appendQuestions ?? [];
	if (followups.length > 0) {
		const repaused = appendQuestions(model, followups);
		const result: ApplyAtomicResult = applyAtomic({
			cwd,
			itemPath,
			itemBody: withAppliedAnswers(baseBody, model.entries),
			sidecar: repaused,
			mode: 'repause',
			by,
			env,
			note,
		});
		const message = `applied ${item} + appended ${followups.length} new question(s) → re-paused (needsAnswers:true).`;
		note(message);
		return {
			outcome: 'repaused',
			commit: result.commit,
			sidecarPath,
			itemPath,
			message,
		};
	}

	// (2) DISPOSE: the caller decided the source should be DISPOSED (the `dispose`
	// verdict). REGIME-POLYMORPHIC on the source type (task
	// `apply-disposition-delete-to-dispose-regime-polymorphic`, spec
	// `surface-stuck-as-questions-and-retire-stuck-lock-state` decision #5):
	//   - observation → `git rm` the note + sidecar in one revertible commit
	//     (reason in the message; notes leave by deletion, decision 12);
	//   - task → `git mv` to `tasks/cancelled/` (RETAINED; `reason:` written into
	//     the moved body; sidecar `git rm`-ed in the same commit);
	//   - spec → `git mv` to `specs/dropped/` (RETAINED, same shape).
	// DIRECT — no preview/confirm (decision 12); the human's answer is the source
	// of truth. A TASK is never `git rm`-ed here (true by construction: the
	// task-branch calls `git mv`, no branch of this dispatcher hard-deletes a
	// task).
	if (options.dispose !== undefined) {
		const {type} = resolveSidecarIdentity(item);
		if (type === 'observation') {
			return disposeObservationByDeletion({
				cwd,
				item,
				itemPath,
				reason: options.dispose.reason,
				sidecarPath,
				by,
				env,
				note,
			});
		}
		return disposeToTerminal({
			cwd,
			item,
			itemPath,
			type,
			reason: options.dispose.reason,
			sidecarPath,
			by,
			env,
			note,
		});
	}

	// (3) RESOLVE FULLY (the default): clear needsAnswers + delete the sidecar in
	// ONE commit. Full-resolution reconcile (D1): strip the now-stale marker-fenced
	// open-questions block(s) so the resolved body reads as resolved. Backward
	// compatible — no marker ⇒ identical bytes. The re-pause path above is
	// deliberately untouched (D3): its open-questions block is still open.
	const reconciledBody = stripOpenQuestionsBlocks(baseBody);
	const resolvedBody = withTriagedMarkerIfKeptNote(
		withAppliedAnswers(reconciledBody, model.entries),
		item,
	);
	const result = applyAtomic({
		cwd,
		itemPath,
		itemBody: resolvedBody,
		sidecar: model,
		mode: 'resolve',
		by,
		env,
		note,
	});
	const message = `applied ${item} → resolved (needsAnswers cleared, sidecar deleted).`;
	note(message);
	return {
		outcome: 'resolved',
		commit: result.commit,
		sidecarPath,
		itemPath,
		message,
	};
}

/**
 * Stamp the `triaged:` settled marker on a resolve-fully body — but ONLY for an
 * OBSERVATION (the one item type this path KEEPS in a re-scanned inbox).
 *
 * Structural, not caller-supplied, so it cannot be forgotten by a future caller:
 * every route that reaches the resolve-fully branch with an observation identity
 * has, by definition, just closed that note's question-loop while retaining the
 * file. A TASK/SPEC is deliberately EXCLUDED — it rests in a lifecycle FOLDER (its
 * status), is not enumerated from the observation inbox, and has no triage rung to
 * re-ask it; stamping a triage marker on one would invent a second status axis for
 * an item whose status is already the folder.
 *
 * Idempotent ({@link setFrontmatterMarker} replaces an existing key) and
 * fence-creating (observations are routinely born fence-less), so re-resolving a
 * note after a genuinely new question re-stamps rather than duplicating.
 */
function withTriagedMarkerIfKeptNote(body: string, item: string): string {
	const {type} = resolveSidecarIdentity(item);
	if (type !== 'observation') {
		return body;
	}
	return setFrontmatterMarker(body, 'triaged', TRIAGED_RESOLVE);
}

interface DisposeInput {
	cwd: string;
	item: string;
	itemPath: string;
	/** The human's dispose reason (their answer text), recorded in the commit message. */
	reason: string;
	sidecarPath: string;
	by: string;
	env: NodeJS.ProcessEnv | undefined;
	note: (m: string) => void;
}

/**
 * DISPOSE an OBSERVATION by DELETION (task
 * `apply-disposition-delete-to-dispose-regime-polymorphic`; US #5/#11): `git rm`
 * the observation-note AND its answered sidecar in ONE STANDALONE commit, the
 * human's dispose reason recorded in the commit MESSAGE (git history = archive).
 * There is no spawned artifact for a dispose-by-deletion, so the deletion is a
 * standalone commit (a `mint`, by contrast, rides the new artifact's create
 * commit through `promoteObservation`).
 *
 * A disposed observation leaves by being GONE — notes have no terminal folder
 * (decision 12: "notes leave by deletion"), unlike a task/spec which is `git
 * mv`-ed to its regime's terminal by {@link disposeToTerminal}. This is the
 * apply rung applying the human's RATIFIED answer (the deletion is
 * human-authored), and it is git-recoverable (a single revertible commit) — a
 * wrong inference is never catastrophic.
 */
function disposeObservationByDeletion(
	input: DisposeInput,
): ApplyAnsweredQuestionsResult {
	const {cwd, item, itemPath, reason, sidecarPath, by, env, note} = input;
	// `git rm` the source. The sidecar may not exist in every path; rm it too when
	// present, so the dispose leaves no answered-sidecar residue. Both ride ONE
	// commit.
	const rmPaths = [itemPath];
	if (existsSync(join(cwd, sidecarPath))) {
		rmPaths.push(sidecarPath);
	}
	gitHard(['rm', '--quiet', '--', ...rmPaths], cwd, env);
	const reasonLine = reason.trim() === '' ? '(no reason given)' : reason.trim();
	const subject = `advance: ${item} → deleted (by ${by})`;
	const messageBody =
		`Disposed by deletion (the human's ratified answer authors it; ` +
		`git history is the archive).\n\nreason: ${reasonLine}`;
	gitHard(['commit', '--quiet', '-m', subject, '-m', messageBody], cwd, env);
	const commit = gitHard(['rev-parse', 'HEAD'], cwd, env).stdout.trim();
	const message =
		`applied ${item} → deleted (source git rm-ed in a standalone commit; reason ` +
		'in the commit message, git history is the archive).';
	note(message);
	return {
		outcome: 'deleted',
		commit,
		sidecarPath,
		itemPath,
		message,
	};
}

/**
 * The per-regime WON'T-PROCEED TERMINAL folder key {@link disposeToTerminal}
 * moves a task/spec into. The folder WORDS are deliberately different
 * (`cancelled` for tasks, `dropped` for specs) so a task and spec sharing a slug
 * cannot collide on one terminal path — the two regimes have namespaced
 * terminals by design (spec `surface-stuck-as-questions-and-retire-stuck-lock-
 * state`, and see `work-layout.ts`). Do NOT rename the folders here; the token
 * that changed is the verdict outcome (`dispose`), NOT the folder words.
 */
const DISPOSE_TERMINAL_FOLDER = {
	task: 'cancelled',
	spec: 'specs-dropped',
} as const;

interface DisposeToTerminalInput extends DisposeInput {
	type: Exclude<SidecarType, 'observation'>;
}

/**
 * DISPOSE a TASK or SPEC to its regime's won't-proceed TERMINAL folder (task
 * `apply-disposition-delete-to-dispose-regime-polymorphic`, spec
 * `surface-stuck-as-questions-and-retire-stuck-lock-state` decision #5): `git
 * mv` the item to `tasks/cancelled/` (task) or `specs/dropped/` (spec), with the
 * human's dispose reason written into the moved body's `reason:` frontmatter
 * (durable, in-file archive of WHY the item won't proceed — symmetric across
 * both regimes; the source of the moved item is the human's ratified answer),
 * then `git rm` the answered sidecar, all in ONE commit.
 *
 * ## Decisions (recorded here per task etiquette)
 *
 * - **`reason:` frontmatter, symmetric across task AND spec.** The acceptance
 *   criteria explicitly require the reason for the task branch; the spec
 *   branch is only required to `git mv` to `specs/dropped/`. We nonetheless
 *   write the same `reason:` marker onto a disposed SPEC too, because (a) the
 *   two regimes are the same shape ("disposed to terminal"), so asymmetric
 *   behaviour would be a surprise; (b) the spec regime's dropped/ folder had
 *   no in-file WHY at all before, so any adjacent surface (an operator
 *   inspecting `specs/dropped/`) would otherwise have to grep the commit
 *   history for the reason. Setting it uses the same {@link
 *   setFrontmatterMarker} the surface rung already uses for `needsAnswers`.
 *   The commit message still carries the reason too (belt + braces — the
 *   frontmatter is the durable in-file record, the commit is the audit
 *   history). If a reviewer disagrees they can flip the spec branch back to a
 *   bare `git mv` in one line — the task branch is the load-bearing acceptance.
 *
 * - **The sidecar is `git rm`-ed in the same commit as the mv.** A disposed
 *   item is no longer in the question-loop (the answer settled it), so the
 *   sidecar has no reason to survive at the terminal folder. Same commit
 *   preserves the sidecar's `needsAnswers ⇔ active sidecar` invariant.
 *
 * A TASK is NEVER `git rm`-ed on this branch (that is the invariant this
 * function exists to enforce): the disposal is a `git mv` to `tasks/cancelled/`,
 * a folder-move that git can revert with a single `git revert`.
 */
function disposeToTerminal(
	input: DisposeToTerminalInput,
): ApplyAnsweredQuestionsResult {
	const {cwd, item, itemPath, type, reason, sidecarPath, by, env, note} = input;
	const {slug} = resolveSidecarIdentity(item);
	const folderKey = DISPOSE_TERMINAL_FOLDER[type];
	const terminalPath = workItemRel(folderKey, `${slug}.md`);

	// (a) Rewrite the item body with the `reason:` frontmatter marker BEFORE the
	// mv so the marker rides the same commit as the terminal move. `git mv` reads
	// the working-tree file, so a pre-mv rewrite is picked up by the subsequent
	// stage of the moved path.
	const reasonLine = reason.trim() === '' ? '(no reason given)' : reason.trim();
	const itemAbs = join(cwd, itemPath);
	const rewritten = setFrontmatterMarker(
		readFileSync(itemAbs, 'utf8'),
		'reason',
		reasonLine,
	);
	writeFileSync(itemAbs, rewritten);

	// (b) Ensure the terminal folder exists (git mv fatals on a missing parent).
	mkdirSync(dirname(join(cwd, terminalPath)), {recursive: true});

	// (c) `git mv` the source to its regime terminal.
	gitHard(['mv', '--', itemPath, terminalPath], cwd, env);

	// (d) `git rm` the answered sidecar (the loop is settled) in the same commit.
	const rmPaths: string[] = [];
	if (existsSync(join(cwd, sidecarPath))) {
		rmPaths.push(sidecarPath);
	}
	if (rmPaths.length > 0) {
		gitHard(['rm', '--quiet', '--', ...rmPaths], cwd, env);
	}

	// (e) Stage the rewritten (now-moved) body so its `reason:` marker rides the
	// same commit as the mv.
	gitHard(['add', '--', terminalPath], cwd, env);

	const subject = `advance: ${item} → disposed (by ${by})`;
	const messageBody =
		`Disposed to regime terminal '${folderKey}' (the human's ratified answer ` +
		`authors it; git history + terminal folder are the archive).\n\n` +
		`reason: ${reasonLine}`;
	gitHard(['commit', '--quiet', '-m', subject, '-m', messageBody], cwd, env);
	const commit = gitHard(['rev-parse', 'HEAD'], cwd, env).stdout.trim();
	const message =
		`applied ${item} → disposed (source git mv-ed to '${terminalPath}', ` +
		`reason: written into the moved body's frontmatter, sidecar deleted in the ` +
		`same commit).`;
	note(message);
	return {
		outcome: 'disposed',
		commit,
		sidecarPath,
		itemPath: terminalPath,
		message,
	};
}

// Re-export the heading constant the tests assert against, so the byte-level
// marker stays in one place.
export {APPLIED_HEADING};
