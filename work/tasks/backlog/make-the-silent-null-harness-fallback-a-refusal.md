---
title: 'Make the silent `?? new NullHarness()` harness fallback a refusal, not a no-agent default'
slug: make-the-silent-null-harness-fallback-a-refusal
spec: dorfl
blockedBy: []
covers: []
---

## What to build

Four production sites construct the harness with `options.harness ?? new NullHarness()` and then proceed to run a build/decide/launch as if a usable agent were attached:

- `packages/dorfl/src/do.ts:1990` (`runDoAgent`)
- `packages/dorfl/src/apply-decide.ts:262`
- `packages/dorfl/src/intake.ts:1945`
- `packages/dorfl/src/intake.ts:2341`

A `NullHarness` is a real, runnable adapter — it shells out to `agentCmd` — so the `??` is silent only when `agentCmd` is empty too, which is exactly the `harness: pi`-intended shape. On the CLI this never bites: `doNeedsAgentCmd` (`packages/dorfl/src/do-config.ts`) refuses loudly before any git transition whenever `harness !== 'pi'` and `agentCmd` is empty, and every CLI path builds the harness via `createHarness` and threads it. The `??` is therefore a fallback only for LIBRARY/embedding callers (and tests) that call `performDo` / `performIntake` / the apply decider WITHOUT supplying `harness` OR a non-empty `agentCmd`.

Today such a caller silently builds with no usable agent: it claims the lock, onboards the worktree (on the `do` path), and only then discovers it has nothing to run — the exact shape the `--watch` guard already refuses at `packages/dorfl/src/do.ts:914` ("no claim, no branch", BEFORE any git transition). The silent default is the wrong posture for a seam: a build path with no usable agent should refuse before it claims, exactly as `--watch` does and as `doNeedsAgentCmd` does for the CLI.

Replace the silent `?? new NullHarness()` with a refusal when the resolved harness would be the null adapter AND there is no non-empty `agentCmd` to shell out to. Keep the NullHarness itself usable when a caller genuinely wants it (an explicit `harness: new NullHarness()` paired with an `agentCmd`), so this is about the UNRESOLVED-then-defaulted case, not about disabling the adapter.

This is the one live residue of the `deadline-reap-lets-node-exit-0-before-the-checkpoint-runs` investigation: it was NOT the cause of that incident (a real `PiHarness` ran), but it is the same class of silent-default that misdirected the diagnosis, and it remains a genuine latent hazard for non-CLI callers.

## Acceptance criteria

- [ ] Each of the four `?? new NullHarness()` sites refuses loudly when the resolved harness would be a `NullHarness` (or `undefined`) AND `agentCmd` resolves to empty — BEFORE any git transition / claim / onboarding — mirroring the `do.ts:914` `--watch` guard's "no claim, no branch" stance.
- [ ] A caller that EXPLICITLY passes a `NullHarness` with a non-empty `agentCmd` still works (the adapter remains usable when deliberately chosen).
- [ ] The CLI paths are unchanged (`doNeedsAgentCmd` already refuses earlier; the new guard is a no-op there and must not double-fire or change messages).
- [ ] Tests: a library/embedding call with no `harness` and empty `agentCmd` is refused before any worktree/claim side-effect, on each of the four paths; an explicit `NullHarness` + `agentCmd` still runs; the CLI path is unchanged (the existing `doNeedsAgentCmd` tests stay green).

## Blocked by

- None — can start immediately. Independent of the already-landed `runner-must-not-exit-between-the-agent-and-its-outcome` and `do-job-record-finalises-with-real-harness-and-outcome` fixes; same area, different defect.

## Prompt

> In `packages/dorfl/`, the four `options.harness ?? new NullHarness()` sites (`do.ts:1990`, `apply-decide.ts:262`, `intake.ts:1945`, `intake.ts:2341`) silently build with no usable agent when a library/embedding caller supplies neither a `harness` nor a non-empty `agentCmd`. The CLI is already covered by `doNeedsAgentCmd` (`do-config.ts`), which refuses earlier; `--watch` already refuses the analogous case at `do.ts:914` BEFORE any git transition ("no claim, no branch"). Make the UNRESOLVED-then-defaulted case a refusal in the same stance: when the resolved harness would be the null adapter and `agentCmd` is empty, refuse before claiming/onboarding, mirroring `do.ts:914`. Do NOT disable the `NullHarness` adapter itself — an explicit `NullHarness` paired with a non-empty `agentCmd` must still run. Reuse `doNeedsAgentCmd` / `NO_AGENT_CMD_MESSAGE` so the message matches. TDD with vitest: each of the four paths refuses with no side-effects when no harness and empty `agentCmd`; an explicit `NullHarness` + `agentCmd` still runs; the CLI path is unchanged (the existing `doNeedsAgentCmd` tests stay green). Match house style. "Done" = acceptance criteria met and `pnpm -r build && pnpm -r test && pnpm -r format:check` green. READ FIRST: `work/notes/observations/deadline-reap-lets-node-exit-0-before-the-checkpoint-runs.md` (the one live residue), the `--watch` guard at `do.ts:914`, and `do-config.ts`'s `doNeedsAgentCmd`.