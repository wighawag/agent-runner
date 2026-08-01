---
'dorfl': patch
---

Fix the post-write state check reporting dorfl's own successful write as absent.

Two call sites in the checkpoint / surface path answered a state question by reading a remote-tracking ref (`refs/remotes/<arbiter>/…`) after a plain `git fetch <arbiter>`. That is unsound in the configuration `--isolated` itself creates: a job worktree is cut from the bare hub mirror, whose `origin` carries the mirror refspec `+refs/heads/*:refs/heads/*`, so a plain fetch never populates that namespace — and, when a `work/<slug>` branch is checked out, it fails outright (`refusing to fetch into branch …`) and refreshes nothing.

Two consequences in the field. A surface commit that LANDED was reported `push reported up-to-date / no change of our making — treating as rejected`, retried to the retry cap (landing one identical commit per attempt), then declared `did not land on origin/main` with a recommendation to run an unnecessary recovery command. And a requeue announced `'<slug>' has no work branch on origin — nothing to continue from` over a branch holding an hour of agent work, one line before correctly announcing that the next tick would continue from that same branch; acting on the first message re-drives the task from scratch and discards the work.

Post-write verification is now arbiter-authoritative through one shared seam: prune-fetch with an explicit per-branch refspec into the namespace readers actually read, then ask the arbiter itself via `git ls-remote`. A push that succeeded can never be reported as not landed, and an unreachable arbiter after a green push reports published rather than inventing a rejection. Tree-less transitions are idempotent at the commit level — an empty diff lands nothing, and re-surfacing a bounce whose questions are already present and unanswered is a no-op — so the commit count no longer scales with the retry budget. The requeue resolves the continue-branch exactly once and publishes that single resolved state, which callers derive their messages from, so mutually contradictory lines are structurally impossible; an unreadable arbiter now says so instead of asserting there is nothing to continue from.

This also fixes a third consequence that had gone unnoticed: because the surface is surface-first / release-second, a surface mis-reported as failed meant the lock release never ran, leaving a bounced item both surfaced for a human and still holding a live `active` claim lock, which blocks re-claiming.
