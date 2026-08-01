---
needsAnswers: true
---

# After a deadline checkpoint, TWO agents were alive in the same worktree at once

Date: 2026-08-01
Observer: field run of dorfl 0.11.1 driving a real repo, harness `pi`, `--isolated --merge --review --arbiter origin`, `agentDeadlineMinutes: 60`, `maxAutoCheckpoints: 5`.

FIXED by this change. Same underlying gap as `checkpoint-path-reports-its-own-write-as-absent`: the checkpoint path acted without confirming its own side effect — there, the git write it reported; here, the agent process it claimed to have stopped.

## What was seen

The checkpoint saved WIP at 02:13 and the runner dispatched a CONTINUATION agent at ~02:15 into the same worktree (`~/.dorfl/work/<repo>__<slug>`). The previous agent was still running: its session log kept being written until 02:19:29 — roughly four minutes into the continuation run — and its final act was to append to a file the continuation agent had already read as clean in its opening `git status`.

Nothing was lost this time: the two happened not to touch the same file, and the late write was itself legitimate content. The SHAPE is the defect: one lock, one working tree, two live writers.

- A write landing after the successor's `git status` is invisible to it.
- A write landing during its edits can be clobbered in either direction.
- The successor can commit the predecessor's half-finished edits as though they were its own, inside a commit whose message describes something else.

## Root cause

`PiHarness.launchAsync`'s deadline handler called `child.kill('SIGTERM')`, which signals exactly ONE pid, and then resolved the launch promise on pi's own `exit`. The runner treats that resolution as "the agent is done", so it saved WIP, released the item lock, and let the next tick onboard a successor.

But a modern agent is a TREE: subagent processes, MCP servers, model proxies, tool subshells. Those descendants do not receive the parent's SIGTERM, and once pi exits they are re-parented to init — so they can no longer even be FOUND by walking `ppid`, while they keep writing into the worktree. The signal was treated as the outcome.

dorfl's own docs already warn a human that aborting `do` does not kill the spawned agent tree. The checkpoint path had the same gap internally.

## The fix

- **Process GROUP as the handle.** A pid-tree walk cannot work here, because the processes to reap are precisely the ones that outlive the parent. A pgid is inherited by every descendant and is unaffected by re-parenting, so `launchAsync` now spawns pi `detached: true` (making it a group leader) and signals `kill(-pgid, …)`.
- **Signal, then VERIFY.** `reap-agent-tree.ts` SIGTERMs the group, POLLS until it is observably gone, escalates to SIGKILL after a grace, keeps polling, and on failure returns `reaped: false` with a loud message naming what the caller must not do. Bounded by construction, so it cannot reintroduce the runner-hang that the resolve-on-`exit` discipline exists to avoid.
- **The launch does not resolve until the tree is gone** on the deadline path, so the runner is never told the agent is done while it is still writing. A normal (non-deadline) exit is untouched: nothing was signalled, so nothing is killed — in particular a process the agent deliberately left running behind a SUCCESSFUL run is not reaped.
- **The lock does not move without proof.** `routeDeadlineCheckpoint` still SAVES and pushes the WIP (never lose work) but refuses the auto-continue when the reap is unproven, surfacing a `deadline checkpoint (agent NOT verifiably stopped)` question instead. Only the hand-off is withheld.
- **A per-worktree writer sentinel** (`worktree-writer-lock.ts`) as an INDEPENDENT backstop, because the item lock guards the ITEM and nothing guarded the TREE. It refuses to onboard a second agent into a tree with a LIVE holder, keyed on the tree rather than the item (two different items sharing one worktree is just as unsafe). It lives in the worktree's private git dir, so it can never appear in `git status`, needs no new exclusion in the empty-diff backstop or `gc`'s cleanliness predicate, and dies with the worktree. A dead holder's sentinel is stale and taken over, so a `kill -9`ed runner cannot poison a worktree.

## Deliberate trade-off worth knowing

`detached: true` takes pi out of the runner's foreground process group, so a Ctrl-C aimed at the runner would no longer reach it — which would WIDEN the documented "aborting `do` does not kill the agent tree" gap. The launch therefore forwards the parent's own SIGINT/SIGTERM to the child's group while the child is live, so detaching strictly improves reachability instead of trading one orphan class for another.

## Residue

The reap is scoped to the DEADLINE path, where dorfl did the signalling and therefore owes proof. A normal-exit run that leaves MCP servers or other descendants alive is still a possible two-writer hazard for a later run in the same worktree; the writer sentinel is what covers that case, and it refuses rather than reaping. Whether a normal exit should also reap (and how to distinguish a leaked helper from a background process the task deliberately started) is not settled here.
