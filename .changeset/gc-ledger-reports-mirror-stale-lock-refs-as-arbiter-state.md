---
'dorfl': patch
---

Fix `dorfl gc --ledger` reporting locks that do not exist on the arbiter.

`gc --ledger` reported "STALE / crash-window orphan" locks and printed a `dorfl release-lock <item>` for each, which then failed with "(stale info)" / "already absent on origin" — naming locks a human should delete that did not actually exist. Verified: `git ls-remote origin 'refs/dorfl/lock/*'` returned nothing while the hub mirror held 8 `refs/dorfl/lock/*` refs, three of them for locks released on origin earlier in the same session.

The root cause was structural. The lock readers (`listItemLocks`, `listItemLockEntries`, `readItemLock`, `fetchHeldEntry`, the acquire/release/reconcile paths) did `git fetch <arbiter> +refs/dorfl/lock/*:refs/dorfl/lock/*` — force-update with NO `--prune` — then read the LOCAL `refs/dorfl/lock/*` via `for-each-ref` / `git show <ref>`. A lock released on the arbiter (its ref deleted there) survived locally indefinitely, so the readers reported locks the arbiter no longer held. The same accumulation also affected the SELECTION path (`heldTaskSlugsStrict`/`heldSpecSlugsStrict` via `listItemLocks`): a released task's stale local ref kept it subtracted from the eligible pool, so a released task could not be re-tasked. Separately, `ensureMirror` synced only `refs/heads/*` (and `main`), never `refs/dorfl/lock/*`, so the mirror's lock namespace was never pruned and released locks accumulated there too.

Two fixes:

1. Prune `refs/dorfl/lock/*` when syncing the mirror. `ensureMirror` now best-effort `--prune` fetches the per-item lock namespace from the arbiter, so released locks cannot accumulate on the mirror.

2. The ledger reads the arbiter directly. `listItemLockEntries` (the `gc --ledger` report reader) now takes the authoritative lock list from `git ls-remote <arbiter> refs/dorfl/lock/*` — ONLY the refs that actually exist on the arbiter right now — so the report can never name a lock that does not exist. The content is materialized by a `--prune` fetch (which also keeps the local namespace clean). `listItemLocks`, `readItemLock`, `fetchHeldEntry`, and the acquire/release/reconcile fetches all add `--prune`, so a released lock's stale local ref is pruned and `for-each-ref`/`git show` read the arbiter's actual state. `listItemLocks` keeps materializing the refs locally (not `ls-remote`-only) because `migrateStuckLocks` reads a lock's body via `git show <ref>:lock.md` after it.

A report whose entire purpose is to name locks a human should delete can no longer name locks that do not exist. Adds regression tests: a mirror holding a lock ref the arbiter does not is pruned on the next `ensureMirror` sync; and `listItemLocks`/`listItemLockEntries`/`reportItemLocks`/`readItemLock` do not report a stale local lock ref the arbiter no longer holds (while a genuinely held lock is still reported).