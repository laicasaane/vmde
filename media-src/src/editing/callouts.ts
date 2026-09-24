// Callouts / GitHub Alerts (task 106) — IR dual-node.
//
// Lute renders `> [!NOTE]` as a plain editable blockquote (verified) — no node/marker. To make a
// callout edit like Vditor's code/mermaid blocks (a clean NON-editable render when the caret is
// outside, the raw source when it's inside) we build a dual-node ourselves, on two verified facts:
//   1. Tagging the blockquote with Vditor's own `vditor-ir__node` class makes Vditor's
//      `expandMarker` toggle `vditor-ir__node--expand` on it as the caret enters/leaves — so the
//      source⇄preview swap reuses Vditor's caret machinery (incl. keyboard) instead of our own.
//   2. Lute's serializer IGNORES `.vditor-ir__preview` (and `contenteditable=false`) subtrees, so
//      the non-editable render we inject INTO the blockquote doesn't affect the markdown — Lute
//      only sees the editable source (`[!NOTE]` + body), so it round-trips unchanged.
//
// CSS keys off `--expand`: collapsed → show the injected preview, hide the source; expanded → show
// the source, hide the preview. `observeCallouts` (MutationObserver) re-tags + re-syncs the preview
// after Vditor rebuilds the IR DOM on each edit.
//
// `matchCallout` is pure (unit-tested); the DOM transform is e2e-tested.

import {
  observeScopedMutations,
  queryIncludingSelf,
} from '../util/mutation-impact'
import {
  isCompositionActive,
  subscribeCompositionState,
} from '../util/caret-gesture'
import { innerVditor } from '../util/inner-vditor'
import { activeModeElement } from '../util/source-map'
import { findScroller } from '../chrome/toolbar-scroll-guard'
import {
  elementPanelBounds,
  elementPanelPosition,
} from '../chrome/floating-overlay'
import {
  captureRewrapSourceSelection,
  replaceSvMarkdownRange,
  type SourceSelection,
} from './rewrap-command'
import { requestCaret } from './caret'

export interface Callout {
  type: string
  /** Optional title after the marker (`[!NOTE] My title`). */
  title: string
}

// GitHub's 5 alerts + common Obsidian types. Unknown `[!x]` still renders (neutral style).
export const CALLOUT_TYPES = [
  'note',
  'tip',
  'important',
  'warning',
  'caution',
  'info',
  'abstract',
  'todo',
  'success',
  'question',
  'failure',
  'danger',
  'bug',
  'example',
  'quote',
] as const

const MARKER = /^\s*\[!([A-Za-z][\w-]*)\]([-+]?)[ \t]*(.*)$/
const PREVIEW_CLASS = 'vmde-callout__preview'
// Only these names render as a styled callout (GitHub's 5 alerts + the common Obsidian types above).
// An UNKNOWN `[!x]` is NOT a callout — like GitHub, it stays a plain blockquote showing the raw `[!x]`
// text, instead of a mystery blue box. (Was lenient before; user: "niepoprawny typ → surowy tekst".)
const KNOWN_TYPES: ReadonlySet<string> = new Set(CALLOUT_TYPES)

type CalloutContextKind =
  | 'empty'
  | 'paragraph'
  | 'blockquote'
  | 'callout'
  | 'unsupported'

export interface CalloutSourceContext {
  kind: CalloutContextKind
  type?: string
  title?: string
  canApply: boolean
  canRemove: boolean
  disabledReason?: string
  sourceStart: number
  sourceEnd: number
  quotePrefix?: string
  markerStart?: number
  markerEnd?: number
  markerEndWithBreak?: number
}

export type CalloutSourceAction =
  | { kind: 'apply'; type: string; title?: string }
  | { kind: 'remove' }

export interface CalloutTransformResult {
  changed: boolean
  markdown: string
  startOffset: number
  endOffset: number
  context: CalloutSourceContext
}

interface CalloutActionTarget {
  selection: SourceSelection
  context: CalloutSourceContext
}

export interface CalloutActionDeps {
  setApplying(applying: boolean): void
  postExact(markdown: string): void
  onError(error: unknown): void
}

interface SourceLine {
  text: string
  start: number
  end: number
  endWithBreak: number
}

function markdownLines(markdown: string): SourceLine[] {
  if (!markdown) return [{ text: '', start: 0, end: 0, endWithBreak: 0 }]
  const lines: SourceLine[] = []
  let start = 0
  while (start < markdown.length) {
    const newline = markdown.indexOf('\n', start)
    const end = newline === -1 ? markdown.length : newline
    lines.push({
      text: markdown.slice(start, end),
      start,
      end,
      endWithBreak: newline === -1 ? end : end + 1,
    })
    start = newline === -1 ? markdown.length : newline + 1
  }
  if (markdown.endsWith('\n')) {
    lines.push({
      text: '',
      start: markdown.length,
      end: markdown.length,
      endWithBreak: markdown.length,
    })
  }
  return lines
}

function lineAtOffset(lines: SourceLine[], offset: number): number {
  const clamped = Math.max(0, offset)
  const found = lines.findIndex(
    (line, index) =>
      clamped < line.endWithBreak ||
      (index === lines.length - 1 && clamped <= line.endWithBreak),
  )
  return found === -1 ? lines.length - 1 : found
}

const QUOTE_LINE = /^(\s*>\s?)/
const UNKNOWN_CALLOUT_LINE = /^\s*>\s*\[!/
const UNSUPPORTED_PROSE =
  /^\s*(?:#{1,6}(?:\s|$)|```|~~~|(?:[-+*]|\d+[.)])\s+|\|.*\||<|(?:[-*_]\s*){3,}$)/

function unsupportedContext(reason: string): CalloutSourceContext {
  return {
    kind: 'unsupported',
    canApply: false,
    canRemove: false,
    disabledReason: reason,
    sourceStart: 0,
    sourceEnd: 0,
  }
}

function lineIsInsideFence(lines: SourceLine[], target: number): boolean {
  let fence: '`' | '~' | null = null
  for (let index = 0; index <= target; index++) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(lines[index]?.text ?? '')?.[1]
    if (index === target && (fence !== null || marker)) return true
    if (!marker) continue
    const kind = marker[0] as '`' | '~'
    if (fence === null) fence = kind
    else if (fence === kind) fence = null
  }
  return fence !== null
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: conservative source block classification across empty/prose/quote/callout/unsupported selection shapes
export function deriveCalloutContext(
  markdown: string,
  startOffset: number,
  endOffset: number,
): CalloutSourceContext {
  const lines = markdownLines(markdown)
  const startLine = lineAtOffset(lines, startOffset)
  const endLine = lineAtOffset(lines, Math.max(startOffset, endOffset - 1))
  const line = lines[startLine]
  if (lineIsInsideFence(lines, startLine))
    return unsupportedContext('Unsupported fenced block')
  if (!line || line.text.trim() === '') {
    if (startLine !== endLine)
      return unsupportedContext('Selection crosses block boundaries')
    return {
      kind: 'empty',
      canApply: true,
      canRemove: false,
      sourceStart: line?.start ?? 0,
      sourceEnd: line?.end ?? 0,
    }
  }

  const quote = QUOTE_LINE.exec(line.text)
  if (quote) {
    let first = startLine
    let last = startLine
    while (first > 0 && QUOTE_LINE.test(lines[first - 1].text)) first--
    while (last + 1 < lines.length && QUOTE_LINE.test(lines[last + 1].text))
      last++
    if (endLine < first || endLine > last)
      return unsupportedContext('Selection crosses block boundaries')
    const firstLine = lines[first]
    const prefix = QUOTE_LINE.exec(firstLine.text)?.[1] ?? '> '
    const content = firstLine.text.slice(prefix.length)
    const callout = matchCallout(content)
    if (!callout && UNKNOWN_CALLOUT_LINE.test(firstLine.text)) {
      return unsupportedContext('Unsupported callout type')
    }
    return {
      kind: callout ? 'callout' : 'blockquote',
      type: callout?.type,
      title: callout?.title,
      canApply: true,
      canRemove: Boolean(callout),
      sourceStart: firstLine.start,
      sourceEnd: lines[last].end,
      quotePrefix: prefix,
      ...(callout
        ? {
            markerStart: firstLine.start,
            markerEnd: firstLine.end,
            markerEndWithBreak: firstLine.endWithBreak,
          }
        : {}),
    }
  }

  if (UNSUPPORTED_PROSE.test(line.text))
    return unsupportedContext('Unsupported Markdown block')
  let first = startLine
  let last = startLine
  while (
    first > 0 &&
    lines[first - 1].text.trim() !== '' &&
    !UNSUPPORTED_PROSE.test(lines[first - 1].text) &&
    !QUOTE_LINE.test(lines[first - 1].text)
  )
    first--
  while (
    last + 1 < lines.length &&
    lines[last + 1].text.trim() !== '' &&
    !UNSUPPORTED_PROSE.test(lines[last + 1].text) &&
    !QUOTE_LINE.test(lines[last + 1].text)
  )
    last++
  if (endLine < first || endLine > last)
    return unsupportedContext('Selection crosses block boundaries')
  return {
    kind: 'paragraph',
    canApply: true,
    canRemove: false,
    sourceStart: lines[first].start,
    sourceEnd: lines[last].end,
  }
}

const validActionType = (type: string): boolean =>
  KNOWN_TYPES.has(type.toLowerCase())

const markerText = (type: string, title = ''): string => {
  const trimmed = title.trim()
  return `[!${type.toUpperCase()}]${trimmed ? ` ${trimmed}` : ''}`
}

function mapReplacementOffset(
  offset: number,
  start: number,
  end: number,
  replacementLength: number,
): number {
  if (offset <= start) return start
  if (offset >= end) return start + replacementLength + (offset - end)
  return start + Math.min(offset - start, replacementLength)
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one pure transform covers create/convert/update/remove while preserving source offsets
export function transformCalloutMarkdown(
  markdown: string,
  startOffset: number,
  endOffset: number,
  action: CalloutSourceAction,
): CalloutTransformResult {
  const context = deriveCalloutContext(markdown, startOffset, endOffset)
  const unchanged = (): CalloutTransformResult => ({
    changed: false,
    markdown,
    startOffset,
    endOffset,
    context,
  })
  if (context.kind === 'unsupported') return unchanged()
  if (action.kind === 'remove' && context.kind !== 'callout') return unchanged()
  if (action.kind === 'apply' && !validActionType(action.type))
    return unchanged()

  let replaceStart = context.sourceStart
  let replaceEnd = context.sourceEnd
  let replacement = markdown.slice(replaceStart, replaceEnd)
  if (context.kind === 'empty' && action.kind === 'apply') {
    replacement = `> ${markerText(action.type, action.title)}\n> `
  } else if (context.kind === 'paragraph' && action.kind === 'apply') {
    const source = markdown.slice(replaceStart, replaceEnd)
    replacement = `> ${markerText(action.type, action.title)}\n${source
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}`
  } else if (context.kind === 'blockquote' && action.kind === 'apply') {
    replacement = `${context.quotePrefix}${markerText(action.type, action.title)}\n${replacement}`
  } else if (context.kind === 'callout') {
    replaceStart = context.markerStart as number
    replaceEnd = context.markerEnd as number
    const line = markdown.slice(replaceStart, replaceEnd)
    if (action.kind === 'remove') {
      const hasBody = (context.markerEndWithBreak as number) < context.sourceEnd
      replaceEnd = context.markerEndWithBreak as number
      replacement = hasBody ? '' : (context.quotePrefix ?? '> ')
    } else {
      const nextType = action.type.toUpperCase()
      replacement = line.replace(/\[![A-Za-z][\w-]*\]/, `[!${nextType}]`)
      if (action.title !== undefined) {
        const marker = /^(\s*>\s*\[![A-Za-z][\w-]*\][-+]?)/.exec(
          replacement,
        )?.[1]
        if (!marker) return unchanged()
        const title = action.title.trim()
        replacement = `${marker}${title ? ` ${title}` : ''}`
      }
    }
  }

  const nextMarkdown =
    markdown.slice(0, replaceStart) + replacement + markdown.slice(replaceEnd)
  if (nextMarkdown === markdown) return unchanged()

  let nextStart: number
  let nextEnd: number
  if (context.kind === 'empty') {
    nextStart = replaceStart + replacement.length
    nextEnd = nextStart
  } else if (context.kind === 'paragraph' && action.kind === 'apply') {
    const markerLength = `> ${markerText(action.type, action.title)}\n`.length
    const mapParagraph = (offset: number) => {
      const relative = Math.max(0, offset - context.sourceStart)
      const lineCount = markdown
        .slice(context.sourceStart, context.sourceStart + relative)
        .split('\n').length
      return context.sourceStart + markerLength + relative + lineCount * 2
    }
    nextStart = mapParagraph(startOffset)
    nextEnd = mapParagraph(endOffset)
  } else if (context.kind === 'blockquote' && action.kind === 'apply') {
    const delta =
      `${context.quotePrefix}${markerText(action.type, action.title)}\n`.length
    nextStart = startOffset + delta
    nextEnd = endOffset + delta
  } else {
    nextStart = mapReplacementOffset(
      startOffset,
      replaceStart,
      replaceEnd,
      replacement.length,
    )
    nextEnd = mapReplacementOffset(
      endOffset,
      replaceStart,
      replaceEnd,
      replacement.length,
    )
  }
  return {
    changed: true,
    markdown: nextMarkdown,
    startOffset: nextStart,
    endOffset: nextEnd,
    context: deriveCalloutContext(nextMarkdown, nextStart, nextEnd),
  }
}

const ACTION_CARET_BASE = '\uE420VMDE_CALLOUT_CARET'

function uniqueActionCaret(markdown: string): string {
  let counter = 0
  for (;;) {
    const marker = `${ACTION_CARET_BASE}_${counter}\uE42F`
    if (!markdown.includes(marker)) return marker
    counter++
  }
}

function removeActionCaret(editor: HTMLElement, marker: string): number | null {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let textOffset = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    const index = text.data.indexOf(marker)
    if (index < 0) {
      textOffset += text.data.length
      continue
    }
    text.deleteData(index, marker.length)
    return textOffset + index
  }
  return null
}

export function captureCalloutActionTarget(
  win: Window,
): CalloutActionTarget | null {
  const outer = win.vditor
  const inner = innerVditor()
  const editor = outer ? activeModeElement(outer) : null
  const domSelection = win.getSelection()
  let selection: SourceSelection | null = null
  if (inner?.currentMode === 'sv' && editor && domSelection?.rangeCount) {
    const range = domSelection.getRangeAt(0)
    if (
      editor.contains(range.startContainer) &&
      editor.contains(range.endContainer)
    ) {
      const offset = (node: Node, nodeOffset: number) => {
        const prefix = docRange(editor.ownerDocument, editor, node, nodeOffset)
        return prefix.toString().length
      }
      const startOffset = offset(range.startContainer, range.startOffset)
      const endOffset = offset(range.endContainer, range.endOffset)
      selection = {
        markdown: outer.getValue(),
        startOffset,
        endOffset,
        caretOffset: endOffset,
      }
    }
  } else {
    selection = captureRewrapSourceSelection(win)
  }
  if (!selection) return null
  return {
    selection,
    context: deriveCalloutContext(
      selection.markdown,
      selection.startOffset,
      selection.endOffset,
    ),
  }
}

function docRange(
  doc: Document,
  editor: HTMLElement,
  node: Node,
  offset: number,
): Range {
  const range = doc.createRange()
  range.selectNodeContents(editor)
  range.setEnd(node, offset)
  return range
}

/**
 * @knipignore — consumed by the Chromium callout-authoring harness, which is intentionally outside
 * knip's production entry graph.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one transaction adapter must keep IR/WYS marker restoration, SV exact-range repair, undo, scroll, focus, and rollback atomic
export function runCalloutAction(
  win: Window,
  deps: CalloutActionDeps,
  action: CalloutSourceAction,
  capturedTarget?: CalloutActionTarget | null,
): boolean {
  try {
    const target = capturedTarget ?? captureCalloutActionTarget(win)
    const outer = win.vditor
    const inner = innerVditor()
    const editor = outer ? activeModeElement(outer) : null
    if (!target || !outer || !inner || !editor) return false
    const result = transformCalloutMarkdown(
      target.selection.markdown,
      target.selection.startOffset,
      target.selection.endOffset,
      action,
    )
    if (!result.changed) return false

    const marker = uniqueActionCaret(result.markdown)
    const marked =
      result.markdown.slice(0, result.endOffset) +
      marker +
      result.markdown.slice(result.endOffset)
    const scroller = findScroller(editor)
    const scrollTop = scroller.scrollTop
    let applied = false
    deps.setApplying(true)
    try {
      inner.undo?.addToUndoStack?.(inner)
      if (inner.currentMode === 'sv') {
        if (
          !replaceSvMarkdownRange(editor, target.selection.markdown, {
            markdown: result.markdown,
            caretOffset: result.endOffset,
          })
        ) {
          return false
        }
        const fresh = activeModeElement(outer)
        if (!fresh) return false
        inner.undo?.addToUndoStack?.(inner)
        if (
          fresh.textContent !== result.markdown &&
          !replaceSvMarkdownRange(fresh, fresh.textContent ?? '', {
            markdown: result.markdown,
            caretOffset: result.endOffset,
          })
        ) {
          return false
        }
        const nextScroller = findScroller(fresh)
        nextScroller.scrollTop = Math.min(
          scrollTop,
          Math.max(0, nextScroller.scrollHeight - nextScroller.clientHeight),
        )
        fresh.focus({ preventScroll: true })
        applied = true
      } else {
        outer.setValue(marked)
        const fresh = activeModeElement(outer)
        const caret = fresh ? removeActionCaret(fresh, marker) : null
        if (caret === null) {
          outer.setValue(target.selection.markdown)
          return false
        }
        inner.undo?.addToUndoStack?.(inner)
        const nextScroller = findScroller(fresh as HTMLElement)
        nextScroller.scrollTop = Math.min(
          scrollTop,
          Math.max(0, nextScroller.scrollHeight - nextScroller.clientHeight),
        )
        ;(fresh as HTMLElement).focus({ preventScroll: true })
        win.requestAnimationFrame(() => requestCaret({ textOffset: caret }))
        applied = true
      }
    } finally {
      deps.setApplying(false)
    }
    if (!applied) return false
    deps.postExact(result.markdown)
    return true
  } catch (error) {
    deps.onError(error)
    return false
  }
}

let configuredCalloutActionDeps: CalloutActionDeps | undefined

export function configureCalloutActions(deps: CalloutActionDeps): void {
  configuredCalloutActionDeps = deps
}

function runConfiguredCalloutAction(
  action: CalloutSourceAction,
  target?: CalloutActionTarget | null,
): boolean {
  if (!configuredCalloutActionDeps) return false
  return runCalloutAction(window, configuredCalloutActionDeps, action, target)
}

/** Parse a blockquote's first line. Returns the callout, or null if it isn't one — either no
 *  `[!TYPE]` marker, OR a TYPE that isn't a known callout name (→ render as a plain blockquote).
 *  Obsidian's foldable suffix (`[!note]-` / `+`) is ACCEPTED but ignored — the callout
 *  renders normally (fold-state support was dropped as overkill at this stage). */
export function matchCallout(firstLine: string): Callout | null {
  const m = MARKER.exec(firstLine)
  if (!m) return null
  const type = m[1].toLowerCase()
  if (!KNOWN_TYPES.has(type)) return null // unknown type → not a callout (raw blockquote text)
  return {
    type,
    title: m[3].trim(),
  }
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// First line of a blockquote's first <p>. The soft break after the marker is a `<br>` in some
// renderings (Md2HTML / static) but a literal `\n` in the live IR DOM (verified:
// `<p>[!NOTE]\nbody</p>`), so we take the text up to the first <br> AND up to the first newline.
function firstLine(bq: Element): string {
  const p = bq.querySelector(':scope > p')
  if (!p) return ''
  const br = p.querySelector(':scope > br')
  let s = p.textContent || ''
  if (br) {
    s = ''
    let n: ChildNode | null = p.firstChild
    while (n && n !== br) {
      s += n.textContent || ''
      n = n.nextSibling
    }
  }
  return s.split('\n')[0]
}

// Remove the marker line (`[!NOTE]…`) from the FIRST <p> of a cloned body, so the preview shows
// only the body — the marker becomes the title instead. The line ends at the first <br> (static /
// Md2HTML) OR the first `\n` inside the leading text node (live IR). If the first <p> is just the
// marker (no body line), drop it.
function stripMarkerLine(body: HTMLElement): void {
  const p = body.querySelector(':scope > p')
  if (!p) return
  // Remove the leading marker line (`[!TYPE]…` up to the first soft break). The break is a `<br>`
  // (static / Md2HTML) OR a literal `\n` inside the text. Editing the marker makes the IR SPLIT the
  // leading run across several text nodes (e.g. `[!TIPs]` + `\nbody`), so we must SCAN the child nodes
  // in order — the old `p.firstChild` shortcut saw only `[!TIPs]`, found no `\n`, and dropped the WHOLE
  // <p> incl. the body in the sibling node (callout body vanished after renaming the type). Task 106/179.
  let n: ChildNode | null = p.firstChild
  while (n) {
    const next: ChildNode | null = n.nextSibling
    if (n.nodeName === 'BR') {
      p.removeChild(n) // the soft break ends the marker line
      break
    }
    if (n.nodeType === 3) {
      const txt = n.textContent ?? ''
      const nl = txt.indexOf('\n')
      if (nl === -1) {
        p.removeChild(n) // this whole text node is part of the marker line → drop it, keep scanning
        n = next
        continue
      }
      ;(n as Text).textContent = txt.slice(nl + 1) // keep the body after the newline
      break
    }
    p.removeChild(n) // a non-text inline before the break belongs to the marker line
    n = next
  }
  if (p.parentNode && !p.textContent?.trim() && !p.querySelector('*'))
    p.remove() // first <p> was only the marker (no body line)
}

/**
 * Build/refresh the non-editable rendered preview inside a callout blockquote: a title (from the
 * marker) + a clone of the body (the blockquote content minus the marker line). Marked
 * `.vditor-ir__preview` + `contenteditable=false` so Lute ignores it (the markdown round-trips
 * off the editable source). Guarded by a source signature so re-runs are no-ops — otherwise our
 * own injection would feed the MutationObserver back into an infinite loop.
 */
function syncPreview(bq: HTMLElement, c: Callout): void {
  const doc = bq.ownerDocument
  const srcChildren = Array.from(bq.children).filter(
    (el) => !el.classList.contains(PREVIEW_CLASS),
  )
  const title = c.title || titleCase(c.type)
  const sig = `${title} ${srcChildren.map((el) => el.outerHTML).join('')}`
  const existing = bq.querySelector<HTMLElement>(`:scope > .${PREVIEW_CLASS}`)
  if (existing && existing.dataset.sig === sig) return

  const preview = doc.createElement('div')
  preview.className = `vditor-ir__preview ${PREVIEW_CLASS}`
  preview.setAttribute('contenteditable', 'false')
  preview.dataset.sig = sig

  const titleEl = doc.createElement('div')
  titleEl.className = 'vmde-callout__title'
  titleEl.textContent = title
  preview.appendChild(titleEl)

  const body = doc.createElement('div')
  body.className = 'vmde-callout__body'
  for (const el of srcChildren) body.appendChild(el.cloneNode(true))
  stripMarkerLine(body)
  preview.appendChild(body)

  if (existing) existing.replaceWith(preview)
  else bq.appendChild(preview)
}

/**
 * True when `anchor` (the live selection's anchor node) sits inside this callout's EDITABLE source —
 * i.e. inside the blockquote but NOT inside the injected, non-editable `.vmde-callout__preview`.
 * Drives the "caret is editing this callout" guard (task 179): keep the dual-node expanded + skip the
 * preview rebuild while typing. Pure (no globals) so it's unit-testable; the caller reads the live
 * selection and passes its `anchorNode` (or null when there's no selection).
 */
export function calloutSourceHasAnchor(
  bq: Element,
  anchor: Node | null | undefined,
): boolean {
  if (!anchor || !bq.contains(anchor)) return false
  const host =
    anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement
  return !host?.closest(`.${PREVIEW_CLASS}`)
}

function clearCallout(bq: Element): void {
  bq.removeAttribute('data-callout')
  bq.removeAttribute('data-callout-title')
  bq.removeAttribute('data-callout-editing')
  bq.classList.remove('vditor-ir__node')
  bq.className = bq.className.replace(/\bvmde-callout(--\S+)?\b/g, '').trim()
  bq.querySelector(`:scope > .${PREVIEW_CLASS}`)?.remove()
  bq.querySelector(`:scope > .${TITLE_CLASS}`)?.remove()
  unwrapWysiwygMarker(bq)
}

// ── WYSIWYG callouts: a non-editable title + a native popover type-picker ─────────────────────────
// WYSIWYG has no `expandMarker` (the IR caret swap), so injecting the dual-node shows the source AND
// the render at once (duplicate content + a stray 2nd scrollbar). Instead the callout stays a normal
// editable blockquote with three pieces:
//   1. the raw `[!TYPE]` marker line is HIDDEN — wrapped in a non-editable span that stays in the
//      source, so Lute round-trips it unchanged (verified via a Lute-in-Node spike);
//   2. a non-editable title label (`Note`/`Important`/…) is shown at the top — like a real callout,
//      and (also CE=false) ignored by Lute;
//   3. the TYPE is changed from Vditor's own floating block popover (the panel that already carries
//      ∧ ∨ 🗑 for a focused blockquote) via the `customWysiwygToolbar('blockquote', …)` hook —
//      exactly the way you pick a code block's language. `calloutWysiwygToolbar` appends the
//      `<select>` there; changing it rewrites the marker in the hidden source.
// Vditor's SpinVditorDOM rebuilds the block to plain `[!TYPE]\nbody` on every keystroke, so
// observeCallouts re-applies the hide + title SYNCHRONOUSLY (before paint → no flash of the raw
// marker), idempotently (guards stop the MutationObserver feeding back into a loop).
const MARKER_CLASS = 'vmde-callout__marker'
const TITLE_CLASS = 'vmde-callout__title'
const TYPE_CONTROL_CLASS = 'vmde-callout__type'
const TITLE_INPUT_CLASS = 'vmde-callout__title-input'

/** Wrap the leading marker line (`[!TYPE] …` up to the soft break) of the callout's first <p> in a
 *  hidden, non-editable span — it disappears visually but stays in the source for serialization.
 *  Idempotent (skips if already wrapped). */
function hideWysiwygMarker(bq: HTMLElement): void {
  const p = bq.querySelector<HTMLElement>(':scope > p')
  const first = p?.firstChild
  if (!p || !first) return
  if (
    first.nodeType === 1 &&
    (first as HTMLElement).classList.contains(MARKER_CLASS)
  )
    return // already wrapped
  if (first.nodeType !== 3) return
  const span = p.ownerDocument.createElement('span')
  span.className = MARKER_CLASS
  span.setAttribute('contenteditable', 'false')
  const txt = first.textContent || ''
  const nl = txt.indexOf('\n')
  if (nl !== -1) {
    // marker line + the newline go into the hidden span; the body stays inline after it
    span.textContent = txt.slice(0, nl + 1)
    ;(first as Text).textContent = txt.slice(nl + 1)
    p.insertBefore(span, first)
    return
  }
  const next = first.nextSibling
  if (next && next.nodeName === 'BR') {
    // Lute sometimes emits the soft break as a <br>; fold the text + the <br> into the span
    span.appendChild(first)
    span.appendChild(next)
    p.insertBefore(span, p.firstChild)
    return
  }
  // marker only, no body line yet
  span.appendChild(first)
  p.insertBefore(span, p.firstChild)
}

/** Undo hideWysiwygMarker: splice the hidden marker span's contents back inline (for mode switches
 *  and when a callout is un-marked). */
function unwrapWysiwygMarker(bq: Element): void {
  for (const span of Array.from(
    bq.querySelectorAll<HTMLElement>(`.${MARKER_CLASS}`),
  )) {
    const parent = span.parentNode
    if (!parent) continue
    while (span.firstChild) parent.insertBefore(span.firstChild, span)
    parent.removeChild(span)
  }
}

/** Inject/refresh the non-editable callout title label (custom title, else the type name) at the top
 *  of the blockquote. CE=false → Lute ignores it. Idempotent (skips if the text already matches). */
function syncWysiwygTitle(bq: HTMLElement, c: Callout): void {
  const doc = bq.ownerDocument
  const title = c.title || titleCase(c.type)
  let el = bq.querySelector<HTMLElement>(`:scope > .${TITLE_CLASS}`)
  if (el && el.textContent === title) return
  if (!el) {
    el = doc.createElement('div')
    el.className = TITLE_CLASS
    el.setAttribute('contenteditable', 'false')
    bq.insertBefore(el, bq.firstChild)
  }
  el.textContent = title
}

/** Build the type `<option>` list onto a <select>, including any unknown `[!x]` type. */
function fillTypeOptions(select: HTMLSelectElement, current: string): void {
  const doc = select.ownerDocument
  for (const t of CALLOUT_TYPES) {
    const opt = doc.createElement('option')
    opt.value = t
    opt.textContent = titleCase(t)
    select.appendChild(opt)
  }
  if (!Array.from(select.options).some((o) => o.value === current)) {
    const opt = doc.createElement('option')
    opt.value = current
    opt.textContent = titleCase(current)
    select.insertBefore(opt, select.firstChild)
  }
  select.value = current
}

interface CalloutControlCallbacks {
  apply(type: string, title: string): void
  remove(): void
  dismiss(): void
}

export function createCalloutControls(
  doc: Document,
  context: CalloutSourceContext,
  callbacks: CalloutControlCallbacks,
): HTMLElement {
  const panel = doc.createElement('div')
  panel.className = 'vmde-callout-controls'
  panel.dataset.render = '1'
  panel.contentEditable = 'false'
  panel.setAttribute('role', 'group')
  panel.setAttribute('aria-label', 'Callout controls')

  const select = doc.createElement('select')
  select.className = `vditor-input ${TYPE_CONTROL_CLASS}`
  select.setAttribute('aria-label', 'Callout type')
  fillTypeOptions(select, context.type ?? 'note')
  panel.appendChild(select)

  const titleInput = doc.createElement('input')
  titleInput.className = `vditor-input ${TITLE_INPUT_CLASS}`
  titleInput.setAttribute('aria-label', 'Callout title')
  titleInput.placeholder = titleCase(context.type ?? 'note')
  titleInput.value = context.title ?? ''
  panel.appendChild(titleInput)

  const apply = doc.createElement('button')
  apply.type = 'button'
  apply.className = 'vmde-callout__apply'
  apply.textContent =
    context.kind === 'empty'
      ? 'Insert Callout'
      : context.kind === 'callout'
        ? 'Apply'
        : 'Make Callout'
  apply.disabled = !context.canApply
  apply.addEventListener('click', () =>
    callbacks.apply(select.value, titleInput.value),
  )
  panel.appendChild(apply)

  if (context.canRemove) {
    const remove = doc.createElement('button')
    remove.type = 'button'
    remove.className = 'vmde-callout__remove'
    remove.textContent = 'Remove Callout'
    remove.addEventListener('click', () => callbacks.remove())
    panel.appendChild(remove)
  }

  if (context.disabledReason) {
    const reason = doc.createElement('span')
    reason.className = 'vmde-callout__disabled-reason'
    reason.textContent = context.disabledReason
    panel.appendChild(reason)
  }
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    callbacks.dismiss()
  })
  return panel
}

function domContextForBlockquote(bq: HTMLElement): CalloutSourceContext {
  const callout = matchCallout(firstLine(bq))
  if (!callout && /^\s*\[!/.test(firstLine(bq))) {
    return {
      ...unsupportedContext('Unsupported callout type'),
      sourceStart: 0,
      sourceEnd: 0,
    }
  }
  return {
    kind: callout ? 'callout' : 'blockquote',
    type: callout?.type,
    title: callout?.title,
    canApply: true,
    canRemove: Boolean(callout),
    sourceStart: 0,
    sourceEnd: 0,
  }
}

function fullPreviewIsOpen(): boolean {
  const button = innerVditor()?.toolbar?.elements?.preview?.children[0]
  return button?.classList.contains('vditor-menu--current') === true
}

declare global {
  interface Window {
    __vmdeOpenContextualCalloutControls?: () => boolean
  }
}

export function installCalloutAuthoringControls(): () => void {
  const doc = document
  const toolbarButton = doc.querySelector<HTMLElement>(
    '.vditor-toolbar [data-type="callout"]',
  )
  const toolbarPanel = doc.createElement('div')
  toolbarPanel.className = 'vditor-hint vmde-callout-toolbar-panel'
  toolbarPanel.style.display = 'none'
  toolbarPanel.dataset.render = '1'
  toolbarPanel.contentEditable = 'false'
  doc.body.appendChild(toolbarPanel)

  const irPanel = doc.createElement('div')
  irPanel.className = 'vmde-callout-context-panel'
  irPanel.style.display = 'none'
  irPanel.dataset.render = '1'
  irPanel.contentEditable = 'false'
  doc.body.appendChild(irPanel)
  let currentBlockquote: HTMLElement | null = null
  let selectionRaf = 0

  const focusEditor = () =>
    activeModeElement(window.vditor)?.focus({ preventScroll: true })
  const hideToolbar = () => {
    toolbarPanel.style.display = 'none'
    irPanel.style.pointerEvents = ''
    toolbarButton?.setAttribute('aria-expanded', 'false')
    focusEditor()
  }
  const renderToolbar = (target: CalloutActionTarget | null) => {
    const context = target?.context ?? unsupportedContext('No callout target')
    toolbarPanel.replaceChildren(
      createCalloutControls(doc, context, {
        apply: (type, title) => {
          if (target)
            runConfiguredCalloutAction({ kind: 'apply', type, title }, target)
          hideToolbar()
        },
        remove: () => {
          if (target) runConfiguredCalloutAction({ kind: 'remove' }, target)
          hideToolbar()
        },
        dismiss: hideToolbar,
      }),
    )
  }
  const toggleToolbar = () => {
    if (fullPreviewIsOpen()) return
    if (toolbarPanel.style.display === 'block') {
      hideToolbar()
      return
    }
    const target = captureCalloutActionTarget(window)
    irPanel.style.display = 'none'
    irPanel.style.pointerEvents = 'none'
    currentBlockquote = null
    renderToolbar(target)
    const rect = toolbarButton?.getBoundingClientRect()
    if (rect) {
      toolbarPanel.style.left = `${Math.max(8, rect.right - 320)}px`
      toolbarPanel.style.top = `${rect.bottom + 2}px`
    }
    toolbarPanel.style.display = 'block'
    toolbarButton?.setAttribute('aria-expanded', 'true')
    toolbarPanel.querySelector<HTMLElement>('select, input, button')?.focus()
  }
  const onToggleToolbar = () => toggleToolbar()
  doc.addEventListener('vmde-toggle-callout-toolbar', onToggleToolbar)
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Node | null
    if (
      toolbarPanel.style.display === 'block' &&
      target &&
      !toolbarPanel.contains(target) &&
      !toolbarButton?.contains(target)
    ) {
      hideToolbar()
    }
  }
  doc.addEventListener('pointerdown', onPointerDown, true)
  toolbarButton?.setAttribute('aria-haspopup', 'dialog')
  toolbarButton?.setAttribute('aria-expanded', 'false')
  const toolbarPanelObserver = new MutationObserver(() => {
    toolbarButton?.setAttribute(
      'aria-expanded',
      toolbarPanel.style.display === 'block' ? 'true' : 'false',
    )
  })
  toolbarPanelObserver.observe(toolbarPanel, {
    attributes: true,
    attributeFilter: ['style'],
  })

  const hideIrPanel = () => {
    irPanel.style.display = 'none'
    irPanel.style.visibility = ''
    currentBlockquote = null
  }
  const positionIrPanel = (blockquote: HTMLElement) => {
    if (!blockquote.isConnected || !blockquote.closest('.vditor-ir')) {
      hideIrPanel()
      return
    }
    const rect = blockquote.getBoundingClientRect()
    const scroller = blockquote
      .closest('.vditor-content')
      ?.getBoundingClientRect()
    const toolbar = doc
      .querySelector('.vditor-toolbar')
      ?.getBoundingClientRect()
    const bounds = elementPanelBounds(
      { width: window.innerWidth, height: window.innerHeight },
      scroller,
      toolbar,
    )
    // Keep the active owner, but hide its panel while the block is fully outside
    // the visible editor; a later scroll can reveal and reposition the same controls.
    if (
      rect.bottom <= bounds.top ||
      rect.top >= bounds.bottom ||
      rect.right <= bounds.left ||
      rect.left >= bounds.right
    ) {
      irPanel.style.visibility = 'hidden'
      return
    }
    irPanel.style.visibility = ''
    // Cap the actual body-owned box to the scrollport intersection before sizing it.
    irPanel.style.maxWidth = `${Math.max(0, bounds.right - bounds.left)}px`
    const selection = doc.getSelection()
    const line = selection?.rangeCount
      ? selection.getRangeAt(0).getBoundingClientRect()
      : null
    const position = elementPanelPosition(
      rect,
      { width: irPanel.offsetWidth, height: irPanel.offsetHeight },
      bounds,
      line,
    )
    if (!position) {
      hideIrPanel()
      return
    }
    irPanel.style.left = `${position.left}px`
    irPanel.style.top = `${position.top}px`
  }
  const renderIrPanel = (blockquote: HTMLElement) => {
    currentBlockquote = blockquote
    const context = domContextForBlockquote(blockquote)
    const dismiss = () => {
      hideIrPanel()
      focusEditor()
    }
    irPanel.replaceChildren(
      createCalloutControls(doc, context, {
        apply: (type, title) => {
          runConfiguredCalloutAction({ kind: 'apply', type, title })
          dismiss()
        },
        remove: () => {
          runConfiguredCalloutAction({ kind: 'remove' })
          dismiss()
        },
        dismiss,
      }),
    )
    irPanel.style.display = 'flex'
    positionIrPanel(blockquote)
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one selection projection coordinates Preview disablement, toolbar state, and the single contextual surface
  const updateFromSelection = () => {
    selectionRaf = 0
    if (
      toolbarPanel.style.display === 'block' ||
      toolbarPanel.contains(doc.activeElement)
    ) {
      hideIrPanel()
      return
    }
    if (irPanel.contains(doc.activeElement)) return
    const selection = doc.getSelection()
    const anchor = selection?.rangeCount ? selection.anchorNode : null
    const host =
      anchor?.nodeType === Node.ELEMENT_NODE
        ? (anchor as Element)
        : anchor?.parentElement
    const blockquote =
      host?.closest<HTMLElement>('.vditor-ir blockquote') ?? null
    const previewVisible = fullPreviewIsOpen()
    if (toolbarButton instanceof HTMLButtonElement) {
      toolbarButton.disabled = previewVisible
    }
    toolbarButton?.setAttribute(
      'aria-disabled',
      previewVisible ? 'true' : 'false',
    )
    if (previewVisible) {
      hideIrPanel()
      return
    }
    toolbarButton?.classList.toggle(
      'vditor-menu--current',
      Boolean(host?.closest('blockquote[data-callout]')),
    )
    if (!blockquote) {
      hideIrPanel()
      return
    }
    const signature = `${firstLine(blockquote)}|${blockquote.isConnected}`
    if (
      currentBlockquote === blockquote &&
      irPanel.dataset.signature === signature
    ) {
      positionIrPanel(blockquote)
      return
    }
    irPanel.dataset.signature = signature
    renderIrPanel(blockquote)
  }
  const onSelectionChange = () => {
    if (selectionRaf) return
    selectionRaf = requestAnimationFrame(updateFromSelection)
  }
  doc.addEventListener('selectionchange', onSelectionChange)
  // The body-owned panel does not move with the editor scroller; recalculate from the
  // live quote rectangle after scrolling or resizing, including while a field has focus.
  const onLayoutChange = () => {
    if (currentBlockquote && irPanel.style.display !== 'none')
      requestAnimationFrame(() => {
        if (currentBlockquote) positionIrPanel(currentBlockquote)
      })
  }
  doc.addEventListener('scroll', onLayoutChange, true)
  window.addEventListener('resize', onLayoutChange)
  const previewButton = innerVditor()?.toolbar?.elements?.preview?.children[0]
  const previewObserver = new MutationObserver(() => onSelectionChange())
  if (previewButton) {
    previewObserver.observe(previewButton, {
      attributes: true,
      attributeFilter: ['class'],
    })
  }
  onSelectionChange()

  window.__vmdeOpenContextualCalloutControls = () => {
    updateFromSelection()
    const visible = irPanel.style.display !== 'none'
    const nativePopover = innerVditor()?.wysiwyg?.popover
    const panel = visible ? irPanel : nativePopover
    const control = panel?.querySelector<HTMLElement>(
      '.vmde-callout-controls select, .vmde-callout-controls input',
    )
    if (!control) return false
    control.focus({ preventScroll: true })
    // The chord is handled in capture phase, before Vditor's own key handlers and focus bookkeeping
    // have finished the event. Reassert once on the next frame so a late same-key focus restore
    // cannot leave the panel visible but its first control inactive.
    const refocus = () => {
      if (control.isConnected) control.focus({ preventScroll: true })
    }
    requestAnimationFrame(() => requestAnimationFrame(refocus))
    setTimeout(refocus, 50)
    return true
  }

  return () => {
    if (selectionRaf) cancelAnimationFrame(selectionRaf)
    previewObserver.disconnect()
    doc.removeEventListener('selectionchange', onSelectionChange)
    doc.removeEventListener('scroll', onLayoutChange, true)
    window.removeEventListener('resize', onLayoutChange)
    doc.removeEventListener('vmde-toggle-callout-toolbar', onToggleToolbar)
    doc.removeEventListener('pointerdown', onPointerDown, true)
    toolbarPanelObserver.disconnect()
    toolbarPanel.remove()
    irPanel.remove()
    delete window.__vmdeOpenContextualCalloutControls
  }
}

/**
 * Vditor `customWysiwygToolbar` hook. Vditor builds a floating popover for a focused blockquote
 * (∧ ∨ 🗑) and calls this with `('blockquote', popover)`; if the focused blockquote is a callout we
 * append a native type `<select>` (styled `.vditor-input`, like the code block's language field).
 * Vditor clears + rebuilds the popover on each selection change, so this just appends fresh.
 */
export function calloutWysiwygToolbar(
  type: string,
  popover: HTMLElement | null | undefined,
): void {
  if (type !== 'blockquote' || !popover) return
  const sel = popover.ownerDocument.getSelection?.()
  const anchor = sel?.anchorNode
  const from =
    anchor && anchor.nodeType === 1
      ? (anchor as Element)
      : (anchor?.parentElement ?? null)
  const bq = from?.closest('blockquote') as HTMLElement | null
  if (!bq) return
  const target = captureCalloutActionTarget(window)
  if (!target?.context.canApply) return
  const dismiss = () => {
    popover.style.display = 'none'
    activeModeElement(window.vditor)?.focus({ preventScroll: true })
  }
  popover.appendChild(
    createCalloutControls(popover.ownerDocument, target.context, {
      apply: (calloutType, title) => {
        runConfiguredCalloutAction(
          { kind: 'apply', type: calloutType, title },
          target,
        )
        dismiss()
      },
      remove: () => {
        runConfiguredCalloutAction({ kind: 'remove' }, target)
        dismiss()
      },
      dismiss,
    }),
  )
}

/** Decorate one blockquote: colour classes + the mode-appropriate render (IR/Preview dual-node, or
 *  the WYSIWYG dropdown header + hidden marker). Clears decoration if it's no longer a callout. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: branches on callout type/mode (IR vs WYSIWYG) and editing state; pre-existing (task 469 baseline)
function decorateCallout(bq: Element): void {
  const c = matchCallout(firstLine(bq))
  if (!c) {
    if (bq.hasAttribute('data-callout')) clearCallout(bq)
    return
  }
  if (bq.getAttribute('data-callout') !== c.type) {
    bq.className = bq.className.replace(/\bvmde-callout(--\S+)?\b/g, '').trim()
    bq.classList.add('vmde-callout', `vmde-callout--${c.type}`)
  }
  bq.setAttribute('data-callout', c.type)
  bq.setAttribute('data-callout-title', c.title || titleCase(c.type))
  if ((bq as HTMLElement).closest('.vditor-wysiwyg')) {
    // WYSIWYG: a non-editable title label + the hidden marker (the type picker lives in Vditor's
    // popover, see calloutWysiwygToolbar). NOT the dual-node (no expandMarker here).
    bq.classList.remove('vditor-ir__node')
    bq.querySelector<HTMLElement>(`:scope > .${PREVIEW_CLASS}`)?.remove()
    syncWysiwygTitle(bq as HTMLElement, c)
    hideWysiwygMarker(bq as HTMLElement)
  } else {
    // IR editor / Preview pane: the dual-node (Vditor's expandMarker or the no-caret preview state
    // swaps source⇄render). Strip any WYSIWYG title/hidden-marker a prior mode left behind.
    bq.querySelector<HTMLElement>(`:scope > .${TITLE_CLASS}`)?.remove()
    unwrapWysiwygMarker(bq)
    bq.classList.add('vditor-ir__node')
    // Editing guard (task 179). Every keystroke runs SpinVditorIRDOM, which REBUILDS the blockquote
    // (dropping our `vditor-ir__node`/`--expand`) and fires observeCallouts SYNCHRONOUSLY — before
    // Vditor's keyup re-adds `--expand`. So drive the expand/collapse off the LIVE selection, not
    // Vditor's timing: caret inside this callout's source → keep it expanded; caret outside → collapse.
    const inIr = !!(bq as HTMLElement).closest('.vditor-ir')
    const sel = bq.ownerDocument.getSelection?.()
    const anchor = sel?.rangeCount ? sel.anchorNode : null
    if (inIr && calloutSourceHasAnchor(bq, anchor)) {
      bq.classList.add('vditor-ir__node--expand')
      bq.setAttribute('data-callout-editing', '')
    } else {
      bq.removeAttribute('data-callout-editing')
      if (inIr) bq.classList.remove('vditor-ir__node--expand')
    }
    // Keep the preview built in BOTH states. While editing it's HIDDEN under `--expand`, but it must
    // already EXIST so collapsing on caret-leave reveals the rendered callout IMMEDIATELY instead of an
    // empty frame — the re-spin drops the injected preview every keystroke, and a missing preview at the
    // moment `--expand` clears made the callout vanish → content jumped up → reappear (user report).
    // syncPreview only READS/clones the source (it never mutates the editable <p> the caret is in), so
    // it can't eject the caret; its source-signature guard makes the steady-state runs no-ops.
    syncPreview(bq as HTMLElement, c)
  }
}

/**
 * Turn `[!TYPE]` blockquotes inside `root` into callouts. IR/Preview get the dual-node; WYSIWYG gets
 * the type dropdown + hidden marker. Idempotent — each blockquote's render is rebuilt only when its
 * source signature changed, so it won't feed the MutationObserver back into a loop.
 */
export function applyCallouts(root: ParentNode | null | undefined): void {
  if (!root || typeof (root as ParentNode).querySelectorAll !== 'function')
    return
  for (const bq of Array.from(
    (root as ParentNode).querySelectorAll('blockquote'),
  ))
    decorateCallout(bq)
}

/**
 * Task 173: the scoped counterpart of `applyCallouts` — re-decorate blockquotes inside a single
 * top-level block instead of the whole editor. Uses `queryIncludingSelf` because a scoped block CAN
 * itself be the `<blockquote>` we're looking for (`block.querySelectorAll('blockquote')` alone would
 * miss it — querySelectorAll only searches descendants).
 */
function applyCalloutsWithin(block: Element): void {
  for (const bq of queryIncludingSelf<HTMLElement>(block, 'blockquote'))
    decorateCallout(bq)
}

/**
 * Keep callouts wired as the editor rebuilds its DOM on each edit. The first mutation batch of a
 * frame re-applies SYNCHRONOUSLY (before paint → no flash of the raw `[!TYPE]` marker in WYSIWYG)
 * and same-frame bursts coalesce into one pre-paint trailing run (coalescePerFrame, 185/2c);
 * observes childList/characterData (NOT attributes), and every transform is idempotent (signature /
 * already-wrapped guards), so our own injections don't re-trigger an infinite loop. Returns a
 * disposer. (Same pattern as observeCodeSource.)
 *
 * Task 173/174: each batch is scoped to the top-level block(s) it touched (mutation-scope.ts) instead
 * of a whole-`editorEl` `querySelectorAll('blockquote')`, and a batch that's entirely our own preview/
 * marker/title injections is dropped outright (no re-walk at all) — see mutation-scope.ts's doc
 * comment for why `record.target` can't drive the scoping and why the fallback errs toward a full
 * walk rather than under-scoping.
 */
export function observeCallouts(
  editorEl: HTMLElement | null | undefined,
): () => void {
  // No editor root mounted yet — nothing to observe; hand back a no-op
  // disposer so callers can always call the returned teardown unconditionally.
  if (!editorEl)
    return () => {
      /* no-op disposer */
    }
  const disposeObserver = observeScopedMutations(editorEl, {
    full: applyCallouts,
    within: applyCalloutsWithin,
  })

  // Caret-leave preview re-sync (task 179). While the caret is inside an IR callout, decorateCallout
  // SKIPS rebuilding the preview (so typing can't eject the caret) → the preview is left stale and the
  // callout is flagged `data-callout-editing`. The MutationObserver fires on content edits but NOT on
  // a bare caret move OUT of the callout (click / arrow away without editing), so without this the
  // stale render would show on leave. On every selection change, re-derive editing state from the LIVE
  // selection (`:focus-within` doesn't work on the IR edit surface): keep the focused callout
  // expanded, and re-sync any callout still flagged-editing that no longer holds the caret (collapse +
  // rebuild its preview from the final source). Self-correcting off the DOM flag → no cross-event state.
  const doc = editorEl.ownerDocument
  let deferredSelectionChange = false
  let disposed = false
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: re-derives editing/expanded state for every callout from the live selection on each change; pre-existing (task 469 baseline)
  const onSelectionChange = () => {
    if (isCompositionActive()) {
      deferredSelectionChange = true
      return
    }
    deferredSelectionChange = false
    const sel = doc.getSelection?.()
    const anchor = sel?.rangeCount ? sel.anchorNode : null
    const host = anchor
      ? anchor.nodeType === 1
        ? (anchor as Element)
        : anchor.parentElement
      : null
    const current =
      host && editorEl.contains(host) && !host.closest(`.${PREVIEW_CLASS}`)
        ? host.closest<HTMLElement>('blockquote[data-callout]')
        : null
    if (current?.closest('.vditor-ir'))
      current.classList.add('vditor-ir__node--expand')
    for (const left of Array.from(
      editorEl.querySelectorAll<HTMLElement>(
        'blockquote[data-callout-editing]',
      ),
    )) {
      if (left === current) continue // still being typed in
      left.classList.remove('vditor-ir__node--expand') // collapse the callout we just left…
      decorateCallout(left) // …and rebuild its preview from the now-final source (caret is outside)
    }
  }
  doc.addEventListener('selectionchange', onSelectionChange)
  const unsubscribeComposition = subscribeCompositionState((active) => {
    if (!active && deferredSelectionChange) {
      // The composition authority clears in document capture. Wait until the event stack finishes so
      // Vditor's own compositionend handlers commit the staged text before we rebuild the preview.
      queueMicrotask(() => {
        if (!disposed && deferredSelectionChange && !isCompositionActive())
          onSelectionChange()
      })
    }
  })

  return () => {
    disposed = true
    disposeObserver()
    doc.removeEventListener('selectionchange', onSelectionChange)
    unsubscribeComposition()
  }
}
