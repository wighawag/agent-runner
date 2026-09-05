import {
	classifyTerminalItemLocks,
	reconcileTerminalItemLocks,
	refreshMainRef,
	type TerminalLockClassification,
	type TerminalReconcileReport,
} from './item-lock.js';
import {
	classifyTerminalQuestionResidue,
	reconcileTerminalQuestionResidue,
	type TerminalQuestionReport,
	type TerminalQuestionDrainResult,
} from './needs-attention.js';

/**
 * **The ONE terminal-state reconciliation pass.**
 *
 * Two defects of the same shape motivated this, and they are deliberately fixed
 * by ONE mechanism rather than two:
 *
 *   1. **The propose-path lock leak.** `complete --propose` keeps the per-item
 *      lock held across the open PR and defers its release to the merge, so every
 *      completed item leaked its `refs/dorfl/lock/<entry>` ref and reported
 *      in-progress for ever.
 *   2. **The stranded question state.** A bounce atomically writes a sidecar plus
 *      `needsAnswers:true`; if the human disagrees, re-dispatches, and the rebuild
 *      SUCCEEDS, neither half is ever cleared. The item comes to rest in
 *      `tasks/done/` still carrying a question asking whether to CANCEL it, and a
 *      `needsAnswers` gate left armed over shipped work.
 *
 * They share a cause, a moment, and a blind spot. The cause is that both are
 * cleared by a step that only runs on a path the item did not take. The moment
 * both become moot is exactly the same one: the DONE-MOVE landing on the
 * arbiter's `main`. And the blind spot is that each is detectable only from a
 * loop the manual path never enters (`gc --ledger --reap-stale-locks` for the
 * lock, the `advance` tick's `invariant-violation` classifier for the questions),
 * while a human driving `do` and merging a PR enters neither.
 *
 * Dorfl cannot hook the merge: nobody runs a dorfl process when a human clicks
 * merge on GitHub, and there is no daemon. So the shape has to be RECONCILE
 * AGAINST `main` rather than react to the merge. The merge event is unobservable;
 * its consequence on `main` is durable, so a late pass converges just as well as
 * a timely one.
 *
 * ONE DISCRIMINATOR governs both halves: the item's POSITION on `<arbiter>/main`.
 * Not a branch, not a PR, not the holder, not age, not the flag/sidecar
 * disagreement on its own. An item that has reached a terminal resting folder is
 * finished and cannot need either piece of state; an item resting anywhere else
 * keeps everything it has, untouched. Both sub-passes resolve every uncertainty
 * towards LEAVING STATE ALONE, because the failure modes are asymmetric and both
 * severe: releasing a live lock would let two claimants build one item, and
 * clearing a live `needsAnswers` would disarm a gate and hand gated work to
 * agents.
 *
 * WHERE THIS RUNS. On the CLAIM path, which already writes to the arbiter and
 * already runs on every unit of work, so the residue drains as a side effect of
 * ordinary use. The read-only surfaces (`status`, `scan`) use the CLASSIFY twin
 * ({@link classifyTerminalState}) to REPORT the same residue without writing, and
 * perform this pass only under an explicit `--reconcile-locks`. Putting the
 * automatic clear on a write path rather than behind a flag on a read command is
 * what makes the fix real: an offer nobody is routed to is what let both defects
 * accumulate in the first place.
 */
export interface TerminalStateReport {
	locks: TerminalReconcileReport;
	questions: TerminalQuestionDrainResult;
}

/** The read-only twin of {@link TerminalStateReport}: what a reconcile WOULD do. */
export interface TerminalStateClassification {
	locks: TerminalLockClassification;
	questions: TerminalQuestionReport;
}

export interface TerminalStateOptions {
	cwd: string;
	arbiter?: string;
	env?: NodeJS.ProcessEnv;
	/**
	 * The ref holding the arbiter's authoritative `main`, for the READ side.
	 * Defaults to `<arbiter>/main` (the WORKING-CLONE shape); a BARE HUB MIRROR has
	 * no `refs/remotes/*` namespace at all and must pass `'main'`.
	 *
	 * NOTE: this governs the CLASSIFY/read side only. The question-drain's WRITE
	 * side publishes through `runTreelessLedgerMove`, which resolves its own CAS
	 * base from `<arbiter>/main`, so {@link reconcileTerminalState} is supported
	 * from a WORKING CLONE only. Classification is safe from either shape.
	 */
	mainRef?: string;
	note?: (message: string) => void;
}

/**
 * READ-ONLY: classify every piece of terminal-state residue on the arbiter (stale
 * locks + stranded question state) without touching anything. This is what the
 * read commands render, so finished work stops being reported as in-flight or as
 * blocked on open questions.
 */
export async function classifyTerminalState(
	opts: TerminalStateOptions,
): Promise<TerminalStateClassification> {
	const arbiter = opts.arbiter ?? 'origin';
	const mainRef = opts.mainRef ?? `${arbiter}/main`;
	const locks = await classifyTerminalItemLocks(opts.cwd, arbiter, opts.env, {
		mainRef,
	});
	const questions = await classifyTerminalQuestionResidue({
		cwd: opts.cwd,
		arbiter,
		mainRef,
		env: opts.env,
	});
	return {locks, questions};
}

/**
 * WRITE: settle both halves of an item's terminal residue in one pass. The lock
 * sub-pass deletes stale lock refs; the question sub-pass publishes ONE tree-less
 * commit to `main` removing stale sidecars and clearing stale `needsAnswers`
 * flags.
 *
 * Order matters only for reporting, not correctness: the two touch disjoint state
 * (a hidden ref namespace vs `main`'s tree) and neither depends on the other. It
 * never throws; each sub-pass degrades independently, so a failure to reach the
 * lock refs does not prevent the question drain, or vice versa.
 */
export async function reconcileTerminalState(
	opts: TerminalStateOptions,
): Promise<TerminalStateReport> {
	const arbiter = opts.arbiter ?? 'origin';
	const mainRef = opts.mainRef ?? `${arbiter}/main`;
	// ONE refresh of `main` for the WHOLE pass. Both sub-passes read the same
	// durable record, so fetching it twice per claim is pure waste on a hot path.
	// A failed refresh is not fatal: each sub-pass independently resolves every
	// uncertainty towards leaving state alone.
	await refreshMainRef(mainRef, arbiter, opts.cwd, opts.env);
	// Each sub-pass is independently guarded so one cannot take the other down,
	// and so a caller running this as opportunistic hygiene (the claim path) is
	// never failed by unrelated residue. Both are documented as never throwing;
	// this is the belt that makes that true even if a callee regresses.
	let locks: TerminalReconcileReport = {
		released: [],
		kept: [],
		stillHeld: [],
		errors: [],
	};
	try {
		locks = await reconcileTerminalItemLocks(opts.cwd, arbiter, opts.env, {
			mainRef,
			mainAlreadyFresh: true,
		});
	} catch (err) {
		locks.errors.push({
			entry: '(locks)',
			message: err instanceof Error ? err.message : String(err),
		});
	}
	let questions: TerminalQuestionDrainResult = {
		drained: [],
		unflagged: [],
		answeredHeld: [],
		errors: [],
	};
	try {
		questions = await reconcileTerminalQuestionResidue({
			cwd: opts.cwd,
			arbiter,
			mainRef,
			env: opts.env,
			mainAlreadyFresh: true,
			note: opts.note,
		});
	} catch (err) {
		questions.errors.push({
			item: '(questions)',
			message: err instanceof Error ? err.message : String(err),
		});
	}
	return {locks, questions};
}
