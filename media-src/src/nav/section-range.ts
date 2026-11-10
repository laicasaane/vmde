export interface SectionRange {
  start: number
  end: number
  level: number
}

export interface HeadingPathEntry {
  index: number
  level: number
  text: string
}

const HEADING_TAG = /^H([1-6])$/

export function topLevelBlocks(surface: HTMLElement): HTMLElement[] {
  return Array.from(surface.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.hasAttribute('data-block'),
  )
}

export function headingLevel(block: HTMLElement): number | null {
  const match = HEADING_TAG.exec(block.tagName)
  return match ? Number(match[1]) : null
}

/** `levelOf` decides which blocks are headings; Preview passes one that skips raw HTML headings
 * (Task 721), which IR and WYSIWYG keep as HTML blocks. */
export function sectionRangeForHeading(
  blocks: readonly HTMLElement[],
  start: number,
  levelOf: (block: HTMLElement) => number | null = headingLevel,
): SectionRange | null {
  const level = blocks[start] ? levelOf(blocks[start]) : null
  if (level === null) return null
  let end = blocks.length
  for (let index = start + 1; index < blocks.length; index++) {
    const candidateLevel = levelOf(blocks[index])
    if (candidateLevel !== null && candidateLevel <= level) {
      end = index
      break
    }
  }
  return { start, end, level }
}

export function headingLabel(block: HTMLElement): string {
  const clone = block.cloneNode(true) as HTMLElement
  for (const marker of clone.querySelectorAll(
    '.vditor-ir__marker, [data-type$="marker"]',
  )) {
    marker.remove()
  }
  return clone.textContent?.trim() ?? ''
}

export function headingPathForIndex(
  blocks: readonly HTMLElement[],
  target: number,
): HeadingPathEntry[] {
  const path: HeadingPathEntry[] = []
  for (let index = 0; index <= target && index < blocks.length; index++) {
    const level = headingLevel(blocks[index])
    if (level === null) continue
    while ((path.at(-1)?.level ?? 0) >= level) path.pop()
    path.push({ index, level, text: headingLabel(blocks[index]) })
  }
  return path
}

interface MarkdownLine {
  text: string
  start: number
  end: number
  endWithBreak: number
  lineBreak: string
}

interface MarkdownHeading {
  kind: 'atx' | 'setext'
  level: number
  start: number
  end: number
  line: MarkdownLine
  markerStart: number
  markerEnd: number
  title?: MarkdownLine
}

export interface HeadingLevelShiftInput {
  markdown: string
  startOffset: number
  endOffset: number
  caretOffset: number
  direction: -1 | 1
  section?: boolean
}

export type HeadingLevelShiftResult =
  | {
      status: 'ok'
      markdown: string
      caretOffset: number
      shifted: number
      scope: 'single' | 'section'
    }
  | { status: 'clamped' | 'not-heading' }

function markdownLines(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = []
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/gu
  for (;;) {
    const match = pattern.exec(markdown)
    if (!match || match[0] === '') break
    lines.push({
      text: match[1],
      start: match.index,
      end: match.index + match[1].length,
      endWithBreak: match.index + match[0].length,
      lineBreak: match[2],
    })
    if (!match[2]) break
  }
  return lines
}

interface FenceState {
  marker: string
  length: number
}

interface HtmlBlockState {
  terminator: RegExp | 'blank'
}

const HTML_BLOCK_TAG =
  /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)$/iu
const COMPLETE_HTML_TAG =
  /^(?:<\/[A-Za-z][A-Za-z0-9-]*[\t ]*>|<[A-Za-z][A-Za-z0-9-]*(?:[\t ]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[\t ]*=[\t ]*(?:[^"'=<>`\t ]+|'[^']*'|"[^"]*"))?)*[\t ]*\/?>)[\t ]*$/u

interface HtmlBlockOpening {
  next: HtmlBlockState | null
}

function rawElementHtmlOpening(trimmed: string): HtmlBlockOpening | null {
  const match = /^<(script|pre|style|textarea)(?:[\t ]|>|$)/iu.exec(trimmed)
  if (!match) return null
  const terminator = new RegExp(`</${match[1]}[\\t ]*>`, 'iu')
  return { next: terminator.test(trimmed) ? null : { terminator } }
}

function delimitedHtmlOpening(trimmed: string): HtmlBlockOpening | null {
  const delimiters: Array<[RegExp, RegExp]> = [
    [/^<!--/u, /-->/u],
    [/^<\?/u, /\?>/u],
    [/^<![A-Z]/u, />/u],
    [/^<!\[CDATA\[/u, /\]\]>/u],
  ]
  for (const [start, terminator] of delimiters) {
    const match = start.exec(trimmed)
    if (!match) continue
    return {
      next: terminator.test(trimmed.slice(match[0].length))
        ? null
        : { terminator },
    }
  }
  return null
}

function htmlBlockStep(
  text: string,
  current: HtmlBlockState | null,
  allowTypeSeven = false,
): { skip: boolean; next: HtmlBlockState | null } {
  if (current) {
    const closes =
      current.terminator === 'blank'
        ? text.trim() === ''
        : current.terminator.test(text)
    return { skip: true, next: closes ? null : current }
  }
  const trimmed = text.replace(/^ {0,3}/u, '')
  const delimited =
    rawElementHtmlOpening(trimmed) ?? delimitedHtmlOpening(trimmed)
  if (delimited) return { skip: true, next: delimited.next }
  const blockTag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[\t ]|\/?>|$)/u.exec(trimmed)
  return (blockTag && HTML_BLOCK_TAG.test(blockTag[1])) ||
    (allowTypeSeven && COMPLETE_HTML_TAG.test(trimmed))
    ? { skip: true, next: { terminator: 'blank' } }
    : { skip: false, next: null }
}

function fenceStep(
  text: string,
  current: FenceState | null,
): { skip: boolean; next: FenceState | null } {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(text)
  if (current) {
    const closes = Boolean(
      match &&
        match[1][0] === current.marker &&
        match[1].length >= current.length &&
        text.slice(match[0].length).trim() === '',
    )
    return { skip: true, next: closes ? null : current }
  }
  return match
    ? {
        skip: true,
        next: { marker: match[1][0], length: match[1].length },
      }
    : { skip: false, next: null }
}

function atxHeading(line: MarkdownLine): MarkdownHeading | null {
  const match = /^( {0,3})(#{1,6})(?:[\t ]+|$)/u.exec(line.text)
  return match
    ? {
        kind: 'atx',
        level: match[2].length,
        start: line.start,
        end: line.endWithBreak,
        line,
        markerStart: line.start + match[1].length,
        markerEnd: line.start + match[1].length + match[2].length,
      }
    : null
}

function setextHeading(
  line: MarkdownLine,
  underline: MarkdownLine | undefined,
): MarkdownHeading | null {
  const match = underline ? /^ {0,3}(=+|-+)[\t ]*$/u.exec(underline.text) : null
  const startsAnotherBlock =
    /^(?: {4}|\t)/u.test(line.text) ||
    /^ {0,3}>/u.test(line.text) ||
    /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[\t ]+|$)/u.test(line.text) ||
    /^ {0,3}(?:(?:\*[\t ]*){3,}|(?:-[\t ]*){3,}|(?:_[\t ]*){3,})$/u.test(
      line.text,
    )
  if (!match || !line.text.trim() || !underline || startsAnotherBlock)
    return null
  return {
    kind: 'setext',
    level: match[1][0] === '=' ? 1 : 2,
    start: line.start,
    end: underline.endWithBreak,
    line,
    title: line,
    markerStart: underline.start,
    markerEnd: underline.end,
  }
}

function continuesParagraph(text: string, alreadyActive: boolean): boolean {
  if (/^(?: {4}|\t)/u.test(text)) return alreadyActive
  return !(
    /^ {0,3}>/u.test(text) ||
    /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[\t ]+|$)/u.test(text) ||
    /^ {0,3}(?:(?:\*[\t ]*){3,}|(?:-[\t ]*){3,}|(?:_[\t ]*){3,})$/u.test(
      text,
    ) ||
    /^ {0,3}\[[^\]]+\]:/u.test(text)
  )
}

interface HeadingScanState {
  fence: FenceState | null
  htmlBlock: HtmlBlockState | null
  paragraphActive: boolean
}

function skipProtectedHeadingLine(
  text: string,
  state: HeadingScanState,
): boolean {
  if (state.fence) {
    state.fence = fenceStep(text, state.fence).next
    state.paragraphActive = false
    return true
  }
  if (state.htmlBlock) {
    state.htmlBlock = htmlBlockStep(text, state.htmlBlock).next
    state.paragraphActive = false
    return true
  }
  const fenceOpening = fenceStep(text, null)
  if (fenceOpening.skip) {
    state.fence = fenceOpening.next
    state.paragraphActive = false
    return true
  }
  const htmlOpening = htmlBlockStep(text, null, !state.paragraphActive)
  if (!htmlOpening.skip) return false
  state.htmlBlock = htmlOpening.next
  state.paragraphActive = false
  return true
}

function sourceHeadings(markdown: string): MarkdownHeading[] {
  const lines = markdownLines(markdown)
  const headings: MarkdownHeading[] = []
  const state: HeadingScanState = {
    fence: null,
    htmlBlock: null,
    paragraphActive: false,
  }
  let firstContentLine = 0
  if (lines[0]?.text.trim() === '---') {
    const frontmatterEnd = lines.findIndex(
      (line, index) =>
        index > 0 && (line.text.trim() === '---' || line.text.trim() === '...'),
    )
    if (frontmatterEnd > 0) firstContentLine = frontmatterEnd + 1
  }
  for (let index = firstContentLine; index < lines.length; index++) {
    const line = lines[index]
    if (skipProtectedHeadingLine(line.text, state)) continue
    if (line.text.trim() === '') {
      state.paragraphActive = false
      continue
    }
    const atx = atxHeading(line)
    if (atx) {
      headings.push(atx)
      state.paragraphActive = false
      continue
    }
    const setext = setextHeading(line, lines[index + 1])
    if (setext) {
      headings.push(setext)
      state.paragraphActive = false
      index++
    } else {
      state.paragraphActive = continuesParagraph(
        line.text,
        state.paragraphActive,
      )
    }
  }
  return headings
}

interface HeadingEdit {
  start: number
  end: number
  replacement: string
  mapCaret(offset: number): number
}

function headingEdit(heading: MarkdownHeading, direction: -1 | 1): HeadingEdit {
  const level = heading.level + direction
  if (heading.kind === 'atx') {
    const relativeMarkerEnd = heading.markerEnd - heading.line.start
    const marker = '#'.repeat(level)
    const replacement =
      heading.line.text.slice(0, heading.markerStart - heading.line.start) +
      marker +
      heading.line.text.slice(relativeMarkerEnd) +
      heading.line.lineBreak
    return {
      start: heading.start,
      end: heading.end,
      replacement,
      mapCaret: (offset) => {
        const delta = direction
        return offset <= heading.markerEnd
          ? heading.markerStart + marker.length
          : offset + delta
      },
    }
  }

  const title = heading.title!
  const indent = /^ {0,3}/u.exec(title.text)?.[0] ?? ''
  const prefix = `${'#'.repeat(level)} `
  const replacement = `${indent}${prefix}${title.text.slice(indent.length)}${title.lineBreak}`
  return {
    start: heading.start,
    end: heading.end,
    replacement,
    mapCaret: (offset) => {
      if (offset > title.end)
        return heading.start + title.text.length + prefix.length
      const indentEnd = title.start + indent.length
      return offset <= indentEnd ? offset : offset + prefix.length
    },
  }
}

function mappedCaret(
  caretOffset: number,
  edits: readonly HeadingEdit[],
): number {
  let delta = 0
  for (const edit of edits) {
    if (caretOffset < edit.start) break
    if (caretOffset <= edit.end) return edit.mapCaret(caretOffset) + delta
    delta += edit.replacement.length - (edit.end - edit.start)
  }
  return caretOffset + delta
}

export function shiftMarkdownHeadingLevels(
  input: HeadingLevelShiftInput,
): HeadingLevelShiftResult {
  const headings = sourceHeadings(input.markdown)
  const collapsed = input.startOffset === input.endOffset
  const rootIndex = headings.findIndex((heading) =>
    collapsed
      ? input.startOffset >= heading.start && input.startOffset <= heading.end
      : heading.start < input.endOffset && heading.end > input.startOffset,
  )
  if (rootIndex < 0) return { status: 'not-heading' }

  const root = headings[rootIndex]
  const section = Boolean(
    input.section || (!collapsed && input.endOffset > root.end),
  )
  let endIndex = rootIndex + 1
  if (section) {
    while (endIndex < headings.length && headings[endIndex].level > root.level)
      endIndex++
  }
  const targets = headings.slice(rootIndex, endIndex)
  if (
    targets.some((heading) => {
      const next = heading.level + input.direction
      return next < 1 || next > 6
    })
  )
    return { status: 'clamped' }

  const edits = targets.map((heading) => headingEdit(heading, input.direction))
  let markdown = input.markdown
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index]
    markdown =
      markdown.slice(0, edit.start) +
      edit.replacement +
      markdown.slice(edit.end)
  }
  return {
    status: 'ok',
    markdown,
    caretOffset: mappedCaret(input.caretOffset, edits),
    shifted: targets.length,
    scope: section ? 'section' : 'single',
  }
}
