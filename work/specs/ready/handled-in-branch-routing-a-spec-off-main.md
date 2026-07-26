---
title: '`handledInBranch`: route a whole spec onto a named branch, so `main` never moves until the work is adopted or abandoned'
slug: handled-in-branch-routing-a-spec-off-main
humanOnly: true
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked — they move into tasks/ADRs and this spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)

## Problem Statement

I want to build a whole spec — a chain of eight tasks with `blockedBy` edges — as a durable, removable line of work that `main` never sees until I decide to keep it. The concrete case is a NixOS fleet repo where "try the whole feature on a real box, then keep it or throw it away" is the natural unit, and a half-adopted feature on `main` is actively harmful. I want to deploy that line of work to a live box before committing to it, and I want abandoning it to leave `main` byte-identical with nothing lingering.

Today dorfl cannot do this, and every workaround fails in a different way.

**There is no non-`main` land target.** `mergePushOnce` builds the refspec `<branch>:main` literally; `rebaseOntoArbiterMain` fetches `+refs/heads/main:refs/remotes/<arbiter>/main`; the integration core repeats it in its step-4 tail; the ledger write publishes `<localBranch>:main --force-with-lease=main:<base>`. There is no branch key in the config, no `DORFL_*` env for one, and no `--base`/`--branch`/`--target` flag on any command. 223 non-comment lines in `packages/dorfl/src` name the literal `main` ref.

**`--propose` is not a workaround.** In propose mode nothing lands anywhere, so the chain becomes N independent work branches, each rebased onto `main`, none of which can see the others' code. Task 5 builds against a tree that will never exist, and its `blockedBy` predecessor never reaches `tasks/done/` on `main` unless I merge to `main`, which is the one thing I refused.

**Driving it by hand against a checked-out feature branch does not work either.** The in-place isolation strategy never reads HEAD's branch name; in the fresh case it switches to the work branch cut from `<arbiter>/main`. Whatever branch you were on is silently abandoned. Both the isolated and in-place paths cut from `<arbiter>/main`, so there is no conventional escape hatch at all — an apparently-reasonable manual procedure would silently build on the wrong base while reporting green.

The underlying gap: **the `work/` contract has exactly one integration base and it is a literal.** Every durable transition is defined as a `git mv` on `main`, so "done" can only mean "on `main`", and there is no vocabulary for work that is complete relative to anything else.

## Solution

**One optional frontmatter field on a spec**, from which everything else follows:

```yaml
handledInBranch: my-feature-line # optional. The branch this spec's tasks are built and landed on.
```

Absent means `main`, which is today's behaviour byte-identical. Present means: this spec's tasks are cut from that branch, land on that branch, resolve their dependencies against that branch, and are not buildable anywhere else.

The field holds a **literal branch name the user chooses**, not a derived `variants/<slug>`, because the branch's INTENT varies by repo (a discardable variant, a feature that must land whole, a spike) and deriving one name would bake one intent in and make the others read as lies. The precedent is `defaultArbiter`, which likewise stores a remote NAME rather than deriving one.

The shape of the feature:

- **Specs and tasking always stay on `main`.** The spec rests on `main`, the tasker runs there, the tasks are born there, and the `specs/ready → specs/tasked` move lands there. `handledInBranch` says only where the tasks are BUILT. This keeps `taskedAfter` working unchanged, keeps the decomposition visible and greppable on `main`, and means there is no migration story to invent.
- **`do` routes; it does not reject.** `do task:<slug>` reads its `spec:`, reads that spec's field, and cuts from and lands on that branch. No flag to pass, nothing to forget, correct from any directory.
- **The branch is created automatically** on first need, off `<arbiter>/main`, via the same create-only lease the claim CAS uses, and the creation is reported loudly.
- **The branch becomes the ledger for its own items**: pool residence, `tasks/done/`, `needsAnswers`, and question sidecars all live there. `main`'s copies are provenance, not state.
- **Adopt and abandon are verbs.** Adopt is the existing land primitive pointed at the branch. Abandon cancels the tasks, clears the field, and deletes the branch.

Review is unchanged: `integration` still defaults to `propose`, so each task opens a PR **into its branch** and a human reviews it exactly as today. The feature changes exactly one variable — which base the work converges on — and leaves the review discipline, the acceptance gate, the claim CAS, and the conflict-safety rules untouched.

## User Stories

1. As a repo owner, I want to mark a spec as handled in a named branch by adding one line to its frontmatter, so that I do not have to configure anything, remember any flags, or learn a new command to opt in.
2. As a repo owner, I want the field to hold a branch name I choose, so that the branch can be called `variants/x` in one repo and `feature/y` in another without the tool asserting what my intent is.
3. As a repo owner, I want a spec with no `handledInBranch` to behave exactly as it does today, so that adopting this feature costs nothing for every spec that does not use it.
4. As a tasker, I want to task a branch-handled spec on `main` exactly as I task any other spec, so that the decomposition is visible on `main`, `taskedAfter` keeps resolving, and nothing about authoring changes.
5. As a human, I want to see a branch-handled spec's tasks on `main` after tasking, so that I can review the decomposition, promote it, fix a `needsAnswers`, or cancel a task before any building starts.
6. As a human, I want the first build of a branch-handled task to create the branch off current `<arbiter>/main` automatically and tell me it did so, so that I never have to hand-run a `git push origin main:<branch>` and a typo in the field surfaces as an unexpected branch name in the run output.
7. As a human, I want the branch's creation to be safe under concurrency, so that two builds starting at once do not race: one creates the branch and the other simply uses it.
8. As a human, I want to be refused with a specific reason if I try to activate a branch-handled spec while any of its tasks is still in `tasks/backlog/` or carries `needsAnswers: true`, so that I am forced to finish admitting and specifying the decomposition before committing it to a branch.
9. As a human, I want that entry gate to be absence-based rather than presence-based, so that a spec whose tasks were partly built on `main`, or partly cancelled, before I decided to branch can still be activated.
10. As a human, I want the entry gate checked once at activation and never again, so that a question discovered while building does not deadlock the whole line of work.
11. As a human, I want `main`-side moves (promote, clear a flag, cancel a task, re-task) to remain legal while the field is set but the branch does not yet exist, so that setting the field does not freeze the ledger before I have finished preparing it.
12. As a human, I want `promote` and `drop` on `main` to be refused for a branch-handled task once its branch exists, so that I cannot accidentally rename a file on `main` that the branch is simultaneously renaming, which would manufacture a conflict at adopt on a file nobody meaningfully edited.
13. As an autonomous runner, I want to pick a branch-handled task and build it on its branch without a human naming the branch, so that the line of work drains itself under `run`, `advance`, and `do` auto-pick.
14. As an autonomous runner, I want a branch-handled task's `blockedBy` resolved against its branch's `tasks/done/`, so that a chain of eight tasks proceeds past the first one instead of stalling because `main`'s `tasks/done/` is empty.
15. As a human reading `dorfl scan`, I want each eligibility verdict to say which base it was computed against, so that the output is unambiguous once two bases are in flight.
16. As an autonomous runner scanning a branch, I want to consider only tasks whose resolved base is that branch, so that the unrelated `main`-handled tasks the branch inherited when it was cut are never built onto it.
17. As a human, I want a task file created directly on the branch with no `spec:` to be inert rather than built somewhere wrong, so that a stray file cannot silently become work.
18. As a human, I want a chore that only makes sense inside this line of work to join it by carrying `spec: <that spec>` with `covers: []`, so that I do not need a second mechanism for chores.
19. As a reviewer, I want each branch-handled task to open a PR into its branch under the default `propose` mode, so that my review discipline is unchanged and only the target moves.
20. As a repo owner, I want an explicit way to opt a branch-handled spec into merge-mode onto its branch, so that I can let the chain drain fully autonomously and defer all review to adopt when the branch is disposable enough to earn that.
21. As a human, I want a bounced branch-handled task's question sidecar and `needsAnswers` flag written to its branch, so that the flag and the sidecar stay on one substrate and cannot tear.
22. As a human, I want `dorfl status` to aggregate questions across bases, so that a parked question on a branch-handled task is visible to someone watching `main` rather than silently invisible.
23. As a human, I want `dorfl status` to tell me how far behind `main` an active branch has fallen, so that branch lifetime is a number I can act on rather than a feeling.
24. As a human, I want the freshness report to be purely informational, so that no build is ever refused for drift the task's author did not cause.
25. As a human, I want to refresh a branch from `main` as a real land (merge in, re-verify, push) rather than a bare merge, so that the reconciled tree is proven rather than assumed.
26. As a human, I want to adopt a line of work with one command that runs the land primitive against `main`, so that the single riskiest merge of the whole exercise is gated rather than hand-run.
27. As a human, I want adopt to honour propose and merge modes, so that I can either land it inline or open one PR from the branch into `main` and review the whole thing as a unit.
28. As a human, I want adopt to clear `handledInBranch` from every spec pointing at that branch, so that no spec is left pointing at a deleted ref.
29. As a human, I want adopt to leave the work branches reapable again by the normal predicate, so that cleanup needs no special case once the work is on `main`.
30. As a human, I want abandon to cancel the line of work's tasks into `tasks/cancelled/` with a reason, clear the field, and delete the branch, so that `main` is left in an honest, in-contract state with nothing dangling.
31. As a human, I want abandoning to leave `main`'s code byte-identical to what it was before the line of work started, so that "throw it away" genuinely costs nothing.
32. As a human, I want to grow a line of work by authoring another spec on `main` with the same `handledInBranch`, so that growing it is the same move as starting it.
33. As a human, I want a line of work's membership to be derivable from `main` by grepping specs for the field, so that there is no index file to conflict on.
34. As a human, I want a spec that appears only on the branch (typically swept in by the runner's `git add -A`) to be inert and reported, so that an accident is visible without a good build being refused for it.
35. As a human, I want a crash between a branch land and the lock release to be recoverable, so that the item does not become permanently unclaimable while the tooling reports its lock as a healthy in-flight hold.
36. As a maintainer, I want the contract to state explicitly why a spec field may gate a task's build when `humanOnly` may not, so that the inheritance reads as a deliberate carve-out rather than a violated invariant.
37. As a maintainer, I want `to-spec` and `to-task` to know about the field, so that a spec can declare it at authoring time and the agent prompt can name the base it is building against.

### Autonomy notes (the two gate axes)

- **`humanOnly: true` is SET.** A human must drive the tasking of this spec. Three reasons, all about the decomposition rather than the difficulty: it changes `work/protocol/` (the contract itself), which in this repo means editing `skills/setup/protocol/` as the SOURCE and mirroring into `work/protocol/` — a two-place rule a tasker can silently miss; it touches the land primitive, which ADR `land-primitive-rebase-reverify-advance` explicitly protects from silent regression; and it contains a **must-ship-together** constraint (see Implementation Decisions) that a naive decomposition would split into a follow-up task, producing exactly the silent-dead-lock failure the constraint exists to prevent. This flag says nothing about the emitted tasks' own gates: most of them are ordinary agent-buildable work and the tasker should gate each on its own build-nature.
- **`needsAnswers` is OMITTED.** The design was resolved end-to-end in a design grill; every fork was decided and the rejected alternatives are recorded in Out of Scope with their reasons. The one unresolved item (the re-drive path) is a contained investigation with a known location, not a design fork, so it is expressed as work rather than as a blocking question.
- **`taskedAfter` is OMITTED.** The sibling spec that makes `specs/tasked/` terminal (see Out of Scope) simplifies this spec's abandon design but is not a prerequisite: abandon works either way, leaving the spec resting in `specs/tasked/`.

## Implementation Decisions

### The coherence check (this is a new named concept)

`handledInBranch` does not collide with any term in `CONTEXT.md`, `work/protocol/`, or the config keys. It is a THIRD axis, orthogonal to the two that already exist: **arbiter** answers "which remote serialises claims", **integration mode** answers "how does finished work land (propose or merge)", and `handledInBranch` answers "onto which base". None of the three re-means another.

Two glossary consequences that must be written, not left implicit:

- `CONTEXT.md` defines **work branch** as "`work/<slug>`, branched off the latest arbiter `main`". This spec changes the second half of that definition. (The first half is already stale independently: the code builds `work/<type>-<slug>` via the single constructor in `slug-namespace.ts`. Correct both.)
- The **routing-versus-autonomy carve-out.** `WORK-CONTRACT.md` states that spec and task `humanOnly` share "NO inheritance, NO propagation, and NOT EVEN A HINT". This spec introduces the first spec-to-task inheritance of something that gates a build, so the distinction must be stated: `humanOnly` answers WHETHER an agent may act, which is a per-task judgement and must not be inherited; `handledInBranch` answers WHERE the act lands, which is a property of the whole decomposition and must be inherited or the decomposition splits across bases. The existing `promptGuidance.*` inheritance is precedent for the mechanism but is explicitly scoped to nudges and "CATEGORICALLY SEPARATE from the gate family", so it does not cover this on its own.

### Base resolution

One resolver, used everywhere: a task's base is its `spec:`'s `handledInBranch`, else `main`. A task with no `spec:` always resolves to `main`. **Tasks may not carry the field directly** — inheritance only, one source of truth, and "what is in this line of work" stays derivable from `main` by two greps. A per-task base is a separate idea (Out of Scope).

The resolver is pure given the spec's frontmatter; the spec read it needs is already performed. The local and mirror spec-pool readers already parse the frontmatter of every file in `specs/tasked/` and discard all but the slug, and the spec pool is already in hand next to the task scan in the auto-pick path, so the field costs no new I/O.

### The two states, derived not recorded

- **DECLARED**: field set, branch absent. `main`-side moves stay legal; building is refused.
- **ACTIVE**: branch exists. `main` is frozen for that spec; `promote`/`drop` refused.

Derived from whether the branch exists, so there is no state field to keep consistent. This exists to dissolve an ordering race: a field that froze `main` the instant it appeared would make it impossible to promote after setting it, while promoting before setting it would leave the tasks in `main`'s pool un-fielded, where an autonomous claimer could grab one and build it on `main`.

### Activation and the entry gate

Activation is the branch's creation, at the first `do` on a branch-handled task. The gate, checked once:

> No task carrying `spec:<slug>` resides in `tasks/backlog/`, and none carries `needsAnswers: true`.

Absence-based deliberately, so a partially-built or partially-cancelled spec passes. It is the same scan `spec-complete.ts` performs (task lifecycle folders keyed on the parsed `spec:` field), asking "is this spec STARTABLE" instead of "is it COMPLETE".

Branch creation is off `<arbiter>/main` with a create-only lease (empty expected value, i.e. "the ref must be absent"), the same self-arbitrating CAS shape the claim acquire uses, and is reported loudly.

### Routing, not rejection

`do` is isolated by default (the cwd is an origin source only) and cuts its worktree from the bare hub mirror, so there is no checked-out branch that could express intent. A `--integration-base` flag would therefore have to be repeated on every invocation, making omission the default mistake. Routing makes the bare command correct everywhere.

Rejection survives in exactly two roles: an explicit flag that CONTRADICTS the resolved base (a real disagreement, surfaced loudly), and the activation gate.

### The branch is the ledger for its items

Pool residence, `tasks/done/`, `needsAnswers`, and question sidecars all live on the branch for a branch-handled item. Two alternatives were tried and fail:

- **Pool from `main`, done from the branch** yields a re-pick loop. `main` never moves its copies, so a task sits in `main`'s `tasks/ready/` and the branch's `tasks/done/` at once, and nothing rejects that: eligibility only checks whether a task's BLOCKERS are done, never whether the task itself is, and the one-slug-one-folder invariant is asserted per-ref so it does not fire across two refs.
- **Questions on `main`, the rest on the branch** tears an asserted invariant. `needsAnswers: true` if and only if an active sidecar exists is maintained by the surface persist path and violations are reported as `invariant-violation`; splitting it means either the branch-side scan re-picks a task parked for a human, or a two-substrate write that cannot be atomic.

### Enumeration is branch-side and filtered by resolved base

The branch is cut from `main`, so it carries **every** task in `main`'s pool. A naive branch-side enumeration would find unrelated `main`-handled tasks and build them onto the branch. So: when scanning branch B, consider only tasks whose resolved base is B. Enumeration must be branch-side (per the re-pick argument), which makes the filter mandatory rather than optional. A lone task on the branch with no `spec:` resolves to `main`, is filtered out, and is inert.

### Base-relative eligibility

A branch-handled task's `blockedBy` resolves against `<arbiter>/<branch>`'s `tasks/done/`. The tree-reading helper already takes a ref; what changes is that the scan holds a MAP of base to done-set rather than the single set it carries today. Cost: one extra tree read per distinct base. The pure `resolveBlockedBy` is untouched — it already takes the set as an argument.

Accepted consequence: **eligible is base-relative**, so `scan` must report which base each verdict used. This composes correctly across lines of work: a `main`-handled task blocked by a branch-handled one resolves against `main`, does not find it, and correctly stays blocked until adopt.

### Integration mode: a separate axis, default unchanged

The field does NOT imply merge-mode. `integration` still applies (default `propose`), so a branch-handled task opens a PR into its branch. The PR base becomes the resolved base — the GitHub provider already has a `base` option, documented as "The base branch PRs target", which no construction site currently sets, so this is a wire-up rather than new machinery.

A separate config key, proposed as **`branchIntegration`** (`propose | merge`), overrides the mode for branch-handled tasks only, resolved through the standard chain. It follows the `taskingIntegration` / `intakeIntegration` precedent of per-context integration overrides. **The key's NAME is a decision to ratify at review**, not a settled fact; the alternative considered was making it a second spec frontmatter field, rejected to keep one field per fact.

`originTrust: untrusted` continues to force propose, which composes cleanly: it proposes into the branch rather than into `main`.

Keeping `propose` as the default is deliberate. It makes the feature "today's exact workflow, relocated off `main`". Note the distinction from the original problem: the stall under `--propose` against `main` was STRUCTURAL (merging would move `main`, the one thing refused, so there was no path to `tasks/done/` at all), whereas waiting for a PR into the branch is PROCEDURAL (merging lands the record on the branch, `main` never moves, the chain proceeds). That is not a stall, that is review.

### Freshness is advisory

`dorfl status` reports how far behind `<arbiter>/main` an active branch is. The ahead/behind computation already exists. Purely informational; no threshold, no refusal.

Automatic refresh before each land was rejected: a task build would bounce to needs-attention for unrelated `main` traffic, which is bad failure attribution and trains people to ignore bounces.

**The refresh cannot be a rebase** — the branch carries landed work and merged PRs, so it is shared history. Refreshing means merging `main` in. This looks like it violates `CLAIM-PROTOCOL.md`'s "reconcile by REBASE, never a plain `git pull` merge", but that rule's stated reason is that a merge does not re-run `verify` on the reconciled tree; merge-plus-re-verify IS the land primitive, merge-shaped. **Write this asymmetry down** or it will read as a violated rule.

### Adopt and abandon

**Adopt** is the land primitive pointed at the branch: fetch `main`, merge the branch onto it, re-verify, push. Because `main` was genuinely frozen for that spec, its inert task copies merge cleanly (untouched on `main`, renamed to `tasks/done/` on the branch, so the merge takes the rename). It reuses the existing two-frontend shape: `--merge` lands inline, `--propose` opens one PR from the branch into `main`. Adopt is `performIntegration` pointed at a different branch, not a new primitive. Once the work is on `main`, the work branches become provably merged under the existing reap predicate, so normal reaping resumes with no special case.

**Abandon** cancels the tasks to `tasks/cancelled/` with `reason: superseded by abandoned branch <x>` and deletes the branch. The spec stays in `specs/tasked/`; it was tasked, and that is a permanent fact.

**Both must clear `handledInBranch` on every spec pointing at that branch**, not just one, since a line of work can accumulate several. Leaving a sibling pointing at a deleted branch leaves a dangling base that every later scan fails to resolve, far from its cause. This is the single most damaging thing to forget by hand, and is the main argument for these being verbs rather than a documented procedure.

### MUST SHIP TOGETHER (do not split this across a follow-up)

The lock reconciliation repair is not a nice-to-have and must land in the same slice as base-aware landing. `reconcileItemLockAgainstMain` converges a lock that outlived its leg by asking whether the item is terminal on `<arbiter>/main`. A branch-handled task that landed on its branch is NOT terminal on `main`, so a crash between the land and the release yields a dead lock that reconciliation classifies as `kept-in-flight` and `gc --ledger` reports as a HEALTHY in-flight hold rather than a reapable orphan. The item becomes permanently unclaimable and nothing says why.

Fix: the terminal probe consults the item's resolved base as well as `main`, treating terminal-on-either as terminal. When the base IS `main` the extra probe finds nothing, so the existing path stays byte-identical.

Also note the lock namespace is base-agnostic (keyed on `<type>-<slug>`), so a slug driven on `main` and on a branch contend on ONE lock. That is correct behaviour (do not build one task twice) but it is a hidden coupling between two supposedly-independent bases and belongs in the glossary.

### Surfaces that must become base-aware in this slice

The branch cut (both isolated and in-place paths, which both currently cut from `<arbiter>/main`, so there is exactly ONE base to thread and no "which branch am I on" logic to reconcile); the land rebase and its fetch refspec; the merge push refspec; the ledger publish refspec and lease; the PR base; the done-set read; the pool enumeration; `status` and `scan` (base per verdict, question aggregation, freshness); `promote` (refusal); the lock terminal probe; and the cross-repo `run` daemon, which threads the same base literal today.

## Testing Decisions

The repo's house style is real git: throwaway repos plus a local `--bare` arbiter. That is the right substrate here, because every claim in this spec is about which ref a thing lands on, and a mock cannot be wrong about that in the way a real ref can.

**The crown-jewel test, at the highest seam.** Drive a whole branch-handled spec end-to-end through the CLI against a local bare arbiter: task on `main`, activate, build a chain of at least three tasks with `blockedBy` edges, and assert that (a) each task's predecessor's code is present in the next task's tree, (b) the chain proceeds past task one without a human, and (c) **`<arbiter>/main` is byte-identical before and after**. That last assertion is the whole feature; if it can only be stated in prose, the feature is not testable.

Then abandon and re-assert `main` is untouched, and separately adopt and assert the work and all the done records arrive in one land.

**Lower seams, each with prior art in this repo:**

- **Pure resolvers.** The base resolver (task to spec to field to base) is pure given frontmatter, and tests at the same level as `eligibility.ts` and `tasking-eligibility.ts`, which are already deliberately I/O-free.
- **Ledger reads against a ref.** The tree-reading helpers already take a ref, so a repo with two refs holding different `tasks/done/` contents tests base-relative done-set resolution directly.
- **The enumeration filter.** Cut a branch from a `main` carrying several unrelated tasks and assert the branch-side scan considers only the branch-handled ones. This is the test that catches the "builds unrelated main tasks onto the branch" bug, which is the most likely serious regression.
- **The land primitive with a non-`main` base**, against a local bare arbiter with two branches: assert the rebase targets the base, the push refspec targets the base, and `main` is untouched.
- **The lock reconciliation repair.** Simulate the crash window (land on the branch, do not release) and assert reconciliation clears the lock rather than reporting `kept-in-flight`. Assert the `main`-base path is unchanged.
- **Concurrency on branch creation.** Two simultaneous first-builds; assert one creates, the other proceeds, neither fails.
- **The claim race** already has a truly-simultaneous two-agent test; extend it to cover a slug contending across two bases, since the lock namespace is shared.

**What NOT to test:** the exact wording of reports, and anything that would pin the shape of the base map rather than its behaviour. Test the external property (which ref moved, which did not), never the internal plumbing that achieves it.

## Out of Scope

Rejected during design, recorded with reasons so they are not re-proposed blind:

- **A documented manual procedure with no code change.** Disproven: the in-place path cuts from `<arbiter>/main` regardless of your checkout, so "check out the branch and drive it by hand" silently builds on the wrong base while reporting green. There is no conventional path.
- **A separate `integrationBase` config key alongside the field.** Two sources for one fact, and a flag that must agree with a field.
- **An "always branch" repo policy.** Made unnecessary by per-spec opt-in; a universal rule would coarsen cross-spec `blockedBy` granularity and cannot apply to spec-less chores anyway.
- **A task-position fence on `main`** (birth them in `tasks/backlog/`, never promote). Protection by discipline rather than mechanism; superseded by routing plus the two-phase freeze.
- **A migration convenience** (delete task files from `main`, recreate them on the branch). Evaporates, since tasking always happens on `main`. It was also not a contract transition, was destructive under concurrency, and forced a lie about tasked-ness.
- **Landing the ledger move on `main` while the code goes to the branch.** `main` would assert N tasks done whose code is not there, abandon would leave permanent false records, and it breaks the "done record lands WITH the code in one atomic revertable commit" rule.
- **Stacked branches** (each task cut from its `blockedBy` predecessor). `blockedBy` is a LIST so fan-in tasks have no defined parent, and `TASKING-PROTOCOL.md` §3a deliberately creates tasks blocked by every migrate batch. Amending one task cascades re-verifies through all successors, and the continue-detection would treat every stacked branch as ahead of `main`. It delivers none of the wants: no single branch to deploy, adopt, or delete.
- **A first-class variant or epic OBJECT.** A file listing member tasks is exactly the shared index the contract's rule 2 bans. Membership is derived instead, the same way a spec's task set is derived from each task's own `spec:` field.
- **Tasks carrying `handledInBranch` directly.** A real but separate idea: a PER-TASK base, so a single task with no spec at all could be tried on a branch ("try this one risky refactor somewhere safe"). Folding it in creates a second source for the base that must be reconciled against the spec's when both are present, and it breaks the "the decomposition is the unit" story that justifies the inheritance carve-out. Deliberately left unbuilt and unrecorded elsewhere; this entry is its durable home until someone wants it.
- **A `handle-in-branch` verb** that sets the field and checks the gate in one CAS. The DECLARED/ACTIVE split removed the ordering race that would have forced it, so hand-editing the spec is safe. An ergonomic follow-up, not a requirement.
- **A `demote` verb** (`tasks/ready → tasks/backlog`). It was needed only by the rejected migration path. It may still be independently useful — no inverse of `promote` exists — but it belongs to its own idea.
- **Making the freshness report a refusal** past a drift threshold. Deliberately deferred; informational only for now.

**A SIBLING SPEC, deliberately not folded in:** `specs/tasked/` should be terminal and the documented reopen path removed. `WORK-CONTRACT.md` forbids `specs/tasked → specs/proposed` because it "falsely un-records a tasking that really happened and ORPHANS the tasks it already emitted", then two lines later sanctions `specs/tasked → specs/ready` as "the reopen path" — and since residence IS the signal, both moves un-record tasked-ness identically. No reopen is implemented in code (the only `reopen` in the source is GitHub PR reopening), so it is a documentation change. The resolution reached during this design: tasked is terminal, and re-tasking happens IN PLACE from `specs/tasked/`, since the folder's only operational jobs are gating auto-tasking and satisfying `taskedAfter`, neither of which a human re-tasking in place disturbs. The boundary: user stories unchanged means the decomposition was wrong, so re-task in place; user stories changed means the intent moved, so mint a new spec. This is a **pre-existing contract inconsistency this work merely surfaced**, it simplifies but does not gate this spec's abandon design, and it deserves its own `to-spec` pass.

## Further Notes

**Known unresolved edge, expressed as work rather than a blocking question.** Re-driving a task that already landed on its branch looks like it misroutes. On the branch tree the slug is in `tasks/done/`, so `complete` resolves the pool and staging sources as absent and `onDone` as true, setting the stranded-done folder shape and routing into the committed-recovery tail — which decides via an ancestry check against `<arbiter>/main`, where the branch tip is not reachable, so it would likely attempt a re-push rather than returning the clean `already-integrated` no-op. This is INFERRED from reading the source, not traced to a conclusion and not tested. "Re-run a task that already landed" is a normal human action, so this wants a task of its own with the tracing as its first acceptance criterion.

**Semantic hazards to carry into the ADR this work should produce.** While a line of work is active, `main` is honest about intent and silent about progress: the spec and tasks are visible there but never advance. Doc-versus-reality drift forks, since a task on the branch is premised on branch reality. And every per-task green is green against a branch snapshot, with adopt re-exposing all of them to current `main` at once — the individually-green-collectively-broken case the land ADR names as its forward seam, with branch lifetime as the multiplier. The adopt land's re-verify is the backstop, and the freshness report is what keeps the multiplier visible.

**`spec-complete.ts` will report a branch-handled spec as incomplete until adopt**, since it counts residence in `tasks/done/` on the tree it scans. For issue-closing linkage that is arguably correct (the issue is not closed until the work is on `main`), but it should be a stated consequence rather than a surprise.

**Provenance.** This spec is the product of a design grill that walked the decision tree end to end: every fork named in Implementation Decisions, and every entry in Out of Scope, was decided there against the real code rather than assumed here. Several of those decisions REVERSED an earlier draft (a manual procedure, a separate `integrationBase` key, an always-branch policy, a task-position fence on `main`), which is why Out of Scope records the reasons rather than just the verdicts: each was rejected on evidence, and the evidence is what stops it being re-proposed.

The exploratory note this grew from has been discharged, per the contract's rule that a capture-bucket note leaves the inbox once a self-contained artifact carries its signal. This spec is that artifact and is intended to stand alone. Where it names a mechanism by IDENTIFIER rather than by file path (deliberately, per the spec template's no-stale-paths rule), the identifier is greppable in `packages/dorfl/src`.
