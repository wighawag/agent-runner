import {runAsync, type RunResult} from './git.js';
import {acquireItemLock, releaseItemLock, heldTaskSlugs} from './item-lock.js';
import {reconcileTerminalState} from './reconcile-terminal.js';
import {extractPromptSection} from './prompt.js';
import {resolveReadiness} from './readiness.js';
import {workBranchRef} from './slug-namespace.js';
import {workItemRel} from './work-layout.js';

/**
 * In-process TypeScript implementation of the atomic compare-and-swap claim from
 * `scripts/CLAIM-PROTOCOL.md`. This is the first-class `dorfl claim`
 * command (ADR §9: dorfl is the PRIMARY implementation of the claim
 * protocol; `scripts/claim.sh` is retained as the portable, zero-dependency
 * bootstrap / reference). The lock-substrate cut-over (spec
 * `ledger-status-per-item-lock-refs`) has since diverged it from `claim.sh`'s
 * body-move semantics — see the lock note below — but the exit codes are the same.
 *
 * It is async (each git call is a non-blocking `runAsync`) so two awaited claims
 * over the same slug genuinely race — the arbiter's per-item-ref CAS (not test
 * ordering) picks the single winner.
 *
 * Exit codes:
 *   0  claim landed (the per-item lock is held; the body stays where it rested:
 *       `tasks/ready/` normally, or `tasks/backlog/` under --allow-backlog)
 *   1  usage / environment error, or a readiness REFUSAL (unmet blockedBy)
 *   2  item not claimable (not in backlog, or lost the lock race to someone else)
 *   3  (legacy) push contention — no longer reachable: the per-item lock never
 *      falsely contends, so there is no retry budget to exhaust
 *
 * UNIFIED PER-ITEM LOCK (spec `ledger-status-per-item-lock-refs` US #1/#15/#16,
 * ADR `ledger-status-on-per-item-lock-refs`): a claim ACQUIRES the item's
 * per-item lock (`action: implement`) via the lock module and writes NOTHING to
 * `main` — the body STAYS at `work/backlog/<slug>.md`. The claimable predicate is
 * "in `backlog/` on `main` AND no lock held"; the held lock IS the claim. The lock
 * is acquired FIRST, so a lock `lost` (the SAME item is already locked) makes the
 * claim lose definitively (exit 2, NO retry budget). A subsequent claimability
 * re-check (the body left `backlog/`) RELEASES the lock (never orphaned). Because
 * claim touches no `main` (and no protected ref), a protected-`main` repo CAN be
 * claimed. The interim dual-write (`git mv backlog→in-progress` + a `main` claim
 * commit) is GONE.
 *
 * Before the claim runs, the HUMAN path's readiness guard (resolveReadiness) is
 * applied: a task with an unmet `blockedBy` is REFUSED (exit 1, outcome
 * 'not-ready') unless overridden; a `needsAnswers: true` task is WARNED about
 * but still claimed. The autonomous runner does NOT pass `humanPath`, so its
 * behaviour is unchanged (eligibility already filters those items upstream).
 */

/** Maps onto the four claim.sh exit codes. */
export type ClaimExitCode = 0 | 1 | 2 | 3;

/** A semantic label for each exit code (for callers/tests, never the verdict). */
export type ClaimCasOutcome =
	| 'claimed'
	| 'usage-error'
	| 'lost'
	| 'contended'
	| 'not-ready';

export interface ClaimCasOptions {
	/** The slug to claim (`work/backlog/<slug>.md`). */
	slug: string;
	/** Working clone/worktree the claim runs in. */
	cwd: string;
	/** Name of the arbiter remote (`--arbiter`). Defaults to `origin`. */
	arbiter?: string;
	/**
	 * (LEGACY, accepted-but-ignored) Cap on push retries when main merely advanced.
	 * The per-item lock never falsely contends (a per-item ref CAS is self-arbitrating),
	 * so there is no retry loop and nothing to bound. Kept on the option shape so
	 * existing callers/tests that pass `--retries` keep type-checking; it has NO effect.
	 */
	retries?: number;
	/** Show the intended push without mutating the arbiter (`--dry-run`). */
	dryRun?: boolean;
	/**
	 * Apply the human-path readiness guard before the CAS: refuse an unmet
	 * `blockedBy`, warn on `needsAnswers`. The HUMAN `claim`/`start` path sets
	 * this; the autonomous runner leaves it off (it filters upstream via
	 * eligibility and must NOT change behaviour here).
	 */
	humanPath?: boolean;
	/**
	 * Override flag (`--force` / `--ignore-not-ready`): bypass the readiness
	 * refusal and silence the `needsAnswers` warning, printing a loud notice that
	 * the guard was overridden. Only meaningful with `humanPath`.
	 */
	override?: boolean;
	/**
	 * `--allow-backlog` (spec
	 * `do-allow-backlog-drive-staged-tasks-without-promotion`): WIDEN the claimable
	 * predicate to ALSO accept a `tasks/backlog/`-resident body (staging), so a
	 * human can drive a staged task in place WITHOUT promoting it to the pool. The
	 * claim STAYS a pure per-item-lock acquire \u2014 it writes NOTHING to `main` and
	 * does NOT `git mv` the body (the body stays in `tasks/backlog/`). Competitor
	 * exclusion is the HELD LOCK (the pool scan subtracts held slugs folder-
	 * agnostically), not the folder, so no move is needed. Default off \u21d2 the
	 * predicate is "in `tasks/ready/` on `main` AND no lock held" exactly as today;
	 * reachable ONLY via the explicit flag, never `run`/auto-pick/advance.
	 */
	allowBacklog?: boolean;
	/** Environment for child git processes (identity etc.). */
	env?: NodeJS.ProcessEnv;
	/** Sink for human-readable progress notes (claim.sh writes these to stderr). */
	note?: (message: string) => void;
}

export interface ClaimCasResult {
	exitCode: ClaimExitCode;
	outcome: ClaimCasOutcome;
	/** Human-readable summary of the terminal condition. */
	message: string;
	/**
	 * (RETAINED for the option shape; now ALWAYS absent.) Historically the sha of
	 * the CLAIM COMMIT that landed on `main`, used by in-place onboarding to branch
	 * the work branch off the exact claim commit. The lock-substrate claim writes
	 * NOTHING to `main` (the body stays where it rested — `tasks/ready/` normally,
	 * or `tasks/backlog/` under --allow-backlog), so there is no claim
	 * commit — onboarding cuts the work branch straight off `<arbiter>/main` (which
	 * carries the backlog body). Kept on the result shape so existing readers
	 * (`do.ts` threads `claim.claimCommit` into onboarding) keep type-checking; an
	 * `undefined` value drives onboarding's fresh-off-`<arbiter>/main` branch path.
	 */
	claimCommit?: string;
}

/**
 * The "lost" diagnostic for a held-lock loss, reused so its message carries the
 * recovery hints a human re-running their OWN item needs. The body now STAYS in
 * `work/backlog/` (claim never moves it), so a held item is identified by its LOCK
 * (`action: implement` held on the per-item ref), not an `in-progress/` folder: a
 * held lock + the body still in `backlog/` is the normal claimed state. We fetch
 * the lock refs and, when the slug's lock is held, surface the resume/requeue
 * recovery hints; otherwise (the body left `backlog/` entirely — done/removed) we
 * fall back to the generic message.
 */
async function lostMessage(
	slug: string,
	arbiter: string,
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
	fallback: string,
): Promise<string> {
	const held = await heldTaskSlugs(cwd, arbiter, env);
	if (held.has(slug)) {
		return `'${slug}' is already claimed on ${arbiter}/main (its per-item lock is held). If someone else claimed it, pick another item; if it's your own (e.g. an interrupted run), continue it with \`dorfl resume ${slug}\` (or \`work-on\`), or recover via \`requeue\`.`;
	}
	return fallback;
}

/** Raised for usage/environment errors (exit 1). */
class ClaimUsageError extends Error {}

/**
 * Raised for a deliberate readiness REFUSAL (exit 1, outcome 'not-ready') —
 * distinct from a usage/environment error. The task has an unmet `blockedBy`
 * and the override was not supplied, so nothing is claimed.
 */
class ClaimNotReady extends Error {}

const DEFAULT_ARBITER = 'origin';

/**
 * Perform the claim CAS. Never throws for the expected "lost the race" or
 * "contended" cases — those are returned as exit 2 / 3. Usage/environment
 * problems surface as exit 1. A successful claim is exit 0. This mirrors
 * claim.sh's control flow exactly (refuse dirty tree → loop attempts → on
 * rejection refetch & decide lost-vs-advanced → cap retries → back off).
 */
export async function performClaim(
	options: ClaimCasOptions,
): Promise<ClaimCasResult> {
	const note = options.note ?? (() => {});
	try {
		return await runClaim(options, note);
	} catch (err) {
		if (err instanceof ClaimNotReady) {
			return {exitCode: 1, outcome: 'not-ready', message: err.message};
		}
		if (err instanceof ClaimUsageError) {
			return {exitCode: 1, outcome: 'usage-error', message: err.message};
		}
		// Any other unexpected failure is an environment error (exit 1), never a
		// false "claimed". claim.sh treats unexpected rc the same way (die → 1).
		const message = err instanceof Error ? err.message : String(err);
		return {exitCode: 1, outcome: 'usage-error', message};
	}
}

async function runClaim(
	options: ClaimCasOptions,
	note: (m: string) => void,
): Promise<ClaimCasResult> {
	const slug = options.slug;
	const arbiter = options.arbiter ?? DEFAULT_ARBITER;
	const dryRun = options.dryRun ?? false;
	const cwd = options.cwd;
	const env = options.env;

	if (!slug) {
		throw new ClaimUsageError(
			'missing <slug>. usage: dorfl claim <slug> [--arbiter remote]',
		);
	}
	if ((await gitSoft(['rev-parse', '--git-dir'], cwd, env)).status !== 0) {
		throw new ClaimUsageError('not inside a git repository');
	}
	if ((await gitSoft(['remote', 'get-url', arbiter], cwd, env)).status !== 0) {
		throw new ClaimUsageError(
			`no git remote named '${arbiter}' (set one, or pass --arbiter)`,
		);
	}

	// Refuse to run with a dirty tree — the claim must be a clean, isolated commit.
	const dirtyWorktree =
		(await gitSoft(['diff', '--quiet'], cwd, env)).status !== 0;
	const dirtyIndex =
		(await gitSoft(['diff', '--cached', '--quiet'], cwd, env)).status !== 0;
	if (dirtyWorktree || dirtyIndex) {
		throw new ClaimUsageError(
			'working tree has uncommitted changes; commit/stash them before claiming',
		);
	}

	// HUMAN-path readiness guard (run BEFORE the CAS so a not-ready task is never
	// claimed). Reads the task frontmatter + `work/done/` from `<arbiter>/main`
	// (the same source of truth the folder check uses) and resolves `blockedBy`
	// via the shared resolveBlockedBy. Skipped entirely for the autonomous runner
	// (no `humanPath`), whose eligibility filter already handles these upstream.
	if (options.humanPath) {
		await gitHard(['fetch', '--quiet', arbiter], cwd, env);
		const readiness = await resolveReadiness({
			slug,
			cwd,
			arbiter,
			override: options.override === true,
			env,
		});
		if (readiness.refuse) {
			const missing = readiness.missing.join(', ');
			const message =
				`'${slug}' is not ready: blocked by unmet dependencies not yet in ` +
				`work/done/ on ${arbiter}/main: ${missing}. ` +
				'Re-run with --force (or --ignore-not-ready) to claim it anyway.';
			note(message);
			throw new ClaimNotReady(message);
		}
		if (readiness.overridden && readiness.missing.length > 0) {
			note(
				`!! readiness guard OVERRIDDEN: claiming '${slug}' despite unmet ` +
					`blockedBy: ${readiness.missing.join(', ')} (not yet in work/done/).`,
			);
		}
		if (readiness.needsAnswers && !readiness.overridden) {
			note(
				`!! WARNING: '${slug}' is flagged needsAnswers: true — it has open ` +
					'questions (see the task body). Claiming it anyway (human path); ' +
					'resolve the questions before/while building.',
			);
		} else if (readiness.needsAnswers && readiness.overridden) {
			note(
				`!! readiness guard OVERRIDDEN: silencing the needsAnswers warning for '${slug}'.`,
			);
		}
	}

	const backlog = workItemRel('tasks-ready', `${slug}.md`);
	const staged = workItemRel('tasks-backlog', `${slug}.md`);
	const branch = workBranchRef('task', slug);

	/**
	 * The CLAIMABLE-RESIDENCE half of the predicate: the body rests in the pool
	 * (`tasks/ready/`) on `<arbiter>/main`, OR \u2014 under `--allow-backlog` \u2014 in
	 * `tasks/backlog/` (staging). The held-lock half is the create-only acquire.
	 * Folder-agnostic exclusion is the lock, never the folder, so a staged body is
	 * a legitimate claimable residence under the flag; otherwise staging is invisible.
	 */
	async function claimableBodyRel(): Promise<string | undefined> {
		if (await catFileExists(`${arbiter}/main:${backlog}`, cwd, env)) {
			return backlog;
		}
		if (
			options.allowBacklog === true &&
			(await catFileExists(`${arbiter}/main:${staged}`, cwd, env))
		) {
			return staged;
		}
		return undefined;
	}
	async function bodyRestsClaimable(): Promise<boolean> {
		return (await claimableBodyRel()) !== undefined;
	}

	/**
	 * The human-facing folder label for a resolved claimable body path (`work/<dir>`,
	 * e.g. `work/tasks/ready` or `work/tasks/backlog`). Derived from the ACTUAL
	 * resolved residence so the claim message never hard-codes the wrong folder.
	 */
	function residenceFolder(bodyRel: string): string {
		const dir = bodyRel.slice(0, bodyRel.lastIndexOf('/'));
		return dir === '' ? bodyRel : dir;
	}

	/**
	 * PRE-CLAIM WELL-FORMEDNESS GUARD (this task's interim guard against the
	 * promptless-promoted-task strand). The validator `resolveTask` /
	 * `extractPromptSection` (`prompt.ts`) requires a task body to carry a
	 * `## Prompt` section; it runs at DISPATCH (`do.ts` step 5), AFTER the claim,
	 * so a body missing `## Prompt` was caught only post-claim — the failure routed
	 * to `saveAgentFailure`, which left the lock `state: stuck`. We run the SAME
	 * validator (`extractPromptSection`, the single source of truth for "what makes
	 * a task dispatchable") HERE, BEFORE the lock is acquired, so a malformed body
	 * from ANY source (promotion, hand-authored, externally edited) is refused with a
	 * clean usage error and NO lock is taken. `bodyRel` is the resolved claimable
	 * residence (`tasks/ready/` or, under the flag, `tasks/backlog/`). A genuinely
	 * absent body is NOT this guard's concern (the claimability check returns `lost`
	 * separately) — this only fires when a body that DOES rest claimable lacks a
	 * `## Prompt`.
	 */
	async function assertBodyWellFormed(bodyRel: string): Promise<void> {
		const show = await gitSoft(
			['show', `${arbiter}/main:${bodyRel}`],
			cwd,
			env,
		);
		if (show.status !== 0) {
			// The body vanished between the residence check and this read — leave it to
			// the claimability path to report `lost`; do not synthesise a guard error.
			return;
		}
		if (extractPromptSection(show.stdout) === undefined) {
			throw new ClaimUsageError(
				`'${slug}' (${bodyRel}) has no '## Prompt' section, so it is not ` +
					'dispatchable — add a `## Prompt` section to the task body before ' +
					'claiming it. NO lock was acquired.',
			);
		}
	}

	// UNIFIED PER-ITEM LOCK — the WHOLE of the claim now (spec
	// `ledger-status-per-item-lock-refs` US #1/#15/#16; ADR
	// `ledger-status-on-per-item-lock-refs`). The interim dual-write is GONE: claim
	// acquires the item's per-item lock (`action: implement`) and writes NOTHING to
	// `main` — the body STAYS at `work/backlog/<slug>.md`, the claimable predicate is
	// "in `backlog/` on `main` AND no lock held", and the held lock IS the claim. So
	// a protected-`main` repo can be claimed (claim touches no protected ref).
	//
	// A dry-run takes no lock (it mutates nothing) and just reports it WOULD claim.
	/** The not-found diagnostic, naming the pool (and staging under the flag). */
	const notFoundFallback =
		options.allowBacklog === true
			? `neither '${backlog}' nor '${staged}' found on ${arbiter}/main (already done/removed, or wrong slug).`
			: `'${backlog}' not found on ${arbiter}/main (already done/removed, or wrong slug).`;

	if (dryRun) {
		await gitHard(['fetch', '--quiet', arbiter], cwd, env);
		const bodyRel = await claimableBodyRel();
		if (bodyRel === undefined) {
			const message = await lostMessage(
				slug,
				arbiter,
				cwd,
				env,
				notFoundFallback,
			);
			note(message);
			return {exitCode: 2, outcome: 'lost', message};
		}
		// A dry-run still runs the pre-claim well-formedness guard so it reports a
		// promptless body as a usage error rather than "would claim" it.
		await assertBodyWellFormed(bodyRel);
		const message = `DRY-RUN: would acquire the per-item lock for '${slug}' (body stays in ${residenceFolder(bodyRel)}/).`;
		note(message);
		return {exitCode: 0, outcome: 'claimed', message};
	}

	// PRE-CLAIM WELL-FORMEDNESS GUARD: fetch + read the claimable body and refuse a
	// task missing its `## Prompt` BEFORE the lock is acquired (so a malformed body
	// never strands a `state: stuck` lock at dispatch). A genuinely absent body is
	// left to the post-lock claimability re-check to report as `lost`; this guard
	// only fires for a body that DOES rest claimable but is not dispatchable.
	await gitHard(['fetch', '--quiet', arbiter], cwd, env);
	{
		const bodyRel = await claimableBodyRel();
		if (bodyRel !== undefined) {
			await assertBodyWellFormed(bodyRel);
		}
	}

	// LAZY RECONCILIATION of TERMINAL-STATE RESIDUE: the stale per-item lock a
	// propose PR leaves behind (observation
	// `every-completed-task-leaves-its-lock-ref-reporting-in-progress`) AND the
	// stranded sidecar + `needsAnswers` flag a bounced-then-rebuilt item leaves
	// behind (observation
	// `a-rebuilt-task-leaves-its-bounce-question-asking-to-cancel-a-merged-task`).
	// ONE pass, because they are the SAME defect wearing two hats: both are cleared
	// by a step that only runs on a path the item did not take, both become moot at
	// exactly the same moment (the done-move landing on `main`), and both are
	// otherwise detectable only from a loop the manual path never enters.
	//
	// `complete --propose` deliberately KEEPS its per-item lock held across the open
	// PR and promises "It is released when the PR merges (reconciled against main)".
	// That release could never fire: no dorfl process runs when a human clicks merge
	// on GitHub, there is no merge hook, and there is no daemon, so every completed
	// propose item leaked its lock ref permanently.
	//
	// THIS is where the release belongs, and why it is here rather than on `status`:
	// the merge EVENT is unobservable, but its CONSEQUENCE on `main` is durable, so
	// any later sweep converges just as well as a timely one. `claim` is the natural
	// host, it ALREADY writes to the arbiter (it is about to acquire a lock), it
	// ALREADY fetched `main` just above, and it runs on EVERY unit of work, so the
	// leaked set drains continuously without a human ever being asked to run a
	// clean-up verb. Keeping the release on a write path is what makes the fix real:
	// `gc --ledger` had been reporting these very locks and printing the
	// `release-lock` command all along, and that offer is precisely what nobody was
	// routed to. The read-only surfaces (`status`, `scan`) therefore only CLASSIFY.
	//
	// It acts EXACTLY on items that have come to REST in a terminal folder on
	// `<arbiter>/main`; an item on an OPEN PR still shows its body in the pool and
	// keeps both its lock and its question state, as does a genuinely stuck one.
	// Clearing a live `needsAnswers` would be as bad as releasing a live lock: it
	// would disarm a gate and hand gated work to agents. Best-effort and never throws:
	// any fault leaves every lock HELD (the safe direction) and never fails the
	// claim, which is unrelated work, this sweep is opportunistic hygiene, not a
	// precondition. It also cannot affect THIS claim's outcome: an item terminal on
	// `main` is not in the claimable pool anyway.
	await reconcileTerminalState({cwd, arbiter, env});

	// Acquire the lock FIRST. A lock `lost` (someone already holds this SAME item's
	// lock) makes claim lose DEFINITIVELY — exit 2, NO retry budget (a per-item ref
	// never falsely contends, so a rejection is a GENUINE same-item conflict the
	// loser should lose). We do NOT try to tell "our own orphaned lock" apart by
	// holder identity and auto-reclaim it: holder ids are NOT unique (a CI bot claims
	// many items under one `user.name`), so a release+re-acquire "reclaim" could let a
	// concurrent LOSER release the WINNER's still-valid lock — and an automatic sweep
	// contradicts the ADR's recovery model (`ledger-status-on-per-item-lock-refs`:
	// "no liveness heartbeat, no auto-sweep; a human asserts a lock is dead"). A
	// genuinely orphaned lock is cleared by the human-mediated `release-lock` verb +
	// `gc --ledger` report, never an auto-steal at claim time.
	const lock = await acquireItemLock({
		item: `task:${slug}`,
		action: 'implement',
		cwd,
		arbiter,
		env,
	});
	if (lock.outcome === 'error') {
		// Environment/usage problem acquiring the lock — surface as exit 1, never a
		// false claim. Nothing was acquired.
		throw new ClaimUsageError(
			`failed to acquire the item lock for '${slug}': ${lock.message}`,
		);
	}
	if (lock.outcome === 'lost') {
		const message = await lostMessage(slug, arbiter, cwd, env, lock.message);
		note(message);
		return {exitCode: 2, outcome: 'lost', message};
	}

	/** Release the lock we just acquired (best-effort) — used when the claimability
	 * re-check finds the item is no longer in the pool, so the lock is never
	 * orphaned (the body never moved, so the item is cleanly returned to the pool). */
	async function releaseHeldLock(): Promise<void> {
		await releaseItemLock({item: `task:${slug}`, cwd, arbiter, env});
	}

	// The RESOLVED claimable residence (`tasks/ready/` or, under `--allow-backlog`,
	// `tasks/backlog/`), captured by the post-lock claimability re-check below so the
	// success message reports the real folder rather than a hard-coded guess.
	let claimedBodyRel: string | undefined;

	try {
		// CLAIMABLE PREDICATE (US #15): "in `tasks/ready/` (the pool) on `main` AND no
		// lock held" \u2014 widened under `--allow-backlog` to ALSO accept a
		// `tasks/backlog/`-resident body (staging), so a human can drive a staged task
		// in place. The HELD-LOCK half is the create-only acquire above (a held slug
		// already lost the race). Confirm the residence here \u2014 the body STAYS where it
		// rested (claim moves nothing, even under the flag), so a `done`/absent item is
		// not claimable: release the lock we just took (it never protected any in-flight
		// work) and lose (exit 2).
		await gitHard(['fetch', '--quiet', arbiter], cwd, env);
		claimedBodyRel = await claimableBodyRel();
		if (claimedBodyRel === undefined) {
			await releaseHeldLock();
			const message = await lostMessage(
				slug,
				arbiter,
				cwd,
				env,
				notFoundFallback,
			);
			note(message);
			return {exitCode: 2, outcome: 'lost', message};
		}
	} catch (err) {
		// A plumbing failure after we took the lock: release it so the held lock does
		// not orphan an item that never started, then re-throw for the top-level
		// handler to classify (exit 1).
		await releaseHeldLock();
		throw err;
	}

	// CLAIMED. The body rests where it was claimed from (`tasks/ready/` normally, or
	// `tasks/backlog/` under `--allow-backlog`) on `<arbiter>/main` and the lock is
	// held. There is NO claim commit and nothing on `main` to branch from —
	// onboarding cuts the work branch straight off `<arbiter>/main` (which carries the
	// body). The folder is the RESOLVED residence, not a hard-coded guess: a `ready/`
	// claim must not falsely report `backlog/` (it misled a whole CI-incident triage).
	// `claimedBodyRel` is always set here (the claimability re-check above returns
	// `lost` otherwise); fall back to the pool residence (`backlog` IS the
	// `tasks-ready` path constant) for type-safety — derived via the layout helper,
	// never a raw `work/<folder>` literal (the work-layout guard).
	const residence = residenceFolder(claimedBodyRel ?? backlog);
	const message = `CLAIMED '${slug}' (lock held; body stays in ${residence}/ on ${arbiter}/main).`;
	note(message);
	note(
		`Start work:  git fetch ${arbiter} && git switch -C ${branch} ${arbiter}/main`,
	);
	return {exitCode: 0, outcome: 'claimed', message};
}

/** `git cat-file -e <object>` — true iff the object exists. */
async function catFileExists(
	object: string,
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<boolean> {
	return (await gitSoft(['cat-file', '-e', object], cwd, env)).status === 0;
}

/** Run git, returning the raw result (no throw) — for soft checks. */
function gitSoft(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<RunResult> {
	return runAsync('git', args, cwd, {env});
}

/** Run git; throw on non-zero (genuinely unexpected plumbing failures). */
async function gitHard(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): Promise<RunResult> {
	const result = await runAsync('git', args, cwd, {env});
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr.trim()}`,
		);
	}
	return result;
}
