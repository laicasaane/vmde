export type ListNormalizeScope = 'caret' | 'all'

export interface SourceListNormalizeResult {
  markdown: string
  changedRoots: number
  startOffset: number
  endOffset: number
}

interface SourceLine {
  start: number
  end: number
  endWithBreak: number
  text: string
}

interface Marker {
  line: number
  quote: string
  indent: string
  indentColumns: number
  ordered: boolean
  delimiter?: '.' | ')'
  digits?: string
  number?: number
  digitStart: number
  digitEnd: number
  contentIndent: number
  parent: Marker | null
  root: Marker
  list: Marker[]
  members: Marker[]
}

interface Replacement {
  start: number
  end: number
  text: string
}

const ORDERED_MARKER = /^(\d{1,9})([.)])([\t ]+)(.*)$/u
const BULLET_MARKER = /^([-+*])([\t ]+)(.*)$/u

function linesOf(markdown: string): SourceLine[] {
  const lines: SourceLine[] = []
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/gu
  for (;;) {
    const match = pattern.exec(markdown)
    if (!match || match[0] === '') break
    lines.push({
      start: match.index,
      end: match.index + match[1].length,
      endWithBreak: match.index + match[0].length,
      text: match[1],
    })
    if (!match[2]) break
  }
  return lines
}

function quotePrefix(line: string): { prefix: string; rest: string } {
  let cursor = 0
  for (;;) {
    const match = /^[ \t]{0,3}>[ \t]?/u.exec(line.slice(cursor))
    if (!match) break
    cursor += match[0].length
  }
  return { prefix: line.slice(0, cursor), rest: line.slice(cursor) }
}

function indentColumns(indent: string): number {
  let columns = 0
  for (const character of indent) {
    columns += character === '\t' ? 4 - (columns % 4) : 1
  }
  return columns
}

/** Returns false for source regions where a marker-looking line is not Markdown list syntax. */
function protectedLines(lines: readonly SourceLine[]): boolean[] {
  const protectedLine = Array.from({ length: lines.length }, () => false)
  let fence: { marker: '`' | '~'; length: number; quote: string } | null = null
  let comment = false
  let frontMatter = false
  let rawHtml: RegExp | null = null
  let math = false
  for (const [index, line] of lines.entries()) {
    const view = quotePrefix(line.text)
    const content = view.rest
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(content)
    if (index === 0 && content.trim() === '---') {
      protectedLine[index] = true
      frontMatter = true
      continue
    }
    if (frontMatter) {
      protectedLine[index] = true
      if (content.trim() === '---' || content.trim() === '...')
        frontMatter = false
      continue
    }
    if (rawHtml) {
      protectedLine[index] = true
      if (rawHtml.test(content)) rawHtml = null
      continue
    }
    if (math || content.trim() === '$$') {
      protectedLine[index] = true
      math = content.trim() === '$$' ? !math : math
      continue
    }
    const rawOpen = /^\s*<(script|style|pre|textarea)(?:\s|>|$)/iu.exec(content)
    if (rawOpen) {
      protectedLine[index] = true
      rawHtml = new RegExp(`</${rawOpen[1]}\\s*>`, 'iu')
      if (rawHtml.test(content)) rawHtml = null
      continue
    }
    if (fence) {
      protectedLine[index] = true
      if (
        fenceMatch &&
        fence.quote === view.prefix &&
        fenceMatch[1][0] === fence.marker &&
        fenceMatch[1].length >= fence.length &&
        content.slice(fenceMatch[0].length).trim() === ''
      )
        fence = null
      continue
    }
    if (comment || /^\s*<!--/u.test(content)) {
      protectedLine[index] = true
      comment = !(comment || /^\s*<!--/u.test(content)) || !/-->/u.test(content)
      continue
    }
    if (fenceMatch) {
      protectedLine[index] = true
      fence = {
        marker: fenceMatch[1][0] as '`' | '~',
        length: fenceMatch[1].length,
        quote: view.prefix,
      }
      continue
    }
    protectedLine[index] = false
  }
  return protectedLine
}

function parseMarker(
  line: SourceLine,
  lineIndex: number,
  excluded: boolean,
): Omit<Marker, 'parent' | 'root' | 'list' | 'members'> | null {
  if (excluded) return null
  const view = quotePrefix(line.text)
  const indentMatch = /^[ \t]*/u.exec(view.rest)
  const indent = indentMatch?.[0] ?? ''
  const afterIndent = view.rest.slice(indent.length)
  const ordered = ORDERED_MARKER.exec(afterIndent)
  const bullet = BULLET_MARKER.exec(afterIndent)
  if (!ordered && !bullet) return null
  const markerStart = line.start + view.prefix.length + indent.length
  if (ordered) {
    return {
      line: lineIndex,
      quote: view.prefix,
      indent,
      indentColumns: indentColumns(indent),
      ordered: true,
      delimiter: ordered[2] as '.' | ')',
      digits: ordered[1],
      number: Number(ordered[1]),
      digitStart: markerStart,
      digitEnd: markerStart + ordered[1].length,
      contentIndent:
        indentColumns(indent) + ordered[1].length + 1 + ordered[3].length,
    }
  }
  return {
    line: lineIndex,
    quote: view.prefix,
    indent,
    indentColumns: indentColumns(indent),
    ordered: false,
    digitStart: markerStart,
    digitEnd: markerStart,
    contentIndent:
      indentColumns(indent) + bullet![1].length + bullet![2].length,
  }
}

function hasDirectBreak(
  lines: readonly SourceLine[],
  markersByLine: ReadonlyMap<number, Marker>,
  previous: Marker,
  next: Marker,
): boolean {
  let afterBlank = false
  for (let index = previous.line + 1; index < next.line; index++) {
    const line = lines[index]
    const view = quotePrefix(line.text)
    if (view.prefix !== next.quote) continue
    if (!view.rest.trim()) {
      afterBlank = true
      continue
    }
    if (markersByLine.has(index)) continue
    const indent = indentColumns(/^[ \t]*/u.exec(view.rest)?.[0] ?? '')
    if (afterBlank && indent < previous.contentIndent) return true
    if (indent <= next.indentColumns) return true
  }
  return afterBlank && next.indentColumns < previous.contentIndent
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: source ownership is resolved atomically so protected lines cannot leak list ancestry.
function sourceRoots(markdown: string): Marker[] {
  const lines = linesOf(markdown)
  const excluded = protectedLines(lines)
  const parsed = lines
    .map((line, index) => parseMarker(line, index, excluded[index]))
    .filter(
      (
        marker,
      ): marker is Omit<Marker, 'parent' | 'root' | 'list' | 'members'> =>
        Boolean(marker),
    )
  const markers: Marker[] = parsed.map((marker) => ({
    ...marker,
    parent: null,
    root: null as unknown as Marker,
    list: [],
    members: [],
  }))
  const markersByLine = new Map(markers.map((marker) => [marker.line, marker]))
  const roots: Marker[] = []
  for (const marker of markers) {
    const previous = [...markers]
      .slice(0, markers.indexOf(marker))
      .reverse()
      .find(
        (candidate) =>
          candidate.root &&
          candidate.quote === marker.quote &&
          candidate.indentColumns <= marker.indentColumns,
      )
    if (marker.indentColumns >= 4 && !previous) continue
    const parent =
      previous && previous.indentColumns < marker.indentColumns
        ? previous
        : null
    marker.parent = parent
    const directPrevious =
      previous && previous.indentColumns === marker.indentColumns
        ? previous
        : null
    const continuesDirectList = Boolean(
      directPrevious &&
        directPrevious.ordered === marker.ordered &&
        (!marker.ordered || directPrevious.delimiter === marker.delimiter) &&
        !hasDirectBreak(lines, markersByLine, directPrevious, marker),
    )
    if (parent) {
      marker.root = parent.root
    } else if (continuesDirectList && directPrevious) {
      marker.root = directPrevious.root
    } else {
      marker.root = marker
      roots.push(marker)
    }
    if (continuesDirectList && directPrevious) marker.list = directPrevious.list
    else marker.list = [marker]
    if (marker !== marker.list[0]) marker.list.push(marker)
    marker.root.members.push(marker)
  }
  return roots
}

function rootEnd(
  root: Marker,
  markers: readonly Marker[],
  lines: readonly SourceLine[],
): number {
  const owned = markers.filter((marker) => marker.root === root)
  const last = owned.at(-1)
  if (!last) return lines[root.line]?.endWithBreak ?? 0
  let end = lines[last.line].endWithBreak
  for (let index = last.line + 1; index < lines.length; index++) {
    const view = quotePrefix(lines[index].text)
    if (view.prefix !== root.quote) break
    if (!view.rest.trim()) {
      end = lines[index].endWithBreak
      continue
    }
    const indent = indentColumns(/^[ \t]*/u.exec(view.rest)?.[0] ?? '')
    if (indent <= root.indentColumns) break
    end = lines[index].endWithBreak
  }
  return end
}

function mapOffset(
  offset: number,
  replacements: readonly Replacement[],
): number {
  let mapped = offset
  for (const replacement of replacements) {
    const before = replacement.end - replacement.start
    const after = replacement.text.length
    if (offset >= replacement.end) mapped += after - before
    else if (offset > replacement.start)
      mapped = replacement.start + Math.min(offset - replacement.start, after)
  }
  return mapped
}

function apply(markdown: string, replacements: readonly Replacement[]): string {
  return [...replacements]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (text, replacement) =>
        text.slice(0, replacement.start) +
        replacement.text +
        text.slice(replacement.end),
      markdown,
    )
}

function ownedIndentedLines(
  marker: Marker,
  lines: readonly SourceLine[],
  markersByLine: ReadonlyMap<number, Marker>,
): number[] {
  const owned: number[] = []
  for (let index = marker.line + 1; index < lines.length; index++) {
    const view = quotePrefix(lines[index].text)
    if (view.prefix !== marker.quote) break
    const nextMarker = markersByLine.get(index)
    if (nextMarker && nextMarker.indentColumns <= marker.indentColumns) break
    const indent = /^[ \t]*/u.exec(view.rest)?.[0] ?? ''
    if (indentColumns(indent) >= marker.contentIndent) owned.push(index)
  }
  return owned
}

/**
 * Plans digit-only source edits for explicit SV list commands. It deliberately recognizes only
 * unambiguous Markdown markers, so protected or uncertain lookalikes remain untouched.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one planner deliberately owns root selection, marker edits, indentation, and endpoint mapping.
export function normalizeOrderedListsSource(
  markdown: string,
  caretOffset: number,
  scope: ListNormalizeScope,
  endOffset = caretOffset,
): SourceListNormalizeResult | null {
  const roots = sourceRoots(markdown)
  const markers = roots.flatMap((root) => root.members)
  const lines = linesOf(markdown)
  const targetRoots =
    scope === 'all'
      ? roots
      : roots.filter(
          (root) =>
            caretOffset >= lines[root.line].start &&
            caretOffset <= rootEnd(root, markers, lines),
        )
  const replacements: Replacement[] = []
  const indentDeltas = new Map<number, number>()
  const markersByLine = new Map(markers.map((marker) => [marker.line, marker]))
  const changedRoots = new Set<Marker>()
  for (const root of targetRoots) {
    const owned = markers.filter(
      (marker) => marker.root === root && marker.ordered,
    )
    for (const first of owned.filter((marker) => marker.list[0] === marker)) {
      for (const [index, marker] of first.list.entries()) {
        if (!marker.ordered || marker.number === undefined || !marker.digits)
          continue
        const target = first.number! + index
        if (target > 999_999_999) return null
        const digits = String(target).padStart(marker.digits.length, '0')
        if (digits === marker.digits) continue
        replacements.push({
          start: marker.digitStart,
          end: marker.digitEnd,
          text: digits,
        })
        const widthDelta = digits.length - marker.digits.length
        if (widthDelta !== 0) {
          for (const line of ownedIndentedLines(marker, lines, markersByLine)) {
            indentDeltas.set(line, (indentDeltas.get(line) ?? 0) + widthDelta)
          }
        }
        changedRoots.add(root)
      }
    }
  }
  for (const [lineIndex, delta] of indentDeltas) {
    if (delta === 0) continue
    const line = lines[lineIndex]
    const view = quotePrefix(line.text)
    const indent = /^[ \t]*/u.exec(view.rest)?.[0] ?? ''
    if (delta < 0 && indent.length < -delta) return null
    replacements.push({
      start: line.start + view.prefix.length,
      end: line.start + view.prefix.length + indent.length,
      text: delta > 0 ? indent + ' '.repeat(delta) : indent.slice(0, delta),
    })
  }
  if (replacements.length === 0) return null
  const result = apply(markdown, replacements)
  return {
    markdown: result,
    changedRoots: changedRoots.size,
    startOffset: mapOffset(caretOffset, replacements),
    endOffset: mapOffset(endOffset, replacements),
  }
}
