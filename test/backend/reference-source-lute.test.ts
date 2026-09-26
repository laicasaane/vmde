import { fileURLToPath } from 'node:url'
import { beforeAll, expect, it } from 'vitest'
import {
  indexReferenceDefinitions,
  normalizeReferenceLabel,
} from '../../media-src/src/links/reference-source'
import { prewarmLute, renderForMode } from '../../src/lute/lute-host'
import { waitForLuteWarm } from './lute-artifact'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

beforeAll(async () => {
  prewarmLute(ROOT)
  await waitForLuteWarm()
})

it('matches pinned Lute definition winners for full, collapsed and shortcut references', () => {
  const markdown = [
    'See [`init`][INIT], [init][], and [init].',
    '',
    '[Init]: <https://first.example/a> "Title"',
    '[init]: https://second.example/b "Ignored"',
    '',
  ].join('\n')
  const definitions = indexReferenceDefinitions(markdown)
  expect(definitions.map((item) => item.destination)).toEqual([
    'https://first.example/a',
    'https://second.example/b',
  ])
  for (const mode of ['ir', 'wysiwyg'] as const) {
    const html = renderForMode(ROOT, markdown, mode)
    expect(html.match(/data-type="link-ref"/gu)).toHaveLength(3)
    expect(html).toContain('data-type="link-ref-defs-block"')
  }
})

it('does not index a malformed line before a separate valid definition', () => {
  const markdown =
    'See [ref].\n\n[ref] https://bad.example/a(b\n\n[ref]: <https://winner.example/a(b)c> "Title"\n'
  const html = renderForMode(ROOT, markdown, 'ir')
  expect(html.match(/data-type="link-ref-defs-block"/gu)).toHaveLength(1)
  expect(indexReferenceDefinitions(markdown)).toHaveLength(1)
})

it('characterizes pinned Lute parenthesized destination recognition', () => {
  const statuses = [] as Array<[string, boolean]>
  for (const definition of [
    '[r]: https://e.com/a(b)c',
    '[r]: https://e.com/a(b)c "T"',
    '[r]: https://e.com/a(b',
    '[r]: https://e.com/a(b "T"',
    '[r]: <https://e.com/a(b)c> "T"',
    '[r]: https://e.com/a\\(b\\)c "T"',
  ]) {
    const html = renderForMode(ROOT, `See [x][r]\n\n${definition}\n`, 'ir')
    statuses.push([
      definition,
      html.includes('data-type="link-ref-defs-block"'),
    ])
  }
  expect(statuses.map(([, recognized]) => recognized)).toEqual([
    false,
    false,
    true,
    true,
    true,
    true,
  ])
})

it('keeps a code-formatted reference label in pinned IR DOM', () => {
  const markdown =
    '- `IsExternalInit.cs`: Enable [`init`][init] of C# 9\n\n[init]: https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/init\n'
  const ir = renderForMode(ROOT, markdown, 'ir')
  expect(ir).toMatch(
    /data-type="link-ref"[^>]*>[\s\S]*?<code[^>]*>init<\/code>/u,
  )
})

// Task 576: pinned Lute's WYS renderer reads only the first NodeLinkText child, so a code-formatted
// reference label renders as an EMPTY `data-type="link-ref"` span instead of carrying `<code>init</code>`
// (see the IR-vs-WYS mismatch above — IR keeps the label, WYS drops it). This is the known engine defect
// documented by Task 550 and owned by deferred Task 572 (tasks/572-native-lute-reference-links.md),
// which scopes a native Lute repair of the WYS reference-label renderer. Do not "fix" this by patching
// Lute here; `it.fails` keeps the defect visible and this test will start failing (telling us to flip it
// back to `it`) the moment Task 572 lands.
it.fails('keeps a code-formatted reference label in pinned WYS DOM (defect owned by Task 572)', () => {
  const markdown =
    '- `IsExternalInit.cs`: Enable [`init`][init] of C# 9\n\n[init]: https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/init\n'
  const wys = renderForMode(ROOT, markdown, 'wysiwyg')
  expect(wys).toMatch(
    /data-type="link-ref"[^>]*>[\s\S]*?<code[^>]*>init<\/code>/u,
  )
})

it('rejects an angle destination whose title has no separating whitespace', () => {
  const markdown = 'See [r].\n\n[r]: <https://example.com/a>"Title"\n'
  const html = renderForMode(ROOT, markdown, 'ir')
  expect(html).not.toContain('data-type="link-ref-defs-block"')
  expect(indexReferenceDefinitions(markdown)).toHaveLength(0)
})

it('matches pinned Lute simple Unicode folding for Greek sigma and accented case', () => {
  for (const [use, definition] of [
    ['Σ', 'ς'],
    ['CAFÉ', 'café'],
  ]) {
    const markdown = `[${use}]\n\n[${definition}]: https://example.com\n`
    expect(renderForMode(ROOT, markdown, 'ir')).toContain(
      'data-type="link-ref"',
    )
    expect(normalizeReferenceLabel(use)).toBe(
      normalizeReferenceLabel(definition),
    )
  }
})

it('resolves only the same raw escape spelling used by pinned Lute', () => {
  for (const label of ['a\\]b', 'a\\*b']) {
    const markdown = `[${label}]\n\n[${label}]: https://example.com\n`
    expect(renderForMode(ROOT, markdown, 'ir')).toContain(
      'data-type="link-ref"',
    )
    expect(indexReferenceDefinitions(markdown)).toHaveLength(1)
  }
  const mismatch = '[a*b]\n\n[a\\*b]: https://example.com\n'
  expect(renderForMode(ROOT, mismatch, 'ir')).not.toContain(
    'data-type="link-ref"',
  )
})

it('keeps pinned Lute angle destinations with whitespace as the first winner', () => {
  const markdown =
    'See [ref].\n\n[ref]: <https://example.com/a b> "Title"\n\n[ref]: https://later.example\n'
  const html = renderForMode(ROOT, markdown, 'ir')
  expect(html?.match(/data-type="link-ref-defs-block"/gu)).toHaveLength(2)
  expect(
    indexReferenceDefinitions(markdown).map((item) => item.destination),
  ).toEqual(['https://example.com/a b', 'https://later.example'])
})

it('indexes exact title delimiters and CRLF boundaries that pinned Lute recognizes', () => {
  for (const title of ['"Double"', "'Single'", '(Parenthesized)']) {
    const markdown = `See [r].\r\n\r\n[r]: <https://example.com/a(b)c> ${title}\r\n`
    const html = renderForMode(ROOT, markdown, 'ir')
    expect(html?.match(/data-type="link-ref-defs-block"/gu)).toHaveLength(1)
    const [definition] = indexReferenceDefinitions(markdown)
    expect(definition).toBeDefined()
    expect(
      markdown.slice(definition.destinationStart, definition.destinationEnd),
    ).toBe('https://example.com/a(b)c')
    expect(markdown.slice(definition.titleStart!, definition.titleEnd!)).toBe(
      title,
    )
  }
})

it('indexes a definition directly after a closed heading block', () => {
  const markdown = '# Heading\n[ref]: https://example.com\n\nSee [ref].\n'
  expect(renderForMode(ROOT, markdown, 'ir')).toContain(
    'data-type="link-ref-defs-block"',
  )
  expect(
    indexReferenceDefinitions(markdown).map((item) => item.destination),
  ).toEqual(['https://example.com'])
})
