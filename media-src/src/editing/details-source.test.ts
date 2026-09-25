import { describe, expect, it } from 'vitest'
import { transformDetailsSelection } from './details'
import {
  buildDetailsSourceIndex,
  classifyDetailsSelection,
  resolveDetailsBlockRange,
  resolveDetailsBlockRangeIn,
} from './details-source'

// Task 574: passive Details display state uses `classifyDetailsSelection` over a per-document
// index. It must return the transform's status for every selection, and a reused index must
// resolve exactly like a freshly built one.
const DOCUMENTS: Record<string, string> = {
  mixed: [
    'Intro paragraph',
    'soft wrapped | with a pipe',
    '',
    '- item one',
    '  continued',
    '- item two',
    '',
    '  loose paragraph',
    '',
    '```js',
    'const x = 1',
    '```',
    '',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    'Setext',
    '======',
    '',
    '> quote',
    '> lazy',
    '',
    '---',
    '',
    'Tail',
    '',
  ].join('\n'),
  details: [
    'Before',
    '',
    '<details>',
    '<summary>Outer <b>custom</b></summary>',
    '',
    'Outer body',
    '',
    '<details open>',
    '<summary>Inner</summary>',
    '',
    'Inner body one',
    'Inner body two',
    '',
    '</details>',
    '',
    'Outer tail',
    '',
    '</details>',
    '',
    '<details><details>',
    '<summary>Coalesced</summary>',
    '',
    'Coalesced body',
    '',
    '</details></details>',
    '',
    '<details>',
    '<summary>Unclosed</summary>',
    '',
    'Orphan body',
    '',
    '```html',
    '<details>',
    '```',
    '',
    'After',
    '',
  ].join('\n'),
}
DOCUMENTS.crlf = DOCUMENTS.details.replace(/\n/gu, '\r\n')
DOCUMENTS.mixedCrlf = DOCUMENTS.mixed.replace(/\n/gu, '\r\n')

function offsetsFor(markdown: string): number[] {
  const offsets = new Set<number>([0, markdown.length])
  for (const match of markdown.matchAll(/\r\n|\n|\r/gu)) {
    offsets.add(match.index)
    offsets.add(match.index + match[0].length)
  }
  for (let offset = 0; offset < markdown.length; offset += 7)
    offsets.add(offset)
  return [...offsets].sort((a, b) => a - b)
}

/** Check one grid selection; returns the resolved status, or null when the resolver rejects it. */
function checkSelection(
  markdown: string,
  index: ReturnType<typeof buildDetailsSourceIndex>,
  start: number,
  end: number,
): string | null {
  const resolved = resolveDetailsBlockRangeIn(index, start, end)
  expect(resolved).toEqual(resolveDetailsBlockRange(markdown, start, end))
  expect(classifyDetailsSelection(index, start, end)).toBe(
    transformDetailsSelection({
      markdown,
      startOffset: start,
      endOffset: end,
      resolved: true,
    }).status,
  )
  if (!resolved) return null
  const status = classifyDetailsSelection(
    index,
    resolved.startOffset,
    resolved.endOffset,
  )
  expect(status).toBe(
    transformDetailsSelection({ ...resolved, resolved: true }).status,
  )
  return status
}

/** Every status the grid produced for one document. */
function gridStatuses(markdown: string): string[] {
  const index = buildDetailsSourceIndex(markdown)
  const offsets = offsetsFor(markdown)
  const statuses = new Set<string>()
  for (const [position, start] of offsets.entries())
    for (const end of offsets.slice(position)) {
      const status = checkSelection(markdown, index, start, end)
      if (status) statuses.add(status)
    }
  return [...statuses].sort()
}

// The grid must exercise every status a document can produce, or parity would be vacuous.
const EXPECTED_STATUSES: Record<string, string[]> = {
  mixed: ['disabled', 'wrap'],
  mixedCrlf: ['disabled', 'wrap'],
  details: ['disabled', 'unwrap', 'wrap'],
  crlf: ['disabled', 'unwrap', 'wrap'],
}

describe('Details source index parity', () => {
  for (const [name, markdown] of Object.entries(DOCUMENTS))
    it(`classifies and resolves every grid selection like the transform (${name})`, () => {
      expect(gridStatuses(markdown)).toEqual(EXPECTED_STATUSES[name])
    })

  it('finds the containing line by binary search at every line boundary', () => {
    const markdown = DOCUMENTS.mixedCrlf
    const index = buildDetailsSourceIndex(markdown)
    for (const [lineIndex, line] of index.lines.entries()) {
      if (!line.text.trim() || line.text.includes('|')) continue
      if (
        index.fences.some(
          ([open, close]) => lineIndex >= open && lineIndex <= close,
        )
      )
        continue
      const role = /^\s*(?:[-+*]|\d+[.)])\s+|^\s*>|^ {0,3}#|^`{3}|^---$|^=+$/u
      if (role.test(line.text)) continue
      const resolved = resolveDetailsBlockRangeIn(index, line.start, line.end)
      expect(resolved, `line ${lineIndex}`).not.toBeNull()
      expect(resolved!.startOffset).toBeLessThanOrEqual(line.start)
      expect(resolved!.endOffset).toBeGreaterThanOrEqual(line.end)
    }
  })

  it('unwraps a whole immediate body and wraps a strict subset of a broader body', () => {
    const markdown = DOCUMENTS.details
    const index = buildDetailsSourceIndex(markdown)
    const start = markdown.indexOf('Inner body one')
    // A partial first line expands to the whole two-line paragraph, which is the immediate body.
    const partial = resolveDetailsBlockRangeIn(index, start, start + 5)!
    expect(markdown.slice(partial.startOffset, partial.endOffset)).toBe(
      'Inner body one\nInner body two',
    )
    expect(
      classifyDetailsSelection(index, partial.startOffset, partial.endOffset),
    ).toBe('unwrap')
    const outer = markdown.indexOf('Outer body')
    const subset = resolveDetailsBlockRangeIn(index, outer, outer + 3)!
    expect(
      classifyDetailsSelection(index, subset.startOffset, subset.endOffset),
    ).toBe('wrap')
  })
})
