<!-- dorfl-sidecar: item=observation:do-remote-untouched-dirs-test-walks-the-real-dorfl-home type=observation slug=do-remote-untouched-dirs-test-walks-the-real-dorfl-home allAnswered=false -->

Item: [`observation:do-remote-untouched-dirs-test-walks-the-real-dorfl-home`](../notes/observations/do-remote-untouched-dirs-test-walks-the-real-dorfl-home.md)

## Q1

**Which invariant is this test actually meant to pin: (a) nothing dorfl-do writes leaks into the developer's REAL ~/.dorfl and ~/.pi/agent/sessions on this machine, or (b) dorfl-do never targets the human/state roots at all (a property provable against a controlled HOME with no dependence on the developer's actual files)?**

> The test today conflates both: it runs against the real homedir (proving (a) on this machine) but its cost scales with that homedir, so on any machine that has actually used dorfl (retained worktrees with node_modules from prepare: pnpm install — 136k files / 3.3GB observed) two JS recursive walks blow the 5s vitest budget and the gate reds. The three candidate fixes in the note map to different answers: cheap-identity check keeps (a) but weakens it to a shallow signal; hermetic HOME converts it to (b); bumping the timeout keeps (a) verbatim and accepts unbounded gate cost. Picking one requires knowing which property the suite is buying.

_Suggested default: Interpret it as (b) — the honest property is 'dorfl-do targets scratch, never the human/state roots', which is a code-path invariant and does not need to walk the developer's real home; keep an additional cheap (a)-style check (mtime / direct entry list, no recursion) as a belt-and-braces smoke on the real roots so a regression that DID target real HOME still trips the gate without making cost a function of the developer's history._

<!-- q1 fields: id=q1 -->

**Your answer** (write below this line):
