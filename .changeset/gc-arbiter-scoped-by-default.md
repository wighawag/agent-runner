---
'dorfl': minor
---

Scope `gc` to a single arbiter by default instead of reaping worktrees across every arbiter globally.

`gc` used to default to a GLOBAL sweep of every job worktree under the work dir, across every repo/arbiter. But it is almost always run from inside one project, where the operator's intent is "clean up THIS repo", so a routine `gc --force --yes` run from repo A could silently and irreversibly discard un-pushed work belonging to an unrelated repo B (this actually happened).

`gc` is now **arbiter-scoped by default**: it acts only on the worktrees of the arbiter resolved from the cwd (the same arbiter-resolution `do --isolated`/the mirror uses), so a `gc` in repo A can never reap repo B's worktrees. New `--all-arbiters` flag restores the old global cross-arbiter sweep behind a LOUD banner that names every arbiter it will touch before doing anything (and combining it with `--force` still requires `--yes`, so the destructive cross-repo path must be opted into explicitly). `--arbiter <remote-or-url>` targets a specific arbiter that is not the cwd's. If no cwd arbiter is resolvable and neither flag is given, `gc` now REFUSES with an actionable error rather than silently falling back to global.

**Behavior change:** a bare `gc` (including in existing scripts) now scopes to the cwd's arbiter. Because this only ever makes `gc` LESS destructive (it can no longer reach another repo's worktrees by default), it is safe, but scripts that relied on a bare `gc` sweeping every arbiter must now pass `--all-arbiters`.
