import {
  sourceTableRangeAtSelection,
  tableCellLocationAtOffset,
  tableCellOffsetForLocation,
} from './table-operations'
import {
  restoreCodeSpanPipeForm,
  splitTableRowCells,
  tableRowPipeOffsets,
} from '../../../src/shared/table-code-pipes'

export interface TableFormatter {
  format(markdown: string): string
}

export interface FormattedTableSelection {
  markdown: string
  startOffset: number
  endOffset: number
  selectionStart: number
  selectionEnd: number
}

interface SourceLine {
  text: string
  ending: string
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

function restoreLineEndings(formatted: string, source: string): string | null {
  const formattedLines = splitLines(formatted)
  const sourceLines = splitLines(source)
  if (formattedLines.length !== sourceLines.length) return null
  return formattedLines
    .map((line, index) => `${line.text}${sourceLines[index]!.ending}`)
    .join('')
}

interface FormattedCell {
  lead: number
  content: string
  trail: number
}

interface FormattedRow {
  text: string
  ending: string
  /** Null when the row has no outer pipes (not Lute's padded shape): the row is left alone. */
  cells: FormattedCell[] | null
  pipes: number[]
}

function readFormattedRow(line: SourceLine): FormattedRow {
  const pipes = tableRowPipeOffsets(line.text)
  const outer =
    pipes.length >= 2 && pipes[0] === 0 && pipes.at(-1) === line.text.length - 1
  if (!outer) return { ...line, cells: null, pipes }
  const cells: FormattedCell[] = []
  for (let k = 0; k + 1 < pipes.length; k++) {
    const raw = line.text.slice(pipes[k] + 1, pipes[k + 1])
    const content = raw.trim()
    const lead = raw.length - raw.trimStart().length
    cells.push({ lead, content, trail: raw.length - lead - content.length })
  }
  return { ...line, cells, pipes }
}

/**
 * Task 704 (Q2, Q3, P3): Lute formats the table with every code-span pipe escaped (the parse-side
 * escape in `patchLuteTableCodePipes`), so its output carries `\|` where the user wrote `|`. Give
 * each unchanged code span its source form back, then recompute the column padding.
 *
 * Lute pads by the width of the RENDERED text, where `\|` counts as one character (measured:
 * `x \| y` is padded as 5 wide). A restored `\|` is therefore one wider than Lute assumed
 * (excess `e`), and a restored bare `|` fits exactly. With `pad` = the cell's padding beyond its two
 * gutter spaces and `M` = max(e - pad) over the column, the new column width is `M` wider than the
 * old one, each cell's padding changes by `M - e` (on the side its alignment pads) and the delimiter
 * row grows or loses `M` dashes. Only integer counts are used, so CJK width needs no measure.
 * Returns `formatted` unchanged when the shapes do not line up.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one pass over parsed rows computing the per-column padding change and rebuilding each line
function restoreSourceCodePipeForms(formatted: string, source: string): string {
  if (source.indexOf('`') === -1 || source.indexOf('|') === -1) return formatted
  const fl = splitLines(formatted).map(readFormattedRow)
  const sl = splitLines(source)
  if (fl.length !== sl.length || fl.length < 2) return formatted
  const restored: string[][] = []
  const excess: number[][] = []
  let changed = false
  for (let i = 0; i < fl.length; i++) {
    const cells = fl[i].cells
    if (!cells) return formatted
    if (i === 1) {
      restored.push([])
      excess.push([])
      continue
    }
    const sourceCells = splitTableRowCells(sl[i].text).map((c) => c.trim())
    if (sourceCells.length !== cells.length) return formatted
    const texts = cells.map((cell, c) =>
      restoreCodeSpanPipeForm(sourceCells[c], cell.content),
    )
    if (texts.some((text, c) => text !== cells[c].content)) changed = true
    restored.push(texts)
    excess.push(
      cells.map(
        (cell, c) =>
          texts[c].length - cell.content.length + escapedPipes(cell.content),
      ),
    )
  }
  if (!changed) return formatted
  const columns = fl[0].cells?.length ?? 0
  const growth: number[] = []
  for (let c = 0; c < columns; c++) {
    let best = Number.NEGATIVE_INFINITY
    for (let i = 0; i < fl.length; i++) {
      const cell = fl[i].cells?.[c]
      if (i === 1 || !cell) continue
      best = Math.max(best, excess[i][c] - (cell.lead + cell.trail - 2))
    }
    growth.push(Number.isFinite(best) ? best : 0)
  }
  const alignment = (fl[1].cells ?? []).map((cell) => ({
    left: cell.content.startsWith(':'),
    right: cell.content.endsWith(':'),
  }))
  return fl
    .map((row, i) => {
      let out = '|'
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: delimiter-row dashes and the alignment-dependent padding split of one cell, kept next to the totals they use
      ;(row.cells as FormattedCell[]).forEach((cell, c) => {
        const { left, right } = alignment[c] ?? { left: false, right: false }
        if (i === 1) {
          const colons = (left ? 1 : 0) + (right ? 1 : 0)
          const dashes = Math.max(cell.content.length - colons + growth[c], 1)
          const text = `${left ? ':' : ''}${'-'.repeat(dashes)}${right ? ':' : ''}`
          out += `${' '.repeat(cell.lead)}${text}${' '.repeat(cell.trail)}|`
          return
        }
        const padOld = cell.lead + cell.trail - 2
        const padNew = padOld + growth[c] - excess[i][c]
        let leadExtra = 0
        if (right && !left) leadExtra = padNew
        else if (left && right) {
          // Centered: keep the rounding Lute used (extra space on the leading side or not).
          const leadWasLarger = cell.lead - 1 > padOld - (cell.lead - 1)
          leadExtra = leadWasLarger
            ? Math.ceil(padNew / 2)
            : Math.floor(padNew / 2)
        }
        out += `${' '.repeat(1 + leadExtra)}${restored[i][c]}${' '.repeat(1 + padNew - leadExtra)}|`
      })
      return out + row.ending
    })
    .join('')
}

/** Count of `\|` pairs in a formatted cell: Lute counts each as one character when it pads. */
function escapedPipes(text: string): number {
  let count = 0
  for (
    let at = text.indexOf('\\|');
    at !== -1;
    at = text.indexOf('\\|', at + 2)
  )
    count++
  return count
}

/** Formats exactly one scanner-proven GFM table, retaining source EOL bytes and source selection. */
export function formatTableAtSelection(
  markdown: string,
  selectionStart: number,
  selectionEnd: number,
  formatter: TableFormatter,
): FormattedTableSelection | null {
  const range = sourceTableRangeAtSelection(
    markdown,
    selectionStart,
    selectionEnd,
  )
  if (!range) return null
  const table = markdown.slice(range.start, range.end)
  const relativeStart = selectionStart - range.start
  const relativeEnd = selectionEnd - range.start
  const startLocation = tableCellLocationAtOffset(table, relativeStart)
  const endLocation = tableCellLocationAtOffset(table, relativeEnd)
  if (!startLocation || !endLocation) return null
  const lineRestored = restoreLineEndings(formatter.format(table), table)
  if (!lineRestored) return null
  const formatted = restoreSourceCodePipeForms(lineRestored, table)
  const formattedStart = tableCellOffsetForLocation(formatted, startLocation)
  const formattedEnd = tableCellOffsetForLocation(formatted, endLocation)
  if (formattedStart === null || formattedEnd === null || formatted === table)
    return null
  return {
    markdown:
      markdown.slice(0, range.start) + formatted + markdown.slice(range.end),
    startOffset: range.start,
    endOffset: range.end,
    selectionStart: range.start + formattedStart,
    selectionEnd: range.start + formattedEnd,
  }
}
