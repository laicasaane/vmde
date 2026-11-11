import { splitTableRowCells, tableRowPipeOffsets } from './table-code-pipes'

// Task 733: table row splice helpers moved out of markdown/minimal-diff-writeback.ts (bodies
// unchanged) so the webview text model reuses the host's byte-preserving cell splice.

// Split one table row into trimmed cell texts. Code-span aware (Task 704, D1): a `|` inside a code
// span does not end the cell, the same reading the editor's Lute gets through table-code-pipes.
export function splitRow(line: string): string[] {
  return splitTableRowCells(line).map((c) => c.trim())
}

export interface RowCellSpan {
  contentStart: number
  contentEnd: number
}

function isHorizontalSpace(char: string): boolean {
  return char === ' ' || char === '\t'
}

// Return replacement intervals only when this raw row has the same cells as the established
// splitRow contract. An ambiguous escaped border pipe keeps the canonical fallback.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validates raw row boundaries and escape parity before allowing byte-preserving splices
export function originalRowCellSpans(
  raw: string,
  cells: string[],
): RowCellSpan[] | null {
  const sourceEnd = raw.endsWith('\r') ? raw.length - 1 : raw.length
  let trimmedStart = 0
  let trimmedEnd = sourceEnd
  while (trimmedStart < trimmedEnd && isHorizontalSpace(raw[trimmedStart]))
    trimmedStart++
  while (trimmedEnd > trimmedStart && isHorizontalSpace(raw[trimmedEnd - 1]))
    trimmedEnd--
  if (trimmedStart === trimmedEnd) return null

  let bodyStart = trimmedStart
  let bodyEnd = trimmedEnd
  if (raw[bodyStart] === '|') bodyStart++
  if (raw[bodyEnd - 1] === '|') {
    if (raw[bodyEnd - 2] === '\\') return null
    bodyEnd--
  }

  // The same code-span-aware, backslash-parity pipe rule as splitRow, so the spans line up with
  // the cells it reports.
  const delimiters = tableRowPipeOffsets(raw).filter(
    (offset) => offset >= bodyStart && offset < bodyEnd,
  )

  const spans: RowCellSpan[] = []
  let start = bodyStart
  for (const end of [...delimiters, bodyEnd]) {
    let contentStart = start
    let contentEnd = end
    while (contentStart < contentEnd && isHorizontalSpace(raw[contentStart]))
      contentStart++
    while (contentEnd > contentStart && isHorizontalSpace(raw[contentEnd - 1]))
      contentEnd--
    spans.push({ contentStart, contentEnd })
    start = end + 1
  }

  if (spans.length !== cells.length) return null
  return spans.every(
    (span, index) =>
      raw.slice(span.contentStart, span.contentEnd).trim() === cells[index],
  )
    ? spans
    : null
}

export function spliceChangedRow(
  raw: string,
  originalCells: string[],
  nextCells: string[],
  changed: boolean[],
): string | null {
  const spans = originalRowCellSpans(raw, originalCells)
  if (!spans) return null
  let result = raw
  for (let index = spans.length - 1; index >= 0; index--) {
    if (!changed[index]) continue
    const span = spans[index]
    result =
      result.slice(0, span.contentStart) +
      nextCells[index] +
      result.slice(span.contentEnd)
  }
  const resultCells = splitRow(result)
  // `\|` and `|` in a code span are the same cell text (the source form of an unchanged span is
  // restored per cell), so compare with the escape read as the bare pipe.
  const bare = (cell: string) => cell.replace(/\\\|/g, '|')
  return resultCells.length === nextCells.length &&
    resultCells.every((cell, index) => bare(cell) === bare(nextCells[index]))
    ? result
    : null
}

// Reserialize a single cell inside a 1-column table so the comparison sees the same
// trim Lute applies in real table context.
export function cellRoundTrip(
  text: string,
  reserialize: (block: string) => string | undefined,
): string | undefined {
  const r = reserialize(`| ${text} |\n| - |`)
  return r === undefined ? undefined : splitRow(r.split('\n')[0])[0]
}

// Two cells are equivalent if identical, or if they reserialize identically (so the
// only difference is reflow the editor would apply anyway, e.g. the task-60 trim).
export function cellsEqual(
  a: string,
  b: string,
  reserialize: (block: string) => string | undefined,
): boolean {
  if (a === b) return true
  const ra = cellRoundTrip(a, reserialize)
  const rb = cellRoundTrip(b, reserialize)
  return ra !== undefined && ra === rb
}
