import {randomUUID} from 'node:crypto';
import {runAsync, type RunResult} from './git.js';
import {refreshArbiterRefs, resolveArbiterBranch} from './arbiter-refs.js';
import {
	Integrator,
	type IntegrateResult,
	type ReviewProvider,
} from './integrator.js';
import type {IntegrationMode} from './config.js';
import {
	routeToNeedsAttention,
	returnToBacklog,
	surfaceStuckToNeedsAttention,
	type RouteToNeedsAttentionOptions,
	type RouteToNeedsAttentionResult,
	type ReturnToBacklogOptions,
	type ReturnToBacklogResult,
	type SurfaceToNeedsAttentionOptions,
	type SurfaceToNeedsAttentionResult,
	type BranchPushOutcome,
} from './needs-attention.js';
import type {NewQuestion} from './sidecar.js';

/**
 * The **write half** of the ledger-transition seam (ADR
 * `docs/adr/claim-ledger-vs-protected-main.md`, status: accepted — the "Write
 * seam"). ONE entry point — "apply this `work/` transition" — that every
 * transition (claim / complete / needs-attention) routes through, so a FUTURE
 * strategy could publish a transition elsewhere (e.g. a dedicated `main`-free
 * ledger ref) without the transition call sites learning a new mechanism.
 *
 * It is a PURE REFACTOR: there is exactly ONE strategy ({@link
 * currentLedgerWrite}) and it does EXACTLY what the code did before — it
 * CAS-publishes the prepared transition commit to the arbiter's `main` with
 * `--force-with-lease` and then verifies `<arbiter>/main` is now that commit. No
 * mode, no config, no `ledgerMode`, no new ref.
 *
 * The seam stays at the SEMANTIC level: the caller hands the seam a *prepared*
 * transition (a local branch carrying the commit, the base the ledger must still
 * be at for the CAS, and the commit it expects to land) plus the transition
 * KIND, and asks the seam to publish it. The public input is storage-agnostic —
 * it does NOT name `main`; that `main` is the publish/verify target is an
 * implementation detail of the sole strategy below.
 *
 * This task routes the CLAIM transition through the seam (see `claim-cas.ts`).
 * The `complete` and `needs-attention` kinds are named here so the companion
 * tasks route through the SAME entry point; they are not yet wired.
 *
 * The NEEDS-ATTENTION transition is wired here too: the abort paths in
 * `complete.ts` (red gate, rebase conflict), the runner's stuck routing in
 * `run.ts`, and the human `return` command all drive the
 * `* → needs-attention` move (and its `needs-attention → backlog` re-queue)
 * through this SAME seam rather than calling the move helpers directly. The
 * sole strategy delegates to the folder-native mechanism in
 * `needs-attention.ts` UNCHANGED (reason-in-the-body — WORK-CONTRACT rule 3,
 * bounce from in-progress OR done, ONE atomic commit, optional branch push); the
 * seam only relocates WHERE the "apply the needs-attention transition" call is
 * expressed, so the later cherry-pick-to-`main` surfacing is built AGAINST the
 * seam, not bolted onto the move code.
 */

/**
 * The `work/` lifecycle transitions the write seam can apply.
 *
 * `tasking` is the legacy tasking-lock MARKER transition. It is now VESTIGIAL: the
 * capstone cut-over (task
 * `cutover-retire-slicing-advancing-markers-and-trim-folder-sets`) retired the
 * `git mv work/prd/<slug>.md → work/tasking/<slug>.md` marker (the historical
 * marker paths), so the tasking lock
 * is the unified per-item lock ref (`tasking-lock.ts`) and no longer routes through
 * {@link applyTransition} with this kind. The member is kept so the strategy
 * interface and any historical reference stay valid; nothing publishes it.
 *
 * `advancing` is the kind {@link createItemThroughCas} (`advancing-lock.ts`) uses
 * to publish a NEW `work/` item (the triage observation→promote path) through the
 * SAME CAS the `claim` transition uses, keyed on the new item's identity (its
 * path). The advancing-lock BORROW itself no longer rides this kind: the
 * `work/advancing/<entry>.md` presence-marker is retired (the borrow is the unified
 * `action: advance` lock ref now). So `advancing` survives only as the create-item
 * CAS kind.
 */
export type LedgerTransitionKind =
	| 'claim'
	| 'complete'
	| 'needs-attention'
	| 'requeue'
	| 'tasking'
	| 'advancing'
	/**
	 * The **promote** transition (spec `staging-pool-position-gate-and-trust-model`,
	 * task `pre-backlog-staging-folder-and-promote-step-a`): move a STAGED task
	 * `work/tasks/backlog/<slug>.md → work/tasks/ready/<slug>.md` to enter the
	 * agent-eligible pool. A durable `main` move, the same category as `requeue`
	 * (tree-less CAS via {@link applyTransition}). RUNNER/human-owned — no
	 * agent-facing path performs it (governing ADR
	 * `placement-is-runner-deterministic-humanonly-is-agent-judgement`).
	 */
	| 'promote';

/**
 * A *prepared* COMPLETE transition the caller asks the seam to publish: a
 * finished work branch whose code should be integrated back to the arbiter. Like
 * {@link ApplyTransitionInput} it is storage-agnostic — it names the work branch
 * + the integration MODE + the review provider, NOT *where* the integration
 * lands (the sole strategy decides that; today `merge` ff's to the arbiter's
 * `main`, `propose` pushes the branch + requests review). The caller has already
 * done the gate / done-move / commit / rebase-onto-arbiter — the seam only
 * APPLIES the integration of that prepared branch.
 */
export interface ApplyCompleteTransitionInput {
	/** Name of the arbiter git remote the integration is published to. */
	arbiter: string;
	/** The prepared (gated, committed, rebased) work branch to integrate. */
	branch: string;
	/** Integration mode: `merge` (ff to the ledger) or `propose` (push + review). */
	mode: IntegrationMode;
	/** The review-request provider (propose mode); push-only `none` otherwise. */
	provider: ReviewProvider;
	/**
	 * **The PR-INTENT axis** (config `noPR`, ADR §6): when `true` on the propose
	 * path, push the branch but SKIP the review request (the explicit suppress-PR
	 * intent). Threaded to {@link Integrator.integrate}. Ignored in `merge` mode.
	 */
	noPR?: boolean;
	/**
	 * Optional single-line review-request TITLE (propose mode), threaded straight
	 * to the provider. Absent ⇒ the provider's `--fill` default (no regression).
	 */
	title?: string;
	/**
	 * Optional review-request BODY (propose mode) — advisory prose, gates nothing —
	 * threaded straight to the provider. Absent ⇒ the provider's `--fill` default.
	 */
	body?: string;
	/**
	 * **Reap the remote head branch inline after a merge lands** (the merged-branch
	 * hygiene task's part (b)). When `true` on the `merge` path, delete the remote
	 * `work/<slug>` head AFTER the work landed on `main` (provably merged, so
	 * ancestor-safe; idempotent no-op when no remote head exists). Threaded straight
	 * to {@link Integrator.integrate}. Ignored in `propose` mode (the branch is the
	 * review surface, reaped later by `gc --remote-branches`).
	 */
	deleteMergedHead?: boolean;
	/** Working clone/worktree the integration runs in. */
	cwd: string;
	/** Environment for child git processes. */
	env?: NodeJS.ProcessEnv;
}

/**
 * The outcome of asking the seam to apply (publish) a prepared COMPLETE
 * transition. It is exactly the integration result the {@link Integrator}
 * produces — the seam adds NO interpretation, it only relocates WHERE the
 * "apply the complete transition" call is expressed.
 */
export type ApplyCompleteTransitionResult = IntegrateResult;

/**
 * A *prepared* NEEDS-ATTENTION transition the caller asks the seam to apply:
 * mark a stuck claimed item on its per-item lock with the reason. Like the
 * other inputs it is storage-agnostic — it names the slug, the reason prose,
 * any surfaced questions, and an OPTIONAL arbiter to also push the work branch
 * to, NOT *where* the surface commits/publishes (the sole strategy decides
 * that: post lock-cutover, a lock amend to `state: stuck` with the reason on
 * the lock entry — no `work/needs-attention/` folder write — plus the optional
 * branch push). This mirrors {@link RouteToNeedsAttentionOptions} so the
 * mechanism stays unchanged.
 */
export type ApplyNeedsAttentionTransitionInput = RouteToNeedsAttentionOptions;

/**
 * The outcome of asking the seam to apply a NEEDS-ATTENTION transition — the
 * move result the folder-native mechanism produces. The RECOVERABLE branch push
 * outcome rides on `branchPush` (the caller reads it rather than assuming
 * "pushed" off the local move). The OBSERVABLE half is now the per-item lock
 * `state: stuck` amend (spec `ledger-status-per-item-lock-refs`); there is no
 * separate on-`main` surface outcome to report.
 */
export type ApplyNeedsAttentionTransitionResult = RouteToNeedsAttentionResult;

/**
 * A *prepared* RETURN-TO-BACKLOG transition: re-queue a STUCK item so it can be
 * re-claimed — recovered via its per-item lock on the arbiter (post lock-cutover
 * the body never moved into a status folder; it rests in `backlog/`, so requeue
 * releases/clears the lock rather than moving a `.md`). Covers both a resolved
 * stuck hold and a claim that never surfaced.
 * Storage-agnostic, mirroring {@link ReturnToBacklogOptions}.
 */
export type ApplyReturnToBacklogTransitionInput = ReturnToBacklogOptions;

/**
 * The outcome of asking the seam to apply a RETURN-TO-BACKLOG transition. It is
 * a Promise: like `claim`, the tree-less strategy fetches + CAS-pushes to the
 * arbiter (async).
 */
export type ApplyReturnToBacklogTransitionResult =
	Promise<ReturnToBacklogResult>;

/**
 * A *prepared* TREE-LESS NEEDS-ATTENTION (surface) transition: surface a stuck
 * AFTER-COMMIT, LEDGER-ONLY item (post lock-cutover — mark its per-item lock
 * `state: stuck` with the reason, no `in-progress/ → needs-attention/` folder
 * move) WITHOUT a checkout — the SURFACE-direction sibling of the
 * tree-less requeue, sharing its exact mechanism. The work is ALREADY committed
 * on the kept `work/<slug>` branch (intact on the arbiter, recoverable), so the
 * surface is purely the lock amend + reason — no `pushBranch`, no
 * worktree. Storage-agnostic, mirroring {@link SurfaceToNeedsAttentionOptions}.
 * NOT for the wip-save / gate-failed / agent-failed surfaces (which may carry
 * uncommitted work — those keep {@link applyNeedsAttentionTransition}, the
 * cwd-bound path that can commit wip first).
 */
export type ApplyTreelessNeedsAttentionTransitionInput =
	SurfaceToNeedsAttentionOptions;

/**
 * The outcome of asking the seam to apply a TREE-LESS NEEDS-ATTENTION (surface)
 * transition. A Promise: like `requeue`/`claim`, the tree-less strategy fetches +
 * CAS-pushes to the arbiter (async).
 */
export type ApplyTreelessNeedsAttentionTransitionResult =
	Promise<SurfaceToNeedsAttentionResult>;

/**
 * A *prepared* RESOLVE-NEEDS-ATTENTION transition: a human is picking up a stuck
 * item, so the seam must **clear the stuck state** and restore it to `active`.
 * Storage-agnostic — it names the slug + the working clone (and an OPTIONAL
 * arbiter to amend the lock on), NOT *where* the stuck state lives. The sole
 * strategy clears it by amending the per-item lock `stuck → active` on the
 * arbiter (task `cutover-needs-attention-becomes-lock-stuck-recovery-surface`).
 */
export interface ApplyResolveNeedsAttentionTransitionInput {
	/** The working clone the `work/` tree lives in. */
	cwd: string;
	/** The slug of the stuck item to resolve back to active. */
	slug: string;
	/**
	 * The arbiter remote whose lock ref to amend (`stuck → active`). Omitted ⇒ a
	 * recorded no-op success (no lock ref to amend; the human-local face).
	 * Storage-agnostic: it names the remote, not `main`.
	 */
	arbiter?: string;
	/** Environment for child git processes. */
	env?: NodeJS.ProcessEnv;
	/** Sink for human-readable progress notes. */
	note?: (message: string) => void;
}

/** The outcome of asking the seam to apply a RESOLVE-NEEDS-ATTENTION transition. */
export interface ApplyResolveNeedsAttentionTransitionResult {
	/** True iff the lock was amended back to active (or the no-arbiter no-op). */
	moved: boolean;
	/** When NOT moved, why (no held stuck lock, contention, …). */
	reasonNotMoved?: string;
}

/**
 * A *prepared* transition the caller asks the seam to publish. Storage-agnostic:
 * it describes the transition semantically (a kind + a prepared local commit +
 * the CAS lease), NOT *where* it should be published. The sole strategy decides
 * that (today: the arbiter's `main`).
 */
export interface ApplyTransitionInput {
	/** Which `work/` transition this is (claim / complete / needs-attention). */
	kind: LedgerTransitionKind;
	/** Name of the arbiter git remote the transition is published to. */
	arbiter: string;
	/** Local branch carrying the prepared transition commit (its tip = {@link head}). */
	localBranch: string;
	/**
	 * The ledger commit the publish must be a fast-forward FROM — the
	 * compare-and-swap lease. If the ledger has moved past this, the publish is
	 * rejected (someone else advanced it under us).
	 */
	expectedBase: string;
	/** The commit sha the caller expects to become the ledger tip after publish. */
	head: string;
	/** Working clone/worktree the publish runs in. */
	cwd: string;
	/** Show the intended publish without mutating the arbiter (dry-run). */
	dryRun?: boolean;
	/** Environment for child git processes. */
	env?: NodeJS.ProcessEnv;
	/** Sink for human-readable progress notes. */
	note?: (message: string) => void;
}

/** The outcome of asking the seam to publish a prepared transition. */
export interface ApplyTransitionResult {
	/**
	 * `published` — the transition landed (and was verified to be the ledger tip).
	 * `rejected` — the CAS lease failed (the ledger moved under us); the caller
	 * decides whether to refetch+retry or give up. The seam never throws for this
	 * expected contended case.
	 */
	kind: 'published' | 'rejected';
	/** Human-readable summary of the terminal condition. */
	message: string;
	/**
	 * The sha that ACTUALLY landed on the ledger when `published`. The seam stamps
	 * each attempt's tip with a fresh `CAS-Nonce` trailer (so the pushed sha is
	 * unique), so the landed commit is NOT the caller's pre-nonce `head` — it is
	 * this nonce'd descendant-in-content. Callers that branch/track/report off the
	 * landed commit (e.g. `claim`'s work-branch hint) MUST use this, not their
	 * input `head`. Absent on `rejected` and on `dryRun`.
	 */
	publishedHead?: string;
}

/**
 * The write-seam interface: ONE entry point — apply (publish) a prepared `work/`
 * transition. A future strategy implements this same interface to publish the
 * transition elsewhere — without any transition call site changing.
 */
export interface LedgerWriteStrategy {
	applyTransition(input: ApplyTransitionInput): Promise<ApplyTransitionResult>;
	/**
	 * Apply (publish) a prepared COMPLETE transition: integrate a finished work
	 * branch back to the arbiter per its mode. The sole strategy delegates to the
	 * integration mechanism unchanged; a future strategy could integrate elsewhere
	 * without `complete.ts` changing.
	 */
	applyCompleteTransition(
		input: ApplyCompleteTransitionInput,
	): Promise<ApplyCompleteTransitionResult>;
	/**
	 * Apply a NEEDS-ATTENTION transition: mark a stuck claimed item on its
	 * per-item lock with its reason (post lock-cutover — no folder write). The
	 * sole strategy delegates to the underlying mechanism unchanged; a future
	 * strategy could surface the stuck item elsewhere without
	 * `complete.ts`/`run.ts` changing.
	 */
	applyNeedsAttentionTransition(
		input: ApplyNeedsAttentionTransitionInput,
	): Promise<ApplyNeedsAttentionTransitionResult>;
	/**
	 * Apply a TREE-LESS NEEDS-ATTENTION (surface) transition: surface a stuck
	 * AFTER-COMMIT, LEDGER-ONLY item (post lock-cutover — mark its per-item lock
	 * `state: stuck`, no `in-progress/ → needs-attention/` folder move) WITHOUT a
	 * checkout, reusing the SAME tree-less mechanism `requeue` uses for the reverse
	 * direction. The sole strategy delegates to the tree-less surface (a pure lock
	 * amend CAS-published to the arbiter's lock ref). NOT
	 * for the uncommitted-wip surfaces, which keep {@link
	 * applyNeedsAttentionTransition} (the cwd-bound path that can commit wip first).
	 */
	applyTreelessNeedsAttentionTransition(
		input: ApplyTreelessNeedsAttentionTransitionInput,
	): ApplyTreelessNeedsAttentionTransitionResult;
	/**
	 * Apply a RETURN-TO-BACKLOG transition: re-queue a STUCK item (recovered via
	 * its per-item lock on the arbiter — post lock-cutover the body rests in
	 * `backlog/`, not a status folder) for
	 * re-claiming, routed through the SAME seam. Like `claim`, it is TREE-LESS —
	 * the amend is a compare-and-swap push to the arbiter ref (it never writes the
	 * cwd tree).
	 */
	applyReturnToBacklogTransition(
		input: ApplyReturnToBacklogTransitionInput,
	): ApplyReturnToBacklogTransitionResult;
	/**
	 * Apply a RESOLVE-NEEDS-ATTENTION transition: a human is picking up a stuck
	 * item, so **clear the stuck surface** and restore it to `in-progress`. The
	 * seam carries only that INTENT — "clear the surface" — NOT *how*; the sole
	 * (mode-M) strategy clears it by reverse-moving needs-attention → in-progress
	 * on the arbiter's `main`, but a future strategy could clear it differently
	 * without `start.ts` changing.
	 */
	applyResolveNeedsAttentionTransition(
		input: ApplyResolveNeedsAttentionTransitionInput,
	): Promise<ApplyResolveNeedsAttentionTransitionResult>;
}

// --- The sole strategy: exactly today's behaviour -------------------------

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

/** The git trailer key the per-attempt CAS nonce rides in (greppable, round-trips). */
export const CAS_NONCE_TRAILER = 'CAS-Nonce';

/**
 * Rebuild the transition tip ({@link localBranch}'s commit, whose sha is {@link
 * head}) into a NEW commit object that is byte-for-byte identical EXCEPT for a
 * freshly-appended `CAS-Nonce: <uuid>` trailer, and return the new sha. This is
 * the ONE chokepoint that makes EVERY {@link
 * LedgerWriteStrategy.applyTransition} caller's CAS commit unique — create,
 * claim, tasking-lock, advancing-lock, and the needs-attention/requeue surface
 * all route their publish through `applyTransition`, so stamping HERE (the seam
 * AMENDING the tip's message just before the push) covers all of them WITHOUT a
 * shared commit-building helper and WITHOUT touching each commit site.
 *
 * It is built with `commit-tree` plumbing on the same tree + parent + ambient
 * env identity as the tip, so it NEVER mutates the caller's working tree, index,
 * or HEAD (safe from a job worktree mid-flight), and it preserves WHO/WHAT — it
 * ONLY appends the trailer to the original message. The author/committer
 * identity is pinned from the original commit so the stamp does not silently
 * re-attribute the transition.
 *
 * A FRESH nonce is generated on EACH call — and `applyTransition` calls this once
 * per ATTEMPT (each retry of a caller's outer refetch loop re-enters
 * `applyTransition`), so two concurrent same-identity racers, and any single
 * racer across its own retries, ALWAYS get distinct shas.
 */
async function stampNonce(params: {
	localBranch: string;
	head: string;
	cwd: string;
	env: NodeJS.ProcessEnv | undefined;
}): Promise<string> {
	const {localBranch, head, cwd, env} = params;
	const nonce = randomUUID();

	// Read the tip's tree + parents + author/committer identity + original message
	// in ONE `git log` (one git subprocess, not four) — the body (%B, multi-line)
	// MUST be last. Fields are NUL-separated (%x00); the trailing field is the raw
	// body so its embedded newlines do not confuse the split.
	const FIELD_SEP = '\u0000';
	const raw = (
		await gitHard(
			[
				'log',
				'-1',
				`--format=%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%B`,
				head,
			],
			cwd,
			env,
		)
	).stdout;
	const fields = raw.split(FIELD_SEP);
	const tree = (fields[0] ?? '').trim();
	const parents = (fields[1] ?? '')
		.trim()
		.split(/\s+/)
		.filter((p) => p.length > 0); // the tip's parents (usually exactly one)
	const authorName = fields[2] ?? '';
	const authorEmail = fields[3] ?? '';
	const authorDate = fields[4] ?? '';
	const committerName = fields[5] ?? '';
	const committerEmail = fields[6] ?? '';
	// The body is the last field; strip trailing whitespace before we append.
	const message = (fields[7] ?? '').replace(/\s+$/, '');

	// Pin the original author/committer so the stamp re-attributes nothing; we are
	// only appending a trailer to the message.
	const stampEnv: NodeJS.ProcessEnv = {
		...(env ?? process.env),
		GIT_AUTHOR_NAME: authorName,
		GIT_AUTHOR_EMAIL: authorEmail,
		GIT_AUTHOR_DATE: authorDate,
		GIT_COMMITTER_NAME: committerName,
		GIT_COMMITTER_EMAIL: committerEmail,
		// Deliberately do NOT pin GIT_COMMITTER_DATE: even two stamps with identical
		// everything-else would still differ by the nonce, but leaving the committer
		// date current is the honest "when this attempt was published".
	};

	// Append the trailer as its own block so it round-trips as a real git trailer.
	const noncedMessage = `${message}\n\n${CAS_NONCE_TRAILER}: ${nonce}\n`;
	const parentArgs = parents.flatMap((p) => ['-p', p]);
	const result = await runAsync(
		'git',
		['commit-tree', tree, ...parentArgs, '-m', noncedMessage],
		cwd,
		{env: stampEnv},
	);
	if (result.status !== 0) {
		throw new Error(
			`git commit-tree (CAS nonce stamp) failed (exit ${result.status}): ${result.stderr.trim()} — localBranch=${localBranch}`,
		);
	}
	return result.stdout.trim();
}

/**
 * The ONLY ledger-write strategy: current behaviour. It CAS-publishes the
 * prepared transition commit to the arbiter's `main` — the `main` push and the
 * `--force-with-lease=main:<base>` lease live HERE, not in the public input — and
 * verifies the arbiter's `main` is now that commit (guarding against an
 * "Everything up-to-date" push masquerading as a successful transition). A future
 * strategy would be a different object implementing the same interface — chosen
 * NOWHERE today (no mode/config selects it).
 */
export const currentLedgerWrite: LedgerWriteStrategy = {
	async applyTransition({
		arbiter,
		localBranch,
		expectedBase,
		head,
		cwd,
		dryRun,
		env,
		note,
	}): Promise<ApplyTransitionResult> {
		const emit = note ?? (() => {});

		if (dryRun) {
			const message = `[dry-run] would: git push ${arbiter} ${localBranch}:main --force-with-lease=main:${expectedBase}`;
			emit(message);
			return {kind: 'published', message};
		}

		// Stamp this ATTEMPT's transition commit with a FRESH random nonce (a real
		// `CAS-Nonce: <uuid>` git trailer) so the pushed sha is UNIQUE per attempt.
		// This is what makes the lease authoritative even for SAME-IDENTITY,
		// SAME-CONTENT racers: without it, two racers who build an identical tree +
		// message off the same base within git's 1-second timestamp resolution
		// produce an IDENTICAL sha X. The first push ff's main to X; the second
		// push of the SAME X degrades to "Everything up-to-date" (git exits 0, the
		// lease has nothing to reject), and the post-push verify X === X passes — so
		// BOTH would return `published`. The nonce gives each attempt a DISTINCT sha,
		// so the loser's push finds main moved past <base> and is GENUINELY rejected
		// by the lease, and the verify below correctly fails for it. The stamp is
		// built with `commit-tree` plumbing (no checkout/HEAD mutation), reusing the
		// tip's tree + parent + author/committer identity — it ONLY appends the
		// trailer, leaving WHO/WHAT/the original message intact. Called per ATTEMPT
		// (each retry of the caller's outer refetch loop re-enters here), so every
		// attempt gets a fresh nonce, not one per process.
		const nonced = await stampNonce({localBranch, head, cwd, env});

		// The atomic compare-and-swap. --force-with-lease=main:<base> asserts the
		// arbiter's main is STILL <base> (unchanged since our fetch); the push then
		// fast-forwards main to our (nonce'd, thus unique) commit. If main moved, the
		// lease fails → rejected.
		const push = await gitSoft(
			[
				'push',
				arbiter,
				`${nonced}:main`,
				`--force-with-lease=main:${expectedBase}`,
			],
			cwd,
			env,
		);
		if (push.status === 0) {
			// Verify the arbiter main now points at OUR (nonce'd) commit. INVARIANT:
			// because the nonce makes our sha unique, a successful push can ONLY mean
			// either (a) we genuinely ff'd main to our nonce'd commit (published), or
			// (b) someone else's commit (a DIFFERENT nonce ⇒ a DIFFERENT sha) is already
			// there and ours did NOT land — i.e. an "up-to-date / no change of our
			// making" no-op, which is a LOSS. The nonce makes the two naturally
			// distinguishable: `arbiterHead === nonced` iff WE won. So an up-to-date
			// no-op can never satisfy this and is classified REJECTED, never published.
			//
			// The read MUST be ARBITER-AUTHORITATIVE, and used to not be: it was a
			// plain `git fetch <arbiter>` + `rev-parse <arbiter>/main`. In the
			// bare-hub-mirror job worktree `--isolated` runs in, that fetch does not
			// populate `refs/remotes/<arbiter>/main` at all (the mirror refspec maps
			// `+refs/heads/*:refs/heads/*`) and can even fail outright, so the verify
			// compared our fresh sha against a view PREDATING our own push and declared
			// a landed transition "not our commit ⇒ rejected" — five times per bounce,
			// landing five identical commits and then reporting "did not land"
			// (observation `checkpoint-path-reports-its-own-write-as-absent`). We now
			// prune-fetch with the EXPLICIT refspec (so the objects/refs are local for
			// any follow-up comparison) and then ask the ARBITER for the sha via
			// `ls-remote`, which no local refspec accident can defeat.
			await refreshArbiterRefs({cwd, arbiter, branches: ['main'], env});
			const resolved = await resolveArbiterBranch({
				cwd,
				arbiter,
				branch: 'main',
				env,
			});
			if (resolved.sha === nonced) {
				return {
					kind: 'published',
					message: 'transition published',
					publishedHead: nonced,
				};
			}
			if (!resolved.trustworthy) {
				// The arbiter could not be reached, so we CANNOT tell a lost CAS from an
				// unreadable view — and our push exited 0, which is evidence FOR landing.
				// Reporting "rejected" here is precisely the defect (a successful write
				// described as absent), and it also drives a retry that would duplicate
				// the commit. Trust the green push: report published, and say why.
				emit(
					`push to ${arbiter}/main succeeded but the arbiter could not be re-read ` +
						`to confirm it (${resolved.unreachableDetail ?? 'arbiter unreachable'}) ` +
						'— trusting the successful push rather than reporting a landed write as ' +
						'absent.',
				);
				return {
					kind: 'published',
					message:
						'transition published (push succeeded; arbiter re-read unavailable)',
					publishedHead: nonced,
				};
			}
			emit(
				`push reported up-to-date / no change of our making — ${arbiter}/main is not our commit — treating as rejected.`,
			);
		}
		return {kind: 'rejected', message: 'push rejected / lease failed'};
	},

	/**
	 * The complete transition under the SAME strategy: integrate the prepared work
	 * branch back to the arbiter exactly as `complete.ts` did before — it builds
	 * the {@link Integrator} with the chosen provider and calls `integrate` (the
	 * branch was already rebased onto the latest arbiter ledger by the caller, so
	 * this is the non-rebasing `integrate`, never `--force`). `merge` ff's the
	 * branch to the arbiter's `main`; `propose` pushes the branch + asks the
	 * provider to request review. That `merge` targets `main` is an implementation
	 * detail of THIS strategy — the public input never names it.
	 */
	async applyCompleteTransition({
		arbiter,
		branch,
		mode,
		provider,
		noPR,
		title,
		body,
		deleteMergedHead,
		cwd,
		env,
	}): Promise<ApplyCompleteTransitionResult> {
		const integrator = new Integrator({provider});
		return integrator.integrate({
			cwd,
			arbiter,
			branch,
			mode,
			noPR,
			title,
			body,
			deleteMergedHead,
			env,
		});
	},

	/**
	 * The needs-attention transition under the SAME strategy. The seam's contract
	 * is transition-kind-agnostic: durably record a stuck job =
	 *
	 *   - **OBSERVABLE** — publish the stuck state to the ledger surface so
	 *     `scan`/`status`/a fresh checkout/another machine can see it. (THIS mode-M
	 *     strategy does that by CHERRY-PICKING the move-only commit — the reason +
	 *     the `git mv` — onto the arbiter's `main`, all-or-nothing, never `--force`d,
	 *     so the half-finished wip below it never lands there. A future mode-P
	 *     strategy could make it observable WITHOUT writing `main`, e.g. by reading
	 *     work-branch tips.)
	 *   - **RECOVERABLE** — push the work branch (when there IS one), so the saved
	 *     work travels cross-machine and a requeue continues from its tip. (Mode M
	 *     does that by `git push`ing the branch; the WHICH branch is the caller's,
	 *     not assumed `work/<slug>` — a build bounce pushes `work/<slug>`, a tasking
	 *     bounce its `work/prd-<slug>`, a temp-branch caller pushes NOTHING.)
	 *
	 * Both halves are ONE operation done in ONE place: it delegates to {@link
	 * routeToNeedsAttention}, which saves the aborted work as a **wip** commit
	 * on the work branch (post lock-cutover no `work/needs-attention/` folder
	 * write ever fires here) and — when an `arbiter` is given — pushes the work
	 * branch (best-effort, branch-parameterised, emptiness-guarded; SURFACE-
	 * ONLY when `pushBranch: false`). The OBSERVABLE lock amend rides on
	 * {@link bounceToStuckLock} directly below. The seam does NOT strip the arbiter: the same
	 * arbiter both publishes the surface (here) AND drives the helper's branch push,
	 * so "record stuck" and "save the work" can never drift apart. The human-vs-
	 * autonomous gate rides on whether an `arbiter` is given at all (human
	 * `complete` passes none → no surface, no push, local-only; autonomous `do`/`run`
	 * pass it → both).
	 */
	async applyNeedsAttentionTransition(
		input: ApplyNeedsAttentionTransitionInput,
	): Promise<ApplyNeedsAttentionTransitionResult> {
		// BOUNCE = SAVE WIP + PUSH BRANCH (recoverable) + MARK LOCK STUCK (observable)
		// — task `cutover-needs-attention-becomes-lock-stuck-recovery-surface`
		// (decision i+). The OBSERVABLE half is now the per-item lock `state: stuck`
		// (full reason prose + any agent-surfaced questions on the entry), NOT a
		// `git mv` to `needs-attention/` and NOT an on-`main` surface — so a
		// protected-`main` bounce succeeds and a branch cut from `main` inherits no
		// stuck record. The RECOVERABLE half is UNCHANGED: {@link routeToNeedsAttention}
		// commits the agent's uncommitted wip to the `work/<slug>` branch tip and
		// pushes the branch (best-effort, branch-parameterised, emptiness-guarded,
		// outage-retried), so the partial work travels cross-machine and a `requeue`
		// continues from the tip. The work-branch push is NOT a `main` write.
		const saved = await routeToNeedsAttention(input);
		const surfaced = await bounceThroughSurface({
			cwd: input.cwd,
			slug: input.slug,
			item: `task:${input.slug}`,
			reason: input.reason,
			questions: input.questions,
			arbiter: input.arbiter,
			env: input.env,
			note: input.note,
		});
		return {
			// `moved` reflects the OBSERVABLE half (the surface record): the sidecar +
			// `needsAnswers:true` on `<arbiter>/main` (or the human-local no-op).
			moved: surfaced.moved,
			reasonNotMoved: surfaced.reasonNotMoved,
			// The branch push outcome is the honest RECOVERABLE report (`do`/`run` read
			// it).
			branchPush: saved.branchPush,
			pushError: saved.pushError,
		};
	},

	/**
	 * The return-to-backlog transition under the SAME strategy: re-queue the
	 * stuck item by delegating to {@link returnToBacklog}, which moves the slug's
	 * current `work/<needs-attention|in-progress>/<slug>.md → work/tasks/ready/<slug>.md`
	 * TREE-LESSLY — it
	 * builds the move off `<arbiter>/main` with plumbing and CAS-publishes it back
	 * THROUGH this same write seam (`applyTransition`, the very push+lease+verify
	 * `claim` uses), never staging/committing in the cwd working tree.
	 */
	applyReturnToBacklogTransition(
		input: ApplyReturnToBacklogTransitionInput,
	): ApplyReturnToBacklogTransitionResult {
		return returnToBacklog(input);
	},

	/**
	 * The tree-less surface transition under the SAME strategy: surface the
	 * stuck AFTER-COMMIT, LEDGER-ONLY item by delegating to the tree-less
	 * surface — post lock-cutover a pure LOCK AMEND (`state: stuck` with the
	 * reason on the lock entry), CAS-published to the arbiter's lock ref via
	 * the same push+lease+verify seam `claim`/`requeue` use, never staging or
	 * committing in the cwd working tree. The reverse of
	 * {@link applyReturnToBacklogTransition}, the same one mechanism.
	 */
	async applyTreelessNeedsAttentionTransition(
		input: ApplyTreelessNeedsAttentionTransitionInput,
	): ApplyTreelessNeedsAttentionTransitionResult {
		// PR-2b surface cutover (spec
		// `surface-stuck-as-questions-and-retire-stuck-lock-state`, decision #1): the
		// after-commit / ledger-only surface (continue-push-failure / continue-rebase-
		// conflict) surfaces the item on `<arbiter>/main` (a `stuck`-kind sidecar +
		// `needsAnswers:true` on the item body in ONE commit) THEN releases the per-
		// item lock. Surface-FIRST, release-SECOND, with `main`-authoritative crash
		// recovery inherited from {@link runTreelessLedgerMove}. The recoverable work
		// is already committed on the kept `work/<slug>` branch (intact on the arbiter).
		const surfaced = await bounceThroughSurface({
			cwd: input.cwd,
			slug: input.slug,
			item: `task:${input.slug}`,
			reason: input.reason,
			questions: input.questions,
			arbiter: input.arbiter,
			env: input.env,
			note: input.note,
		});
		return {moved: surfaced.moved, reasonNotMoved: surfaced.reasonNotMoved};
	},

	/**
	 * The resolve-needs-attention transition under the SAME strategy — satisfying
	 * the INTENT "clear the stuck surface + restore active." It delegates to
	 * the resume lock amend (post lock-cutover — `stuck → active` on the per-item
	 * lock, no reverse `needs-attention/ → in-progress/` folder move) and, when an
	 * `arbiter` is given, CAS-publishes that lock amend to the arbiter's lock ref —
	 * CLEARING the stuck surface there (the item is active again). Same
	 * all-or-nothing, never-`--force` publish. The lock-ref amend is a detail of
	 * THIS strategy; the seam's contract is only the intent "clear the surface."
	 */
	async applyResolveNeedsAttentionTransition(
		_input: ApplyResolveNeedsAttentionTransitionInput,
	): Promise<ApplyResolveNeedsAttentionTransitionResult> {
		// Post-`retire-stuck-lock-state`: the `stuck` lock state is retired, so
		// there is no `stuck → active` lock amend to perform. A parked item is
		// now a `needsAnswers:true` pool item on `main` with a sidecar, drained
		// by the apply rung (answer the sidecar), not by a resolve verb. The seam
		// is kept for source compatibility of its remaining legacy callers
		// (start.ts's legacy `needs-attention/` folder branch), where it is a
		// recorded no-op success.
		return {moved: true};
	},
};

/**
 * The SOLE stuck-state RECORD (PR-2b, spec
 * `surface-stuck-as-questions-and-retire-stuck-lock-state`, user stories 1/3/8,
 * decisions #1/#4): surface the bounced item as a `stuck`-kind sidecar +
 * `needsAnswers:true` on the item body in ONE commit on `<arbiter>/main`, THEN
 * release the per-item lock. Surface-FIRST, release-SECOND — the ordering is
 * load-bearing so a crash between them is recoverable from `main` (the classifier
 * fold in `item-lock.ts` re-derives `cleared-stale` from the main-side truth
 * PR-2a landed). This REPLACES the retired `active → stuck` lock amend: no
 * bounce leaves a `stuck` lock; a bounced item rests as a plain `needsAnswers:true`
 * pool item (`eligible:false` by construction).
 *
 * The OUTCOME MAPPING onto `{moved}`:
 *   - `surfaced`        — the sidecar + `needsAnswers:true` commit landed on
 *     `<arbiter>/main` and the lock was released ⇒ `moved: true`.
 *   - `bodyAbsent`      — the D1 probe found no body for the item on `main` (a
 *     bounce for an item whose body never landed — e.g. a claim that lost/raced).
 *     The surface is a CLEAN NO-OP; the lock is STILL released so the bounce is
 *     never a dead-end held lock ⇒ `moved: true` (nothing to record, nothing left
 *     stuck).
 *   - `!surfaced`       — the surface commit did NOT land (contention exhausted,
 *     item missing on main by explicit path, environment fault) ⇒ `moved: false`
 *     with `reasonNotMoved` so the caller reports the honest not-landed state.
 *   - no arbiter        — a human local-only `complete` (no arbiter handle): the
 *     surface primitive requires an arbiter, so this is a recorded no-op (`moved:
 *     true`) — a human is right there (the same human-vs-autonomous posture the
 *     retired lock amend took). NOTE this records nothing durable, by design.
 */
async function bounceThroughSurface(params: {
	cwd: string;
	slug: string;
	item: string;
	reason: string;
	questions?: string[];
	arbiter?: string;
	env?: NodeJS.ProcessEnv;
	note?: (message: string) => void;
}): Promise<{moved: boolean; reasonNotMoved?: string}> {
	const {cwd, slug, item, reason, questions, arbiter, env} = params;
	const note = params.note ?? (() => {});
	if (!arbiter) {
		// No arbiter handle ⇒ no `<arbiter>/main` to surface on. A human local-only
		// `complete`: the human is right there, so this is a recorded no-op (parity
		// with the retired local-only lock amend that wrote nothing cross-machine).
		note(
			`'${slug}' bounced locally (no arbiter) — the stuck reason is not surfaced ` +
				'on <arbiter>/main (a human is right here).',
		);
		return {moved: true};
	}
	const asNewQuestions: NewQuestion[] | undefined = questions?.map((q) => ({
		question: q,
		kind: 'stuck' as const,
	}));
	try {
		const r = await surfaceStuckToNeedsAttention({
			cwd,
			slug,
			item,
			reason,
			questions: asNewQuestions,
			arbiter,
			env,
			note,
		});
		if (r.surfaced) {
			note(`Surfaced '${item}' on ${arbiter}/main (stuck): ${reason}`);
			return {moved: true};
		}
		if (r.bodyAbsent) {
			note(
				`'${item}' has no body on ${arbiter}/main — surface skipped as a clean ` +
					'no-op; the lock was still released to avoid a dead-end held lock.',
			);
			return {moved: true};
		}
		const reasonNotMoved =
			r.reasonNotSurfaced ??
			`could not surface '${item}' on ${arbiter}/main (unknown reason).`;
		note(reasonNotMoved);
		return {moved: false, reasonNotMoved};
	} catch (err) {
		const reasonNotMoved =
			`could not surface '${item}' on ${arbiter}/main ` +
			`(${err instanceof Error ? err.message : String(err)}).`;
		note(reasonNotMoved);
		return {moved: false, reasonNotMoved};
	}
}

/**
 * The active ledger-write strategy. There is exactly one (current behaviour);
 * this indirection is the seam's single insertion point — NOT a selectable mode.
 */
export const ledgerWrite: LedgerWriteStrategy = currentLedgerWrite;
