// Source-side Details rules (Task 533 resolver, moved here by Task 574). The block-range resolver
// and the status classifier read one per-document index, so passive display state and the Details
// action share the same admission rules without rescanning the document per selection.

import {
  detailsSelectionStatus,
  sourceDetailsPairs,
  type DetailsTag,
  type SourceDetailsPair,
} from './details'

export interface SourceRange {
  markdown: string
  startOffset: number
  endOffset: number
}

interface MarkdownLine {
  text: string
  start: number
  end: number
}

function sourceLines(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = []
  let start = 0
  for (const match of markdown.matchAll(/\r\n|\n|\r/gu)) {
    lines.push({
      text: markdown.slice(start, match.index),
      start,
      end: match.index,
    })
    start = match.index + match[0].length
  }
  lines.push({ text: markdown.slice(start), start, end: markdown.length })
  return lines
}

/** First line whose end is at or after `offset` (binary search over ascending line ends). */
function lineForOffset(lines: readonly MarkdownLine[], offset: number): number {
  let low = 0
  let high = lines.length - 1
  if (offset > lines[high].end) return high
  while (low < high) {
    const middle = (low + high) >> 1
    if (offset <= lines[middle].end) high = middle
    else low = middle + 1
  }
  return low
}

function fenceRanges(lines: readonly MarkdownLine[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let opening: { index: number; marker: string; length: number } | null = null
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line.text)?.[1]
    if (!marker) continue
    if (!opening) {
      opening = { index, marker: marker[0], length: marker.length }
      continue
    }
    const trailing = line.text.slice(line.text.indexOf(marker) + marker.length)
    if (
      marker[0] === opening.marker &&
      marker.length >= opening.length &&
      trailing.trim() === ''
    ) {
      ranges.push([opening.index, index])
      opening = null
    }
  }
  if (opening) ranges.push([opening.index, lines.length - 1])
  return ranges
}

type LineRole = 'blank' | 'table' | 'list' | 'quote' | 'atomic' | 'prose'

function lineRole(text: string): LineRole {
  if (!text.trim()) return 'blank'
  if (text.includes('|')) return 'table'
  if (/^\s*(?:[-+*]|\d+[.)])\s+/u.test(text)) return 'list'
  if (/^\s*>/u.test(text)) return 'quote'
  if (/^ {0,3}(?:#{1,6}(?:\s|$)|(?:[-*_]\s*){3,}$)/u.test(text)) return 'atomic'
  return 'prose'
}

function sameBlockRole(role: LineRole, text: string): boolean {
  const candidate = lineRole(text)
  if (role === 'list') return candidate === 'list' || /^\s{2,}\S/u.test(text)
  return candidate === role
}

function expandFencedSelection(
  lines: readonly MarkdownLine[],
  fences: ReadonlyArray<[number, number]>,
  first: number,
  last: number,
  startOffset: number,
  endOffset: number,
): [number, number] | null {
  let expandedFirst = first
  let expandedLast = last
  for (const [open, close] of fences) {
    if (last < open || first > close) continue
    if (startOffset > lines[open].start || endOffset < lines[close].end)
      return null
    expandedFirst = Math.min(expandedFirst, open)
    expandedLast = Math.max(expandedLast, close)
  }
  return [expandedFirst, expandedLast]
}

const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[\t ]*$/u

function setextRange(
  lines: readonly MarkdownLine[],
  first: number,
  last: number,
): [number, number] | null {
  if (
    SETEXT_UNDERLINE.test(lines[first].text) &&
    first > 0 &&
    lineRole(lines[first - 1].text) === 'prose'
  ) {
    first--
    while (first > 0 && lineRole(lines[first - 1].text) === 'prose') first--
    return [first, last]
  }
  if (
    lineRole(lines[first].text) === 'prose' &&
    last + 1 < lines.length &&
    SETEXT_UNDERLINE.test(lines[last + 1].text)
  ) {
    last++
    while (first > 0 && lineRole(lines[first - 1].text) === 'prose') first--
    return [first, last]
  }
  return null
}

function expandList(
  lines: readonly MarkdownLine[],
  first: number,
  last: number,
): [number, number] {
  while (first > 0) {
    if (sameBlockRole('list', lines[first - 1].text)) {
      first--
      continue
    }
    if (
      lineRole(lines[first - 1].text) === 'blank' &&
      first > 1 &&
      sameBlockRole('list', lines[first - 2].text)
    ) {
      first -= 2
      continue
    }
    break
  }
  while (last + 1 < lines.length) {
    if (sameBlockRole('list', lines[last + 1].text)) {
      last++
      continue
    }
    if (
      lineRole(lines[last + 1].text) === 'blank' &&
      last + 2 < lines.length &&
      sameBlockRole('list', lines[last + 2].text)
    ) {
      last += 2
      continue
    }
    break
  }
  return [first, last]
}

function lazyContainerRange(
  lines: readonly MarkdownLine[],
  first: number,
  last: number,
): [number, number] | null {
  if (lineRole(lines[first].text) !== 'prose' || first === 0) return null
  let proseStart = first
  let proseEnd = last
  while (proseStart > 0 && lineRole(lines[proseStart - 1].text) === 'prose')
    proseStart--
  while (
    proseEnd + 1 < lines.length &&
    lineRole(lines[proseEnd + 1].text) === 'prose'
  )
    proseEnd++
  if (proseStart === 0) return null
  const ownerIndex = proseStart - 1
  const owner = lineRole(lines[ownerIndex].text)
  if (owner !== 'list' && owner !== 'quote') return null
  if (owner === 'list')
    return [expandList(lines, ownerIndex, ownerIndex)[0], proseEnd]
  first = ownerIndex
  while (first > 0 && lineRole(lines[first - 1].text) === 'quote') first--
  return [first, proseEnd]
}

function expandSingleBlock(
  lines: readonly MarkdownLine[],
  first: number,
  last: number,
): [number, number] {
  if (first !== last) return [first, last]
  const lazy = lazyContainerRange(lines, first, last)
  if (lazy) return lazy
  const setext = setextRange(lines, first, last)
  if (setext) return setext
  const role = lineRole(lines[first].text)
  if (role === 'atomic' || role === 'table') return [first, last]
  if (role === 'list') return expandList(lines, first, last)
  while (first > 0 && sameBlockRole(role, lines[first - 1].text)) first--
  while (last + 1 < lines.length && sameBlockRole(role, lines[last + 1].text))
    last++
  if (
    role === 'prose' &&
    last + 1 < lines.length &&
    SETEXT_UNDERLINE.test(lines[last + 1].text)
  )
    last++
  return [first, last]
}

/** Source line and Details tag tables for one Markdown string, reused across selections. */
export interface DetailsSourceIndex {
  markdown: string
  lines: MarkdownLine[]
  /** First/last line index of each fenced block. */
  fences: Array<[number, number]>
  tags: DetailsTag[]
  pairs: SourceDetailsPair[]
}

/** Index of the source line containing `offset` (an offset at a line break belongs to that line). */
export function detailsLineAt(
  index: DetailsSourceIndex,
  offset: number,
): number {
  return lineForOffset(index.lines, offset)
}

export function buildDetailsSourceIndex(markdown: string): DetailsSourceIndex {
  const lines = sourceLines(markdown)
  const { pairs, tags } = sourceDetailsPairs(markdown)
  return { markdown, lines, fences: fenceRanges(lines), tags, pairs }
}

/** Expand a source selection to the complete contiguous blocks Details may wrap, or reject it. */
export function resolveDetailsBlockRangeIn(
  index: DetailsSourceIndex,
  startOffset: number,
  endOffset: number,
): SourceRange | null {
  if (startOffset >= endOffset) return null
  const { lines } = index
  let first = lineForOffset(lines, startOffset)
  let last = lineForOffset(lines, Math.max(startOffset, endOffset - 1))
  const fenced = expandFencedSelection(
    lines,
    index.fences,
    first,
    last,
    startOffset,
    endOffset,
  )
  if (!fenced) return null
  ;[first, last] = fenced
  const firstRole = lineRole(lines[first].text)
  const lastRole = lineRole(lines[last].text)
  if (
    (firstRole === 'table' && startOffset > lines[first].start) ||
    (lastRole === 'table' && endOffset < lines[last].end)
  )
    return null
  ;[first, last] = expandSingleBlock(lines, first, last)
  return {
    markdown: index.markdown,
    startOffset: lines[first].start,
    endOffset: lines[last].end,
  }
}

export function resolveDetailsBlockRange(
  markdown: string,
  startOffset: number,
  endOffset: number,
): SourceRange | null {
  return resolveDetailsBlockRangeIn(
    buildDetailsSourceIndex(markdown),
    startOffset,
    endOffset,
  )
}

/** Details button status for already-resolved source offsets; builds no document string. */
export function classifyDetailsSelection(
  index: DetailsSourceIndex,
  startOffset: number,
  endOffset: number,
): 'wrap' | 'unwrap' | 'disabled' {
  return detailsSelectionStatus(
    index.markdown,
    index.tags,
    index.pairs,
    startOffset,
    endOffset,
  ).status
}
