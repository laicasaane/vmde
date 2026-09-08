/** A half-open UTF-16 range in one exact Markdown snapshot. */
export interface SourceRange {
  start: number
  end: number
}

export type SourceMoveResult =
  | {
      status: 'ok'
      markdown: string
      movedRange: SourceRange
      /** Maps a snapshot offset into the reordered snapshot. */
      mapOffset(offset: number): number
    }
  | { status: 'noop' }
  | { status: 'rejected'; reason: 'invalid-offset' }

function validOffset(offset: number, length: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= length
}

/**
 * Moves an exact source range without interpreting Markdown. Heading and list planners own
 * their respective boundary rules; keeping this primitive raw makes it reusable by Task 259.
 */
export function moveSourceRange(
  markdown: string,
  range: SourceRange,
  insertionOffset: number,
): SourceMoveResult {
  const { start, end } = range
  if (
    !validOffset(start, markdown.length) ||
    !validOffset(end, markdown.length) ||
    !validOffset(insertionOffset, markdown.length) ||
    start >= end
  ) {
    return { status: 'rejected', reason: 'invalid-offset' }
  }
  if (insertionOffset >= start && insertionOffset <= end)
    return { status: 'noop' }

  const moved = markdown.slice(start, end)
  const remaining = markdown.slice(0, start) + markdown.slice(end)
  const adjustedInsertion =
    insertionOffset < start ? insertionOffset : insertionOffset - moved.length
  const next =
    remaining.slice(0, adjustedInsertion) +
    moved +
    remaining.slice(adjustedInsertion)
  const movedRange = {
    start: adjustedInsertion,
    end: adjustedInsertion + moved.length,
  }

  return {
    status: 'ok',
    markdown: next,
    movedRange,
    mapOffset: (offset) => {
      if (!validOffset(offset, markdown.length)) return offset
      if (offset >= start && offset <= end)
        return movedRange.start + offset - start
      if (insertionOffset < start) {
        if (offset >= insertionOffset && offset < start)
          return offset + moved.length
        return offset
      }
      if (offset > end && offset < insertionOffset) return offset - moved.length
      return offset
    },
  }
}

export interface HeadingIdentity {
  start: number
  level: number
}

export type SectionPlacement = 'before' | 'after'

export type MarkdownSectionMoveResult =
  | {
      status: 'ok'
      markdown: string
      movedRange: SourceRange
    }
  | { status: 'noop' }
  | {
      status: 'rejected'
      reason: 'invalid-offset' | 'stale-heading' | 'level-mismatch' | 'overlap'
    }

export interface SourceHeading extends HeadingIdentity {
  end: number
}

/** Human-visible text used only to prove an outline row still agrees with exact source order. */
export function sourceHeadingLabel(
  markdown: string,
  heading: SourceHeading,
): string {
  const source = markdown.slice(heading.start, heading.end)
  const lines = source.split(/\r\n|\n|\r/u)
  const atx = /^(?: {0,3})#{1,6}[\t ]*(.*)$/u.exec(lines[0] ?? '')
  if (atx)
    return atx[1]
      .replace(/[\t ]+#+[\t ]*$/u, '')
      .replace(/\s+/gu, ' ')
      .trim()
  return lines.slice(0, -1).join(' ').replace(/\s+/gu, ' ').trim()
}

interface SourceSection extends SourceHeading {
  sectionEnd: number
  coreEnd: number
}

interface MarkdownLine {
  text: string
  start: number
  end: number
  endWithBreak: number
}

function markdownLines(markdown: string): MarkdownLine[] {
  const out: MarkdownLine[] = []
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/gu
  for (;;) {
    const match = pattern.exec(markdown)
    if (!match || match[0] === '') return out
    out.push({
      text: match[1],
      start: match.index,
      end: match.index + match[1].length,
      endWithBreak: match.index + match[0].length,
    })
    if (!match[2]) return out
  }
}

function isContainerLine(text: string): boolean {
  return /^(?: {4}|\t| {0,3}>| {0,3}(?:[-+*]|\d{1,9}[.)])(?:[\t ]+|$))/u.test(
    text,
  )
}

function fencedOpening(
  text: string,
): { marker: string; length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(text)
  if (!match) return null
  // CommonMark forbids a backtick in the info string of a backtick fence. Treating one
  // as an opener would hide later real headings until an unrelated closing fence appears.
  if (match[1][0] === '`' && match[2].includes('`')) return null
  return { marker: match[1][0], length: match[1].length }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: source protection is intentionally one ordered state machine so fenced and HTML regions cannot drift between branches.
export function scanSourceHeadings(markdown: string): SourceHeading[] {
  const lines = markdownLines(markdown)
  const headings: SourceHeading[] = []
  let first = 0
  if (lines[0]?.text.trim() === '---') {
    const end = lines.findIndex(
      (line, index) =>
        index > 0 && (line.text.trim() === '---' || line.text.trim() === '...'),
    )
    if (end > 0) first = end + 1
  }
  let fence: { marker: string; length: number } | undefined
  let html: RegExp | 'blank' | undefined
  let listContinuation = false
  let paragraphStart: number | undefined
  for (let index = first; index < lines.length; index++) {
    const line = lines[index]
    const trimmed = line.text.replace(/^ {0,3}/u, '')
    if (fence) {
      const closing = fencedOpening(line.text)
      if (
        closing &&
        closing.marker === fence.marker &&
        closing.length >= fence.length &&
        line.text
          .slice(/^ {0,3}(?:`{3,}|~{3,})/u.exec(line.text)![0].length)
          .trim() === ''
      ) {
        fence = undefined
      }
      paragraphStart = undefined
      continue
    }
    const openingFence = fencedOpening(line.text)
    if (openingFence) {
      fence = openingFence
      paragraphStart = undefined
      continue
    }
    if (html) {
      if (html === 'blank' ? trimmed === '' : html.test(trimmed))
        html = undefined
      paragraphStart = undefined
      continue
    }
    if (/^<!--/u.test(trimmed)) {
      if (!/-->/u.test(trimmed.slice(4))) html = /-->/u
      paragraphStart = undefined
      continue
    }
    const rawHtml = /^<(?:script|pre|style|textarea)(?:[\t ]|>|$)/iu.exec(
      trimmed,
    )
    if (rawHtml) {
      const close = new RegExp(
        `</${rawHtml[0].slice(1).split(/[\\s>]/u)[0]}[\\t ]*>`,
        'iu',
      )
      if (!close.test(trimmed)) html = close
      paragraphStart = undefined
      continue
    }
    if (
      /^<\/?(?:address|article|aside|blockquote|div|figure|footer|header|main|nav|section|table|ul|ol|li|h[1-6])(?:[\t ]|>|\/|$)/iu.test(
        trimmed,
      )
    ) {
      html = 'blank'
      paragraphStart = undefined
      continue
    }
    if (line.text.trim() === '') {
      listContinuation = false
      paragraphStart = undefined
      continue
    }
    if (isContainerLine(line.text)) {
      listContinuation = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[\t ]+|$)/u.test(
        line.text,
      )
      paragraphStart = undefined
      continue
    }
    if (listContinuation && /^(?: {2,}|\t)/u.test(line.text)) {
      paragraphStart = undefined
      continue
    }
    listContinuation = false
    const atx = /^( {0,3})(#{1,6})(?:[\t ]+|$)/u.exec(line.text)
    if (atx) {
      headings.push({
        start: line.start,
        end: line.endWithBreak,
        level: atx[2].length,
      })
      paragraphStart = undefined
      continue
    }
    const underline = lines[index + 1]
    const setext = underline && /^ {0,3}(=+|-+)[\t ]*$/u.exec(underline.text)
    if (setext && line.text.trim()) {
      headings.push({
        start: paragraphStart ?? line.start,
        end: underline.endWithBreak,
        level: setext[1][0] === '=' ? 1 : 2,
      })
      paragraphStart = undefined
      index++
    } else {
      paragraphStart ??= line.start
    }
  }
  return headings
}

function trailingNewlineStart(
  markdown: string,
  start: number,
  end: number,
): number {
  let cursor = end
  while (cursor > start && /[\r\n]/u.test(markdown[cursor - 1])) cursor--
  return cursor
}

function sectionForHeading(
  headings: readonly SourceHeading[],
  identity: HeadingIdentity,
  markdown: string,
): SourceSection | undefined {
  const index = headings.findIndex(
    (heading) =>
      heading.start === identity.start && heading.level === identity.level,
  )
  if (index < 0) return undefined
  const heading = headings[index]
  const boundary = headings
    .slice(index + 1)
    .find((next) => next.level <= heading.level)
  const sectionEnd = boundary?.start ?? markdown.length
  return {
    ...heading,
    sectionEnd,
    coreEnd: trailingNewlineStart(markdown, heading.start, sectionEnd),
  }
}

/**
 * Reorders one complete same-level heading section while retaining authored EOL and separator
 * bytes. Callers must bind identities to the current document snapshot before invoking it.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: EOF separator ownership is one exact-byte transaction with coupled stale and overlap checks.
export function moveMarkdownSection(
  markdown: string,
  source: HeadingIdentity,
  target: HeadingIdentity,
  placement: SectionPlacement,
): MarkdownSectionMoveResult {
  if (placement !== 'before' && placement !== 'after') {
    return { status: 'rejected', reason: 'invalid-offset' }
  }
  const headings = scanSourceHeadings(markdown)
  const sourceSection = sectionForHeading(headings, source, markdown)
  const targetSection = sectionForHeading(headings, target, markdown)
  if (!sourceSection || !targetSection)
    return { status: 'rejected', reason: 'stale-heading' }
  if (sourceSection.level !== targetSection.level)
    return { status: 'rejected', reason: 'level-mismatch' }
  if (
    targetSection.start >= sourceSection.start &&
    targetSection.start < sourceSection.sectionEnd
  ) {
    return sourceSection.start === targetSection.start
      ? { status: 'noop' }
      : { status: 'rejected', reason: 'overlap' }
  }
  if (
    (placement === 'before' &&
      sourceSection.sectionEnd === targetSection.start) ||
    (placement === 'after' && targetSection.sectionEnd === sourceSection.start)
  ) {
    return { status: 'noop' }
  }

  const sourceCore = markdown.slice(sourceSection.start, sourceSection.coreEnd)
  let separator = markdown.slice(
    sourceSection.coreEnd,
    sourceSection.sectionEnd,
  )
  let removeStart = sourceSection.start
  let removeEnd = sourceSection.sectionEnd
  if (sourceSection.sectionEnd === markdown.length) {
    // A final section owns terminal whitespace, not the separator before it. Transfer the
    // preceding separator onto the moved section and leave the terminal bytes with the new EOF.
    const before = trailingNewlineStart(markdown, 0, sourceSection.start)
    separator = markdown.slice(before, sourceSection.start)
    removeStart = before
    removeEnd = sourceSection.coreEnd
  }
  let base = markdown.slice(0, removeStart) + markdown.slice(removeEnd)
  const insertionOriginal =
    placement === 'before' ? targetSection.start : targetSection.sectionEnd
  const insertion =
    insertionOriginal <= removeStart
      ? insertionOriginal
      : insertionOriginal >= removeEnd
        ? insertionOriginal - (removeEnd - removeStart)
        : removeStart
  const movesToEof =
    insertionOriginal === markdown.length &&
    sourceSection.sectionEnd !== markdown.length
  const terminal = movesToEof
    ? markdown.slice(targetSection.coreEnd, targetSection.sectionEnd)
    : ''
  if (movesToEof && terminal) base = base.slice(0, -terminal.length)
  const effectiveInsertion = movesToEof ? base.length : insertion
  const fragment = movesToEof
    ? separator + sourceCore + terminal
    : sourceCore + separator
  const next =
    base.slice(0, effectiveInsertion) +
    fragment +
    base.slice(effectiveInsertion)
  return {
    status: 'ok',
    markdown: next,
    movedRange: {
      start: effectiveInsertion + (movesToEof ? separator.length : 0),
      end:
        effectiveInsertion +
        (movesToEof ? separator.length : 0) +
        sourceCore.length,
    },
  }
}
