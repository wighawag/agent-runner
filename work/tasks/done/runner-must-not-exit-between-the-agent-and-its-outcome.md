---
title: 'The runner must not exit between the agent and its outcome: a deadline reap let node exit 0 mid-checkpoint'
slug: runner-must-not-exit-between-the-agent-and-its-outcome
spec: dorfl
blockedBy: []
covers: []
---

## What to build

Close the window in which a runner can exit while an agent launch is unsettled, so a deadline stop can never again be reported as a clean success while the item stays locked and the work stays uncommitted.

Field evidence (dorfl 0.13.0, harness `pi`, `do task:<slug> --isolated --allow-backlog --propose --no-review`, `agentDeadlineMinutes: 90`, driving `jolly-roger-eth/ethereum-indexer`): two consecutive runs of one task printed only the claim/onboard preamble, then went silent and exited 0 after exactly 90 minutes each. No gate, no commit, no pushed branch, no PR. The lock was left `implement/active`, the job record left `"state": "running"`, roughly 35 files of real agent work were left unsaved in the job worktree, and the worktree writer sentinel was left held by a dead pid (proving the pipeline never unwound). Ten shorter tasks in the same session with identical config were unaffected, because only a run that reaches the deadline takes this path.

The mechanism is that an `await` is not a handle. Node keeps a process alive for referenced handles, and a suspended promise is not one. On the deadline path `PiHarness.launchAsync` drops every handle it owns the moment pi exits (destroys the stdio pipes, `unref`s the child) and then leaves the promise pending across `reapProcessGroup`, whose poll timer was `unref`'d. With any group member still alive at the reap's first probe (a tool subshell, a test runner, an MCP server), the loop had nothing referenced left, so node exited normally with code 0 and the entire suspended pipeline (checkpoint save, branch push, lock release, sentinel release, record update) never ran.

## Acceptance criteria

- [ ] `reap-agent-tree.ts`'s poll sleep uses a REFERENCED timer, with the reason recorded at the site (the reap is bounded by construction, so referencing it cannot hang a runner).
- [ ] `PiHarness.launchAsync` holds a referenced keep-alive from spawn until the promise settles, released on BOTH the resolve and reject paths so a failed spawn cannot pin the loop.
- [ ] Exiting with a launch in flight is LOUD and never reports success: a process `exit` guard writes a synchronous diagnosis to fd 2 naming the recovery (`requeue`) and forces a non-zero exit code.
- [ ] A regression test runs a BARE runner process (not in-process): it asserts the code after the `await` and the surrounding `finally` both run, and that the deadline stop still carries proof the tree is gone.
- [ ] That test FAILS on the pre-fix code with the field symptom exactly (preamble printed, nothing after the await, no `finally`, exit 0).
- [ ] The existing in-process deadline/reap guarantees are untouched (`checkpoint-reaps-agent-tree.test.ts`, `graceful-pre-timeout-checkpoint.test.ts`, `graceful-checkpoint-routing.test.ts` stay green).

## Decisions

**Two independent layers, not one.** The `unref`'d poll timer is the proximate cause and fixing it alone makes the reproduction pass, but "the reap happens to be the last handle holder" is an invariant nothing enforces: any future code that awaits after the child is released re-opens the same hole. So the launch also holds an explicit keep-alive (prevents the known mechanism) AND arms an exit guard (refuses to let a future variant be mistaken for a clean run). The guard is the part that would have surfaced this incident on day one, since the silent exit 0 is what let a driving loop read it as a completed build.

**The guard writes with `writeSync` on fd 2, not `console.error`.** stderr to a pipe is asynchronous, and an `exit` listener is the last synchronous moment there is, so a buffered write would be dropped precisely when it matters.

**The regression test had to leave the test process.** Inside vitest the defect is unobservable, because the runner's own handles keep the loop alive: the pre-existing in-process deadline/reap suite passes both before and after the fix. Any test for "the process must not exit" has to own the process.

**Two field beliefs were disproved rather than acted on.** The run's `harness: {"adapter": "null"}` was read at the time as proof that a null harness ran, and the `options.harness ?? new NullHarness()` fallback as the culprit. Neither holds: `createHarness` always constructs and threads an instance on every CLI path, and `createJob` writes `{adapter: 'null'}` as the INITIAL record value that the whole `do` path never updates (only `run` finalises it), so every `do` job reads that way whether healthy or not. The pi session logs prove a real `PiHarness` ran for the full 90 minutes both times.

**Left deliberately out of scope** (captured in `work/notes/observations/deadline-reap-lets-node-exit-0-before-the-checkpoint-runs.md`): the `do` path never calling `updateJobRecord`, so `state`/`harness` in a job record are non-diagnostic there; and the `?? new NullHarness()` sites remaining a silent default for library/embedding callers (on the CLI the loud refusal already exists earlier, via `doNeedsAgentCmd`).
