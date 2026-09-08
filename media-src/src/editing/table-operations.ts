import { FENCE } from '../../../src/shared/md-scan'

type Direction = 'left' | 'right' | 'up' | 'down'
export type TableMove =
  | 'moveColumnLeft'
  | 'moveColumnRight'
  | 'moveRowUp'
  | 'moveRowDown'

export type TableRectangleOperation =
  | 'insertRowAbove'
  | 'insertRowBelow'
  | 'insertColumnLeft'
  | 'insertColumnRight'
  | 'deleteRows'
  | 'deleteColumns'

interface SourceLine {
  text: string
  ending: string
}

interface ParsedRow {
  cells: string[]
  starts: number[]
  ends: number[]
  line: SourceLine
}

export interface TableCellLocation {
  row: number
  column: number
  offset: number
}

function splitLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = []
  const matcher = /([^\r\n]*)(\r\n|\n|\r|$)/gu
  for (;;) {
    const match = matcher.exec(markdown)
    if (!match || match[0] === '') return lines
    lines.push({ text: match[1], ending: match[2] })
    if (!match[2]) return lines
  }
}

function pipeOffsets(line: string): number[] {
  const offsets: number[] = []
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== '|') continue
    let slashes = 0
    for (let before = index - 1; before >= 0 && line[before] === '\\'; before--)
      slashes++
    if (slashes % 2 === 0) offsets.push(index)
  }
  return offsets
}

function parseRow(line: SourceLine | undefined): ParsedRow | null {
  if (!line) return null
  const pipes = pipeOffsets(line.text)
  if (!pipes.length) return null
  const first = pipes[0]
  const last = pipes.at(-1)
  if (last === undefined) return null
  const leadingOuter = line.text.slice(0, first).trim() === ''
  const trailingOuter = line.text.slice(last + 1).trim() === ''
  const delimiters = pipes.slice(
    leadingOuter ? 1 : 0,
    trailingOuter ? -1 : undefined,
  )
  const cells: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  let start = leadingOuter ? first + 1 : 0
  for (const delimiter of delimiters) {
    const end = delimiter
    cells.push(line.text.slice(start, end))
    starts.push(start)
    ends.push(end)
    start = delimiter + 1
  }
  const end = trailingOuter ? last : line.text.length
  cells.push(line.text.slice(start, end))
  starts.push(start)
  ends.push(end)
  return { cells, starts, ends, line }
}

function parseTable(markdown: string): ParsedRow[] | null {
  const rows = splitLines(markdown).map(parseRow)
  if (rows.some((row) => !row)) return null
  const parsed = rows as ParsedRow[]
  const width = parsed[0]?.cells.length
  const delimiter = parsed[1]
  if (
    !width ||
    parsed.length < 2 ||
    parsed.some((row) => row.cells.length !== width) ||
    !delimiter.cells.every((cell) => /^\s*:?-+:?\s*$/u.test(cell))
  ) {
    return null
  }
  return parsed
}

function renderRow(row: ParsedRow): string {
  let text = ''
  let cursor = 0
  for (let index = 0; index < row.cells.length; index++) {
    text += row.line.text.slice(cursor, row.starts[index]) + row.cells[index]
    cursor = row.ends[index]
  }
  return text + row.line.text.slice(cursor)
}

function renderTable(rows: ParsedRow[]): string {
  return rows.map((row) => `${renderRow(row)}${row.line.ending}`).join('')
}

function renderChangedRow(row: ParsedRow): string {
  // A one-column GFM table without outer pipes is indistinguishable from ordinary prose/Setext
  // syntax. Structural deletion therefore makes the remaining column explicit.
  if (row.cells.length === 1) return `|${row.cells[0]}|${row.line.ending}`
  const prefix = row.line.text.slice(0, row.starts[0])
  const suffix = row.line.text.slice(row.ends.at(-1))
  return `${prefix}${row.cells.join('|')}${suffix}${row.line.ending}`
}

function renderChangedTable(rows: ParsedRow[]): string {
  return rows.map(renderChangedRow).join('')
}

function isProtectedTableContext(line: string): boolean {
  return (
    /^ {4}/u.test(line) ||
    /^ {0,3}>/u.test(line) ||
    /^\s*(?:[-+*]|\d+[.)])\s+/u.test(line)
  )
}

function isProtectedContinuation(lines: SourceLine[], index: number): boolean {
  if (!/^ {2,3}(?:\||\S.*\|)/u.test(lines[index]?.text ?? '')) return false
  for (let previous = index - 1; previous >= 0; previous--) {
    const text = lines[previous]!.text
    // A blank line is permitted inside a list/quote continuation. Keep walking its indented
    // source context so a table cannot escape the container merely by inserting that blank.
    if (!text.trim()) continue
    if (/^ {0,3}>/u.test(text) || /^ {0,3}(?:[-+*]|\d+[.)])\s+/u.test(text))
      return true
    if (!/^ {2,3}/u.test(text)) break
  }
  return false
}

const HTML_VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

function htmlBlockStart(line: string): string | 'blank' | null {
  const match = /^\s*<([a-z][\w-]*)\b[^>]*>/iu.exec(line)
  if (!match || /<\/[a-z][\w-]*\s*>/iu.test(line)) return null
  const tag = match[1]!.toLowerCase()
  // These forms have no closing tag, but a Markdown HTML block still owns following source
  // lines until its blank-line terminator. Do not mistake their lack of an end tag for no block.
  return HTML_VOID_ELEMENTS.has(tag) || /\/\s*>\s*$/u.test(line) ? 'blank' : tag
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one fence-aware scan keeps source table boundaries and protected-context rejection in lockstep.
function sourceTableRanges(
  markdown: string,
): Array<{ start: number; end: number }> {
  const lines = splitLines(markdown)
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.text.length + line.ending.length
  }
  const ranges: Array<{ start: number; end: number }> = []
  let fence: { marker: '`' | '~'; length: number } | null = null
  let htmlBlock: string | 'blank' | null = null
  let comment = false
  for (let index = 0; index < lines.length; ) {
    const current = lines[index]!.text
    // Raw HTML and comments own their contents; fence-looking text inside either is literal.
    if (comment) {
      if (current.includes('-->')) comment = false
      index++
      continue
    }
    if (htmlBlock) {
      if (!current.trim()) htmlBlock = null
      else if (
        htmlBlock !== 'blank' &&
        new RegExp(`</${htmlBlock}\\s*>`, 'iu').test(current)
      )
        htmlBlock = null
      index++
      continue
    }
    const fenceMatch = FENCE.exec(current)
    // Fence state has priority only after active HTML/comment state was excluded. An HTML-looking
    // line inside a fence remains literal code and cannot open an HTML block.
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~'
      if (fence === null) fence = { marker, length: fenceMatch[1].length }
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length)
        fence = null
      index++
      continue
    }
    if (fence !== null) {
      index++
      continue
    }
    if (current.includes('<!--')) {
      comment = !current.includes('-->')
      index++
      continue
    }
    htmlBlock = htmlBlockStart(current)
    if (htmlBlock) {
      index++
      continue
    }
    if (
      isProtectedTableContext(current) ||
      isProtectedContinuation(lines, index)
    ) {
      index++
      continue
    }
    const header = parseRow(lines[index]!)
    const delimiter = parseRow(lines[index + 1]!)
    if (
      !header ||
      !delimiter ||
      header.cells.length !== delimiter.cells.length ||
      !delimiter.cells.every((cell) => /^\s*:?-+:?\s*$/u.test(cell))
    ) {
      index++
      continue
    }
    let end = index + 2
    while (end < lines.length) {
      const line = lines[end]!
      if (
        isProtectedTableContext(line.text) ||
        isProtectedContinuation(lines, end) ||
        FENCE.test(line.text)
      )
        break
      const body = parseRow(line)
      if (!body || body.cells.length !== header.cells.length) break
      end++
    }
    const source = lines
      .slice(index, end)
      .map((line) => `${line.text}${line.ending}`)
      .join('')
    if (parseTable(source)) {
      ranges.push({
        start: starts[index],
        end:
          starts[end - 1] +
          lines[end - 1].text.length +
          lines[end - 1].ending.length,
      })
      index = end
    } else {
      index++
    }
  }
  return ranges
}

/** Returns the one ordinary GFM table wholly containing a source selection, if it is safe to edit. */
export function sourceTableRangeAtSelection(
  markdown: string,
  startOffset: number,
  endOffset: number,
): { start: number; end: number } | null {
  if (
    startOffset < 0 ||
    endOffset < startOffset ||
    endOffset > markdown.length
  ) {
    return null
  }
  return (
    sourceTableRanges(markdown).find(
      (range) => startOffset >= range.start && endOffset <= range.end,
    ) ?? null
  )
}

/** Maps one table-local rendered selection back to its same-ordinal exact-source table. */
export function mapRenderedTableSelectionToSource(
  renderedMarkdown: string,
  exactMarkdown: string,
  startOffset: number,
  endOffset: number,
): { startOffset: number; endOffset: number } | null {
  const renderedRanges = sourceTableRanges(renderedMarkdown)
  const renderedIndex = renderedRanges.findIndex(
    (range) => startOffset >= range.start && endOffset <= range.end,
  )
  const renderedRange = renderedRanges[renderedIndex]
  const exactRange = sourceTableRanges(exactMarkdown)[renderedIndex]
  if (!renderedRange || !exactRange) return null
  const rendered = renderedMarkdown.slice(
    renderedRange.start,
    renderedRange.end,
  )
  const exact = exactMarkdown.slice(exactRange.start, exactRange.end)
  const start = tableCellLocationAtOffset(
    rendered,
    startOffset - renderedRange.start,
  )
  const end = tableCellLocationAtOffset(
    rendered,
    endOffset - renderedRange.start,
  )
  if (!start || !end) return null
  const exactStart = tableCellOffsetForLocation(exact, start)
  const exactEnd = tableCellOffsetForLocation(exact, end)
  if (exactStart === null || exactEnd === null) return null
  return {
    startOffset: exactRange.start + exactStart,
    endOffset: exactRange.start + exactEnd,
  }
}

function trimmedCellBounds(
  row: ParsedRow,
  column: number,
): { start: number; end: number } | null {
  const rawStart = row.starts[column]
  const rawEnd = row.ends[column]
  if (rawStart === undefined || rawEnd === undefined) return null
  let start = rawStart
  let end = rawEnd
  while (start < end && /[ \t]/u.test(row.line.text[start]!)) start++
  while (end > start && /[ \t]/u.test(row.line.text[end - 1]!)) end--
  return { start, end }
}

/** Locates a source offset inside a table cell's authored content, excluding pipes and padding. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: maps every authored, padded and outer-pipe caret edge through the same parsed table rows.
export function tableCellLocationAtOffset(
  markdown: string,
  offset: number,
): TableCellLocation | null {
  const rows = parseTable(markdown)
  if (!rows || offset < 0 || offset > markdown.length) return null
  let lineStart = 0
  for (const [rowIndex, row] of rows.entries()) {
    for (let column = 0; column < row.cells.length; column++) {
      const bounds = trimmedCellBounds(row, column)
      if (!bounds) continue
      const rawStart = row.starts[column]
      const rawEnd = row.ends[column]
      if (rawStart === undefined || rawEnd === undefined) continue
      const start = lineStart + rawStart
      const end = lineStart + rawEnd
      if (column === 0 && offset === start - 1) {
        return { row: rowIndex, column, offset: 0 }
      }
      if (offset >= start && offset <= end) {
        return {
          row: rowIndex,
          column,
          offset: Math.max(
            0,
            Math.min(
              offset - (lineStart + bounds.start),
              bounds.end - bounds.start,
            ),
          ),
        }
      }
    }
    lineStart += row.line.text.length + row.line.ending.length
  }
  return null
}

/** Restores an authored-cell position after a table-only formatter has changed padding. */
export function tableCellOffsetForLocation(
  markdown: string,
  location: TableCellLocation,
): number | null {
  const rows = parseTable(markdown)
  const row = rows?.[location.row]
  if (!row || location.column < 0 || location.offset < 0) return null
  const bounds = trimmedCellBounds(row, location.column)
  if (!bounds) return null
  const lineStart = rows
    .slice(0, location.row)
    .reduce(
      (offset, current) =>
        offset + current.line.text.length + current.line.ending.length,
      0,
    )
  return (
    lineStart +
    bounds.start +
    Math.min(location.offset, bounds.end - bounds.start)
  )
}

function sameTableCells(left: ParsedRow[], right: ParsedRow[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (row, rowIndex) =>
        row.cells.length === right[rowIndex]?.cells.length &&
        row.cells.every((cell, column) => {
          const normalize = (value: string) =>
            rowIndex === 1 ? value.trim().replace(/-+/gu, '-') : value.trim()
          return (
            normalize(cell) === normalize(right[rowIndex]?.cells[column] ?? '')
          )
        }),
    )
  )
}

/** Proves a rendered DOM-table ordinal still names the same exact-source GFM table. */
export function resolveRenderedTableIndex(
  exactMarkdown: string,
  renderedMarkdown: string,
  domOrdinal: number,
  domTableCount?: number,
): number | null {
  const exact = sourceTableRanges(exactMarkdown)
  const rendered = sourceTableRanges(renderedMarkdown)
  if (
    domOrdinal < 0 ||
    exact.length !== rendered.length ||
    (domTableCount !== undefined && exact.length !== domTableCount) ||
    !exact[domOrdinal] ||
    !rendered[domOrdinal]
  ) {
    return null
  }
  const sourceTable = parseTable(
    exactMarkdown.slice(exact[domOrdinal]!.start, exact[domOrdinal]!.end),
  )
  const renderedTable = parseTable(
    renderedMarkdown.slice(
      rendered[domOrdinal]!.start,
      rendered[domOrdinal]!.end,
    ),
  )
  return sourceTable &&
    renderedTable &&
    sameTableCells(sourceTable, renderedTable)
    ? domOrdinal
    : null
}

/** Applies one structural move to the indexed source table without touching adjacent document bytes. */
export function moveTableAt(
  markdown: string,
  tableIndex: number,
  row: number,
  column: number,
  move: TableMove,
): string | null {
  const range = sourceTableRanges(markdown)[tableIndex]
  if (!range) return null
  const table = markdown.slice(range.start, range.end)
  const next =
    move === 'moveColumnLeft'
      ? moveTableColumn(table, column, 'left')
      : move === 'moveColumnRight'
        ? moveTableColumn(table, column, 'right')
        : move === 'moveRowUp'
          ? moveTableRow(table, row + 1, 'up')
          : moveTableRow(table, row + 1, 'down')
  return next === null
    ? null
    : markdown.slice(0, range.start) + next + markdown.slice(range.end)
}

/** Clears an inclusive DOM-cell rectangle while retaining the GFM table structure. */
export function clearTableCellsAt(
  markdown: string,
  tableIndex: number,
  anchorRow: number,
  focusRow: number,
  anchorColumn: number,
  focusColumn: number,
): string | null {
  const range = sourceTableRanges(markdown)[tableIndex]
  if (!range) return null
  const table = markdown.slice(range.start, range.end)
  const rows = parseTable(table)
  if (!rows) return null
  const rowStart = Math.min(anchorRow, focusRow)
  const rowEnd = Math.max(anchorRow, focusRow)
  const columnStart = Math.min(anchorColumn, focusColumn)
  const columnEnd = Math.max(anchorColumn, focusColumn)
  for (let domRow = rowStart; domRow <= rowEnd; domRow++) {
    const sourceRow = domRow === 0 ? 0 : domRow + 1
    const row = rows[sourceRow]
    if (!row || columnEnd >= row.cells.length) return null
    for (let column = columnStart; column <= columnEnd; column++)
      row.cells[column] = ''
  }
  const next = renderTable(rows)
  return markdown.slice(0, range.start) + next + markdown.slice(range.end)
}

function sourceRowForDomRow(domRow: number): number {
  return domRow === 0 ? 0 : domRow + 1
}

function tableRectangle(
  rows: ParsedRow[],
  anchorRow: number,
  focusRow: number,
  anchorColumn: number,
  focusColumn: number,
): {
  rowStart: number
  rowEnd: number
  columnStart: number
  columnEnd: number
} | null {
  const rowStart = Math.min(anchorRow, focusRow)
  const rowEnd = Math.max(anchorRow, focusRow)
  const columnStart = Math.min(anchorColumn, focusColumn)
  const columnEnd = Math.max(anchorColumn, focusColumn)
  const width = rows[0]?.cells.length ?? 0
  if (
    rowStart < 0 ||
    rowEnd > rows.length - 2 ||
    columnStart < 0 ||
    columnEnd >= width
  ) {
    return null
  }
  return { rowStart, rowEnd, columnStart, columnEnd }
}

/** Builds a standalone GFM fragment from raw table cells, including source-only inline syntax. */
export function tableRectangleMarkdownAt(
  markdown: string,
  tableIndex: number,
  anchorRow: number,
  focusRow: number,
  anchorColumn: number,
  focusColumn: number,
): string | null {
  const range = sourceTableRanges(markdown)[tableIndex]
  if (!range) return null
  const rows = parseTable(markdown.slice(range.start, range.end))
  if (!rows) return null
  const rectangle = tableRectangle(
    rows,
    anchorRow,
    focusRow,
    anchorColumn,
    focusColumn,
  )
  if (!rectangle) return null
  const { rowStart, rowEnd, columnStart, columnEnd } = rectangle
  const cells = (sourceRow: number) =>
    rows[sourceRow]!.cells.slice(columnStart, columnEnd + 1)
  const bodyRows = Array.from({ length: rowEnd - rowStart + 1 }, (_, index) =>
    cells(sourceRowForDomRow(rowStart + index)),
  )
  const header = bodyRows.shift()
  if (!header) return null
  const delimiter =
    rowStart === 0
      ? cells(1)
      : Array.from({ length: header.length }, () => '---')
  const ending = rows[0]?.line.ending || '\n'
  return [header, delimiter, ...bodyRows]
    .map((row) => `|${row.join('|')}|`)
    .join(ending)
}

/** Applies one range-sized structural table operation without touching surrounding document bytes. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the six GFM-valid rectangle operations share one validated source-table transaction.
export function operateTableRectangleAt(
  markdown: string,
  tableIndex: number,
  anchorRow: number,
  focusRow: number,
  anchorColumn: number,
  focusColumn: number,
  operation: TableRectangleOperation,
): string | null {
  const range = sourceTableRanges(markdown)[tableIndex]
  if (!range) return null
  const rows = parseTable(markdown.slice(range.start, range.end))
  if (!rows) return null
  const rectangle = tableRectangle(
    rows,
    anchorRow,
    focusRow,
    anchorColumn,
    focusColumn,
  )
  if (!rectangle) return null
  const { rowStart, rowEnd, columnStart, columnEnd } = rectangle
  const count = columnEnd - columnStart + 1
  if (operation === 'deleteRows') {
    // Header/declaration are the irreducible GFM structure. Never turn an inclusive rectangle
    // that reaches the header into a destructive table removal; callers disable that operation.
    if (rowStart === 0) return null
    const sourceStart = sourceRowForDomRow(rowStart)
    const sourceEnd = sourceRowForDomRow(rowEnd)
    const terminalEnding = rows.at(-1)?.line.ending ?? ''
    rows.splice(sourceStart, sourceEnd - sourceStart + 1)
    rows.at(-1)!.line.ending = terminalEnding
  } else if (operation === 'insertRowAbove' || operation === 'insertRowBelow') {
    const insertion =
      operation === 'insertRowAbove'
        ? Math.max(2, sourceRowForDomRow(rowStart))
        : Math.max(2, sourceRowForDomRow(rowEnd) + 1)
    const preferredEnding =
      rows.find((row) => row.line.ending)?.line.ending || '\n'
    const additions = Array.from({ length: rowEnd - rowStart + 1 }, () => ({
      ...rows[0]!,
      cells: Array.from({ length: rows[0]!.cells.length }, () => ''),
      starts: [...rows[0]!.starts],
      ends: [...rows[0]!.ends],
      line: { ...rows[0]!.line, ending: preferredEnding },
    }))
    if (insertion === rows.length && rows.at(-1)?.line.ending === '') {
      rows.at(-1)!.line.ending = preferredEnding
      additions.at(-1)!.line.ending = ''
    }
    rows.splice(insertion, 0, ...additions)
  } else if (operation === 'deleteColumns') {
    if (count === rows[0]!.cells.length) return null
    for (const row of rows) row.cells.splice(columnStart, count)
  } else {
    const insertion =
      operation === 'insertColumnLeft' ? columnStart : columnEnd + 1
    for (const [index, row] of rows.entries())
      row.cells.splice(
        insertion,
        0,
        ...Array.from({ length: count }, () => (index === 1 ? '---' : '')),
      )
  }
  const next = renderChangedTable(rows)
  return markdown.slice(0, range.start) + next + markdown.slice(range.end)
}

/** Moves a GFM column, including its delimiter alignment cell, without canonicalizing source. */
export function moveTableColumn(
  markdown: string,
  column: number,
  direction: Extract<Direction, 'left' | 'right'>,
): string | null {
  const rows = parseTable(markdown)
  if (!rows) return null
  const target = direction === 'left' ? column - 1 : column + 1
  if (column < 0 || target < 0 || target >= rows[0].cells.length) return null
  for (const row of rows)
    [row.cells[column], row.cells[target]] = [
      row.cells[target],
      row.cells[column],
    ]
  return renderTable(rows)
}

/** Moves only body rows; the GFM header and delimiter remain structural anchors. */
export function moveTableRow(
  markdown: string,
  row: number,
  direction: Extract<Direction, 'up' | 'down'>,
): string | null {
  const rows = parseTable(markdown)
  if (!rows || row < 2 || row >= rows.length) return null
  const target = direction === 'up' ? row - 1 : row + 1
  if (target < 2 || target >= rows.length) return null
  const endings = rows.map((candidate) => candidate.line.ending)
  ;[rows[row], rows[target]] = [rows[target], rows[row]]
  rows.forEach((candidate, index) => {
    candidate.line.ending = endings[index]!
  })
  return renderTable(rows)
}
