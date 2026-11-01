// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import * as proof from './sv-source-proof'
import { proveSvCaretInSpan } from './sv-source-proof'

// Task 669 (RED): SV table-format and list-normalize no longer authorize a write by line mapping.
// They prove the retained editor offsets against the acquired exact text through the Task 605
// alignment, and replace only the proven rendered region. The helpers named here do not exist yet:
// `proveSvOffsets` (offsets instead of a Range), `svRenderedBounds` (the rendered image of an exact
// span, bounds proven only) and `planSvRegionEdit` (a region edit whose replacement may come from
// CRLF exact text). They are read off the namespace so that this file compiles before they exist.
const api = proof as unknown as {
  proveSvOffsets(
    exact: string,
    text: string,
    startAt: number,
    endAt: number,
  ):
    | {
        status: 'proven'
        start: number
        end: number
        renderedStart: number
        renderedEnd: number
      }
    | { status: 'unprovable' }
  svRenderedBounds(
    exact: string,
    text: string,
    span: { start: number; end: number },
  ): { start: number; end: number } | null
  planSvRegionEdit(
    exact: string,
    result: { markdown: string; anchor: number; focus: number },
    span: { start: number; end: number },
    rendered: { start: number; end: number },
  ): { replacement: string; anchor: number; focus: number } | null
}

// Vditor's SV text is LF and ends with one appended newline; the exact host text keeps its CRLF.
const EXACT = 'x\r\n\r\n|a|b|\r\n|-|-|\r\n\r\ny\r\n'
// What Lute shows after a mode switch: the table is padded (wide, so a caret can sit inside it).
const PADDED_HEAD = '| a     | b |'
const TEXT = `x\n\n${PADDED_HEAD}\n| - | - |\n\ny\n\n`
const TABLE_START = 'x\r\n\r\n'.length
const TABLE_END = TABLE_START + '|a|b|\r\n|-|-|'.length
const TEXT_TABLE_START = 'x\n\n'.length
const TEXT_TABLE_END = TEXT_TABLE_START + `${PADDED_HEAD}\n| - | - |`.length

describe('Task 669: no SV command authorizes a write by line mapping', () => {
  test('neither SV command source uses mapCaretOffsetByLine', () => {
    for (const name of [
      'table-format-command.ts',
      'list-normalize-source-command.ts',
    ]) {
      const source = readFileSync(`media-src/src/editing/${name}`, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      expect(source, name).not.toContain('mapCaretOffsetByLine')
    }
  })
})

describe('Task 669: proveSvOffsets', () => {
  test('proves a caret after the trailing newline span and maps it across CRLF', () => {
    const at = TEXT.indexOf('y') + 1
    expect(api.proveSvOffsets(EXACT, TEXT, at, at)).toMatchObject({
      status: 'proven',
      start: EXACT.indexOf('y') + 1,
      end: EXACT.indexOf('y') + 1,
      renderedStart: at,
      renderedEnd: at,
    })
  })

  test('proves both endpoints of a range', () => {
    const from = TEXT.indexOf('y')
    expect(api.proveSvOffsets(EXACT, TEXT, from, from + 1)).toMatchObject({
      status: 'proven',
      start: EXACT.indexOf('y'),
      end: EXACT.indexOf('y') + 1,
    })
  })

  test('declines an endpoint inside normalized padding that has no exact image', () => {
    const inside = TEXT.indexOf('a') + 3
    expect(api.proveSvOffsets(EXACT, TEXT, inside, inside)).toEqual({
      status: 'unprovable',
    })
  })

  test('declines a reversed range', () => {
    const at = TEXT.indexOf('y')
    expect(api.proveSvOffsets(EXACT, TEXT, at + 1, at)).toEqual({
      status: 'unprovable',
    })
  })
})

describe('Task 669: svRenderedBounds', () => {
  test('returns the rendered image of a normalized table span', () => {
    expect(
      api.svRenderedBounds(EXACT, TEXT, { start: TABLE_START, end: TABLE_END }),
    ).toEqual({ start: TEXT_TABLE_START, end: TEXT_TABLE_END })
  })

  test('returns the rendered image of a verbatim line', () => {
    const start = EXACT.indexOf('y')
    expect(
      api.svRenderedBounds(EXACT, TEXT, { start, end: start + 1 }),
    ).toEqual({ start: TEXT.indexOf('y'), end: TEXT.indexOf('y') + 1 })
  })

  test('returns the rendered image of a renumbered list root', () => {
    const exact = 'a\r\n\r\n1. one\r\n3. two\r\n\r\nz\r\n'
    const text = 'a\n\n1. one\n3. two\n\nz\n\n'
    const start = exact.indexOf('1. one')
    const end = exact.indexOf('two') + 3
    expect(api.svRenderedBounds(exact, text, { start, end })).toEqual({
      start: text.indexOf('1. one'),
      end: text.indexOf('two') + 3,
    })
  })

  test('declines a span that ends past the exact text', () => {
    expect(
      api.svRenderedBounds(EXACT, TEXT, {
        start: TABLE_START,
        end: EXACT.length + 5,
      }),
    ).toBeNull()
  })

  test('declines when a bound character differs between the exact and the rendered text', () => {
    const edited = TEXT.replace('| - | - |', '| - | - ¦')
    expect(
      api.svRenderedBounds(EXACT, edited, {
        start: TABLE_START,
        end: TABLE_END,
      }),
    ).toBeNull()
  })
})

describe('Task 669: planSvRegionEdit', () => {
  const EXACT_TABLE = 'x\r\n\r\n|a|b|\r\n|-|-|\r\n\r\ny\r\n'
  const FORMATTED_TABLE = '| a | b |\r\n| - | - |'
  const result = (markdown: string, anchor: number, focus: number) => ({
    markdown,
    anchor,
    focus,
  })
  const markdown = `${EXACT_TABLE.slice(0, TABLE_START)}${FORMATTED_TABLE}${EXACT_TABLE.slice(TABLE_END)}`
  const rendered = { start: TEXT_TABLE_START, end: TEXT_TABLE_END }

  test('uses an LF replacement and counts removed carriage returns in the carets', () => {
    // First caret on the first formatted line, second caret after the CR of the first line break.
    const anchor = TABLE_START + 2
    const focus = TABLE_START + '| a | b |\r\n'.length + 2
    expect(
      api.planSvRegionEdit(
        EXACT_TABLE,
        result(markdown, anchor, focus),
        { start: TABLE_START, end: TABLE_END },
        rendered,
      ),
    ).toEqual({
      replacement: '| a | b |\n| - | - |',
      anchor: TEXT_TABLE_START + 2,
      focus: TEXT_TABLE_START + '| a | b |\n'.length + 2,
    })
  })

  test('declines when a byte outside the span changes', () => {
    expect(
      api.planSvRegionEdit(
        EXACT_TABLE,
        result(markdown.replace('y', 'z'), TABLE_START, TABLE_START),
        { start: TABLE_START, end: TABLE_END },
        rendered,
      ),
    ).toBeNull()
  })

  test('declines a region edge that would split a CR/LF pair', () => {
    expect(
      api.planSvRegionEdit(
        'x\r\ny',
        result('x\r\nY', 3, 3),
        { start: 2, end: 4 },
        { start: 2, end: 3 },
      ),
    ).toBeNull()
  })

  test('declines a caret outside the replaced region', () => {
    expect(
      api.planSvRegionEdit(
        EXACT_TABLE,
        result(markdown, 0, TABLE_START),
        { start: TABLE_START, end: TABLE_END },
        rendered,
      ),
    ).toBeNull()
  })
})

// Task 681: a caret in a padded table cell has no exact image, so `proveSvOffsets` declines it. The
// command snaps it to the nearest proven offset inside its own cell; this helper does the search.
describe('Task 681: proveSvCaretInSpan', () => {
  // `| a     | b |`: the cell of "a" spans the offsets between its pipes. Only the offset after the
  // left pipe and the one after the text are proven; all of the padding is not.
  const pipe = TEXT_TABLE_START
  const cell = { start: pipe + 1, end: pipe + PADDED_HEAD.indexOf('|', 1) }
  const afterPipe = pipe + 1
  const afterText = pipe + 3

  const snapped = (at: number, span = cell) =>
    proveSvCaretInSpan(EXACT, TEXT, at, span)

  test('keeps an offset that is already proven', () => {
    expect(snapped(afterText)).toMatchObject({
      status: 'proven',
      start: TABLE_START + 2,
      end: TABLE_START + 2,
      renderedStart: afterText,
      renderedEnd: afterText,
    })
  })

  test('snaps the left padding to the offset after the left pipe, on a tie to the lower one', () => {
    // Between the padding space and "a": one character from either proven offset.
    expect(snapped(pipe + 2)).toMatchObject({
      status: 'proven',
      start: TABLE_START + 1,
      end: TABLE_START + 1,
      renderedStart: afterPipe,
      renderedEnd: afterPipe,
    })
  })

  test('snaps the right padding to the offset after the cell text', () => {
    for (const at of [pipe + 4, pipe + 6, cell.end]) {
      expect(snapped(at), `at ${at - pipe}`).toMatchObject({
        status: 'proven',
        start: TABLE_START + 2,
        renderedStart: afterText,
        renderedEnd: afterText,
      })
    }
  })

  test('snaps an empty cell to the offset after its left pipe', () => {
    const exact = 'p\r\n\r\n|a||\r\n|-|-|\r\n\r\ny\r\n'
    const text = 'p\n\n| a |   |\n| - | - |\n\ny\n\n'
    const left = text.indexOf('|   |') + 1
    expect(
      proveSvCaretInSpan(exact, text, left + 2, { start: left, end: left + 3 }),
    ).toMatchObject({
      status: 'proven',
      start: exact.indexOf('||') + 1,
      renderedStart: left,
    })
  })

  test('declines a caret outside the span, never snapping into another cell', () => {
    const next = { start: pipe + 10, end: pipe + 11 }
    expect(snapped(pipe + 6, next)).toEqual({ status: 'unprovable' })
    expect(snapped(cell.end + 2)).toEqual({ status: 'unprovable' })
  })

  test('declines a span that holds no proven offset', () => {
    expect(snapped(pipe + 8, { start: pipe + 4, end: pipe + 8 })).toEqual({
      status: 'unprovable',
    })
  })
})
