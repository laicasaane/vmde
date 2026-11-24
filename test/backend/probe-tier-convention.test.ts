import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Task 449's `@probe` tier (test/vscode-e2e/playwright.config.ts's `grepExcludePatterns`) is
// enforced by TWO independent conventions that must agree:
//   - the `@probe` tag in a test() title (the mechanism that actually excludes a test, same
//     precedent as the pre-existing `@visual` tag), and
//   - a `*-probe.spec.ts` filename (a readable signal for anyone scanning the directory, so a
//     spec that forgets the tag is still visually flagged).
//
// A file can drift off either convention without the other noticing — team-lead hit BOTH
// directions before this guard existed:
//   - `caret-empty-typing-probe.spec.ts` carried real regression assertions under a probe NAME
//     (renamed off the convention once found — a filename-says-probe, content-is-real mismatch).
//   - `undo-dirty-probe.spec.ts` is a real SMOKE-tier assertion spec with a historical probe name
//     that was never a measurement-only probe to begin with.
// Both are "someone reads the filename and silently drops a real gate" — the failure this guard
// exists to make impossible, in either direction, without needing a VS Code boot to check it.
//
// No VS Code boot: this is pure text/regex over the spec SOURCE, not `import()` of the specs
// themselves (they import 'vscode-test-playwright', which isn't installed for the root vitest
// run — see test/vscode-e2e's separate node_modules).

const SPEC_DIR = path.resolve(__dirname, '../vscode-e2e')

// Direction A exceptions: a `*-probe.spec.ts` FILE that is intentionally NOT tag-excluded,
// because — despite its name — it carries real assertions that must stay in the default run.
// Declaring an exception here is the point: the next reader sees WHY, instead of discovering a
// missing gate by debugging a regression that silently stopped running.
const PROBE_NAME_EXCEPTIONS: Record<string, string> = {
  'undo-dirty-probe.spec.ts':
    'historical name, not a measurement-only probe — real dirty-state assertions, and it is a ' +
    'SMOKE_SPECS member (team-lead, task 449 review). Do not tag @probe or this drops out of the ' +
    'PR gate.',
}

// Direction B exceptions: a file carrying `@probe`-tagged tests whose name does NOT end in
// `-probe.spec.ts`. Two shapes:
//   - task 449's original tagging pass predates the `*-probe.spec.ts` filename convention (that
//     convention was added by team-lead AFTER 449 landed) and reused the existing `@visual`
//     precedent — tag-only, no filename rule — so these names were never meant to carry "-probe".
//   - `probe-cloudogu.spec.ts` / `probe-pumlmode.spec.ts` carry "probe" as a PREFIX, not a suffix,
//     so they deliberately do not match the `*-probe.spec.ts` glob.
// Renaming any of these to satisfy the suffix convention was considered and rejected: several
// (`mermaid-markers`, `diagram-edit-scroll`) mix a probe-tagged test with other content, so a
// blanket "-probe" rename would misdescribe the file; a rename also breaks every doc/comment that
// already names them (18 header comments added in task 449) for no safety gain — see Direction B's
// own purpose below.
const TAG_ONLY_PROBES = new Set<string>([
  'd2-edit-perf.spec.ts',
  'diagram-sizing-audit.spec.ts',
  'katex-open-cost.spec.ts',
  // `mermaid-markers.spec.ts` was here until task 453 deleted the spec (its coverage moved down to
  // the chromium harness). Removed rather than left as a harmless-looking string: this test exists
  // precisely to stop the allowlist accumulating names of files nobody has, and it caught this one
  // the same day. The comment above still cites it as an example of a mixed-content probe file —
  // that history is accurate and worth keeping, so it is deliberately not rewritten.
  'perf-timeline.spec.ts',
  'perf-observer-fleet.spec.ts',
  'perf-prose-typing.spec.ts',
  'prerender-first-open.spec.ts',
  'diagram-edit-scroll.spec.ts',
  'probe-cloudogu.spec.ts',
  'probe-pumlmode.spec.ts',
  // Task 733 / 045: the first-Source-edit regression tests and their latency and return-to-IR
  // flush probes share one fixture setup and one file; only the probe cells carry `@probe`.
  'sv-first-edit.spec.ts',
])

/** Every `test(<quoted title>` / `test.describe(<quoted title>` string literal in a spec file. */
function testTitles(source: string): string[] {
  const titles: string[] = []
  // Matches a single/double/backtick-quoted first argument only — every title in the suite today
  // is a plain string literal (no template interpolation), which this deliberately does not try
  // to handle: a title built from a template expression would need eval, which a text-only guard
  // must not do.
  const re = /\btest(?:\.describe)?\(\s*(['"`])((?:(?!\1).)*)\1/g
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec-loop idiom
  while ((m = re.exec(source))) titles.push(m[2])
  return titles
}

describe('the @probe tag and *-probe.spec.ts filename conventions agree (task 449 guard)', () => {
  const files = readdirSync(SPEC_DIR).filter((f) => f.endsWith('.spec.ts'))
  expect(
    files.length,
    'no spec files found — SPEC_DIR is probably wrong',
  ).toBeGreaterThan(50)

  it('every allowlist entry names a file that still exists (no stale exemptions)', () => {
    const known = new Set(files)
    for (const f of Object.keys(PROBE_NAME_EXCEPTIONS))
      expect(
        known.has(f),
        `PROBE_NAME_EXCEPTIONS names "${f}", which no longer exists`,
      ).toBe(true)
    for (const f of TAG_ONLY_PROBES)
      expect(
        known.has(f),
        `TAG_ONLY_PROBES names "${f}", which no longer exists`,
      ).toBe(true)
  })

  it('direction A: every *-probe.spec.ts file has all its tests @probe-tagged, or is on the allowlist', () => {
    const violations: string[] = []
    for (const f of files) {
      if (!f.endsWith('-probe.spec.ts')) continue
      if (f in PROBE_NAME_EXCEPTIONS) continue
      const titles = testTitles(readFileSync(path.join(SPEC_DIR, f), 'utf8'))
      const untagged = titles.filter((t) => !t.includes('@probe'))
      if (untagged.length > 0)
        violations.push(
          `${f}: ${untagged.length} test title(s) not @probe-tagged (${untagged.map((t) => `"${t}"`).join(', ')}) — ` +
            `tag them @probe, or add "${f}" to PROBE_NAME_EXCEPTIONS with a reason if it is meant to stay in the default run`,
        )
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('direction B: every @probe-tagged test lives in a *-probe.spec.ts file, or is on the allowlist', () => {
    const violations: string[] = []
    for (const f of files) {
      if (f.endsWith('-probe.spec.ts')) continue
      if (TAG_ONLY_PROBES.has(f)) continue
      const titles = testTitles(readFileSync(path.join(SPEC_DIR, f), 'utf8'))
      const tagged = titles.filter((t) => t.includes('@probe'))
      if (tagged.length > 0)
        violations.push(
          `${f}: ${tagged.length} test title(s) carry @probe but the filename doesn't end in ` +
            `"-probe.spec.ts" (${tagged.map((t) => `"${t}"`).join(', ')}) — rename the file to match, ` +
            `or add "${f}" to TAG_ONLY_PROBES with a reason`,
        )
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})
