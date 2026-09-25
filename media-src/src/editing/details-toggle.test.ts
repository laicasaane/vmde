import { describe, expect, it } from 'vitest'
import { transformDetailsSelection } from './details'
import { resolveDetailsBlockRange } from './details-source'

const transform = (
  markdown: string,
  startOffset: number,
  endOffset: number,
  resolved = true,
) => transformDetailsSelection({ markdown, startOffset, endOffset, resolved })

describe('details selection source transform', () => {
  it('wraps one exact LF paragraph and preserves the logical body selection', () => {
    const markdown = 'Before\n\nBody **exact**.\n\nAfter\n'
    const start = markdown.indexOf('Body')
    const end = start + 'Body **exact**.'.length
    expect(transform(markdown, start, end)).toEqual({
      status: 'wrap',
      markdown:
        'Before\n\n<details>\n<summary>Details</summary>\n\nBody **exact**.\n\n</details>\n\nAfter\n',
      startOffset: start + '<details>\n<summary>Details</summary>\n\n'.length,
      endOffset: end + '<details>\n<summary>Details</summary>\n\n'.length,
    })
  })

  it('uses CRLF for wrapper bytes without normalizing a mixed multi-block body', () => {
    const body =
      '## Heading\r\n\r\n3. three\r\n4. four\r\n\r\n```js\r\nconst x = 1\r\n```'
    const markdown = `Before\r\n\r\n${body}\r\n\r\nAfter\r\n`
    const start = markdown.indexOf('## Heading')
    const result = transform(markdown, start, start + body.length)
    expect(result.status).toBe('wrap')
    expect(result.markdown).toContain(
      `<details>\r\n<summary>Details</summary>\r\n\r\n${body}\r\n\r\n</details>`,
    )
    expect(result.markdown?.slice(result.startOffset, result.endOffset)).toBe(
      body,
    )
  })

  it('unwraps only the exact immediate body, including attributed custom summary markup', () => {
    const prefix =
      '<details open class="box">\n<summary data-x="1">Custom <b>title</b></summary>\n\n'
    const body = 'Body\n\n- item'
    const markdown = `${prefix}${body}\n\n</details>\n`
    const result = transform(
      markdown,
      prefix.length,
      prefix.length + body.length,
    )
    expect(result).toEqual({
      status: 'unwrap',
      markdown: `${body}\n`,
      startOffset: 0,
      endOffset: body.length,
    })
  })

  it('wraps a strict subset inside a broader details body instead of removing the ancestor', () => {
    const prefix = '<details>\n<summary>Outer</summary>\n\n'
    const markdown = `${prefix}First\n\nSecond\n\n</details>\n`
    const start = markdown.indexOf('Second')
    const result = transform(markdown, start, start + 'Second'.length)
    expect(result.status).toBe('wrap')
    expect(result.markdown).toContain(
      'First\n\n<details>\n<summary>Details</summary>\n\nSecond\n\n</details>\n\n</details>',
    )
  })

  it.each([
    ['collapsed', 'Body\n', 2, 2, true],
    ['unresolved', 'Body\n', 0, 4, false],
    ['partial raw wrapper', '<details>\nBody\n', 0, 9, true],
    ['closing only', 'Body\n</details>\n', 0, 15, true],
  ])('disables %s selections', (_name, markdown, start, end, resolved) => {
    expect(transform(markdown, start, end, resolved)).toEqual({
      status: 'disabled',
      markdown,
      startOffset: start,
      endOffset: end,
    })
  })

  it('does not treat details-shaped fenced text as an immediate wrapper', () => {
    const markdown =
      '```html\n<details>\n<summary>Fake</summary>\n\nbody\n\n</details>\n```\n'
    const start = markdown.indexOf('body')
    expect(transform(markdown, start, start + 4).status).toBe('wrap')
  })
})

describe('details source block-range resolver', () => {
  it('expands a partial soft-wrapped paragraph and a partial list item', () => {
    const paragraph = 'alpha line\nbeta line\n\nafter\n'
    expect(
      resolveDetailsBlockRange(
        paragraph,
        paragraph.indexOf('beta') + 1,
        paragraph.indexOf('beta') + 3,
      ),
    ).toMatchObject({
      startOffset: 0,
      endOffset: 'alpha line\nbeta line'.length,
    })

    const list = 'before\n\n1. one\n2. two\n  - nested\n\nafter\n'
    expect(
      resolveDetailsBlockRange(
        list,
        list.indexOf('two') + 1,
        list.indexOf('two') + 2,
      ),
    ).toMatchObject({
      startOffset: list.indexOf('1. one'),
      endOffset: list.indexOf('  - nested') + '  - nested'.length,
    })
  })

  it('rejects partial table cells and fenced bodies', () => {
    const table = '| a | b |\n| - | - |\n| c | d |\n'
    expect(resolveDetailsBlockRange(table, 2, 3)).toBeNull()
    const fence = '```js\nconst x = 1\n```\n'
    const start = fence.indexOf('const')
    expect(resolveDetailsBlockRange(fence, start, start + 5)).toBeNull()
    expect(
      resolveDetailsBlockRange(fence, 0, fence.lastIndexOf('```') + 3),
    ).toMatchObject({
      startOffset: 0,
      endOffset: fence.lastIndexOf('```') + 3,
    })
  })

  it('keeps Setext pairs, loose lists, pipe-less tables, and non-closing fences atomic', () => {
    const setext = 'first title line\nsecond title line\n---\n\nafter\n'
    expect(resolveDetailsBlockRange(setext, 8, 12)).toMatchObject({
      startOffset: 0,
      endOffset: setext.indexOf('---') + 3,
    })

    const loose = '1. one\n\n2. two\n   continuation\n\nafter\n'
    expect(
      resolveDetailsBlockRange(
        loose,
        loose.indexOf('two'),
        loose.indexOf('two') + 2,
      ),
    ).toMatchObject({
      startOffset: 0,
      endOffset: loose.indexOf('   continuation') + '   continuation'.length,
    })

    const table = 'name | value\n--- | ---\na | b\n'
    expect(resolveDetailsBlockRange(table, 1, 3)).toBeNull()

    const fence = '```md\ninside\n``` still source\n## still fenced\n```\n'
    const inside = fence.indexOf('still fenced')
    expect(resolveDetailsBlockRange(fence, inside, inside + 5)).toBeNull()
  })

  it.each([
    ['> quoted\nfirst lazy\nlater continuation\n\nafter\n', 'quoted'],
    ['1. item\nfirst lazy\nlater continuation\n\nafter\n', 'item'],
  ])('keeps a lazy continuation with its %s owner', (markdown) => {
    for (const needle of ['first lazy', 'later continuation']) {
      const start = markdown.indexOf(needle) + 2
      expect(
        resolveDetailsBlockRange(markdown, start, start + 3),
      ).toMatchObject({
        startOffset: 0,
        endOffset: markdown.indexOf('\n\n'),
      })
    }
  })
})
