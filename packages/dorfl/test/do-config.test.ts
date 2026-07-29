import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {rmrf} from './helpers/gitRepo.js';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mergeConfig} from '../src/config.js';
import {resolveRepoConfig} from '../src/repo-config.js';
import {
	doFlagOverrides,
	doNeedsAgentCmd,
	NO_AGENT_CMD_MESSAGE,
	noPRFlagOverrides,
	shouldFailProposePrIntent,
	PROPOSE_PR_INTENT_GH_UNAVAILABLE_MESSAGE,
} from '../src/do-config.js';

/**
 * The `do-threads-harness-flags` task: `do` DECLARES `--harness`,
 * `--agent-cmd`, `--pi-bin`, `--model` but its action used to pass ONLY
 * `{integration}` to {@link resolveRepoConfig}, silently dropping the rest — so
 * `do --harness pi` was ignored and `do` wrongly demanded `agentCmd`.
 *
 * These tests pin the FIX: the `do` flags fold into the SAME flag-override
 * `PartialConfig` `run` uses (via {@link doFlagOverrides}, which reuses
 * `runFlagOverrides`'s per-key mapping) and resolve through the SAME precedence
 * chain (flag > env > per-repo > global > default), AND the no-config
 * null-default guard ({@link doNeedsAgentCmd}) still fires.
 */

let repo: string;
beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), 'dorfl-do-config-'));
});
afterEach(() => {
	rmrf(repo);
});

describe('doFlagOverrides — folds the do CLI flags into a PartialConfig', () => {
	it('maps --harness pi into the overrides', () => {
		const overrides = doFlagOverrides({harness: 'pi'});
		expect(overrides.harness).toBe('pi');
	});

	it('maps --agent-cmd / --pi-bin / --model / --build-model', () => {
		const overrides = doFlagOverrides({
			harness: 'null',
			agentCmd: 'run-agent --slug',
			piBin: '/opt/pi',
			model: 'anthropic/x',
			buildModel: 'anthropic/build',
		});
		expect(overrides.harness).toBe('null');
		expect(overrides.agentCmd).toBe('run-agent --slug');
		expect(overrides.piBin).toBe('/opt/pi');
		expect(overrides.model).toBe('anthropic/x');
		expect(overrides.buildModel).toBe('anthropic/build');
	});

	it('folds the integrate-time mode in (so {integration} is NOT lost)', () => {
		expect(doFlagOverrides({}, 'merge').integration).toBe('merge');
		expect(doFlagOverrides({}, 'propose').integration).toBe('propose');
		// No flag mode ⇒ integration is left to per-repo/global/default.
		expect(doFlagOverrides({}).integration).toBeUndefined();
	});

	it('an explicit --merge/--propose ALSO sets `taskingIntegration` so the typed flag wins for the TASKING transition too', () => {
		// `per-transition-integration-mode-slicing-vs-build`: the flag is
		// transition-AGNOSTIC (each command runs ONE transition), so it must override
		// BOTH the build mode (`integration`) AND the tasking mode (`taskingIntegration`,
		// which the tasking caller reads as `taskingIntegration ?? integration`).
		// Otherwise a `--propose` on a `taskingIntegration:'merge'` repo would be
		// shadowed by the config override.
		expect(doFlagOverrides({}, 'merge').taskingIntegration).toBe('merge');
		expect(doFlagOverrides({}, 'propose').taskingIntegration).toBe('propose');
		// No flag mode ⇒ `taskingIntegration` is left to per-repo/global (and then
		// falls back to `integration`) — the flag-override layer adds NOTHING.
		expect(doFlagOverrides({}).taskingIntegration).toBeUndefined();
	});

	it('sets only what was passed (absent flags ⇒ absent keys)', () => {
		const overrides = doFlagOverrides({});
		expect(overrides.harness).toBeUndefined();
		expect(overrides.agentCmd).toBeUndefined();
		expect(overrides.piBin).toBeUndefined();
		expect(overrides.model).toBeUndefined();
		expect(overrides.integration).toBeUndefined();
		expect(overrides.selectionOrder).toBeUndefined();
	});

	it('maps --selection-order: a preset keyword stays a string', () => {
		expect(doFlagOverrides({selectionOrder: 'groom'}).selectionOrder).toBe(
			'groom',
		);
	});

	it('maps --selection-order: a comma form becomes a trimmed list (explicit order)', () => {
		expect(
			doFlagOverrides({selectionOrder: 'build, task ,surface,triage'})
				.selectionOrder,
		).toEqual(['build', 'task', 'surface', 'triage']);
	});

	it('maps --observation-triage: each valid enum value', () => {
		expect(doFlagOverrides({observationTriage: 'off'}).observationTriage).toBe(
			'off',
		);
		expect(doFlagOverrides({observationTriage: 'ask'}).observationTriage).toBe(
			'ask',
		);
		expect(doFlagOverrides({observationTriage: 'auto'}).observationTriage).toBe(
			'auto',
		);
		// absent flag ⇒ absent key (lower layers / default decide).
		expect(doFlagOverrides({}).observationTriage).toBeUndefined();
	});

	it('--observation-triage FAILS LOUDLY on an invalid value (naming the flag + options)', () => {
		expect(() => doFlagOverrides({observationTriage: 'maybe'})).toThrow(
			/--observation-triage/,
		);
		expect(() => doFlagOverrides({observationTriage: 'maybe'})).toThrow(
			/off.*ask.*auto/,
		);
		// the old boolean values are NOT silently accepted (no boolean→enum alias).
		expect(() => doFlagOverrides({observationTriage: 'true'})).toThrow(
			/--observation-triage/,
		);
	});

	it('maps --surface-blockers / --no-surface-blockers (the boolean blocked-work gate)', () => {
		expect(doFlagOverrides({surfaceBlockers: true}).surfaceBlockers).toBe(true);
		expect(doFlagOverrides({surfaceBlockers: false}).surfaceBlockers).toBe(
			false,
		);
		// absent flag ⇒ absent key (lower layers / default decide).
		expect(doFlagOverrides({}).surfaceBlockers).toBeUndefined();
	});
});

describe('do — flags resolve through resolveRepoConfig (the bug fix)', () => {
	it('do --harness pi resolves the pi adapter (no agentCmd demanded)', () => {
		const resolved = resolveRepoConfig({
			repoPath: repo,
			global: mergeConfig({}),
			flags: doFlagOverrides({harness: 'pi'}),
		});
		expect(resolved.config.harness).toBe('pi');
		// pi adapter does not consume agentCmd ⇒ the null-default guard must NOT fire.
		expect(doNeedsAgentCmd(resolved.config)).toBe(false);
	});

	it('do --harness null --agent-cmd <cmd> resolves the null adapter with that command', () => {
		const resolved = resolveRepoConfig({
			repoPath: repo,
			global: mergeConfig({}),
			flags: doFlagOverrides({harness: 'null', agentCmd: 'my-agent {model}'}),
		});
		expect(resolved.config.harness).toBe('null');
		expect(resolved.config.agentCmd).toBe('my-agent {model}');
		expect(doNeedsAgentCmd(resolved.config)).toBe(false);
	});

	it('--pi-bin and --model flags take effect on the resolved config', () => {
		const resolved = resolveRepoConfig({
			repoPath: repo,
			global: mergeConfig({}),
			flags: doFlagOverrides({
				harness: 'pi',
				piBin: '/custom/pi',
				model: 'routing/intent',
			}),
		});
		expect(resolved.config.piBin).toBe('/custom/pi');
		expect(resolved.config.model).toBe('routing/intent');
	});

	it('the flags fold through the SAME chain run/complete use (flag > env > per-repo > global > default)', () => {
		// global sets harness pi; a --harness null flag must WIN (flag > global).
		const resolved = resolveRepoConfig({
			repoPath: repo,
			global: mergeConfig({harness: 'pi', model: 'global/m'}),
			env: {DORFL_MODEL: 'env/m'},
			flags: doFlagOverrides({harness: 'null', agentCmd: 'c', model: 'flag/m'}),
		});
		expect(resolved.config.harness).toBe('null');
		// flag beats env beats global for model too.
		expect(resolved.config.model).toBe('flag/m');
	});
});

describe('do — null-default guard (no regression)', () => {
	it('with NO harness flags + NO config the null-default guard STILL fires', () => {
		const resolved = resolveRepoConfig({
			repoPath: repo,
			global: mergeConfig({}),
			// Inject an empty env so an ambient DORFL_* (e.g. a runner that
			// exports DORFL_HARNESS) cannot perturb this no-config assertion.
			env: {},
			flags: doFlagOverrides({}),
		});
		// Default harness is the null adapter (unset, ≠ 'pi') and agentCmd is empty
		// ⇒ the guard demands agentCmd.
		expect(resolved.config.harness).not.toBe('pi');
		expect(resolved.config.agentCmd.trim()).toBe('');
		expect(doNeedsAgentCmd(resolved.config)).toBe(true);
	});
});

describe('NO_AGENT_CMD_MESSAGE — the shared up-front refusal message', () => {
	it('names the --harness pi escape hatch (alongside setting harness/agentCmd)', () => {
		// The message `do`/`run`/`--remote` all emit must point at BOTH escape
		// hatches: the pi adapter (no agentCmd needed) and config.
		expect(NO_AGENT_CMD_MESSAGE).toContain('--harness pi');
		expect(NO_AGENT_CMD_MESSAGE).toMatch(/harness\/agentCmd|harness.*agentCmd/);
	});
});

describe('noPRFlagOverrides — the --no-pr PR-INTENT flag mapping', () => {
	it('maps `--no-pr` (commander `pr === false`) to `noPR: true`', () => {
		expect(noPRFlagOverrides({pr: false})).toEqual({noPR: true});
	});
	it('absent `--no-pr` contributes NO key (the lower layer decides)', () => {
		expect(noPRFlagOverrides({})).toEqual({});
		// `pr === true` (no `--no-pr` passed) is also a no-op — only `--no-pr` sets it.
		expect(noPRFlagOverrides({pr: true})).toEqual({});
	});
	it('rides the SAME flag-override chain via doFlagOverrides', () => {
		expect(doFlagOverrides({pr: false})).toMatchObject({noPR: true});
	});
});

describe('shouldFailProposePrIntent — the up-front PR-intent guard decision', () => {
	const base = {
		mode: 'propose' as const,
		arbiterIsGitHub: true,
		noPR: undefined,
		ghCanOpenPr: () => false,
	};

	it('FIRES: propose + GitHub arbiter + noPR unset + probe says gh cannot open a PR', () => {
		expect(shouldFailProposePrIntent(base)).toBe(true);
	});

	it('does NOT fire when the probe PASSES (ambient gh auth — absent identity OK)', () => {
		// The CRITICAL case: NO `providers.github` identity but `gh` is ambiently
		// authed ⇒ the probe passes ⇒ the guard must NOT fire (working setups proceed).
		expect(shouldFailProposePrIntent({...base, ghCanOpenPr: () => true})).toBe(
			false,
		);
	});

	it('does NOT fire in merge mode (merge never opens a PR)', () => {
		expect(shouldFailProposePrIntent({...base, mode: 'merge'})).toBe(false);
	});

	it('does NOT fire on a non-GitHub arbiter (no PR is possible there)', () => {
		expect(shouldFailProposePrIntent({...base, arbiterIsGitHub: false})).toBe(
			false,
		);
	});

	it('does NOT fire when noPR is true (no PR is intended — the suppress-PR case)', () => {
		expect(shouldFailProposePrIntent({...base, noPR: true})).toBe(false);
	});

	it('the message names every real fix (gh auth / providers.github token / --merge / --no-pr)', () => {
		expect(PROPOSE_PR_INTENT_GH_UNAVAILABLE_MESSAGE).toMatch(/gh auth login/);
		expect(PROPOSE_PR_INTENT_GH_UNAVAILABLE_MESSAGE).toMatch(
			/providers\.github/,
		);
		expect(PROPOSE_PR_INTENT_GH_UNAVAILABLE_MESSAGE).toMatch(/--merge/);
		expect(PROPOSE_PR_INTENT_GH_UNAVAILABLE_MESSAGE).toMatch(/--no-pr/);
	});
});
