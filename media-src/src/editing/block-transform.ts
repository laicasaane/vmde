import {
  BLOCK_TYPES,
  type BlockType,
  type BlockTransformStatus,
} from '../../../src/shared/block-types'
import {
  type CALLOUT_TYPES,
  deriveCalloutContext,
  transformCalloutMarkdown,
} from './callouts'

export { BLOCK_TYPES }
export type { BlockType, BlockTransformStatus }

export interface BlockTarget {
  type: BlockType
  calloutType?: (typeof CALLOUT_TYPES)[number]
  title?: string
  language?: string
}

export interface BlockTransformResult {
  status: BlockTransformStatus
  markdown: string
  anchor: number
  focus: number
  currentType: BlockType | null
  reason?: string
}

interface SourceLine {
  text: string
  ending: string
  start: number
}

interface DecodedBlock {
  type: BlockType
  lines: SourceLine[]
  body: string[]
  prefixLengths: number[]
}

function linesOf(source: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  for (const match of source.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/gu)) {
    if (match[0] === '') break
    lines.push({ text: match[1], ending: match[2], start })
    start += match[0].length
  }
  return lines
}

const HEADING = /^(#{1,6})[ \t]+(.*)$/u
const BULLET = /^ {0,3}([-+*])([ \t]+)(.*)$/u
const ORDERED = /^ {0,3}(\d{1,9})([.)])([ \t]+)(.*)$/u
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/u
const QUOTE = /^ {0,3}> ?/u
const PROTECTED =
  /^(?:\s*(?:\||<|\$\$|\\|\[[^\]]+\]:)|\s*(?:---|\+\+\+|\*\s*\*\s*\*)\s*$)/u

function unsupported(
  source: string,
  anchor: number,
  focus: number,
  reason: string,
): BlockTransformResult {
  return {
    status: 'unsupported',
    markdown: source,
    anchor,
    focus,
    currentType: null,
    reason,
  }
}

function classifyQuote(
  source: string,
  lines: SourceLine[],
  anchor: number,
): DecodedBlock | null {
  if (lines.some((line) => !QUOTE.test(line.text))) return null
  const offset = Math.min(anchor, source.length)
  const context = deriveCalloutContext(source, offset, offset)
  if (
    context.kind === 'unsupported' ||
    context.sourceStart !== 0 ||
    context.sourceEnd !== source.length
  )
    return null
  return {
    type: context.kind === 'callout' ? 'callout' : 'quote',
    lines,
    body: lines.map((line) =>
      line.text.slice(QUOTE.exec(line.text)![0].length),
    ),
    prefixLengths: lines.map((line) => QUOTE.exec(line.text)![0].length),
  }
}

function classifyFence(
  lines: SourceLine[],
  opening: string,
): DecodedBlock | null {
  const closing = lines.at(-1)?.text.trim() ?? ''
  if (
    lines.length < 2 ||
    !new RegExp(`^${opening[0]}{${opening.length},}$`, 'u').test(closing)
  )
    return null
  return { type: 'fence', lines, body: [], prefixLengths: [] }
}

function classifyHeading(
  lines: SourceLine[],
  marker: string,
  body: string,
): DecodedBlock | null {
  if (lines.length !== 1) return null
  return {
    type: `h${marker.length}` as BlockType,
    lines,
    body: [body],
    prefixLengths: [lines[0].text.length - body.length],
  }
}

function listContinuation(line: string, indent: number): string | null {
  if (line === '') return ''
  if (!line.startsWith(' '.repeat(indent))) return null
  const content = line.slice(indent)
  return /^(?:[-+*]|\d{1,9}[.)])\s|^>|^`{3,}|^~{3,}|^\|/u.test(content)
    ? null
    : content
}

function classifyList(
  lines: SourceLine[],
  bullet: RegExpExecArray | null,
  ordered: RegExpExecArray | null,
): DecodedBlock | null {
  const first = lines[0].text
  const markerText = bullet?.[3] ?? ordered?.[4] ?? ''
  const taskMarker = bullet
    ? /^\[[ xX]\][ \t]+/u.exec(markerText)?.[0]
    : undefined
  const indent = taskMarker ? 6 : ordered ? 3 : 2
  const body = [markerText.slice(taskMarker?.length ?? 0)]
  const prefixLengths = [
    first.length - markerText.length + (taskMarker?.length ?? 0),
  ]
  for (const line of lines.slice(1)) {
    const content = listContinuation(line.text, indent)
    if (content === null) return null
    body.push(content)
    prefixLengths.push(content ? indent : 0)
  }
  return {
    type: taskMarker ? 'task' : ordered ? 'ordered' : 'bullet',
    lines,
    body,
    prefixLengths,
  }
}

function plainLine(line: SourceLine): boolean {
  return (
    line.text !== '' &&
    !PROTECTED.test(line.text) &&
    !HEADING.test(line.text) &&
    !BULLET.test(line.text) &&
    !ORDERED.test(line.text) &&
    !FENCE_OPEN.test(line.text) &&
    !QUOTE.test(line.text)
  )
}

function classify(source: string, anchor: number): DecodedBlock | null {
  if (source === '')
    return {
      type: 'paragraph',
      lines: [{ text: '', ending: '', start: 0 }],
      body: [''],
      prefixLengths: [0],
    }
  const lines = linesOf(source)
  if (!lines.length || lines.at(-1)?.ending || source.includes('\0'))
    return null
  const first = lines[0].text
  if (PROTECTED.test(first) || /^ {4}|^\t/u.test(first)) return null
  if (QUOTE.test(first)) return classifyQuote(source, lines, anchor)
  const fence = FENCE_OPEN.exec(first)
  if (fence) return classifyFence(lines, fence[1])
  const heading = HEADING.exec(first)
  if (heading) return classifyHeading(lines, heading[1], heading[2])
  const bullet = BULLET.exec(first)
  const ordered = ORDERED.exec(first)
  if (bullet || ordered) return classifyList(lines, bullet, ordered)
  if (lines.some((line) => !plainLine(line))) return null
  return {
    type: 'paragraph',
    lines,
    body: lines.map((line) => line.text),
    prefixLengths: lines.map(() => 0),
  }
}

function calloutEol(
  source: string,
  result: ReturnType<typeof transformCalloutMarkdown>,
): ReturnType<typeof transformCalloutMarkdown> {
  // Task 527 inserts a marker break as LF. Match this block's uniform CRLF form while
  // preserving the authored CRLF bytes already present in its body.
  if (!source.includes('\r\n') || /(?<!\r)\n/u.test(source)) return result
  const map = (offset: number) =>
    offset +
    (result.markdown.slice(0, offset).match(/(?<!\r)\n/gu)?.length ?? 0)
  return {
    ...result,
    markdown: result.markdown.replace(/(?<!\r)\n/gu, '\r\n'),
    startOffset: map(result.startOffset),
    endOffset: map(result.endOffset),
  }
}

function quotedContent(text: string): string {
  return text.replace(/^ {0,3}(?:> ?)+/u, '')
}

interface ProtectionState {
  fence: string | null
  html: string | null
  comment: boolean
  math: boolean
  frontMatter: boolean
}

function closeProtection(state: ProtectionState, text: string): boolean {
  if (state.frontMatter) {
    if (text === '---') state.frontMatter = false
    return true
  }
  if (state.comment) {
    if (text.includes('-->')) state.comment = false
    return true
  }
  if (state.html) {
    if (new RegExp(`</${state.html}s*>`, 'iu').test(text)) state.html = null
    return true
  }
  if (state.math) {
    if (text === '$$') state.math = false
    return true
  }
  if (!state.fence) return false
  const closing = /^(`{3,}|~{3,})\s*$/u.exec(text)?.[1]
  if (
    closing &&
    closing[0] === state.fence[0] &&
    closing.length >= state.fence.length
  )
    state.fence = null
  return true
}

function openProtection(
  state: ProtectionState,
  text: string,
  first: boolean,
): void {
  if (first && text === '---') {
    state.frontMatter = true
    return
  }
  const marker = /^(`{3,}|~{3,})/u.exec(text)?.[1]
  if (marker) {
    state.fence = marker
    return
  }
  if (text.includes('<!--') && !text.includes('-->')) {
    state.comment = true
    return
  }
  if (text === '$$') {
    state.math = true
    return
  }
  const opening = /^<(div|table|pre|script|style|details)(?:\s|>)/iu.exec(
    text,
  )?.[1]
  if (opening && !new RegExp(`</${opening}s*>`, 'iu').test(text))
    state.html = opening
}

/** A caller's line span is not proof when an earlier container still owns that line. */
function insideProtectedContext(markdown: string, start: number): boolean {
  const state: ProtectionState = {
    fence: null,
    html: null,
    comment: false,
    math: false,
    frontMatter: false,
  }
  const preceding = linesOf(markdown.slice(0, start))
  for (let index = 0; index < preceding.length; index++) {
    const text = quotedContent(preceding[index].text).trim()
    if (!closeProtection(state, text)) openProtection(state, text, index === 0)
  }
  return Boolean(
    state.fence ||
      state.html ||
      state.comment ||
      state.math ||
      state.frontMatter,
  )
}

function unchanged(
  status: Exclude<BlockTransformStatus, 'changed'>,
  source: string,
  anchor: number,
  focus: number,
  currentType: BlockType,
  reason?: string,
): BlockTransformResult {
  return { status, markdown: source, anchor, focus, currentType, reason }
}

function mapLineOffset(
  source: DecodedBlock,
  nextLines: string[],
  nextPrefixes: string[],
  offset: number,
): number {
  const clamped = Math.max(
    0,
    Math.min(
      offset,
      source.lines.at(-1)!.start + source.lines.at(-1)!.text.length,
    ),
  )
  let nextStart = 0
  for (let index = 0; index < source.lines.length; index++) {
    const line = source.lines[index]
    const lineEnd = line.start + line.text.length + line.ending.length
    if (clamped <= lineEnd || index === source.lines.length - 1) {
      const oldColumn = Math.min(clamped - line.start, line.text.length)
      const bodyColumn = Math.max(0, oldColumn - source.prefixLengths[index])
      return (
        nextStart +
        nextPrefixes[index].length +
        Math.min(bodyColumn, source.body[index].length)
      )
    }
    nextStart += nextLines[index].length + line.ending.length
  }
  return nextStart
}

function targetPrefix(target: BlockType, line: string, index: number): string {
  if (target === 'paragraph') return ''
  if (target === 'quote') return line ? '> ' : '>'
  if (index === 0) {
    if (target === 'bullet') return '- '
    if (target === 'ordered') return '1. '
    return '- [ ] '
  }
  if (!line) return ''
  if (target === 'bullet') return '  '
  if (target === 'ordered') return '   '
  return '      '
}

function render(
  source: DecodedBlock,
  target: BlockType,
): { text: string; lines: string[]; prefixes: string[] } | null {
  const body = source.body
  if (/^h[1-6]$/u.test(target)) {
    if (body.length !== 1 || !body[0].trim()) return null
    const prefix = `${'#'.repeat(Number(target[1]))} `
    return {
      text: prefix + body[0],
      lines: [prefix + body[0]],
      prefixes: [prefix],
    }
  }
  const prefixes = body.map((line, index) => targetPrefix(target, line, index))
  const rendered = body.map((line, index) => prefixes[index] + line)
  return {
    text: rendered
      .map((line, index) => line + source.lines[index].ending)
      .join(''),
    lines: rendered,
    prefixes,
  }
}

function calloutOutcome(
  blockMd: string,
  current: BlockType,
  anchor: number,
  focus: number,
  result: ReturnType<typeof transformCalloutMarkdown>,
  noChange: 'noop' | 'unsupported',
): BlockTransformResult {
  const adjusted = calloutEol(blockMd, result)
  return adjusted.changed
    ? {
        status: 'changed',
        markdown: adjusted.markdown,
        anchor: adjusted.startOffset,
        focus: adjusted.endOffset,
        currentType: current,
      }
    : unchanged(noChange, blockMd, anchor, focus, current)
}

function fromCallout(
  blockMd: string,
  target: BlockTarget,
  anchor: number,
  focus: number,
): BlockTransformResult {
  if (target.type === 'quote') {
    return calloutOutcome(
      blockMd,
      'callout',
      anchor,
      focus,
      transformCalloutMarkdown(blockMd, anchor, focus, { kind: 'remove' }),
      'unsupported',
    )
  }
  const currentType =
    deriveCalloutContext(blockMd, anchor, focus).type ?? 'note'
  return calloutOutcome(
    blockMd,
    'callout',
    anchor,
    focus,
    transformCalloutMarkdown(blockMd, anchor, focus, {
      kind: 'apply',
      type: target.calloutType ?? currentType,
      title: target.title,
    }),
    'noop',
  )
}

function toCallout(
  blockMd: string,
  current: BlockType,
  target: BlockTarget,
  anchor: number,
  focus: number,
): BlockTransformResult {
  const intermediate =
    current === 'quote'
      ? { status: 'noop' as const, markdown: blockMd, anchor, focus }
      : blockTransform(blockMd, { type: 'paragraph' }, anchor, focus)
  if (intermediate.status !== 'changed' && intermediate.status !== 'noop')
    return unchanged('unsupported', blockMd, anchor, focus, current)
  const outcome = calloutOutcome(
    intermediate.markdown,
    current,
    intermediate.anchor,
    intermediate.focus,
    transformCalloutMarkdown(
      intermediate.markdown,
      intermediate.anchor,
      intermediate.focus,
      {
        kind: 'apply',
        type: target.calloutType ?? 'note',
        title: target.title,
      },
    ),
    'unsupported',
  )
  return outcome.status === 'changed'
    ? { ...outcome, currentType: current }
    : unchanged('unsupported', blockMd, anchor, focus, current)
}

/** Pure, fail-closed transform of one caller-proven Markdown block. */
export function blockTransform(
  blockMd: string,
  target: BlockTarget,
  anchor: number,
  focus: number,
): BlockTransformResult {
  if (
    anchor < 0 ||
    focus < 0 ||
    anchor > blockMd.length ||
    focus > blockMd.length
  )
    return unsupported(blockMd, anchor, focus, 'Selection is outside the block')
  const source = classify(blockMd, anchor)
  if (!source)
    return unsupported(blockMd, anchor, focus, 'Ambiguous or protected block')
  const current = source.type
  if (
    current === target.type &&
    !(
      target.type === 'callout' &&
      (target.calloutType || target.title !== undefined)
    )
  )
    return unchanged('noop', blockMd, anchor, focus, current)
  if (current === 'fence' || target.type === 'fence')
    return unchanged(
      'confirm-required',
      blockMd,
      anchor,
      focus,
      current,
      'Fence conversion can lose language or structure',
    )
  if (
    current === 'callout' &&
    target.type !== 'quote' &&
    target.type !== 'callout'
  )
    return unchanged(
      'confirm-required',
      blockMd,
      anchor,
      focus,
      current,
      'Removing a callout body wrapper needs confirmation',
    )
  if (current === 'callout') return fromCallout(blockMd, target, anchor, focus)
  if (target.type === 'callout')
    return toCallout(blockMd, current, target, anchor, focus)
  const rendered = render(source, target.type)
  if (!rendered)
    return unchanged(
      'unsupported',
      blockMd,
      anchor,
      focus,
      current,
      'Target cannot preserve this multiline block',
    )
  if (rendered.text === blockMd)
    return unchanged('noop', blockMd, anchor, focus, current)
  return {
    status: 'changed',
    markdown: rendered.text,
    anchor: mapLineOffset(source, rendered.lines, rendered.prefixes, anchor),
    focus: mapLineOffset(source, rendered.lines, rendered.prefixes, focus),
    currentType: current,
  }
}

function exactLineBoundaries(
  markdown: string,
  start: number,
  end: number,
): boolean {
  const before = markdown[start - 1]
  const after = markdown[end]
  const startsLine =
    start === 0 ||
    before === '\n' ||
    (before === '\r' && markdown[start] !== '\n')
  const endsLine =
    end === markdown.length ||
    after === '\r' ||
    (after === '\n' && markdown[end - 1] !== '\r')
  return startsLine && endsLine
}

function neighboringLine(
  markdown: string,
  boundary: number,
  side: 'before' | 'after',
): string {
  const slice =
    side === 'before'
      ? markdown.slice(0, boundary).replace(/(?:\r\n|\n|\r)$/u, '')
      : markdown.slice(boundary).replace(/^(?:\r\n|\n|\r)/u, '')
  const lines = slice.split(/\r\n|\n|\r/u)
  return side === 'before' ? (lines.at(-1) ?? '') : (lines[0] ?? '')
}

function partialSourceOwner(
  markdown: string,
  start: number,
  end: number,
  type: BlockType,
): boolean {
  // An empty source line is an insertion boundary, not a slice of adjacent prose.
  if (start === end) return false
  if (type !== 'paragraph' && type !== 'quote') return false
  const before = neighboringLine(markdown, start, 'before')
  const after = neighboringLine(markdown, end, 'after')
  if (type === 'quote') return QUOTE.test(before) || QUOTE.test(after)
  return (
    (start > 0 && plainLine({ text: before, ending: '', start: 0 })) ||
    (end < markdown.length && plainLine({ text: after, ending: '', start: 0 }))
  )
}

/** Splice the exact source span, preserving every byte outside it and selection direction. */
export function planBlockTransform(
  markdown: string,
  span: { start: number; end: number },
  target: BlockTarget,
  anchor: number,
  focus: number,
): BlockTransformResult {
  const { start, end } = span
  if (
    start < 0 ||
    end < start ||
    end > markdown.length ||
    !exactLineBoundaries(markdown, start, end) ||
    anchor < start ||
    anchor > end ||
    focus < start ||
    focus > end ||
    insideProtectedContext(markdown, start)
  )
    return unsupported(markdown, anchor, focus, 'Unproven source span')
  const source = markdown.slice(start, end)
  const owner = classify(source, anchor - start)
  if (owner && partialSourceOwner(markdown, start, end, owner.type))
    return unsupported(markdown, anchor, focus, 'Span cuts an adjacent block')
  const local = blockTransform(source, target, anchor - start, focus - start)
  if (local.status !== 'changed') return { ...local, markdown, anchor, focus }
  return {
    ...local,
    markdown: markdown.slice(0, start) + local.markdown + markdown.slice(end),
    anchor: start + local.anchor,
    focus: start + local.focus,
  }
}

function lineAt(lines: SourceLine[], offset: number): number {
  return lines.findIndex(
    (line) => offset >= line.start && offset <= line.start + line.text.length,
  )
}

function fenceOwner(
  lines: SourceLine[],
  target: number,
): { first: number; last: number } | null {
  let opening = -1
  let marker = ''
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index].text
    if (opening >= 0) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(text)?.[1]
      if (!close || close[0] !== marker[0] || close.length < marker.length)
        continue
      if (target >= opening && target <= index)
        return { first: opening, last: index }
      opening = -1
      marker = ''
      continue
    }
    const open = FENCE_OPEN.exec(text)?.[1]
    if (open) {
      opening = index
      marker = open
    }
  }
  return null
}

function listOwner(
  lines: SourceLine[],
  target: number,
): { first: number; last: number } | null {
  let first = target
  while (
    first > 0 &&
    (/^ {2,}\S/u.test(lines[first].text) || lines[first].text === '')
  )
    first--
  const bullet = BULLET.exec(lines[first].text)
  const ordered = ORDERED.exec(lines[first].text)
  if (!bullet && !ordered) return null
  let last = first
  for (let index = first + 1; index < lines.length; index++) {
    if (/^ {2,}\S/u.test(lines[index].text)) {
      last = index
      continue
    }
    if (
      lines[index].text === '' &&
      /^ {2,}\S/u.test(lines[index + 1]?.text ?? '')
    ) {
      last = index
      continue
    }
    break
  }
  return target <= last ? { first, last } : null
}

function quoteOwner(
  lines: SourceLine[],
  target: number,
): { first: number; last: number } | null {
  let first = target
  let last = target
  while (first > 0 && QUOTE.test(lines[first - 1].text)) first--
  while (last + 1 < lines.length && QUOTE.test(lines[last + 1].text)) last++
  return lines
    .slice(first, last + 1)
    .some((line) => FENCE_OPEN.test(quotedContent(line.text)))
    ? null
    : { first, last }
}

function proseOwner(
  lines: SourceLine[],
  target: number,
): { first: number; last: number } {
  let first = target
  let last = target
  while (first > 0 && plainLine(lines[first - 1])) first--
  while (last + 1 < lines.length && plainLine(lines[last + 1])) last++
  return { first, last }
}

function ownerBounds(
  lines: SourceLine[],
  target: number,
): { first: number; last: number } | null {
  const fence = fenceOwner(lines, target)
  if (fence) return fence
  if (QUOTE.test(lines[target].text)) return quoteOwner(lines, target)
  const list = listOwner(lines, target)
  if (list) return list
  return plainLine(lines[target])
    ? proseOwner(lines, target)
    : { first: target, last: target }
}

/** Locate one complete, source-addressable block; ambiguous ownership is a no-op. */
export function locateBlockSpan(
  markdown: string,
  anchor: number,
  focus: number,
): { start: number; end: number } | null {
  if (
    anchor < 0 ||
    focus < 0 ||
    anchor > markdown.length ||
    focus > markdown.length
  )
    return null
  const lines = linesOf(markdown)
  const target = lineAt(lines, Math.min(anchor, focus))
  if (target < 0) return null
  const bounds = ownerBounds(lines, target)
  if (!bounds) return null
  const start = lines[bounds.first].start
  const end = lines[bounds.last].start + lines[bounds.last].text.length
  if (Math.max(anchor, focus) > end || insideProtectedContext(markdown, start))
    return null
  const source = markdown.slice(start, end)
  return classify(source, anchor - start) ? { start, end } : null
}

export interface BlockMetadata {
  span: { start: number; end: number }
  currentType: BlockType
  targets: Array<{ type: BlockType; status: BlockTransformStatus }>
}

/** One source authority for the native QuickPick and later editor menus. */
export function describeBlockAt(
  markdown: string,
  anchor: number,
  focus: number,
): BlockMetadata | null {
  const span = locateBlockSpan(markdown, anchor, focus)
  if (!span) return null
  const current = classify(
    markdown.slice(span.start, span.end),
    anchor - span.start,
  )
  if (!current) return null
  return {
    span,
    currentType: current.type,
    targets: BLOCK_TYPES.map((type) => ({
      type,
      status: planBlockTransform(markdown, span, { type }, anchor, focus)
        .status,
    })),
  }
}
