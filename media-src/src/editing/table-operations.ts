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

function parseRow(line: SourceLine): ParsedRow | null {
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
  if (!delimiters.length) return null
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
    parsed.length < 3 ||
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
  const prefix = row.line.text.slice(0, row.starts[0])
  const suffix = row.line.text.slice(row.ends.at(-1))
  return `${prefix}${row.cells.join('|')}${suffix}${row.line.ending}`
}

function renderChangedTable(rows: ParsedRow[]): string {
  return rows.map(renderChangedRow).join('')
}

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
  for (let index = 0; index < lines.length; ) {
    let end = index
    while (end < lines.length && lines[end].text.includes('|')) end++
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
  const emptyRow = () => ({
    cells: Array.from({ length: rows[0]!.cells.length }, () => ''),
    starts: [],
    ends: [],
    line: { text: '', ending: rows[0]!.line.ending || '\n' },
  })
  if (operation === 'deleteRows') {
    if (rowStart === 0 && rowEnd === rows.length - 2)
      return markdown.slice(0, range.start) + markdown.slice(range.end)
    const sourceStart = Math.max(2, sourceRowForDomRow(rowStart))
    const sourceEnd = sourceRowForDomRow(rowEnd)
    if (sourceEnd < 2) return null
    rows.splice(sourceStart, sourceEnd - sourceStart + 1)
  } else if (operation === 'insertRowAbove' || operation === 'insertRowBelow') {
    const insertion =
      operation === 'insertRowAbove'
        ? Math.max(2, sourceRowForDomRow(rowStart))
        : Math.max(2, sourceRowForDomRow(rowEnd) + 1)
    rows.splice(
      insertion,
      0,
      ...Array.from({ length: rowEnd - rowStart + 1 }, emptyRow),
    )
  } else if (operation === 'deleteColumns') {
    if (count === rows[0]!.cells.length)
      return markdown.slice(0, range.start) + markdown.slice(range.end)
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
  ;[rows[row], rows[target]] = [rows[target], rows[row]]
  return renderTable(rows)
}
