// Task 645 — pure planning for the Split View source gutter (sv-gutter.ts measures the DOM and
// draws the result). A source line is one `span[data-type="newline"]`-terminated run of the single
// editable source block; it can wrap onto several visual rows. The gutter shows the line number on
// the first row and a `↳` mark with a sub-number counted from 1 on every further row.

/** The vertical extent of one visual row, in the same coordinate space as the caller measured. */
export interface RowBox {
  top: number
  bottom: number
}

/** One source line with the visual rows it occupies. */
export interface PlannedLine {
  line: number
  rows: readonly RowBox[]
}

/** One label to draw: the line number (first row) or a wrapped-row sub-number. */
export interface GutterLabel {
  kind: 'line' | 'sub'
  text: string
  top: number
  height: number
}

/** Decimal digits of a non-negative integer, 1 for zero. */
export function digitCount(value: number): number {
  return String(Math.max(0, Math.trunc(value))).length
}

/**
 * Gutter width in digit widths: the larger of the digits of the highest line number and the sub
 * number column, which is the `↳` mark, one space and the digits of the widest sub-number.
 */
export function gutterColumns(maxLine: number, maxSub: number): number {
  const subColumns = maxSub > 0 ? 2 + digitCount(maxSub) : 0
  return Math.max(digitCount(maxLine), subColumns)
}

/**
 * Merge measured rects into visual rows: rects whose tops differ by at most `tolerance` belong to one
 * row. Rects without height are ignored. The rows come back sorted by top.
 */
export function groupRows(rects: readonly RowBox[], tolerance = 1): RowBox[] {
  const sorted = rects
    .filter((rect) => rect.bottom > rect.top)
    .slice()
    .sort((a, b) => a.top - b.top)
  const rows: RowBox[] = []
  for (const rect of sorted) {
    const row = rows[rows.length - 1]
    if (row && rect.top - row.top <= tolerance) {
      row.bottom = Math.max(row.bottom, rect.bottom)
    } else rows.push({ top: rect.top, bottom: rect.bottom })
  }
  return rows
}

/** Rows a line of `height` pixels holds at `rowPitch` pixels per row; at least 1, 1 for unusable input. */
export function estimateRowCount(height: number, rowPitch: number): number {
  if (!Number.isFinite(height) || !Number.isFinite(rowPitch) || rowPitch <= 0)
    return 1
  return Math.max(1, Math.round(height / rowPitch))
}

/** The widest sub-number a set of lines needs: the largest row count minus one, 0 when none wraps. */
export function maxSubNumber(rowCounts: readonly number[]): number {
  let max = 1
  for (const count of rowCounts) if (count > max) max = count
  return max - 1
}

/** Labels for lines in order: the number on the first row, sub-numbers 1, 2, … on the rest. */
export function planLabels(lines: readonly PlannedLine[]): GutterLabel[] {
  const labels: GutterLabel[] = []
  for (const { line, rows } of lines) {
    rows.forEach((row, index) => {
      labels.push({
        kind: index === 0 ? 'line' : 'sub',
        text: String(index === 0 ? line : index),
        top: row.top,
        height: row.bottom - row.top,
      })
    })
  }
  return labels
}

/**
 * The current-row highlight band for a caret on `caret` (viewport coordinates): centred on the
 * caret's row, one line height tall, and positioned in the pane's scrolling content (so the pane's
 * own `background-attachment: local` scrolls it with the text). `paneTop` is the viewport top of the
 * pane's padding box. `null` for any non-finite input or a line height of 0 or less.
 */
export function currentRowBand(
  caret: RowBox,
  lineHeight: number,
  paneTop: number,
  scrollTop: number,
): { top: number; height: number } | null {
  if (
    ![caret.top, caret.bottom, lineHeight, paneTop, scrollTop].every(
      Number.isFinite,
    ) ||
    lineHeight <= 0
  )
    return null
  const centre = (caret.top + caret.bottom) / 2
  return {
    top: centre - lineHeight / 2 - paneTop + scrollTop,
    height: lineHeight,
  }
}
