// Task 730 — reveal a Markdown source line on the surface the reader is looking at. A `#L42` link
// (from another file, or the same document through the host) and the host's Reveal in Visual
// Editor both arrive as `reveal-line`. Before this, only IR and WYSIWYG revealed anything: Split
// (SV) and Preview returned false until the retry gave up, and a Preview-first open has no edit view
// at all (its `getValue()` is empty). Each surface now maps the line itself:
//
// - IR / WYSIWYG: nav/outline.ts `revealSourceLine` (block units, then the line inside the unit).
// - Split: the source pane shows the Markdown text, so the line is found in its text and the caret
//   placed (or the range selected) there. Scrolling the source pane drives the preview pane through
//   the split scroll sync (nav/split-scroll-sync.ts).
// - Preview: the readable text of every source line is aligned with the rendered text (the same
//   bounded diff Find uses), and the rendered element holding the line is scrolled into view.
//
// Lives in bridge/ because it needs editing/ (alignment, Preview text) and nav/; links/ may not
// import editing/ (editing already imports links), and nav/ may not either.
import type Vditor from 'vditor'
import { alignText, type OffsetAlignment } from '../editing/find-align'
import { collectPreviewText, fullPreviewRoot } from '../editing/preview-find'
import { FLASH_CLASS, revealSourceLine } from '../nav/outline'
import { liveDocumentText } from '../util/document-text'
import { scrollBehavior } from '../util/reduced-motion'
import {
  lineStartOffset,
  readableSourceLines,
  sourceLineForReveal,
} from '../util/source-map'

export interface LineRevealRequest {
  /** 0-based line of the document text the host holds. */
  line: number
  lineText?: string
  /** A range's 0-based last line, after `line`. */
  endLine?: number
  endLineText?: string
}

interface Point {
  node: Node
  offset: number
}

interface TextSegment {
  node: Text
  start: number
  end: number
}

type CaretRequest = (intent: Point | { anchor: Point; focus: Point }) => boolean

const FLASH_MS = 1400

function flash(element: HTMLElement): void {
  element.classList.add(FLASH_CLASS)
  setTimeout(() => element.classList.remove(FLASH_CLASS), FLASH_MS)
}

function segmentPoint(
  segments: readonly TextSegment[],
  offset: number,
  bias: 'start' | 'end',
): Point | null {
  const found =
    bias === 'end'
      ? segments.find((s) => offset > s.start && offset <= s.end)
      : segments.find((s) => offset >= s.start && offset < s.end)
  return found ? { node: found.node, offset: offset - found.start } : null
}

function svSegments(root: HTMLElement): {
  text: string
  segments: TextSegment[]
} {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const segments: TextSegment[] = []
  let text = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = (node as Text).data
    segments.push({
      node: node as Text,
      start: text.length,
      end: text.length + data.length,
    })
    text += data
  }
  return { text, segments }
}

/** Split: the source pane's own text is the Markdown, so the line is located in it directly. */
function revealInSource(
  root: HTMLElement,
  request: LineRevealRequest,
): boolean {
  const { text, segments } = svSegments(root)
  if (text.trim() === '') return false
  const line = sourceLineForReveal(text, request.line, request.lineText)
  if (line === null) return false
  const startOffset = lineStartOffset(text, line)
  const start =
    segmentPoint(segments, startOffset, 'start') ??
    segmentPoint(segments, startOffset, 'end')
  if (!start) return false
  const endLine =
    request.endLine === undefined
      ? null
      : sourceLineForReveal(text, request.endLine, request.endLineText)
  const endOffset =
    endLine !== null && endLine > line
      ? lineStartOffset(text, endLine) +
        (text.split('\n')[endLine]?.length ?? 0)
      : null
  const end =
    endOffset === null ? null : segmentPoint(segments, endOffset, 'end')
  const element =
    start.node instanceof HTMLElement ? start.node : start.node.parentElement
  element?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })
  const requestCaret = (
    window as unknown as { __vmdeRequestCaret?: CaretRequest }
  ).__vmdeRequestCaret
  requestCaret?.(end ? { anchor: start, focus: end } : start)
  return true
}

// The rendered element a Preview reveal scrolls to: the nearest line-level block holding `node`.
const PREVIEW_LINE_ELEMENT =
  'li, tr, p, h1, h2, h3, h4, h5, h6, pre, blockquote, dt, dd, table'

function previewElementAt(root: HTMLElement, node: Node): HTMLElement | null {
  const parent = node instanceof HTMLElement ? node : node.parentElement
  const element = parent?.closest<HTMLElement>(PREVIEW_LINE_ELEMENT)
  if (element && root.contains(element)) return element
  let top = parent
  while (top && top.parentElement !== root) top = top.parentElement
  return top ?? null
}

function topLevelChild(root: HTMLElement, node: Node): HTMLElement | null {
  let top: Node | null = node
  while (top && top.parentNode !== root) top = top.parentNode
  return top instanceof HTMLElement ? top : null
}

/** The first rendered offset of plain-text span [from, to), scanning forward. */
function firstMapped(
  alignment: OffsetAlignment,
  from: number,
  to: number,
): number | null {
  for (let offset = from; offset < to; offset++) {
    const mapped = alignment.toRendered(offset, 'start')
    if (mapped !== null) return mapped
  }
  return null
}

/** The last rendered offset before plain-text offset `before`, scanning backward. */
function lastMappedBefore(
  alignment: OffsetAlignment,
  before: number,
): number | null {
  for (let offset = before; offset > 0; offset--) {
    const mapped = alignment.toRendered(offset, 'end')
    if (mapped !== null) return mapped
  }
  return null
}

/** The readable text of every source line joined by newlines, with each line's offset in it. */
export function readableDocument(markdown: string): {
  text: string
  lineStarts: number[]
  lines: string[]
} {
  const lines = readableSourceLines(markdown)
  const lineStarts: number[] = []
  let offset = 0
  for (const line of lines) {
    lineStarts.push(offset)
    offset += line.length + 1
  }
  return { text: lines.join('\n'), lineStarts, lines }
}

/** Task 730 — the rendered-text offset of 0-based `line`, or of the element after the rendered
 * content that precedes it when the line itself renders as no text (a diagram, math, or a blank
 * line): `{ offset, after }` where `after` means "the block following this offset's block". */
export function previewOffsetForLine(
  markdown: string,
  rendered: string,
  line: number,
): { offset: number; after: boolean } | null {
  const readable = readableDocument(markdown)
  if (line < 0 || line >= readable.lines.length) return null
  const alignment = alignText(readable.text, rendered)
  const from = readable.lineStarts[line] ?? 0
  const own = firstMapped(
    alignment,
    from,
    from + (readable.lines[line]?.length ?? 0),
  )
  if (own !== null) return { offset: own, after: false }
  const before = lastMappedBefore(alignment, from - 1)
  if (before !== null) return { offset: Math.max(0, before - 1), after: true }
  const next = firstMapped(alignment, from, readable.text.length)
  return next === null ? null : { offset: next, after: false }
}

/** Preview: scroll the rendered element holding the line into view and flash it. */
function revealInPreview(
  vditor: Vditor,
  root: HTMLElement,
  request: LineRevealRequest,
): boolean {
  const markdown = liveDocumentText(vditor)
  if (markdown.trim() === '') return false
  const line = sourceLineForReveal(markdown, request.line, request.lineText)
  if (line === null) return false
  const snapshot = collectPreviewText(root)
  if (snapshot.text.trim() === '') return false
  const place = previewOffsetForLine(markdown, snapshot.text, line)
  if (!place) return false
  const segments: TextSegment[] = snapshot.nodes
  const point =
    segmentPoint(segments, place.offset, 'start') ??
    segmentPoint(segments, place.offset, 'end')
  if (!point) return false
  const element = place.after
    ? ((topLevelChild(root, point.node)
        ?.nextElementSibling as HTMLElement | null) ??
      previewElementAt(root, point.node))
    : previewElementAt(root, point.node)
  if (!element) return false
  element.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })
  flash(element)
  return true
}

/** Reveal `request` on the visible surface. False while that surface cannot place the line yet
 * (still rendering, or the line is not in its text), so the caller retries. */
export function revealLineOnSurface(
  vditor: Vditor,
  request: LineRevealRequest,
): boolean {
  const inner = (
    vditor as unknown as {
      vditor?: { currentMode?: string; sv?: { element?: HTMLElement } }
    }
  ).vditor
  const preview = fullPreviewRoot(vditor)
  if (preview) return revealInPreview(vditor, preview, request)
  if (inner?.currentMode === 'sv') {
    const root = inner.sv?.element
    return root ? revealInSource(root, request) : false
  }
  return revealSourceLine(
    vditor,
    request.line,
    request.lineText,
    request.endLine,
    request.endLineText,
  )
}
