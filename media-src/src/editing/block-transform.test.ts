import { describe, expect, it } from 'vitest'
import {
  blockTransform,
  describeBlockAt,
  locateBlockSpan,
  planBlockTransform,
  type BlockType,
} from './block-transform'

const BLOCKS: Record<BlockType, string> = {
  paragraph: 'alpha **beta**',
  h1: '# alpha **beta**',
  h2: '## alpha **beta**',
  h3: '### alpha **beta**',
  h4: '#### alpha **beta**',
  h5: '##### alpha **beta**',
  h6: '###### alpha **beta**',
  quote: '> alpha **beta**',
  bullet: '- alpha **beta**',
  ordered: '3. alpha **beta**',
  task: '- [x] alpha **beta**',
  fence: '```js\nalpha **beta**\n```',
  callout: '> [!NOTE] Title\n> alpha **beta**',
}
const TYPES = Object.keys(BLOCKS) as BlockType[]

function expectedStatus(from: BlockType, to: BlockType) {
  if (from === to) return 'noop'
  if (from === 'fence' || to === 'fence') return 'confirm-required'
  if (from === 'callout' && to !== 'quote') return 'confirm-required'
  return 'changed'
}

describe('Task 298 block transform pair matrix', () => {
  for (const from of TYPES) {
    for (const to of TYPES) {
      it(`${from} → ${to} has an explicit result`, () => {
        const source = BLOCKS[from]
        const caret = source.indexOf('beta') + 2
        const result = blockTransform(source, { type: to }, caret, caret)
        expect(result.currentType).toBe(from)
        expect(result.status).toBe(expectedStatus(from, to))
        if (result.status === 'changed') {
          expect(result.markdown).toContain('alpha **beta**')
          expect(result.anchor).toBeGreaterThanOrEqual(0)
          expect(result.focus).toBe(result.anchor)
          const repeat = blockTransform(
            result.markdown,
            { type: to },
            result.anchor,
            result.focus,
          )
          expect(repeat.currentType).toBe(to)
          expect(repeat.status).toBe('noop')
        } else {
          expect(result.markdown).toBe(source)
        }
      })
    }
  }
})

it('splices only an exact source span and maps a backward selection without changing CRLF prose', () => {
  const document = 'before\r\n\r\n- alpha **beta**\r\n\r\nafter\r\n'
  const start = document.indexOf('- alpha')
  const end = start + '- alpha **beta**'.length
  const anchor = start + 14
  const focus = start + 5
  const result = planBlockTransform(
    document,
    { start, end },
    { type: 'quote' },
    anchor,
    focus,
  )
  expect(result.status).toBe('changed')
  expect(result.markdown).toBe(
    'before\r\n\r\n> alpha **beta**\r\n\r\nafter\r\n',
  )
  expect(result.anchor).toBeGreaterThan(result.focus)
  expect(result.markdown.slice(0, result.focus)).toContain('> alp')
})

it.each([
  '| h | v |\n| - | - |',
  '<div>raw HTML</div>',
  '---',
  '$$\na+b\n$$',
  '- parent\n  - nested',
  '- first\n- second',
  '3. first\n   ```js\n   code\n   ```',
  '> [!UNKNOWN]\n> body',
])(
  'declines unsupported or ambiguous ownership without mutation: %s',
  (source) => {
    const result = blockTransform(source, { type: 'paragraph' }, 2, 2)
    expect(result.status).toBe('unsupported')
    expect(result.markdown).toBe(source)
  },
)

it('removes only a callout marker when turning into a quote', () => {
  const source = '> [!NOTE]- Title\n> body **exact**\n>\n> second'
  const result = blockTransform(
    source,
    { type: 'quote' },
    source.indexOf('body'),
    source.indexOf('body'),
  )
  expect(result.status).toBe('changed')
  expect(result.markdown).toBe('> body **exact**\n>\n> second')
})

it('preserves quote body lines when turning into prose', () => {
  const source = '> first **line**\n>\n> second line'
  const result = blockTransform(
    source,
    { type: 'paragraph' },
    source.indexOf('second'),
    source.indexOf('second'),
  )
  expect(result.status).toBe('changed')
  expect(result.markdown).toBe('first **line**\n\nsecond line')
})

it('keeps risky fence and callout edges non-mutating until a confirmation policy exists', () => {
  const toFence = blockTransform(
    'plain',
    { type: 'fence', language: 'ts' },
    2,
    2,
  )
  expect(toFence).toMatchObject({
    status: 'confirm-required',
    markdown: 'plain',
  })
  const fromCallout = blockTransform(
    '> [!TIP] Title\n> body',
    { type: 'h2' },
    20,
    20,
  )
  expect(fromCallout).toMatchObject({
    status: 'confirm-required',
    markdown: '> [!TIP] Title\n> body',
  })
})

it('preserves CRLF while converting a multi-line quote to prose and a prose block to a callout', () => {
  const quoted = '> first **line**\r\n> second line'
  const unquoted = blockTransform(
    quoted,
    { type: 'paragraph' },
    quoted.indexOf('second'),
    quoted.indexOf('second'),
  )
  expect(unquoted).toMatchObject({
    status: 'changed',
    markdown: 'first **line**\r\nsecond line',
  })
  const callout = blockTransform(
    'first **line**\r\nsecond line',
    { type: 'callout' },
    8,
    8,
  )
  expect(callout).toMatchObject({
    status: 'changed',
    markdown: '> [!NOTE]\r\n> first **line**\r\n> second line',
  })
})

it('declines a source span inside a fence even when the selected line looks like prose', () => {
  const document = 'before\n\n```ts\nalpha\n```\n\nafter\n'
  const start = document.indexOf('alpha')
  const result = planBlockTransform(
    document,
    { start, end: start + 5 },
    { type: 'h2' },
    start + 2,
    start + 2,
  )
  expect(result).toMatchObject({ status: 'unsupported', markdown: document })
})

it('declines an indented-code source block instead of treating it as paragraph prose', () => {
  const source = '    alpha **beta**'
  expect(blockTransform(source, { type: 'quote' }, 8, 8)).toMatchObject({
    status: 'unsupported',
    markdown: source,
  })
})

it.each([
  ['> ```ts\n> alpha\n> ```\n', '> alpha'],
  ['<div>\nalpha\n</div>\n', 'alpha'],
  ['<!--\nalpha\n-->\n', 'alpha'],
  ['$$\nalpha\n$$\n', 'alpha'],
  ['---\ntitle: alpha\n---\n', 'title: alpha'],
])(
  'declines a paragraph-looking span inside a protected container: %s',
  (document, line) => {
    const start = document.indexOf(line)
    const end = start + line.length
    const result = planBlockTransform(
      document,
      { start, end },
      { type: 'h2' },
      start + 2,
      start + 2,
    )
    expect(result).toMatchObject({ status: 'unsupported', markdown: document })
  },
)

it('reindents a plain list continuation when converting a single item to ordered', () => {
  const source = '- alpha **beta**\n  continuation'
  const result = blockTransform(
    source,
    { type: 'ordered' },
    source.indexOf('beta'),
    source.indexOf('beta'),
  )
  expect(result).toMatchObject({
    status: 'changed',
    markdown: '1. alpha **beta**\n   continuation',
  })
})

it('uses the shared Task 527 marker transform for a callout type change', () => {
  const source = '> [!NOTE]- Title\n> body **exact**'
  const offset = source.indexOf('body')
  const result = blockTransform(
    source,
    { type: 'callout', calloutType: 'warning' },
    offset,
    offset,
  )
  expect(result).toMatchObject({
    status: 'changed',
    markdown: '> [!WARNING]- Title\n> body **exact**',
  })
})

it('rejects a span that splits CRLF between its carriage return and line feed', () => {
  const document = 'before\r\nalpha\r\nafter\r\n'
  const start = document.indexOf('alpha') - 1
  const result = planBlockTransform(
    document,
    { start, end: start + 6 },
    { type: 'h2' },
    start + 2,
    start + 2,
  )
  expect(result).toMatchObject({ status: 'unsupported', markdown: document })
})

it('rejects a line that is only part of an adjacent prose paragraph', () => {
  const document = 'alpha\nbeta\n'
  const start = document.indexOf('beta')
  const result = planBlockTransform(
    document,
    { start, end: start + 4 },
    { type: 'h2' },
    start + 2,
    start + 2,
  )
  expect(result).toMatchObject({ status: 'unsupported', markdown: document })
})

it('keeps a selected word anchored after Task 527 inserts a CRLF callout marker', () => {
  const source = 'first **line**\r\nsecond line'
  const offset = source.indexOf('second') + 3
  const result = blockTransform(source, { type: 'callout' }, offset, offset)
  expect(result.status).toBe('changed')
  expect(result.markdown.slice(result.anchor - 3, result.anchor + 3)).toBe(
    'second',
  )
})

it('uses Task 527 empty-block insertion for an empty paragraph to callout', () => {
  const result = blockTransform('', { type: 'callout' }, 0, 0)
  expect(result).toMatchObject({
    status: 'changed',
    currentType: 'paragraph',
    markdown: '> [!NOTE]\n> ',
    anchor: 12,
    focus: 12,
  })
})

it('declines a quote line when another quote line owns the same root', () => {
  const document = '> first\n> second\n'
  const start = document.indexOf('> second')
  const result = planBlockTransform(
    document,
    { start, end: start + 8 },
    { type: 'paragraph' },
    start + 3,
    start + 3,
  )
  expect(result).toMatchObject({ status: 'unsupported', markdown: document })
})

describe('Task 298 exact source owner location', () => {
  it.each([
    [
      'paragraph',
      'before\n\nalpha **beta**\r\nsoft line\n\nafter\n',
      'beta',
      'alpha **beta**\r\nsoft line',
    ],
    [
      'heading',
      'before\n\n## alpha **beta**\n\nafter\n',
      'beta',
      '## alpha **beta**',
    ],
    [
      'quote',
      'before\n\n> first\n> second **beta**\n\nafter\n',
      'beta',
      '> first\n> second **beta**',
    ],
    [
      'list item',
      'before\n\n- alpha\n  continuation **beta**\n\nafter\n',
      'beta',
      '- alpha\n  continuation **beta**',
    ],
    [
      'fence',
      'before\n\n```ts\nconst beta = 1\n```\n\nafter\n',
      'beta',
      '```ts\nconst beta = 1\n```',
    ],
  ])(
    'locates one complete %s by offsets',
    (_label, markdown, needle, expected) => {
      const offset = markdown.indexOf(needle) + 2
      const span = locateBlockSpan(markdown, offset, offset)
      expect(span).not.toBeNull()
      expect(markdown.slice(span!.start, span!.end)).toBe(expected)
    },
  )

  it('declines nested and cross-block selections rather than guessing a root', () => {
    const nested = '- parent\n  - child\n'
    expect(
      locateBlockSpan(nested, nested.indexOf('child'), nested.indexOf('child')),
    ).toBeNull()
    const multiple = 'alpha\n\nbeta\n'
    expect(
      locateBlockSpan(multiple, 2, multiple.indexOf('beta') + 2),
    ).toBeNull()
  })

  it('uses the selected occurrence when two blocks have identical content', () => {
    const markdown = 'alpha\n\nalpha\n'
    const second = markdown.lastIndexOf('alpha') + 2
    expect(locateBlockSpan(markdown, second, second)).toEqual({
      start: markdown.lastIndexOf('alpha'),
      end: markdown.lastIndexOf('alpha') + 5,
    })
  })
})

it('derives current type and target availability from the exact source owner', () => {
  const markdown = 'before\n\n## alpha **beta**\n\nafter\n'
  const caret = markdown.indexOf('beta') + 2
  const metadata = describeBlockAt(markdown, caret, caret)
  expect(metadata).toMatchObject({
    currentType: 'h2',
    span: {
      start: markdown.indexOf('## alpha'),
      end: markdown.indexOf('## alpha') + '## alpha **beta**'.length,
    },
  })
  expect(metadata?.targets.find((target) => target.type === 'h2')?.status).toBe(
    'noop',
  )
  expect(
    metadata?.targets.find((target) => target.type === 'quote')?.status,
  ).toBe('changed')
  expect(
    metadata?.targets.find((target) => target.type === 'fence')?.status,
  ).toBe('confirm-required')
})

it('offers no target metadata for protected or cross-block selection', () => {
  expect(describeBlockAt('<div>\nalpha\n</div>\n', 8, 8)).toBeNull()
  expect(describeBlockAt('alpha\n\nbeta\n', 2, 10)).toBeNull()
})

it('offers callout insertion for an empty source block between paragraphs', () => {
  const markdown = 'before\n\nnext\n'
  const empty = markdown.indexOf('\n\n') + 1
  const metadata = describeBlockAt(markdown, empty, empty)
  expect(metadata?.currentType).toBe('paragraph')
  expect(metadata?.span).toEqual({ start: empty, end: empty })
  const result = planBlockTransform(
    markdown,
    metadata!.span,
    { type: 'callout' },
    empty,
    empty,
  )
  expect(result.status).toBe('changed')
  expect(result.markdown).toBe('before\n> [!NOTE]\n> \nnext\n')
})
