<!-- dorfl-sidecar: item=observation:answered-sidecar-on-a-terminal-item-is-never-drained type=observation slug=answered-sidecar-on-a-terminal-item-is-never-drained allAnswered=false -->

Item: [`observation:answered-sidecar-on-a-terminal-item-is-never-drained`](../notes/observations/answered-sidecar-on-a-terminal-item-is-never-drained.md)

## Q1

**Should the apply rung be reachable for an item that is already at rest in tasks/done/, so a hand-written answer on its sidecar is consumed via the one existing implementation rather than a second sweep?**

> Residue Q1 in the note: today advance selects only live items, so an ANSWERED sidecar on a shipped task has no rung that will ever pick it up. A dorfl apply <item> that accepts a terminal resting record would route the answer through the same code path (resolve / dispose / re-pause) instead of forking it into an opportunistic hygiene sweep.

_Suggested default: Yes: extend apply to accept terminal resting records; keep the drain answered-safe as today._

<!-- q1 fields: id=q1 -->

**Your answer** (write below this line):

## Q2

**When an answer on a shipped (tasks/done/) item says 'dispose', what is the correct outcome given the durable record says the work shipped?**

> Residue Q2. Moving a done item into tasks/cancelled/ contradicts the shipped record. The note tentatively prefers refusal-with-report over destructive routing.

_Suggested default: Refuse the dispose route on a done item and tell the human; never move shipped work into a cancellation terminal._

<!-- q2 fields: id=q2 -->

**Your answer** (write below this line):

## Q3

**Should an answer written against a shipped item be applied at all, or archived somewhere as after-the-fact commentary since the question it answers is moot by outcome?**

> Residue Q3. The original question (e.g. 'cancel this item?') was settled by outcome (the rebuild succeeded), so the human's later prose may be commentary rather than an actionable directive.

_Suggested default: Archive-and-report by default; only apply if the answer names a still-live follow-up._

<!-- q3 fields: id=q3 -->

**Your answer** (write below this line):

## Q4

**Adopt the proposed third TerminalKind (e.g. open-loop) for specs/tasked/ so a sidecar on a tasked spec is REPORTED but never staged, restoring visibility for the two now-invisible shapes without widening the drain?**

> Section 'Related, and made slightly worse on purpose': removing specs/tasked/ from the terminal map (correct, to stop deleting drifted tasked-spec sidecars) also hid (a) tasked spec + sidecar with needsAnswers absent (permanent litter + standing sidecar-without-needsAnswers violation) and (b) tasked spec + ANSWERED sidecar + flag cleared (previously visible under status 'Answered but never applied', now nowhere). A new kind classified through the same successTerminalFolders() filter would report without touching state.

_Suggested default: Yes: add TerminalKind.OpenLoop for specs/tasked/, wire it to the 'Answered but never applied' + 'sidecar litter' report, do not stage it._

<!-- q4 fields: id=q4 -->

**Your answer** (write below this line):
