---
'dorfl': patch
---

Stop the runner exiting 0 in the middle of its own deadline checkpoint, leaving the item locked, the work uncommitted, and the run reported as a success.

Observed in the field twice on one task (dorfl 0.13.0, harness `pi`, `do task:<slug> --isolated --allow-backlog --propose --no-review`, `agentDeadlineMinutes: 90`): both runs printed only the claim/onboard preamble, then went silent and exited 0 after exactly 90 minutes. No acceptance gate, no commit, no pushed branch, no PR. The item lock was left `implement/active`, the job record left `"state": "running"`, and roughly 35 files of real agent work were left unsaved in the job worktree. Ten shorter tasks in the same session with the same config were fine, because only a run that actually reaches the deadline takes this path.

An `await` is not a handle. Node keeps a process alive for referenced HANDLES (timers, sockets, child processes); a suspended promise is none of those. On the deadline path `PiHarness.launchAsync` deliberately drops every handle it owns the moment pi exits (it destroys the stdio pipes and `unref`s the child so a leaked grandchild's inherited FDs cannot pin the loop) and then keeps the launch promise PENDING across `reapProcessGroup`, whose poll timer was itself `unref`'d. So whenever any group member was still alive at the reap's first probe (a tool subshell, a test runner, an MCP server, or in the observed run the `sleep` the agent was parked in), the event loop had nothing referenced left, node did the correct thing with an empty loop and exited normally with code 0, and the whole suspended pipeline never ran: no WIP commit, no branch push, no lock release or needs-attention surface, no worktree-writer-sentinel release, no job-record update. The exit status was a genuine 0, so nothing upstream could tell it from a completed build.

The reap being the sole remaining handle-holder is not an accident of that one timer, so the fix has two independent layers:

1. `reap-agent-tree.ts`'s sleep timer is REFERENCED. The reap is bounded by construction (`sigtermGrace + sigkillTimeout`), which is what made the `unref` look free; it was not, because by then it is the only thing standing between the runner and an empty loop.

2. `PiHarness.launchAsync` holds an explicit referenced keep-alive for exactly as long as the launch is unsettled, and arms a process `exit` guard that turns any OTHER way of exiting mid-launch into a LOUD, non-zero failure naming the recovery (`requeue`) instead of a silent success. The keep-alive prevents the known mechanism; the guard refuses to let a future variant of it be mistaken for a clean run. It is released on both settle paths, so a failed spawn cannot pin the loop.

Two field beliefs this corrects, both wrong and both costly at the time: the run's `harness: {"adapter": "null"}` in `~/.dorfl/work/<work-id>.json` is NOT evidence that a null harness ran (`createJob` writes `{adapter: 'null'}` as the initial value, `jobWorktreeStrategy` passes no harness, and the whole `do` path never calls `updateJobRecord` at all, so every `do` job reads that way whether healthy or not; only `run` finalises the record), and the `options.harness ?? new NullHarness()` fallback cannot fire from any CLI path, since `createHarness` always constructs and threads an instance. Neither was the cause.

Adds regression tests that run a BARE runner process, because the defect is invisible in-process: vitest's own handles keep the loop alive, which is exactly why the existing in-process deadline/reap suite passed throughout. Without the fix the new test reproduces the field symptom byte for byte (preamble printed, nothing after the `await`, no `finally`, exit 0).
