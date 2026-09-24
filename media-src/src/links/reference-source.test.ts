import { expect, it } from 'vitest'
import {
  indexReferenceDefinitions,
  normalizeReferenceLabel,
  planReferenceDefinitionEdit,
  resolveReferenceDefinition,
} from './reference-source'

it('normalizes case and internal whitespace while selecting the first valid definition', () => {
  const source = [
    'See [`init`][  INIT  ] and [another][init].',
    '',
    '[ Init ]: <https://first.example/a b> "First title"',
    '[init]: https://second.example/path "Second title"',
    '',
  ].join('\r\n')
  expect(normalizeReferenceLabel('  INIT \t Name  ')).toBe('init name')
  const definitions = indexReferenceDefinitions(source)
  expect(definitions).toHaveLength(2)
  expect(definitions[0]).toMatchObject({
    normalizedLabel: 'init',
    label: ' Init ',
    destination: 'https://first.example/a b',
    title: '"First title"',
    angleBracketed: true,
  })
  expect(
    source.slice(
      definitions[0].destinationStart,
      definitions[0].destinationEnd,
    ),
  ).toBe('https://first.example/a b')
  expect(definitions[0].titleDelimiter).toBe('"')
  expect(
    source.slice(definitions[0].titleStart!, definitions[0].titleEnd!),
  ).toBe('"First title"')
  expect(resolveReferenceDefinition(source, 'init')?.destination).toBe(
    'https://first.example/a b',
  )
  expect(resolveReferenceDefinition(source, 'INIT')?.destination).toBe(
    'https://first.example/a b',
  )
  expect(resolveReferenceDefinition(source, 'missing')).toBeNull()
})

it('rewrites only the winning exact destination and retains CRLF, case, title, and duplicate uses', () => {
  const source = [
    '# Report',
    '',
    'See [`init`][INIT] and [second][init].',
    '',
    '[Init]: <https://first.example/a> "Keep title"',
    '[init]: https://ignored.example/b "Other title"',
    '',
    '| raw | table |',
    '| --- | --- |',
    '| x | y |',
    '',
    '```md',
    '[init]: https://protected.example/c',
    '```',
    '',
  ].join('\r\n')
  const winner = resolveReferenceDefinition(source, 'INIT')!
  const result = planReferenceDefinitionEdit(
    source,
    {
      label: 'init',
      start: winner.destinationStart,
      end: winner.destinationEnd,
    },
    'https://changed.example/new',
  )
  expect(result).toMatchObject({
    status: 'changed',
    markdown: source.replace(
      'https://first.example/a',
      'https://changed.example/new',
    ),
  })
})

it('ignores protected and malformed definitions, then uses the first Lute-shaped one', () => {
  const source = [
    '```md',
    '[ref]: https://fence.example',
    '```',
    '',
    '<!--',
    '[ref]: https://comment.example',
    '-->',
    '',
    '<div>',
    '[ref]: https://html.example',
    '</div>',
    '',
    '    [ref]: https://indent.example',
    '',
    '[ref] https://bad.example/a(b',
    '',
    '[ref]: <https://winner.example/a(b)c> "Title"',
    '',
  ].join('\n')
  expect(indexReferenceDefinitions(source)).toHaveLength(1)
  expect(resolveReferenceDefinition(source, 'REF')?.destination).toBe(
    'https://winner.example/a(b)c',
  )
})

it('rejects stale, unchanged and invalid replacements without mutating source', () => {
  const source = '[ref]: https://example.com/a (Title)\n'
  const winner = resolveReferenceDefinition(source, 'ref')!
  expect(
    planReferenceDefinitionEdit(
      source,
      {
        label: 'ref',
        start: winner.destinationStart + 1,
        end: winner.destinationEnd,
      },
      'https://changed.example',
    ).status,
  ).toBe('rejected')
  for (const destination of [
    'https://example.com/a',
    'https://bad.example/has space',
    'https://bad.example/line\nbreak',
    'https://bad.example/a(b)c',
    '',
  ])
    expect(
      planReferenceDefinitionEdit(
        source,
        {
          label: 'ref',
          start: winner.destinationStart,
          end: winner.destinationEnd,
        },
        destination,
      ).status,
    ).toBe('rejected')
  expect(source).toBe('[ref]: https://example.com/a (Title)\n')
})

it('follows pinned Lute for bare closing parentheses and safe escaped or angle forms', () => {
  expect(indexReferenceDefinitions('[r]: https://e.com/a(b)c\n')).toHaveLength(
    0,
  )
  expect(
    indexReferenceDefinitions('[r]: <https://e.com/a(b)c>\n'),
  ).toHaveLength(1)
  expect(
    indexReferenceDefinitions('[r]: https://e.com/a\\(b\\)c\n'),
  ).toHaveLength(1)
})

it('does not treat footnotes as shared link definitions', () => {
  const source =
    '[^init]: https://footnote.example\n\n[init]: https://link.example\n'
  expect(indexReferenceDefinitions(source).map((item) => item.label)).toEqual([
    'init',
  ])
  expect(resolveReferenceDefinition(source, 'init')?.destination).toBe(
    'https://link.example',
  )
})

it('uses pinned Lute simple Unicode folding without merging distinct sharp-s labels', () => {
  expect(normalizeReferenceLabel('Σ')).toBe(normalizeReferenceLabel('ς'))
  expect(normalizeReferenceLabel('CAFÉ')).toBe(normalizeReferenceLabel('café'))
  expect(normalizeReferenceLabel('STRASSE')).not.toBe(
    normalizeReferenceLabel('Straße'),
  )
})

it('rejects a later duplicate and maps UTF-16 offsets after an astral character', () => {
  const source =
    '😀 [ref] and [ref]\r\n\r\n[Ref]: <https://one.example> "Title"\r\n[ref]: https://two.example\r\n'
  const [first, later] = indexReferenceDefinitions(source)
  expect(source.slice(first.destinationStart, first.destinationEnd)).toBe(
    'https://one.example',
  )
  expect(
    planReferenceDefinitionEdit(
      source,
      {
        label: 'ref',
        start: later.destinationStart,
        end: later.destinationEnd,
      },
      'https://wrong.example',
    ).status,
  ).toBe('rejected')
  const change = planReferenceDefinitionEdit(
    source,
    { label: 'ref', start: first.destinationStart, end: first.destinationEnd },
    'https://new.example',
  )
  expect(change).toMatchObject({
    status: 'changed',
    markdown: source.replace('https://one.example', 'https://new.example'),
  })
})

it('keeps escape bytes in labels because pinned Lute resolves the raw escaped key', () => {
  const source =
    '[a\\]b] and [a\\*b]\n\n[a\\]b]: https://bracket.example\n[a\\*b]: https://star.example\n'
  expect(normalizeReferenceLabel('a\\]b')).not.toBe(
    normalizeReferenceLabel('a]b'),
  )
  expect(resolveReferenceDefinition(source, 'a\\]b')?.destination).toBe(
    'https://bracket.example',
  )
  expect(resolveReferenceDefinition(source, 'a\\*b')?.destination).toBe(
    'https://star.example',
  )
  expect(resolveReferenceDefinition(source, 'a]b')).toBeNull()
})
