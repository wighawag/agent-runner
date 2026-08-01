---
'dorfl': patch
---

Fix the deadline checkpoint leaving two agents alive in the same worktree.

The harness sent `SIGTERM` to a single pid and resolved the launch on that process's own exit, which the runner treats as "the agent is done" — so it saved the WIP, released the item lock, and let the next tick dispatch a continuation agent into the same worktree. But an agent is a process TREE (subagents, MCP servers, model proxies, tool subshells) whose members never receive the parent's signal and, once the parent exits, are re-parented to init and can no longer even be found by walking `ppid`. In the field a predecessor kept writing for roughly four minutes into its successor's run, and its final write landed on a file the successor had already read as clean in its opening `git status`. Nothing was lost only because the two happened not to touch the same file.

A deadline stop now spawns the agent as a process-group leader, signals the whole group, and polls until the group is verifiably gone (escalating to `SIGKILL` after a grace, bounded by construction, with a loud failure naming what must not happen next if it will not die). The launch does not resolve until then, so the runner is never told the agent is done while it is still writing. The checkpoint refuses to release the item lock or dispatch a successor without that proof: it still saves and pushes the WIP, and surfaces a `deadline checkpoint (agent NOT verifiably stopped)` question instead, so only the hand-off is withheld.

A normal (non-deadline) exit is unchanged: nothing was signalled, so nothing is reaped — in particular a process an agent deliberately left running behind a successful run is not killed. Because spawning detached would otherwise take the agent out of the runner's foreground process group and widen the documented "aborting `do` does not kill the spawned agent tree" gap, the launch forwards the parent's own `SIGINT`/`SIGTERM` to the group while the child is live.

Adds a per-worktree writer sentinel as an independent backstop, since the item lock guards the ITEM and nothing guarded the WORKING TREE. It refuses to onboard a second agent into a tree that already has a live holder, keyed on the tree rather than the item. It lives in the worktree's private git directory, so it can never appear in `git status` and needs no new exclusion in the empty-diff backstop or `gc`'s cleanliness predicate, and a dead holder's sentinel is treated as stale so a killed runner cannot poison a worktree.
