// Task 605 — marker-free SV selection → exact-source proof and rendered-span splice.
//
// SV shows source text, but not the exact bytes: Vditor appends a newline (and, in a direct SV
// open, U+200B), a mode switch shows the Lute serialization, and carriage returns are not part of
// the editor text. So the editor text `T` (the joined Text node data) is never authority. Exact
// source stays the transform input; `T` only locates it. An endpoint is accepted when one exact
// offset is provable through the bounded alignment, and a target only when its image in `T` is
// verbatim (`T.slice(...) === exact.slice(...)`).
import { textPointAt } from './rewrap-command'
import { alignText, type OffsetAlignment } from './find-align'
import {
  exactOffsetThrough,
  isExactTextBoundary,
} from './selection-source-proof'

type Span = { start: number; end: number }

export type SvSelectionProof =
  | {
      status: 'proven'
      text: string
      /** Exact offsets of the range start and end (equal for a caret). */
      start: number
      end: number
      /** The same endpoints as offsets into `text`. */
      renderedStart: number
      renderedEnd: number
    }
  | { status: 'unprovable' }

export interface SvEdit {
  /** The text that replaces the rendered span. */
  replacement: string
  /** Caret endpoints as offsets into the editor text after the splice. */
  anchor: number
  focus: number
}

/** The joined Text node data of the SV editor (equal to its `textContent`). */
export function svText(editor: HTMLElement): string {
  return editor.textContent ?? ''
}

// One alignment per (exact, text) pair: capture, rendered-span lookup and tests repeat the same
// pair on a large document, and the alignment is the costly part.
let cached: { exact: string; text: string; alignment: OffsetAlignment } | null =
  null
function alignmentFor(exact: string, text: string): OffsetAlignment {
  if (cached?.exact === exact && cached.text === text) return cached.alignment
  const alignment = alignText(exact, text)
  cached = { exact, text, alignment }
  return alignment
}

function renderedOffset(
  editor: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  // Element offsets include syntax boundaries; moving them to nearby text would invent a position.
  if (!(node instanceof Text) || !node.isConnected || !editor.contains(node))
    return null
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let total = 0
  for (let item = walker.nextNode(); item; item = walker.nextNode()) {
    if (item === node) return total + offset
    total += (item as Text).data.length
  }
  return null
}

// Sentinel offsets only give order; an adjacent live character must equal the exact character.
// A range start compares the character after the endpoint; a range end and a caret compare the
// one before it. The SV text has no carriage returns, so at a CRLF line end the character after
// is "\n" in the editor but "\r" in the exact source, while the one before is the same text.
function sameCharacter(
  exact: string,
  text: string,
  exactOffset: number,
  renderedAt: number,
  bias: 'caret' | 'start' | 'end',
): boolean {
  const before = renderedAt > 0 && exactOffset > 0
  const after = renderedAt < text.length && exactOffset < exact.length
  if (bias !== 'start' && before)
    return text[renderedAt - 1] === exact[exactOffset - 1]
  if (after) return text[renderedAt] === exact[exactOffset]
  return before ? text[renderedAt - 1] === exact[exactOffset - 1] : true
}

// A deletion puts two exact boundaries at one editor caret. At a CRLF line end they are the offset
// before "\r" and the one between "\r" and "\n", which is no caret position; the single real text
// boundary is the answer. Two real boundaries stay ambiguous and decline.
function caretOffset(
  alignment: OffsetAlignment,
  exact: string,
  rendered: number,
): number | null {
  const candidates = new Set<number>()
  for (const bias of ['start', 'end'] as const) {
    const at = alignment.toExact(rendered, bias)
    if (at !== null && isExactTextBoundary(exact, at)) candidates.add(at)
  }
  return candidates.size === 1 ? [...candidates][0] : null
}

function provePoint(
  alignment: OffsetAlignment,
  exact: string,
  text: string,
  rendered: number,
  bias: 'caret' | 'start' | 'end',
): number | null {
  const mapped =
    bias === 'caret'
      ? caretOffset(alignment, exact, rendered)
      : exactOffsetThrough(alignment, rendered, bias)
  return mapped !== null &&
    mapped >= 0 &&
    mapped <= exact.length &&
    isExactTextBoundary(exact, mapped) &&
    sameCharacter(exact, text, mapped, rendered, bias)
    ? mapped
    : null
}

/** Prove both endpoints of `range` against `exact` without inserting markers. */
export function proveSvSelection(
  editor: HTMLElement,
  exact: string,
  range: Range,
): SvSelectionProof {
  const startAt = renderedOffset(
    editor,
    range.startContainer,
    range.startOffset,
  )
  const endAt = range.collapsed
    ? startAt
    : renderedOffset(editor, range.endContainer, range.endOffset)
  if (startAt === null || endAt === null) return { status: 'unprovable' }
  const text = svText(editor)
  const alignment = alignmentFor(exact, text)
  const start = provePoint(
    alignment,
    exact,
    text,
    startAt,
    range.collapsed ? 'caret' : 'start',
  )
  const end = range.collapsed
    ? start
    : provePoint(alignment, exact, text, endAt, 'end')
  if (start === null || end === null || start > end)
    return { status: 'unprovable' }
  return {
    status: 'proven',
    text,
    start,
    end,
    renderedStart: startAt,
    renderedEnd: endAt,
  }
}

/** The span's verbatim image in `text` that also contains both rendered endpoints, else `null`
 * (this rejects offsets inside Vditor's appended trailing newline and any normalized region). */
export function svRenderedSpan(
  exact: string,
  text: string,
  span: Span,
  renderedStart: number,
  renderedEnd: number,
): Span | null {
  const alignment = alignmentFor(exact, text)
  const start = alignment.toRendered(span.start, 'start')
  const end = alignment.toRendered(span.end, 'end')
  if (
    start === null ||
    end === null ||
    text.slice(start, end) !== exact.slice(span.start, span.end) ||
    renderedStart < start ||
    renderedEnd > end
  )
    return null
  return { start, end }
}

/**
 * Plan the editor change for an exact edit confined to `span`: the bytes outside the span must be
 * unchanged, the new bytes must be representable in SV text (a carriage return is not), and the
 * carets must land inside the new block. Positions inside the span are linear because the span is
 * verbatim in the editor text.
 */
export function planSvEdit(
  exact: string,
  result: { markdown: string; anchor: number; focus: number },
  span: Span,
  rendered: Span,
): SvEdit | null {
  const end = span.end + (result.markdown.length - exact.length)
  if (
    end < span.start ||
    result.markdown.slice(0, span.start) !== exact.slice(0, span.start) ||
    result.markdown.slice(end) !== exact.slice(span.end)
  )
    return null
  const replacement = result.markdown.slice(span.start, end)
  if (replacement.includes('\r')) return null
  const caret = (offset: number): number | null =>
    offset >= span.start && offset <= end
      ? rendered.start + (offset - span.start)
      : null
  const anchor = caret(result.anchor)
  const focus = caret(result.focus)
  return anchor === null || focus === null
    ? null
    : { replacement, anchor, focus }
}

/** Replace only the rendered span; false (editor untouched) when the text is not `text`. */
export function spliceSvRenderedSpan(
  editor: HTMLElement,
  text: string,
  span: Span,
  replacement: string,
): boolean {
  if (svText(editor) !== text) return false
  const startPoint = textPointAt(editor, span.start)
  const endPoint = textPointAt(editor, span.end)
  if (!startPoint || !endPoint) return false
  const range = document.createRange()
  range.setStart(startPoint.node, startPoint.offset)
  range.setEnd(endPoint.node, endPoint.offset)
  range.deleteContents()
  range.insertNode(document.createTextNode(replacement))
  editor.normalize()
  return (
    svText(editor) ===
    text.slice(0, span.start) + replacement + text.slice(span.end)
  )
}
