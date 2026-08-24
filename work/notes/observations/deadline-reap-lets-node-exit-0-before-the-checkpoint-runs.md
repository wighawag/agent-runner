---
needsAnswers: false
triaged: keep
---

# At the agent deadline the runner exits 0 mid-flight: no checkpoint, no WIP commit, lock left `active`

Date: 2026-08-23
Observer: field run of dorfl 0.13.0 (installed in the target repo, forwarded via `dorflCmd`) driving `github.com/jolly-roger-eth/ethereum-indexer`, harness `pi` (pi 0.80.6), `dorfl do task:<slug> --isolated --allow-backlog --propose --no-review`, `agentDeadlineMinutes: 90`, `maxAutoCheckpoints: 5`, `review: false`, `freshWorktreeGate: true`.

The exit-0 mechanism is FIXED (see `## Update 2026-08-23` at the end). The note is KEPT for the residue that is still live: on the `do` path a job record's `state`/`harness` fields are non-diagnostic, which is what sent the original field diagnosis down the wrong path.

## What was seen

Two consecutive runs of the same task printed only the claim/onboard preamble and then went silent:

```
>> Using hub mirror for git@github.com:jolly-roger-eth/ethereum-indexer.git at ...
>> CLAIMED '<slug>' (lock held; body stays in work/tasks/backlog/ on origin/main).
>> Start work:  git fetch origin && git switch -C work/task-<slug> origin/main
>> Resumed '<slug>': switched to work/task-<slug> (no claim).
```

No further output, no acceptance gate, no commit, no pushed branch, no PR. The item lock was left `implement/active`, the job record at `~/.dorfl/work/<work-id>.json` was left `"state": "running"`, and the job worktree held roughly 35 modified/added files of real, unsaved agent work. Ten other tasks in the same session, same config, same flags, completed normally.

The runs did not fail fast: each lasted 90.5 minutes wall clock, which is exactly `agentDeadlineMinutes: 90` plus the time to notice. That is the tell: this is the DEADLINE path, not a launch failure.

## Evidence trail (all of it independent of the runner's own reporting)

- Both runs DID launch the pi agent. Sessions exist under the job worktree's session folder and carry the build prompt: run 1 `11:43:16Z` to `13:13:14Z`, run 2 `13:16:26Z` to `14:32:39Z`. Both end abruptly mid-turn, consistent with the deadline SIGTERM reaching the process group.
- The runner died within a second of the deadline instant. Run 2: writer sentinel acquired `13:16:25.664Z`, so the deadline fell at `14:46:25.7Z`; the driving shell's command returned at `14:46:25.906Z`.
- The worktree writer sentinel (`.git/worktrees/<id>/dorfl-writer.json`) was still present with `"pid": 3414863` and no live process. That sentinel is released in a `finally` inside `runDoAgent`, so its survival proves the runner never unwound: it did not return, throw, or route.
- The job record was never rewritten after `createJob`.

## Root cause: the event loop empties during the post-deadline reap, so Node exits normally (code 0) with the pipeline suspended

At the deadline, `PiHarness.launchAsync` SIGTERMs the agent's process group, and pi exits. Its `exit` handler then does two things whose combination is fatal:

1. it releases every remaining reference the runner holds: `child.stdout/stderr/stdin.destroy()` plus `child.unref()` (`packages/dorfl/src/pi-harness.ts` around the `exit` handler), and the deadline timers are cleared (they were `unref`'d anyway);
2. on the timed-out path it does NOT resolve the launch promise yet: it defers settlement to `reapProcessGroup({pgid})`, whose wait loop sleeps on a timer that is explicitly UNREF'd (`packages/dorfl/src/reap-agent-tree.ts`, `sleep()` does `timer.unref?.()`).

If the first liveness probe finds the group already gone, `reapProcessGroup` returns synchronously, the promise settles in a microtask, and everything proceeds correctly. That is the common case and is why the deadline path has looked healthy.

But if ANY member of the group is still alive at that first probe (a tool subshell, a test runner, an MCP server, or, in run 2, the `sleep 900` the agent was parked in), the reap signals the group and then awaits an unref'd 50 ms timer. At that instant the runner holds zero referenced handles: the child is unref'd, its stdio is destroyed, the deadline timers are gone, and a pending promise is not a handle. Node therefore does what it is supposed to do with an empty loop: it exits cleanly with code 0, abandoning the suspended `await`.

Everything downstream of that await never runs: `routeDeadlineCheckpoint` (so no WIP commit and no branch push), the lock release or the needs-attention surface, the writer-sentinel `finally`, and the job-record update. The exit code is a genuine 0, so the run is indistinguishable from success to any caller that checks status. In this incident the caller additionally piped through `tail`, which masks the exit status anyway.

## Minimal reproduction (against the installed 0.13.0 build)

A fake `pi` that leaves one group member alive across the SIGTERM is enough:

```bash
# fakepi.sh
cat > /dev/null
bash -c 'trap "" TERM; sleep 8' &   # a tool subprocess that outlives the SIGTERM
sleep 300
```

```js
async function runPipeline() {
  console.log(">> CLAIMED ... Resumed ... (no claim).");
  try {
    const res = await new PiHarness({piBin: './fakepi.sh'}).launchAsync({
      dir: '.', slug: 's', command: '', prompt: 'x',
      session: './session.jsonl', deadlineMs: Date.now() + 3000,
    });
    console.log('>> deadline checkpoint would run now', res.reap);
  } finally {
    console.log('>> writer sentinel released (finally)');
  }
}
void runPipeline();
```

Observed: the preamble prints, then the process exits with code 0. Neither the checkpoint line nor the `finally` ever runs, which is exactly the field symptom including the orphaned sentinel. With the grandchild removed (group dies instantly on SIGTERM) the same script completes normally, which is why this reproduces only under the conditions above.

## Two things this is NOT, both of which were believed at the time

- **NOT the `options.harness ?? new NullHarness()` fallback** (`do.ts`, and the same shape in `apply-decide.ts` / `intake.ts`). On every CLI path the harness is built by `createHarness({harness: config.harness, piBin})` and passed in, so the `??` cannot fire there; the pi sessions prove a real `PiHarness` ran. The fallback remains a genuine latent hazard for library/embedding callers (a silent no-agent build), but it is a separate concern, not this defect.
- **NOT evidence from `harness: {adapter: "null"}` in the job record.** `createJob` writes `harness: options.harness ?? DEFAULT_HARNESS` where `DEFAULT_HARNESS = {adapter: 'null'}`, `jobWorktreeStrategy` never passes a harness, and the whole `do` path (in place and `--isolated`/`--remote`) never calls `updateJobRecord`. Only `run.ts` finalises the record with the real launch record. So `adapter: "null"` and `state: "running"` are the initial and only values on EVERY `do` job, healthy or not, and neither field carries diagnostic signal on that path. A field diagnosis at the time read those values as proof that no agent was attached, and recorded that wrong cause in the task's requeue handoff note.

## Why it matters

This is the failure mode the deadline checkpoint exists to prevent, occurring inside the checkpoint itself. The contract is "always save the WIP first, then decide"; what actually happens is that a long task loses 90 minutes of unsaved work, leaves its lock held `active` with no live process behind it, and reports success. Recovery is manual (`requeue`, then `gc --force` to clear the retained worktree), and because the exit code is 0 nothing upstream can notice: a CI leg or a driving loop reads it as a completed build. It is also self-perpetuating, since the item most likely to hit it is the item that hit it last time.

## Fix shape (as originally proposed; see the Update for what landed)

The invariant to restore is that a runner may not exit while a launch promise is unsettled. Candidates, roughly in increasing order of blast radius:

1. Keep a REFERENCED handle for the duration of the reap. `reapProcessGroup` is bounded by construction (`sigtermGrace + sigkillTimeout`, 15 s), so its poll timer does not need to be unref'd; the unref there buys nothing and costs the process. Smallest change, directly on the mechanism.
2. Do not `child.unref()` until after the promise settles, so the child handle keeps the loop alive across the reap.
3. Belt and braces at the process boundary: an explicit keep-alive ref held by the launch for as long as it is in flight, plus a `process.on('exit')` assertion that a launch in flight at exit is a loud failure rather than a silent 0.

Related questions the human should settle at the same time:

- Should the exit CODE ever be 0 when the pipeline did not reach a terminal decision? A guard that turns "exited with a launch in flight" into a non-zero exit would have made both incidents visible immediately, independently of this bug's mechanism.
- Should a run that ends without ever attaching or settling an agent clean up after itself (release the lock, drop the record)? Today it cannot, because it does not know it ended.
- Should the `?? new NullHarness()` sites become a refusal (as `--watch` already refuses before any git transition) rather than a silent default? Note that on the CLI the loud refusal already exists earlier, via `doNeedsAgentCmd`.

## Update 2026-08-23: fixed, with the residue named

Landed as `work/tasks/done/runner-must-not-exit-between-the-agent-and-its-outcome.md`. Candidates 1 and 3 above were taken, deliberately as two independent layers: the reap's poll timer is now REFERENCED (the proximate cause), and `PiHarness.launchAsync` additionally holds a referenced keep-alive while a launch is unsettled plus a process `exit` guard that makes exiting mid-launch loud and non-zero (so a future variant of the same shape cannot masquerade as a clean run). Candidate 2 was not needed once the launch owns a handle of its own.

The regression test runs a BARE runner process, because this defect is invisible from inside vitest: the test runner's own handles keep the loop alive, which is exactly why the existing in-process deadline/reap suite passed throughout. On the pre-fix code it reproduces the field symptom byte for byte (preamble printed, nothing after the `await`, no `finally`, exit 0).

Landed LATER THE SAME DAY as `work/tasks/done/do-job-record-finalises-with-real-harness-and-outcome.md`: the first residue below is now fixed — the `do` path finalises every job record with the REAL harness record at launch-settle and with the real terminal outcome before teardown, mirroring `run`'s discipline. A retained record now carries the pid/session anchor, so `status`/`gc` can answer liveness for a do-path job, and a retained record reads its actual outcome rather than a bare `running`.

The one piece STILL LIVE, and why this note is kept rather than deleted:

- The `?? new NullHarness()` sites (`do.ts`, `apply-decide.ts`, `intake.ts` x2) remain a silent default for library/embedding callers. Not reachable from the CLI (`doNeedsAgentCmd` refuses earlier), so it was not this defect, but a build path that silently attaches no agent is still the wrong default for a seam.
