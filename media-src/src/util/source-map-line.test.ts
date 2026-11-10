import { describe, it, expect } from 'vitest'
import {
  blockIndexForRevealLine,
  blockIndexForSourceLine,
  lineAndTextForOffset,
  lineStartOffset,
  markdownBlockRanges,
  readableLineText,
  readableSourceLines,
  sourceLineForReveal,
} from './source-map'

// Pure: offset → { line, lineText } in the SAME string. Reveal-in-source sends
// both to the host so it can match by content (robust to Vditor's on-load
// reflow) instead of trusting a raw offset across two text spaces.
describe('lineAndTextForOffset', () => {
  const md = '# Title\n\nFirst para.\nSecond para.\n'

  it('returns the line and its text for an offset', () => {
    // offset of "Second" = after "# Title\n\nFirst para.\n"
    const off = md.indexOf('Second')
    expect(lineAndTextForOffset(md, off)).toEqual({
      line: 3,
      lineText: 'Second para.',
    })
  })

  it('returns the heading line with its marker', () => {
    expect(lineAndTextForOffset(md, 2)).toEqual({
      line: 0,
      lineText: '# Title',
    })
  })

  it('clamps a negative offset to line 0', () => {
    expect(lineAndTextForOffset(md, -5).line).toBe(0)
  })

  it('clamps an out-of-range offset to the last line', () => {
    const res = lineAndTextForOffset(md, 9999)
    expect(res.line).toBe(4) // trailing empty line after the final \n
    expect(res.lineText).toBe('')
  })
})

describe('source line → Markdown block', () => {
  const md = [
    '---',
    'title: Demo',
    '---',
    '',
    '# Heading',
    '',
    'soft paragraph line one',
    'soft paragraph line two',
    '',
    '> quoted line',
    '>',
    '> quote tail',
    '',
    '- first item',
    '  - nested item',
    '    continuation',
    '',
    '| A | B |',
    '| --- | --- |',
    '| one | two |',
    '',
    '```mermaid',
    'graph TD',
    '  A --> B',
    '```',
    '',
    'Setext heading',
    '===',
    '',
    'tail',
  ].join('\n')

  it('groups front matter, soft paragraphs, quotes, lists, tables, fences, and setext headings', () => {
    expect(markdownBlockRanges(md)).toEqual([
      { startLine: 0, endLine: 2 },
      { startLine: 4, endLine: 4 },
      { startLine: 6, endLine: 7 },
      { startLine: 9, endLine: 11 },
      { startLine: 13, endLine: 15 },
      { startLine: 17, endLine: 19 },
      { startLine: 21, endLine: 24 },
      { startLine: 26, endLine: 27 },
      { startLine: 29, endLine: 29 },
    ])
  })

  it.each([
    [1, 0],
    [4, 1],
    [7, 2],
    [10, 3],
    [15, 4],
    [18, 5],
    [23, 6],
    [27, 7],
    [29, 8],
  ])('maps line %i to owning block %i', (line, block) => {
    expect(blockIndexForSourceLine(md, line)).toBe(block)
  })

  it('returns null for blank, negative, and out-of-range lines', () => {
    expect(blockIndexForSourceLine(md, 3)).toBeNull()
    expect(blockIndexForSourceLine(md, -1)).toBeNull()
    expect(blockIndexForSourceLine(md, 999)).toBeNull()
  })

  // Task 635 S3b — a link to a blank line (`notes.md:5`) still has to land somewhere: the next
  // block, or the previous one when nothing follows. A line inside a block keeps that block, so
  // a fenced-code line stays in its fence.
  it.each([
    [3, 1], // blank line after front matter -> next block (the heading)
    [5, 2], // blank line between blocks -> the block that follows
    [8, 3],
    [16, 5], // blank line -> next
    [23, 6], // inside a fenced block -> the fence itself
    [28, 8], // blank line before the last block -> the last block
  ])('reveal line %i lands on block %i', (line, block) => {
    expect(blockIndexForRevealLine(md, line)).toBe(block)
  })

  it('reveal line snaps back to the last block when only blank lines follow', () => {
    expect(blockIndexForRevealLine('# Title\n\nBody\n\n\n', 3)).toBe(1)
    expect(blockIndexForRevealLine('# Title\n\nBody\n', 3)).toBe(1)
  })

  it('reveal line returns null without any block, or for a negative or fractional line', () => {
    expect(blockIndexForRevealLine('\n\n', 1)).toBeNull()
    expect(blockIndexForRevealLine(md, -1)).toBeNull()
    expect(blockIndexForRevealLine(md, 1.5)).toBeNull()
  })

  it('keeps indented code and thematic breaks as distinct blocks', () => {
    const source = 'before\n\n    alpha\n    beta\n\n---\n\nafter'
    expect(markdownBlockRanges(source)).toEqual([
      { startLine: 0, endLine: 0 },
      { startLine: 2, endLine: 3 },
      { startLine: 5, endLine: 5 },
      { startLine: 7, endLine: 7 },
    ])
  })

  it('recovers the nearest canonical line by text after blank-line/table normalization', () => {
    const canonical =
      'start\n\n| A   | B |\n| --- | - |\n| one | two |\n\ntarget'
    expect(sourceLineForReveal(canonical, 8, 'target')).toBe(6)
    expect(sourceLineForReveal(canonical, 3, '| A | B |')).toBe(2)
    expect(sourceLineForReveal(canonical, 2, 'missing')).toBeNull()
  })
})

// Task 730 — a `#L<line>` link names a line of the file; the webview finds it again in its own
// serialization (which renumbers lists and repads tables) and in rendered text (Preview).
describe('line reveal helpers (task 730)', () => {
  it('finds a line that only reads the same when its text changed', () => {
    const canonical =
      '# T\n\n1. one\n2. two\n\n| A | B |\n| --- | --- |\n| x | y |'
    // A list the host numbers 7. and Lute renumbers 2.
    expect(sourceLineForReveal(canonical, 9, '7. two')).toBe(3)
    // Table padding differs from the canonical row.
    expect(sourceLineForReveal(canonical, 7, '|  x  |  y  |')).toBe(7)
    // A blank line keeps the exact comparison (nearest blank line).
    expect(sourceLineForReveal(canonical, 4, '')).toBe(4)
    // Text that is nowhere in the document stays unresolved.
    expect(sourceLineForReveal(canonical, 3, 'missing words')).toBeNull()
  })

  it('gives the offset of a line start, clamped past the end', () => {
    const md = 'ab\ncde\n\nf'
    expect(lineStartOffset(md, 0)).toBe(0)
    expect(lineStartOffset(md, 1)).toBe(3)
    expect(lineStartOffset(md, 2)).toBe(7)
    expect(lineStartOffset(md, 3)).toBe(8)
    expect(lineStartOffset(md, 9)).toBe(8)
  })

  it('reads a line without its block markers and inline markup', () => {
    expect(readableLineText('14. Point **fourteen** is `here`.')).toBe(
      'Point fourteen is here.',
    )
    expect(readableLineText('> - [x] quoted task')).toBe('quoted task')
    expect(readableLineText('## Heading two ##')).toBe('Heading two')
    expect(readableLineText('> [!NOTE] Title')).toBe('Title')
    expect(readableLineText('| a1 | b1 |')).toBe('a1 b1')
    expect(
      readableLineText('see [the docs](https://x.y) and ![pic](p.png)'),
    ).toBe('see the docs and')
    expect(readableLineText('keep snake_case, drop _emphasis_')).toBe(
      'keep snake_case, drop emphasis',
    )
    expect(readableLineText('a <b>bold</b> \\*star\\*')).toBe('a bold *star*')
  })

  it('reads a syntax-only line as empty', () => {
    for (const line of [
      '',
      '   ',
      '```ts',
      '~~~',
      '$$',
      '---',
      '===',
      '***',
      '| --- | :-: |',
    ])
      expect(readableLineText(line)).toBe('')
  })

  it('reads every line, keeping code verbatim and front matter content', () => {
    const md = [
      '---',
      'title: X',
      '---',
      '# Head',
      '```js',
      '  const a = 1 // **not bold**',
      '```',
      '- item',
    ].join('\n')
    expect(readableSourceLines(md)).toEqual([
      '',
      'title: X',
      '',
      'Head',
      '',
      'const a = 1 // **not bold**',
      '',
      'item',
    ])
  })

  it('treats an unclosed fence as code to the end', () => {
    expect(readableSourceLines('a\n~~~\n# not a heading')).toEqual([
      'a',
      '',
      '# not a heading',
    ])
  })
})
