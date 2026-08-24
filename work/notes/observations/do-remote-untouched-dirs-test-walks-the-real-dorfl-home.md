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
