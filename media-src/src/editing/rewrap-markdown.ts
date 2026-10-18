export interface RewrapResult {
  markdown: string
  caretOffset: number
  changed: boolean
}

interface SourceLine {
  start: number
  end: number
  endWithBreak: number
  text: string
  newline: string
  excluded: boolean
  owner?: PrefixSpec
}

interface PrefixSpec {
  first: string
  continuation: string
  list: boolean
  quoteDepth: number
}

interface LogicalUnit {
  startLine: number
  endLine: number
  prefix: PrefixSpec
}

export interface ExplicitHardBreak {
  line: number
  suffix: string
}

interface DelimitedState {
  fence: {
    marker: string
    length: number
    container: ProtectedContainer
  } | null
  math: ProtectedContainer | null
  html: { tag: string; container: ProtectedContainer } | null
  frontMatter: boolean
}

interface QuoteView {
  prefix: string
  rest: string
  depth: number
}

type ProtectedContainer =
  | { kind: 'quote'; depth: number }
  | { kind: 'prefix'; value: string }

interface RelativeView {
  content: string
  container: ProtectedContainer
  listOwner?: PrefixSpec
  startsList: boolean
}

const CARET_MARKER_BASE = '\uE000VMDE_REWRAP_CARET'
const HARD_BREAK_RE = /( {2,}|(?<!\\)\\)$/u
const COMBINING_OR_FORMAT_RE = /\p{Mark}|\u200d|\ufe0e|\ufe0f/u
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
]

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function sourceLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = []
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/gu
  for (;;) {
    const match = re.exec(markdown)
    if (!match) break
    if (match[0] === '' && re.lastIndex === markdown.length) break
    const start = match.index
    const text = match[1]
    const newline = match[2]
    lines.push({
      start,
      end: start + text.length,
      endWithBreak: start + text.length + newline.length,
      text,
      newline,
      excluded: false,
    })
    if (!newline) break
  }
  if (lines.length === 0) {
    lines.push({
      start: 0,
      end: 0,
      endWithBreak: 0,
      text: '',
      newline: '',
      excluded: false,
    })
  }
  return lines
}

function quoteView(line: string): QuoteView {
  let cursor = 0
  let prefix = ''
  let depth = 0
  for (;;) {
    const match = line.slice(cursor).match(/^[ \t]{0,3}>[ \t]?/u)
    if (!match) break
    prefix += match[0]
    cursor += match[0].length
    depth++
  }
  return { prefix, rest: line.slice(cursor), depth }
}

function stripQuoteDepth(line: string, depth: number): string | null {
  let cursor = 0
  for (let index = 0; index < depth; index++) {
    const marker = line.slice(cursor).match(/^[ \t]{0,3}>[ \t]?/u)
    if (!marker) return null
    cursor += marker[0].length
  }
  return line.slice(cursor)
}

function contentInContainer(
  line: string,
  container: ProtectedContainer,
): string | null {
  if (container.kind === 'prefix') {
    if (!line.trim()) return ''
    if (line.startsWith(container.value)) {
      return line.slice(container.value.length)
    }
    if (
      /^[ \t]+$/u.test(container.value) &&
      leadingIndentColumns(line) >= leadingIndentColumns(container.value)
    ) {
      return line
    }
    return null
  }
  return stripQuoteDepth(line, container.depth)
}

function leadingIndentColumns(line: string): number {
  let columns = 0
  for (const char of line) {
    if (char === ' ') columns++
    else if (char === '\t') columns += 4 - (columns % 4)
    else break
  }
  return columns
}

function matchingListContinuation(
  line: string,
  owners: PrefixSpec[],
): PrefixSpec | undefined {
  return owners
    .filter((owner) => line.startsWith(owner.continuation))
    .sort(
      (left, right) => right.continuation.length - left.continuation.length,
    )[0]
}

function continuationPrefix(owner: PrefixSpec): PrefixSpec {
  return {
    first: owner.continuation,
    continuation: owner.continuation,
    list: false,
    quoteDepth: owner.quoteDepth,
  }
}

function relativeView(line: string, listOwners: PrefixSpec[]): RelativeView {
  const prefix = prefixFor(line)
  if (prefix.list) {
    return {
      content: line.slice(prefix.first.length),
      container: { kind: 'prefix', value: prefix.continuation },
      listOwner: prefix,
      startsList: true,
    }
  }
  const listOwner = matchingListContinuation(line, listOwners)
  if (listOwner) {
    return {
      content: line.slice(listOwner.continuation.length),
      container: { kind: 'prefix', value: listOwner.continuation },
      listOwner,
      startsList: false,
    }
  }
  const quote = quoteView(line)
  return {
    content: quote.rest,
    container: { kind: 'quote', depth: quote.depth },
    startsList: false,
  }
}

function updateListContinuations(
  line: string,
  view: RelativeView,
  owners: PrefixSpec[],
): void {
  if (view.listOwner && view.startsList) {
    while (
      owners.length > 0 &&
      owners[owners.length - 1].continuation.length >=
        view.listOwner.continuation.length
    ) {
      owners.pop()
    }
    owners.push(view.listOwner)
    return
  }
  if (!line.trim()) return
  if (view.listOwner) {
    const owner = owners.indexOf(view.listOwner)
    owners.splice(owner + 1)
    return
  }
  owners.length = 0
}

function closesFence(
  content: string,
  fence: NonNullable<DelimitedState['fence']>,
): boolean {
  const match = content.match(/^ {0,3}(`+|~+)[ \t]*$/u)
  return match?.[1][0] === fence.marker && match[1].length >= fence.length
}

function htmlClosePattern(tag: string): RegExp {
  return new RegExp(`</${tag}[ \\t]*>`, 'iu')
}

function setextContent(
  line: SourceLine,
  prefix: PrefixSpec,
  quoteDepth: number,
  headingLine: boolean,
): string | null {
  if (!prefix.list) return stripQuoteDepth(line.text, quoteDepth)
  const expected = headingLine ? prefix.first : prefix.continuation
  return line.text.startsWith(expected)
    ? line.text.slice(expected.length)
    : null
}

function setextHeadingPrefix(
  heading: SourceLine,
  underline: SourceLine,
): PrefixSpec | null {
  if (underline.excluded || heading.excluded) return null
  const prefix = linePrefix(heading)
  const headingContent = setextContent(heading, prefix, prefix.quoteDepth, true)
  const underlineContent = setextContent(
    underline,
    prefix,
    prefix.quoteDepth,
    false,
  )
  if (
    headingContent == null ||
    underlineContent == null ||
    !headingContent.trim() ||
    !/^[ \t]*(?:=+|-+)[ \t]*$/u.test(underlineContent)
  ) {
    return null
  }
  return prefix
}

function markSetextPrelude(
  lines: SourceLine[],
  headingIndex: number,
  headingPrefix: PrefixSpec,
): void {
  let laterPrefix = headingPrefix
  for (let cursor = headingIndex - 1; cursor >= 0; cursor--) {
    const earlier = lines[cursor]
    if (earlier.excluded || !earlier.text.trim()) break
    const earlierPrefix = linePrefix(earlier)
    const compatible =
      earlierPrefix.quoteDepth === laterPrefix.quoteDepth &&
      (earlierPrefix.first === laterPrefix.first ||
        earlierPrefix.continuation === laterPrefix.first)
    if (!compatible) break
    earlier.excluded = true
    laterPrefix = earlierPrefix
  }
}

function markSetextHeadings(lines: SourceLine[]): void {
  for (let index = 1; index < lines.length; index++) {
    const underline = lines[index]
    const heading = lines[index - 1]
    const headingPrefix = setextHeadingPrefix(heading, underline)
    if (!headingPrefix) continue
    underline.excluded = true
    heading.excluded = true
    markSetextPrelude(lines, index - 1, headingPrefix)
  }
}

interface ReferenceContinuationState {
  needsDestination: boolean
  titleClose: string
}

type ReferenceContinuationResult = 'stop' | 'continue' | 'done'

function consumeReferenceContent(
  content: string,
  state: ReferenceContinuationState,
): ReferenceContinuationResult {
  if (state.titleClose) {
    return endsWithUnescaped(content, state.titleClose) ? 'done' : 'continue'
  }
  if (state.needsDestination) {
    const destination = referenceDestination(content)
    if (!destination) return 'stop'
    state.needsDestination = false
    if (!destination.title) return 'continue'
    state.titleClose = referenceTitleClose(destination.title)
    if (
      !state.titleClose ||
      endsWithUnescaped(destination.title, state.titleClose)
    ) {
      return 'done'
    }
    return 'continue'
  }
  state.titleClose = referenceTitleClose(content)
  if (!state.titleClose) return 'stop'
  return content.length > 1 && endsWithUnescaped(content, state.titleClose)
    ? 'done'
    : 'continue'
}

function endsWithUnescaped(content: string, delimiter: string): boolean {
  if (!content.endsWith(delimiter)) return false
  let backslashes = 0
  for (
    let cursor = content.length - delimiter.length - 1;
    cursor >= 0;
    cursor--
  ) {
    if (content[cursor] !== '\\') break
    backslashes++
  }
  return backslashes % 2 === 0
}

function linkReferenceDefinition(content: string): string | null {
  const match = content.match(/^\[(?:\\.|[^\]\\])+\]:[ \t]*(.*)$/u)
  return match?.[1] ?? null
}

function markReferenceContinuations(
  lines: SourceLine[],
  start: number,
  prefix: PrefixSpec,
  state: ReferenceContinuationState,
): number {
  let end = start
  for (let cursor = start + 1; cursor < lines.length; cursor++) {
    const continuation = lines[cursor]
    if (continuation.excluded || !continuation.text.trim()) break
    const content = linkReferenceContinuation(
      continuation.text,
      prefix,
      prefix.quoteDepth,
    )
    if (content == null) break
    const result = consumeReferenceContent(content.trim(), state)
    if (result === 'stop') break
    continuation.excluded = true
    end = cursor
    if (result === 'done') break
  }
  return end
}

function markLinkReferenceDefinitions(lines: SourceLine[]): void {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.excluded) continue
    const prefix = linePrefix(line)
    const content = line.text.slice(prefix.first.length)
    const definition = linkReferenceDefinition(content.trimStart())
    if (definition == null) continue
    line.excluded = true
    index = markReferenceContinuations(lines, index, prefix, {
      needsDestination: definition.trim() === '',
      titleClose: '',
    })
  }
}

function referenceDestination(content: string): { title: string } | null {
  const match = content.match(/^(?:<[^>]*>|\S+)(?:[ \t]+(.*))?$/u)
  return match ? { title: match[1] ?? '' } : null
}

function referenceTitleClose(content: string): string {
  if (content.startsWith('"')) return '"'
  if (content.startsWith("'")) return "'"
  if (content.startsWith('(')) return ')'
  return ''
}

function linkReferenceContinuation(
  line: string,
  prefix: PrefixSpec,
  quoteDepth: number,
): string | null {
  if (!prefix.list) return stripQuoteDepth(line, quoteDepth)
  return line.startsWith(prefix.continuation)
    ? line.slice(prefix.continuation.length)
    : null
}

function markFrontMatterLine(
  line: SourceLine,
  index: number,
  state: DelimitedState,
): boolean {
  if (!state.frontMatter) return false
  line.excluded = true
  const trimmed = line.text.trim()
  if (index > 0 && (trimmed === '---' || trimmed === '...')) {
    state.frontMatter = false
  }
  return true
}

function consumeFenceLine(line: SourceLine, state: DelimitedState): boolean {
  const fence = state.fence
  if (!fence) return false
  const content = contentInContainer(line.text, fence.container)
  if (content == null) {
    state.fence = null
    return false
  }
  line.excluded = true
  if (closesFence(content, fence)) state.fence = null
  return true
}

function consumeMathLine(line: SourceLine, state: DelimitedState): boolean {
  if (!state.math) return false
  const content = contentInContainer(line.text, state.math)
  if (content == null) {
    state.math = null
    return false
  }
  line.excluded = true
  if (/^[ \t]{0,3}\$\$[ \t]*$/u.test(content)) state.math = null
  return true
}

function consumeHtmlLine(line: SourceLine, state: DelimitedState): boolean {
  const html = state.html
  if (!html) return false
  const content = contentInContainer(line.text, html.container)
  if (content == null) {
    state.html = null
    return false
  }
  line.excluded = true
  if (htmlClosePattern(html.tag).test(content)) state.html = null
  return true
}

function consumeProtectedLine(
  line: SourceLine,
  state: DelimitedState,
): boolean {
  return (
    consumeFenceLine(line, state) ||
    consumeMathLine(line, state) ||
    consumeHtmlLine(line, state)
  )
}

function markProtectedOpening(
  line: SourceLine,
  view: RelativeView,
  state: DelimitedState,
): void {
  const fence = view.content.match(/^ {0,3}(`{3,}|~{3,})/u)
  if (fence) {
    line.excluded = true
    state.fence = {
      marker: fence[1][0],
      length: fence[1].length,
      container: view.container,
    }
    return
  }
  if (/^[ \t]{0,3}\$\$[ \t]*$/u.test(view.content)) {
    line.excluded = true
    state.math = view.container
    return
  }
  const html = view.content.match(
    /^[ \t]{0,3}<(pre|script|style|textarea)(?:[ \t>]|$)/iu,
  )
  if (!html) return
  line.excluded = true
  if (!htmlClosePattern(html[1]).test(view.content)) {
    state.html = { tag: html[1], container: view.container }
  }
}

function markDelimitedBlocks(lines: SourceLine[]): void {
  const state: DelimitedState = {
    fence: null,
    math: null,
    html: null,
    frontMatter: lines[0]?.text.trim() === '---',
  }
  const listOwners: PrefixSpec[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (markFrontMatterLine(line, index, state)) continue
    if (consumeProtectedLine(line, state)) continue
    const view = relativeView(line.text, listOwners)
    if (view.listOwner) {
      line.owner = view.startsList
        ? view.listOwner
        : continuationPrefix(view.listOwner)
    }
    markProtectedOpening(line, view, state)
    updateListContinuations(line.text, view, listOwners)
  }
  markLinkReferenceDefinitions(lines)
  markSetextHeadings(lines)
}

function prefixFor(line: string): PrefixSpec {
  const quote = quoteView(line)
  const rest = quote.rest
  const list = rest.match(
    /^([ \t]{0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/u,
  )
  if (list) {
    return {
      first: quote.prefix + list[1],
      continuation: quote.prefix + ' '.repeat(displayWidth(list[1])),
      list: true,
      quoteDepth: quote.depth,
    }
  }
  const callout = quote.prefix
    ? rest.match(/^(\[![A-Za-z][A-Za-z0-9_-]*\][ \t]+)/u)
    : null
  if (callout) {
    return {
      first: quote.prefix + callout[1],
      continuation: quote.prefix,
      list: false,
      quoteDepth: quote.depth,
    }
  }
  return {
    first: quote.prefix,
    continuation: quote.prefix,
    list: false,
    quoteDepth: quote.depth,
  }
}

function linePrefix(line: SourceLine): PrefixSpec {
  return line.owner ?? prefixFor(line.text)
}

function isThematicBreak(line: string): boolean {
  return /^[ \t]{0,3}(?:\*(?:[ \t]*\*){2,}|-(?:[ \t]*-){2,}|_(?:[ \t]*_){2,})[ \t]*$/u.test(
    line,
  )
}

function isListIndentedCode(line: string): boolean {
  return /^[ \t]{0,3}(?:[-+*]|\d{1,9}[.)]) {5,}\S/u.test(line)
}

function isStandaloneExcluded(
  line: SourceLine,
  prefix: PrefixSpec,
  owner?: PrefixSpec,
): boolean {
  if (line.excluded) return true
  const quotedContent = quoteView(line.text).rest
  if (isThematicBreak(quotedContent) || isListIndentedCode(quotedContent)) {
    return true
  }
  const content = line.text.slice(prefix.first.length)
  const trimmed = content.trim()
  if (!trimmed) return false
  if (/^(?:#{1,6}[ \t]+|={3,}$|-{3,}$|_{3,}$|\*{3,}$)/u.test(trimmed)) {
    return true
  }
  if (isThematicBreak(content)) return true
  const indentedContent =
    owner?.list && line.text.startsWith(owner.continuation)
      ? line.text.slice(owner.continuation.length)
      : quoteView(line.text).rest
  if (/^(?: {4}|\t)/u.test(indentedContent) && !prefix.list) {
    return true
  }
  if (/^<[/!A-Za-z][\s\S]*>?$/u.test(trimmed)) return true
  if (/^\[[^\]]+\]:[ \t]*\S/u.test(trimmed)) return true
  if (line.text.includes('|')) return true
  return false
}

function isUnitBoundary(line: SourceLine): boolean {
  // Container-only quote and callout lines carry Markdown bytes but no prose for rewrap to merge.
  const quote = quoteView(line.text)
  return (
    line.text.trim() === '' ||
    (quote.depth > 0 &&
      (/^[ \t]*$/u.test(quote.rest) ||
        /^\[![A-Za-z][A-Za-z0-9_-]*\][-+]?[ \t]*$/u.test(quote.rest)))
  )
}

export function explicitHardBreaks(markdown: string): ExplicitHardBreak[] {
  const lines = sourceLines(markdown)
  markDelimitedBlocks(lines)
  const breaks: ExplicitHardBreak[] = []
  for (let index = 0; index < lines.length - 1; index++) {
    const line = lines[index]
    const prefix = linePrefix(line)
    if (isStandaloneExcluded(line, prefix)) continue
    const content = line.text.slice(prefix.first.length)
    const suffix = content.match(HARD_BREAK_RE)?.[0]
    if (suffix) breaks.push({ line: index, suffix })
  }
  return breaks
}

function compatibleContinuation(line: SourceLine, prefix: PrefixSpec): boolean {
  if (isUnitBoundary(line)) return false
  const nextPrefix = linePrefix(line)
  if (prefix.quoteDepth !== nextPrefix.quoteDepth) return false
  if (prefix.list && nextPrefix.list) return false
  if (prefix.list) return line.text.startsWith(prefix.continuation)
  if (prefix.first) return line.text.startsWith(prefix.continuation)
  return nextPrefix.first === ''
}

function unitEndLine(
  lines: SourceLine[],
  start: number,
  last: number,
  prefix: PrefixSpec,
  failOnExcluded: boolean,
): number {
  let end = start
  while (end < last) {
    const next = lines[end + 1]
    if (!compatibleContinuation(next, prefix)) break
    if (isStandaloneExcluded(next, linePrefix(next), prefix)) {
      return failOnExcluded ? -1 : end
    }
    end++
  }
  return end
}

function logicalUnits(
  lines: SourceLine[],
  first: number,
  last: number,
  failOnExcluded = true,
): LogicalUnit[] {
  const units: LogicalUnit[] = []
  let index = first
  while (index <= last) {
    const line = lines[index]
    if (isUnitBoundary(line)) {
      index++
      continue
    }
    const prefix = linePrefix(line)
    if (isStandaloneExcluded(line, prefix)) {
      if (failOnExcluded) return []
      index++
      continue
    }
    const endLine = unitEndLine(lines, index, last, prefix, failOnExcluded)
    if (endLine < 0) return []
    units.push({ startLine: index, endLine, prefix })
    index = endLine + 1
  }
  return units
}

function lineIndexAt(lines: SourceLine[], offset: number): number {
  const found = lines.findIndex(
    (line) => offset >= line.start && offset <= line.endWithBreak,
  )
  return found < 0 ? lines.length - 1 : found
}

function selectedLineRange(
  lines: SourceLine[],
  startOffset: number,
  endOffset: number,
): { first: number; last: number } {
  const first = lineIndexAt(lines, startOffset)
  let last = lineIndexAt(lines, endOffset)
  if (
    endOffset > startOffset &&
    last > first &&
    endOffset === lines[last].start
  ) {
    last--
  }
  return { first, last }
}

function collapsedUnit(
  lines: SourceLine[],
  caretOffset: number,
): LogicalUnit | null {
  const caretLine = lineIndexAt(lines, caretOffset)
  if (isUnitBoundary(lines[caretLine])) return null
  let first = caretLine
  let last = caretLine
  while (first > 0 && !isUnitBoundary(lines[first - 1])) first--
  while (last + 1 < lines.length && !isUnitBoundary(lines[last + 1])) last++
  const units = logicalUnits(lines, first, last)
  return (
    units.find(
      (unit) => caretLine >= unit.startLine && caretLine <= unit.endLine,
    ) ?? null
  )
}

function codePointWidth(codePoint: number, char: string): number {
  if (
    codePoint === 0 ||
    codePoint < 32 ||
    (codePoint >= 0x7f && codePoint < 0xa0)
  ) {
    return 0
  }
  if (COMBINING_OR_FORMAT_RE.test(char)) return 0
  const wide =
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint !== 0x303f &&
      WIDE_RANGES.some(
        ([first, last]) => codePoint >= first && codePoint <= last,
      ))
  return wide ? 2 : 1
}

function displayWidth(value: string): number {
  let width = 0
  for (const char of value.replaceAll(CARET_MARKER_BASE, '')) {
    width += codePointWidth(char.codePointAt(0) ?? 0, char)
  }
  return width
}

/** The caret the planner places its marker at: a caret inside a line's block-syntax prefix (quote
 * marks, list marker, indentation) moves to the end of that prefix, so the marker never splits
 * syntax and the planned bytes do not depend on where in the prefix the caret was. */
function caretAfterLinePrefix(lines: SourceLine[], caret: number): number {
  const line = lines.find(
    (candidate) => caret >= candidate.start && caret <= candidate.end,
  )
  if (!line) return caret
  const prefix = linePrefix(line)
  const length = line.text.startsWith(prefix.first)
    ? prefix.first.length
    : line.text.startsWith(prefix.continuation)
      ? prefix.continuation.length
      : 0
  return caret < line.start + length ? line.start + length : caret
}

function uniqueCaretMarker(markdown: string): string {
  let marker = CARET_MARKER_BASE
  while (markdown.includes(marker)) marker += '_'
  return marker
}

function contentForLine(
  line: string,
  prefix: PrefixSpec,
  first: boolean,
): string | null {
  const expected = first ? prefix.first : prefix.continuation
  if (!line.startsWith(expected)) return null
  return line.slice(expected.length)
}

function wrapWords(
  text: string,
  prefix: PrefixSpec,
  column: number,
  firstOutput: boolean,
): { lines: string[]; firstOutput: boolean } {
  const words = text.trim().split(/\s+/u).filter(Boolean)
  if (words.length === 0) return { lines: [], firstOutput }
  const output: string[] = []
  let current = ''
  for (const word of words) {
    const linePrefix = firstOutput ? prefix.first : prefix.continuation
    const candidate = current ? `${current} ${word}` : word
    if (
      current &&
      displayWidth(linePrefix) + displayWidth(candidate) > column
    ) {
      output.push(linePrefix + current)
      firstOutput = false
      current = word
    } else {
      current = candidate
    }
  }
  if (current) {
    output.push((firstOutput ? prefix.first : prefix.continuation) + current)
    firstOutput = false
  }
  return { lines: output, firstOutput }
}

function appendWrappedSegment(
  output: string[],
  segment: string,
  hardBreak: string,
  prefix: PrefixSpec,
  column: number,
  firstOutput: boolean,
): boolean | null {
  const wrapped = wrapWords(segment, prefix, column, firstOutput)
  if (wrapped.lines.length === 0) return hardBreak ? null : firstOutput
  if (hardBreak) wrapped.lines[wrapped.lines.length - 1] += hardBreak
  output.push(...wrapped.lines)
  return wrapped.firstOutput
}

function prosePart(
  line: SourceLine,
  prefix: PrefixSpec,
  first: boolean,
): { text: string; hardBreak: string } | null {
  const raw = contentForLine(line.text, prefix, first)
  if (raw == null) return null
  const hardBreak = raw.match(HARD_BREAK_RE)?.[0] ?? ''
  return {
    text: (hardBreak ? raw.slice(0, -hardBreak.length) : raw).trim(),
    hardBreak,
  }
}

function formatUnit(
  lines: SourceLine[],
  unit: LogicalUnit,
  column: number,
): string[] | null {
  const output: string[] = []
  let segment = ''
  let firstOutput = true
  for (let index = unit.startLine; index <= unit.endLine; index++) {
    const part = prosePart(lines[index], unit.prefix, index === unit.startLine)
    if (!part) return null
    if (part.text) segment = segment ? `${segment} ${part.text}` : part.text
    if (part.hardBreak) {
      const next = appendWrappedSegment(
        output,
        segment,
        part.hardBreak,
        unit.prefix,
        column,
        firstOutput,
      )
      if (next == null) return null
      firstOutput = next
      segment = ''
    }
  }
  if (segment) {
    appendWrappedSegment(output, segment, '', unit.prefix, column, firstOutput)
  }
  return output
}

function unitsForRange(
  lines: SourceLine[],
  start: number,
  end: number,
): LogicalUnit[] {
  if (start === end) {
    const unit = collapsedUnit(lines, start)
    return unit ? [unit] : []
  }
  const range = selectedLineRange(lines, start, end)
  return logicalUnits(lines, range.first, range.last)
}

function formatMarkedUnits(
  markedLines: SourceLine[],
  units: LogicalUnit[],
  column: number,
): string[] | null {
  const replacement: string[] = []
  let cursorLine = units[0].startLine
  for (const unit of units) {
    while (cursorLine < unit.startLine) {
      replacement.push(markedLines[cursorLine].text)
      cursorLine++
    }
    const markedUnit: LogicalUnit = {
      ...unit,
      prefix: linePrefix(markedLines[unit.startLine]),
    }
    const formatted = formatUnit(markedLines, markedUnit, column)
    if (!formatted) return null
    replacement.push(...formatted)
    cursorLine = unit.endLine + 1
  }
  return replacement
}

export function rewrapMarkdownRange(
  markdown: string,
  startOffset: number,
  endOffset: number,
  caretOffset: number,
  column: number,
): RewrapResult {
  const safeCaret = clamp(caretOffset, 0, markdown.length)
  const noChange = (): RewrapResult => ({
    markdown,
    caretOffset: safeCaret,
    changed: false,
  })
  if (!Number.isFinite(column) || column < 1) return noChange()
  const start = clamp(Math.min(startOffset, endOffset), 0, markdown.length)
  const end = clamp(Math.max(startOffset, endOffset), 0, markdown.length)
  const lines = sourceLines(markdown)
  markDelimitedBlocks(lines)

  const units = unitsForRange(lines, start, end)
  if (units.length === 0) return noChange()

  const rangeStart = lines[units[0].startLine].start
  const lastLine = lines[units[units.length - 1].endLine]
  const rangeEnd = lastLine.endWithBreak
  const marker = uniqueCaretMarker(markdown)
  const markerCaret = caretAfterLinePrefix(lines, safeCaret)
  const markerInRange = markerCaret >= rangeStart && markerCaret < rangeEnd
  const markedMarkdown = markerInRange
    ? markdown.slice(0, markerCaret) + marker + markdown.slice(markerCaret)
    : markdown
  const markedLines = sourceLines(markedMarkdown)
  markDelimitedBlocks(markedLines)

  const replacement = formatMarkedUnits(markedLines, units, Math.floor(column))
  if (!replacement) return noChange()
  const newline = lastLine.newline || '\n'
  let replacementText = replacement.join(newline)
  if (lastLine.newline) replacementText += lastLine.newline
  let nextMarkdown =
    markedMarkdown.slice(0, rangeStart) +
    replacementText +
    markedMarkdown.slice(rangeEnd + (markerInRange ? marker.length : 0))

  let nextCaret: number
  const markerIndex = nextMarkdown.indexOf(marker)
  if (markerIndex >= 0) {
    nextCaret = markerIndex
    nextMarkdown =
      nextMarkdown.slice(0, markerIndex) +
      nextMarkdown.slice(markerIndex + marker.length)
  } else if (safeCaret >= rangeEnd) {
    nextCaret = safeCaret + (nextMarkdown.length - markdown.length)
  } else {
    nextCaret = clamp(
      safeCaret,
      rangeStart,
      rangeStart + replacementText.length,
    )
  }
  if (nextMarkdown === markdown) return noChange()
  return { markdown: nextMarkdown, caretOffset: nextCaret, changed: true }
}

export function rewrapMarkdownDocument(
  markdown: string,
  caretOffset: number,
  column: number,
): RewrapResult {
  const safeCaret = clamp(caretOffset, 0, markdown.length)
  const noChange = (): RewrapResult => ({
    markdown,
    caretOffset: safeCaret,
    changed: false,
  })
  if (!Number.isFinite(column) || column < 1) return noChange()

  const lines = sourceLines(markdown)
  markDelimitedBlocks(lines)
  const units = logicalUnits(lines, 0, lines.length - 1, false)
  if (units.length === 0) return noChange()

  const marker = uniqueCaretMarker(markdown)
  const markerCaret = caretAfterLinePrefix(lines, safeCaret)
  const markedMarkdown =
    markdown.slice(0, markerCaret) + marker + markdown.slice(markerCaret)
  const markedLines = sourceLines(markedMarkdown)
  markDelimitedBlocks(markedLines)
  let nextMarkdown = markedMarkdown

  for (let index = units.length - 1; index >= 0; index--) {
    const unit = units[index]
    const markedUnit: LogicalUnit = {
      ...unit,
      prefix: linePrefix(markedLines[unit.startLine]),
    }
    const formatted = formatUnit(markedLines, markedUnit, Math.floor(column))
    if (!formatted) return noChange()
    const firstLine = markedLines[unit.startLine]
    const lastLine = markedLines[unit.endLine]
    const newline = lastLine.newline || firstLine.newline || '\n'
    let replacement = formatted.join(newline)
    if (lastLine.newline) replacement += lastLine.newline
    nextMarkdown =
      nextMarkdown.slice(0, firstLine.start) +
      replacement +
      nextMarkdown.slice(lastLine.endWithBreak)
  }

  const nextCaret = nextMarkdown.indexOf(marker)
  if (nextCaret < 0) return noChange()
  nextMarkdown =
    nextMarkdown.slice(0, nextCaret) +
    nextMarkdown.slice(nextCaret + marker.length)
  if (nextMarkdown === markdown) return noChange()
  return { markdown: nextMarkdown, caretOffset: nextCaret, changed: true }
}
