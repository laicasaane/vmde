import { parseHtmlInlineToken } from './html-inline-token'

type SubscriptState = 'inactive' | 'active' | 'mixed' | 'disabled'
export interface Splice {
  start: number
  end: number
  text: string
}
export interface SubscriptPlan {
  state: SubscriptState
  splices?: Splice[]
  selection?: { anchor: number; focus: number }
}
interface Pair {
  openStart: number
  openEnd: number
  bodyStart: number
  bodyEnd: number
  closeStart: number
  closeEnd: number
}

interface Span {
  start: number
  end: number
}

interface TokenScan {
  pairs: Pair[]
  tags: Span[]
  protected: Span[]
}

interface HtmlInlineDescriptor {
  tag: 'sub' | 'sup' | 'ins'
}

const SUBSCRIPT: HtmlInlineDescriptor = { tag: 'sub' }
const SUPERSCRIPT: HtmlInlineDescriptor = { tag: 'sup' }
const UNDERLINE: HtmlInlineDescriptor = { tag: 'ins' }

function escaped(source: string, offset: number): boolean {
  let slashes = 0
  for (let index = offset - 1; index >= 0 && source[index] === '\\'; index--)
    slashes++
  return slashes % 2 === 1
}

function delimiterRun(
  source: string,
  start: number,
  character: string,
): number {
  let end = start
  while (source[end] === character) end++
  return end - start
}

/** Find closed inline code/math delimiters before considering HTML tokens. This keeps exact
 * source offsets intact while refusing mutations anywhere Lute would treat as protected text. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: scans protected delimiter runs without changing UTF-16 offsets
function protectedSpans(source: string): Span[] {
  const spans: Span[] = []
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if ((character !== '`' && character !== '$') || escaped(source, index))
      continue
    const length = delimiterRun(source, index, character)
    let close = -1
    for (let candidate = index + length; candidate < source.length; ) {
      if (source[candidate] !== character || escaped(source, candidate)) {
        candidate++
        continue
      }
      const candidateLength = delimiterRun(source, candidate, character)
      if (candidateLength === length) {
        close = candidate
        break
      }
      candidate += candidateLength
    }
    if (close < 0) {
      // An unmatched delimiter is ambiguous source syntax. Failing closed through EOF avoids
      // placing an HTML wrapper into text that a later delimiter could turn into code or math.
      spans.push({ start: index, end: source.length })
      break
    }
    spans.push({ start: index, end: close + length })
    index = close + length - 1
  }
  return spans
}

function containsOffset(spans: readonly Span[], offset: number): boolean {
  return spans.some((span) => offset > span.start && offset < span.end)
}

function intersects(
  spans: readonly Span[],
  start: number,
  end: number,
): boolean {
  return spans.some((span) =>
    start === end
      ? start >= span.start && start <= span.end
      : start < span.end && end > span.start,
  )
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one balanced-token scan preserves the source offset contract
function scan(
  source: string,
  descriptor: HtmlInlineDescriptor,
): TokenScan | null {
  const protectedRanges = protectedSpans(source)
  const stack: Array<{ name: string; start: number; end: number }> = []
  const pairs: Pair[] = []
  const tags: Span[] = []
  for (let i = 0; i < source.length; i++) {
    if (
      source[i] !== '<' ||
      escaped(source, i) ||
      containsOffset(protectedRanges, i)
    )
      continue
    let quote = ''
    let end = -1
    for (let j = i + 1; j < source.length; j++) {
      const c = source[j]
      if (quote) {
        if (c === quote) quote = ''
        continue
      }
      if (c === '"' || c === "'") quote = c
      else if (c === '>') {
        end = j + 1
        break
      }
    }
    if (end < 0) return null
    const token = parseHtmlInlineToken(source.slice(i, end))
    if (!token) return null
    tags.push({ start: i, end })
    if (!token.void && !token.closing)
      stack.push({ name: token.name, start: i, end })
    else if (token.closing) {
      const open = stack.pop()
      if (!open || open.name !== token.name) return null
      if (token.name === descriptor.tag)
        pairs.push({
          openStart: open.start,
          openEnd: open.end,
          bodyStart: open.end,
          bodyEnd: i,
          closeStart: i,
          closeEnd: end,
        })
    }
    i = end - 1
  }
  return stack.length ? null : { pairs, tags, protected: protectedRanges }
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: classifies exact, partial, protected, and malformed source ranges before mutation
function planHtmlInline(
  source: string,
  anchor: number,
  focus: number,
  descriptor: HtmlInlineDescriptor,
): SubscriptPlan {
  if (!Number.isInteger(anchor) || !Number.isInteger(focus))
    return { state: 'disabled' }
  const start = Math.min(anchor, focus),
    end = Math.max(anchor, focus)
  if (start < 0 || end > source.length) return { state: 'disabled' }
  const scanned = scan(source, descriptor)
  if (!scanned) return { state: 'disabled' }
  const { pairs, tags, protected: protectedRanges } = scanned
  if (
    containsOffset(tags, start) ||
    containsOffset(tags, end) ||
    intersects(protectedRanges, start, end)
  )
    return { state: 'disabled' }
  if (start === end) {
    const active = pairs.some(
      (pair) => start >= pair.bodyStart && start <= pair.bodyEnd,
    )
    return {
      state: active ? 'active' : 'inactive',
      splices: [
        { start, end: start, text: `<${descriptor.tag}></${descriptor.tag}>` },
      ],
      selection: {
        anchor: start + `<${descriptor.tag}>`.length,
        focus: start + `<${descriptor.tag}>`.length,
      },
    }
  }
  const exact = pairs.find(
    (p) =>
      (start === p.openStart && end === p.closeEnd) ||
      (start === p.bodyStart && end === p.bodyEnd),
  )
  if (exact) {
    const bodyLength = exact.bodyEnd - exact.bodyStart
    return {
      state: 'active',
      splices: [
        { start: exact.closeStart, end: exact.closeEnd, text: '' },
        { start: exact.openStart, end: exact.openEnd, text: '' },
      ],
      selection: {
        anchor: exact.openStart + (anchor > focus ? bodyLength : 0),
        focus: exact.openStart + (anchor > focus ? 0 : bodyLength),
      },
    }
  }
  if (pairs.some((pair) => start >= pair.bodyStart && end <= pair.bodyEnd))
    return { state: 'active' }
  if (pairs.some((pair) => start < pair.closeEnd && end > pair.openStart))
    return { state: 'mixed' }
  if (intersects(tags, start, end)) return { state: 'disabled' }
  const open = `<${descriptor.tag}>`
  const close = `</${descriptor.tag}>`
  const shift = open.length
  return {
    state: 'inactive',
    splices: [
      { start: end, end, text: close },
      { start, end: start, text: open },
    ],
    selection: { anchor: anchor + shift, focus: focus + shift },
  }
}

export function planHtmlSubscript(
  source: string,
  anchor: number,
  focus: number,
): SubscriptPlan {
  return planHtmlInline(source, anchor, focus, SUBSCRIPT)
}

export function planHtmlSuperscript(
  source: string,
  anchor: number,
  focus: number,
): SubscriptPlan {
  return planHtmlInline(source, anchor, focus, SUPERSCRIPT)
}

export function planHtmlUnderline(
  source: string,
  anchor: number,
  focus: number,
): SubscriptPlan {
  return planHtmlInline(source, anchor, focus, UNDERLINE)
}
