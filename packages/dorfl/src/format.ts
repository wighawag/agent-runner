import type {ScanReport, ScannedItem} from './scan.js';
import type {CwdSection} from './cwd-section.js';
import type {LockEntry} from './item-lock.js';
import {formatDuplicateWarnings} from './ledger-lint.js';
import {
	categoriseItems,
	summariseGroups,
	CATEGORY_ORDER,
	CATEGORY_LABELS,
	type CategorisedItem,
	type CategorisedGroups,
} from './categorise.js';

/**
 * Human label for the two autonomy axes. `humanOnly` is reported first when both
 * are set, so the REASON an agent is gated is always visible and distinct from
 * `needsAnswers`.
 */
export function gateLabel(
	humanOnly: boolean | undefined,
	needsAnswers?: boolean | undefined,
): string {
	if (humanOnly === true) {
		return 'human-only';
	}
	if (needsAnswers === true) {
		return 'needs-answers';
	}
	return 'undeclared';
}

/** A short description of the `blockedBy` readiness for one item. */
function readinessLabel(item: ScannedItem): string {
	if (item.blockedBy.length === 0) {
		return 'deps: satisfied (none)';
	}
	if (item.eligibility.blockedBy.satisfied) {
		return `deps: satisfied (${item.blockedBy.join(', ')})`;
	}
	return `deps: waiting on ${item.eligibility.blockedBy.missing.join(', ')}`;
}

/** Ready items get a filled marker, blocked ones an open one. */
function readinessMarker(entry: CategorisedItem): string {
	return entry.ready ? '*' : 'o';
}

function formatItem(entry: CategorisedItem): string {
	return `      ${readinessMarker(entry)} ${entry.item.slug}   ${readinessLabel(entry.item)}`;
}

/** Render one repo's three labelled groups; empty groups show `(none)`. */
function formatRepo(path: string, groups: CategorisedGroups): string[] {
	const lines: string[] = [];
	lines.push(`  ${path}`);
	lines.push('');
	for (const category of CATEGORY_ORDER) {
		lines.push(`    ${CATEGORY_LABELS[category]}:`);
		const entries = groups[category];
		if (entries.length === 0) {
			lines.push('      (none)');
		} else {
			for (const entry of entries) {
				lines.push(formatItem(entry));
			}
		}
	}
	lines.push('');
	return lines;
}

function pluralRepos(n: number): string {
	return n === 1 ? 'repo' : 'repos';
}

function pluralItems(n: number): string {
	return n === 1 ? 'item' : 'items';
}

/**
 * The divergence-vs-arbiter line for the cwd-local section, using the
 * `main-divergence-guard` framing: local `main` AHEAD of `<arbiter>/main` means
 * UNPUSHED commits (the local working tree is more authoritative than the
 * arbiter for those); BEHIND means the arbiter has commits the local tree lacks.
 * When the fetch failed it says so (the divergence reflects last-known).
 */
function cwdDivergenceLine(
	arbiter: NonNullable<CwdSection['arbiter']>,
): string {
	const freshness = arbiter.fetched
		? 'fetched just now'
		: 'FETCH FAILED — last-known (offline)';
	const {ahead, behind, remote} = arbiter;
	if (ahead === 0 && behind === 0) {
		return `      in sync with ${remote}/main (${freshness}).`;
	}
	const parts: string[] = [];
	if (ahead > 0) {
		parts.push(`${ahead} commit${ahead === 1 ? '' : 's'} ahead (unpushed)`);
	}
	if (behind > 0) {
		parts.push(`${behind} commit${behind === 1 ? '' : 's'} behind`);
	}
	return `      local main is ${parts.join(', ')} vs ${remote}/main (${freshness}).`;
}

/**
 * Render the CWD-LOCAL section of `scan`/`status` (the `scan-status-read-cwd-repo`
 * task): a DISTINCT, separately-counted block for the CURRENT repo, read from
 * the LOCAL WORKING TREE (NOT the registry's bare mirror ref). Returns `[]` when
 * the cwd does NOT participate (no local section). The section LABELS its source
 * + freshness, shows the divergence-vs-arbiter (`main-divergence-guard` framing),
 * and — when the cwd participates but is NOT registered — teaches
 * self-registration instead of the dead-end "No participating repos found".
 *
 * The counts here are the cwd's OWN (never merged into the registry total — the
 * consistency rule): the two reads have different freshness + storage models.
 */
/**
 * Render ONE held per-item lock entry as an indented line, the SHARED renderer
 * for the in-flight lock surface on BOTH the registry view (`formatStatus`) and
 * the cwd section (`formatCwdSection`). Post-`retire-stuck-lock-state` the
 * lock state is degenerate (`active` only) — a held lock is always an
 * in-progress hold; a parked item is a `needsAnswers:true` pool item on `main`
 * with a sidecar, rendered by the pool categoriser (NOT here).
 */
export function formatLockEntryLines(
	entry: LockEntry,
	indent: string,
): string[] {
	return [
		`${indent}${entry.entry}   (${entry.action}/${entry.state} = in-progress)`,
	];
}

export function formatCwdSection(section: CwdSection): string[] {
	if (!section.participating || section.repo === undefined) {
		return [];
	}
	const lines: string[] = [];
	const dedup = section.alsoRegistered === true ? ' (also registered)' : '';
	lines.push('This repo (local working tree):');
	lines.push(`  ${section.path}${dedup}`);
	lines.push(
		'  source: local working tree (may be ahead of / behind the arbiter) — ' +
			'distinct from the registry view below (arbiter main, fetched).',
	);

	// Fetch-first divergence-vs-arbiter (or a no-arbiter note).
	if (section.arbiter !== undefined) {
		lines.push(cwdDivergenceLine(section.arbiter));
	} else {
		lines.push(
			'      no arbiter remote configured — divergence vs arbiter unknown.',
		);
	}

	const total = section.totalItems ?? 0;
	// Self-registration hint when the cwd participates but is NOT registered.
	if (section.alsoRegistered !== true) {
		lines.push('');
		lines.push(
			`  This repo participates (${total} backlog ${pluralItems(total)}) but is ` +
				'NOT registered — `run`/`scan` across machines won’t see it until ' +
				'`dorfl remote add . --local` (or `remote add <its-url>`).',
		);
	}

	// The cwd's grouped backlog — the SAME who-can-take-it grouping the registry
	// view uses, but read from the working tree and counted SEPARATELY.
	const groups = categoriseItems(section.repo.items);
	lines.push('');
	for (const category of CATEGORY_ORDER) {
		lines.push(`    ${CATEGORY_LABELS[category]}:`);
		const entries = groups[category];
		if (entries.length === 0) {
			lines.push('      (none)');
		} else {
			for (const entry of entries) {
				lines.push(formatItem(entry));
			}
		}
	}

	// The PER-ITEM LOCK in-flight SURFACE for the cwd (spec
	// `ledger-status-per-item-lock-refs` US #8): held (`active` = in-progress) and
	// `stuck` (= needs-attention) lock entries + their reasons. This is what keeps a
	// held/stuck cwd item from vanishing: the held-slug subtraction removes it from
	// the buckets above, so without THIS block it would be invisible (the regression
	// this fixes). Symmetric with the registry view's `In-flight locks` block (same
	// `refs/dorfl/lock/*` source, same primitive); rendered HERE inside the cwd
	// section so it stays the cwd's OWN, separately-counted surface. Empty ⇒ no
	// block (a calm repo adds no lines).
	const lockHeld = section.repo.lockHeld ?? [];
	if (lockHeld.length > 0) {
		lines.push('');
		lines.push('    In progress (lock held — refs/dorfl/lock/*):');
		for (const entry of lockHeld) {
			lines.push(...formatLockEntryLines(entry, '      '));
		}
	}

	// STALE locks, finished work whose lock has not been released yet (fix for the
	// propose-path lock leak). `complete --propose` keeps the lock held and defers
	// its release to the PR merge, an event dorfl is never present for, so these
	// accumulate. They are shown as their OWN block and NOT under "In progress":
	// reporting completed work as in-progress for ever was the symptom. `status` is
	// read-only, so it names the state and how it clears rather than clearing it.
	const stale = section.staleLocks ?? [];
	if (stale.length > 0) {
		lines.push('');
		lines.push(
			`    Completed, lock not yet released (${stale.length}; item is at rest ` +
				'on main, so this is NOT in flight):',
		);
		for (const entry of stale) {
			lines.push(`      ${entry}`);
		}
		lines.push(
			'      These clear automatically on the next claim. To drain them now: ' +
				'`dorfl status --reconcile-locks`.',
		);
	}

	// STRANDED QUESTION STATE on terminal items: a bounce wrote a sidecar +
	// `needsAnswers:true` atomically, the human re-dispatched instead of answering,
	// the rebuild succeeded, and neither half was ever cleared. The flag is the
	// harmful part: it is a gate left armed over shipped work, which is why this is
	// surfaced rather than left to be discovered in the questions folder.
	const staleQuestions = section.staleQuestions ?? [];
	if (staleQuestions.length > 0) {
		lines.push('');
		lines.push(
			`    Completed, question state not yet cleared (${staleQuestions.length}; ` +
				'stale bounce sidecar and/or a needsAnswers gate on a finished item):',
		);
		for (const item of staleQuestions) {
			lines.push(`      ${item}`);
		}
		lines.push(
			'      These clear automatically on the next claim. To drain them now: ' +
				'`dorfl status --reconcile-locks`.',
		);
	}

	// A human's ANSWER that nothing ever applied. Never auto-drained, because the
	// prose is data the tool did not author; it needs a human, so it is named.
	const unapplied = section.unappliedAnswers ?? [];
	if (unapplied.length > 0) {
		lines.push('');
		lines.push(
			`    Answered but never applied (${unapplied.length}; the sidecar carries ` +
				'your answer and the item is already finished, kept, never auto-deleted):',
		);
		for (const item of unapplied) {
			lines.push(`      ${item}`);
		}
	}

	// Locks this run actually RELEASED (only under the explicit
	// `--reconcile-locks` opt-in, the one way `status` writes). Always reported,
	// never silent.
	const reconciled = section.reconciledLocks ?? [];
	if (reconciled.length > 0) {
		lines.push('');
		lines.push(
			`    Released ${reconciled.length} completed lock(s) (item is terminal on ` +
				'main, the propose PR merged out-of-band):',
		);
		for (const entry of reconciled) {
			lines.push(`      ${entry}`);
		}
	}
	lines.push('');
	lines.push(
		`  Local total: ${total} ${pluralItems(total)} ` +
			`(${section.totalEligible ?? 0} eligible) — this repo only, NOT merged with ` +
			'the registry total below.',
	);
	return lines;
}

/**
 * Render the cross-repo queue as a human decision dashboard: under each repo,
 * every backlog item is grouped by who-can-take-it (Agent-claimable now /
 * Human-only / Blocked), with empty groups shown as `(none)`. Within a group,
 * ready (deps-satisfied) items sort above blocked ones.
 *
 * The set of groups shown is INDEPENDENT of `autoBuild`; only the eligibility
 * *verdict* line reflects the policy (`report.totalEligible` counts an
 * agent-claimable item only when `autoBuild` is on).
 */
export function formatReport(report: ScanReport, cwd?: CwdSection): string {
	const lines: string[] = [];

	// The cwd-local section (the `scan-status-read-cwd-repo` task): a DISTINCT,
	// separately-counted block for the CURRENT repo, ABOVE the registry view.
	const cwdLines = cwd !== undefined ? formatCwdSection(cwd) : [];
	if (cwdLines.length > 0) {
		lines.push(...cwdLines);
		lines.push('');
	}

	// De-dup: when the cwd is ALSO registered, drop its registry row (shown once,
	// above, marked "(also registered)") so the same repo never appears twice.
	const registryRepos =
		cwd?.alsoRegistered === true && cwd.registeredMirrorPath !== undefined
			? report.repos.filter((r) => r.path !== cwd.registeredMirrorPath)
			: report.repos;

	if (registryRepos.length === 0) {
		// If the cwd participates we already rendered its local section above (no
		// dead-end). Otherwise keep the existing empty-state.
		if (cwdLines.length === 0) {
			lines.push('No participating repos found.');
			lines.push(
				'(A repo participates iff its work/ tree has lifecycle content in any ' +
					'pool: tasks/ready, tasks/backlog, specs/proposed, specs/ready, ' +
					'notes/observations, or questions.)',
			);
		} else {
			lines.push(
				'Registered repos: (none) — nothing registered in the registry yet.',
			);
		}
		return lines.join('\n').replace(/\n+$/, '');
	}

	lines.push('Registered repos (registry — arbiter main, fetched):');
	lines.push('');
	const allGroups: CategorisedGroups[] = [];
	for (const repo of registryRepos) {
		const groups = categoriseItems(repo.items);
		allGroups.push(groups);
		lines.push(...formatRepo(repo.path, groups));
		// The one-slug-one-folder LINT (spec `ledger-integrity` story 3): WARN LOUDLY
		// when any slug in this repo's ledger resides in >1 status folder (a corrupt
		// ledger — never a silent pass). Clean ledgers add no lines.
		const warnings = formatDuplicateWarnings(repo.ledgerDuplicates ?? []);
		if (warnings.length > 0) {
			lines.push(...warnings.map((w) => `  ${w}`));
			lines.push('');
		}
	}

	const s = summariseGroups(allGroups);
	const repoCount = registryRepos.length;
	const registryItems = registryRepos.reduce((n, r) => n + r.items.length, 0);
	const registryEligible = registryRepos.reduce(
		(n, r) => n + r.items.filter((i) => i.eligibility.eligible).length,
		0,
	);
	lines.push(
		`Registry summary: ${registryItems} item(s) across ${repoCount} ${pluralRepos(repoCount)} — ` +
			`${s.agentClaimable} agent-claimable, ${s.humanOnly} human-only, ` +
			`${s.needsAnswers} needs-answers, ${s.blocked} blocked ` +
			`(${s.ready} ready).`,
	);
	lines.push(
		`Runner verdict: ${registryEligible}/${registryItems} item(s) eligible now ` +
			`(under the current --auto-build policy).`,
	);

	return lines.join('\n');
}
