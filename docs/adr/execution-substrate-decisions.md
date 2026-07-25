---
title: 'Execution substrate decisions — jobs, isolation, deletion safety, seams, arbiters'
slug: execution-substrate-decisions
type: finding
created: 2026-06-03
---

# Execution substrate decisions (ADR)

> **Note:** `claim.sh` was RETIRED on 2026-06-20 — see §9; the per-item lock ref superseded its direct-`main` claim mechanism.

Captures the load-bearing decisions for how dorfl runs work concurrently and safely, agreed during design before any of the B/C-tier tasks were built. The tasks `agent-workspaces`, `claim-command`, `arbiter-management`, `harness-pi`, `integration-github`, and `watch` all depend on these.

## 1. Jobs, not agents

There is **no long-lived "agent" identity**. The unit is a **job** = one claimed work item being processed. We do not name agents, pool agents, or track per-agent clones. We track _active jobs_ (and their liveness via the harness seam, §5). This collapses earlier ideas about agent-name generators and per-agent clone trees — they solved a problem we don't have.

## 2. Isolation: hub mirror + external worktrees (not N full clones)

Full `git clone` per job gives the best isolation but costs disk + transfer. Instead:

- **One bare hub mirror per repo** under `~/.dorfl/repos/<host>/<org>/<name>.git` (shared object store, cheap; re-fetched from the arbiter).
- **One git worktree per job**, checked out **outside** the hub at `~/.dorfl/work/<work-id>/`, on branch `work/<slug>`.

Worktrees share the hub's objects (cheap) yet have independent working trees (isolated). Git forbids the _same branch_ in two worktrees — but each job is a distinct slug ⇒ distinct work branch, so the constraint is **naturally avoided** by keying on the work item. (Claims serialize per slug via the arbiter CAS, so the same slug never runs twice concurrently.)

> The work-branch ref is `work/<slug>` **above**, but a bare slug is NOT a unique key — a spec and a task (and an intake run) can share a slug. The branch ref is therefore **namespaced by item type + producer** (`work/<type>-<slug>`, e.g. `work/task-<slug>` / `work/spec-<slug>`, with an optional `intake-` producer prefix): see **§15**. Read every `work/<slug>` in this ADR as shorthand for that namespaced ref.

### Encoding (repo → folder key)

From the arbiter remote URL, drop scheme/user/`.git`, and replace `.` → `-` per segment (lossless, reversible; avoids the dotted-segment hazard that trips some editors/tools and our own dotdir-pruning):

- `git@github.com:wighawag/dorfl.git`
- hub (hierarchical): `repos/github-com/wighawag/dorfl.git`
- work-id (flat, deterministic, unique per claim): `github-com__wighawag__dorfl__<slug>`

Hierarchical for hubs (groups by host/org); **flat** for work-ids (so listing / counting / GC of jobs is a flat `ls`).

## 3. `~/.dorfl/` is STATE, not cache

The working area (hub mirrors + job worktrees) lives under a single visible `~/.dorfl/` (config-overridable). It is treated as **state**, NOT cache.

Why not `~/.cache`: a hub mirror _is_ regenerable (true cache), but a job worktree is **only conditionally** regenerable — before its branch is pushed to the arbiter it holds the ONLY copy of the agent's commits (and any uncommitted changes). Housing it under a cache dir invites the wrong reflex (OS cleaners, "clear caches" scripts, a human `rm -rf ~/.cache/*`) and risks destroying un-pushed work. So we classify the whole working area at the level of its most-precious member: **state**. The "safe to delete" property is enforced _behaviourally_ (§4), never _spatially_ by living in a cache dir.

## 4. Deletion safety = a provable arbiter-reachability predicate

A job's worktree is removed (auto, at end-of-job; or by `gc`) **iff**:

1. the working tree is **clean** (no uncommitted changes), AND
2. the job branch's tip is **reachable on the arbiter** — either merged into `<arbiter>/main` (`git merge-base --is-ancestor <tip> <arbiter>/main`), or pushed as an up-to-date branch (`<arbiter>/<branch>` tip == local tip).

Both hold ⇒ the worktree is genuinely redundant (reconstructible from the arbiter) ⇒ delete. Otherwise ⇒ **retain for the human**.

Consequences:

- The trigger is **provable safety, not "success."** A successful-but-unpushed job is retained; a job whose commits are on the arbiter is reaped. One rule, no done-vs-failed special-casing.
- `propose` mode (§6) is delete-eligible because opening a review request implies the branch was **pushed** — but we verify _remote tip == local tip_, not merely "a review request exists" (guards a later un-pushed amend).
- The only worktrees that linger are **genuinely un-saved work** (failures, crashes, dirty trees) — a reliable "needs attention" signal that dovetails with `watch`'s surface-failures rail.
- **`gc`** re-applies the same predicate as a safety net (for when auto-delete didn't run — runner crash/kill). It is **arbiter-scoped by default**: a bare `gc` acts ONLY on the worktrees of the arbiter resolved from the cwd (the same arbiter-resolution `do --isolated`/the mirror uses), so a `gc` in repo A can never reap repo B's worktrees. `--all-arbiters` restores the global cross-arbiter sweep behind a loud banner (naming every arbiter it will touch); `--arbiter <remote-or-url>` targets a specific one; with no resolvable cwd arbiter and neither flag, `gc` REFUSES rather than silently going global. `gc --force` overrides the deletion predicate (requires `--yes`; loud, never default) — and even then the destructive cross-arbiter combination (`--all-arbiters --force --yes`) must be opted into explicitly.
- Removal is `git worktree remove` (+ prune), never a bare `rm -rf` (which would leave a dangling worktree registration on the hub).

## 5. Harness seam (liveness + invocation)

How a job is launched and how its liveness is observed is **pluggable** behind a harness adapter; the core never hard-codes a specific tool.

- **null adapter** (this substrate's default, testable standalone): records PID, runs a configured command.
- **pi adapter** (first real target, own task): liveness via PID + a pointer to the pi session dir/log; invocation via the pi CLI.

Liveness is reported by the harness, NOT inferred from filesystem mtime (a live agent can think for minutes without writing files). mtime is not used.

## 6. Integration seam: mode × provider; push is the guarantee

Integration after green tests has two orthogonal axes:

- **Mode** (`integration` config): `merge` (ff/rebase onto `<arbiter>/main`, push to main — provider-agnostic git) or **`propose`** (push a branch + request review). _(Renamed from `pr`: "propose" is provider-neutral; "PR" is GitHub jargon that misleads for GitLab MRs / bare arbiters.)_
- **Provider** (the review-request tool, a seam): `github` (`gh pr create`), future `glab`/Gitea, or **`none`** (push the branch + tell the human to open a request manually — the graceful-degradation path, and the only option for a local `--bare` arbiter, which has no review concept). The provider is **purely ARBITER-DERIVED** — a `github.com` arbiter URL ⇒ the GitHub provider, else `none`. There is **NO `provider` config OVERRIDE / `--provider` flag**: with IDENTITY + ARBITER first-class, a separate provider choice could only CONTRADICT the arbiter (the arbiter says WHICH provider; the identity's `providers.github` — or ambient `gh` auth — says whether `gh` is AUTHED to open the PR). _(A stale `provider` key in an old config/env is IGNORED with a deprecation warning, never an error.)_
- **PR-INTENT** (`noPR` config + `--no-pr` flag): whether to open a PR at all, an intent LAYERED on top of the arbiter-derived provider (it does NOT pick a provider). `noPR: true` ⇒ push the branch but deliberately SKIP the review request (the explicit "suppress the PR" intent that RE-HOMES the old `provider: none` use — no warning, the no-PR outcome is intended); unset/`false` (default) ⇒ "I want a PR". Resolved per-repo like `review`: `--no-pr` > env > per-repo > global > default `false`.

The **universal, safety-bearing action is `git push`** to the arbiter; the review request is layered on top and provider-specific. Deletion safety (§4) rides on the push, never on the provider step — so a provider failure leaves a safe, pushed branch, not lost work. The core calls `Integrator.integrate(job)`; adapters own the tooling.

**Honest up-front failure (the value `noPR` buys).** A `propose` run on a GitHub arbiter that INTENDS a PR (`noPR` unset) but where `gh` genuinely cannot open one must FAIL FAST — at the pre-flight-guard stage, BEFORE claim/onboard/build (alongside the dirty-tree / diverged-main guards) — rather than silently degrading to manual-PR instructions, so "I deliberately want no PR" is never confused with "I wanted a PR and silently didn't get one." The "can't open a PR" signal is a `gh` AUTH/AVAILABILITY **PROBE** (`GitHubProvider.available`, a `gh auth status`-style check), **NOT** "is a `providers.github` identity present": an absent identity falls back to AMBIENT `gh` auth (a developer's `gh auth login`, a CI `GITHUB_TOKEN`), the common local-dev case that WORKS — so the guard must NOT fire on absent-identity alone. The runtime manual-PR degrade is correspondingly NARROWED to the legitimate cases: `noPR: true` (intended) and a TRANSIENT mid-run `gh` outage (the probe passed up front but the API failed later) — the start-of-run unauthed case is now caught up front.

## 7. Arbiters are precious DATA → `~/git/`, dorfl-managed

A local `--bare` arbiter (offline mode) is the **source of truth**, not cache or state — the thing §4's predicate proves everything else safe _against_. It must NOT live under `~/.dorfl/` (a `gc`/cleanup mishap could nuke the only copy). Default location: **`~/git/<host>/<org>/<name>.git`** (hierarchical; visible, memorable, easy to back up / put on a synced/archived folder), overridable via `arbitersDir`. dorfl _provisions/locates_ it (`arbiter init` from an existing repo, `arbiter status`) but treats its bytes as precious.

Three ownership tiers (do not conflate):

| Tier | Role | Disposable | Location |
| --- | --- | --- | --- |
| your working repos | where you edit | no | `~/dev/...` |
| hub mirrors + job worktrees | execution **state** | conditionally (§4) | `~/.dorfl/` |
| arbiters (offline) | **source of truth** | no | `~/git/...` |

## 8. The acceptance gate is a per-repo `verify` seam; authority differs by caller

The gate that decides whether work is acceptable is a **per-repo declared command** (`verify` config, e.g. `pnpm -r build && test && format:check`), exposed as `dorfl verify`. NOT per-task: a per-task gate would force a model to interpret prose to decide what "passing" means — putting an LLM inside the trust boundary, which is exactly where we want determinism. Per-repo config keeps the gate a dumb, auditable shell command (and means there is nothing to "cache" — the gate is known by reading config, no model call).

One mechanism, two callers, different **authority**:

- **Autonomous runner** (`run-once`/`watch`): the gate is the **non-negotiable trust boundary** (spec story 12 — bad work never reaches `done/`). The agent's own "I'm done / tests pass" is a hint, NEVER a substitute; the runner runs `verify` itself and that is the verdict. No skip.
- **Human `complete`**: the human is the trusted operator, so `verify` runs as a **default-on safety-net** with `--skip-verify` to opt out ("I already ran it").

A possible later optimization is caching _test results_ (skip re-running when the git tree is unchanged) — but it must be off-by-default for the authoritative autonomous gate (a safety boundary must not trust a cache). Out of scope for now.

> **Note (there is NO default gate — an unset `verify` FAILS LOUD, 2026-07-14):** the gate has no built-in fallback command. Earlier, an unset (or all-blank) `verify` silently resolved to `pnpm -r build && pnpm -r test && pnpm -r format:check`. That was unsafe two ways: (1) in a repo whose real gate is something else (a Zig `zig build test`, a Make target, …) it ran the WRONG check; (2) in a repo pnpm knows nothing about, `pnpm -r …` prints "No projects found" and exits 0 — a VACUOUS GREEN that let unverified work pass the trust boundary. So `resolveVerifyCommands` now THROWS `VerifyNotConfiguredError` on unset/all-blank; `runVerify` turns that into a failing `notConfigured` result (never an uncaught crash) so the shared `performIntegration` band routes it to needs-attention with a precise reason; and the pre-claim `checkGatePreconditions` guard fails fast (MODE-INDEPENDENT — a missing gate can't pass in ANY mode) BEFORE a wasted claim + build. A repo MUST declare its own `verify` in `dorfl.json`. Separately, the standalone `dorfl verify` command was fixed to resolve the gate through the per-repo chain (flag > env > per-repo `dorfl.json` > global) instead of only the GLOBAL config — previously it ignored a repo's committed `verify` entirely and ran the old default, which is how the vacuous-green surfaced in practice.

> **Note (gate unification — run now honours `verify`, 2026-06-07):** the autonomous `run` path previously had its OWN gate (`defaultTestGate`, hardcoded `pnpm -r test` — test-only, Node-only, ignoring `config.verify`) — a PROTOCOL VIOLATION of this section's per-repo, language-agnostic gate. The run/do integrate-path convergence (`work/specs/tasked/run-do-integrate-convergence.md`) routed `runOneItem` through the shared `performIntegration` core, which gates on `runVerify(config.verify)` exactly like `do`/`complete`. `defaultTestGate` and the `TestGate` type are DELETED. This is a deliberate, intended BEHAVIOUR CHANGE: the fleet now enforces the SAME full configured floor (build + test + format, or the repo's command) in ANY language — closing drift instance #3 in `work/findings/run-and-do-have-separate-integrate-paths.md`. The same convergence also gave `run` the review gate (Gate 2) and the synthesised PR title/body it previously lacked.

> **Note (the gate tests the tree that MERGES — `freshWorktreeGate`, 2026-06-14):** the acceptance gate (`verify`) runs, ON BY DEFAULT, in a CLEAN throwaway worktree cut from the work branch REBASED onto the latest `<arbiter>/main` (the would-be-integrated tip), NOT the agent's pre-rebase checkout — so a green gate provably describes the MERGED artifact (gitignored/uncommitted state in the agent's checkout cannot leak into a falsely-green gate, and a change the integration rebase introduces IS gated). It is a POSITIVE boolean `freshWorktreeGate` (default `true`, `--fresh-worktree-gate`/`--no-fresh-worktree-gate`, resolved like `taskerLoop`); `--no-fresh-worktree-gate` runs `verify` in the agent's build worktree (the pre-rebase tree, today's behaviour byte-for-byte) for when per-gate install cost is too high. The mechanism lives in the SHARED `performIntegration` band (caller-agnostic — it honours the boolean it is handed); the ONE fleet-aware decision (the `run` fleet falls back to today's in-build-worktree gate at `config.perRepoMax > 1`, where two pre-existing run-fleet races would otherwise fire — task `run-fleet-claim-integrate-and-sibling-rebase-concurrency-safe`) lives in the `run` caller. Single-job paths (in-place `do`, `--isolated`, `--remote`, `complete`) and `run` at `perRepoMax === 1` always use the resolved flag. This subsumes the `drive-tasks` skill's dropped per-task "Gate-3 re-verify" (it makes Gate-1 itself test the merged tree).
>
> **Verify-THEN-review on the SAME merged tree (MAINTAINER DECISION 2):** with the fresh gate ON, the Gate-2 REVIEW is RELOCATED to run AFTER the rebased-tip `verify`, inside the fresh gate worktree (on the rebased tip), so the "verify is the deterministic floor, runs FIRST; the Gate-2 review only on its green" invariant of this section holds on the tree that actually LANDS — verify-then-review, BOTH on the merged tree, never split across two trees. The ON-path band order is therefore `done-move → commit → rebase → verify (rebased tip) → review (rebased tip) → integrate`. When the fresh gate is OFF the review stays at the front on the pre-rebase checkout, right after the front `verify`, exactly as before (`verify (cwd) → review (cwd) → done-move → … → integrate`).

## 9. dorfl is the primary implementation; contract + `claim.sh` are the portable substrate

dorfl and the `to-task` skill (the `work/` contract, `CLAIM-PROTOCOL.md`, `claim.sh`) are **one project / one vision**. dorfl grows a first-class **`claim` command** (TS) that implements the same claim CAS as `claim.sh`, with identical exit-code semantics.

> **Note (ledger-transition seam):** the claim CAS's direct write to `main` described throughout this ADR is the **current (only) strategy** behind the ledger-transition seam (`docs/adr/claim-ledger-vs-protected-main.md`, accepted). The three `work/` transitions now route through that read+write seam; behaviour is byte-identical (one strategy, `main`-writing), but the `main`-write is no longer hard-wired — a future strategy could differ. This ADR's `main`-write descriptions remain accurate for today's single strategy.

- The **contract docs stay tool-agnostic and primary** (the stable interface).
- **`claim.sh` was RETIRED (2026-06-20).** It was originally retained as a zero-dependency, portable bootstrap / reference implementation of the claim CAS. That rationale lapsed: the claim mechanism moved to the per-item lock ref (`refs/dorfl/lock/<entry>`, ADR `ledger-status-on-per-item-lock-refs`) and the body no longer moves to `in-progress/` on claim, so the script's `git mv work/backlog → work/in-progress` direct-`main` CAS implemented the SUPERSEDED mechanism against retired folder names. A zero-dep bootstrap that performs the OLD claim is worse than none (it would mis-claim against the current ledger), and the first-task bootstrap need is now served by `dorfl claim` itself. The portable CLAIM PROTOCOL lives in `CLAIM-PROTOCOL.md` (tool-agnostic); only the drifted shell reference implementation is gone.
- The other behaviours designed here (isolation §2, deletion §4, integration §6) are likewise **protocols**, not just features. Follow-up (own task, not these tasks): author companion contract docs in the skill repo (e.g. `EXECUTION-PROTOCOL.md`, `INTEGRATION-PROTOCOL.md`) once the implementation proves them out, so other tools can implement the same protocols.

## 10. Merge conflicts: rebase-or-abort, never auto-resolve

`blocked_by` encodes LOGICAL ordering, not FILE ordering: two independent tasks can touch the same files and conflict when the second integrates after the first. Conflicts between parallel branches are therefore **inherent**, not a bug. We do NOT try to prevent them with file reservations / locks (that reintroduces the shared-state coordination the `work/` contract bans, and agents can't reliably predeclare touched files). Instead:

- **Rarer, by design (tasking guidance):** prefer thin, file-orthogonal tasks; when two tasks are known to touch the same module, add a `blocked_by` to serialize them. This is the tasker's judgement (documented in the `to-task` skill), not enforced by tooling.
- **Cheaper + safe, by tooling:** at integration time the runner / `complete` does a **deterministic rebase** of `work/<slug>` onto the latest `<arbiter>/main`. A **clean** rebase proceeds. A **conflicting** rebase is `git rebase --abort`ed, the job is marked **needs-attention**, and it is surfaced (the retained worktree is the signal; dovetails with `watch`'s surface-failures rail).
- **Never auto-resolve.** dorfl deterministically _attempts_ the rebase and _detects_ conflict; it does NOT pick `--ours`/`--theirs` or any heuristic, because a conflict resolution requires SEMANTIC judgement and a wrong-but- compiling merge is the worst outcome (it passes the gate, the code is broken). Resolution is a human task (or a future, explicitly conflict-prompted `resolve`-agent — distinct from the build agent, which still does no git).
- The build agent is unaffected: it does no git writes (read-only `git log`/`diff` for context is fine). Rebase/integration/conflict-surfacing are the runner's.

## 11. Integration mode is resolved at integrate-time, per-repo, never at start-time

Whether work lands via `merge` (direct to main) or `propose` (push a branch + request review) is decided **where it applies — at `complete`/integrate time**, NOT at `start` time. Stamping a mode at start would force it into task frontmatter (rejected: that puts non-source-of-truth runtime policy into declarative task content, the same anti-pattern as per-task gates) or into a side-channel the human in-place flow doesn't have. Nothing in the build phase depends on the mode, so there is nothing to carry forward.

Resolution precedence (highest first), identical for human and autonomous paths except the flag is human-only:

1. `complete --merge` / `--propose` flag (human, per-invocation)
2. per-repo config override (a committed repo-root `dorfl.json`)
3. global config `integration`
4. built-in default `propose`

`propose` is the safe default (human reviews before main moves — essential for unattended/autonomous work). `merge` is opt-in for repos where trust × low blast-radius × a strong `verify` gate make hands-off landing acceptable. Integration mode (and `verify`, arbiter) are repo properties, so they live in a per-repo config layered over global — letting repo A be `merge` and repo B `propose` in the same multi-repo run.

## 12. Stuck items move to `needs-attention/` (folder-native surfacing, not labels)

Every "couldn't finish, a human must look" outcome — a failed acceptance gate, a rebase/merge conflict (§10), a task the agent found too ambiguous to build, a timeout, a rejected review — resolves to ONE mechanism: the runner `git mv`s the claimed item from `work/in-progress/<slug>.md` to `work/needs-attention/<slug>.md`, writing the reason (+ any surfaced agent questions) into the file body. This is the folder-native form of "needs-attention surfacing" (which we had parked as an open problem): the surface is a folder you can `ls`, read by `scan`/`status` — no labels, no status field (honours WORK-CONTRACT rule 3: status = folder).

Why folders, not Matt-Pocock-style labels: a mutable status/label _field_ that every transition rewrites is a shared conflict point (rules 2–3). Moving a file between folders is conflict-safe by construction. So we borrow the _concept_ of triage/needs-attention states but express them the contract's way — as folders + `git mv`.

Decisions:

- **One folder for now: `needs-attention/`** — the _post-claim, attempted-but- stuck_ state. We deliberately do NOT add a separate _pre-claim_ "not ready to claim" state (a la intake `needs-triage`/`needs-info`): under-specified items simply should not be written into `backlog/` until ready. (Solo-with-agents has no separate "reporter" to wait on, so `needs-info` doesn't map cleanly.) Revisit only if a real intake-triage need appears.
- **The runner owns the move** (not the build agent — agents do no git). It writes the reason, `git mv` in-progress -> needs-attention, commits/pushes like the done-move.
- **Not claimable, but surfaced:** `scan`/eligibility skip `needs-attention/` for claiming; `status` lists them with their reason (this folder is the "look here" set; dovetails with the retained-worktree signal).
- **Return path:** a human resolves the cause and `git mv`s the item back to `backlog/` to be re-claimed (or resumes on its branch). It must not rot.
- This unifies and subsumes the previously-separate "needs-attention surfacing" concern across the gate, conflict, ambiguity, and timeout outcomes.

## 13. Model selection is dorfl's (via the harness seam); auth/keys are the harness's

The runner decides **which model** a job runs on; it never touches **credentials**. This is the clean boundary: model = routing intent dorfl controls; API keys, OAuth, provider base URLs = the agent harness's job, out of scope for dorfl (the harness — `pi`, or whatever `agentCmd` wraps — already does auth well, and a portable runner must not duplicate per-provider secret handling).

Decisions:

- **`model` is a first-class, harness-agnostic field** carried through the harness seam (`LaunchInput.model`). The CORE passes the _intent_ (a model id); the ADAPTER decides how that reaches its tool:
  - the **pi** adapter passes it natively (`--model <model>`);
  - the **null/shell** adapter substitutes a `{model}` placeholder in `agentCmd` (degradation rules: placeholder + no model ⇒ a clear config error; no placeholder ⇒ run the command as-is — dorfl offers model routing but never forces it, so a user who bakes the model into `agentCmd` or relies on the harness's own default is untouched). This mirrors §6's seam discipline: one declared intent, adapter-specific realization; the core stays tool-agnostic.

- **`model` resolves per-repo, like `integration`/`verify`:** flag (`--model`) > **env (`DORFL_*`)** > per-repo `dorfl.json` > global > default (unset). So `model` joins `REPO_ALLOWED_KEYS` — choosing the model for _this repo's_ work is a legitimate repo property. `harness` (which adapter) is likewise repo-appropriate and allowed per-repo; `piBin` and `agentCmd` stay **host-only** (rejected per-repo) because they are machine paths/commands, not repo policy.

- **Host-only keys come from a PER-MACHINE source — never the committed repo file.** This is the sharpened principle: a host-only key (`piBin`, `agentCmd`, `roots`, `maxParallel`, …) must be supplied by a _per-machine_ source — a CLI flag, an **`DORFL_*` environment variable**, or the global `~/.config/dorfl/config.json` — and is rejected (ignored + reported) if it appears in the committed `dorfl.json`. The per-repo allow/reject split (`REPO_ALLOWED_KEYS`/`REPO_REJECTED_KEYS`) governs ONLY the committed repo file; it does **not** constrain env. Env is a legitimate per-machine source (exactly like a flag or the global file), so it may set **any** `Config` key, host-only included — it is simply the per-machine source a CI job actually has without writing a file. This de-risks per-job CI config and lets every future key (e.g. `model`) inherit env support uniformly.

  > **Deliberate EXCEPTION — `dorflCmd` is repo-settable (2026-07-21).** The ONE machine-command key that is in `REPO_ALLOWED_KEYS`, not `REPO_REJECTED_KEYS`: `dorflCmd` (the repo-declared dorfl COMMAND bare `dorfl` self-forwards to — spec `dorfl-self-version-pinning-and-bootstrap-forward`) names WHICH executable runs, so it is definitionally the same class as the rejected `agentCmd`/`piBin`/`sessionsDir` above, yet it is deliberately repo-settable. This REVERSES this bullet's host-only rule for that one key, because its purpose is repo-declared REPRODUCIBILITY (the repo SHOULD decide which dorfl it runs), it carries no more trust than the committed `verify` command the repo already runs, and the forward is ANNOUNCED on stderr (unlike a silent `piBin`). There is NO trust gate. Recorded in its own ADR — see `dorfl-cmd-repo-settable-exception-to-host-only.md`.

- **The env layer: `DORFL_<SCREAMING_SNAKE(key)>`, typed + loud.** Env vars are named by mechanically uppercasing the camelCase `Config` key (`agentCmd` → `DORFL_AGENT_CMD`, `perRepoMax` → `DORFL_PER_REPO_MAX`). Each is coerced per the key's type and an invalid value **fails loudly** (naming the offending variable), never silently ignored: booleans accept only `true`/`false`; numbers reject NaN; enums validate against their union; list keys split on comma (cross-platform); strings pass verbatim. Absent env leaves built-in floors/defaults untouched; the global `.config` file keeps working (env is additive). Full chain (highest wins): `flag > ENV (DORFL_*) > per-repo > global > built-in default`.

- **Auth stays in the harness, always.** dorfl sets no API keys, writes no `auth.json`/`models.json`, and reads no secrets. (The CI `install-ci` work — separate spec — wires harness auth as a harness concern, mirroring whitesmith.)

- **Per-ROLE model (build vs task vs review vs grilling) is STAGED, not built now.** A single `model` covers the build path today. Each future capability brings its own role override _as it becomes real_ (e.g. `auto-slice` adds a `task` model; review adds a `review` model) — resolved as role-override > base `model`, then through the per-repo chain. We do NOT spec the role map up front (it would be config for capabilities that don't exist yet — speculative generality that goes stale). The `model` field is shaped so a later `perRole` map layers on without breaking it.

## 14. Recovery model: the branch is the durable artifact; requeue continues by default

A claimed item's **`work/<slug>` branch is the durable artifact**; the job worktree (agents' area) is a disposable cache. Recovery of stuck/failed/interrupted work flows through the branch + the folder-native surfaces (§4, §12), NOT by a human editing the agents'-area worktree. Decisions:

- **One branch per slug-IDENTITY, content-named, no versioning.** The work branch is stable and 1:1 with the item's _namespaced_ identity (`<type>-<slug>`, §15) — NOT the bare slug (a spec and a task sharing a slug are distinct items and get distinct branches). The slug-not-counter principle still holds: we do NOT version attempts (`…/attempt-2`) — that reintroduces a counter and forces every consumer (claim, integrate, gc, work-on) to learn "which attempt is current". The single branch accumulates across attempts.

- **`requeue` (default) = keep + continue.** Requeue moves the ledger `needs-attention/ → backlog/` and KEEPS the branch; the next claim **continues from the existing `work/<slug>` tip on the arbiter** (not a fresh cut off main). Cross-machine continue works because stuck items push the branch to the arbiter (§12 / `routeToNeedsAttention`). `requeue -m "<note>"` appends a dated human handoff note to the item body, threaded into the continuing agent's prompt (alongside the prior diff + the needs-attention reason). The build agent's prompt gains a CONTINUE block ONLY when continuing (fresh-start path unchanged).

- **`requeue --reset` = discard + fresh.** Deletes the remote branch (`git push <arbiter> --delete work/<slug>` — plain provider-agnostic git, works on a `--bare` arbiter; the ONE deliberate, guarded exception to "never delete the remote branch") and starts the next attempt clean off main. Plain delete (revisit a rename-aside-to-`discarded/` only if a real "undo my reset" need appears).

- **Agent failure SAVES work.** A non-zero agent exit commits + pushes the partial work + routes to `needs-attention` (parity with a gate failure), recoverable via requeue-continue — never a silent drop.

- **No periodic auto-commit/push.** We do NOT periodically commit the agent's working tree to checkpoint against mid-work interruption: a timer-driven `git add -A` would sweep untracked/incomplete artifacts (the precise bug the tree-cleanliness wrapper rule fixed). Work is saved at deliberate transitions (done-move, needs-attention routing), never on a blind timer. A HARD mid-work interruption (kill -9 / machine shutdown with uncommitted edits) is accepted as inherently lossy.

- **Salvage policy (a + permissive-c; b deferred).** The clean recovery path is needs-attention → `requeue` (continue) / `work-on` in the HUMAN area — the agents'-area worktree is never the human's edit surface (the secrets-isolation line, §2/§3). (a) Because stuck/failed runs push the branch, the work is almost always already on the arbiter, so `work-on`/requeue recover it without touching the agents' area — this is the default and covers nearly all cases. (b) A dedicated `salvage` verb (lift an un-pushed retained worktree's branch to the arbiter) is NOT built — the residual gap (committed-but-unpushed work stranded on a vanished machine) is narrow; revisit if it bites. (c) We do NOT forbid a human `cd`-ing into a retained job worktree as a last resort — the goal is that a human NEVER NEEDS to, not that they mustn't; if they do, it works (just keep secrets out of it). Permissive, not prohibitive.

- **Recovery is artifact-AGNOSTIC — it covers the TASKING branch too** (`centralise-bounce-branch-push`). The "push the work branch on a bounce so a requeue continues from its tip" mechanism is consolidated INTO the needs-attention seam (`ledgerWrite.applyNeedsAttentionTransition`): one operation done in one place — OBSERVABLE (the ledger surface on `main`, the mode-M cherry-pick) + RECOVERABLE (push the work branch, when there is one) — fired whenever an `arbiter` is given, best-effort, emptiness-guarded, and branch-PARAMETERISED (default `work/<slug>`; an explicit branch overrides; surface-only pushes nothing). "The branch is the durable artifact" is transition-kind-agnostic: a build bounce keeps `work/<slug>`, and a **tasking** attempt keeps its `work/tasking/<slug>` branch the same way. A tasking attempt that PRODUCED task files then failed a review (a Gate-1 spec rejection) must NOT discard them — the written tasks are a valuable durable artifact (re-deriving the decomposition loses the reviewer's context); a requeue continues from the written tasks, exactly as a build continues from the code wip. So `auto-slice` (the `do spec:<slug>` tasking path, now wired in `tasking.ts`) REUSES this seam — it passes its `work/tasking/<slug>` as the seam's `branch` rather than re-inventing the push (and so never re-discovers the bolt-on asymmetry a sixth time).

## 15. The work-branch ref is namespaced by item type (and producer), derived from ONE resolver

The work-branch ref is the LAST identity to join the `<type>-<slug>` scheme the rest of the system already uses (the advance sidecar filename `work/questions/<type>-<slug>.md`, the `advancing/` lock entry). Before this, the branch was a bare `work/<slug>` everywhere — the **one identity NOT type-encoded** — so a spec `<slug>` and a task `<slug>` (and an `intake` run on that slug) all collided on the SAME arbiter branch. This had stopped being latent: `intake N` left a `work/<slug>` branch behind, and a later `do task:<slug>` onboarding found that stale same-named branch and reused it (task still in backlog on it) → the build landed on a pre-claim base and the done-move errored "nothing to complete".

Decisions:

- **Namespace the branch by item TYPE, spelled `work/<type>-<slug>`** (`work/task-<slug>`, `work/spec-<slug>`) — matching the lock-entry + sidecar-filename `<type>-<slug>` form EXACTLY, so all four identities (sidecar, lock, **branch**, command-line `task:`/`spec:` prefix) derive from ONE scheme. The task-build / `start` / `work-on` / `complete` paths use `task`; the `do spec:<slug>` tasking path uses `spec`.

- **An optional PRODUCER prefix isolates the `intake` lifecycle** (`work/intake-task-<slug>` / `work/intake-spec-<slug>`). `intake`'s branch CREATES a brand-new backlog item (or spec) — a short-lived "create the item" branch, a SEPARATE lifecycle from the later claim→build→complete of `do task:<slug>`. Giving it its own ref means the branch that creates an item never collides with (or is reused by) the branch that later builds the same-slug task — closing the firing `intake × do task:` collision directly. The producer axis is ORTHOGONAL to the type axis (`intake` is the only producer today); the sidecar/lock identity stays `task`/`spec` (intake produces a real task/spec), only the BRANCH ref carries the producer distinction.

- **ONE derivation, shared with the resolver — no second source of truth.** `workBranchRef(namespace, slug, {producer?})` in `src/slug-namespace.ts` (beside the §3a `resolveSlug` resolver) is the SOLE construction; `parseWorkBranchRef` is its inverse. Every site that builds or reads a work-branch ref calls one of them — none hand-builds `work/${slug}`. The type is THREADED alongside the slug (claim → onboard → complete → continue-detection → needs-attention → gc); where a consumer is already standing ON the branch (`complete`, the integrate core), it RECOVERS the type from the branch name via `parseWorkBranchRef` rather than re-deriving it.

- **Clean breaking cutover (no recognise-old-name window).** Precedent: `remove-sliced-marker-step-b`, `rename-reviewpr-to-review`. `parseWorkBranchRef` returns `undefined` for a pre-rename un-namespaced `work/<slug>`, so continue-detection simply does not find a pre-rename kept branch (there are unlikely to be in-flight ones at rollout). A one-time cutover, documented here.

- **Defensive onboarding guard (backstop on top of the namespace fix).** Even namespaced, in-place onboarding must not silently build on a stale same-named branch. The claim commit sha is now surfaced out of `performClaim` (`ClaimCasResult.claimCommit`) and threaded into the isolation strategy's `prepare`. After the claim push, the arbiter is fetched so local `<arbiter>/main` includes the claim (fixing the masking second defect — a not-yet-advanced local main — and the "Start work" hint). The in-place FRESH path then ASSERTS the claim commit is reachable from `<arbiter>/main` (`git merge-base --is-ancestor`) and throws a CLEAR error if not (never a silent stale-base build), and force-RESETs the work branch onto the EXACT claim commit (`git switch -C <branch> <claimCommit>`, mirroring the §14 CONTINUE path's `-C`) — so any stale same-named branch is re-pointed, never reused as-is. The CONTINUE/requeue rebase path (§14/§10) is unchanged. Failures are LOUD: a missing/unreachable claim commit fails fast, never a silent stale-base build.
