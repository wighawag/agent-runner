---
needsAnswers: true
---

# The `do --remote` "real dirs are UNTOUCHED" test walks the developer's REAL `~/.dorfl`, so it times out on a machine that has used dorfl

Date: 2026-08-23
Observer: running the acceptance gate (`pnpm -r test`) on a dev machine while landing `runner-must-not-exit-between-the-agent-and-its-outcome`.

## What was seen

`test/do-remote.test.ts > do --remote — NEVER touches the human area or the real state dirs > the real ~/.dorfl/ and ~/.pi/agent/sessions/ are UNTOUCHED` failed with `Test timed out in 5000ms`. It fails identically on a pristine tree (verified by stashing the change under test), so it is not caused by the change that surfaced it, and it passes unchanged with `--testTimeout=180000`.

The cause is that the test snapshots the REAL state dirs by fully recursing them: `listAllFiles(join(homedir(), '.dorfl'))` and the same for `~/.pi/agent/sessions`, once before the run and once after. On this machine `~/.dorfl` currently holds 136,448 files / 3.3 GB, because retained job worktrees keep a full checkout each (`prepare: pnpm install`, so `node_modules` too). Two JS-level recursive walks of that do not fit in the default 5 s vitest budget. On a fresh machine `~/.dorfl` is nearly empty and the test is instant, which is why this has not bitten before.

## Why it matters

The assertion itself is valuable (it pins the "agents never write the human area / the real state dirs" invariant), but its cost is a function of the DEVELOPER'S OWN home directory, so the gate gets slower for exactly the people who use the tool most, and fails outright for anyone carrying a retained worktree. A retained worktree is the normal, documented outcome of a failed run (never lose work), so the failing state is one the tool deliberately produces.

It is also a false signal at the worst moment: the gate reds while investigating an unrelated incident, and the red points at a test whose name suggests a leak into the user's home.

## Candidate directions (not decided)

- Assert on a cheap identity instead of a full walk: mtime + direct-entry list of the two roots, or a bounded-depth listing. Keeps the invariant, drops the recursion.
- Or make it hermetic: point `HOME` at scratch for this test, so "the real dirs" are a controlled empty pair and the walk is trivially cheap. This changes what the test proves (it would no longer prove anything about the actual machine), so it needs a deliberate answer.
- Or keep the walk but give the test a timeout proportional to what it is asked to do, and accept that the gate's cost varies with the developer's home.

The open question is which of those the invariant actually wants, since the current test is quietly asserting two different things (nothing leaked, and the leak check is cheap).

## Later datum (2026-09-03): the suite is FEEDING the directory it then walks

Hit again while fixing an unrelated tasking-lock defect, and the re-measurement changes the shape of the problem. The walk cost is not merely a function of the developer's *usage* history; **the test suite grows the walked directory on every run**, so the gate degrades by running it.

Measured on this machine: `~/.dorfl` = 2.5 GB / 110,346 files, of which `~/.dorfl/repos/tmp` holds **600 leftover `pre-backlog-step-a-*` scratch dirs** (83 MB). Those are left by a DIFFERENT test writing its scratch into the real state root instead of a `makeScratch` temp dir. So a sibling test is committing the very shared-write violation this test exists to catch, and it is invisible to the assertion because the leak happens outside the before/after window. `~/.dorfl/webkit-spike-build` (1.6 GB) is another unrelated non-test resident inflating the same walk.

Two consequences the candidate directions above do not cover:

- The failure is **load- and history-dependent, not deterministic**: this test passed in the full suite earlier the same day and failed after four more full-suite runs had added scratch, then passed again in isolation with the identical tree. Anyone bisecting a red gate will mis-attribute it to whatever change is in the tree, exactly as happened here (it cost a stash-and-rerun on a pristine tree to clear the fix under review).
- Whichever direction is chosen for THIS test, `pre-backlog-step-a-*` should be routed to scratch regardless. That is an independent leak, and it is the one actually accumulating.

Suggested cheap first move, independent of the open question: fix the leaking test to use `makeScratch`, and have the suite fail loudly if any test writes under `~/.dorfl` (a guard is more honest than a snapshot diff, and is O(1) rather than O(home)).

Housekeeping note for whoever picks this up: the 600 leftover dirs are still on this machine and were deliberately NOT deleted (they are in the developer's real state root, not the agent's to remove unasked).
