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
  quoteDepth: number
  indent: string
  indentColumns: number
  ordered: boolean
  delimiter?: '.' | ')'
  digits?: string
  number?: number
  digitStart: number
  digitEnd: number
  contentIndent: number
  root: SourceRoot
  list: Marker[]
  ownedLines: number[]
}

interface SourceRoot {
  first: Marker
  members: Marker[]
  endLine: number
}

interface ListContainer {
  quoteDepth: number
  indentColumns: number
  ordered: boolean
  delimiter?: '.' | ')'
  root: SourceRoot
  list: Marker[]
  last: Marker
  blankSinceContent: boolean
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

function quotePrefix(line: string): {
  prefix: string
  rest: string
  depth: number
  outerIndentColumns: number
} {
  let cursor = 0
  let depth = 0
  let outerIndentColumns = 0
  for (;;) {
    const match = /^[ \t]{0,3}>[ \t]?/u.exec(line.slice(cursor))
    if (!match) break
    if (depth === 0)
      outerIndentColumns = indentColumns(/^[ \t]*/u.exec(match[0])?.[0] ?? '')
    cursor += match[0].length
    depth++
  }
  return {
    prefix: line.slice(0, cursor),
    rest: line.slice(cursor),
    depth,
    outerIndentColumns,
  }
}

function indentColumns(indent: string): number {
  let columns = 0
  for (const character of indent) {
    columns += character === '\t' ? 4 - (columns % 4) : 1
  }
  return columns
}

interface ProtectedState {
  fence: { marker: '`' | '~'; length: number; quoteDepth: number } | null
  html: RegExp | 'blank' | null
  frontMatter: boolean
  math: boolean
}

const HTML_BLOCK_TAG =
  /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)$/iu
const COMPLETE_HTML_TAG =
  /^(?:<\/[A-Za-z][A-Za-z0-9-]*[\t ]*>|<[A-Za-z][A-Za-z0-9-]*(?:[\t ]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[\t ]*=[\t ]*(?:[^"'=<>`\t ]+|'[^']*'|"[^"]*"))?)*[\t ]*\/?>)[\t ]*$/u

function rawHtmlTerminator(content: string): RegExp | 'blank' | null {
  const raw = /^<(script|pre|style|textarea)(?:[\t ]|>|$)/iu.exec(content)
  if (raw) return new RegExp(`</${raw[1]}[\\t ]*>`, 'iu')
  if (/^<!--/u.test(content)) return /-->/u
  if (/^<\?/u.test(content)) return /\?>/u
  if (/^<![A-Z]/u.test(content)) return />/u
  if (/^<!\[CDATA\[/u.test(content)) return /\]\]>/u
  const blockTag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[\t ]|\/?>|$)/u.exec(content)
  return (blockTag && HTML_BLOCK_TAG.test(blockTag[1])) ||
    COMPLETE_HTML_TAG.test(content)
    ? 'blank'
    : null
}

/** Returns whether this physical line is a non-Markdown leaf and advances its lifetime. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CommonMark leaf lifetimes must advance in source order before container ownership is considered.
function protectedLeaf(
  index: number,
  view: ReturnType<typeof quotePrefix>,
  state: ProtectedState,
): boolean {
  const content = view.rest
  if (index === 0 && view.depth === 0 && content.trim() === '---') {
    state.frontMatter = true
    return true
  }
  if (state.frontMatter) {
    if (content.trim() === '---' || content.trim() === '...')
      state.frontMatter = false
    return true
  }
  if (state.html) {
    const closes =
      state.html === 'blank' ? !content.trim() : state.html.test(content)
    if (closes) state.html = null
    return true
  }
  if (state.math || content.trim() === '$$') {
    state.math = content.trim() === '$$' ? !state.math : state.math
    return true
  }
  const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(content)
  if (state.fence) {
    if (
      fence &&
      view.depth === state.fence.quoteDepth &&
      fence[1][0] === state.fence.marker &&
      fence[1].length >= state.fence.length &&
      !fence[2].trim()
    )
      state.fence = null
    return true
  }
  if (fence) {
    state.fence = {
      marker: fence[1][0] as '`' | '~',
      length: fence[1].length,
      quoteDepth: view.depth,
    }
    return true
  }
  const html = rawHtmlTerminator(content.replace(/^ {0,3}/u, ''))
  if (!html) return false
  if (html instanceof RegExp && html.test(content)) return true
  state.html = html
  return true
}

function parseMarker(
  line: SourceLine,
  lineIndex: number,
): Omit<Marker, 'root' | 'list' | 'ownedLines'> | null {
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
      quoteDepth: view.depth,
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
    quoteDepth: view.depth,
    indent,
    indentColumns: indentColumns(indent),
    ordered: false,
    digitStart: markerStart,
    digitEnd: markerStart,
    contentIndent:
      indentColumns(indent) + bullet![1].length + bullet![2].length,
  }
}

function appendOwnedLine(
  containers: readonly ListContainer[],
  line: number,
): void {
  for (const container of containers) container.last.ownedLines.push(line)
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one forward container/leaf scan is the ownership authority; it intentionally declines indented markers without a live parent.
function scanSourceLists(markdown: string): {
  lines: SourceLine[]
  roots: SourceRoot[]
} {
  const lines = linesOf(markdown)
  const roots: SourceRoot[] = []
  const state: ProtectedState = {
    fence: null,
    html: null,
    frontMatter: false,
    math: false,
  }
  let containers: ListContainer[] = []
  for (const [lineIndex, line] of lines.entries()) {
    const view = quotePrefix(line.text)
    // Moving out of a quote closes only deeper quote containers; an outer list can own a
    // blockquote leaf when the quote itself is indented to that item's continuation column.
    containers = containers.filter(
      (container) => container.quoteDepth <= view.depth,
    )
    if (protectedLeaf(lineIndex, view, state)) {
      containers = []
      continue
    }
    const marker = parseMarker(line, lineIndex)
    if (marker) {
      const directIndex = containers.findLastIndex(
        (container) =>
          container.indentColumns === marker.indentColumns &&
          container.quoteDepth === marker.quoteDepth,
      )
      const direct = directIndex < 0 ? undefined : containers[directIndex]
      // A marker at an item's outer margin after a blank can be either a loose child item or
      // indented code. Without a live continuation column it is ambiguous, so leave it verbatim.
      if (
        direct?.blankSinceContent &&
        marker.indentColumns < direct.last.contentIndent
      ) {
        containers = []
        continue
      }
      const parent = containers
        .filter(
          (container) =>
            container.indentColumns < marker.indentColumns &&
            (container.quoteDepth === marker.quoteDepth
              ? marker.indentColumns >= container.last.contentIndent
              : view.outerIndentColumns >= container.last.contentIndent),
        )
        .at(-1)
      const continues = Boolean(
        direct &&
          direct.ordered === marker.ordered &&
          (!marker.ordered || direct.delimiter === marker.delimiter),
      )
      if (!direct && !parent && marker.indentColumns >= 4) {
        containers = []
        continue
      }
      if (direct)
        containers = containers.slice(0, directIndex + (continues ? 1 : 0))
      else if (parent) {
        const parentIndex = containers.indexOf(parent)
        containers = containers.slice(0, parentIndex + 1)
      }
      const owner = continues ? direct : undefined
      const root = owner?.root ??
        parent?.root ?? {
          first: null as unknown as Marker,
          members: [],
          endLine: marker.line,
        }
      const resolved: Marker = {
        ...marker,
        root,
        list: owner?.list ?? [],
        ownedLines: [],
      }
      if (!owner && !parent) roots.push(root)
      if (!owner) resolved.list.push(resolved)
      else resolved.list.push(resolved)
      if (!root.first) root.first = resolved
      root.members.push(resolved)
      root.endLine = lineIndex
      // A sibling marker replaces the active item; only its enclosing containers own its indent.
      appendOwnedLine(
        continues ? containers.slice(0, -1) : containers,
        lineIndex,
      )
      const container: ListContainer = owner ?? {
        quoteDepth: resolved.quoteDepth,
        indentColumns: resolved.indentColumns,
        ordered: resolved.ordered,
        delimiter: resolved.delimiter,
        root,
        list: resolved.list,
        last: resolved,
        blankSinceContent: false,
      }
      container.last = resolved
      container.blankSinceContent = false
      if (!owner) containers.push(container)
      continue
    }
    if (!view.rest.trim()) {
      for (const container of containers) {
        container.blankSinceContent = true
        container.root.endLine = lineIndex
      }
      continue
    }
    const indent = indentColumns(/^[ \t]*/u.exec(view.rest)?.[0] ?? '')
    const ownerIndex = containers.findLastIndex((container) =>
      container.quoteDepth === view.depth
        ? indent >= container.last.contentIndent
        : view.outerIndentColumns >= container.last.contentIndent,
    )
    if (ownerIndex >= 0) {
      containers = containers.slice(0, ownerIndex + 1)
      appendOwnedLine(containers, lineIndex)
      for (const container of containers) {
        container.blankSinceContent = false
        container.root.endLine = lineIndex
      }
      continue
    }
    if (containers.some((container) => container.blankSinceContent)) {
      containers = []
      continue
    }
    // A nonblank, unindented line immediately after an item is a CommonMark lazy continuation.
    appendOwnedLine(containers, lineIndex)
    for (const container of containers) {
      container.blankSinceContent = false
      container.root.endLine = lineIndex
    }
  }
  return { lines, roots }
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
  const { lines, roots } = scanSourceLists(markdown)
  const markers = roots.flatMap((root) => root.members)
  const targetRoots =
    scope === 'all'
      ? roots
      : roots.filter(
          (root) =>
            caretOffset >= lines[root.first.line].start &&
            caretOffset <= lines[root.endLine].endWithBreak,
        )
  const replacements: Replacement[] = []
  const indentDeltas = new Map<number, number>()
  const changedRoots = new Set<SourceRoot>()
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
          for (const line of marker.ownedLines) {
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
