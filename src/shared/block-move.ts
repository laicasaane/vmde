import { moveSourceRange, type SourceRange } from './section-move'

export type MovableKind =
  | 'paragraph'
  | 'heading'
  | 'quote'
  | 'list-item'
  | 'fence'
  | 'table'
  | 'thematic'

export interface MovableBlock extends SourceRange {
  kind: MovableKind
  /** End of the source-owned separator run, or EOF. */
  sectionEnd: number
  /** Consecutive sibling list items share a run; all other blocks use -1. */
  listRun: number
}

interface SourceLine {
  text: string
  start: number
  end: number
  endWithBreak: number
}

function linesOf(markdown: string): SourceLine[] {
  const lines: SourceLine[] = []
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/gu
  for (;;) {
    const match = pattern.exec(markdown)
    if (!match || match[0] === '') break
    lines.push({
      text: match[1],
      start: match.index,
      end: match.index + match[1].length,
      endWithBreak: match.index + match[0].length,
    })
    if (!match[2]) break
  }
  return lines
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u
const LIST = /^(?:[-+*]|\d{1,9}[.)])[ \t]+/u
const QUOTE = /^ {0,3}> ?/u
const ATX = /^ {0,3}#{1,6}(?:[ \t]+|$)/u
const TABLE_DELIMITER = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/u
const THEMATIC = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u
const RAW_HTML =
  /^ {0,3}<(?:!--|\/?(?:div|table|pre|script|style|details))(?:\s|>|$)/iu

function fenceOpening(text: string): string | null {
  const match = FENCE.exec(text)
  if (!match) return null
  if (match[1][0] === '`' && match[2].includes('`')) return null
  return match[1]
}

function fencedEnd(
  lines: SourceLine[],
  start: number,
  marker: string,
): number | null {
  for (let index = start + 1; index < lines.length; index++) {
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(lines[index].text)?.[1]
    if (close && close[0] === marker[0] && close.length >= marker.length)
      return index
  }
  return null
}

function tableEnd(lines: SourceLine[], start: number): number | null {
  if (
    !lines[start].text.includes('|') ||
    !TABLE_DELIMITER.test(lines[start + 1]?.text ?? '')
  )
    return null
  let end = start + 1
  while (lines[end + 1]?.text.includes('|') && lines[end + 1].text.trim()) end++
  return end
}

function listEnd(lines: SourceLine[], start: number): number {
  const marker = LIST.exec(lines[start].text)?.[0] ?? ''
  const task = /^\[[ xX]\][ \t]+/u.exec(
    lines[start].text.slice(marker.length),
  )?.[0]
  const indent = marker.length + (task?.length ?? 0)
  const continuation = new RegExp(`^ {${indent},}\\S`, 'u')
  let end = start
  for (let index = start + 1; index < lines.length; index++) {
    const text = lines[index].text
    if (continuation.test(text)) {
      end = index
      continue
    }
    if (text === '' && continuation.test(lines[index + 1]?.text ?? '')) {
      end = index
      continue
    }
    break
  }
  return end
}

function paragraphEnd(lines: SourceLine[], start: number): number {
  let end = start
  for (let index = start + 1; index < lines.length; index++) {
    const text = lines[index].text
    if (
      !text.trim() ||
      ATX.test(text) ||
      LIST.test(text) ||
      QUOTE.test(text) ||
      fenceOpening(text) ||
      THEMATIC.test(text) ||
      RAW_HTML.test(text) ||
      tableEnd(lines, index) !== null
    )
      break
    end = index
  }
  return end
}

function frontMatterStart(lines: SourceLine[]): number {
  if (lines[0]?.text.trim() !== '---') return 0
  const close = lines.findIndex(
    (line, index) =>
      index > 0 && (line.text.trim() === '---' || line.text.trim() === '...'),
  )
  return close < 0 ? lines.length : close + 1
}

function unprovenLazyLine(lines: SourceLine[], endLine: number): boolean {
  const next = lines[endLine + 1]?.text
  if (!next?.trim()) return false
  return !(
    LIST.test(next) ||
    ATX.test(next) ||
    QUOTE.test(next) ||
    fenceOpening(next) ||
    THEMATIC.test(next) ||
    RAW_HTML.test(next) ||
    tableEnd(lines, endLine + 1) !== null
  )
}

function quotedBlockAt(
  lines: SourceLine[],
  index: number,
): { kind: 'quote'; endLine: number } | null {
  let endLine = index
  while (QUOTE.test(lines[endLine + 1]?.text ?? '')) endLine++
  return unprovenLazyLine(lines, endLine) ? null : { kind: 'quote', endLine }
}

function listBlockAt(
  lines: SourceLine[],
  index: number,
): { kind: 'list-item'; endLine: number } | null {
  const endLine = listEnd(lines, index)
  return unprovenLazyLine(lines, endLine)
    ? null
    : { kind: 'list-item', endLine }
}

function blockAt(
  lines: SourceLine[],
  index: number,
): { kind: MovableKind; endLine: number } | null {
  const text = lines[index].text
  if (
    /^(?: {4}|\t| {1,3}(?:[-+*]|\d{1,9}[.)])[ \t]+)/u.test(text) ||
    RAW_HTML.test(text)
  )
    return null
  const fence = fenceOpening(text)
  if (fence) {
    const endLine = fencedEnd(lines, index, fence)
    return endLine === null ? null : { kind: 'fence', endLine }
  }
  const table = tableEnd(lines, index)
  if (table !== null) return { kind: 'table', endLine: table }
  if (QUOTE.test(text)) return quotedBlockAt(lines, index)
  if (LIST.test(text)) return listBlockAt(lines, index)
  if (ATX.test(text)) return { kind: 'heading', endLine: index }
  if (THEMATIC.test(text)) return { kind: 'thematic', endLine: index }
  if (
    lines[index + 1] &&
    /^ {0,3}(?:=+|-+)[ \t]*$/u.test(lines[index + 1].text)
  )
    return { kind: 'heading', endLine: index + 1 }
  return { kind: 'paragraph', endLine: paragraphEnd(lines, index) }
}

/** Conservative source scan for top-level blocks and complete list-item subtrees. */
export function scanMovableBlocks(markdown: string): MovableBlock[] {
  const lines = linesOf(markdown)
  const blocks: MovableBlock[] = []
  let listRun = 0
  for (let index = frontMatterStart(lines); index < lines.length; ) {
    if (!lines[index].text.trim()) {
      index++
      continue
    }
    const parsed = blockAt(lines, index)
    if (!parsed) return []
    const previous = blocks.at(-1)
    const run =
      parsed.kind === 'list-item'
        ? previous?.kind === 'list-item' &&
          /^(?:\r\n|\n|\r)$/u.test(
            markdown.slice(previous.end, lines[index].start),
          )
          ? previous.listRun
          : ++listRun
        : -1
    blocks.push({
      kind: parsed.kind,
      start: lines[index].start,
      end: lines[parsed.endLine].end,
      sectionEnd: 0,
      listRun: run,
    })
    index = parsed.endLine + 1
  }
  for (let index = 0; index < blocks.length; index++)
    blocks[index].sectionEnd = blocks[index + 1]?.start ?? markdown.length
  return blocks
}

export type BlockMoveResult =
  | {
      status: 'ok'
      markdown: string
      movedRange: SourceRange
      mapOffset(offset: number): number
    }
  | { status: 'noop' }
  | {
      status: 'rejected'
      reason:
        | 'stale-block'
        | 'list-boundary'
        | 'heading-section'
        | 'invalid-placement'
    }

function trailingNewlineStart(
  markdown: string,
  floor: number,
  end: number,
): number {
  let cursor = end
  while (
    cursor > floor &&
    (markdown[cursor - 1] === '\r' || markdown[cursor - 1] === '\n')
  )
    cursor--
  return cursor
}

/** Raw UTF-16 splice plus block/list separator ownership and EOF newline transfer. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: exact block identity, list-depth guard and EOF separator transfer are one coupled move decision.
export function planBlockMove(
  markdown: string,
  sourceStart: number,
  targetStart: number,
  placement: 'before' | 'after',
): BlockMoveResult {
  if (placement !== 'before' && placement !== 'after')
    return { status: 'rejected', reason: 'invalid-placement' }
  const blocks = scanMovableBlocks(markdown)
  const source = blocks.find((block) => block.start === sourceStart)
  const target = blocks.find((block) => block.start === targetStart)
  if (!source || !target) return { status: 'rejected', reason: 'stale-block' }
  if (
    source === target ||
    (placement === 'before' && source.sectionEnd === target.start) ||
    (placement === 'after' && target.sectionEnd === source.start)
  )
    return { status: 'noop' }
  // A heading handle cannot move only its marker line: Task 222 owns complete sections.
  if (source.kind === 'heading')
    return { status: 'rejected', reason: 'heading-section' }
  if (
    (source.kind === 'list-item' || target.kind === 'list-item') &&
    (source.kind !== 'list-item' ||
      target.kind !== 'list-item' ||
      source.listRun !== target.listRun)
  )
    return { status: 'rejected', reason: 'list-boundary' }

  const insertionOriginal =
    placement === 'before' ? target.start : target.sectionEnd
  const sourceCore = markdown.slice(source.start, source.end)
  if (
    source.sectionEnd < markdown.length &&
    insertionOriginal < markdown.length
  ) {
    const raw = moveSourceRange(
      markdown,
      { start: source.start, end: source.sectionEnd },
      insertionOriginal,
    )
    return raw.status === 'ok'
      ? {
          status: 'ok',
          markdown: raw.markdown,
          movedRange: {
            start: raw.movedRange.start,
            end: raw.movedRange.start + sourceCore.length,
          },
          mapOffset: (offset) => {
            if (offset !== source.sectionEnd) return raw.mapOffset(offset)
            const movedLength = source.sectionEnd - source.start
            const baseOffset = offset - movedLength
            return baseOffset >= raw.movedRange.start
              ? baseOffset + movedLength
              : baseOffset
          },
        }
      : raw.status === 'noop'
        ? { status: 'noop' }
        : { status: 'rejected', reason: 'stale-block' }
  }

  // A final block owns terminal whitespace, not the separator before it. Transfer that
  // separator onto the moved core and leave authored terminal bytes with the new EOF.
  let separator = markdown.slice(source.end, source.sectionEnd)
  let removeStart = source.start
  let removeEnd = source.sectionEnd
  if (source.sectionEnd === markdown.length) {
    const before = trailingNewlineStart(markdown, 0, source.start)
    separator = markdown.slice(before, source.start)
    removeStart = before
    removeEnd = source.end
  }
  let base = markdown.slice(0, removeStart) + markdown.slice(removeEnd)
  const insertion =
    insertionOriginal <= removeStart
      ? insertionOriginal
      : insertionOriginal >= removeEnd
        ? insertionOriginal - (removeEnd - removeStart)
        : removeStart
  const movesToEof =
    insertionOriginal === markdown.length &&
    source.sectionEnd !== markdown.length
  const terminal = movesToEof
    ? markdown.slice(target.end, target.sectionEnd)
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
  const rawMapping = moveSourceRange(
    markdown,
    { start: removeStart, end: removeEnd },
    insertionOriginal,
  )
  if (rawMapping.status !== 'ok')
    return { status: 'rejected', reason: 'stale-block' }
  const movedRange = {
    start: effectiveInsertion + (movesToEof ? separator.length : 0),
    end:
      effectiveInsertion +
      (movesToEof ? separator.length : 0) +
      sourceCore.length,
  }
  return {
    status: 'ok',
    markdown: next,
    movedRange,
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: maps moved core, transferred separator, terminal bytes and untouched source through the same EOF splice.
    mapOffset: (offset) => {
      if (offset === markdown.length) return next.length
      if (offset >= source.start && offset <= source.end)
        return movedRange.start + offset - source.start
      if (
        movesToEof &&
        terminal &&
        offset >= target.end &&
        offset < target.sectionEnd
      )
        return next.length - terminal.length + offset - target.end
      if (
        source.sectionEnd === markdown.length &&
        offset >= removeStart &&
        offset < source.start
      )
        return effectiveInsertion + sourceCore.length + offset - removeStart
      if (
        source.sectionEnd !== markdown.length &&
        offset > source.end &&
        offset < source.sectionEnd
      )
        return effectiveInsertion + offset - source.end
      // moveSourceRange maps its half-open end boundary to the moved chunk. At the
      // first byte of the following block, ownership belongs to that following block.
      if (source.sectionEnd !== markdown.length && offset === removeEnd) {
        const baseOffset = offset - (removeEnd - removeStart)
        return baseOffset >= effectiveInsertion
          ? baseOffset + fragment.length
          : baseOffset
      }
      return rawMapping.mapOffset(offset)
    },
  }
}

export type BlockEditResult =
  | { status: 'ok'; markdown: string; caretOffset: number }
  | { status: 'rejected'; reason: 'stale-block' | 'heading-section' }

function actionBlock(markdown: string, start: number): MovableBlock | null {
  return (
    scanMovableBlocks(markdown).find((block) => block.start === start) ?? null
  )
}

/** Delete one proven block/list subtree; heading sections require Task 222 delegation. */
export function planBlockDelete(
  markdown: string,
  sourceStart: number,
): BlockEditResult {
  const source = actionBlock(markdown, sourceStart)
  if (!source) return { status: 'rejected', reason: 'stale-block' }
  if (source.kind === 'heading')
    return { status: 'rejected', reason: 'heading-section' }
  const final = source.sectionEnd === markdown.length
  const removeStart = final
    ? trailingNewlineStart(markdown, 0, source.start)
    : source.start
  const removeEnd = final ? source.end : source.sectionEnd
  const next = markdown.slice(0, removeStart) + markdown.slice(removeEnd)
  return {
    status: 'ok',
    markdown: source.start === 0 && final ? '' : next,
    caretOffset: Math.min(removeStart, next.length),
  }
}

/** Duplicate one proven block/list subtree with its authored separator and terminal state. */
export function planBlockDuplicate(
  markdown: string,
  sourceStart: number,
): BlockEditResult {
  const source = actionBlock(markdown, sourceStart)
  if (!source) return { status: 'rejected', reason: 'stale-block' }
  if (source.kind === 'heading')
    return { status: 'rejected', reason: 'heading-section' }
  if (source.sectionEnd < markdown.length) {
    const chunk = markdown.slice(source.start, source.sectionEnd)
    return {
      status: 'ok',
      markdown:
        markdown.slice(0, source.sectionEnd) +
        chunk +
        markdown.slice(source.sectionEnd),
      caretOffset: source.sectionEnd,
    }
  }
  const before = trailingNewlineStart(markdown, 0, source.start)
  const authoredSeparator = markdown.slice(before, source.start)
  const eol = markdown.includes('\r\n')
    ? '\r\n'
    : markdown.includes('\r')
      ? '\r'
      : '\n'
  const separator = authoredSeparator || `${eol}${eol}`
  const core = markdown.slice(source.start, source.end)
  const terminal = markdown.slice(source.end)
  const next = markdown.slice(0, source.end) + separator + core + terminal
  return {
    status: 'ok',
    markdown: next,
    caretOffset: source.end + separator.length,
  }
}

export type BlockActionIntent =
  | {
      kind: 'move'
      sourceStart: number
      targetStart: number
      placement: 'before' | 'after'
    }
  | { kind: 'delete'; sourceStart: number }
  | { kind: 'duplicate'; sourceStart: number }

export type BlockActionPlan =
  | { status: 'ok'; markdown: string; caretOffset: number }
  | { status: 'noop' }
  | { status: 'rejected'; reason: string }

/** One exact source planner for handle drag, Alt+Arrow and handle menu actions. */
export function planBlockAction(
  markdown: string,
  action: BlockActionIntent,
): BlockActionPlan {
  if (action.kind === 'delete')
    return planBlockDelete(markdown, action.sourceStart)
  if (action.kind === 'duplicate')
    return planBlockDuplicate(markdown, action.sourceStart)
  const moved = planBlockMove(
    markdown,
    action.sourceStart,
    action.targetStart,
    action.placement,
  )
  return moved.status === 'ok'
    ? {
        status: 'ok',
        markdown: moved.markdown,
        caretOffset: moved.movedRange.start,
      }
    : moved
}

/** Build only wire-safe fields; host bindings also carry a live timeout handle. */
export function blockActionPreparePayload(
  requestId: string,
  binding: { uri: string; version: number; before: string; after: string },
  caretOffset: number,
) {
  return {
    command: 'prepare-block-action' as const,
    requestId,
    uri: binding.uri,
    version: binding.version,
    before: binding.before,
    after: binding.after,
    caretOffset,
  }
}
