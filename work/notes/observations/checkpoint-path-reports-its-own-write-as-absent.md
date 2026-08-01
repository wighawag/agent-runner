---
needsAnswers: false
---

# The deadline-checkpoint / surface path reported dorfl's OWN successful write as absent

Date: 2026-08-01
Observer: field run of dorfl 0.11.1 driving a real repo, harness `pi`, `--isolated --merge --review --arbiter origin`, `agentDeadlineMinutes: 60`, `maxAutoCheckpoints: 5`, `freshWorktreeGate: true`. The target repo was NOT in the hub registry, and `dorfl status` also printed "no 'arbiter' remote configured in this repo" even though `defaultArbiter: origin` resolved fine.

FIXED by this change; recorded because the root cause is a whole CLASS of read, not two bugs, and because the fix corrected a third consequence nobody had noticed.

## What was seen

Two call sites, one root cause.

**Instance 1 — the surface path.** A task bounced to needs-attention. The surface commit pushed successfully, then:

```
>> push reported up-to-date / no change of our making — origin/main is not our commit — treating as rejected.
>> main advanced under us — surface refetch and retry (1/5)...
```

That repeated through 5/5, then reported `surface for 'task:<slug>' did not land on origin/main (item missing on main, or contention exhausted after retries)` and recommended `dorfl complete --isolated <slug>` to recover a "stranded" branch. It had in fact landed: `origin/main` gained FIVE commits with the identical subject `surface task:<slug> (stuck): acceptance gate failed …`.

**Instance 2 — the deadline checkpoint.** Four lines in this order:

```
>> Bounced '<slug>' to stuck (lock): deadline-checkpoint save for '<slug>' (see branch)
>> '<slug>' has no work branch on origin — requeueing to backlog for a FRESH claim (nothing to continue from; no --reset needed).
>> Returned '<slug>' to backlog (released the lock; body rests in pool).
>> Auto-continued '<slug>' at the dorfl-internal deadline (checkpoint 1/5): WIP saved + branch pushed, lock released so the next tick continues from work/task-<slug>.
```

Lines 2 and 4 contradict each other. Line 4 was true: `refs/heads/work/task-<slug>` was on the arbiter carrying ~1,280 lines of real work across 19 files. Acting on line 2 re-drives the task from scratch and discards it. Nothing was lost only because the branch was inspected by hand first.

## Root cause (confirmed empirically, not inferred)

Both sites answered a state question by reading a REMOTE-TRACKING ref (`refs/remotes/<arbiter>/…`) after a PLAIN `git fetch <arbiter>`. That is unsound in the configuration `--isolated` itself creates: a job worktree is `git worktree add`ed from the BARE HUB MIRROR (`workspace.ts` `createJob` → `repo-mirror.ts` `ensureMirror`), whose `origin` carries the mirror refspec `+refs/heads/*:refs/heads/*`.

Reproduced from first principles in a scratch repo:

- A plain fetch there writes `refs/heads/main` and **never populates** `refs/remotes/origin/main`. So `rev-parse origin/main` returned a sha left behind by an EARLIER explicit-refspec fetch — a view predating the very push being verified. The push had landed (`arbiter refs/heads/main` = our new sha); `rev-parse origin/main` still reported the old one; `ls-remote` reported the truth.
- Worse, with `work/task-<slug>` checked out, a plain `git fetch origin` FAILS outright: `fatal: refusing to fetch into branch 'refs/heads/work/task-<slug>' checked out at …`, because the mirror refspec's destination IS the checked-out branch. It refreshed nothing, and the follow-up `rev-parse origin/work/task-<slug>` failed against a ref that never existed — reported as "no work branch on origin".

The retry loop then made it worse rather than better: each attempt re-planned against a freshly-fetched base, built a NEW surface commit (`appendQuestions` mints a new entry id, so the tree genuinely differed), pushed it, and mis-read the verify again. Five commits, one per retry — the commit count scaled with the retry budget, not with anything real.

The unregistered repo and the missing `arbiter` remote were NOT causal. They are just the ordinary shape of an `--isolated` run, which is what puts the code in a bare-mirror worktree.

## The third consequence, previously unnoticed

Because `surfaceStuckToNeedsAttention` is surface-FIRST / release-SECOND, a surface mis-reported as failed meant the release never ran. So a bounced item was left **simultaneously surfaced for a human AND holding a live `state: active` claim lock** — a stranded lock that blocks re-claiming entirely. Two existing tests were asserting that stranded state as if it were correct (`centralise-bounce-branch-push`: `requeue.moved === true`, only reachable because a lock was still held; `run-uses-advance-tick`: `needsAttention: 1 / failed: 1`, the FAILED-surface exit code rather than PR-2b D3's green clean surface). Both were updated to the intended contract.

## The fix

- `arbiter-refs.ts` — ONE shared seam for this class: `refreshArbiterRefs` prune-fetches with an EXPLICIT, per-branch refspec into the namespace readers actually read (per-branch and soft, so the one refspec git refuses cannot defeat the others), and `resolveArbiterBranch` answers the sha from the ARBITER via `ls-remote`, with an explicitly `trustworthy: false` local fallback when the arbiter is unreachable.
- The write seam's post-push verify uses it, so a green push can never be reported as "did not land". An unreachable arbiter after a green push now reports PUBLISHED (the push exiting 0 is evidence FOR landing) rather than inventing a rejection.
- Idempotence at the commit level: `runTreelessLedgerMove` short-circuits when the planned commit's tree equals the base's, and the surface plan additionally short-circuits when every entry it would append is already present UNANSWERED. A re-surface is a no-op; a genuinely new or already-answered reason still surfaces.
- ONE resolved state: `returnToBacklog` resolves the continue-branch exactly once and publishes it as `result.continueBranch`, from which both its own note and the caller's checkpoint message are derived. The two contradictory lines are structurally impossible now.

## Residue

`explicitMainRefspec` on `runTreelessLedgerMove` is now vestigial (the refresh is always explicit) and is `void`ed with a comment. It could be deleted along with its two call-site arguments; left in place to keep this change scoped to the defect.
