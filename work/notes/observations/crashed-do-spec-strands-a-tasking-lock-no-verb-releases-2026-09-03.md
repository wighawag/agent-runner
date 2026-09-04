---
title: 'A crashed `do spec:<slug>` strands its tasking lock: the agent-failure path returns before the review loop that was supposed to surface it, and all three escalation rungs the operator tried dead-ended on a capability (`release-lock spec:<slug>`) that already existed'
type: observation
status: spotted
spotted: 2026-09-03
needsAnswers: false
triaged: fixed
---

## What was seen

`dorfl do spec:<slug>` was run three times on one spec. Each run died inside the tasking agent from a model-API fault (`Connection error.`, then `overloaded_error`, then `api_error`). Every run after the first refused before doing any work:

```
'spec-<slug>' is already locked (held by another). Back off.
```

The lock (`refs/dorfl/lock/spec-<slug>`, `action: task`, `state: active`) outlived the process that took it. Recovery ended up being `git push origin :refs/dorfl/lock/spec-<slug>` by hand.

## The defect

`performTask` (`src/tasking.ts`) acquires the lock at step 2, invokes the agent at step 3, and on `!agent.ok` returned immediately with the lock still held, justified in-comment by:

> The lock stays held (the runner did not release it): a stuck tasking is recoverable / re-runnable. Surfacing it is the review/edit loop's job.

Both clauses were false in combination. The review/edit loop is step 3.5, strictly AFTER that early return, so on an agent crash it never runs and nothing surfaces the lock. And the "re-runnable" recovery the comment promises is exactly what the retained lock prevents: the retry loses the create-only ref CAS to a holder that no longer exists. The path had no owner, so the lock simply leaked.

Note the asymmetry that made this obvious once located: the sibling failure a few lines below (`ReviewParseError`) routes through `surfaceTaskingBlock`, which releases the lock and writes a question sidecar. The agent-crash path, which is strictly less ambiguous, did neither.

## The escalation ladder had rungs; none of them said so

The sharper half of this observation is that the capability to clear the lock existed the whole time and the operator could not find it, having tried three commands that each answered in a way that implied the state was not theirs to fix.

- **`dorfl requeue <slug>`** is task-only, so a bare slug resolves to `task-<slug>`, finds nothing, and answers `'<slug>' has no held per-item lock on origin — nothing to requeue (wrong slug, or already at rest in backlog/done?)`. This actively misdirects: it asserts nothing is held while `refs/dorfl/lock/spec-<slug>` is sitting on the arbiter, sending the reader to look for a typo.
- **`dorfl gc`** reaps worktrees and reported `0 reaped`, because a tasking run that dies before integrating leaves no worktree. Correct, and irrelevant. Crucially, **`dorfl gc --ledger` DOES report the lock and prints the exact fix** — but nothing on the plain `gc` path hints that the flag exists.
- **`dorfl release-lock spec:<slug>`** was the answer all along. It accepts `spec:` item forms, maps to the `spec-<slug>` entry, and performs the same tree-less leased delete. Verified empirically against a scratch arbiter both before and after this fix.

So the reported gap ("no rung on the ladder", "the only recovery is manual ref surgery") was really a **discoverability** gap in three messages, not a missing verb.

## What was changed

1. **The leak (primary).** The agent-failure path now releases the lock itself. It is a PLAIN release, not the `needsAnswers:true` + sidecar surface the review-verdict path uses: a transport crash carries no judgement for a human to resolve, and surfacing it would take the spec out of the taskable pool behind a contentless question, converting a retryable blip into mandatory paperwork. The crash is still reported as `agent-failed`; a release fault is reported but never masks it.

2. **Two dead-end messages.** The contention refusal now names `gc --ledger` / `release-lock <item>` under an explicit "if the holder is DEAD" condition, keeping `Back off.` as the default so a runner is never nudged into stealing a live peer's lock. `requeue` now probes the spec namespace on a miss and, on a hit, names the held lock and the verb that owns it.

3. **Deliberately NOT done:** teaching `requeue` to release `spec-` locks. `release-lock` is the already-generalised named release for all holds (it is what `release-advancing` was consolidated into), and `requeue`'s contract is keep/continue/rebase/reset/reconcile of a WORK BRANCH, which a tasking run does not have. Adding a second release mechanism for the same ref would re-fragment what was deliberately unified.

## Why releasing is safe (the premise, now asserted in tests)

`switchToWorkBranch` creates the tasking branch with a LOCAL `git switch -C` and does not push it; the durable `specs/ready → specs/tasked` move also happens only at the integrate band. A run that died at the agent step has therefore published nothing to the arbiter, so releasing its lock cannot lose work. There is one regression test that pins exactly this (spec still in `specs/ready/`, no `refs/heads/work/*` on the arbiter after a crash), so a future change that starts pushing earlier will fail loudly here rather than silently making the release unsafe.

## Residue / follow-ups

- A **successful** `--propose` tasking run still ends with the lock held by design (releasing at PR-open time is the `propose-tasking-releases-lock-so-spec-is-retasked-and-pr-force-pushed-every-tick` bug). If such a PR is abandoned, its lock is still cleared only by a human via `release-lock`. Not addressed here, and correct as-is, but it is the remaining route to a long-lived `spec-` lock.
- Plain `dorfl gc` still does not mention `--ledger` even when locks are held. Cheap follow-up: have `gc` note "N lock(s) held — see `gc --ledger`" when the report would be non-empty.
- The stranding class is not tasking-specific in principle. The `do task:` build path was reported (`runner-must-not-exit-between-the-agent-and-its-outcome`) to have had a structurally similar hole; worth a sweep for any other early return between an acquire and its release.
