import {discoverJobs, type GcJob} from './gc.js';
import {resolveHarness, type Harness} from './harness.js';
// Import for the registration side-effect: ensures the `pi` adapter is in the
// harness registry so `resolveHarness` dispatches pi jobs' liveness to it.
import './pi-harness.js';
import {type JobState} from './workspace.js';
import {fetchMirrorMainOrWarn} from './repo-mirror.js';
import {formatArbiterStatus, type ArbiterStatusReport} from './arbiter.js';
import {
	listItemLockEntries,
	classifyTerminalItemLocks,
	reconcileTerminalItemLocks,
	type LockEntry,
} from './item-lock.js';
import {formatCwdSection, formatLockEntryLines} from './format.js';
import type {CwdSection} from './cwd-section.js';
import {
	lintRefLedger,
	formatDuplicateWarnings,
	type DuplicateSlug,
} from './ledger-lint.js';

/**
 * `dorfl status` — the **operational dashboard of jobs** (ADR §4/§5/§12
 * in `docs/adr/execution-substrate-decisions.md`). Split out of
 * `agent-workspaces` so the substrate stays thin; this module owns the view.
 *
 * It lists the jobs under `<workspacesDir>/work/*` from their
 * `.dorfl-job.json` records + worktree state, grouped by state:
 *
 *   - **active** — `running` AND the harness reports the job still alive.
 *   - **failed / retained** — everything that wants a human's eye: a job the
 *     `needs-attention` mechanism flagged (with its reason, ADR §12), a `done`
 *     job whose worktree was never reaped (awaiting cleanup), or a `running`
 *     job whose harness reports it DEAD (crashed — the runner died mid-flight).
 *
 * **Liveness comes from the harness seam (PID / session), NOT filesystem mtime**
 * (ADR §5): a live agent can think for minutes without writing files, so mtime
 * would mistake a thinking agent for a dead one. The harness answers liveness
 * from the real signal.
 *
 * **Fetch-first (ADR §5/§6):** the per-mirror lock-ref + one-slug-one-folder
 * lint surfaces are read AFTER refreshing each registered hub mirror's `main` —
 * the old "scan is always offline" framing is RETIRED (it was the roots-local
 * model). A failed mirror fetch is NOT fatal: it WARNS and falls back to that
 * mirror's last-known `main`. The ledger read STRATEGY is unchanged
 * (`claim-ledger-vs-protected-main.md`); `status` only ensures the ref is fresh.
 *
 * It is strictly **read-only**: it inspects records/worktrees; it never claims,
 * runs, moves, or deletes (deletion is `gc`). It reuses the `gc` `discoverJobs`
 * primitive to enumerate jobs (it does NOT re-implement the work-area layout).
 *
 * Distinct from `scan`: `scan` answers "what work is in the *backlog* and who
 * can take it"; `status` answers "what is *running / stuck / awaiting cleanup*
 * right now". The retained-worktree + stuck-lock items are the "look here" set.
 */

/** One job as the operational dashboard sees it (a record + its liveness). */
export interface JobStatus {
	/** The work slug being processed. */
	slug: string;
	/** The encoded repo key the job's hub mirror was cut from. */
	repo: string;
	/** The work branch checked out in the worktree (`work/<slug>`). */
	branch: string;
	/** ISO timestamp the job worktree was created. */
	startedAt: string;
	/** The persisted lifecycle state. */
	state: JobState;
	/** Liveness FROM THE HARNESS SEAM (PID/session), never mtime (ADR §5). */
	alive: boolean;
	/**
	 * Why the job is stuck (ADR §12), when known — surfaced for the
	 * failed/retained group. Present for `needs-attention` jobs that recorded a
	 * reason; absent otherwise.
	 */
	reason?: string;
	/**
	 * The review-request URL (e.g. a GitHub PR) opened for this job, when a
	 * `propose`-mode provider opened one (ADR §6). Surfaced so the human can jump
	 * straight to the PR. Absent otherwise.
	 */
	prUrl?: string;
	/** Absolute path to the job worktree (for the human to look). */
	dir: string;
}

/**
 * One repo's PER-ITEM LOCK refs, surfaced for the dashboard (spec
 * `ledger-status-per-item-lock-refs` US #8; task
 * `needs-attention-as-stuck-lock-state`). The in-flight view read from the lock
 * refs — held (`active` = in-progress) and stuck (`needs-attention`) entries +
 * their reasons — is the SOLE stuck-state surface (the
 * `work/needs-attention/` folder is retired, task
 * `cutover-needs-attention-becomes-lock-stuck-recovery-surface`).
 */
export interface RepoLockEntries {
	/** The repo path whose lock refs were read (a hub-mirror path). */
	repoPath: string;
	/** The held lock entries (action × state + reason), sorted by entry. */
	entries: LockEntry[];
}

/** One repo's STALE per-item locks: entries whose item has already come to rest
 * in a terminal folder on that repo's `main`, so the hold is finished work
 * awaiting release rather than an in-flight claim. */
export interface RepoStaleLocks {
	/** The repo path whose lock refs were classified (a hub-mirror path). */
	repoPath: string;
	/** The stale lock `<entry>` names, sorted. */
	entries: string[];
}

/** One repo's one-slug-one-folder LINT result, surfaced for the dashboard. */
export interface RepoLedgerDuplicates {
	/** The repo path whose `work/` ledger was linted (a hub-mirror path). */
	repoPath: string;
	/** The slugs present in more than one status folder (non-empty here). */
	duplicates: DuplicateSlug[];
}

/** The operational groups `status` reports. */
export interface StatusReport {
	/** Running jobs the harness reports still alive. */
	active: JobStatus[];
	/** Stuck (needs-attention), crashed (running-but-dead), or un-reaped (done) jobs. */
	attention: JobStatus[];
	/**
	 * The PER-ITEM LOCK in-flight view (spec `ledger-status-per-item-lock-refs` US
	 * #8; task `needs-attention-as-stuck-lock-state`): per registered hub mirror,
	 * the held lock entries read from the mirror's `refs/dorfl/lock/*` refs —
	 * `active` holds (in-progress) and `stuck` holds (needs-attention) + reasons.
	 * This is the SOLE stuck-state surface (the `work/needs-attention/` folder is
	 * retired, task
	 * `cutover-needs-attention-becomes-lock-stuck-recovery-surface`). Only repos
	 * WITH at least one held lock appear. Empty when no `mirrorPaths` were given or
	 * no locks are held. Optional so older literals stay valid; `status()` always
	 * populates it (possibly empty).
	 */
	lockHeld?: RepoLockEntries[];
	/**
	 * Per registered hub mirror, the lock `<entry>` names whose item is already at
	 * REST in a terminal folder on that mirror's `main`, finished work (typically
	 * a merged propose PR) whose lock has not been released yet. Reported
	 * SEPARATELY from {@link StatusReport.lockHeld}, and deliberately excluded from
	 * it, so completed work never reads as in-progress (the symptom of the
	 * propose-path lock leak). `status` RELEASES nothing by default, it is
	 * read-only; these drain on the next claim, or under `--reconcile-locks`.
	 */
	staleLocks?: RepoStaleLocks[];
	/**
	 * The one-slug-one-folder LINT (spec `ledger-integrity` story 3): per registered
	 * hub mirror, any slug present in MORE THAN ONE `work/` status folder (a corrupt
	 * ledger). Read from the mirror's bare `main` ref (the SAME `ls-tree` source the
	 * needs-attention surface uses). Only repos WITH a duplicate appear. `status`
	 * WARNS loudly about each (never a silent pass); a human resolves it. Empty when
	 * no `mirrorPaths` were given or every ledger is clean.
	 */
	ledgerDuplicates?: RepoLedgerDuplicates[];
	/**
	 * The current repo's arbiter state (folded in from the old `arbiter status`,
	 * ADR §1/§7): which remote, URL/path, exists/bare, main reachable, and the
	 * unsafe non-bare-with-main flag. Present only when the CLI resolved one (it is
	 * a current-checkout concern); absent for the pure job-area dashboard.
	 */
	arbiter?: ArbiterStatusReport;
	/**
	 * The CWD-LOCAL section (the `scan-status-read-cwd-repo` task): when `status`
	 * runs INSIDE a participating repo, this is that CURRENT repo read from its
	 * LOCAL WORKING TREE (fetch-its-arbiter-first), reported as a DISTINCT,
	 * separately-counted block alongside (never merged into) the registry view.
	 * Absent when the cwd does not participate or the caller did not resolve it.
	 */
	cwd?: CwdSection;
}

export interface StatusOptions {
	/** The execution working area to inspect (config `workspacesDir`). */
	workspacesDir: string;
	/**
	 * The harness used to answer liveness (PID/session — never mtime). When given,
	 * it answers liveness for EVERY job (tests inject a stub here). When omitted,
	 * each job's liveness is answered by the adapter that OWNS its record
	 * (`resolveHarness` keyed off the record's `adapter`) — so a `pi` job reports
	 * via the pi adapter (PID + session pointer) and a `null` job via the null
	 * adapter, never mtime.
	 */
	harness?: Harness;
	/**
	 * Hub-mirror PATHS whose lock refs + one-slug-one-folder lint to surface, read
	 * from each mirror's BARE `main` ref (mirrors have no working tree). The CLI
	 * wires these from the registry's {@link listMirrors}. `status` FETCHES each
	 * mirror's `main` first (ADR §5/§6 — the registry's remote is the source of
	 * truth); a failed fetch WARNS and falls back to last-known (never errors).
	 * Omitted ⇒ only the job worktrees are reported.
	 */
	mirrorPaths?: string[];
	/**
	 * OPT-IN WRITE (`status --reconcile-locks`). `false`/omitted (the DEFAULT)
	 * keeps `status` strictly READ-ONLY: stale locks are classified and REPORTED
	 * via {@link StatusReport.staleLocks} and nothing on any arbiter is touched.
	 * `true` additionally RELEASES them. Not needed for routine convergence, the
	 * claim path already sweeps on every unit of work; this is the manual
	 * "drain them now" lever.
	 */
	reconcileLocks?: boolean;
	/**
	 * Sink for the fetch-first fall-back warning (ADR §5/§6): when a mirror's `main`
	 * cannot be fetched, `status` warns through this and reads that mirror's
	 * last-known state. The CLI wires it to the standard `>>` stderr note.
	 */
	warn?: (message: string) => void;
	/**
	 * The current repo's arbiter state to fold into the dashboard (the old `arbiter
	 * status`, ADR §1). The CLI resolves it via `arbiterStatus` for the current
	 * checkout; omitted ⇒ no arbiter section.
	 */
	arbiter?: ArbiterStatusReport;
	/**
	 * The pre-resolved CWD-LOCAL section (the `scan-status-read-cwd-repo` task).
	 * The CLI resolves it via `resolveCwdSection` (cwd participation + fetch-first
	 * divergence + registry de-dup) and hands it here; `status` carries it onto the
	 * report and `formatStatus` renders it as a distinct local block. Omitted ⇒ no
	 * local section.
	 */
	cwd?: CwdSection;
	env?: NodeJS.ProcessEnv;
}

/**
 * Build the operational status of every job under `<workspacesDir>/work/*`
 * (ADR §4/§5/§12). READ-ONLY: enumerates job records via the `gc` `discoverJobs`
 * primitive, asks the harness for liveness (NOT mtime), and groups each job as
 * **active** (running + alive) or **failed/retained** (needs-attention, a
 * crashed running-but-dead job, or a done-but-un-reaped one). Mutates nothing —
 * no claim/run/move/delete.
 */
export async function status(options: StatusOptions): Promise<StatusReport> {
	const active: JobStatus[] = [];
	const attention: JobStatus[] = [];

	for (const job of discoverJobs(options.workspacesDir)) {
		const view = toJobStatus(job, options.harness);
		// Active iff the runner believes the job is in flight (`running`) AND the
		// harness confirms it is still alive. Everything else is "look here":
		//   - needs-attention: the runner flagged it (gate red, conflict, …)
		//   - done: landed but the worktree wasn't reaped (awaiting cleanup)
		//   - running but NOT alive: the process died mid-flight (crashed)
		if (view.state === 'running' && view.alive) {
			active.push(view);
		} else {
			attention.push(view);
		}
	}

	active.sort(bySlug);
	attention.sort(bySlug);

	// The STUCK-STATE surface is now the PER-ITEM LOCK `state: stuck` (task
	// `cutover-needs-attention-becomes-lock-stuck-recovery-surface`, decision i+:
	// the `needs-attention/` folder is retired — NO code reads
	// `work/needs-attention/`). `status` reads the lock refs per mirror to surface
	// held (`active` = in-progress) AND stuck (`needs-attention`) entries + their
	// reasons/questions.
	const lockHeld: RepoLockEntries[] = [];
	const staleLocks: RepoStaleLocks[] = [];
	const ledgerDuplicates: RepoLedgerDuplicates[] = [];
	for (const mirrorPath of options.mirrorPaths ?? []) {
		// Fetch-first (ADR §5/§6): refresh this mirror's `main` so the duplicate lint
		// reflects the remote truth. Never fatal — a failed fetch WARNS and falls back
		// to the mirror's last-known `main`.
		fetchMirrorMainOrWarn({mirrorPath, warn: options.warn, env: options.env});
		// CLASSIFY the mirror's held locks against its `main` (fix for the propose-path
		// lock leak; observation
		// `every-completed-task-leaves-its-lock-ref-reporting-in-progress`). A
		// `complete --propose` KEEPS its lock held across the open PR and defers the
		// release to the merge, an event no dorfl process is present for (no hook, no
		// daemon), so the release never fired and every completed item reported
		// in-progress for ever.
		//
		// `status` is READ-ONLY and stays that way: by DEFAULT we only classify, so a
		// lock whose item has come to REST in a terminal folder on the mirror's `main`
		// is reported as STALE rather than listed in-flight. The refs themselves are
		// drained by the paths that already write on every unit of work (the claim
		// path), or here under the explicit `--reconcile-locks` opt-in. An item on an
		// OPEN PR (still in the pool on `main`) stays in-flight either way.
		// Best-effort and never throws, any fault treats the lock as HELD.
		//
		// A hub mirror is a BARE clone with no `refs/remotes/*` namespace, so its copy
		// of the arbiter's main is the plain `main` ref (the SAME ref
		// `fetchMirrorMainOrWarn` above and `lintRefLedger` below read). Passing the
		// default `origin/main` here would fail EVERY probe with `invalid object name`
		// and silently classify every lock as in-flight.
		const MIRROR_MAIN = {mainRef: 'main'};
		let staleEntries: string[] = [];
		let entries: LockEntry[];
		if (options.reconcileLocks === true) {
			const reconciled = await reconcileTerminalItemLocks(
				mirrorPath,
				'origin',
				options.env,
				MIRROR_MAIN,
			);
			if (reconciled.released.length > 0) {
				options.warn?.(
					`${mirrorPath}: released ${reconciled.released.length} stale per-item ` +
						'lock(s) whose item is terminal on main (work landed; the ' +
						`propose PR merged out-of-band): ${reconciled.released.join(', ')}`,
				);
			}
			// Under an EXPLICIT drain request a refusal must be reported: the operator
			// asked for these to go away, so silence would be a lie.
			for (const e of reconciled.errors) {
				options.warn?.(
					`${mirrorPath}: could not release '${e.entry}': ${e.message}`,
				);
			}
			entries = reconciled.stillHeld;
		} else {
			const classified = await classifyTerminalItemLocks(
				mirrorPath,
				'origin',
				options.env,
				MIRROR_MAIN,
			);
			staleEntries = classified.terminal.map((l) => l.entry);
			entries = classified.inFlight;
		}
		// The PER-ITEM LOCK in-flight view (spec US #8): read the mirror's lock refs to
		// surface held (`active` = in-progress) and stuck (`needs-attention`) entries +
		// reasons/questions. A bare hub mirror's arbiter is its `origin` (the SAME
		// handle the `scan` held-slug subtraction reads). Best-effort: a fetch/read
		// fault yields an EMPTY list (see {@link listItemLockEntries}), so this
		// read-only view degrades to "no in-flight locks" rather than erroring.
		// `entries` comes STRAIGHT from the classification above (its `inFlight`
		// partition, or `stillHeld` after a sweep), so the stale ones are already
		// excluded: finished work is not an in-flight hold, and listing it as one is
		// the exact symptom being fixed. Reusing that result also avoids a SECOND
		// `ls-remote` + fetch per mirror, and the TOCTOU window between two reads.
		if (entries.length > 0) {
			lockHeld.push({repoPath: mirrorPath, entries});
		}
		if (staleEntries.length > 0) {
			staleLocks.push({repoPath: mirrorPath, entries: staleEntries});
		}
		// The one-slug-one-folder LINT (spec story 3): derive any slug residing in >1
		// status folder from the SAME freshly-fetched `main` ref, surfaced LOUDLY.
		const dups = lintRefLedger('main', mirrorPath, options.env);
		if (dups.length > 0) {
			ledgerDuplicates.push({repoPath: mirrorPath, duplicates: dups});
		}
	}
	lockHeld.sort((a, b) => a.repoPath.localeCompare(b.repoPath));
	staleLocks.sort((a, b) => a.repoPath.localeCompare(b.repoPath));
	ledgerDuplicates.sort((a, b) => a.repoPath.localeCompare(b.repoPath));

	return {
		active,
		attention,
		lockHeld,
		staleLocks,
		ledgerDuplicates,
		...(options.arbiter ? {arbiter: options.arbiter} : {}),
		...(options.cwd ? {cwd: options.cwd} : {}),
	};
}

function bySlug(a: JobStatus, b: JobStatus): number {
	return a.slug.localeCompare(b.slug);
}

/**
 * Project a discovered job + its harness liveness into a `JobStatus`. When no
 * harness is forced (the normal case), each record's liveness is answered by the
 * adapter that OWNS it (`resolveHarness`) — a pi job via the pi adapter (PID +
 * session), never mtime.
 */
function toJobStatus(job: GcJob, forced: Harness | undefined): JobStatus {
	const record = job.record;
	const harness =
		forced ?? (record ? resolveHarness(record.harness) : undefined);
	const alive =
		record !== undefined && harness !== undefined
			? harness.isAlive(record.harness)
			: false;
	return {
		slug: job.slug,
		repo: record?.repoKey ?? '(unknown)',
		branch: job.branch,
		startedAt: record?.startedAt ?? '(unknown)',
		state: record?.state ?? 'running',
		alive,
		reason: record?.reason,
		prUrl: record?.prUrl,
		dir: job.dir,
	};
}

/**
 * Render the operational status for the terminal: an **Active jobs** section and
 * a **Failed / retained jobs** section, each line carrying slug, repo, branch,
 * and started-at — plus, for stuck jobs, the recorded reason, and for a
 * running-but-dead job a `(crashed — no longer alive)` marker.
 *
 * Deliberately framed in terms of **jobs** (running / stuck / awaiting cleanup),
 * NOT the backlog *queue* — that is what keeps it visibly distinct from `scan`.
 */
export function formatStatus(report: StatusReport): string {
	const lines: string[] = [];

	// The cwd-local section (the `scan-status-read-cwd-repo` task): a DISTINCT,
	// separately-counted block for the CURRENT repo's working tree, ABOVE the
	// job/registry dashboard (never merged into the job counts).
	const cwdLines = report.cwd !== undefined ? formatCwdSection(report.cwd) : [];

	const lockHeld = report.lockHeld ?? [];
	const lockCount = lockHeld.reduce((sum, r) => sum + r.entries.length, 0);
	const staleLocks = report.staleLocks ?? [];
	const staleCount = staleLocks.reduce((sum, r) => sum + r.entries.length, 0);
	const ledgerDuplicates = report.ledgerDuplicates ?? [];
	const dupCount = ledgerDuplicates.reduce(
		(sum, r) => sum + r.duplicates.length,
		0,
	);
	if (
		report.active.length === 0 &&
		report.attention.length === 0 &&
		lockCount === 0 &&
		// A repo whose ONLY locks are stale must not print "the work area is empty":
		// that would turn the old "wrongly shown as in-progress" bug into a worse
		// "not shown at all" one.
		staleCount === 0 &&
		dupCount === 0 &&
		report.arbiter === undefined &&
		cwdLines.length === 0
	) {
		return 'No jobs running or retained (the work area is empty).';
	}

	if (cwdLines.length > 0) {
		lines.push(...cwdLines);
		lines.push('');
	}

	lines.push('Active jobs (running):');
	if (report.active.length === 0) {
		lines.push('  (none)');
	} else {
		for (const job of report.active) {
			lines.push(formatJobLine(job));
		}
	}
	lines.push('');

	lines.push('Failed / retained jobs (look here):');
	if (report.attention.length === 0) {
		lines.push('  (none)');
	} else {
		for (const job of report.attention) {
			lines.push(formatJobLine(job));
		}
	}

	// The PER-ITEM LOCK in-flight view (spec US #8; task
	// `cutover-needs-attention-becomes-lock-stuck-recovery-surface`): the held lock
	// refs read from each mirror — `active` holds (in-progress) and `stuck` holds
	// (needs-attention) + their reasons/questions. This is the SOLE stuck-state
	// surface now (the `needs-attention/` folder is retired).
	if (lockCount > 0) {
		lines.push('');
		lines.push('In-flight locks (refs/dorfl/lock/* — held + stuck):');
		for (const repo of lockHeld) {
			lines.push(`  ${repo.repoPath}`);
			for (const entry of repo.entries) {
				// SHARED renderer (NOT a forked one) so the cwd section
				// (`formatCwdSection`) presents a held/stuck item identically.
				lines.push(...formatLockEntryLines(entry, '    '));
			}
		}
	}

	// STALE locks: finished work whose lock has not been released yet (the
	// propose-path lock leak). Rendered as its OWN block and deliberately NOT under
	// "In-flight locks" above, because reporting completed work as in-progress for
	// ever was the symptom. `status` is read-only, so it names the state and how it
	// clears rather than clearing it.
	if (staleCount > 0) {
		lines.push('');
		lines.push(
			`Completed, lock not yet released (${staleCount}; the item is at rest on ` +
				'main, so this is NOT in flight):',
		);
		for (const repo of staleLocks) {
			lines.push(`  ${repo.repoPath}`);
			for (const entry of repo.entries) {
				lines.push(`    ${entry}`);
			}
		}
		lines.push(
			'  These clear automatically on the next claim. To drain them now: ' +
				'`dorfl status --reconcile-locks`.',
		);
	}

	// The one-slug-one-folder LINT (spec `ledger-integrity` story 3): WARN LOUDLY
	// about every slug residing in >1 status folder of a registered mirror's ledger
	// (a corrupt ledger — never a silent pass). A human must resolve each.
	if (dupCount > 0) {
		lines.push('');
		for (const repo of ledgerDuplicates) {
			lines.push(`  ${repo.repoPath}`);
			for (const w of formatDuplicateWarnings(repo.duplicates)) {
				lines.push(`  ${w}`);
			}
		}
	}

	lines.push('');
	lines.push(
		`Summary: ${report.active.length} active, ${report.attention.length} failed/retained job(s)` +
			(lockCount > 0 ? `, ${lockCount} in-flight lock(s)` : '') +
			(dupCount > 0 ? `, ${dupCount} one-slug-one-folder violation(s)` : '') +
			'.',
	);

	// The folded-in arbiter state (ADR §1/§7, the old `arbiter status`).
	if (report.arbiter !== undefined) {
		lines.push('');
		lines.push(formatArbiterStatus(report.arbiter));
	}

	return lines.join('\n');
}

/** One `slug  repo  branch  started-at  [marker]` job line, with reason below. */
function formatJobLine(job: JobStatus): string {
	const marker = jobMarker(job);
	const head = `  ${job.slug}   ${job.repo}   ${job.branch}   started ${job.startedAt}${marker}`;
	const extra: string[] = [];
	if (job.reason !== undefined && job.reason !== '') {
		extra.push(`      reason: ${job.reason}`);
	}
	if (job.prUrl !== undefined && job.prUrl !== '') {
		extra.push(`      PR: ${job.prUrl}`);
	}
	return extra.length > 0 ? [head, ...extra].join('\n') : head;
}

/**
 * A trailing marker that explains WHY a non-active job is in the look-here group:
 * a `running` job the harness reports dead is a **crashed** runner; a `done` job
 * is **awaiting cleanup** (`gc` will reap it); a `needs-attention` job is
 * **stuck** (its reason is rendered separately).
 */
function jobMarker(job: JobStatus): string {
	if (job.state === 'running' && !job.alive) {
		return '   (crashed — no longer alive)';
	}
	if (job.state === 'done') {
		return '   (done — awaiting cleanup)';
	}
	if (job.state === 'needs-attention') {
		return '   (needs attention)';
	}
	return '';
}
