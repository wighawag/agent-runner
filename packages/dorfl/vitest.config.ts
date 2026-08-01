import {defineConfig} from 'vitest/config';

/**
 * Two projects so the FILE-PARALLEL-FLAKY tests don't flake.
 *
 * This list collects tests that pass reliably in isolation but flake ONLY under
 * file-parallel load (the CPU/IO pressure of running concurrently with the rest
 * of the suite widens a timing window). There are two known classes here:
 *
 * 1. git-`file://`-CAS races — the git-heavy files drive REAL git subprocesses
 *    and include in-process two-claimer races (`Promise.all` of concurrent
 *    claims) against a local `--bare` `file://` arbiter. The claim protocol
 *    itself is sound (`--force-with-lease` + post-push verify), but git's
 *    `file://` transport does NOT serialise concurrent pushes as atomically as a
 *    real remote's receive-pack, so under concurrent pressure the local sim
 *    occasionally lets both pushes fast-forward (a harness artifact, NOT a
 *    product bug — the suite passes 100% with file parallelism off, flakes
 *    ~1-in-3 with it on).
 * 2. spawn-stdin races — see `review-gate.test.ts` below.
 *
 * Fix: run these flaky files in their OWN project with `fileParallelism: false`
 * (they run one-at-a-time, isolated from the parallel pressure), while the fast
 * pure-logic tests keep running in parallel. This keeps the gate deterministic
 * without slowing the whole suite or masking anything with retries.
 */
const RACE_SENSITIVE = [
	'test/claim-cas.test.ts',
	// The CROSS-PROCESS concurrent-land test (Story 13 cross-job half of
	// `land-time-reverify-and-parallel-merge-ceiling`): two SPAWNED node
	// processes race the same --bare `file://` arbiter ref so the in-process
	// `integrateLock` cannot serialise them — only the CAS-loop can. Same
	// git-`file://`-CAS race class as `merge-retries-external.test.ts` /
	// `claim-cas.test.ts`; keep it out of file-parallel pressure for the
	// same deterministic claim/main-CAS reasoning.
	'test/cross-job-concurrent-land.test.ts',
	// The `gc --ledger --reap-stale-locks` SWEEP (`gc-ledger-reap-stale-locks-opt-in-flag`):
	// the opt-in reaper clears `cleared-stale` per-item locks via the shared leased
	// delete against a --bare arbiter, and runs an in-process TWO-REAPER race (two
	// clones sweeping the SAME stale lock ref) proving the leased delete REJECTS the
	// loser, never --force; keep it out of file-parallel pressure for the same
	// deterministic lock-CAS reasoning as tasking-lock.test.ts.
	'test/gc-reap-stale-locks.test.ts',
	// The tasking concurrency lock reuses the claim CAS (specs/ready → tasking/ → specs/ready)
	// against a --bare arbiter and runs an in-process two-tasker race plus a
	// release-rebase-conflict test that writes main; keep it out of file-parallel
	// pressure for the same deterministic claim/main-CAS reasoning as claim-cas.
	'test/tasking-lock.test.ts',
	// The advancing-lock BORROW (`advancing-lock-borrow`): a SHORT borrow shaped
	// like tasking-lock, reusing the same CAS ledger-write seam against a --bare
	// arbiter, with an in-process two-tick race + a new-item-creation race + a
	// marker-delete release that writes main; keep it out of file-parallel pressure
	// for the same deterministic claim/main-CAS reasoning as tasking-lock.test.ts.
	'test/advancing-lock.test.ts',
	// The `do spec:<slug>` tasking path (`performTask`): drives the lock CAS
	// (specs/ready → tasking → specs/tasked) against a --bare arbiter AND writes main (the
	// runner-owned completing transition that emits backlog tasks + marks the spec
	// tasked); keep it out of file-parallel pressure for the same deterministic
	// claim/main-CAS reasoning as tasking-lock.test.ts.
	'test/tasking.test.ts',
	// The `do spec:<slug>` slice-output-through-integration keystone
	// (`slice-output-through-integration`): routes the produced tasks + the spec
	// lifecycle move through the shared `performIntegration` core, driving the lock
	// CAS AND writing main (--merge) / pushing the work branch (--propose) against a
	// --bare arbiter; keep it out of file-parallel pressure for the same
	// deterministic claim/main-CAS reasoning as tasking.test.ts.
	'test/tasking-integration.test.ts',
	// The `do spec:<slug>` task-SET ACCEPTANCE GATE (`slice-acceptance-gate`): the
	// task-path mirror of Gate-2 — runs a fresh-context review of the produced SET
	// before it integrates, driving the lock CAS AND writing main (approve→merge /
	// block→needs-attention via the lock's tasking/ → needs-attention redirect)
	// against a --bare arbiter; keep it out of file-parallel pressure for the same
	// deterministic claim/main-CAS reasoning as tasking-integration.test.ts.
	'test/slice-acceptance-gate.test.ts',
	'test/start.test.ts',
	'test/work-on.test.ts',
	'test/run.test.ts',
	// `do <slug>` drives real git against a --bare arbiter, runs in-process
	// two-doer races, AND writes main (the autonomous needs-attention surfacing);
	// keep it out of file-parallel pressure so the claim/main-CAS stays
	// deterministic (same reasoning as start/run/needs-attention-surface).
	'test/do.test.ts',
	// The main-divergence guard + non-fatal local-main sync: drives real git
	// against a --bare arbiter, diverges local main, and writes main (the merge-mode
	// integration + autonomous surfacing); keep it out of file-parallel pressure for
	// the same deterministic claim/main-CAS reasoning as do.test.ts.
	'test/main-divergence-guard.test.ts',
	// The fresh-worktree-gate STARTUP READINESS guard: drives real git against a
	// --bare arbiter (`performDo` claim/onboard, `performComplete` integration
	// path); keep it out of file-parallel pressure for the same deterministic
	// claim/main-CAS reasoning as do.test.ts/main-divergence-guard.test.ts.
	'test/gate-readiness.test.ts',
	// `do --watch` drives real git against a --bare arbiter, writes main, AND
	// launches a stubbed pi (async spawn) whose session .jsonl is tailed
	// concurrently; keep it out of file-parallel pressure for the same reason as
	// do.test.ts (deterministic claim/main-CAS).
	'test/do-watch.test.ts',
	// `do --remote <r>` materialises a hub mirror + job worktree in a temp agents'
	// area, runs the pipeline against the worktree, AND writes main (the autonomous
	// needs-attention surfacing) against a --bare arbiter; keep it out of
	// file-parallel pressure for the same deterministic claim/main-CAS reasoning as
	// do.test.ts.
	'test/do-remote.test.ts',
	// `do --review --watch` drives real git against a --bare arbiter, writes main
	// (approve→merge / block→needs-attention surfacing), AND launches a stubbed pi
	// (async spawn) for BOTH the build and the review, whose session .jsonl files
	// are tailed concurrently; keep it out of file-parallel pressure for the same
	// reason as do-watch.test.ts (deterministic claim/main-CAS).
	'test/watch-review-session.test.ts',
	// Drives real git against a --bare arbiter AND writes main (surface-on-main
	// cherry-pick + resolve-via-start); keep it out of file-parallel pressure so
	// the main-CAS pushes stay deterministic.
	'test/needs-attention-surface-on-main.test.ts',
	// The needs-attention-as-stuck-lock-state task: drives the bounce (folder move
	// + the ADDITIVE per-item-lock mark-stuck CAS amend) AND the status/scan lock-ref
	// read path against a --bare arbiter, writing main and pushing lock refs; keep it
	// out of file-parallel pressure for the same deterministic claim/main-CAS
	// reasoning as needs-attention-surface-on-main.test.ts.
	'test/needs-attention-as-stuck-lock-state.test.ts',
	// The PR-1 tree-less surface primitive tests (task
	// `bounce-surfaces-stuck-sidecar-and-releases-lock`): drive real git against
	// a --bare arbiter through the shared `runTreelessLedgerMove` CAS loop AND
	// write main (the surface commit); keep them out of file-parallel pressure
	// for the same deterministic claim/main-CAS reasoning as
	// needs-attention-surface-on-main.test.ts.
	'test/bounce-surface-primitive.test.ts',
	// The PR-2a mechanism tests for the bounce atomic cutover (task
	// `bounce-atomic-cutover-retire-stuck-lock`): drive real git against a --bare
	// arbiter through `runTreelessLedgerMove` AND write main (surface commits) +
	// exercise the classifier fold + recovery predicate + D1 body-path probe;
	// keep them out of file-parallel pressure for the same deterministic
	// claim/main-CAS reasoning as bounce-surface-primitive.test.ts.
	'test/bounce-atomic-cutover-primitives.test.ts',
	// The ONE-SHOT rollout migration for pre-existing `stuck` per-item lock refs
	// (task `migrate-existing-stuck-locks-one-shot`, spec
	// `surface-stuck-as-questions-and-retire-stuck-lock-state`, resolved decision
	// #3): drives real git against a --bare arbiter through the shared
	// `runTreelessLedgerMove` CAS loop AND writes main (the surface commit per
	// migrated ref) + releases the lock ref; keep it out of file-parallel pressure
	// for the same deterministic claim/main-CAS reasoning as
	// bounce-surface-primitive.test.ts.
	'test/migrate-stuck-locks.test.ts',
	// The after-commit CONTINUE-site tree-less surface tests (`moved:false` →
	// `surface-unmoved`): drive real git against a --bare arbiter AND write main
	// via the surface-on-main CAS publish; the `moved:false` assertion flakes under
	// file-parallel pressure (occasionally saw `needs-attention` instead of the
	// honest `surface-unmoved`). Keep it out of that pressure for the same
	// deterministic claim/main-CAS reasoning as needs-attention-surface-on-main.test.ts.
	'test/surface-treeless-moved-false.test.ts',
	// Drives real git against a --bare arbiter AND writes main (the consolidated
	// bounce push + on-main surface); same determinism reasoning as above.
	'test/centralise-bounce-branch-push.test.ts',
	// The stale-lease all-push-sites + tree-less-surface tests: drive real git
	// against a --bare arbiter, continue a kept work branch, AND write main (the
	// after-commit push-failure needs-attention surfacing, incl. an end-to-end
	// `performDoRemote` mirror+worktree run); keep them out of file-parallel
	// pressure for the same deterministic claim/main-CAS reasoning as
	// do-remote.test.ts.
	'test/stale-lease-all-push-sites.test.ts',
	// The propose-mode stale-lease + benign already-landed tests
	// (`propose-push-survives-stale-lease-on-reaped-work-ref`): drive real git
	// against a --bare arbiter at the integrator seam (direct
	// `Integrator.integrate({mode: 'propose'})` AND `performIntegration({
	// committedRecovery: true})`), pushing the work branch and — in the recovery
	// case — writing main. Keep them out of file-parallel pressure for the same
	// deterministic claim/main-CAS reasoning as `stale-lease-all-push-sites.test.ts`.
	'test/stale-lease-propose-push.test.ts',
	// The REGISTRY-SET advance driver with per-mirror job-worktree isolation
	// (`advance-loop-driver-registry-set-job-worktrees`): discovers the registry via
	// `scan(config)`, materialises a hub mirror + job worktree per mirror, builds +
	// integrates against a --bare arbiter (writes main), and runs an in-process
	// two-batch CAS race over one mirror; keep it out of file-parallel pressure for
	// the same deterministic claim/main-CAS reasoning as do-remote.test.ts.
	'test/advance-registry-set.test.ts',
	// `run` driven by the REGISTRY-SET advance tick (`run-uses-advance-tick`): wraps
	// the SAME registry-set driver as advance-registry-set.test.ts in the run loop, so
	// it materialises hub mirrors + job worktrees, builds + integrates against a
	// --bare arbiter (writes main), AND — since
	// `loop-advance-persists-treeless-rungs-to-arbiter` — ff-pushes tree-less rung
	// results to the arbiter `main` (real per-mirror main writes + git pushes). The
	// multi-mirror drain is right at the 5s timeout boundary under file-parallel
	// pressure; keep it out of that pressure for the same deterministic claim/main-CAS
	// reasoning as advance-registry-set.test.ts.
	'test/run-uses-advance-tick.test.ts',
	// Gate 2 (PR/code review) on the do/complete path: drives real git against a
	// --bare arbiter, integrates/merges on approve, AND writes main (the autonomous
	// needs-attention surfacing on a block); keep it out of file-parallel pressure
	// for the same deterministic claim/main-CAS reasoning as do.test.ts.
	'test/review-gate-pr.test.ts',
	// The shared gate→integrate core (Task 1 of the run/do convergence): drives
	// real git against a --bare arbiter, integrates/merges on approve (writes main),
	// and routes failures; keep it out of file-parallel pressure for the same
	// deterministic claim/main-CAS reasoning as review-gate-pr.test.ts.
	'test/integration-core.test.ts',
	// `run` routed through the shared core (Task 2 of the run/do convergence): the
	// fleet's review gate + PR title/body + per-repo verify proofs. Drives real git
	// against a --bare arbiter, integrates/merges on approve (writes main), and
	// routes failures (the needs-attention surfacing); keep it out of file-parallel
	// pressure for the same deterministic claim/main-CAS reasoning as run.test.ts.
	'test/run-integration-core.test.ts',
	// The observation-promote create-CAS races (`performAdvance` / `promoteObservation`
	// via `Promise.all`) against a --bare arbiter, INCLUDING the identical-identity
	// variants added by `cas-create-nonce-authoritative-same-identity`: those assert
	// EXACTLY one winner DETERMINISTICALLY even when both racers share one committer
	// identity (so without the seam's per-attempt CAS-Nonce the two create commits
	// would be byte-identical and BOTH would spuriously verify as won). The nonce
	// makes the shas distinct so the loser's lease is genuinely rejected; registering
	// here keeps the in-process race out of cross-file `file://` parallel pressure so
	// the exactly-one-winner invariant is gated without the harness-timing confound
	// (same deterministic claim/main-CAS reasoning as advancing-lock.test.ts).
	'test/advance-triage.test.ts',
	'test/triage-persist.test.ts',
	// NOT a git-CAS race — a spawn-stdin race: `NullHarness.launch`'s captured path
	// (`spawnSync('bash', ['-c', printf ...])`) intermittently throws `spawnSync
	// bash EPIPE` when the `printf` child closes stdin before the parent writes the
	// (empty) prompt, but ONLY under heavy concurrent test load (passes 28/28 in
	// isolation). Keep it out of file-parallel pressure so the gate is
	// deterministic; the source fix is the separate
	// `null-harness-prompt-write-epipe-tolerant` task. See
	// work/notes/observations/review-gate-test-epipe-under-parallel-load.md.
	'test/review-gate.test.ts',
	// The FRESH-WORKTREE GATE run-fleet tests + the same-repo concurrent `run`/
	// `runLoop` merge tests (task
	// `run-fleet-claim-integrate-and-sibling-rebase-concurrency-safe`). Once that
	// task REMOVED the `perRepoMax === 1` fresh-gate downgrade, these drive the
	// fresh rebased-tip gate (cut a throwaway worktree, prepare+verify on it) AND
	// the merge integration (write `main` via `${branch}:main` against a --bare
	// `file://` arbiter) at `perRepoMax > 1`. That is exactly the git-`file://`-CAS
	// race class above: the protocol is sound (the merge push now re-rebases +
	// retries on a non-fast-forward), but git's `file://` transport does not
	// serialise concurrent pushes atomically, so under cross-file parallel pressure
	// the loser's CAS occasionally flakes (passes 100% in isolation, here and below).
	// Keep them out of file-parallel pressure for the same deterministic
	// claim/main-CAS reasoning as run.test.ts / integration-core.test.ts.
	'test/run-loop.test.ts',
	'test/run-fresh-worktree-gate.test.ts',
	'test/fresh-worktree-gate.test.ts',
	'test/run-internal-error-tests.test.ts',
	// New git-`file://` CAS race file (in-process two-claimer + high-fan-out
	// concurrent claims against a --bare arbiter): sound product, but times out
	// under cross-file parallel pressure (the documented git-`file://` race class
	// above). Run it in the sequential project for the same deterministic
	// claim/main-CAS reasoning as claim-cas.test.ts.
	'test/claim-acquires-unified-lock.test.ts',
	// The POST-#9 EXCLUSION PROOF (task
	// `cutover-retire-slicing-advancing-markers-and-trim-folder-sets`): drives REAL
	// `performAdvance` build-task/task-spec rungs (which orchestrate the inner
	// `performDo`/`performTask` claim/task lock) racing a direct `performClaim` /
	// tasking acquire against a --bare `file://` arbiter, in-process, AND writes main
	// (the inner do's merge integration). It is the git-`file://`-CAS race class
	// above; run it sequentially for the same deterministic claim/main-CAS reasoning
	// as claim-acquires-unified-lock.test.ts / advancing-acquires-unified-lock.test.ts.
	'test/advance-exclusion-via-inner-lock.test.ts',
	// The self-renaming-folder DIRTY-CONTINUE keystone: drives real git against a
	// --bare arbiter via `seedRepoWithArbiter` + `performComplete`, continuing a
	// kept work branch and writing main (the rename-aware integration push). It is
	// the git-`file://`-CAS race class above; under file-parallel pressure the
	// DIRTY-CONTINUE case (~L160) exceeds the default 5s per-test timeout (passes
	// 17/17 in isolation in ~5s). Run it sequentially for the same deterministic
	// claim/main-CAS reasoning as do.test.ts / do-remote.test.ts.
	'test/complete-self-renaming-folder-task.test.ts',
	// The post-write-verification regression tests (observation
	// `checkpoint-path-reports-its-own-write-as-absent`): drive real git against a
	// --bare arbiter through the write seam's CAS + the tree-less surface loop AND
	// write main (surface commits), including a BARE-HUB-MIRROR job worktree whose
	// `origin` carries the mirror refspec. Same git-`file://`-CAS class as
	// bounce-surface-primitive.test.ts; run sequentially for the same deterministic
	// claim/main-CAS reasoning.
	'test/post-write-verify-mirror-view.test.ts',
	// The isolated-`do` SEQUENTIAL-REFETCH FRESHNESS drain (~L445): drives
	// `performDoRemote(Auto)` against a --bare arbiter (hub mirror + job worktree),
	// runs the pipeline, AND writes main (the autonomous needs-attention surfacing)
	// repeatedly across rungs. It is the git-`file://`-CAS race class above; under
	// file-parallel pressure the sequential-refetch drain exceeds the default 5s
	// per-test timeout (passes in isolation in ~5s). Run it sequentially for the
	// same deterministic claim/main-CAS reasoning as do-remote.test.ts.
	'test/do-isolated.test.ts',
];

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'parallel',
					setupFiles: ['./test/setup.ts'],
					exclude: ['node_modules/**', 'dist/**', ...RACE_SENSITIVE],
				},
			},
			{
				test: {
					name: 'sequential',
					setupFiles: ['./test/setup.ts'],
					include: RACE_SENSITIVE,
					fileParallelism: false,
				},
			},
		],
	},
});
