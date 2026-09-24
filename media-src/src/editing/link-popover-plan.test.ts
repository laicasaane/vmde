import { expect, it } from 'vitest'
import {
  listLinkPopoverCandidates,
  planLinkPopoverAction,
} from './link-popover-plan'

function destinationSpan(markdown: string, value: string, occurrence = 0) {
  let start = -1
  let from = 0
  for (let count = 0; count <= occurrence; count++) {
    start = markdown.indexOf(value, from)
    if (start < 0) throw new Error(`missing test destination ${value}`)
    from = start + value.length
  }
  return { start, end: start + value.length }
}

it('edits only the mapped duplicate inline destination and preserves labels, titles, and CRLF', () => {
  const source =
    '[first \\[label\\]](https://same.example/a "first title")\r\n' +
    "[second](https://same.example/a 'second title')\r\n"
  const span = destinationSpan(source, 'https://same.example/a', 1)
  expect(
    planLinkPopoverAction(
      source,
      { ...span, kind: 'link' },
      {
        kind: 'edit',
        destination: 'https://changed.example/path',
      },
    ),
  ).toMatchObject({
    status: 'changed',
    markdown:
      '[first \\[label\\]](https://same.example/a "first title")\r\n' +
      "[second](https://changed.example/path 'second title')\r\n",
  })
})

it('keeps balanced and escaped destination parentheses inside the exact mapped span', () => {
  const balanced = '[Path](https://example.com/a(b)c)\r\n'
  const balancedSpan = destinationSpan(balanced, 'https://example.com/a(b)c')
  expect(
    planLinkPopoverAction(
      balanced,
      { ...balancedSpan, kind: 'link' },
      {
        kind: 'edit',
        destination: 'https://new.example/x(y)z',
      },
    ),
  ).toMatchObject({
    status: 'changed',
    markdown: '[Path](https://new.example/x(y)z)\r\n',
  })

  const escaped = '[Path](https://example.com/a\\(b\\)c)\r\n'
  const escapedSpan = destinationSpan(escaped, 'https://example.com/a\\(b\\)c')
  expect(
    planLinkPopoverAction(
      escaped,
      { ...escapedSpan, kind: 'link' },
      {
        kind: 'edit',
        destination: 'https://new.example/x\\(y\\)z',
      },
    ),
  ).toMatchObject({
    status: 'changed',
    markdown: '[Path](https://new.example/x\\(y\\)z)\r\n',
  })
})

it('fails closed on unbalanced destinations and links found inside fenced code', () => {
  const unbalanced = '[Broken](https://example.com/a(b)\r\n'
  const unbalancedSpan = destinationSpan(unbalanced, 'https://example.com/a(b)')
  expect(
    planLinkPopoverAction(
      unbalanced,
      { ...unbalancedSpan, kind: 'link' },
      { kind: 'unlink' },
    ).status,
  ).toBe('rejected')

  const fenced =
    '```md\n[Code](https://example.com/code)\n```\n\n' +
    '[Real](https://example.com/real)\n'
  const codeSpan = destinationSpan(fenced, 'https://example.com/code')
  expect(
    planLinkPopoverAction(
      fenced,
      { ...codeSpan, kind: 'link' },
      { kind: 'unlink' },
    ).status,
  ).toBe('rejected')
})

it('escapes an unmatched closing parenthesis in a new bare destination', () => {
  const source = '[Path](https://old.example/path)\n'
  const span = destinationSpan(source, 'https://old.example/path')
  expect(
    planLinkPopoverAction(
      source,
      { ...span, kind: 'link' },
      {
        kind: 'edit',
        destination: 'https://new.example/path)',
      },
    ),
  ).toMatchObject({
    status: 'changed',
    sourceReplacement: 'https://new.example/path\\)',
    markdown: '[Path](https://new.example/path\\))\n',
  })
})

it('updates the contents of an angle-bracket destination without changing its delimiters or title', () => {
  const source = '[Docs](<https://example.com/a%20b> "Keep title")\n'
  const span = destinationSpan(source, 'https://example.com/a%20b')
  expect(
    planLinkPopoverAction(
      source,
      { ...span, kind: 'link' },
      {
        kind: 'edit',
        destination: 'https://new.example/a%20b',
      },
    ),
  ).toMatchObject({
    status: 'changed',
    sourceReplacement: 'https://new.example/a%20b',
    markdown: '[Docs](<https://new.example/a%20b> "Keep title")\n',
  })
})

it('declines unchanged and invalid replacement destinations without a source write', () => {
  const source = '[Path](https://example.com/path)\n'
  const span = destinationSpan(source, 'https://example.com/path')
  expect(
    planLinkPopoverAction(
      source,
      { ...span, kind: 'link' },
      {
        kind: 'edit',
        destination: 'https://example.com/path',
      },
    ),
  ).toMatchObject({ status: 'rejected', reason: 'unchanged-destination' })
  for (const destination of [
    '',
    'https://example.com/has space',
    'https://example.com/line\nbreak',
  ])
    expect(
      planLinkPopoverAction(
        source,
        { ...span, kind: 'link' },
        {
          kind: 'edit',
          destination,
        },
      ),
    ).toMatchObject({ status: 'rejected', reason: 'invalid-destination' })
})

it('unlinks an inline link while preserving the exact escaped label source', () => {
  const source = 'prefix [A \\[b\\]](https://example.com "title") suffix\r\n'
  const span = destinationSpan(source, 'https://example.com')
  expect(
    planLinkPopoverAction(
      source,
      { ...span, kind: 'link' },
      { kind: 'unlink' },
    ),
  ).toMatchObject({
    status: 'changed',
    markdown: 'prefix A \\[b\\] suffix\r\n',
  })
})

it('unlinks an inline image to its exact alt source and preserves CRLF', () => {
  const source =
    'Before ![alt **bold**](<https://img.example/x> "caption") after\r\n'
  const span = destinationSpan(source, 'https://img.example/x')
  expect(
    planLinkPopoverAction(
      source,
      { ...span, kind: 'image' },
      { kind: 'unlink' },
    ),
  ).toMatchObject({
    status: 'changed',
    sourceReplacement: 'alt **bold**',
    markdown: 'Before alt **bold** after\r\n',
  })
})

it('rejects stale offsets and source forms without a proven inline destination', () => {
  for (const [source, needle, kind] of [
    ['[label][reference]\n', 'reference', 'link'],
    ['[[Home]]\n', 'Home', 'link'],
    ['<https://example.com>\n', 'https://example.com', 'link'],
    [
      '<a href="https://example.com">label</a>\n',
      'https://example.com',
      'link',
    ],
    ['`[label](https://example.com)`\n', 'https://example.com', 'link'],
  ] as const) {
    const span = destinationSpan(source, needle)
    expect(
      planLinkPopoverAction(source, { ...span, kind }, { kind: 'unlink' })
        .status,
      source,
    ).toBe('rejected')
  }
  expect(
    planLinkPopoverAction(
      '[label](https://example.com)',
      { start: 0, end: 4, kind: 'link' },
      { kind: 'unlink' },
    ).status,
  ).toBe('rejected')
})

it('lists ordered duplicate candidate identities with title and exact destination offsets', () => {
  const source =
    '[same](https://same.test/a "one") and [same](https://same.test/a "two")\n'
  const candidates = listLinkPopoverCandidates(source)
  expect(candidates).toHaveLength(2)
  expect(
    candidates.map((candidate) => ({
      kind: candidate.kind,
      label: candidate.label,
      destination: candidate.destination,
      title: candidate.title,
      start: candidate.start,
      end: candidate.end,
    })),
  ).toEqual([
    {
      kind: 'link',
      label: 'same',
      destination: 'https://same.test/a',
      title: '"one"',
      start: source.indexOf('https://same.test/a'),
      end: source.indexOf('https://same.test/a') + 19,
    },
    {
      kind: 'link',
      label: 'same',
      destination: 'https://same.test/a',
      title: '"two"',
      start: source.lastIndexOf('https://same.test/a'),
      end: source.lastIndexOf('https://same.test/a') + 19,
    },
  ])
})

it('keeps escaped quote and parenthesized-title delimiters attached to one candidate', () => {
  const quoted = `${String.raw`[x](https://old.test/a "an \"escaped\" title")`}\n`
  const quotedSpan = destinationSpan(quoted, 'https://old.test/a')
  expect(
    planLinkPopoverAction(
      quoted,
      { ...quotedSpan, kind: 'link' },
      { kind: 'edit', destination: 'https://new.test/b' },
    ),
  ).toMatchObject({
    status: 'changed',
    markdown: quoted.replace('https://old.test/a', 'https://new.test/b'),
  })
  const parenthesized = `${String.raw`[x](https://old.test/a (a\) b))`}\n`
  const parenthesizedSpan = destinationSpan(parenthesized, 'https://old.test/a')
  expect(
    planLinkPopoverAction(
      parenthesized,
      { ...parenthesizedSpan, kind: 'link' },
      { kind: 'unlink' },
    ),
  ).toMatchObject({ status: 'changed', markdown: 'x\n' })
})

it('declines a title whose line break makes inline ownership ambiguous', () => {
  const source = '[x](https://old.test/a "bad\nnext")\n'
  const span = destinationSpan(source, 'https://old.test/a')
  expect(
    planLinkPopoverAction(source, { ...span, kind: 'link' }, { kind: 'unlink' })
      .status,
  ).toBe('rejected')
})
