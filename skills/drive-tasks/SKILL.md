---
name: drive-tasks
disable-model-invocation: true
description: 'The supervised conductor: build every ready work/ task in a loop via dorfl, reviewing each diff and merging, until none can advance. Requires the dorfl CLI.'
---

# drive-tasks

**Be the conductor, not the player.** `dorfl do task:<slug> --isolated` already builds ONE task autonomously (claim → build agent → acceptance gate → optional Gate-2 review → PR) in a worktree off the arbiter. `drive-tasks` is the layer ABOVE: it looks at the _whole_ board, checks each ready task is still _fresh_, decides _what_ to build and in _what order_, drives `do` per task, then acts as a **third reviewer** (Gate-3, the conductor's own diff-vs-criteria pass — see step 4b) over each PR before merging it.

> **Invoking this skill (pi).** It is `disable-model-invocation: true`, so the model will NOT auto-load it — a human reaches for it explicitly. In pi the command form is **`/skill:drive-tasks`** (with `enableSkillCommands: true` in settings), and **arguments ARE supported** — anything after the command is appended to the skill as `User: <args>`, so `/skill:drive-tasks --merge the auth tasks` passes the run-mode + scope straight in. (If `/skill:drive-tasks` "does nothing", check `enableSkillCommands` is on and that the skill is discovered — a `drive-tasks/SKILL.md` DIRECTORY is discovered under `.agents/skills/`, but a bare root `.md` there is IGNORED.) Because pi cannot pass typed skill args, the equivalent and always-safe form is simply a normal prompt that NAMES the skill and its run parameters — "use the drive-tasks skill, `--merge`, on the backlog tasks X and Y"; that prose is read exactly like `/skill:drive-tasks --merge …`. Either way, state the run mode (Gate-2 on/off, propose vs merge) and scope in that same message so the skill need not ask (see [Autonomy](#autonomy--dont-ask-when-execution-is-fully-determined)).

It is a **methodology skill** (prose you follow), like `to-task` / `review` — NOT a runner command. **Precondition:** it drives the **`dorfl` CLI** over a repo using the **`work/` contract** — if neither is present, this skill does not apply. (It is the ONE skill that leans on the runner CLI directly; that is its job. The other skills stay protocol-native.) It composes:

- **`dorfl do task:<slug> --isolated`** — the per-task worker (build + acceptance gate + optional PR/code-review gate), run `--isolated` ALWAYS (a job worktree off the arbiter, never the human checkout). The harness, model, acceptance gate, review mode, and integration mode all come from dorfl CONFIG (per-repo / global) — do NOT hardcode them; `--isolated` is the one flag this skill pins, and any other flag (`--review`/`--merge`/…) is a user-confirmed per-run override only.
- **`review`** (`skills/review/`) — the discipline for your own diff-vs-criteria pass over each opened PR.
- **`to-task`** (`skills/to-task/`) — for the forward-note step and any re-tasking the human asks for.

It is **scoped to building ready TASKS.** The broader job — survey _everything_ (observations, ideas, specs, tasks), figure out what can advance, fill judgement gaps conversationally until new tasks are READY, then build them — is `orchestrate`, which delegates the BUILDING back to this skill. Keep `drive-tasks` focused on building ready tasks; hand the deep survey up to `orchestrate`.

## How it stalls (the stuck-set)

There is ONE loop. The skill **advances every task it can** and, whenever it hits a wall on a particular task, it does NOT halt — it records that task + its specific question in a **stuck-set** and moves to the next independent ready task (the [accumulate-don't-block rule](#the-accumulate-dont-block-rule)). Only when nothing more can advance does it deal with the stuck-set, and HERE is the only behavioural fork — it depends purely on whether a human is reachable in this session:

- **A human is present** (the normal case — you are running in their session): present the accumulated stuck-set as one [batched set of questions](#batching-the-questions), take the answers, and **continue the loop** (a task whose question is resolved becomes buildable again; one the human defers stays parked).
- **No human is reachable** (you were invoked to run unattended): do not block waiting — finish everything that can advance, then **stop and report the stuck-set** (plus the built/merged/needs-attention summary) as your result.

That is the whole difference; the loop, the selection, and the stuck-set are identical either way.

### Selection + isolation

This skill does its OWN intelligent per-task selection (graph order + freshness + diff review) and dispatches `do` **per chosen slug** — it never uses `do`'s auto-pick (that is `run`'s daemon mechanism, not a conductor's). It builds **one task at a time, end-to-end**, and it builds **`--isolated`, ALWAYS** — never in-place.

`do task:<slug> --isolated` builds in a per-job worktree off THIS repo's arbiter (the SAME isolation `run` uses), inferring the arbiter from cwd. The human checkout is **never touched**: no dirty-tree refusal, no claim/done-move churn in your tree, no entanglement with the human's (or your own) uncommitted work, no rebuild-the-dist-mid-drive dance. The conductor is a pure observer of the arbiter. (`do --remote <url>` is the same isolation against a FOREIGN repo with no checkout; `--isolated` is its same-repo sibling.)

The ONE consequence to respect: an isolated build reads the task + its `blockedBy` deps from the **arbiter's `main`**, so a **local-only / un-pushed task is INVISIBLE** to it. Do NOT fall back to in-place for such a task — **push it (and its deps) to the arbiter first** (the arbiter is the source of truth; a task that isn't on it isn't ready to drive). There is no in-place mode in this skill.

The loop, selection, freshness check, Gate-3 review, and stuck-set are exactly as described below; `--isolated` is simply the standing build mode.

## When to use vs. not

- **Use** to take a `work/tasks/ready/` from "N ready tasks" to "no ready task can advance", building + reviewing + merging each, in dependency-and-practical order; to conduct the dorfl worker through a phase of task-building; as the building engine `orchestrate` delegates to.
- **Don't** use it as the unattended daemon — that's `run` (genuine daemon parallelism, no human). `drive-tasks` is **sequential by default, one task at a time end-to-end** (it CAN parallelise deliberately in `--propose` mode over disjoint tasks — see [Parallelism](#parallelism--only-deliberately-with-care) — but never as a daemon and never in `--merge`). Don't use it to _author_ tasks from scratch (that's `to-task`), or to _task specs / triage observations / fill judgement gaps / answer scattered open questions across the whole tree_ (that's `orchestrate`). Don't use it to FORCE a blocked task — it respects the gate.

## The golden rules (do not violate)

1. **Sequential by DEFAULT (one task at a time, end-to-end: build → Gate-3 review → merge); parallelise only deliberately and with care.** The default cadence is strictly serial — land each task green before dispatching the next — so each merge unlocks the next cleanly and rebases stay trivial. Parallelism is POSSIBLE (dispatch several independent `do` jobs at once) but it is a considered opt-in, not a reflex, and it is bounded by hard rules — see [Parallelism](#parallelism--only-deliberately-with-care). The two that are NON-NEGOTIABLE: **(a) `--merge` mode is ALWAYS strictly sequential** — `--merge` integrates each task DIRECTLY into `main` with no PR, so two builds in flight race the same moving `main` and collide; in `--merge` one task must fully land before the next is dispatched, no exceptions. **(b) Never parallelise tasks that touch the SAME hot file or share un-landed scaffolding** — that is the concrete collision that bit us before (two concurrent builds fighting over `build.zig`/a shared new source file, then a rebase mess in the working tree). When in doubt, stay serial: genuine daemon-grade parallelism is `run`'s job.
2. **Never force a failed task.** A red gate / Gate-2 block / rebase conflict routes the item to needs-attention (its per-item lock is marked `state: stuck`) — leave it there, branch preserved, skip its dependents, continue with independent ready tasks, report it at the end.
3. **Capture, don't fix-in-place, off-path findings.** Spot drift outside a task's scope → write a `work/notes/observations/` note (and COMMIT + PUSH it when a later build depends on it — see rule 5), don't expand the task.
4. **You merge the approval.** GitHub refuses `gh pr review --approve` on a PR whose commits are under your own identity — so post the verdict as a PR **comment** (`gh pr comment <n> --body-file …`, lead with `APPROVE ✅` / `BLOCK`), then `gh pr merge <n> --squash --delete-branch`. The comment + merge IS the approval.
5. **Commit + PUSH your own `work/notes/observations/` notes before they need to matter.** Because builds are `--isolated` (off the arbiter), a dirty local tree does NOT block dispatch — but an un-pushed note or task is INVISIBLE to an isolated build until it lands on the arbiter. So commit your contract-native notes (append-only, low-risk) AND push them when a soon-to-build task depends on them being on `main` (e.g. a forward-note planted in a task body — step 2). Report what you committed/pushed in the summary. **What a conductor commits:** its own `work/notes/observations/` notes; a load-bearing **forward-note it plants in a task body** (step 2 — it MUST be committed to take effect before that task's `do`, and it is a small protocol-mechanical edit, not authored content); and the protocol's own moves the runner/`do`/`complete` make (claim reverts, done-moves, PR merges). It does NOT hand-author-and-commit a full spec or a fresh task SET — producing those is `to-spec`/`to-task`' job and they are left for human review. Report every commit in the summary.
6. **Accumulate, don't stall.** When ONE task is stuck or needs a judgement call, write it into the stuck-set and move to the next INDEPENDENT ready task — never block the whole loop on one item. When nothing more can advance, surface the stuck-set: ask the human if one is present, else report it. See [the rule](#the-accumulate-dont-block-rule).
7. **Never touch the target checkout; be checkout-agnostic.** Driving is a side-effect-free observation of the arbiter, so as a side-effect of driving you perform NO git mutation in the target repo's working checkout — no `git switch`/`checkout -B`/`branch -D`/`reset`/`rebase`/commit in the human's working tree. If you need a working tree for a cheap verification (e.g. re-run a task's own tests off its pushed branch), use a THROWAWAY clone / the job worktree / a temp dir — NEVER the human checkout. The human's uncommitted work and current branch are sacrosanct; leave the tree exactly as you found it. And because you need only the arbiter (a URL/remote) + `gh` + a scratch area, you can RUN FROM ANYWHERE: resolve the arbiter EXPLICITLY rather than assuming `cwd` is the repo, and if `cwd` happens to BE the human's checkout, treat it as READ-ONLY. Your own `work/notes/observations/` note commits (rule 5) go to the arbiter without dirtying the working tree. (UNLESS the human explicitly asks to drive in-place in a specific checkout.) This is the same arbiter-is-truth posture `do --remote`/`run` already use; the repeated `git rebase origin/main` reconciliations a checkout-bound drive needs are the symptom this rule removes.

## Always dispatch `dorfl do` — never hand-roll the claim/build/land

The conductor's per-task action is **`dorfl do task:<slug>` and NOTHING ELSE.** `do` owns the entire per-task mechanism: it claims the lock, spawns the build AGENT in the isolated worktree to IMPLEMENT the task, runs the acceptance gate, runs Gate-2, and integrates (PR in `--propose`, direct to `main` in `--merge`) — releasing the lock at the end. The conductor is the LAYER ABOVE that: select → dispatch `do` → Gate-3 review → merge/continue. It does NOT do `do`'s job by hand.

**The trap (observed):** a capable agent, told to "be autonomous", slides into implementing the task ITSELF — hand-editing the source in the checkout, then hand-rolling the claim/land dance with raw git (`git push` to a lock ref, manual `git mv ready→done`, manual rebase/commit/push). This is WRONG on every axis: it bypasses the isolated build (violating golden rule 7 — it mutates the human checkout, causing exactly the unstaged-changes / rebase-conflict messes that follow), it skips the gate + Gate-2 the runner would have run, it leaves stale hand-made locks, and it defeats the whole point of the conductor/worker split. **Autonomy means driving `do` to completion without pausing for permission — it does NOT mean doing `do`'s work yourself.**

Concretely:

- The ONLY way a task gets built is `dorfl do task:<slug> --isolated` (plus config/override flags). If you find yourself `write`-ing the task's source files, `git mv`-ing a task ready→done, or pushing a `refs/dorfl/lock/…` ref by hand, STOP — that is `do`'s job, undo it and dispatch `do`.
- Before the drive, CONFIRM dorfl is present and resolves the arbiter (`dorfl --version`, `dorfl config --json`, `dorfl status`/`scan`). If dorfl is genuinely absent, this skill does not apply (precondition) — say so; do not silently fall back to hand-driving.
- Reading the code to build CONTEXT (understand seams, spot drift, plant forward-notes) is right and expected. CROSSING from reading into implementing is the line you do not cross — the build agent inside `do` implements.

## Parallelism — only deliberately, with care

Sequential is the default (golden rule 1). Parallelism is a real option — the builds are `--isolated` (off the arbiter, not the human checkout), so N independent `do` jobs CAN run concurrently — but it is opt-in and fenced by these rules. Do NOT parallelise unless ALL hold:

1. **Not `--merge` mode.** `--merge` lands straight to `main` with no PR; concurrent `--merge` jobs race the moving `main`. Parallelism is only ever considered in `--propose` mode, where each task lands via its own PR and Gate-3/merge serialises the integration. In `--merge`, always strictly sequential.
2. **Genuinely independent tasks only** — no shared `blockedBy`-still-pending, and crucially **no shared hot file and no shared un-landed scaffolding.** Two tasks that both edit `build.zig`, or where task B needs a new source file task A is still creating, MUST be serialised (land A, then B rebases onto it). This exact collision — concurrent builds fighting over `build.zig` + a shared new file, then rebase/unstaged-changes chaos — is why the conservative default exists.
3. **A human explicitly wants it, or you have judged it clearly safe and say so.** State up front which tasks you are running in parallel and WHY they are safe (independent, disjoint files, propose mode); never fan out silently.
4. **Integration still serialises through Gate-3.** Even with parallel BUILDS, you review + merge PRs ONE at a time in dependency order, re-syncing between merges — so a later merge rebases cleanly on the earlier one. Parallel build, serial land.

Each parallel `do` is still a full isolated job you must track to completion, review at Gate-3, and merge; you gain wall-clock, not a relaxation of any gate or of the checkout-untouched rule. If any condition above is uncertain, fall back to serial — the cost of serial is time; the cost of a bad parallel run is a tangled working tree and wasted claims.

## The accumulate-don't-block rule

The loop's job is to **advance as much as possible**, not to halt at the first judgement call. Whenever you hit a **wall** on a task —

- it looks **stale/drifted** (the freshness check in step 1 fires),
- a **forward-note** seems needed but you're unsure it's wanted,
- a **Gate-3 review** surfaces a genuine judgement call (a maybe-blocking nit, an ambiguously-met criterion), or
- the task is otherwise ambiguous / rests on an unresolved decision

— do NOT stop the loop. **Record the item + the specific question in a STUCK-SET** (a running list you keep for the session), SKIP that task (and its dependents), and **continue with the next independent ready task.** Only when nothing more can advance do you deal with the stuck-set:

- **A human is present** → present the stuck-set as a [batched set of questions](#batching-the-questions), take answers, and resume the loop (a task whose question is resolved becomes buildable again; one the human defers stays parked).
- **No human reachable** → finish all you can, then stop and report the stuck-set (+ the built/merged/needs-attention summary) as your result; do not block waiting.

Either way the discipline is the same: do as much as can be done, then surface the residue in ONE batch — never dribble out one question at a time, never stall the whole loop on a single item.

## Autonomy — don't ask when execution is fully determined

The stuck-set exists for **genuine judgement calls** (a drifted premise, an uncertain forward-note, an ambiguously-met criterion, an unresolved fork). It is NOT a licence to ask the human to confirm things the task, the graph, and the config already answer. **When all the information needed to EXECUTE a task is known, just execute it** — do not stop to ask permission, do not narrate a plan and wait for a nod, do not re-confirm the obvious.

> **Autonomy is driving `do`, not doing `do`'s work.** Being autonomous means running the loop to completion without pausing for permission. It does NOT mean rolling up your sleeves and implementing the tasks yourself. The most common autonomy failure is exactly this over-reach: the agent, trying to be helpful, hand-writes the task's code and hand-rolls the claim/land git dance instead of dispatching `dorfl do`. Full autonomy + `dorfl do` per task are COMPLEMENTARY, not in tension — see [Always dispatch `dorfl do`](#always-dispatch-dorfl-do--never-hand-roll-the-claimbuildland).

Concretely, DEFAULT TO ACTING (no question) when:

- The task's premises still hold (step-1 freshness passes) and its acceptance criteria are clear — build it. You do not need sign-off to dispatch a ready, fresh task.
- The run mode was already stated (in the invoking message / `/skill:drive-tasks` args) or resolves cleanly from config — use it; do not re-ask propose-vs-merge or Gate-2 each task. Confirm the run mode ONCE at the start (step 4a) and only when it was NOT supplied; thereafter let config drive silently.
- Dependency order and hot-file serialisation are computable from the graph — pick the order and state it; don't ask which order.
- A needs-attention item failed for a FIXABLE reason (a bug the gate caught, a flake) — `requeue` + re-`do` is a conductor move, not a human question ([Recovering](#recovering-a-needs-attention-item-requeue)).
- A Gate-3 verdict is a CLEAR approve or CLEAR block — act on it; only a true coin-flip goes to the stuck-set.

ONLY surface a question when execution genuinely cannot proceed without a human decision — the residue defined by the [accumulate-don't-block rule](#the-accumulate-dont-block-rule). The bar is "I cannot correctly execute this without an answer", NOT "I could ask to be safe". Bias hard toward autonomous completion: run the loop to exhaustion, then surface the (hopefully small) real-judgement residue in ONE batch. A drive that asks the human to bless each obvious step has failed at being a conductor.

## Recovering a needs-attention item (requeue)

When a task has routed to needs-attention (a red gate / Gate-2 block / rebase conflict / a build-time STOP marks its per-item lock `state: stuck`), its body carries the reason and its `work/<type>-<slug>` branch is **preserved on the arbiter** — nothing is lost. Whether you can re-drive it depends on the reason:

- **A fixable problem the agent can resolve on a retry** — a real bug the gate caught, a scoping miss, a flaky-test red — is a CONDUCTOR move, not a human question. Recover it with **`dorfl requeue <slug> --arbiter origin`** (DEFAULT = keep + continue: releases the stuck lock; the body is already resting in the pool `tasks/ready/`, and the branch is left UNTOUCHED so the next claim CONTINUES from its tip). Optionally add a precise handoff with **`-m "<what to fix>"`** (appended to the body). Then `do task:<slug>` again: the re-claim CONTINUES from the kept branch, and the merged `agent-prompt-continue-context` puts the prior work + the needs-attention reason
  - your `-m` note into the agent's prompt — so it BUILDS ON the good code and fixes the gap rather than restarting.
- **A genuine human-decision block** — the task is ambiguous / drifted / rests on an unresolved fork — is NOT something a retry fixes. Leave it parked; it is a stuck-set question (ask it if a human is present, else report it). Do NOT requeue a task whose premise is wrong — re-scope it first (that is `orchestrate`/human work).
- **`requeue --reset`** (DISCARD + fresh: deletes the remote branch first, then releases the lock so the next claim starts CLEAN) is for when the kept work is worthless. It is guarded and NEVER the default — only on an explicit human call; the conductor's default recovery is keep+continue.

AFTER any requeue, re-sync (`git fetch && pull --rebase`) so the re-`do` claims off the latest main. A requeued-and-rebuilt task then flows through the normal step-4 BUILD → REVIEW → MERGE.

> **Let `do` re-drive a recovered branch — do NOT hand-roll a parallel `pr/<slug>` branch.** When a flake-recovered task's `work/<type>-<slug>` branch already holds green work but needs only a small lifecycle fixup before its PR (release the stuck lock, strip the runner's "aborted/needs-attention" commit subjects), the right move is `requeue` (keep+continue) + re-`do`: the re-claim continues from the kept branch tip and the runner ITSELF opens the PR — no manual PR at all. If you genuinely must fix up by hand, commit the fixup **ON the existing `work/<type>-<slug>` branch** and PR that branch (`gh pr create --head work/<type>-<slug>`). NEVER spin a separate `pr/<slug>` branch off `main` and re-apply the tree: it **orphans** the canonical `work/<type>-<slug>` branch on the remote (it then has to be remembered and hand-deleted — easy to miss) and **discards** the branch's real history for mere cosmetic single-commit tidiness. One branch, its own history, no orphan.

## The loop

### 0. ANALYSE the task set + dependency graph

Read every `work/tasks/ready/*.md` frontmatter (`slug`, `blockedBy`/`deps`, `needsAnswers`, `humanOnly`, `spec`, `covers`) and the `work/tasks/done/` set. Build the graph:

- **READY** = every `blockedBy` is in `work/tasks/done/` AND `needsAnswers !== true` AND `humanOnly !== true`. (BOTH gate fields exclude a task from READY: `needsAnswers` means open questions a human must answer first; `humanOnly` means a human must DRIVE it. Check BOTH in the frontmatter scan, not just `needsAnswers`. A `humanOnly` task dispatched to `do` will rightly STOP at build time, wasting a claim/surface cycle, so catch it UP FRONT.)
- **BLOCKED** = a `blockedBy` is still in the pool `tasks/ready/`, held (in-progress on its lock), or stuck (needs-attention on its lock).
- **GATED** = `needsAnswers: true` OR `humanOnly: true` (needs a human first, by question or by drive-ownership; not part of the AUTONOMOUS READY set; list it but do not AUTO-build it, even once its deps land). The agent-buildable READY set is the tasks that are neither blocked nor gated by EITHER field.
  - **"GATED" gates AUTONOMOUS SELECTION, not explicit human dispatch.** `humanOnly`/`needsAnswers` keep a task out of the set THIS LOOP (and `run`/`advance`/auto-pick) picks ON ITS OWN; they do NOT make the task unbuildable. An EXPLICIT `dorfl do task:<slug>` typed by a human (or by THIS conductor on a human's explicit instruction to build that named slug) STILL builds it — the readiness guard does not consult `humanOnly` on the human path ("a human is never bound by `humanOnly`"), and explicit dispatch drops the policy term ("the pool gates the policy, not the explicit claim"). So a `humanOnly` task is the human's to drive by NAME, never the conductor's to AUTO-select. (This is also why `humanOnly` can serve, off-label, as a "keep CI/`run` off while I drive this by hand" latch — but prefer POSITION/staging for that; see WORK-CONTRACT.md "Task `humanOnly` is NARROW".)

(A task in the STAGING slot `tasks/backlog/` is review-first, awaiting a human's promotion into the pool `tasks/ready/`; it is NOT in the READY set — surface it, don't build it.) Note which tasks **unlock the most downstream work** when they land — those go first.

> **This is the DEFAULT and it does NOT change:** the READY set is computed from the agent POOL `work/tasks/ready/`, and `work/tasks/backlog/` is review-first STAGING the conductor does NOT build (it surfaces those, it never dispatches `do` against them). Unless the caller explicitly opts into the drive-from-backlog mode below, behave exactly as documented above.

#### Opt-in: drive tasks from `tasks/backlog/` (the staging folder)

**OPT-IN ONLY — never the default.** When, and ONLY when, the **caller EXPLICITLY instructs** this skill to drive tasks from the staging folder `work/tasks/backlog/` (e.g. "drive the tasks in backlog/", "build the backlog tasks <slugs>", an explicit drive-from-backlog mode), the conductor builds those staged tasks too, using the **identical** loop, selection, freshness check, Gate-3 review, requeue recovery, and stuck-set discipline described in this whole skill — the ONLY change is WHERE the READY set is read from. Absent that explicit instruction, `tasks/backlog/` stays review-first staging you surface but do NOT build (the default above). If you are unsure whether the caller meant this, do NOT assume it — treat the staging folder as review-first and ask.

In this mode the READY computation reads **`work/tasks/backlog/`** instead of `work/tasks/ready/` (or, if the caller explicitly says to drive BOTH, the UNION of `tasks/backlog/` + `tasks/ready/`). Everything else is unchanged:

- **READY** = every `blockedBy` is in `work/tasks/done/` AND `needsAnswers !== true` AND `humanOnly !== true` — the SAME gating, just over the staging set (and, when the caller scopes the run to specific slugs, restricted to those). `blockedBy` still resolves against `work/tasks/done/` exactly as in the default; deps held in `tasks/backlog/` (or `tasks/ready/`) that are not yet `done/` are BLOCKED, so honour the same dependency ordering.
- **GATED** (`needsAnswers`/`humanOnly`) and **BLOCKED** mean exactly what they mean above; a `humanOnly`/`needsAnswers` staged task is NEVER agent-buildable here either.
- The build is the SAME `dorfl do task:<slug> --isolated --allow-backlog`, the SAME Gate-3 diff-vs-criteria review, the SAME merge-via-PR-comment, and the SAME accumulate-don't-block stuck-set. The one added flag is **`--allow-backlog`**: it widens `do`'s task resolution to also search `tasks/backlog/`, so the isolated build can resolve a staged slug. WITHOUT it, `do` searches only `tasks/ready/` + in-progress and would throw `no task '<slug>' found in work/in-progress/, work/tasks/ready/` — i.e. this opt-in mode is a spec without a mechanism unless you pass the flag. Everything else about the build (claim, lock, gate, Gate-2) is identical to driving a ready task; the staged task done-moves `tasks/backlog/ → tasks/done/` directly, because your explicit drive IS the promotion. (The staged task must be on the arbiter's `main` for the isolated build to see it — per [Selection + isolation](#selection--isolation), push it and its deps first if they are local-only.)

This mode exists so a caller who has already decided a set of staged tasks is good can have the conductor build them straight from `tasks/backlog/` without first promoting them into `tasks/ready/`. It does NOT relax the review-first nature of staging for any OTHER caller or run; it is a per-invocation, explicitly-requested override of the read location only.

**Why drive in place beats promote-then-drive (the competition window).** The obvious-but-wrong way to build a staged task is to first promote it `tasks/backlog/ → tasks/ready/`, then drive it. But `tasks/ready/` is the AGENT POOL: the instant a task lands there on the arbiter, a CI `advance` leg OR a machine-local `run` daemon can CLAIM it (both pull from `tasks-ready`). So promote-then-drive opens a **competition window** — the autonomous claimer races the human who wanted to drive the work themselves. Driving in place with `--allow-backlog` keeps the body resting in `tasks/backlog/` (never the pool), so no CI leg or `run` daemon can claim it: the human keeps sole control of the set they are driving until they decide (if ever) to promote. Staging is not only review-first admission; it is the human-control position — promotion to the pool is EXACTLY what makes an item claimable-by-anyone. So drive in place; never promote-then-drive.

### 1. CHECK freshness / up-to-dateness of each ready task

**A ready task is not necessarily a CORRECT task.** Tasks are authored ahead of time; by the time one is ready its load-bearing premises may have **drifted** — something it says is "unconsumed / not yet built / still TODO" may already have landed in `work/tasks/done/` + the code. Building a drifted task wastes a full `do` run (the build agent will rightly STOP, or worse, churn working code) — and the conductor, which sees the WHOLE graph, can catch it cheaply UP FRONT.

For each ready task, before dispatching `do`, sanity-check its premises against current reality:

- Read the task's "What to build" + any **drift-check / READ-FIRST** block (tasks often name the exact files + the premise to confirm).
- Spot-check the load-bearing claims: if it says "X has zero consumers", "Y still uses the old path", "the seam is unwired" — grep `work/tasks/done/` + `src/` to confirm that is STILL true. Recently-merged tasks are the usual culprit (a convergence that already happened, a verb already renamed, a primitive already adopted).
- Glance at `work/notes/observations/` for a `*-premise-drifted` / drift note naming this task.

If the task still holds → proceed. **If it smells stale → it's a WALL**: record it in the stuck-set with the specific premise that no longer holds + a suggested re-scope, SKIP it (per the accumulate-don't-block rule), and move on. (This catches drift cheaply up front. The build-time backstop also exists: a task that IS drifted and slips past this check makes the build agent raise a STOP — the runner routes it to needs-attention with the agent's reason, skipping the wasted gate — but catching it here saves the whole `do` run.)

This is also the natural place for a **light look-ahead**: skim `work/specs/ready/` (and, if cheap, `work/notes/observations/` + `work/notes/ideas/`) for what's coming — it informs the forward-notes in step 2. The DEEP survey-everything pass is `orchestrate`'s job, not this skill's; keep this shallow.

### 2. CHECK for forward-looking notes a soon-to-be-tasked spec will need

Before building, scan `work/specs/ready/` for a spec that will be tasked soon and whose design **depends on the shape** of tasks you're about to land (a `taskedAfter:` / "builds on the X convergence" relationship). If a ready task should carry a `> FORWARD-POINTER` note so that spec can be tasked later WITHOUT amending the spec (e.g. "keep this loop/tick separable", "keep `-n` sequential", "don't rename X — the advance migration owns it", "shape this as a named callable unit"), **add the note to the task body now** (compose `to-task`' forward-note discipline). These notes are load-bearing: they prevent the downstream spec from needing changes. A note you're CONFIDENT about: plant it and COMMIT it (it must land before that task's `do` to take effect; per rule 5 this small protocol edit is committed, unlike authored artifacts). If a note is non-trivial or you're unsure it's wanted, that is a WALL → record it in the stuck-set (surface it with the batch when the loop stalls) rather than planting a guessed note.

> This is the step that earns the conductor its keep — a per-task `do` agent only sees its own task; only the conductor sees the whole graph + the pending specs and can plant the cross-task notes.

### 3. SELECT the tasks + a practical order

From the READY set, order by: (a) **dependency** (a task that unlocks others first), then (b) **practical** concerns — serialise tasks that edit the SAME hot file (e.g. one big `cli.ts`) so rebases stay trivial; prefer the order that keeps each subsequent claim rebasing cleanly off fresh `main`. State the planned order (and why) before you start.

### 4. For EACH fresh, ready task, in order — BUILD → REVIEW → MERGE

**4a. Build it** — ALWAYS `--isolated`:

```sh
dorfl do task:<slug> --isolated
```

This dispatch IS the build — `do` runs the build agent that IMPLEMENTS the task. Do NOT implement the task yourself and do NOT hand-roll the claim/gate/land (see [Always dispatch `dorfl do`](#always-dispatch-dorfl-do--never-hand-roll-the-claimbuildland)). Dispatch ONE `do` at a time by default; only fan out to several concurrent `do` jobs when the [Parallelism](#parallelism--only-deliberately-with-care) conditions all hold (never in `--merge`).

**`--isolated` is the one flag this skill mandates. Everything else — review mode, integration mode, harness, model — is LET TO CONFIG** (resolved `flag > env > per-repo > global > default`), so do NOT hardcode `--review`/`--propose`/`--merge` here: the repo's `dorfl.json` decides, and `do --propose` is already the default. (`--isolated` reads the target repo's committed `dorfl.json` from the arbiter's main, so per-repo `harness`/`verify`/`noPR`/`review` apply automatically — no `--harness`/env workaround.) **At the START of a drive, CONFIRM the run mode with the user** — do they want Gate 2 (`--review`, off by default — the human-first family default), and propose vs merge integration? — and add `--review` / `--merge` / etc. as explicit per-run OVERRIDES only when the user asks; otherwise let config drive every build of the drive.

After a failed/aborted isolated run, a stale job worktree can linger and block the next build's mirror fetch — run `dorfl gc` (or `gc --force --yes` once you've confirmed the work is safe on the arbiter) to reap it before continuing. `gc` is **arbiter-scoped by default**: run it from inside THIS repo's checkout and it only touches THIS arbiter's worktrees, so `gc --force --yes` can never discard another repo's un-pushed work (that global blast-radius now requires an explicit, loud `--all-arbiters`). Use a **generous timeout** — `do` runs a build agent + the full gate + (if enabled) the Gate-2 review and can take well over an hour for a big task. If you interrupt it, KILL the spawned `do`/agent process tree explicitly (an abort of your wrapper does NOT stop the child); the isolated worktree is then reaped/recovered via `gc` + the kept arbiter branch (your checkout is untouched).

- **Non-zero exit** (red gate / Gate-2 block / rebase conflict) → the item is now in needs-attention (its lock is `state: stuck`) with its reason in the body and its branch preserved on the arbiter. STOP that task (golden rule 2), skip its dependents, move to the next INDEPENDENT ready task. If the reason is a FIXABLE problem (not a human-decision block), it is recoverable IN-LOOP via `requeue` + re-`do` (continues from the kept branch) — see [Recovering a needs-attention item](#recovering-a-needs-attention-item-requeue); otherwise it becomes a stuck-set question.

**4b. Gate-3 — review the opened PR yourself** (the conductor's own review, the third review layer after Gate-1 = `do`'s acceptance gate and Gate-2 = `do`'s PR/code-review gate — the discipline that makes you a real reviewer of the result, not a rubber stamp). `do` already ran Gate-1 AND Gate-2 before opening the PR, so **trust that green** — do NOT re-run the (potentially slow) acceptance gate here. Your job is the JUDGEMENT the gates can't fully do: does the diff actually deliver THIS task?

- Read the **diff against the task's acceptance criteria** — tick each criterion (apply the `review` skill's lenses + destination check).
- **Verify every drift note / forward-pointer / must-fix-before-consume** the task carried was actually honoured (these are exactly where a `do` agent silently drifts — e.g. "don't rename X", "keep it sequential", "make the omitted path REFUSE"). Grep the branch to confirm.
- Read the gate-generated `work/notes/observations/review-nits-<slug>-*.md` and triage each nit (blocking? benign? a real off-path finding worth its own observation?).
- **Verdict:** if a drift note was violated or an acceptance criterion is unmet → **BLOCK** (comment the blocking findings; do NOT merge). If it is a clear BLOCK or clear APPROVE, act on it. If it is a genuine **judgement call** (a maybe-blocking nit, an ambiguously-met criterion), that is a WALL → record it in the stuck-set and skip (do not merge on a coin-flip), per the [accumulate-don't-block rule](#the-accumulate-dont-block-rule). Otherwise **APPROVE**.

  > Dropping the Gate-3 re-verify is SOUND by default: `do`'s OWN acceptance gate runs against the merged artifact, because the `freshWorktreeGate` config (ON by default) runs `prepare`+`verify` in a CLEAN throwaway worktree cut from the work branch REBASED onto `<arbiter>/main` (the exact tree that integrates) — closing the checkout-vs-pushed-tree divergence at the root, so there is no separate per-task re-verify to re-introduce. (The opt-out `--no-fresh-worktree-gate` reverts to the old in-build-worktree pre-rebase gate, where that rare divergence is consciously accepted.)

**4c. Merge** (golden rule 4):

```sh
gh pr comment <n> --body-file /tmp/approve-<n>.md     # leads with APPROVE ✅ + per-criterion reasoning
gh pr merge <n> --squash --delete-branch
```

Use `--body-file` (PR bodies are backtick-heavy and break inline `--body` shell quoting).

> PROVIDER ASSUMPTION: the verdict-as-PR-comment + `gh pr merge` flow above assumes **`--propose` mode + a GitHub arbiter** (the only review-surface this skill knows today). In `--merge` mode `do` integrates directly with no PR — then your Gate-3 diff review still applies, but you record the verdict in the task/observation, not a PR comment, and there is nothing to `gh pr merge`. A non-GitHub arbiter has no `gh` at all. Making the approval/merge surface provider-agnostic (a likely future `dorfl` command, e.g. an `approve`/`land` verb) is NOT built yet; until then this step is GitHub-propose-specific — adapt the merge mechanics to the repo's actual integration mode.

**4d. Re-sync + re-evaluate:** recompute the READY set from the ARBITER (read-only) — `git fetch origin` and read the refreshed `origin/main` `work/` state (or use the mirror-side scan). You do NOT need to mutate a working checkout to do this:

```sh
git fetch origin   # then read origin/main's work/ state to recompute the ready set
```

Builds run `--isolated` on the arbiter, NOT your checkout, so a `git fetch` against the arbiter is all you need to RECOMPUTE the READY set — there is no local rebase dance, no branch switch, and no clean-tree precondition for the next dispatch (per golden rule 7, do not `git checkout`/`pull` INTO the human's working tree as a driving side-effect; if you are driving from a scratch clone you own, fast-forwarding IT is fine). If the next `do` runs from a BUILT copy of dorfl (e.g. a local checkout of this very repo), rebuild it so the merge you just made is in the binary the next `do` invokes. The merge landed `work/tasks/done/<slug>.md` on `main`; any task blocked only by it is now unlocked. Recompute the READY set (steps 0–1, including a fresh freshness check on newly-unlocked tasks) and continue.

### 5. CONTINUE until nothing can advance

Repeat step 4 until no ready task can advance (the READY set is empty OR every remaining ready task is parked in the stuck-set). THEN deal with the stuck-set ([the rule](#the-accumulate-dont-block-rule)): if a human is present, ask the batched questions and resume the loop from the answers; if not, report the stuck-set and stop. Once the loop is genuinely exhausted, run the end-of-drive triage (step 5.5) over the accumulated nits + observations BEFORE writing the report — any question it raises joins the same batch.

### 5.5. TRIAGE the drive's accumulated nits + observations

Step 4b triaged each task's nits **in isolation, at the moment its PR merged** — that is the right per-task gate, but it is deliberately narrow (does THIS nit block THIS PR?). It cannot see the drive as a whole. Across a multi-task drive, the nits (`work/notes/observations/review-nits-<slug>-*.md`, one set per built task) and the ad-hoc **off-path observations** you filed along the way (golden rules 3 + 5) pile up into a **residue that only makes sense read TOGETHER at the end** — a recurring nit the same shape across three PRs, a benign-in-isolation observation that is actually a real drift once you see its siblings, a cluster that adds up to a follow-up task. So before you write the report, do ONE cross-drive triage pass over the whole residue. Do it EVEN when the loop finished clean (no stuck-set): a green drive still leaves nits + observations that must be routed, not left to rot in `work/notes/observations/`.

Collect the residue, then triage each item to exactly one destination:

- **Gather** every `work/notes/observations/review-nits-<slug>-*.md` from the tasks you built this drive, plus every `work/notes/observations/*` note you filed during the drive (rule 3/5). Read them together, grouping by theme, not by task — a nit that recurs across PRs is the signal.
- **Route each item** to ONE of:
  - **Already-handled** — the nit was addressed in the merged diff (you fixed it at Gate-3, or the task did). Note it as closed; nothing to carry forward.
  - **Benign / noise** — a style preference or a false positive that is genuinely fine. Say so explicitly (so it is a decision, not an omission) and let the note rest.
  - **A real off-path finding worth its own `work/notes/observations/` note** — keep it, and COMMIT + PUSH it per rule 5 so it survives the drive and a later build can see it.
  - **A follow-up TASK** — a nit/observation that is actually work (a recurring defect, a cross-cutting cleanup a whole cluster points at). Do NOT author the task yourself (that is `to-task`/human work — golden rule 5); instead record it in the triage output as a task-worthy item with a one-line rationale, for the human (or `orchestrate`) to task.
  - **A stuck-set question** — a nit/observation whose disposition needs a human judgement call (blocking-or-not is a genuine coin-flip, or it implies a decision). Fold it into the same batched-questions surface as the loop's stuck-set (do not open a second, separate question channel).
- **Do not fix-in-place off-path here either** (golden rule 3 still holds): triage routes each item to a destination, it does not expand scope or start editing merged code. The only writes this step makes are the append-only `work/notes/observations/` note commits (rule 5) and the triage outcome fed into the report.

The outcome of this pass — what was closed, what was kept as an observation, what is task-worthy, what became a question — is a named section of the report (step 6). When a human is present and this pass raised questions, they join the stuck-set's [batched questions](#batching-the-questions); when unattended, the triage outcome is part of your reported result.

### 6. SUMMARISE — the conductor's report

End with a structured rundown (this is a first-class deliverable, not an afterthought):

- **Built + merged** — each task with its PR number + a one-line note on any drift/forward-pointer/must-fix it honoured (`do` ran the acceptance + review gates; you reviewed the diff).
- **Routed to needs-attention** — each, with the EXACT blocking reason, whether the agent produced no code vs. a real bug the gate caught, and that the branch is preserved on the arbiter (recoverable via `requeue` + re-claim, or `work-on`).
- **Still blocked / gated** — what remains and on what (a needs-attention item? a `needsAnswers` human gate?).
- **What's now UNLOCKED in the project** — new commands, new behaviours/capabilities, retired verbs, and crucially **which specs are now taskable / unblocked** by what landed (the cross-cutting view only the conductor has).
- **Observations filed** (committed as you go, per rule 5) — list them so the human can find them in `git log`.
- **Nit + observation triage** (from step 5.5) — the cross-drive disposition of every `review-nits-<slug>-*` set and every off-path observation filed this drive, grouped by theme: what was **already handled** (closed in the merged diff), what is **benign/noise** (an explicit decision, not an omission), what was **kept as an observation** (committed + pushed), what is **task-worthy** (recorded for `to-task`/the human to task, NOT authored here), and what became a **stuck-set question** (folded into the batch). A recurring nit across PRs is called out as a cluster, not repeated per task.
- **Housekeeping** — any direct-to-`main` chore commits you made (claim reverts, forward-notes), so the human can see them in `git log`.

When you run unattended (no human reachable), this report (plus the stuck-set) is your RESULT to whoever invoked you, not a message to a human.

## Batching the questions

When the loop stalls with a non-empty stuck-set, do NOT ask one question at a time. **Regroup the stuck-set into a single, well-organised batch** (the way a good conductor surfaces everything at once for one efficient answering pass):

- Group by item, each with: the task, the SPECIFIC question, why it's stuck (stale premise / uncertain forward-note / review judgement call / an end-of-drive nit-or-observation whose disposition is a genuine coin-flip — step 5.5), enough inline context to answer WITHOUT opening the file, and a **suggested default** where you have one.
- Order by leverage (a question whose answer unblocks the most downstream work first).
- If a human is present: present the batch, take answers, resume the loop (resolved → buildable again; deferred → stays parked). If not: this batch is the residue you report and stop on.

The batch is conversational (asked) or reported (unattended), not a written file.

## Beyond tasks

This skill builds READY TASKS. Two things sit ABOVE it, sharing its loop shape:

- **`orchestrate`** — the human-in-the-loop META conductor: surveys _everything_ (observations / ideas / specs / tasks), advances what it can (tasking specs, triaging), fills judgement gaps with the human conversationally until new tasks are READY, then **delegates the building to THIS skill** and surfaces the stuck-set to the human.
- **`advance`** — the AUTONOMOUS, file-mediated version of the same idea, driven by `run`/CI with a `work/questions/` sidecar. `drive-tasks` + `orchestrate` are the human-agency, synchronous siblings of `advance`; they share the same tick contract.

The conductor is **tick-agnostic**: today the per-item action is `dorfl do task:<slug>` (build a task); as `advance`-class ticks land (task / triage / surface / apply), the SAME loop applies — only the per-item command in step 4a changes. (Mirrors the loop/tick split in `run`: the conductor is a _loop_; the per-item command is the _tick_.)

## Pitfalls

- **The interrupt footgun.** Aborting your `do` wrapper does NOT kill the spawned agent — it keeps editing files in the background. After any interrupt, `ps`-find + kill the `do`/agent/`tsc` tree, discard its partial edits, and release the claim (the runner reverts the lock; the body is already resting in the pool `tasks/ready/`) before redoing.
- **Flaky tests red a good gate.** If a task's gate fails ONLY on a known-flaky test with everything else green, re-run before treating it as a real block (and the flake itself is a `notes/observations/` note, not a task fix).
- **A `do` that delivers no code is NOT a success** (nothing changed → the gate passes vacuously). The runner catches this two ways — an agent STOP (drift) routes to needs-attention before the gate, and Gate-2 (plus your Gate-3) check the _diff against the criteria_, not just the gate. Trust the block; never merge an empty-or-criteria-unmet diff.
- **Don't sum two freshness models.** When reporting cross-repo + local state, keep them distinct.
