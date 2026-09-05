import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
	parseFrontmatter,
	resolveClosingIssue,
	setFrontmatterMarker,
	setNeedsAnswersMarker,
} from '../src/frontmatter.js';

describe('parseFrontmatter', () => {
	it('extracts slug, humanOnly, needsAnswers and blockedBy from a full frontmatter block', () => {
		const md = [
			'---',
			'title: Some Title',
			'slug: my-task',
			'spec: my-spec',
			'humanOnly: true',
			'needsAnswers: true',
			'blockedBy: [foo, bar]',
			'---',
			'',
			'## What to build',
			'body text here',
		].join('\n');
		const fm = parseFrontmatter(md);
		expect(fm.slug).toBe('my-task');
		expect(fm.spec).toBe('my-spec');
		expect(fm.humanOnly).toBe(true);
		expect(fm.needsAnswers).toBe(true);
		expect(fm.blockedBy).toEqual(['foo', 'bar']);
	});

	it('treats humanOnly: true as the human-only gate', () => {
		const md = ['---', 'slug: a', 'humanOnly: true', '---'].join('\n');
		expect(parseFrontmatter(md).humanOnly).toBe(true);
	});

	it('treats omitted humanOnly as undefined (undeclared)', () => {
		const md = ['---', 'slug: a', 'blockedBy: []', '---'].join('\n');
		expect(parseFrontmatter(md).humanOnly).toBeUndefined();
	});

	it('parses needsAnswers: true as the discovered axis', () => {
		const md = ['---', 'slug: a', 'needsAnswers: true', '---'].join('\n');
		expect(parseFrontmatter(md).needsAnswers).toBe(true);
	});

	it('treats omitted needsAnswers as undefined (undeclared)', () => {
		const md = ['---', 'slug: a', '---'].join('\n');
		expect(parseFrontmatter(md).needsAnswers).toBeUndefined();
	});

	it('parses needsAnswers: false as false (not gated)', () => {
		const md = ['---', 'slug: a', 'needsAnswers: false', '---'].join('\n');
		expect(parseFrontmatter(md).needsAnswers).toBe(false);
	});

	it('returns empty blockedBy when blockedBy is omitted', () => {
		const md = ['---', 'slug: a', '---'].join('\n');
		expect(parseFrontmatter(md).blockedBy).toEqual([]);
	});

	it('returns empty blockedBy for an empty inline list', () => {
		const md = ['---', 'slug: a', 'blockedBy: []', '---'].join('\n');
		expect(parseFrontmatter(md).blockedBy).toEqual([]);
	});

	it('strips a trailing inline `# comment` on an EMPTY inline blockedBy (the shipped template style)', () => {
		// `blockedBy: [] # startable now` is the documented house style in
		// task-template.md / WORK-CONTRACT.md. The comment must NOT leak into the
		// list as a phantom dependency (which silently marks the task ineligible /
		// un-enumerated by the autonomous runner).
		const md = ['---', 'slug: a', 'blockedBy: [] # startable now', '---'].join(
			'\n',
		);
		expect(parseFrontmatter(md).blockedBy).toEqual([]);
	});

	it('strips a trailing inline `# comment` on a NON-empty inline blockedBy', () => {
		const md = [
			'---',
			'slug: a',
			'blockedBy: [foo, bar] # gated on these',
			'---',
		].join('\n');
		expect(parseFrontmatter(md).blockedBy).toEqual(['foo', 'bar']);
	});

	it('strips a trailing inline `# comment` on an inline taskedAfter list', () => {
		const md = [
			'---',
			'slug: a',
			'taskedAfter: [x] # taskable after x',
			'---',
		].join('\n');
		expect(parseFrontmatter(md).taskedAfter).toEqual(['x']);
	});

	it('does NOT treat a `#` INSIDE a quoted slug as a comment delimiter', () => {
		// A `#` within a quoted list item is data, not a comment start.
		const md = [
			'---',
			'slug: a',
			"blockedBy: ['has#hash', plain] # real comment",
			'---',
		].join('\n');
		expect(parseFrontmatter(md).blockedBy).toEqual(['has#hash', 'plain']);
	});

	it('parses a block-style (multi-line) blockedBy list', () => {
		const md = [
			'---',
			'slug: a',
			'blockedBy:',
			'  - foo',
			'  - bar',
			'---',
		].join('\n');
		expect(parseFrontmatter(md).blockedBy).toEqual(['foo', 'bar']);
	});

	it('does NOT match the legacy snake_case blocked_by key', () => {
		const md = ['---', 'slug: a', 'blocked_by: [foo, bar]', '---'].join('\n');
		expect(parseFrontmatter(md).blockedBy).toEqual([]);
	});

	it('parses prd-level taskedAfter (inline list)', () => {
		const md = [
			'---',
			'slug: my-prd',
			'taskedAfter: [other-prd, third-prd]',
			'---',
		].join('\n');
		expect(parseFrontmatter(md).taskedAfter).toEqual([
			'other-prd',
			'third-prd',
		]);
	});

	it('parses a block-style taskedAfter list', () => {
		const md = [
			'---',
			'slug: my-prd',
			'taskedAfter:',
			'  - other-prd',
			'  - third-prd',
			'---',
		].join('\n');
		expect(parseFrontmatter(md).taskedAfter).toEqual([
			'other-prd',
			'third-prd',
		]);
	});

	it('returns empty taskedAfter when omitted', () => {
		const md = ['---', 'slug: my-prd', '---'].join('\n');
		expect(parseFrontmatter(md).taskedAfter).toEqual([]);
	});

	it('the HARD CUTOVER: the pre-rename `brief:` and `briefAfter:` keys are NOT parsed (no old field name)', () => {
		const md = [
			'---',
			'slug: my-task',
			'brief: old-parent',
			'briefAfter: [old-dep]',
			'---',
		].join('\n');
		const fm = parseFrontmatter(md);
		// The old keys are inert text now — neither maps to the new fields.
		// (`spec:` / `taskedAfter:` are the LIVE keys.)
		expect(fm.spec).toBeUndefined();
		expect(fm.taskedAfter).toEqual([]);
	});

	// ── Origin-trust PROVENANCE (task untrusted-origin-forces-build-propose) ────
	// The stamp that survives the PRD/task merge boundary: how the artifact was
	// born + the author-trust verdict at birth. UNSET ⇒ human/trusted (the normal
	// path, zero behaviour change).

	it('parses origin: issue + originTrust: untrusted (the stamped front-door path)', () => {
		const md = [
			'---',
			'title: From a public issue',
			'slug: from-issue',
			'origin: issue',
			'originTrust: untrusted',
			'---',
		].join('\n');
		const fm = parseFrontmatter(md);
		expect(fm.origin).toBe('issue');
		expect(fm.originTrust).toBe('untrusted');
	});

	it('parses originTrust: trusted', () => {
		const md = [
			'---',
			'slug: a',
			'origin: issue',
			'originTrust: trusted',
			'---',
		].join('\n');
		const fm = parseFrontmatter(md);
		expect(fm.origin).toBe('issue');
		expect(fm.originTrust).toBe('trusted');
	});

	it('treats OMITTED origin/originTrust as undefined (⇒ human/trusted, the unset default)', () => {
		// The normal human-authored / local path: NO stamp ⇒ both undefined, which the
		// build transition reads as trusted (zero behaviour change).
		const md = ['---', 'slug: a', 'blockedBy: []', '---'].join('\n');
		const fm = parseFrontmatter(md);
		expect(fm.origin).toBeUndefined();
		expect(fm.originTrust).toBeUndefined();
	});

	it('reads an UNKNOWN origin/originTrust value as undefined (fail-safe to the default)', () => {
		const md = [
			'---',
			'slug: a',
			'origin: nonsense',
			'originTrust: maybe',
			'---',
		].join('\n');
		const fm = parseFrontmatter(md);
		expect(fm.origin).toBeUndefined();
		expect(fm.originTrust).toBeUndefined();
	});

	it('reads a full prd frontmatter block (humanOnly/needsAnswers/taskedAfter)', () => {
		const md = [
			'---',
			'title: Historical Store',
			'slug: historical-store',
			'humanOnly: true',
			'needsAnswers: true',
			'taskedAfter: [foundations]',
			'---',
		].join('\n');
		const fm = parseFrontmatter(md);
		expect(fm.slug).toBe('historical-store');
		expect(fm.humanOnly).toBe(true);
		expect(fm.needsAnswers).toBe(true);
		expect(fm.taskedAfter).toEqual(['foundations']);
	});

	it('parses a prd-only `issue: N` link as a number (intake prd-emit)', () => {
		// `intake`'s prd outcome writes `issue: N` on `work/prds/ready/<slug>.md` so the close
		// JOB can reach it via `task.prd: → prd issue:`. It must be machine-readable.
		const md = [
			'---',
			'title: Some Feature',
			'slug: some-feature',
			'issue: 42',
			'---',
		].join('\n');
		const fm = parseFrontmatter(md);
		expect(fm.issue).toBe(42);
	});

	it('parses a lone-task `issue: N` link as a number (intake TASK-emit, no prd:)', () => {
		// `intake`'s TASK outcome writes `issue: N` on the lone `work/tasks/ready/<slug>.md`
		// (no `prd:`) as the provider-agnostic closure link a future CI close-job reads.
		const md = [
			'---',
			'title: Fix the thing',
			'slug: fix-the-thing',
			'issue: 7',
			'covers: []',
			'---',
		].join('\n');
		const fm = parseFrontmatter(md);
		expect(fm.issue).toBe(7);
		expect(fm.spec).toBeUndefined();
	});

	it('treats omitted `issue:` as undefined (every non-intake prd and most tasks)', () => {
		const md = ['---', 'slug: a', 'prd: my-prd', '---'].join('\n');
		expect(parseFrontmatter(md).issue).toBeUndefined();
	});

	it('treats a non-integer / non-positive `issue:` value as undefined (absent, not malformed)', () => {
		for (const bad of ['issue: not-a-number', 'issue: 0', 'issue: -3']) {
			const md = ['---', 'slug: a', bad, '---'].join('\n');
			expect(parseFrontmatter(md).issue).toBeUndefined();
		}
	});

	it('ignores a stale `tasked:` line (the marker was removed in remove-sliced-marker-step-b)', () => {
		// `tasked:` is no longer a parsed frontmatter axis — tasked-ness is RESIDENCE in
		// `work/prds/tasked/`. A leftover `tasked:` line is just inert text the parser
		// neither recognises nor trips over.
		const md = ['---', 'slug: my-prd', 'tasked: 2026-06-03', '---'].join('\n');
		const fm = parseFrontmatter(md);
		expect(fm.slug).toBe('my-prd');
		expect('tasked' in fm).toBe(false);
	});

	it('strips quotes from quoted scalar values', () => {
		const md = ['---', "slug: 'quoted-slug'", 'humanOnly: "true"', '---'].join(
			'\n',
		);
		const fm = parseFrontmatter(md);
		expect(fm.slug).toBe('quoted-slug');
		expect(fm.humanOnly).toBe(true);
	});

	it('strips quotes from items in inline lists', () => {
		const md = ['---', 'slug: a', 'blockedBy: [\'foo\', "bar"]', '---'].join(
			'\n',
		);
		expect(parseFrontmatter(md).blockedBy).toEqual(['foo', 'bar']);
	});

	it('returns undefined slug when there is no frontmatter block', () => {
		const md = '# just a heading\n\nno frontmatter';
		const fm = parseFrontmatter(md);
		expect(fm.slug).toBeUndefined();
		expect(fm.humanOnly).toBeUndefined();
		expect(fm.needsAnswers).toBeUndefined();
		expect(fm.blockedBy).toEqual([]);
		expect(fm.taskedAfter).toEqual([]);
	});

	it('ignores keys appearing after the frontmatter block', () => {
		const md = [
			'---',
			'slug: a',
			'---',
			'',
			'humanOnly: true',
			'blockedBy: [should-be-ignored]',
		].join('\n');
		const fm = parseFrontmatter(md);
		expect(fm.humanOnly).toBeUndefined();
		expect(fm.blockedBy).toEqual([]);
	});

	it('handles CRLF line endings', () => {
		const md = ['---', 'slug: crlf', 'humanOnly: true', '---', 'body'].join(
			'\r\n',
		);
		const fm = parseFrontmatter(md);
		expect(fm.slug).toBe('crlf');
		expect(fm.humanOnly).toBe(true);
	});

	describe('promptGuidance.testFirst per-item override', () => {
		it('defaults to undefined when omitted (⇒ inherit the next layer)', () => {
			const md = ['---', 'slug: a', '---'].join('\n');
			expect(parseFrontmatter(md).promptGuidance.testFirst).toBeUndefined();
		});

		it('parses `promptGuidance.testFirst: true` as the per-item opt-in', () => {
			const md = [
				'---',
				'slug: a',
				'promptGuidance.testFirst: true',
				'---',
			].join('\n');
			expect(parseFrontmatter(md).promptGuidance.testFirst).toBe(true);
		});

		it('parses `promptGuidance.testFirst: false` as the per-item opt-out', () => {
			const md = [
				'---',
				'slug: a',
				'promptGuidance.testFirst: false',
				'---',
			].join('\n');
			expect(parseFrontmatter(md).promptGuidance.testFirst).toBe(false);
		});

		it('strips quotes around the value ("true" still reads as boolean true)', () => {
			const md = [
				'---',
				'slug: a',
				'promptGuidance.testFirst: "true"',
				'---',
			].join('\n');
			expect(parseFrontmatter(md).promptGuidance.testFirst).toBe(true);
		});

		it('rejects a mistyped scalar ("yes") the same way humanOnly does — undefined, no silent coerce', () => {
			const md = [
				'---',
				'slug: a',
				'promptGuidance.testFirst: yes',
				'humanOnly: yes',
				'---',
			].join('\n');
			const fm = parseFrontmatter(md);
			// The cross-reference: BOTH axes silently degrade to undefined on a
			// non-boolean scalar (no silent coerce to true/false).
			expect(fm.humanOnly).toBeUndefined();
			expect(fm.promptGuidance.testFirst).toBeUndefined();
		});
	});
});

describe('resolveClosingIssue', () => {
	it('a fanned task (spec: only) closes via the `spec:` hop', () => {
		expect(resolveClosingIssue({spec: 'my-spec', issue: undefined})).toEqual({
			via: 'spec',
			spec: 'my-spec',
		});
	});

	it('a lone task (issue: only) closes via its own `issue:` field', () => {
		expect(resolveClosingIssue({spec: undefined, issue: 7})).toEqual({
			via: 'issue',
			issue: 7,
		});
	});

	it('when both are present (a hand-edit contradiction), `spec:` WINS and `issue:` is ignored', () => {
		// The one-closure-path invariant: intake never emits both; a human typo degrades
		// to "use the spec's number" rather than crashing (no throwing validator).
		expect(resolveClosingIssue({spec: 'my-spec', issue: 9})).toEqual({
			via: 'spec',
			spec: 'my-spec',
		});
	});

	it('neither present → no closure path (undefined)', () => {
		expect(
			resolveClosingIssue({spec: undefined, issue: undefined}),
		).toBeUndefined();
	});
});

describe('setFrontmatterMarker', () => {
	it('REPLACES an existing key inside the fence (idempotent)', () => {
		const md = '---\nslug: foo\nneedsAnswers: false\n---\n\nbody\n';
		const out = setFrontmatterMarker(md, 'needsAnswers', 'true');
		expect(parseFrontmatter(out).needsAnswers).toBe(true);
		expect(parseFrontmatter(out).slug).toBe('foo');
		// Body preserved; no duplicate key appended.
		expect(out.match(/needsAnswers/g)).toHaveLength(1);
		expect(out).toContain('body');
	});

	it('APPENDS a new key as the last line inside an existing fence', () => {
		const md = '---\nslug: foo\n---\n\nbody\n';
		const out = setFrontmatterMarker(md, 'triaged', 'keep');
		expect(parseFrontmatter(out).triaged).toBe('keep');
		expect(parseFrontmatter(out).slug).toBe('foo');
	});

	// The load-bearing regression: a fence-less document (how observations are born
	// via capture-signal) must get a fence PREPENDED, NOT be returned unchanged.
	// The old silent no-op is what tore the needsAnswers ⟺ sidecar invariant and
	// produced the `sidecar-without-needsAnswers` advance refusal.
	it('PREPENDS a fence to a FENCE-LESS document (was: returned unchanged)', () => {
		const md = '# `integrateLock` is in-process only\n\nsome prose here\n';
		const out = setFrontmatterMarker(md, 'needsAnswers', 'true');
		expect(out).not.toBe(md);
		expect(out.startsWith('---\n')).toBe(true);
		expect(parseFrontmatter(out).needsAnswers).toBe(true);
		// The original prose is preserved verbatim after the new fence.
		expect(out).toContain('# `integrateLock` is in-process only');
		expect(out).toContain('some prose here');
		expect(out).toBe(
			'---\nneedsAnswers: true\n---\n\n' +
				'# `integrateLock` is in-process only\n\nsome prose here\n',
		);
	});

	it('collapses leading blank lines before the body when prepending a fence', () => {
		const md = '\n\n# heading\n\nbody\n';
		const out = setFrontmatterMarker(md, 'needsAnswers', 'true');
		expect(out).toBe('---\nneedsAnswers: true\n---\n\n# heading\n\nbody\n');
	});

	it('round-trips a re-set on a now-fenced doc (idempotent after the prepend)', () => {
		const md = '# heading\n\nbody\n';
		const once = setNeedsAnswersMarker(md, true);
		const twice = setNeedsAnswersMarker(once, false);
		expect(parseFrontmatter(twice).needsAnswers).toBe(false);
		// Still exactly one needsAnswers line (replaced, not duplicated).
		expect(twice.match(/needsAnswers/g)).toHaveLength(1);
	});

	it('leaves a MALFORMED doc (open fence, no close) untouched', () => {
		const md = '---\nslug: foo\nno closing fence here\n';
		expect(setFrontmatterMarker(md, 'needsAnswers', 'true')).toBe(md);
	});

	/**
	 * A BOM-prefixed doc used to be DEMOTED, not annotated. `extractBlock` (the
	 * READER) strips a leading BOM, so `parseFrontmatter` sees the fence and
	 * reports `slug`/`title` happily; this WRITER did not, so it judged the doc
	 * fence-less and PREPENDED a second fence, pushing the real frontmatter down
	 * into the body. The marker then parsed back correctly, so every
	 * defense-in-depth guard that re-parses the result (the surface path's, and
	 * the terminal drain's) was satisfied and the corrupted body was committed,
	 * silently losing `slug`, `title`, `spec` and `blockedBy`.
	 *
	 * A BOM is rare in this tree but entirely legal, and it is exactly the input a
	 * Windows editor or an external tool produces.
	 */
	describe('a BOM-prefixed document (reader strips it, so the writer must too)', () => {
		const bom = '\uFEFF';
		const md = `${bom}---\ntitle: t\nslug: foo\nneedsAnswers: true\n---\n\nbody\n`;

		it('REPLACES the key in the real fence instead of prepending a second one', () => {
			const out = setFrontmatterMarker(md, 'needsAnswers', 'false');
			expect(parseFrontmatter(out).needsAnswers).toBe(false);
			// Exactly one fence pair, and one needsAnswers line: not demoted. The
			// opening fence carries the preserved BOM, hence the optional prefix.
			expect(out.match(/^\uFEFF?---$/gm)).toHaveLength(2);
			expect(out.match(/needsAnswers/g)).toHaveLength(1);
			expect(out).toBe(
				'\uFEFF---\ntitle: t\nslug: foo\nneedsAnswers: false\n---\n\nbody\n',
			);
		});

		it('PRESERVES the sibling keys the demotion used to destroy', () => {
			const out = setFrontmatterMarker(md, 'needsAnswers', 'false');
			expect(parseFrontmatter(out).slug).toBe('foo');
			expect(parseFrontmatter(md).slug).toBe('foo');
		});

		it('KEEPS the BOM (it is the document’s encoding marker, not ours to drop)', () => {
			expect(setFrontmatterMarker(md, 'needsAnswers', 'false')).toMatch(
				/^\uFEFF/,
			);
		});

		it('still PREPENDS a fence to a BOM-prefixed FENCE-LESS document', () => {
			const prose = `${bom}# heading\n\nprose\n`;
			const out = setFrontmatterMarker(prose, 'needsAnswers', 'true');
			expect(parseFrontmatter(out).needsAnswers).toBe(true);
			expect(out).toMatch(/^\uFEFF---\n/);
			expect(out).toContain('# heading');
		});
	});
});

describe('parseFrontmatter — the SHIPPED templates parse coherently (parser ⟷ template drift guard)', () => {
	// The trailing-`# comment` inline-list style is the documented house style in
	// the canonical templates `setup` propagates to every repo. If the parser ever
	// regresses on it, a task authored straight from the template is silently
	// marked ineligible and never auto-built. Pin the contract by parsing the REAL
	// shipped template lines.
	const here = dirname(fileURLToPath(import.meta.url));
	const repoRoot = join(here, '..', '..', '..');

	for (const rel of [
		'skills/setup/protocol/task-template.md',
		'skills/setup/protocol/WORK-CONTRACT.md',
		'work/protocol/task-template.md',
		'work/protocol/WORK-CONTRACT.md',
	]) {
		it(`the \`blockedBy: [] # ...\` line in ${rel} parses to []`, () => {
			const text = readFileSync(join(repoRoot, rel), 'utf8');
			const line = text
				.split('\n')
				.find((l) => /^blockedBy:\s*\[\]\s*#/.test(l));
			expect(
				line,
				`expected a templated \`blockedBy: [] # ...\` in ${rel}`,
			).toBeDefined();
			const md = ['---', 'slug: a', line as string, '---'].join('\n');
			expect(parseFrontmatter(md).blockedBy).toEqual([]);
		});
	}
});

describe('parseFrontmatter — spec field is `spec:`-only (HARD CUTOVER: no legacy `prd:` KEY read)', () => {
	// The FIELD is `spec`-only (spec
	// `prd-to-spec-vocabulary-cutover-and-migration-command`, HARD CUTOVER — the
	// LAST `prd` back-compat surface removed). There is no `fm.prd` field, and the
	// legacy `prd:` KEY read is GONE: an un-migrated `prd:` field no longer resolves.
	// A downstream repo converts its data via the TEXTUAL `dorfl prd-to-spec`
	// rewrite (which does not go through this parser), after which `spec:` reads
	// canonically.
	it('populates fm.spec from the canonical `spec:` key', () => {
		const md = ['---', 'slug: t', 'spec: my-spec', '---'].join('\n');
		const fm = parseFrontmatter(md);
		expect(fm.spec).toBe('my-spec');
	});

	it('does NOT read a legacy `prd:` KEY into fm.spec (hard cutover)', () => {
		const md = ['---', 'slug: t', 'prd: my-spec', '---'].join('\n');
		const fm = parseFrontmatter(md);
		expect(fm.spec).toBeUndefined();
	});

	it('there is no `prd` FIELD on the parsed frontmatter', () => {
		const md = ['---', 'slug: t', 'prd: my-spec', '---'].join('\n');
		const fm = parseFrontmatter(md);
		expect('prd' in fm).toBe(false);
	});

	it('leaves fm.spec undefined when the `spec:` key is absent', () => {
		const md = ['---', 'slug: t', '---'].join('\n');
		const fm = parseFrontmatter(md);
		expect(fm.spec).toBeUndefined();
	});

	it('a stray legacy `prd:` alongside `spec:` is inert (only `spec:` populates fm.spec)', () => {
		// Either ordering: the canonical `spec:` value populates fm.spec; the legacy
		// `prd:` line is now inert text the parser neither reads nor lets clobber.
		const prdFirst = ['---', 'prd: legacy', 'spec: canonical', '---'].join(
			'\n',
		);
		const specFirst = ['---', 'spec: canonical', 'prd: legacy', '---'].join(
			'\n',
		);
		for (const md of [prdFirst, specFirst]) {
			const fm = parseFrontmatter(md);
			expect(fm.spec).toBe('canonical');
		}
	});

	it('an empty `spec:` leaves fm.spec undefined (a stray `prd:` does not fill it)', () => {
		const md = ['---', 'prd: legacy', 'spec:', '---'].join('\n');
		const fm = parseFrontmatter(md);
		expect(fm.spec).toBeUndefined();
	});
});
