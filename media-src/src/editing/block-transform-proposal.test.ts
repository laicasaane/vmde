import { expect, it } from 'vitest'
import {
  blockTransform,
  describeBlockAt,
  planBlockTransform,
} from './block-transform'

it('offers a non-mutating callout-to-quote proposal with the exact removed metadata', () => {
  const source = '> [!NOTE]- Title\n> body **exact**'
  const caret = source.indexOf('body') + 2
  const result = blockTransform(source, { type: 'quote' }, caret, caret)
  expect(result).toMatchObject({
    status: 'confirm-required',
    markdown: source,
    proposal: {
      markdown: '> body **exact**',
      losses: ['callout-type/title/fold-marker-removed'],
    },
  })
})

it('proposes an exact CRLF code fence while leaving the document unchanged until consent', () => {
  const source = 'before\r\n\r\nalpha\r\nbeta\r\n\r\nafter\r\n'
  const start = source.indexOf('alpha')
  const end = start + 'alpha\r\nbeta'.length
  const result = planBlockTransform(
    source,
    { start, end },
    { type: 'fence', language: 'ts' },
    start + 2,
    start + 2,
  )
  expect(result).toMatchObject({
    status: 'confirm-required',
    markdown: source,
    proposal: {
      markdown: 'before\r\n\r\n```ts\r\nalpha\r\nbeta\r\n```\r\n\r\nafter\r\n',
      losses: ['markdown-becomes-literal'],
    },
  })
})

it('proposes one-paragraph fence unwrap and declines a structural raw body', () => {
  const simple = '```ts\nalpha **bold**\n```'
  expect(blockTransform(simple, { type: 'paragraph' }, 7, 7)).toMatchObject({
    status: 'confirm-required',
    markdown: simple,
    proposal: {
      markdown: 'alpha **bold**',
      losses: ['fence-language-removed'],
    },
  })
  const structural = '```ts\n# heading\n```'
  expect(blockTransform(structural, { type: 'paragraph' }, 7, 7)).toMatchObject(
    {
      status: 'unsupported',
      markdown: structural,
    },
  )
})

it('edits only a same-type fence language and rejects unsafe info syntax', () => {
  const source = '```js\nalpha\n```'
  expect(
    blockTransform(source, { type: 'fence', language: 'ts' }, 8, 8),
  ).toMatchObject({
    status: 'changed',
    markdown: '```ts\nalpha\n```',
  })
  expect(
    blockTransform(source, { type: 'fence', language: 'ts\nunsafe' }, 8, 8),
  ).toMatchObject({ status: 'unsupported', markdown: source })
})

it('composes callout removal and heading conversion in one confirmable candidate', () => {
  const source = '> [!TIP]- Title\n> body **exact**'
  const caret = source.indexOf('body') + 2
  expect(blockTransform(source, { type: 'h2' }, caret, caret)).toMatchObject({
    status: 'confirm-required',
    markdown: source,
    proposal: {
      markdown: '## body **exact**',
      losses: ['callout-type/title/fold-marker-removed'],
    },
  })
})

it('composes fence unwrapping with another target only for one paragraph body', () => {
  const source = '```ts\nalpha **bold**\n```'
  expect(blockTransform(source, { type: 'quote' }, 8, 8)).toMatchObject({
    status: 'confirm-required',
    markdown: source,
    proposal: {
      markdown: '> alpha **bold**',
      losses: ['fence-language-removed'],
    },
  })
  const multiline = '```ts\nfirst\nsecond\n```'
  expect(blockTransform(multiline, { type: 'h2' }, 8, 8)).toMatchObject({
    status: 'unsupported',
    markdown: multiline,
  })
})

it('transforms intersected complete blocks from a backward selection in one exact splice', () => {
  const source = 'alpha\n\nbeta\n\ngamma\n'
  const result = planBlockTransform(
    source,
    { start: 0, end: source.indexOf('beta') + 4 },
    { type: 'h2' },
    source.indexOf('beta') + 2,
    2,
  )
  expect(result).toMatchObject({
    status: 'changed',
    markdown: '## alpha\n\n## beta\n\ngamma\n',
    anchor: 15,
    focus: 5,
  })
})

it('treats a selection endpoint at the next block start as half-open', () => {
  const source = 'alpha\n\nbeta\n'
  const result = planBlockTransform(
    source,
    { start: 0, end: source.indexOf('beta') },
    { type: 'h2' },
    2,
    source.indexOf('beta'),
  )
  expect(result).toMatchObject({
    status: 'changed',
    markdown: '## alpha\n\nbeta\n',
  })
  expect(
    planBlockTransform(
      source,
      { start: 5, end: source.indexOf('beta') },
      { type: 'h2' },
      5,
      source.indexOf('beta'),
    ).status,
  ).toBe('unsupported')
})

it('changes only the needed units in a mixed batch and rejects a table anywhere inside it', () => {
  const source = '## first\n\nplain\n'
  expect(
    planBlockTransform(
      source,
      { start: 0, end: source.indexOf('plain') + 5 },
      { type: 'h2' },
      3,
      13,
    ),
  ).toMatchObject({ status: 'changed', markdown: '## first\n\n## plain\n' })
  const table = 'alpha\n\n| h | v |\n| - | - |\n| a | b |\n'
  expect(
    planBlockTransform(
      table,
      { start: 0, end: table.length },
      { type: 'h2' },
      2,
      table.length,
    ),
  ).toMatchObject({ status: 'unsupported', markdown: table })
})

it('aggregates one confirmation proposal across selected prose blocks', () => {
  const source = 'alpha\n\nbeta\n'
  const result = planBlockTransform(
    source,
    { start: 0, end: source.indexOf('beta') + 4 },
    { type: 'fence' },
    2,
    source.indexOf('beta') + 2,
  )
  expect(result).toMatchObject({
    status: 'confirm-required',
    markdown: source,
    proposal: {
      markdown: '```\nalpha\n```\n\n```\nbeta\n```\n',
      losses: ['markdown-becomes-literal', 'markdown-becomes-literal'],
    },
  })
})

it('derives Mixed and one target-status menu from source-owned multi-block selection', () => {
  const source = '## title\n\nplain\n'
  const metadata = describeBlockAt(
    source,
    source.indexOf('title') + 2,
    source.indexOf('plain') + 2,
  )
  expect(metadata).toMatchObject({
    currentType: 'mixed',
    span: { start: 0, end: source.indexOf('plain') + 5 },
    spans: [
      { start: 0, end: '## title'.length },
      { start: source.indexOf('plain'), end: source.indexOf('plain') + 5 },
    ],
  })
  expect(metadata?.targets.find((item) => item.type === 'h2')?.status).toBe(
    'changed',
  )
  expect(metadata?.targets.find((item) => item.type === 'fence')?.status).toBe(
    'confirm-required',
  )
})

it('does not include the next block in metadata when selection ends at its start', () => {
  const source = 'alpha\n\nbeta\n'
  const metadata = describeBlockAt(source, 2, source.indexOf('beta'))
  expect(metadata).toMatchObject({
    currentType: 'paragraph',
    spans: [{ start: 0, end: 5 }],
  })
  expect(metadata?.targets.find((item) => item.type === 'h2')?.status).toBe(
    'changed',
  )
})
