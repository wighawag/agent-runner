---
name: triage-observations
disable-model-invocation: true
description: 'Drain the work/notes/observations/ inbox one note at a time, human-in-the-loop: investigate each, recommend an outcome, the human decides, execute.'
---

# Triage observations

Drain `work/notes/observations/` toward a **live-only inbox**: every note that survives is still a useful signal; everything else is discharged. You are the investigator + recommender; the **human owns every call**.

> An observation is a **spotted, unverified, often-stale signal** — NOT ground truth. The whole value of this loop is _investigating before judging_: "this is surely irrelevant now" must become a real check against current code, which sometimes agrees and sometimes doesn't.

## The loop (one observation at a time)

Default to **alphabetical order** (the folder listing — `ls work/notes/observations/`), so a full pass deterministically covers the whole inbox with nothing skipped or repeated. The human may override with their own order or name specific files; when they do, follow that and do NOT jump ahead or batch. For each:

1. **READ** the observation in full.
2. **INVESTIGATE** its claim against _current reality_ — read the actual code, tasks, specs, ADRs, and protocol docs it references. Confirm every file/line pointer (repos drift; paths move — e.g. a monorepo's `packages/*/src/`). Establish: is this signal still LIVE? **Also read the item's own open-question surface**: any `work/questions/<type>-<slug>.md` sidecar for this note and the source's `needsAnswers` / `## Open questions` state. An exact-item question match is cheap and required (the note may already be mid-resolution, which changes the call). Topical overlap with ANOTHER item's open questions is a signal to surface to the human, never to auto-decide on.
3. **RECOMMEND** exactly one outcome (the recommendation set below), with reasoning grounded in what you found — not a guess.
4. **WAIT** for the human's decision. Never auto-decide. Surface any genuine judgement residue (e.g. "is this spec's untasked state intentional?") as an explicit question.
5. **EXECUTE** the chosen outcome. For light ones (delete, small amend) do the write + **COMMIT** (scoped — one logical change per commit) before moving on. For heavy ones (make-task, non-trivial fold-into-ADR) do NOT build inline — hand off a copy-pasteable fresh-context prompt (see below) and move on; the note is deleted by that follow-on work, not here.
6. **UPDATE** a running checklist of outcomes so the session has an at-a-glance summary.

## The recommendation set

This is THIS skill's own human-workflow recommendation set — the small menu of things a human can decide to do with an investigated note. It is NOT the engine's old `disposition=` token vocabulary (that token round-trip is retired: an answered question is now read by the agentic apply decision, not routed through a stamped token). Here you simply recommend one of these in plain terms and the human ratifies it.

| recommendation | when | execution |
| --- | --- | --- |
| **leave** | still a live, useful signal; just not acting now | nothing (note stays) |
| **delete** | no longer a live signal — its work landed, the defect is fixed, or it was promoted into a self-contained task/ADR | the direct delete: `git rm` the file (or `dorfl drop obs:<slug>`, which also removes any question sidecar), reason in the commit message |
| **make a task** | there is buildable residue worth promoting | hand off a fresh-context prompt (below); do NOT write the task inline |
| **amend** | still live but inaccurate/stale; the _record_ should be corrected | edit the note (observations are append-only in spirit — prefer an `## Update` over rewriting what was seen) — small in-loop edits are fine; hand off if it needs real investigation |
| **fold-into-ADR / code comment** | the durable _why_ belongs in an ADR or a code comment, not the inbox | hand off a fresh-context prompt (below) when non-trivial; do the note + delete inline only when it is a genuine one-liner |

A note's liveness test is **"is this still a useful signal?"** — NOT "has the work it points at completed?".

> **Throwing a signal away is a DIRECT delete, not a token.** When the call is to discard a note, you (or the human) just delete it: `git rm` the file, or `dorfl drop <identity>` (the one-line CLI helper, which removes the source AND its question sidecar in one revertible commit with the reason in the message). It does NOT round-trip through the decision engine — there is no `delete`/`dropped` token to stamp. Promotion is the mirror: minting a self-contained task/spec/ADR that carries the signal, after which the note discharges by deletion.

## Hand off heavy work as a fresh-context prompt

The triage loop **decides**; it does NOT carry out the follow-on build inline. When a recommendation needs real work, produce a **copy-pasteable prompt** for the human to run in a FRESH context, and STOP there (don't also try to do the work).

> **CRITICAL — match the prompt's DELIVERABLE to the outcome, not to the feature.** A **make-task** hand-off must produce a prompt whose deliverable is **a markdown TASK FILE in `work/tasks/backlog/`** (per the task template) — NOT a prompt that implements the feature/fixes the bug in code. The observation is being _promoted into a tracked work item_, not built. A prompt that says "implement X / fix Y / write the code and tests" is the WRONG output here — that conflates promoting the work with doing it. The task itself is the deliverable; building it is a separate, later step the task will drive. (Likewise a **fold-into-ADR** hand-off delivers an ADR edit, not code.)

Rules for the prompt:

- **Right deliverable.** State it explicitly at the top: "Write a work task at `work/tasks/backlog/<slug>.md` following `work/protocol/task-template.md`" (make-task) or "Add a section to `docs/adr/<file>.md`" (fold-into-ADR). The fresh agent must finish by having WRITTEN THAT FILE, not by having changed product code.
- **Prefix-free body.** No Markdown blockquote `>` bars, no `|` sidebars, no line-number gutters — the human pastes it verbatim, so any per-line prefix has to be hand-stripped. Delimit it with a `---` rule before and after (or a fenced block if it contains no triple backticks), but keep the body itself decoration-free.
- **Self-contained.** Name the source observation, the exact files/seams the TASK should point its future builder at (verified paths), the change the task should specify, and the acceptance criteria the task should carry. Fold in everything — the fresh agent has none of this session's context. (Note these are inputs to WRITING THE TASK, not a to-do list for the fresh agent to execute.)
- **Carry the discharge instruction.** End with: once the task/ADR file is written and self-contained, DELETE the source observation (it has discharged) — so the inbox is drained by the follow-on artifact, not left as a resolved-but-kept note.

Compose with the `to-task` discipline if available — it produces exactly this task-file deliverable.

## Protocol rules this loop enforces

Apply the `work/` contract (`work/protocol/WORK-CONTRACT.md`), especially:

- **Discharge by deletion.** A capture-bucket note leaves the inbox by **deletion** the moment it stops being a live signal (git history is the archive). There is no `resolved` status for a spent signal; a note kept only to narrate that it was dealt with is a contradiction. The one note that legitimately stays is one whose signal is STILL live after the answer (a standing map of a known gap, accepted residue recorded nowhere else): it rests `triaged: <disposition>` + `needsAnswers: false` with the answers harvested into its body, and the marker means its question-loop is settled, never that its signal is finished.
- **Promoted notes discharge on SPAWN, not on landing.** A note promoted into a task/ADR is deletable AS SOON AS that artifact carries its signal — _verify self-containment first_ — NOT when the spawned work lands in `tasks/done/`. "Delete once the task lands" is the resolved-but-kept contradiction. If the spawned artifact is NOT self-contained, the bug is the artifact (fix it to carry the signal), not a reason to keep the note.
- **Forward & live only.** Don't back-fill a task/observation to narrate already-done work. A surviving observation describes a _pending or currently-signalled_ concern.

## Two common discharge patterns

- **The spent drift-pointer:** the task/code it warned about already landed, and its warning was inlined into that artifact → **delete**.
- **The fixed-defect note:** read the code; if the defect it describes is gone, the note is a tombstone → **delete** (optionally preserve the _why_ as a code/ADR note first).

## Repo-specific trap (dorfl)

`dorfl` is both **author and user** of the protocol. The protocol **source of truth** is `skills/setup/protocol/`; `work/protocol/` is a propagated **copy**. NEVER edit `work/protocol/` alone — edit the source and mirror both (see that repo's `AGENTS.md`). Other repos have only `work/protocol/`.

## Guardrails

- **Investigate, don't assume.** A confident "this is obsolete" is a _hypothesis_ until checked against the code.
- **Never auto-decide.** Recommend → WAIT → execute. The human owns the call. (Likewise, throwing a note away is the human's DIRECT delete — `git rm` / `dorfl drop` — not a token routed through the engine.)
- **Self-containment is a precondition for promote-then-delete.** If you make a task and delete the note, the task must stand alone.
- **Clean tree before writing.** Confirm the repo is ready for writes (the human will say so); commit in scoped commits as you go.
- **One at a time, human's order.** Don't fan out across the inbox.
