import { describe, expect, it } from 'vitest'
import {
  moveMarkdownSection,
  moveSourceRange,
  scanSourceHeadings,
} from '../../src/shared/section-move'

describe('moveSourceRange', () => {
  it('moves a half-open source range before an earlier insertion and maps its start', () => {
    expect(moveSourceRange('AA[move]ZZ', { start: 2, end: 8 }, 0)).toEqual({
      status: 'ok',
      markdown: '[move]AAZZ',
      movedRange: { start: 0, end: 6 },
      mapOffset: expect.any(Function),
    })
  })

  it('moves a range after a later insertion without changing source bytes', () => {
    const result = moveSourceRange('AA[move]ZZ', { start: 2, end: 8 }, 10)
    expect(result).toMatchObject({
      status: 'ok',
      markdown: 'AAZZ[move]',
      movedRange: { start: 4, end: 10 },
    })
    if (result.status === 'ok') {
      expect(result.mapOffset(3)).toBe(5)
      expect(result.mapOffset(9)).toBe(3)
    }
  })

  it.each([
    [{ start: -1, end: 1 }, 2],
    [{ start: 2, end: 1 }, 2],
    [{ start: 0, end: 2 }, -1],
    [{ start: 0, end: 2 }, 11],
  ] as const)('rejects invalid UTF-16 offsets %#', (range, insertionOffset) => {
    expect(moveSourceRange('0123456789', range, insertionOffset)).toEqual({
      status: 'rejected',
      reason: 'invalid-offset',
    })
  })

  it.each([2, 3, 7, 8])(
    'returns no-op when insertion is inside or at the moved range (%s)',
    (insertionOffset) => {
      expect(
        moveSourceRange('AA[move]ZZ', { start: 2, end: 8 }, insertionOffset),
      ).toEqual({ status: 'noop' })
    },
  )
})

describe('moveMarkdownSection', () => {
  it('moves a multiline setext title as one heading section', () => {
    const markdown = 'First\nsecond\n======\nbody\n\nOther\n=====\n'
    expect(
      moveMarkdownSection(
        markdown,
        { start: 0, level: 1 },
        { start: markdown.indexOf('Other'), level: 1 },
        'after',
      ),
    ).toMatchObject({
      status: 'ok',
      markdown: 'Other\n=====\n\nFirst\nsecond\n======\nbody\n',
    })
  })

  it('excludes nested/container, raw-HTML, and protected fence pseudo-headings', () => {
    const markdown = [
      '# Real',
      '',
      '- item',
      '  # list fake',
      '> # quote fake',
      '    # code fake',
      '<div>',
      '# html fake',
      '</div>',
      '',
      '```js ` invalid opener',
      '# not fenced because backticks occur in info',
      '# Last',
      '',
    ].join('\n')
    expect(
      scanSourceHeadings(markdown).map((heading) => heading.start),
    ).toEqual([0, markdown.indexOf('# not fenced'), markdown.indexOf('# Last')])
  })
  it('moves a heading with all descendants after a same-level target', () => {
    const markdown = '# A\n\n## Child\nbody\n\n# B\n\n# C\n'
    expect(
      moveMarkdownSection(
        markdown,
        { start: 0, level: 1 },
        { start: markdown.indexOf('# B'), level: 1 },
        'after',
      ),
    ).toMatchObject({
      status: 'ok',
      markdown: '# B\n\n# A\n\n## Child\nbody\n\n# C\n',
    })
  })

  it('keeps trailing spaces with their source section while transferring only newlines', () => {
    const markdown = '# A\nbody  \n\n# B\nother\n'
    expect(
      moveMarkdownSection(
        markdown,
        { start: 0, level: 1 },
        { start: markdown.indexOf('# B'), level: 1 },
        'after',
      ),
    ).toMatchObject({
      status: 'ok',
      markdown: '# B\nother\n\n# A\nbody  \n',
    })
  })

  it('retains the terminal newline state when a final section moves before another', () => {
    const markdown = '# A\n\n# B'
    expect(
      moveMarkdownSection(
        markdown,
        { start: markdown.indexOf('# B'), level: 1 },
        { start: 0, level: 1 },
        'before',
      ),
    ).toMatchObject({ status: 'ok', markdown: '# B\n\n# A' })
  })

  it('preserves CRLF and surrogate-pair UTF-16 offsets through a move', () => {
    const markdown = '# 😀 A\r\n\r\n# B\r\n'
    const result = moveMarkdownSection(
      markdown,
      { start: 0, level: 1 },
      { start: markdown.indexOf('# B'), level: 1 },
      'after',
    )
    expect(result).toMatchObject({
      status: 'ok',
      markdown: '# B\r\n\r\n# 😀 A\r\n',
    })
  })

  it('accepts setext identities and skips headings inside fences and containers', () => {
    const markdown = [
      '---',
      'title: source',
      '---',
      '',
      'Alpha',
      '=====',
      '',
      '```md',
      '# fake',
      '```',
      '',
      '> ## nested',
      '',
      'Beta',
      '====',
      '',
    ].join('\n')
    expect(
      moveMarkdownSection(
        markdown,
        { start: markdown.indexOf('Beta'), level: 1 },
        { start: markdown.indexOf('Alpha'), level: 1 },
        'before',
      ),
    ).toMatchObject({
      status: 'ok',
      markdown: expect.stringMatching(
        /^---\ntitle: source\n---\n\nBeta\n====\n\nAlpha\n=====/u,
      ),
    })
  })

  it('rejects stale identities, mixed levels, and drops into the source subtree', () => {
    const markdown = '# A\n## Child\n# B\n'
    expect(
      moveMarkdownSection(
        markdown,
        { start: 0, level: 1 },
        { start: markdown.indexOf('## Child'), level: 2 },
        'before',
      ),
    ).toEqual({ status: 'rejected', reason: 'level-mismatch' })
    expect(
      moveMarkdownSection(
        markdown,
        { start: 1, level: 1 },
        { start: markdown.indexOf('# B'), level: 1 },
        'before',
      ),
    ).toEqual({ status: 'rejected', reason: 'stale-heading' })
    expect(
      moveMarkdownSection(
        markdown,
        { start: 0, level: 1 },
        { start: markdown.indexOf('## Child'), level: 1 },
        'after',
      ),
    ).toEqual({ status: 'rejected', reason: 'stale-heading' })
  })
})
