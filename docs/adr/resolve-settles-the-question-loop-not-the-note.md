---
title: '`resolve` settles a note''s QUESTION-LOOP, not the note: a kept note rests `triaged:` + `needsAnswers:false`, and a note whose signal is finished is `dispose`d instead'
status: accepted
created: 2026-08-11
decided: 2026-08-11
supersedes:
superseded_by:
---

# ADR: `resolve` settles the question-loop, not the note

## Context

The `advance` apply rung's decision agent may answer a fully-answered observation with `resolve` (`resolve-no-mint`, added by task `apply-decide-resolve-verdict-mint-nothing`): the human's answer settles the item, nothing is minted, and the note is KEPT. The persist's resolve-fully path harvests the answers into a `## Applied answers` block, clears `needsAnswers`, and deletes the sidecar in one atomic commit.

That end-state re-entered the triage loop forever. `classifyTick` (`advance-classify.ts`) reads exactly two signals — `needsAnswers` and the active sidecar — and its first branch is: `needsAnswers` not true, no sidecar, therefore ANALYSE, therefore `triage-observation`. A resolved-and-kept note has `needsAnswers:false` and no sidecar, so it is INDISTINGUISHABLE from a note that has never been triaged. The next tick triaged it again, the triage rung surfaced its DETERMINISTIC engine-built question (so the re-ask was byte-identical, not an agent flake), and the human was asked something they had already answered.

Observed live in the `rocketh` consumer repo: for `observation:any-casts-in-deploy-proxy-diamond`, commit `cdbcd42` surfaced one question, the human answered it, `dd350c4` resolved it, and `c2a75ab` surfaced the same question again — the only difference between the sidecar `dd350c4` deleted and the one `c2a75ab` created was the absence of the human's answer prose. One cycle hit four notes; eleven more were resting in the same shape.

The first fix for this verdict removed an `ask` loop (the decider had no valid verdict for "answered, mint nothing, keep it" and looped on `ask`). It swapped that loop for this one, because it treated `resolve` as purely a routing question ("which existing persist path?") when it is also a lifecycle question ("what does this note look like at rest?").

## Decision

**One:** the resolve-fully path stamps the `triaged:` settled marker on an OBSERVATION, in the same atomic commit that clears `needsAnswers` and deletes the sidecar. A kept note therefore rests as `triaged: resolve` + `needsAnswers: false` + no sidecar + the harvested answers in its body. The stamp is structural in `apply-persist.ts` (derived from the item identity, not passed by the caller), so no route into the resolve-fully path can forget it. A TASK/SPEC is deliberately NOT stamped: its status is its folder, it is not enumerated from the observation inbox, and there is no triage rung to re-ask it.

**Two:** `resolve` MEANS "the question-loop is settled AND this note is still a live signal". The decision prompt now picks between `resolve` and `dispose` on LIVENESS, not on politeness: if the answer means the signal is finished (fixed, covered elsewhere, obsolete, or now wholly carried by a task/spec/ADR/commit), the verdict is `dispose` and the note leaves the inbox by deletion. `resolve` is only correct for a note that still carries a signal nothing else records.

**Three:** the work contract gains the matching cell. `WORK-CONTRACT.md` said there is "no `triaged:` / `needsAnswers:false` resting state", but said it of a DISCHARGED note; it had no cell for a note the answer deliberately KEEPS, which is why the engine had nowhere honest to record one. The contract now describes the kept, triaged resting state explicitly and states what the marker does and does not mean.

**Four:** notes resolved-and-kept BEFORE the stamp existed are back-filled by the triage rung, once each. Their trigger is proof, not a heuristic: only `apply-persist.ts` writes the `## Applied answers` heading, and only after a human answered every open question, so its presence on an unmarked note means the engine already resolved it. The rung stamps what the apply rung would have written and no-ops; the stamped note then drops out of the triage pool, so the arm cannot fire twice for the same note.

## Why

**The marker is the axis the read side already models; only the writer was missing.** `frontmatter.ts` parses `triaged:`, `ledger-read.ts` carries it, `lifecycle-pools.ts` has an explicit branch dropping a marked observation out of the create-side triage pool, `advance.ts`'s triage rung already no-ops on it for an explicit `obs:<slug>`, and `advance-triage-always-asks.test.ts` already pinned "a settled observation is a calm no-op, no question, no spawn" using the literal value `resolve`. The `triaged:` WRITER was removed when the human-stamped `disposition=`/`promote-*` TOKEN vocabulary was retired (task `agentic-apply-retire-disposition-vocabulary`), and `resolve` was added afterwards without noticing it had re-created the one case that needs it. This ADR restores a writer for an axis that never stopped being read.

**Deleting every resolved note instead would destroy exactly what the humans asked to keep.** The tempting alternative reading is that `resolve` should not keep a note at all: the contract says a note leaves the inbox by deletion the moment it stops being a live signal, so "resolve and keep" looks like the backward-artifact-in-a-forward-bucket the contract already forbids. The four `rocketh` answers say otherwise, in the human's own words: "Verified still live and still accurate, so it remains a useful standing map of where the 'no `any`' rule is broken" (with current file/line coordinates), and, three times, "Keep the note until the residue above is either acted on or judged not worth acting on; it is the only record of these choices outside the code." Those notes have not stopped being live signals; their QUESTION has been answered. Deleting them would delete the only record of accepted, user-visible residue, against an explicit instruction to retain it, and the deletion would be the agent's judgement rather than the human's answer.

**Liveness and triaged-ness are two axes, and conflating them is what caused the bug.** The engine had one signal ("is this note in the inbox?") doing the work of two ("is it still a live signal?" and "has its triage question been settled?"). A note can be live and untriaged (the normal case), live and triaged (this ADR's cell), or not live (deleted, no resting state at all). The marker names the second axis so the first no longer has to imply it. This is also why the contract text needed changing rather than being worked around: the missing cell was in the contract, not just in the code.

**The honest half of the delete-instead argument is kept, in the verdict's guidance.** The real risk in "resolve and keep" is that it becomes a soft `dispose` — a polite way to close a loop without deciding, leaving a bucket of notes kept only to show they were handled. That risk is addressed where it lives (the decider's judgement, in its prompt: pick on liveness, and do not use `resolve` as a soft `dispose`), not by removing the verdict that four real answers needed.

**The invariant is untouched.** The stamp is orthogonal to `needsAnswers:false ⟺ no active sidecar` (invariant 1, asserted in `classifyTick`): the resolve path still clears the flag and deletes the sidecar in the same commit, and the marker is a third, independent frontmatter axis the classifier never reads. The classifier keeps its stated two-signal contract; the settled guard that consumes the marker is in the triage RUNG, where it already was.

**A genuinely new question about a settled note is still possible.** An ANSWERED sidecar dominates the `triaged:` marker (ADR `answered-observation-sidecar-dominates-triaged-marker`), so a new question written for a settled note still routes to `apply` and is still answered, and re-resolving simply re-stamps (the marker write is idempotent). What the marker stops is only the engine re-minting its OWN deterministic triage question for a note that has already been through triage.

## Alternatives considered

- **Delete on `resolve` (retire the keep semantics entirely).** Rejected on the evidence above: the humans' answers explicitly instructed retention, and the notes are the sole record of accepted residue. It would also make the apply rung delete a live signal on the AGENT's reading of the answer, which is the one thing the capture-bucket rule bars.
- **Teach `classifyTick` a third signal.** Rejected: the classifier's contract is two signals from a documented state machine, the marker is not a classification input (it does not change WHICH rung applies, only whether that rung has work), and the triage rung's settled guard already existed and was already tested.
- **Recognise the `## Applied answers` body record as the durable settled signal (no frontmatter marker).** Rejected as the primary mechanism: it makes a prose-shaped artifact load-bearing for lifecycle routing, it would need every reader (pool enumeration and rung) to parse bodies rather than frontmatter, and it is destroyed by ordinary human editing of the note. It is used ONLY as the one-time back-fill trigger, where its provenance (engine-written, post-answer) is exactly the proof required, and it converges onto the single frontmatter axis.
- **A one-shot migration command for the stranded notes.** Rejected: it requires a human to know to run it in every consumer repo, and the same self-healing effect is available for free at the seam that would otherwise do the wrong thing.

## Consequences

- A resolved-and-kept observation is a calm no-op on every subsequent cycle: it is dropped at pool enumeration (`lifecycle-pools.ts`) and no-oped at the triage rung on an explicit `obs:<slug>`.
- What stops is the ENGINE re-minting its own triage question for that note. A new question is still posed the way any question is posed for an already-flagged item: write the sidecar and `needsAnswers: true` together (the atomic pair the surface persist writes, so invariant 1 is never torn), and the apply rung consumes the answer as usual. To put a note back into ordinary triage, delete its `triaged:` line — one line, and it is a triage candidate again. This is the pre-existing settled-guard behaviour (`advance obs:<slug>` on a settled note has always been a no-op), not new surface introduced here.
- `resolve` and `dispose` are now distinguished by the note's LIVENESS after the answer, not by tone. Expect (and want) more `dispose` verdicts on notes whose findings are all done or all accepted-and-recorded-elsewhere.
- `triaged:` is written again after the disposition-vocabulary retirement, but with one value (`resolve`) and one writer (the resolve-fully path, plus the one-shot back-fill). It is not a revival of the human-stamped disposition-token vocabulary.
- The back-fill costs one no-op advance leg per already-stranded note, once, and lands as a normal tree-less commit published by `pushTreelessResult`.
