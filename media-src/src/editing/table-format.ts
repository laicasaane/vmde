import {
  sourceTableRangeAtSelection,
  tableCellLocationAtOffset,
  tableCellOffsetForLocation,
} from './table-operations'

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
  const formatted = restoreLineEndings(formatter.format(table), table)
  if (!formatted) return null
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
