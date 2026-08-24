---
title: 'A `do` job record finalises with the real harness record and the real terminal outcome'
slug: do-job-record-finalises-with-real-harness-and-outcome
spec: dorfl
blockedBy: []
covers: []
---

## What to build

The live residue of `work/notes/observations/deadline-reap-lets-node-exit-0-before-the-checkpoint-runs.md`: the whole `do` path (in place and `--isolated`/`--remote`) never called `updateJobRecord`, so `createJob`'s initial record — `harness: {adapter: "null"}`, `state: "running"` — stood forever on every do job, healthy or failed. Only `run` finalised its records. The placeholder then did real damage in the field: it was read as evidence that the null harness launched (sending the diagnosis after `options.harness ?? new NullHarness()`, which a pi session log later disproved), and as evidence that an ended run was still in flight.

Give the `do` path the same record discipline `run` already had, with no behaviour change to claiming, routing, gating, or teardown.

## Acceptance criteria

- [ ] The launch's REAL `HarnessRecord` (adapter + pid/session anchor) is threaded out of `runDoAgent`/`launchAgentUnderWriterLock` and written with `updateJobRecord` the moment the no-checkout pipeline's launch settles, mirroring `run.ts`'s `updateJobRecord(tree.dir, {harness: launched.record})`.
- [ ] `performDoRemote` finalises the record to match the terminal outcome before teardown: `completed` → `done`; every other routed/terminal decision (needs-attention family, failure-cause axis, `agent-stopped`, `deadline-surfaced`, refusals) → `needs-attention` with the pipeline's message as the recorded `reason`.
- [ ] `deadline-auto-continued`, `lost`, and `contended` leave the record untouched, and the helper documents why (nothing needs attention; a retained checkpoint job is genuinely not over).
- [ ] A pipeline that THREW skips the write; the retained record still carries the real harness anchor from the launch-time finalisation, so `status` reads it as crashed-running-but-dead.
- [ ] The in-place `performDo` is unaffected (no job record exists there; `updateJobRecord` no-ops without one).
- [ ] End-to-end tests against the real `performDoRemote` with a stub harness + an arbiter taken offline mid-run (tree retained, record readable): real adapter/pid/session recorded; failed agent → `needs-attention` with the failure detail as the reason; deadline route → recorded reason names the deadline checkpoint. All fail against the pre-fix code.

## Decisions

**Mirror `run`, don't invent a second discipline.** The mapping (`done` on completed, `needs-attention` + reason on routed outcomes, harness record finalised at launch) is copied from `run.ts`'s tail rather than redesigned, so `status`/`gc` read one vocabulary regardless of which entry point produced the record. Two deviations, both deliberate: `deadline-auto-continued` is untouched (run has no deadline checkpoint; a retained checkpoint job is honestly "not over"), and `prUrl` is not recorded on the `completed` path — `DoResult` does not carry the integration URL the way `run`'s core outcome does, and the record is normally reaped seconds later; chasing it is not worth a return-type change here.

**The harness record is finalised at launch-settle, not earlier.** Writing it at spawn (before the promise settles) would be the strictly-better diagnosis story for a `kill -9`ed runner, but the harness owns record construction and only surfaces it in `LaunchResult`; reaching in earlier means changing the seam contract. With the exit-0 defect fixed, settle always arrives, so launch-settle placement covers every reachable case, and a truly hard-killed runner leaves the real anchor nowhere — which is itself the honest signal (`status` reads running-but-dead).

**The one-off fix the field actually needed is upstream of this.** A reader can now trust a do job record, but note the ordering: a crash between `createJob` and launch-settle (or before the terminal finalisation) still reads `adapter: "null"` + `running`, and with the launch anchor present from settle onwards, `status`/`gc` liveness (`pidAlive`) distinguishes "crashed" from "in flight" — that is exactly the read the stranded investigation was trying to make.
