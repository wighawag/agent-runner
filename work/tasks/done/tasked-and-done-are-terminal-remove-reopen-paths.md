---
title: '`specs/tasked/` and `tasks/done/` are TERMINAL: remove the documented reopen paths and name each regime''s honest redo path'
slug: tasked-and-done-are-terminal-remove-reopen-paths
blockedBy: []
covers: []
---

## What to build

Make the `work/` contract say what it already half-says and what the code already does: **`work/specs/tasked/` and `work/tasks/done/` are TERMINAL positions with no exits.** Remove the two documented "reopen" transitions, and replace each with the honest redo path for its regime.

This is a **documentation-only** change. No reopen is implemented anywhere: grepping `packages/dorfl/src` for a `specs-tasked → specs-ready` or `tasks/done → tasks/ready` transition finds nothing, and the only `reopen` in the source is GitHub PR reopening in the provider, which is unrelated. The spec-resolution lists that mention `specs-tasked` (the advance resolver, the item-path resolver, the sidecar folder list) are *where to FIND a spec* lists, not transition lists, so they need no change.

### Why: the contract currently contradicts itself

Three statements in `WORK-CONTRACT.md` cannot all be true:

1. It forbids `specs/tasked/ → specs/proposed/` with the reason that moving an already-tasked spec back "falsely un-records a tasking that really happened and ORPHANS the tasks it already emitted", and states outright: "Tasked-ness is RESIDENCE in `specs/tasked/` and must never be silently rewound."
2. Two lines later it sanctions `specs/tasked/ → specs/ready/` as "the existing reopen path".
3. The governance-regime section states each durable item "has one destiny".

Since residence IS the signal, (2) un-records tasked-ness exactly as much as the move (1) forbids, and both contradict (3). The reasoning given for forbidding one condemns the other.

### The decisions to encode

- **`work/specs/tasked/` is terminal, with NO exits.** It records the permanent fact "this spec was decomposed into tasks". What became of those tasks (built, cancelled, abandoned) is recorded on the TASKS, not by rewinding the spec.
- **Re-tasking happens IN PLACE, from `work/specs/tasked/`.** The folder's only operational jobs are gating AUTO-tasking (the auto-tasker draws from `work/specs/ready/` only) and satisfying `taskedAfter` (which resolves against `work/specs/tasked/` residence). A human re-tasking a spec that stays put disturbs neither. `TASKING-PROTOCOL.md` §6 already says "The DESTINATION is always `tasked/` regardless of source", so a re-task from `tasked/` is a no-op move that already works.
- **The boundary between re-tasking and minting a new spec.** User stories UNCHANGED means the decomposition was wrong: re-task in place, same slug, same `issue:` thread, and supersede the stale emitted tasks into `work/tasks/cancelled/` (reason: superseded by the re-task). User stories CHANGED means the intent moved: mint a NEW spec and move the old one to `work/specs/dropped/`. This test is checkable, because a spec settles to Problem / Solution / User Stories / Out of Scope after its one-time trim, so "did the stories change" is a real diff. It also stops "re-task" from becoming a euphemism for quietly redefining what is being built.
- **`work/tasks/done/` is terminal, with NO exits.** Redoing landed work is a NEW task, never a rewind. Note the ASYMMETRY with specs and state it: a spec in `tasked/` can still be tasked by a human (tasking is not folder-gated on the human path), but a task in `done/` is genuinely unclaimable, because the claimable predicate is "in `tasks/ready/` on `main` AND no lock held". So a task cannot be driven in place from its terminal, and a new forward artifact is the only honest answer. This matches the contract's existing DIRECTION and LIVENESS rule: completed work is a `tasks/done/` record plus its commit, never a back-filled forward artifact.
- **The won't-proceed terminals are reachable only from the NON-terminal positions.** `work/specs/dropped/` is reachable from `proposed/` and `ready/` (a spec that was never tasked); `work/tasks/cancelled/` from `backlog/` and `ready/`. There is no `tasked/ → dropped/` and no `done/ → cancelled/`. This is what resolves the open question of which exits from `specs/tasked/` exist: none.
- **The drift case keeps a complete answer.** `WORK-CONTRACT.md`'s "A SPEC that has drifted AFTER it was TASKED" section currently offers two mechanisms; removing reopen leaves ANNOTATE IN PLACE (`needsAnswers: true` while the spec stays in `specs/tasked/`, which the contract already declares legal and which the sidecar folder list already supports) plus RE-TASK IN PLACE. Together they still cover the case, so rewrite the second bullet rather than deleting it.

### Where the prose lives (inventory)

The reopen claim appears in exactly three places, two of which are a mirrored pair:

- `CONTEXT.md`, the spec-lifecycle glossary bullet: the trailing "Re-task = ... (reopen-to-ready, mirroring `tasks/done/ → tasks/ready/`)" sentence.
- `WORK-CONTRACT.md`, the spec-lifecycle section: the trailing "Re-tasking a reshaped spec is ... (reopen-to-ready, mirroring ...)" sentence.
- `WORK-CONTRACT.md`, the drift section: the "**Reopen to re-decompose (the sanctioned move).**" bullet.

`WORK-CONTRACT.md` exists TWICE and the source is `skills/setup/protocol/` (see the prompt).

### Sweep in one pre-existing mirror drift

`skills/setup/protocol/spec-template.md` and `task-template.md` currently differ from their `work/protocol/` copies on a single line each: the mirror has `title: '<Human Readable Title>'` (quoted), the source has it unquoted. This is pre-existing drift unrelated to the reopen change, but it sits directly in this task's acceptance gate (mirror byte-identity), so resync it rather than weakening the gate. Pick the QUOTED form as canonical (safer YAML for a real title containing a colon) and propagate SOURCE to mirror in the correct direction.

## Acceptance criteria

- [ ] No "reopen" transition prose remains in `CONTEXT.md` or in either copy of `WORK-CONTRACT.md`; a grep for `reopen` across `CONTEXT.md`, `work/protocol/`, and `skills/setup/protocol/` returns nothing.
- [ ] Both copies of `WORK-CONTRACT.md` state explicitly that `work/specs/tasked/` and `work/tasks/done/` are TERMINAL with no exits, and that the won't-proceed terminals are reachable only from the non-terminal positions.
- [ ] The drift section's second mechanism is REWRITTEN as re-task-in-place (not deleted), so the drifted-after-tasking case still has a complete answer alongside annotate-in-place.
- [ ] The re-task versus new-spec boundary (stories unchanged / stories changed) is stated in `WORK-CONTRACT.md`.
- [ ] The task-versus-spec asymmetry is stated with its reason (a `done/` task is unclaimable because the claimable predicate requires residence in `tasks/ready/`; a `tasked/` spec is still human-taskable).
- [ ] `CONTEXT.md`'s spec-lifecycle glossary bullet agrees with the contract (no reopen, terminal stated).
- [ ] `TASKING-PROTOCOL.md` §6 is checked against the change and updated only if it implies a reopen; its existing "DESTINATION is always `tasked/` regardless of source" line already permits re-tasking in place, so a no-op is an acceptable outcome here as long as it is verified.
- [ ] `diff -r skills/setup/protocol work/protocol` is clean apart from `VERSION` (which legitimately exists only in `work/protocol/`). This includes the swept-in `spec-template.md` / `task-template.md` title-quoting resync.
- [ ] No source file under `packages/dorfl/src` is changed (this is documentation-only). If the work reveals a code site that genuinely depends on a reopen transition, STOP and report it rather than expanding scope.
- [ ] `pnpm format` has been run and `pnpm -r build && pnpm -r test && pnpm format:check` is green.

## Blocked by

- None — can start immediately.

## Prompt

You are making a DOCUMENTATION-ONLY change to the `work/` contract in the `dorfl` repo: making `work/specs/tasked/` and `work/tasks/done/` explicitly TERMINAL, removing the two documented "reopen" transitions, and replacing each with its regime's honest redo path. Read this file's "What to build" fully; it contains the decisions to encode and an exact inventory of where the prose lives.

**THE TRAP, read this first.** This repo is both a USER of the dorfl protocol and its AUTHOR, so the protocol docs exist TWICE:

- `skills/setup/protocol/*` is the **SOURCE OF TRUTH**. `setup` copies these into every consuming repo's `work/protocol/`. Edit the protocol HERE.
- `work/protocol/*` is a **propagated COPY** for this repo's own use. Treat it as generated.

You must make the SAME change in BOTH so they stay byte-identical (`diff -r skills/setup/protocol work/protocol` clean apart from `VERSION`). Editing `work/protocol/` alone silently drifts the copy from the source, and the next `setup` run propagates the OLD source text, losing the change in every other repo. See the repo's `AGENTS.md`.

**Domain vocabulary** (use it; do not invent synonyms): status is the FOLDER, never a frontmatter field; a durable transition is a `git mv` on `main`; TASKED-NESS is RESIDENCE in `work/specs/tasked/`; the two won't-proceed terminals are deliberately different words per regime (`tasks/cancelled/` for tasks, `specs/dropped/` for specs) to avoid a slug collision; `taskedAfter` gates TASKING against `specs/tasked/` residence, while `blockedBy` gates BUILDING against `tasks/done/`. `CONTEXT.md` is the glossary and is itself one of the files you are editing, so keep it consistent with what you write in the contract.

**Where to look:** `CONTEXT.md` (the spec-lifecycle glossary bullet), `skills/setup/protocol/WORK-CONTRACT.md` and its `work/protocol/` mirror (the spec-lifecycle section and the drift section), and `skills/setup/protocol/TASKING-PROTOCOL.md` §6 plus its mirror (verify only).

**Ground the "no code implements this" claim before you rely on it.** Grep `packages/dorfl/src` for any transition between the terminal and pool folders. The expected result is that only *resolution* lists mention `specs-tasked` (where to FIND a spec) and no transition does. If you find an actual reopen implementation, that contradicts this task's premise: STOP and report it rather than deleting prose that describes real behaviour.

**Seam and verification.** There is no code seam here; the gate is the acceptance criteria plus `diff -r` mirror byte-identity plus the repo's standard `pnpm -r build && pnpm -r test && pnpm format:check`. To fix formatting run `pnpm format` (the writer), NOT `pnpm format:check` (the read-only gate). Note `format:check` is a ROOT-only script, so it is `pnpm format:check`, never `pnpm -r format:check`.

**Scope discipline.** The one deliberate extra is the `spec-template.md` / `task-template.md` title-quoting resync described above, which is swept in only because it would otherwise fail this task's own mirror-identity gate. Anything else you notice goes in a dated `work/notes/observations/<slug>.md` note, not in this change.

**Record any non-obvious decision** you make while writing the prose (a wording choice that changes a rule's scope, a place where the existing text turns out to be wrong in a way this task did not anticipate) durably and linked from the done record, per the standard rule.

FIRST, check this task against current reality: it is a launch snapshot and may have DRIFTED. Confirm the three prose locations still exist as described and that the mirror drift is still present. If the contract has already been changed such that the premise no longer holds, do NOT build on the stale premise: report the discrepancy so the item routes to needs-attention.
