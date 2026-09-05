---
title: 'Terminal-state residue is reconciled by the claim path; read commands only classify'
status: accepted
created: 2026-09-04
supersedes:
superseded_by:
refines: ledger-status-on-per-item-lock-refs
---

# ADR: reconciling an item's terminal residue belongs on a write path, not on `status`

## Context

Two defects, fixed here as one change because they are one defect wearing two hats.

`complete --propose` deliberately keeps the per-item lock held after opening the PR. That is correct: the done-move lives on the PR branch, so `<arbiter>/main` still shows the body in the ready pool, and releasing there would let the next tick re-claim an item that is actively in review. The runner said so out loud, and promised the other half:

```
>> '<slug>': keeping the per-item lock HELD (propose PR open; the work is not yet on main).
   It is released when the PR merges (reconciled against main).
```

The second sentence was never true. Nobody runs a dorfl process at the moment a human clicks merge on GitHub, there is no merge hook, and there is no daemon, so a release scheduled for merge-time can never fire. `reconcileItemLockAgainstMain` implemented exactly the right decision but had no caller on any ordinary path: it was reachable only from the opt-in `gc --ledger --reap-stale-locks` sweep. An operator driving `do`/`complete` by hand never runs that, so every propose build leaked its lock ref permanently. On the etherfold arbiter this reached 26 refs, every one naming a task at rest in `work/tasks/done/`, all reported by `status` as in-progress.

The `--merge` integration path never showed this: it lands on `main` inline, so the release happens in-process.

### The second half: stranded question state

When a build bounces, the surface path atomically writes both halves of the item's question state in ONE commit: the sidecar `work/questions/<type>-<slug>.md`, and `needsAnswers: true` on the item body. That is correct, and its atomicity is what makes reconciliation decidable at all.

But take the other branch. Instead of answering the sidecar, a human disagrees with the agent, re-dispatches, and the rebuild SUCCEEDS: PR opened, gate green, merged, body done-moved. Neither half is cleared. Items come to rest in `tasks/done/` still carrying a question asking whether to CANCEL them, with a destructive default, and with a `needsAnswers` gate armed over shipped work. The flag is the worse half: it makes `status` report shipped (sometimes released) work under "open questions block autonomous work".

Dorfl already knows this state is illegal. `advance-classify.ts` refuses it as `invariant-violation` with the tag `sidecar-without-needsAnswers`. The detector exists; it just lives in the `advance` tick's classifier, and a human driving `do` and merging a PR never enters that loop.

### Why they are one defect

Both are cleared by a step that only runs on a path the item did not take. Both become moot at exactly the same moment, the done-move landing on `main`. And each is detectable only from a loop the manual path never enters (`gc --ledger --reap-stale-locks` for the lock, the `advance` classifier for the questions). So they get one reconciliation pass, not two mechanisms.

## Decision

The bug has two halves, and they are fixed in two different places.

**The mis-reporting half** is fixed in the read commands. `status` and `scan` classify every held lock against the arbiter's `main` (`classifyTerminalItemLocks`, which writes nothing) and report a lock whose item is already at rest as *"Completed, lock not yet released"*, excluded from the in-flight list. Finished work therefore stops reading as in-progress. **`status` and `scan` remain strictly read-only**, which their own documentation promises.

**The residue half** is fixed on the **claim path**, which already writes to the arbiter, already fetches `main`, and runs on every unit of work. `reconcileTerminalState` runs there, releasing stale locks and publishing one tree-less commit that removes stale sidecars and clears stale `needsAnswers` flags, so the residue drains continuously as a side effect of ordinary use.

`status --reconcile-locks` and `scan --reconcile-locks` perform the same sweep on demand. They are a convenience, not the mechanism.

Two fences bound what may ever be released, and they are the safety-bearing part:

1. **The terminal test is the item's position on `main`, and nothing else.** A lock is released only when the body rests in a terminal folder per `terminalMainPaths` (a task in `tasks/done/` or `tasks/cancelled/`, a spec in `specs/tasked/` or `specs/dropped/`). Never a branch, never a PR's existence, never its merge status, never the holder, never age. An item on an open PR still shows its body in the pool on `main`, so it keeps its lock. A genuinely stuck item keeps its lock. Releasing a non-terminal lock would let two claimants build the same item, so every uncertainty resolves to keep. The `--reconcile-locks` flag authorises the sweep; it does **not** widen this predicate.

2. **Only the terminal class is swept.** The crash-window orphan (non-terminal but surfaced on `main` with `needsAnswers:true` plus a sidecar) is left to the explicit `gc --ledger --reap-stale-locks` sweep.

For the question half the same fence is doing even more work, because **the mirror state is legal and common**. `needsAnswers: true` with no sidecar is exactly what an item authored with open questions looks like before `surface` runs, and that flagged-but-unsurfaced item is the `surface` rung's input. A fix that reconciled "flag without sidecar" would silently disarm every un-surfaced item in the repo and hand gated work to agents. So the terminal POSITION is the discriminator, never the flag/sidecar disagreement on its own, and the enumeration is anchored on the sidecar set rather than on flags.

### Scope of the question drain, and its two deliberate asymmetries

**`specs/tasked/` is NOT a place where question state is moot, and is excluded entirely.** (Corrected 2026-09-05: this ADR originally listed `specs/tasked/` as a success terminal for question state; both that text and the code have since been changed. Note this concerns the QUESTION map only. The LOCK terminal set in `item-lock.ts` still counts `specs/tasked/` as terminal, correctly, since a tasked spec must release its lock; the two sets deliberately differ and must not be unified.) `specs/tasked/` is a terminal RESIDENCE, but the discriminator that matters is "is the question loop CLOSED here?", not "has the item stopped moving?". WORK-CONTRACT ("A SPEC that has drifted AFTER it was TASKED") makes `needsAnswers: true` on a tasked spec **legal and load-bearing**: it means "tasked, but the spec has drifted, do not RE-task or rely on it until reconciled", and the contract explicitly directs that it be set *while the spec stays in `specs/tasked/`*, because moving it back would falsely un-record a tasking that really happened and orphan the tasks it emitted. `lifecycle-gather.ts` enumerates tasked resting specs UNCONDITIONALLY, routing a bare flag to the SURFACE rung and an answered sidecar to the APPLY rung. So BOTH halves of a tasked spec's question state are live inputs to a rung that WILL run. Draining either would disarm a live drift gate and let a stale spec be re-tasked, which is the precise harm this pass exists to avoid. `specs/tasked/` is therefore removed from the question-residue terminal map altogether; this also fixes the previously-shipped behaviour, under which a drifted tasked spec's PENDING sidecar (an unanswered human decision) was deleted and its gate cleared. `specs/dropped/` needs no carve-out: a dropped spec is abandoned and no rung enumerates it.

**`cancelled/` reconciles the sidecar but keeps the flag.** An item can be cancelled precisely BECAUSE its questions were never answered, and its body may carry a real `## Open questions` section recording that; there the flag is accurate history, not residue. Keeping it is harmless, since a terminal item is in no pool and the flag gates nothing. The sidecar still goes in both cases: it is an actionable prompt with a destructive default about an item that is already gone. So `tasks/done/` (the work happened) clears both halves; `tasks/cancelled/` and `specs/dropped/` (the item was abandoned) clear only the sidecar; `specs/tasked/` is left entirely alone (see the correction above).

**An answered sidecar is never auto-drained.** In the field one sidecar had been answered in writing, ending "Close this sidecar", and was still sitting there, which is evidence the drain does not run on the human-answer path either. That is a separate defect, and this pass must not paper over it by destroying the evidence. A terminal item whose sidecar carries any answered entry is therefore left completely untouched and REPORTED, so the human's prose survives and the invariant between flag and sidecar is not torn.

### Addendum 2026-09-05: the residue is enumerated from BOTH halves, not just the sidecar set

As first built, the question sub-pass enumerated `work/questions/` and reasoned outward to the item. That is the cheap, unambiguous handle, and the original write-up defended skipping the opposite shape: "a terminal item carrying a bare flag and no sidecar is deliberately NOT swept", on the grounds that `needsAnswers:true` with no sidecar is the LEGAL pre-surface state.

That conflated a state with its POSITION, and it left the harmful half unreachable. A bare flag is legal in a POOL or STAGING folder, where it is precisely the `surface` rung's input and clearing it would disarm gated work. On `tasks/done/` it cannot mean that: the task has shipped and no rung enumerates it (`lifecycle-gather.ts` enumerates the pools, tasked specs, and under `surfaceStaging` the staging folders, but never `tasks/done/`), so `surface` can never run on it again and no answer can still be typed. There the flag is pure residue, and it is the half that actually gates anything.

Anchoring only on the sidecar meant the sweep could not see that shape at all, and three ordinary routes produce it, each removing the sidecar while the flag survives:

1. **The item was never surfaced.** The tasker sets `needsAnswers:true` on an uncertain task, and the flag is only a WARNING on the human claim path, so the task can be answered in conversation, built and completed. The flag rides the done-move into `tasks/done/` and no sidecar ever existed.
2. **A human tidied `work/questions/` by hand**, the obvious manual clean-up for the paired residue, which deletes exactly the handle the sweep needs.
3. **The drain's own defense-in-depth guard**: it removes the sidecar unconditionally but skips the flag clear on a body it cannot annotate, creating this state and then being blind to it.

So the pass now runs TWO enumerations against the same base: the sidecar set as before, and a `git grep` over the SUCCESS-terminal folders for flagged bodies with no sidecar beside them. The second is a grep because those folders are the repo's largest and fastest-growing (404 done tasks here) and this runs on the claim path; the grep only SHORTLISTS, and the decision is always the parsed frontmatter, since bodies discuss `needsAnswers` in prose constantly.

The two enumerations are kept DISJOINT: an item whose sidecar still exists is skipped by the flag-only half. That is what stops the answered-sidecar carve-out being bypassed by a path that would clear the gate while leaving the unread answer.

The `cancelled/` asymmetry is unchanged and now also governs the flag-only half: a bare flag on `tasks/cancelled/` or `specs/dropped/` is KEPT, for the same reason as before.

This narrows one stated consequence of `ledger-status-on-per-item-lock-refs` ("no auto-sweep; a human asserts a lock is dead") for the terminal class only, and for the reason given below. That ADR's rule continues to govern every other class of lock.

### Reading the arbiter's `main` is ref-shape dependent

The terminal probe must read the ref that actually holds the arbiter's `main`, and that differs by repo shape: a working clone has it at `refs/remotes/<arbiter>/main`, while a **bare hub mirror** (`git clone --bare`, which is what the registry stores) has no `refs/remotes/*` namespace at all and holds it at `refs/heads/main`. Probing the wrong one fails with `invalid object name`, which is indistinguishable from "the item is not terminal", so every lock would classify as in-flight and the sweep would become a silent permanent no-op. Two things prevent that: the refresh uses an **explicit refspec** that writes exactly the ref the probe will read, and the classifier **verifies that ref resolves** before probing, reporting an error instead of quietly answering "nothing is terminal". This is the same hazard `arbiter-refs.ts` was written for.

## Considered and rejected: reconciling on `status`

The first implementation put the automatic release on `status` and `scan`, on the grounds that "report and offer" is exactly what already existed (`gc --ledger` reported these locks and printed the `release-lock` command) and is what produced 26 leaked refs, so an offer nobody is routed to equals no fix.

That reasoning about offers is sound, but it does not justify making a read command write. It only requires that the release be **automatic on a command that actually runs**, and dorfl already has such commands that write to the arbiter by design. Turning the operational dashboard into a mutating command to reach convergence was solving the right problem in the wrong place, and it cost a property worth keeping: `status` and `scan` are safe to run anywhere, by anyone, at any time, including against a repo you do not own or with a read-only token.

Putting the sweep on the claim path keeps both properties. The cost is that convergence is deferred to the next unit of work rather than the next glance at the dashboard, which is immaterial for a durable fact on `main` that no longer gates anything: a terminal item is out of the eligible pool by position regardless of its lock.

## Consequences

- A leaked lock can survive slightly longer than under the rejected design, until the next claim. It is visible and correctly labelled the whole time, and never blocks work.
- The claim path performs one extra `ls-remote` + one lock-ref fetch and a local existence check per lock, reusing the `main` fetch it already does. It is best-effort and never fails a claim: any fault leaves every lock held.
- Every delete is the same `--force-with-lease` delete `release-lock` and `requeue` use, so a lock a concurrent writer moved is reported rather than stolen.
- `gc --ledger` keeps its report-only contract and `--reap-stale-locks` keeps its broader sweep. In practice they will find fewer terminal locks, because the claim path drains them first.
- Recovery verbs are untouched: `requeue`, `requeue --reset`, `release-lock`, and `release-lock --entry <literal>` keep their exact semantics. A pre-cutover entry with no derivable item-form is not classifiable and is left held for the `--entry` escape hatch.
