---
'dorfl': patch
---

A `do` (including `--isolated` / `--remote`) job's record now says what actually ran and how the run ended, instead of `createJob`'s placeholder forever.

Until now the whole `do` path never called `updateJobRecord`, so every job record kept its initial values — `harness: {adapter: "null"}` and `state: "running"` — for its entire life, healthy run or not. Only `run` finalised the record (`run.ts` writes the launch's real harness record and maps the terminal outcome onto `state`). In the field this sent an investigation down the wrong path twice: a healthy pi run's record read as "the null harness was launched with an empty agentCmd", and a run that had reached a terminal decision read as "still in flight" because nothing ever moved it off `running`. Both were the placeholder, not facts.

Two changes, mirroring `run`'s discipline exactly:

1. `runDoAgent`/`launchAgentUnderWriterLock` now thread the launch's REAL `HarnessRecord` (adapter + pid/session liveness anchor) out, and the no-checkout pipeline writes it with `updateJobRecord(cwd, {harness: ...})` the moment the launch settles. The pid/session anchor is also what `status`/`gc` need to answer liveness for a do-path job at all.

2. `performDoRemote` finalises the record to match the terminal outcome before teardown: `completed` → `done`; the needs-attention family, the failure-cause axis, `agent-stopped`, `deadline-surfaced`, and refusals → `needs-attention` with the pipeline's own message as the recorded reason (so `status` surfaces WHY without re-deriving it). `deadline-auto-continued` and lost/contended claims are deliberately untouched — nothing needs attention, and a retained checkpoint job genuinely is not over, the next claim continues it. A pipeline that THREW skips the write: that failure is already loud, and the retained record now carries the real harness anchor so `status` reads it as crashed-running-but-dead, which is honest.

The in-place `do` has no job record (there is no job worktree), so nothing changes there; `updateJobRecord` is a no-op without an existing record either way.

Adds end-to-end tests driving the real `performDoRemote` with a stub harness and the arbiter taken offline mid-run (so the worktree + record are retained and readable): the record carries the stub's adapter/pid/session rather than the placeholder, a failed agent lands `needs-attention` with the failure detail as the reason, and a deadline route records itself instead of a bare `running`. All three fail against the pre-fix code.
