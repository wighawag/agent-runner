---
needsAnswers: true
---

# An ANSWERED sidecar on a terminal item is never drained, by any path

Date: 2026-09-05
Observer: work on the stranded-`needsAnswers` defect (dorfl 0.13.3). Found while
deciding the scope of that fix; deliberately NOT fixed there.

## What was seen

The field report behind the terminal-question-residue work included four stranded
sidecars naming tasks already at rest in `work/tasks/done/`. One of them had been
ANSWERED in writing by the human, ending with the words "Close this sidecar", and
was still sitting in `work/questions/` regardless.

That is a different defect from the one that motivated the drain. The drain
handles a sidecar nobody answered (the question was settled by OUTCOME: the
rebuild succeeded, so "cancel this item?" is moot). This one was settled by a
human TYPING an answer, and nothing consumed it.

## Why nothing clears it

Two mechanisms could, and each declines for a good reason:

- **The terminal-question drain** (`reconcileTerminalQuestionResidue`) explicitly
  carves it out: a sidecar with any answered entry goes to `answeredHeld` and is
  never auto-deleted, because the prose is data the tool did not author. Correct:
  deleting it would discard the human's decision unread.
- **The apply rung** (`apply-persist.ts`) is what SHOULD consume it, and it never
  runs here. `advance` reaches the apply rung by selecting a live item with an
  active sidecar; an item at rest in `tasks/done/` is not selected, so an answer
  written after the item shipped has no rung that will ever pick it up.

So the answer sits there permanently, and the sidecar with it.

## Why it was left out of scope

Settling an answered sidecar means APPLYING the answer, and the answer can say
several different things (resolve, dispose to a terminal, re-pause with follow-up
questions). That routing IS the apply rung. Draining it from an opportunistic
hygiene sweep on the claim path would be a second, silent implementation of the
apply rung, running unattended, on an item the human has already shipped, with a
destructive default in the envelope. That trade is bad in the direction that
loses data.

The conservative behaviour therefore stands: HOLD the sidecar, never delete it,
and REPORT it. `status` already names these under "Answered but never applied"
(`cwd-section.ts` `unappliedAnswers` → `format.ts`), so the state is visible
rather than silent.

## The residue (what a fix would need to decide)

1. Should the apply rung be reachable for an item that is already terminal? A
   `dorfl apply <item>` that accepts a terminal resting record would consume the
   answer through the ONE existing implementation instead of forking it.
2. If the answer says "dispose" for an item already in `tasks/done/`, what is the
   correct outcome? The disposal target (`tasks/cancelled/`) contradicts the
   durable record that the work shipped. Probably: refuse and tell the human,
   rather than move shipped work into a cancellation terminal.
3. Should an answer written against a shipped item be archived somewhere rather
   than applied at all, given the question it answers is moot by outcome?

None of these is decidable without the human whose answer it is, which is the
other reason this is a report and not a sweep.

## Related, and made slightly worse on purpose (2026-09-05)

The same change that added the stranded-flag sweep removed `specs/tasked/` from
the question-residue terminal map entirely, because WORK-CONTRACT makes
`needsAnswers: true` on a tasked spec a LEGAL drift gate and `lifecycle-gather.ts`
feeds both halves to a live rung. That was the right call: the previous behaviour
DELETED a drifted tasked spec's pending, unanswered sidecar.

But it has a cost worth recording, because it widens the very defect this note is
about. A sidecar on a tasked spec is now skipped BEFORE the answered/pending
split, so it is no longer REPORTED either. Two shapes are now invisible:

1. a tasked spec with a sidecar and `needsAnswers` false or absent. WORK-CONTRACT's
   "re-task in place" instruction says to clear `needsAnswers` and re-task, but
   never says to delete the sidecar. `lifecycle-gather` enumerates only
   `needsAnswers === true`, the orphan sweep retains it because the body exists,
   and the drain now skips it. It is permanent `work/questions/` litter carrying a
   destructive default, plus a standing `sidecar-without-needsAnswers` violation.
2. a tasked spec with an ANSWERED sidecar and the flag cleared. Previously this at
   least appeared under `status`'s "Answered but never applied"; now it appears
   nowhere.

The trade is still right (litter beats destroying a live human decision), and
widening the drain again would re-introduce exactly the defect just fixed. The
cheap correct shape is a THIRD `TerminalKind` (e.g. `open-loop`) for
`specs/tasked/` that is classified and REPORTED but never staged, restoring
visibility without touching state and keeping the folder single-sourced for
`successTerminalFolders()` through the same `kind` filter. That is the suggested
fix for both this section and the main note above: one reporting path, no new
sweep.
