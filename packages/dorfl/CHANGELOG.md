# dorfl

## 0.10.1

### Patch Changes

- c5358d6: Harden git spawning against a caller PATH that omits the system dirs, and self-heal orphan claim residue.

  `dorfl` spawned bare `git` resolved against whatever PATH launched it, so a curated launcher PATH (a version-manager / MCP-agent env listing only `~/.volta/bin`, `~/.cargo/bin`, ... and omitting `/usr/bin`) produced an opaque mid-run `spawn git ENOENT`. Git is now resolved to an absolute path per effective PATH (honouring a `DORFL_GIT`/`GIT` override, else the caller's own PATH first, then the standard system dirs `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` appended), and the spawn env's PATH is unioned with those dirs so git's own child processes (`ssh`, hooks) resolve too. A genuine miss now fails fast with an actionable message naming the effective PATH instead of a bare ENOENT.

  Also self-heals the orphan claim residue such a crash leaves: a record-less `~/.dorfl/work/<id>` directory or dangling symlink (crashed after the path appeared but before `git worktree add` registered it) is now cleared by the re-create path and swept by `gc`, instead of wedging the next `worktree add` until a manual `rm`.

## 0.10.0

### Minor Changes

- df0416f: Rename the `SpecsLandIn` config VALUE `pre-proposed → proposed` (hard cutover, no alias) so the spec-side placement value matches its on-disk folder `specs/proposed/`, exactly as `tasksLandIn: backlog` matches `tasks/backlog/`.

  `pre-proposed` was a leftover of the earlier `pre-spec/` staging-folder prefix that survived the `folder-taxonomy-reorg-and-rename` rename. It surfaced in `specsLandIn` / `untrustedSpecsLandIn` (`dorfl.json`), the env `DORFL_SPECS_LAND_IN` / `DORFL_UNTRUSTED_SPECS_LAND_IN`, and the CLI `--specs-land-in`, so the value-vs-folder mismatch was a user-facing papercut. The value is now `proposed`: `DORFL_SPECS_LAND_IN=proposed` and `--specs-land-in proposed` are accepted, and the old `pre-proposed` spelling now FAILS LOUDLY through the existing enum validation (no silent back-compat read), since this repo has no external users yet (matching the `autoTriage → observationTriage` clean-cutover precedent). The on-disk folder `work/specs/proposed/` is unchanged: only the config value spelling changed. `tasksLandIn: 'backlog'` (already consistent) is untouched. Governing spec: `intake-integration-knob-and-specs-land-in-proposed-rename`.

## 0.9.0

### Minor Changes

- ea9d86d: Add an `intakeIntegration` config knob (the twin of `taskingIntegration`) that governs the intake DOCUMENT PR-mode, and decouple that mode from the autonomy gates.

  Previously `deriveIntakeFlags` derived the intake task/spec document merge-vs-propose mode from `autoBuild`/`autoTask` (`task = autoBuild ? propose : merge`), welding "may an agent act autonomously" to "does the document need a PR." So a repo could not have `autoBuild: true`/`autoTask: true` (autonomy) AND intake documents merging to `main` at the same time. Now the intake document mode is the resolved `intakeIntegration ?? integration` (a single operator/config value applied to both the task and spec document), resolved flag > env `DORFL_INTAKE_INTEGRATION` > per-repo > global > fall back to `integration` > default `propose`, surfaced in `dorfl config --json`, and honored per-repo. The autonomy gates go back to meaning ONLY autonomy; they no longer feed the intake document mode. The generated `intake.yml` reads `.intakeIntegration // .integration` (not the gates) for the document mode, and `validateIntakeWorkflow` gains `reads-intake-integration` / `intake-integration-falls-back-to-integration` / `mode-not-gate-derived` invariants so the coupling cannot regress. Untrusted safety is unchanged: it rests on placement (`untrusted*LandIn`) + the build-time `originTrust: untrusted` stamp (the code PR), not a forced document PR. The intake CLI's explicit `--merge-task`/`--merge-spec`/`--merge`/`--propose` overrides still win. Zero-config behaviour is unchanged (everything propose). Governing spec: `intake-integration-knob-and-specs-land-in-proposed-rename`; ADR: `docs/adr/untrusted-origin-carries-via-stamp-not-forced-staging.md`.

### Patch Changes

- 83dbcfe: Stop the generated `intake.yml` hardcoding `DORFL_AUTO_BUILD` / `DORFL_AUTO_TASK` env; read the resolved gates via `dorfl config --json` so the committed `dorfl.json` gates are honored in CI.

  The intake workflow's `env:` block pinned `DORFL_AUTO_BUILD: 'false'` / `DORFL_AUTO_TASK: 'false'`. Since env outranks per-repo config in the resolution chain (flag > env > per-repo > global > default), those defaults SHADOWED a repo's committed gates: a repo with `autoBuild: true` in `dorfl.json` was silently overridden by the hardcoded `false`, contradicting the documented "the same dorfl.json applies in CI." The env lines are removed and the policy step now reads the resolved gates via `dorfl config --json` (the mechanism the `advance` workflow already uses). `validateIntakeWorkflow` gains `no-gate-env-auto-build` / `no-gate-env-auto-task` invariants (mirroring `advance-lifecycle-template.ts`) so the shadowing bug cannot regress. Governing decision: `docs/adr/untrusted-origin-carries-via-stamp-not-forced-staging.md`.

## 0.8.1

### Patch Changes

- 225b4d2: Document the CI-safe `verify` gate pitfalls (the project-toolchain boundary) in `docs/ci/README.md`.

  `dorfl-setup` provisions only what dorfl needs (Node + dorfl + harness), not the project's toolchain — the documented-not-detected boundary from ADR `install-ci-project-provisioning-native-passthrough`. In practice a real repo's `verify` gate hits three concrete pitfalls that fail the GitHub `verify` check (while `merge`-mode work still lands via dorfl's own fresh-worktree gate, so they are easy to miss): (1) `dorfl verify` does NOT run `prepare`, so the job must provision the package manager + install deps itself (else `pnpm: command not found` / missing deps); (2) git-history-dependent gate steps like `changeset status --since=main` fail on a detached PR checkout with no local `main` branch; (3) `changeset status --since=main` can never pass on the changesets Version PR (`changeset-release/main`), which consumes changesets by design. The new "Writing a CI-safe `verify` gate" section documents each pitfall, the project-setup-hook remedy (a copy-pasteable GitHub `pnpm` example), and why a `merge`-mode repo can hit these late.

- e3d6188: Render a task's spec-user-story coverage as `US-<n>` (not `US #<n>`) in the propose-mode tasking PR body.

  `composeTaskingProposeBody` emitted each task's coverage map as `US #<n>`. On GitHub a bare `#<n>` in a PR body autolinks to issue/PR #<n> — a confusing false reference, since the number is a spec user-story index, not an issue (observed live on wighawag/rocketh#45). The hyphenated `US-<n>` form carries the same meaning without tripping GitHub's autolinker.

## 0.8.0

### Minor Changes

- 11b63b8: Make the global `dorfl` a thin bootstrap that self-forwards to the repo-declared `dorflCmd`.

  On startup, BEFORE any command dispatch, `dorfl` reads the nearest repo `dorfl.json`; if it declares `dorflCmd` (added by `dorfl-cmd-config-field`) and we are not already the forwarded process, it `exec`s that command with the ORIGINAL argv + env inherited — after a one-line **stderr** notice — and exits with the child's exit code (transparent passthrough). This makes the taught, project-independent `dorfl` command reproducible + repo-owned instead of floating with whatever global dorfl a machine happens to have. This is the forward half of the `dorfl-self-version-pinning-and-bootstrap-forward` spec (stories 1, 4, 5).

  Guards, all covered end-to-end:
  - **Onboarding-safe:** NO `dorflCmd` ⇒ the bootstrap runs itself (`setup`/`install-ci` in a not-yet-pinned repo just work — never chicken-and-egg).
  - **Loop-safe:** the forwarded child runs with a `DORFL_FORWARDED=1` env marker, so a forwarded dorfl reading the SAME `dorfl.json` runs in-process instead of forwarding again (a single hop).
  - **Fail loud, never silent degrade:** a declared `dorflCmd` whose target does not resolve (e.g. `node_modules/.bin/dorfl` before the repo's dependency install) — or a present binary that spawn-errors — errors clearly, naming the `dorflCmd` value + the `dorfl.json` path + the fix (run the dependency install first) + the `--no-forward`/`DORFL_NO_FORWARD` bypass, with a non-zero exit. A working forward whose COMMAND merely exits non-zero (e.g. `verify` red) is passed through transparently, not treated as broken.
  - **Non-recursive by design:** the forward decision fires ONCE, at bare-`dorfl` startup, in the checkout root. The gate worktree that runs `prepare`/`verify` is prepared by the already-running dorfl via `spawn('bash', ['-c', cmd])` — it never launches a new `dorfl`, so a fresh worktree's empty `node_modules` never re-triggers the forward.
  - **Announced + opt-outable:** the notice goes to **stderr** only (stdout stays clean for `--json`); `DORFL_NO_FORWARD=1` OR `--no-forward` each disable AND silence the forward, honoured before dispatch (the `--no-forward` token is stripped before commander parses).

  `dorflCmd` is honoured verbatim (no trust gate — the same trust as the committed `verify` command). The forward is an injectable seam (`bootstrap-forward.ts`: `decideForward` + `performForward` + `maybeForward`), unit-tested without re-execing a real second dorfl or hitting the network.

- c7033c7: Add the optional `dorflCmd` config field — the repo-declared dorfl COMMAND.

  A repo's committed `dorfl.json` may now declare `dorflCmd`: the exact dorfl command that repo runs with (e.g. `"node_modules/.bin/dorfl"`, `"npx dorfl@0.7.0"`, `"./bin/dorfl"`, `"mise exec dorfl@0.7.0 --"`). This is the config half of the `dorfl-self-version-pinning-and-bootstrap-forward` spec: a later task makes bare `dorfl` (a thin bootstrap) self-forward to it, so the taught, project-independent `dorfl` command becomes reproducible + repo-owned instead of floating with whatever global dorfl a machine happens to have. This task adds ONLY the field — parse, validate, and expose it through the config-resolution chain; the forwarding/announce/opt-out land in `dorfl-bootstrap-self-forward`.

  The field is honoured verbatim (no version parsing, no download/resolution, no shell-splitting — a version is expressed by writing `npx dorfl@<version>` yourself). It is optional with no default: unset/empty/whitespace-only ⇒ absent (the bootstrap runs itself, never an error); leading/trailing whitespace is trimmed; a non-string value fails loud at config load. It resolves per-repo through the standard chain (flag > env `DORFL_DORFL_CMD` > per-repo `dorfl.json` > global > default unset).

  Unlike the host-only machine-command keys `agentCmd`/`piBin`/`sessionsDir` (kept in `REPO_REJECTED_KEYS` per `execution-substrate-decisions.md` §13 — a committed repo file must not redirect where the host runs), `dorflCmd` IS repo-settable (added to `REPO_ALLOWED_KEYS`). This deliberate reversal of the host-only rule for one key — because its purpose is repo-declared reproducibility, it carries no more trust than the committed `verify` command the repo already runs, and the forward is announced, not silent — is recorded in a new ADR (`dorfl-cmd-repo-settable-exception-to-host-only.md`), cross-referenced from the field's JSDoc and from ADR §13. There is no trust gate.

### Patch Changes

- 37230fb: Document the `dorflCmd` pin model + the version-upgrade ritual (docs-only).

  New reference page `docs/dorfl-cmd/README.md` explains the shipped pin model: dorfl is a TOOL like `prettier`/`tsc`, the globally-installed `dorfl` is a thin BOOTSTRAP, a repo declares which dorfl it runs via `dorflCmd` in `dorfl.json`, and bare `dorfl` self-forwards to it (announced on stderr; opt out with `--no-forward` / `DORFL_NO_FORWARD=1`). It covers the per-ecosystem declaration examples (JS devDep `node_modules/.bin/dorfl`, `npx dorfl@<version>`, a vendored `./bin/dorfl`, a `mise`/`asdf` shim), the fail-loud-on-broken-pin behaviour, the upgrade ritual (bump `dorflCmd` → `dorfl sync` → re-run `install-ci` only if the workflow templates changed), and the explicit non-goals (no version resolution/download/cache — write `npx dorfl@<version>` yourself; no trust gate — same trust as the committed `verify` command).

  Cross-references added: the README `Pin the dorfl version (dorflCmd)` section, the website `dorfl.json` card, a `CONTEXT.md` glossary entry (distinguishing `dorflCmd` — the pinned EXECUTABLE — from `dorfl sync` — the `work/protocol/` DOCS), and the `docs/ci/README.md` shim note. The `setup` skill's version-pin nudge now points at the shipped `dorflCmd` field (and this page) instead of a placeholder `dorflBin`. No runtime behaviour changes.

- 6c488c5: Converge the `install-ci` CI resolver shim onto the generic `dorflCmd` bootstrap forward.

  The emitted `dorfl-setup` composite action historically installed the global `dorfl` (`npm install -g dorfl`) and then wrote a bespoke `$PATH` shim that preferred a project-local `node_modules/.bin/dorfl` over the global (task `install-ci-prefer-project-local-dorfl`). That shim was CI-only AND JS-specific (it hardcoded `node_modules/.bin`).

  Now that the global bootstrap `dorfl` self-forwards to the repo-declared `dorflCmd` on its own (task `dorfl-bootstrap-self-forward`), that shim is redundant. This change REMOVES it entirely: CI's `npm install -g dorfl` leaves the bootstrap on `$PATH`, and the bootstrap forwards to the repo's declared `dorflCmd` by the SAME generic mechanism the laptop uses — one code path, JS and non-JS alike (spec `dorfl-self-version-pinning-and-bootstrap-forward` §6 / story 4).

  A JS repo that pinned via a devDep declares `dorflCmd: "node_modules/.bin/dorfl"` (one line; `setup` nudges it) and gets the pin in CI via the forward; a repo with no `dorflCmd` runs the global bootstrap identically on CI and the laptop (onboarding-safe). Keeping a JS-only no-`dorflCmd` fallback was deliberately rejected — it would re-introduce the JS-specific CI-only special case the convergence removes, and a repo declaring both the devDep and `dorflCmd` would double-resolve (shim execs the local bin which then forwards again).

  Everything else in the emitted CI is UNCHANGED: the `verify` required-check name, the `dorfl[bot]` git identity, the harness install, and the `--fake` snapshot mode. Only the dorfl-resolution step changed.

- 2d4b35c: Harden the Gate-2 review-gate wiring regression test against transient CI `spawnSync` fork failures.

  `cli-complete-run-review-gate-wiring.test.ts` proves a `harness: pi` gate does NOT trip the null-adapter empty-`agentCmd` guard by stubbing `piBin: 'true'` and asserting the launch fails DOWNSTREAM as a `ReviewParseError` (empty verdict). Under a heavily-loaded CI runner `spawnSync` can instead fail the FORK itself with a transient `EAGAIN` ("failed to spawn pi …") — an environment flake, not the empty-`agentCmd` guard and not a wiring regression. The core invariant (the surfaced error is NEVER about `agentCmd`) is now asserted unconditionally, and the stronger `ReviewParseError` assertion is skipped only when the message is a transient spawn failure, so a fork hiccup no longer reddens the suite.

- 8e5d237: `setup` now nudges the user to PIN the dorfl version a repo runs with (reproducibility).

  Agents are taught to invoke bare `dorfl` so the workflow stays project-independent, but bare `dorfl` then runs whatever version is globally installed — which drifts (a laptop on one version, CI floating to latest via `npm install -g dorfl`, a repo reasoned-about under a third). The `setup` skill's adoption conversation now includes a language-agnostic nudge, in the same style as its per-change-convention and `testFirst` nudges (folded into the plan, no extra question round): it asks once whether to pin the dorfl version, and records it the language-appropriate way — a root `package.json` devDependency for a JS repo (the `install-ci` CI shim already prefers a project-local `node_modules/.bin/dorfl`), or a vendored `./bin/dorfl` / `npx dorfl@<version>` / `mise` / `asdf` shim for a non-JS repo (never inventing a JS dependency). The scaffolded `CONTEXT.md` `## Conventions` stub carries a matching reminder. Complements the `dorflCmd` pin field in `dorfl.json` (spec `dorfl-self-version-pinning-and-bootstrap-forward`): a repo that declares `dorflCmd` has bare `dorfl` self-forward to the pinned command.

- 1f37af5: A tasking (`spec:`) review that DISAPPROVES now exits 0 (green CI leg) and, in propose mode, CLOSES a stale open PR with the review as the closing comment while keeping the branch.

  Two coupled fixes to the tasking disapprove path:
  - **A clean park-for-human is a SUCCESS, not a failure.** When a tasking review disapproves the produced task SET (or the tasker loop can't converge, or a co-located sidecar / unparseable verdict blocks), `performTask` cleanly surfaces the spec for the human (`needsAnswers: true` body + a question sidecar on `main`, lock RELEASED) and now returns exit 0 instead of exit 1 — so the `advance-propose` CI leg is GREEN, matching the build path (which already treats a clean-surface bounce as exit 0). This stops a normal "I've surfaced a question, over to you" outcome from reddening CI every time and training operators to ignore red. The surface messaging was reworded to say the item is "parked for your attention" rather than the misleading "marked the per-item lock stuck" (the stuck lock state is retired; the lock is released, not held).
  - **Disapprove closes the stale PR (keeps the branch); a later approving re-task reopens it.** Because the earlier multi-run bug could already have opened a tasking PR, a disapprove now closes that PR — with the disapproving review as the closing comment (so the reason is visible ON the PR) — while KEEPING the branch as the recovery point. Only-if-exists: it never opens a PR just to close it, and merge mode (no PR) never consults the seam. A new advisory, never-throw `ReviewProvider.closeRequestOnBranch` (GitHub: `gh pr close <branch> --comment` with NO `--delete-branch`) does the close; `openRequest` now REOPENS a previously-closed PR (`gh pr reopen`) instead of opening a duplicate, so an approving re-task lands back on the same PR with its history and closing-comment thread intact.

- df96cd9: Hold the spec lock across the propose PR so CI stops re-tasking a spec (and force-pushing its open PR) on every tick.

  In propose mode `performTask` released the `spec:<slug>` per-item lock as soon as the tasking PR opened, but the durable `specs/ready → specs/tasked` move lives only on the pushed PR branch — `main` still holds the spec in `ready/`. So the next in-place scan saw the spec eligible again (ready + not-tasked + lock free) and re-tasked it, force-recreating the `work/spec-<slug>` branch (`git switch -C`) and force-pushing the SAME PR, which regenerated its review every scheduled tick until a human merged or closed it.

  The tasking path now mirrors the already-correct build path (`propose-keep-lock-until-pr-merge`): the `spec:<slug>` lock is released only when the work is durably on `main` (merge mode); on propose it stays HELD across the open PR — the held lock is the in-flight-tasking marker. `scoreSpecs`/`scanRepoPaths` and the local autopick driver now subtract held-spec slugs from the taskable pool (a new `heldSpecSlugs`/`heldSpecSlugsStrict`, the spec analogue of the existing held-task-slug subtraction), so an in-flight spec never leaks back into the propose matrix. The lock is reaped when the PR merges (or via `release-lock` if a human closes it unmerged).

## 0.7.0

### Minor Changes

- 038b61b: Point the build agent at the repo's conventions doc so gate-enforced per-change rules (e.g. changesets) aren't silently skipped.

  The `CLAIM-PROTOCOL.md` work-agent wrapper (the in-band prompt every build agent receives) told the agent to satisfy the task's acceptance criteria and make `verify` green, but never to READ the repo's STANDING per-change conventions — the rules EVERY change must follow regardless of the task (add a changeset, a CHANGELOG entry, regenerate a manifest, …). `setup` already elicits these and records them under `## Conventions` in `CONTEXT.md`, but the build agent was never steered to read them, so a convention the `verify` gate enforces (classically: a package changed with no changeset) would pass the agent's own build yet BOUNCE the item at LAND time — an opaque failure the agent could not see coming.

  The wrapper now instructs the agent, right before it stops, to read the repo's conventions doc (`CONTEXT.md`'s `## Conventions`, and `AGENTS.md` if present) and satisfy any standing rule that applies, noting that several are gate-enforced and skipping one bounces the item at land time even when the task's own code is correct. This is generic (any convention, any repo), not changeset-specific — dorfl points at the doc; the repo's `CONTEXT.md` owns the specifics. Mirrored byte-identically into `skills/setup/protocol/` (source of truth) and `work/protocol/` (this repo's copy), and re-vendored into the published CLI.

## 0.6.0

### Minor Changes

- 7fb98a8: Surface WHICH gate command failed and its output in a bounced item's needs-attention reason.

  When an item bounces because the acceptance gate (`verify`) fails — including the land-time re-verify on the rebased tip — the surfaced `work/questions/<slug>.md` reason was an opaque `acceptance gate failed (exit N) on the rebased tip`. A maintainer could not tell WHICH step of a multi-command gate (`build && test && format:check && changeset status …`) failed, or WHY, without re-running the whole gate by hand.

  `runVerify` now captures, on a failing gate, the exact `failedCommand` (the first non-zero-exit command, matching `&&` short-circuit semantics) and a bounded `outputTail` (the last non-empty lines of that command's combined stdout+stderr, capped by the new `VERIFY_OUTPUT_TAIL_LINES`). A new pure `formatGateFailureContext()` helper turns those into an appendable tail, wired through every gate-failure site (front gate, rebased-tip fresh-worktree gate, committed-recovery). The bounce reason now reads e.g. `acceptance gate failed (exit 1) on the rebased tip — the failing step was: \`pnpm changeset status --since=main\`; its last output was: … no changesets were found. Run \`changeset add\` …`, so the surfaced question is actionable (and often self-documents the fix) instead of a bare exit code.

- b2235a0: Scope the `<slug>/` asset-sidecar rule to `notes/*` ONLY, and ENFORCE it at land.

  WORK-CONTRACT.md rule 8 previously allowed a co-located `<slug>/` asset sidecar for ANY bucket (`notes/`, `tasks/`, `specs/`). That is unsafe for the FLOWING regimes: a task moves `tasks/ready → tasks/done` and a spec moves `specs/ready → specs/tasked`, and a co-located sidecar (which shares the item's lifecycle) must be `git mv`'d in lockstep on every transition — in practice it gets STRANDED, splitting one item across two status folders (a one-slug-one-folder violation). Rule 8 now reads: a `<slug>/` sidecar is for `notes/*` only (they leave by deletion, so the sidecar never moves); `tasks/*` and `specs/*` keep durable companion artifacts (a patch, a build/measurement script, a diagram) in the STABLE, non-flowing `docs/spikes/<slug>/` home and REFERENCE them by path. Carve-outs are stated explicitly: transient BUILD scratch belongs OUTSIDE the repo, and the `work/questions/<type>-<slug>.md` needs-attention file is a status-mechanism file, not an item sidecar.

  The build-agent prompt wrapper (CLAIM-PROTOCOL.md `## Prompt`) now instructs agents to write durable/reusable artifacts to `docs/spikes/<slug>/` and never to create a `work/tasks/<slug>/` / `work/specs/<slug>/` sidecar.

  A new GUARD (`sidecar-guard.ts`) detects a `<slug>/` directory co-located with a flowing `tasks/*` / `specs/*` item and HARD-BLOCKS it at LAND (in `performIntegration`, before the durable `git mv`), routing the item to needs-attention with an actionable "relocate to `docs/spikes/<slug>/` and reference by path (WORK-CONTRACT rule 8)" message — surfaced via the same seam a red gate uses (`sidecar-violation` outcome across `complete`/`run`/`do spec:`). A `notes/*` sidecar, the `work/questions/*` file, and any `docs/spikes/<slug>/` outside `work/` all pass with no false positive.

## 0.5.1

### Patch Changes

- 9d7ce55: Fix `complete --review` and a `run`-tick review throwing "empty agentCmd — nothing would run" under `harness: pi`. Both commands built their Gate-2 (PR/code review) gate as an arg-less `harnessReviewGate()`, which defaulted to a `NullHarness` + empty `agentCmd` and tripped the empty-command backstop whenever `--review` was on — even though the pi adapter does not consume `agentCmd` (only the null/shell adapter does). They now resolve and thread `{harness, agentCmd}` exactly as the `do` command already does (via `createHarness({harness, piBin})`), so the pi-backed review gate runs. This unblocks the designated re-integration path after a Gate-2 bounce: fixing a review block on the pushed `work/<slug>` branch and re-running `dorfl complete <slug> --review` now re-reviews through the configured harness instead of forcing `--no-review`. The `--isolated` complete recovery path wires no review gate and is unaffected.

## 0.5.0

### Minor Changes

- 429deea: Tasking is now atomic-or-split-or-explore: a spec is tasked ATOMICALLY (every user story becomes a task, or none does) — there is no "partially tasked" state. The tasker decision procedure has three exhaustive branches: (1) all stories build-taskable now → task the whole spec; (2) mixed confidence / part gated → SPLIT into a fully-taskable spec plus a separate spec for the gated remainder; (3) the whole thing too big/uncertain to build-task → REFRAME as an EXPLORATION spec whose "done" is confidence + a de-risked, sliced build plan (the capability build becomes a follow-on spec, ordered via `taskedAfter:`).

  This forbids partially-tasking a spec (the human `to-task` path is now symmetric with the auto-tasker's whole-spec gate) and introduces a first-class spec KIND distinguished by its definition of DONE (build spec vs exploration spec), without adding any new folder or state — an exploration spec is still just a spec, tasked atomically, and its spikes reuse the existing `prototype` vocabulary. The `do spec:` auto-tasker prompt now routes a mis-scoped or too-big/uncertain spec to needs-attention (to be split or reframed) instead of emitting a confident subset or fictional build tasks. Recorded in ADRs `tasking-is-atomic-or-split-no-partial-tasked-state` and `exploration-vs-build-spec-kinds`; the `TASKING-PROTOCOL.md` protocol doc (source + `work/` mirror + vendored `dist/`) and the `to-spec`/`to-task` skills carry the rule.

## 0.4.0

### Minor Changes

- 65bed98: Add `dorfl sync` to bring an already-onboarded repo up to the current protocol.

  It re-syncs `work/protocol/*` from the package's canonical contract docs and bumps `work/protocol/VERSION` (idempotent: a no-op when already current), so a repo that adopted an older protocol picks up the latest in one command rather than re-running the whole `setup` skill. `--dry-run` previews the re-sync without writing.

  It can also refresh the operator's packaged skills: pass `--add-skills` to install them non-interactively (the flag bypasses the prompt), or answer the one-time confirmation an interactive run shows (a non-TTY run skips skills so a scripted `sync` never hangs). `--local` scopes that skills install to `<cwd>/.agents/skills/`.

  The protocol re-sync engine (`resyncProtocol` / `PROTOCOL_DOCS`) is now shared between `sync` and `prd-to-spec` via a new `resync-protocol` module (behaviour unchanged for `prd-to-spec`).

## 0.3.2

### Patch Changes

- 1cffdfb: Prefer the plain `dorfl.json` per-repo config filename while still reading the legacy `.dorfl.json` dotfile on fallback. This corrects a rename sweep that had flattened every reference to the legacy dotfile down to `dorfl.json`, making the fallback docs self-contradictory and breaking the brand/repo-config/install-ci tests. The legacy `.dorfl.json` name is now consistently documented and tested as the read-only fallback, and the preferred `dorfl.json` is the name written by `setup` and reported by `install-ci`.

## 0.3.1

### Patch Changes

- 1a79008: Add `dorfl --version` (and the lower-case `-v` alias) to print the installed CLI version.

  The version is read at runtime from the package's own `package.json` (the single source of truth changesets bumps on release), so it never drifts from the published version. Previously `dorfl --version` errored with "unknown option '--version'".

## 0.3.0

### Minor Changes

- e3a2c69: Remove the default acceptance gate: an unset `verify` now FAILS LOUD, and `dorfl verify` honours the per-repo `dorfl.json`.

  Two related fixes to the acceptance gate (`verify`):
  - **No more default gate (behaviour change).** Previously an unset or all-blank `verify` silently fell back to `pnpm -r build && pnpm -r test && pnpm -r format:check`. That was unsafe: in a non-pnpm repo (e.g. a Zig or Make project) it ran the WRONG check, and in a repo pnpm knows nothing about, `pnpm -r ...` prints "No projects found" and exits 0 — a VACUOUS GREEN that let unverified work cross the trust boundary. Dorfl now has NO default gate: `resolveVerifyCommands` throws `VerifyNotConfiguredError` on an unset/all-blank gate, `runVerify` turns that into a failing `notConfigured` result (never an uncaught crash), and the pre-claim `checkGatePreconditions` guard fails fast — MODE-INDEPENDENT, since a missing gate can never pass in any mode — before a wasted claim + build. A repo MUST now declare its own `verify` in `dorfl.json`.
  - **`dorfl verify` now reads the per-repo config.** The standalone `dorfl verify` command resolved its gate from the GLOBAL config only, ignoring a repo's committed `dorfl.json` `verify` entirely and running the old built-in default. It now resolves through the same per-repo chain the runner uses (flag > env > per-repo `dorfl.json` > global), matching its own help text and the `do`/`run`/`complete` paths.

  Migration: if you relied on the implicit default, add it explicitly, e.g. `"verify": "pnpm -r build && pnpm -r test && pnpm format:check"` (a single string or an ordered list of commands) to your `dorfl.json`.

## 0.2.1

### Patch Changes

- 319e7a0: WORK-CONTRACT: reword the `release-lock --entry <literal>` note to speak in the present. Drop the historical "pre-vocabulary-cutover `slice-<slug>` / `prd-<slug>` prefix" reference and describe the case generically (e.g. a lock entry left un-derivable after a rename).

## 0.2.0

### Minor Changes

- f854b2d: Retire the `stuck` lock state in favour of surfacing bounced work as answerable questions on `main`.

  A bounced or blocked item no longer parks as a `stuck` lock. Instead it is SURFACED on `main` as a `needsAnswers: true` pool item with a `work/questions/<slug>.md` sidecar, and its lock is released — so the state is visible in `git clone`, `ls work/questions/`, and `dorfl status`, and a human resolves it by answering the sidecar rather than by inspecting a lock ref. `LockState` collapses to a single `active` value (the in-flight hold); the crash-window orphan is the only lock that can outlive a leg, and it is nameable/clearable via `release-lock` (+ an orphan-lock report in `gc --ledger`).
  - **Surface-as-questions bounce.** The bounce seams now write the sidecar + flip `needsAnswers` + release the lock atomically, replacing the retired `active -> stuck` lock amend and the `needs-attention/` folder.
  - **Answer -> apply dispatch.** Answering a `kind: 'stuck'` sidecar drives a deterministic `keep | reset | cancel` verb (a sibling of the existing `kind: 'merge'` dispatch): `keep` continues from the kept `work/<slug>` branch tip, `reset` discards that branch first (the `requeue --reset` primitive) then continues, and `cancel` disposes the item to its terminal folder.
  - **One-shot migration.** A new `dorfl migrate-stuck-locks` verb drains any pre-existing `stuck` lock refs into the new surfaced-question shape, so retiring the state strands no already-stuck item.
  - **`requeue --reconcile`.** A non-destructive middle-rung recovery verb (between the default keep+continue and the destructive `--reset`) that re-syncs the mirror and retries the rebase of the kept branch onto latest `main`, pushing the reconciled tip back on success and never deleting the remote branch.
  - Docs, ADRs, and protocol contracts (`WORK-CONTRACT.md`, `CLAIM-PROTOCOL.md`, `REVIEW-PROTOCOL.md`) are reconciled to the active-hold-only model, and the `gc --ledger` report is renamed from "stuck-lock" to "orphan-lock".

### Patch Changes

- f89c803: Cleanup residual `prd` artifact-word after the hard cutover: flip the now-dead `prd:` field / `do prd:` verb references in `CONTEXT.md` to `spec:` / `do spec:`, and sweep the stale `prd`/`PRD` comment prose in a few living docs (`skills/orchestrate`, two ADRs) + dorfl's own generated `.github/workflows/*.yml` comments (the functional YAML was already `spec`; only comment prose was stale — a `dorfl install-ci` regen produces the same). Tighten the WORD leak scan (`prd-word-cutover-leak-scan.test.ts`) so the `prd:` field / `do prd:` verb PROSE exemption applies ONLY inside TERMINAL-HISTORY trees (`work/tasks/done|cancelled`, `work/specs/tasked|dropped`, append-only notes) where rewriting would falsify the record — a `prd:` / `do prd:` in a LIVING doc (CONTEXT/README/AGENTS/skills/docs/active-work) is now flagged as a leak, since the hard cutover made those forms dead. This caught (and fixed) 3 stale references the earlier sweep missed.
- 97d0a4c: Finish the `prd` → `spec` vocabulary-cutover cleanup: a general sweep of every remaining stale artifact-word `prd`/`PRD`/`Prd` (and the doubly-retired `brief`) that was the CONCEPT, made enforced-by-construction so it cannot re-drift.
  - **`packages/dorfl/src` prose swept to `spec`.** Stale mislabels of LIVE behaviour (a comment calling the current `'spec'` type/outcome/namespace `'prd'`) are corrected in `intake.ts`, `isolation.ts`, `workspace.ts`, `scan.ts`, `triage-persist.ts`, `advance.ts`, `advance-drivers.ts`, `decision-engine.ts`, `select-priority.ts`, `config.ts`, `needs-attention.ts` (incl. the `integration.prd` → `integration.spec` symbol ref); the `prd/task`, `{task | prd | adr}`, `mint-prd`, `prd \`land-…\``prose reads`spec/task`/`{task | spec | adr}`/`mint-spec`/`spec \`land-…\``; the stale `prd/review.md`/`prd → prd-tasked`folder narration reads`spec/review.md`/`specs/ready → specs/tasked`. The `vitest.config.ts` `do prd:`/`PRD`/`task-prd`comments read`do spec:`/`spec`/`task-spec`.
  - **Narrate-the-removal comments keep the retired token as a `''prd''` PROVENANCE MARKER** (double-single-quote), a uniquely-greppable handle distinct from ordinary backticks so `grep "''prd''"` finds exactly the "named here only as the retired token" mentions. PRESERVED untouched: the `prd-to-spec` migration command / verb / module, every `prd`-containing slug identity and namespace/lock-ref form (`prd-<slug>`, `prd-complete-query`, `prd-sliced-folder-step-a`, …), historical API names (`renderPrdBody`, `prdsLandIn`, …), the legacy FLAT-layout migration map (`work/prd/` → `work/specs/ready/`), and English.
  - **Living docs swept.** The now-dead `do prd:` verb / `prd:` field references in `skills/orchestrate`, `skills/from-idea`, `skills/to-task`, `skills/setup`, `docs/ci/README.md` read `do spec:` / `spec:`; the false "the legacy `prd:` key is still READ as back-compat" claims are deleted from the protocol SOURCE (`skills/setup/protocol/{WORK-CONTRACT,TASKING-PROTOCOL,task-template}.md`) and the byte-identical `work/protocol/` mirror.
  - **Enforcement is BI-WORD + tightened.** `prd-src-prose-leak-scan.test.ts` and `prd-word-cutover-leak-scan.test.ts` now also strip the `''…''` provenance-marker span (like a backtick span) and gain a `brief`/`BRIEF`/`Brief` lens (a `spec`-only scan would have passed a stray `brief`), with a `brief`-English allow-list (`debrief`/`briefly`/"a brief note") and the namespace/slug forms. The `brief` gate is scoped to LIVING DOCS (a `brief` in a `work/**` body is dated provenance narration; `docs/adr/**` is the deferred ADR pass). Each scan keeps its non-vacuous detector self-check (a planted bare `prd`/`brief` still fails; the marker/English/slug survivors do not) and asserts a concrete allow-list.

  The `docs/adr/**` sweep is INCLUDED: live-reference / stale-guidance `prd`/`brief` in the ADRs (the command-surface namespace table, the branch/lock naming scheme, `do prd:` mechanism refs, `brief-side` → `spec-side`, the taxonomy live-vocabulary line, the `to-task` frontmatter field, a spec cross-reference) is swept to `spec`; the genuine dated DECISION-RECORD mentions that must stay (the retired name AS the thing retired, e.g. "pre-rename `prd:` prefixes are no longer accepted" / "`prd-tasked` read as awkward", and the migration's pre-cutover INPUT, e.g. a `done/` full of dangling `prd:` refs) are backticked token references or wrapped in the ''…'' provenance marker. The bi-word `brief` gate now walks `docs/adr/**` with no deferred-tree carve-out.

  Note: the compiled `.github/workflows/*.yml` are regenerated by `dorfl install-ci` (not hand-edited); the only `prd` they carry is the exempt slug `prd-complete-query`, so a regen is a no-op here.

- fc7b41f: Remove the three `prd` → `spec` cutover leak-scan test gates. The vocabulary cutover and the stuck-lock migration are complete, so these transitional gates no longer guard a live invariant: the only remaining `prd` mentions are legitimate historical/provenance references to the retired `prd-` lock/branch namespace (which the `migrate-stuck-locks` feature, its docs, and its follow-up tasks must name), not fresh regressions. The tree-wide prose scan had flipped from a useful canary into pure friction, repeatedly failing builds on un-backticked-but-legitimate historical mentions in auto-generated task bodies (bouncing tasks with an opaque "acceptance gate failed on the rebased tip").

  Deleted: `prd-word-cutover-leak-scan.test.ts` (tree-wide WORD/PROSE scan), `prd-src-prose-leak-scan.test.ts` (src-dir prose scan), and `prd-to-spec-leak-scan.test.ts` (the cutover trust-signal gate). The functional `prd → spec` conversion feature and its tests (`prd-to-spec.test.ts`, `convert-from-prd-to-spec-skill-doc.test.ts`) are UNCHANGED — only the enforcement scans are removed.

## 0.1.2

### Patch Changes

- 375982d: Erase the `prd` artifact WORD everywhere it names the concept, making `spec` the one vocabulary across every human-readable tree (`CONTEXT.md`/`README.md`/`AGENTS.md`, `skills/` non-protocol, `docs/` incl. ADRs, and all of `work/**` history): the artifact word `prd`/`PRD`/`Prd` reads `spec`/`SPEC`/`Spec` (keep-case) and every `work/prds/` / `prds/<lifecycle>` folder path reads `work/specs/`. The one residual code leak is fixed: `tasking.ts` `buildTaskingSpec` now points a fresh tasker at the EXISTING `work/specs/ready|tasked/` paths via `workFolderRel('specs-ready'/'specs-tasked')` (never a hard-coded `work/prds/*` literal). Deliberately PRESERVED: every `prd`-containing slug identity / cross-reference (file basenames + frontmatter `slug:`/`spec:`/`blockedBy:`/`covers:` values, incl. the command's own `prd-to-spec` name), the live back-compat CODE aliases (`parseFrontmatter`'s `prd:` key read + the `do prd:` / `advance prd:` verb acceptance + their inert `refs/dorfl/lock/prd-<slug>` / `work/prd-<slug>` namespace forms + the legacy-flat-layout `work/prd/` migration-map source names), the camelCase historical API names in `tasks/done/` records (`renderPrdBody`, `prdTitle`, …), and English (none — `prd` is a coined acronym). A new WORD-scoped leak scan (`prd-word-cutover-leak-scan.test.ts`) gates every swept tree against a concrete, each-class-justified PRESERVE allow-list, so the cutover can never silently re-drift.
- 29fc7c6: HARD CUTOVER: remove the LAST `prd` back-compat surfaces so `spec` is the only accepted form (maintainer decision: NO backward compatibility for `prd`). (A) `parseFrontmatter` now reads ONLY the `spec:` key — the read-only `prd:` KEY alias is GONE, so an un-migrated `prd:` frontmatter field no longer silently resolves into `fm.spec` (a repo converts its data via the TEXTUAL `dorfl prd-to-spec` rewrite, which does not go through this parser, so the migration path is unaffected). (B) the dead `do prd:` / `advance prd:` verb references across `packages/dorfl/src` (help text, prompts, JSDoc, comments) are flipped to `do spec:` / `advance spec:` (the `prd:` namespace prefix was already a dead bare-literal token after the contract cutover), and every now-false "the legacy `prd:<slug>` is still accepted / still read" claim is removed from the `do`/`advance`/`promote` help, the `resolveTaskOnlySlug` JSDoc, and the `close-job` / `prompt` / `tasking` field-read comments (the field is `spec:` only). (C) the two leak scans stop exempting the `prd:` field/verb as a "live CODE back-compat alias": the SRC-prose scan (`prd-src-prose-leak-scan.test.ts`) now FAILS on a stray live `prd:` field-key or `do prd:` verb in `packages/dorfl/src` prose (the hard-cutover gate on live code); the WORD scan (`prd-word-cutover-leak-scan.test.ts`) re-documents its `prd:` prose exemption as PROVENANCE (terminal-history bodies/titles that record the dead field/verb as-it-was are immutable and must not be falsified), not a live alias. PRESERVED: the `dorfl prd-to-spec` migration command (whole-file exempt — it must keep matching `prd:` to convert it), provenance slugs / filenames / camelCase historical API names, and English. Coupled fixtures/tests flipped: `close-job` / `prompt` / `spec-complete` (`prd:` fixture frontmatter → `spec:`, `write('prd', …)` folder args → `specs-*`) and the `frontmatter` back-compat test now asserts the HARD CUTOVER (a `prd:` key is NOT read).

  Decision (recorded): the two leak scans were split rather than treated identically — the SRC-prose scan is the authoritative hard-cutover gate (removes the `prd:` exemption, fails on live `prd:`), while the WORD scan keeps its `prd:` prose exemption re-documented as PROVENANCE so immutable terminal-history bodies/titles that record the dead field/verb are not falsified (a full `work/**` history prose sweep was outside this task's declared D surface). See `work/notes/observations/word-scan-keeps-prd-colon-as-provenance-not-live-alias-2026-07-10.md`.

- 2618c6e: Finish the `prd` → `spec` word cutover inside `packages/dorfl/src`: the last non-identifier residual the two prior scans did not gate. The artifact word `prd`/`PRD`/`Prd` now reads `spec`/`SPEC`/`Spec` (keep-case) in comment/JSDoc PROSE and in live runtime + agent-prompt STRINGS, and every `work/prds/` / `prds/<lifecycle>` folder path reads `work/specs/`. The four load-bearing runtime/prompt strings that pointed a fresh agent/user at a `work/prds/` folder that no longer exists in a migrated repo are fixed to build their paths from `workFolderRel`/`workItemRel('specs-*')` (never a hard-coded `work/prds/*` literal), exactly like `buildTaskingSpec`: the `promote` `--help` + its "nothing staged" message (`cli.ts`), the intake decision-prompt spec-file path (`intake.ts`), and the two tasker/review agent prompts that tell the reviewer which source spec to read (`review-gate.ts`, `tasker-review-loop.ts`). Deliberately PRESERVED: the published back-compat CODE aliases (`parseFrontmatter`'s `prd:` key read, the `do prd:` / `advance prd:` verb dispatch + the `prd:<slug>` grammar its `--help` advertises as the accepted legacy alias, the `'prd'` namespace/type/outcome literals, the sidecar `prd-<slug>.md` file-path fallback, `PRD_PREFIX`), every `prd`-containing slug identity in doc-comment attributions (`prd-complete-query`, `prd-sliced-folder-step-a`, …), camelCase historical API names, backticked references to the retired token, the `dorfl prd-to-spec` migration command whose `--help` legitimately names the legacy `work/prds/*` folder as its migration SOURCE, and English. A new source-scoped leak scan (`prd-src-prose-leak-scan.test.ts`) gates `packages/dorfl/src` prose + `work/prds/` runtime strings against a concrete, each-class-justified code-alias allow-list so `src` can never re-drift; the WORD scan (`prd-word-cutover-leak-scan.test.ts`) gains a small, non-vacuous provenance-file exemption for the `prd`-cutover task/observation bodies that legitimately quote the retired word.

## 0.1.1

### Patch Changes

- babb3c5: Finish the `prd → spec` cutover the source part deferred: the vendored work-contract (`skills/setup/protocol/*`) now describes `work/specs/` folders and teaches the `spec:` authoring field (with `do spec:` / `advance spec:` verb forms and `spec`-named lock refs), and the code parent-spec pointer is `spec`-only. `parseFrontmatter` still reads BOTH the canonical `spec:` key and the legacy `prd:` key into `fm.spec`, so un-migrated downstream repos keep resolving their parent spec; the `Frontmatter.prd` field and its readers are gone. Also fixes a latent `resyncProtocol` bug where a protocol doc whose source could not be resolved bumped `work/protocol/VERSION` without copying anything (a missing source is now reported as a skip and never bumps VERSION). Downstream repos pick up the corrected contract by re-running `dorfl prd-to-spec` (or a setup re-sync).

## 0.1.0

### Minor Changes

- 7ddabb6: First public release of `dorfl` — the agent-native work-execution tool (claim → build → gate → integrate), the `spec` work-contract, and the `dorfl prd-to-spec` migration command for repos on the legacy `prd` vocabulary.
