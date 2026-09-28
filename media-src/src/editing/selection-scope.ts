// Task 506 — Word/Word-processor behaviour for the promoted inline-format keys: pressing
// Ctrl+B / Ctrl+I / Ctrl+D (bold / italic / strike) with a COLLAPSED caret inside a word must wrap
// THAT WORD (`Hello **world**.`), not insert open markers at the caret. Vditor's own collapsed
// branches (`**<wbr>**` in IR, an empty <strong>/<em>/<s> in WYSIWYG) are right for "type after
// pressing the key", wrong for the word you're standing in.
//
// Why a capture-phase document CLICK listener rather than a Vditor TS patch: both the toolbar
// buttons and the hotkey path (message-router's `trigger-toolbar-hotkey` dispatches a synthetic
// click on the same button) converge on Vditor's MenuItem bubble-phase click handler, which calls
// `getEditorRange(vditor)` → `getSelection().getRangeAt(0)` LIVE (selection.ts). Expanding the
// selection in capture, before that bubble handler runs, makes Vditor's existing NON-collapsed
// branches do the right thing in every mode (IR wraps `**word**`, WYSIWYG execCommands the word,
// and both toggle-off paths remove the strong/em/s from the word) — zero vendored changes. Same
// capture-phase shape as escape-toolbar.ts.
//
// Two real-webview measurements shape the expansion (task 506):
//  1. "No selection" must be tested as `range.toString() === ''`, NOT `sel.isCollapsed` — Vditor's
//     caret restoration leaves the caret as a NON-collapsed empty range (start === end, no
//     `collapse()`), which is why Vditor's own handlers test `range.toString() === ""`.
//  2. A mid-word caret sits on a TEXT-NODE boundary: Vditor splits the containing text node at the
//     caret, so "world" becomes the adjacent nodes "wo" | "rld". The word must be re-joined ACROSS
//     direct text siblings (never across elements — IR markers are spans, so crossing only text
//     siblings can never swallow a `**` marker).
import { invalidateCaret, requestCaret } from './caret'
import { activeModeElement } from '../util/source-map'
import { hasClosestBlock } from 'vditor/src/ts/util/hasClosest'
import { guardComposition } from '../util/caret-gesture'
import { innerVditor } from '../util/inner-vditor'
import { findScroller } from '../chrome/toolbar-scroll-guard'

export {
  findMarkdownMatches,
  replaceAllMarkdownMatches,
  replaceMarkdownMatch,
} from './find-engine'
import {
  replaceAllMarkdownMatches,
  replaceMarkdownMatch,
  type MarkdownFindOptions,
  type MarkdownMatch,
  type MarkdownReplaceResult,
} from './find-engine'
import { createFindSourceTracker, type FindResult } from './find-source'
import { findMapperFor, type FindMapper, type VisibleBox } from './find-map'
import {
  checkpointEditorUndo,
  recordRewrapDocumentHistory,
} from './rewrap-command'
import type { SourceBlockIndexHandle } from '../nav/source-block-index'
import type {
  FindWidgetAction,
  HostMessage,
} from '../../../src/shared/protocol'
import { isMac } from '../util/platform'

// Exactly the three formats the user named (task 506 scope decision). `inline-code` (Ctrl+G) keeps
// its collapsed-caret behaviour — deliberately not expanded here; see the task file.
const WORD_FORMAT_BUTTONS: ReadonlySet<string> = new Set([
  'bold',
  'italic',
  'strike',
])

// Opening marker length in the IR DOM for each word format. Wrapping shifts the word (and a caret
// inside it) by exactly this many text characters (`Hello world.` → `Hello **world**.` moves the
// caret +2); unwrapping shifts it back by the same amount.
const FORMAT_MARKER_LENGTH: Record<string, number> = {
  bold: 2, // **
  italic: 1, // *
  strike: 2, // ~~
}

const FORMAT_INLINE_TAG: Record<string, string> = {
  bold: 'strong',
  italic: 'em',
  strike: 's',
}

const WS = /\s/
// Punctuation that ends a sentence/clause is not part of the word it trails — `Hello world.` with a
// caret in "world" must bold `world`, not `world.` (Word-style). Deliberately not a full
// `\p{P}` set: `*`, `_`, `~`, backtick etc. are markdown markers and belong to neighbouring
// formats, not to a word boundary decision.
const TRAILING_PUNCT = /[.,;:!?)\]}>"'”’…]/

/**
 * The maximal run of non-whitespace touching `offset` in `text`, or null when the caret is not in
 * (or immediately at the edge of) a word. `offset` is exclusive: chars before it are the left side,
 * chars at/after it the right side. A caret parked between two whitespace chars — or in an empty
 * text node — walks to `start === end` and yields null. Pure, no DOM (unit-tested directly).
 */
export function wordRangeInText(
  text: string,
  offset: number,
): readonly [number, number] | null {
  if (offset < 0 || offset > text.length) return null
  let start = offset
  while (start > 0 && !WS.test(text[start - 1]!)) start--
  let end = offset
  while (end < text.length && !WS.test(text[end]!)) end++
  return start === end ? null : [start, end]
}

// Only DIRECT text siblings count as word continuations. Crossing an element is never right: IR
// renders `**` markers as <span>s, so a word split by Vditor's caret handling is always adjacent
// text nodes, and a genuine source-level word split (a marker element mid-word) should not be
// re-joined.
function prevTextNode(node: Node): Text | null {
  let p = node.previousSibling
  // Vditor's caret/undo markers can leave zero-length text siblings after removal. They carry no
  // word boundary, so skip them while still refusing to cross a real element/Markdown marker.
  while (p?.nodeType === Node.TEXT_NODE && (p as Text).data.length === 0)
    p = p.previousSibling
  return p?.nodeType === Node.TEXT_NODE ? (p as Text) : null
}

function nextTextNode(node: Node): Text | null {
  let n = node.nextSibling
  while (n?.nodeType === Node.TEXT_NODE && (n as Text).data.length === 0)
    n = n.nextSibling
  return n?.nodeType === Node.TEXT_NODE ? (n as Text) : null
}

function insideMarker(node: Node): boolean {
  const el = node.parentElement
  return (
    !!el &&
    (el.hasAttribute?.('data-marker') ||
      (el.getAttribute('class') ?? '').includes('vditor-ir__marker'))
  )
}

// The absolute character offset of `sel`'s caret within `editor` (0-based, every text node
// depth-first, IR marker spans included). -1 when there is no selection inside the editor.
export function caretTextOffset(editor: Node, sel: Selection): number {
  if (sel.rangeCount === 0) return -1
  const range = sel.getRangeAt(0)
  if (!editor.contains(range.startContainer)) return -1
  const before = range.cloneRange()
  before.selectNodeContents(editor)
  before.setEnd(range.startContainer, range.startOffset)
  return before.toString().length
}

// Is `node` inside an inline format of the given type? Mirrors what makes Vditor's remove-branch
// run — the caret is inside a `data-type="strong"/em/s` element, so the click unwraps rather than
// wraps, and the caret must shift the OTHER way.
export function isInsideInlineFormat(node: Node, type: string): boolean {
  const tag = FORMAT_INLINE_TAG[type]
  const el = node.parentElement
  if (!tag || !el) return false
  return !!el.closest?.(`[data-type="${tag}"], ${tag}`)
}

// Extend a word's LEFT boundary across text siblings: while the boundary sits at a node's START
// and the previous sibling's text ends without whitespace, the word continues into it.
function extendLeft(
  caret: Text,
  startOff: number,
): { node: Text; off: number } {
  let node = caret
  let off = startOff
  while (off === 0) {
    const prev = prevTextNode(node)
    if (
      !prev ||
      prev.data.length === 0 ||
      WS.test(prev.data[prev.data.length - 1]!)
    ) {
      break
    }
    node = prev
    let i = prev.data.length
    while (i > 0 && !WS.test(prev.data[i - 1]!)) i--
    off = i
  }
  return { node, off }
}

// Extend a word's RIGHT boundary across text siblings: while the boundary sits at a node's END and
// the next sibling's text starts without whitespace, the word continues into it.
function extendRight(caret: Text, endOff: number): { node: Text; off: number } {
  let node = caret
  let off = endOff
  while (off === node.data.length) {
    const next = nextTextNode(node)
    if (!next || next.data.length === 0 || WS.test(next.data[0]!)) break
    node = next
    let i = 0
    while (i < next.data.length && !WS.test(next.data[i]!)) i++
    off = i
  }
  return { node, off }
}

// Trim trailing punctuation; if that empties the boundary node entirely, step back to the previous
// text sibling and keep trimming there.
function trimTrailingPunct(
  right: Text,
  rightOff: number,
): { node: Text; off: number } {
  let node = right
  let off = rightOff
  while (off > 0 && TRAILING_PUNCT.test(node.data[off - 1]!)) off--
  while (off === 0) {
    const prev = prevTextNode(node)
    if (!prev) return { node, off }
    node = prev
    off = prev.data.length
    while (off > 0 && TRAILING_PUNCT.test(node.data[off - 1]!)) off--
  }
  return { node, off }
}

/**
 * Expand a "no selected text" caret to the word it stands in. Returns true if it expanded.
 *
 * "No selection" is `range.toString() === ''`, NOT `sel.isCollapsed` — see the file header (Vditor
 * represents a caret as a non-collapsed empty range). Scope guards: only text-node carets (an
 * element-container caret sits on a marker/boundary where cross-node walking is unreliable), only
 * inside `editor`, only when a word actually touches the caret. A real (non-empty) selection passes
 * through untouched — formatting it is already correct.
 */
export function expandCollapsedSelectionToWord(
  sel: Selection,
  editor: Node,
): boolean {
  if (sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  if (range.toString() !== '') return false
  const start = range.startContainer
  if (start.nodeType !== Node.TEXT_NODE || insideMarker(start)) return false
  if (!editor.contains(start)) return false
  const caret = start as Text
  const inner = wordRangeInText(caret.data, range.startOffset)
  if (!inner) return false

  const rightBound = extendRight(caret, inner[1])
  const right = trimTrailingPunct(rightBound.node, rightBound.off)
  const left = extendLeft(caret, inner[0])
  // The token vanished (all-punctuation "word", or a caret between two whitespace chars).
  if (left.node === right.node && left.off === right.off) return false

  range.setStart(left.node, left.off)
  range.setEnd(right.node, right.off)
  sel.removeAllRanges()
  sel.addRange(range)
  return true
}

/**
 * Install the capture-phase click listener that word-expands before a bold/italic/strike click
 * runs. Capture is required: it must run before Vditor's MenuItem bubble-phase handler reads the
 * range. Idempotent across re-inits (each call binds its own listener; the returned teardown
 * removes exactly that one). `win` mirrors `setupFormatHotkeyGuard`'s signature for testability.
 */
// Defer a caret restore until after Vditor's synchronous click handler + re-render have run, then
// shift the caret back to its original position within the wrapped word. Vditor's wrap moves the
// caret past the closing marker; the word (and a caret inside it) shifts by the opening marker's
// length on wrap, and back on unwrap. requestCaret's own rAF re-assertion covers any async tail,
// and the next real gesture invalidates the intent (ADR-0007).
function scheduleCaretRestore(
  win: Window & typeof globalThis,
  type: string,
  caretOffset: number,
  removing: boolean,
): void {
  const delta = (removing ? -1 : 1) * (FORMAT_MARKER_LENGTH[type] ?? 0)
  win.setTimeout(() => {
    requestCaret({ textOffset: caretOffset + delta })
  }, 0)
}

export function installFormatWordExpand(
  win: Window & typeof globalThis = window,
): () => void {
  const onToolbarClick = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof win.Element)) return
    const button = target.closest('button[data-type]')
    if (!button) return
    const type = button.getAttribute('data-type') ?? ''
    if (!WORD_FORMAT_BUTTONS.has(type)) return
    const editor = activeModeElement(win.vditor)
    const sel = win.getSelection()
    if (!editor || !sel || sel.rangeCount === 0) return
    // Capture the caret BEFORE the expansion mutates the selection: its absolute char offset, and
    // whether the click will REMOVE (caret inside an already-formatted word) rather than add.
    const caretOffset = caretTextOffset(editor, sel)
    if (caretOffset < 0) return
    const removing = isInsideInlineFormat(
      sel.getRangeAt(0).startContainer,
      type,
    )
    if (!expandCollapsedSelectionToWord(sel, editor)) return
    scheduleCaretRestore(win, type, caretOffset, removing)
  }
  win.document.addEventListener('click', onToolbarClick, true)
  return () => win.document.removeEventListener('click', onToolbarClick, true)
}

type StructuralScopeKind = 'inline' | 'cell' | 'block' | 'document'

export interface StructuralScope {
  kind: StructuralScopeKind
  element: HTMLElement
  range: Range
}

function elementAt(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement
}

function nodeIsTransient(node: Node): boolean {
  return (
    node instanceof HTMLElement &&
    (node.classList.contains('vditor-ir__marker') ||
      node.hasAttribute('data-render'))
  )
}

/** Select the first contiguous authored-content run inside an inline IR node. Marker spans and
 * renderer/helper DOM are structural chrome, so Ctrl+E never includes them in type-to-replace. */
export function inlineContentRange(node: HTMLElement): Range | null {
  let first: Node | null = null
  let last: Node | null = null
  for (const child of Array.from(node.childNodes)) {
    if (nodeIsTransient(child)) {
      if (first) break
      continue
    }
    first ??= child
    last = child
  }
  if (!first || !last) return null
  const range = document.createRange()
  range.setStartBefore(first)
  range.setEndAfter(last)
  return range
}

function contentsRange(element: HTMLElement): Range {
  const range = document.createRange()
  range.selectNodeContents(element)
  return range
}

function blockRange(element: HTMLElement): Range {
  const range = document.createRange()
  if (element.tagName === 'TABLE') range.selectNode(element)
  else range.selectNodeContents(element)
  return range
}

export function rangesEqual(a: Range, b: Range): boolean {
  return (
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  )
}

function structuralBlock(
  node: Node,
  cell: HTMLElement | null,
): HTMLElement | null {
  if (cell) {
    const table = cell.closest<HTMLElement>('table')
    if (table) return table
  }
  const block = hasClosestBlock(node)
  return block || null
}

/** The strict widening ladder under a live IR range: inline authored content → table cell →
 * Markdown block → document. Duplicate scopes (for example a plain block with no inline node) are
 * omitted, so every repeated chord makes visible progress. */
export function structuralScopes(
  editor: HTMLElement,
  range: Range,
): StructuralScope[] {
  if (
    !editor.contains(range.startContainer) ||
    !editor.contains(range.endContainer)
  )
    return []
  const start = elementAt(range.startContainer)
  if (!start) return []
  const scopes: StructuralScope[] = []
  const inline = start.closest<HTMLElement>(
    '.vditor-ir__node:not([data-block])',
  )
  if (inline && editor.contains(inline)) {
    const inlineRange = inlineContentRange(inline)
    if (inlineRange)
      scopes.push({ kind: 'inline', element: inline, range: inlineRange })
  }
  const cell = start.closest<HTMLElement>('td, th')
  if (cell && editor.contains(cell))
    scopes.push({ kind: 'cell', element: cell, range: contentsRange(cell) })
  const block = structuralBlock(range.startContainer, cell)
  if (block && editor.contains(block))
    scopes.push({ kind: 'block', element: block, range: blockRange(block) })
  scopes.push({
    kind: 'document',
    element: editor,
    range: contentsRange(editor),
  })
  return scopes.filter(
    (scope, index) =>
      !scopes
        .slice(0, index)
        .some((earlier) => rangesEqual(earlier.range, scope.range)),
  )
}

function applySelection(
  win: Window & typeof globalThis,
  range: Range,
): boolean {
  const selection = win.getSelection()
  if (!selection) return false
  const editor = activeModeElement(win.vditor)
  if (editor && !editor.contains(win.document.activeElement))
    editor.focus({ preventScroll: true })
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

function currentIrSelection(
  win: Window & typeof globalThis,
): { editor: HTMLElement; range: Range } | null {
  if (innerVditor()?.currentMode !== 'ir') return null
  const editor = activeModeElement(win.vditor)
  const selection = win.getSelection()
  if (!editor || !selection?.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (
    !editor.contains(range.startContainer) ||
    !editor.contains(range.endContainer)
  )
    return null
  return { editor, range }
}

function fenceSourceRange(range: Range): Range | null {
  const start = elementAt(range.startContainer)
  const block = start?.closest<HTMLElement>('[data-type="code-block"]')
  const code = block?.querySelector<HTMLElement>(
    ':scope > .vditor-ir__marker--pre > code',
  )
  return code?.contains(range.startContainer) ? contentsRange(code) : null
}

function selectNextScope(
  win: Window & typeof globalThis,
  scopes: readonly StructuralScope[],
  current: Range,
): boolean {
  const next = scopes.find((scope) => !rangesEqual(scope.range, current))
  return next ? applySelection(win, next.range) : false
}

function handleSelectAll(win: Window & typeof globalThis): boolean {
  const current = currentIrSelection(win)
  if (!current) return false
  const fence = fenceSourceRange(current.range)
  // Preserve Vditor's PRE stage-0 semantics but own the selection in capture: its bubble handler is
  // nondeterministic from a programmatic caret in Chromium (Task 191 recorded the same empty-range
  // outcome). The next captured chord widens to its Markdown block, then the document.
  if (fence && !rangesEqual(fence, current.range))
    return applySelection(win, fence)
  const scopes = structuralScopes(current.editor, current.range).filter(
    (scope) => scope.kind === 'block' || scope.kind === 'document',
  )
  return selectNextScope(win, scopes, current.range)
}

function handleScopeSelect(win: Window & typeof globalThis): boolean {
  const current = currentIrSelection(win)
  if (!current) return false
  return selectNextScope(
    win,
    structuralScopes(current.editor, current.range),
    current.range,
  )
}

function handleEscape(win: Window & typeof globalThis): boolean {
  const current = currentIrSelection(win)
  if (!current) return false
  const start = elementAt(current.range.startContainer)
  const expanded = start?.closest<HTMLElement>(
    '.vditor-ir__node--expand:not([data-block])',
  )
  if (expanded && current.editor.contains(expanded)) {
    const parent = expanded.parentNode
    const index = parent ? Array.from(parent.childNodes).indexOf(expanded) : -1
    if (parent && index >= 0) {
      requestCaret({ node: parent, offset: index + 1 })
      invalidateCaret()
    }
    expanded.classList.remove('vditor-ir__node--expand')
    return true
  }
  const block = structuralScopes(current.editor, current.range).find(
    (scope) => scope.kind === 'block',
  )
  if (block && !rangesEqual(block.range, current.range))
    return applySelection(win, block.range)
  // There is no structural-selection blur setting. Preserve Task 456's established Escape→Tab
  // route to the toolbar instead of inventing a third-stage option or leaking Escape to VS Code.
  return Boolean(block)
}

function consumeStructuralKey(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopImmediatePropagation()
}

type StructuralKeyAction = 'select-all' | 'select-scope' | 'escape'

function structuralKeyAction(event: KeyboardEvent): StructuralKeyAction | null {
  if (guardComposition(event) || event.altKey || event.shiftKey) return null
  const mod = event.ctrlKey || event.metaKey
  const key = event.key.toLowerCase()
  if (mod && key === 'a') return 'select-all'
  if (mod && key === 'e') return 'select-scope'
  return !mod && event.key === 'Escape' ? 'escape' : null
}

function findWidgetOwnsStructuralKey(
  win: Window & typeof globalThis,
  event: KeyboardEvent,
  action: StructuralKeyAction | null,
): boolean {
  if (!action) return false
  const widget = win.document.querySelector<HTMLElement>('.vmde-find-replace')
  // The editor keeps its Range after Find takes focus. Yield widget keys to its local handler,
  // and yield Escape from the editor to the visible Find widget's host command.
  return Boolean(
    widget &&
      !widget.hidden &&
      (action === 'escape' ||
        (event.target instanceof win.Node && widget.contains(event.target))),
  )
}

/** Install IR-only structural selection. Ctrl+D and Ctrl+L deliberately remain Vditor's promoted
 * strike/list shortcuts; this task predates those shipped bindings and must not steal them. */
export function installStructuralSelection(
  win: Window & typeof globalThis = window,
): () => void {
  const onKeydown = (event: KeyboardEvent): void => {
    const action = structuralKeyAction(event)
    if (findWidgetOwnsStructuralKey(win, event, action)) return
    if (action === 'select-all') {
      if (handleSelectAll(win)) consumeStructuralKey(event)
      return
    }
    if (action === 'select-scope') {
      if (handleScopeSelect(win)) consumeStructuralKey(event)
      return
    }
    if (action === 'escape' && handleEscape(win)) consumeStructuralKey(event)
  }
  const onClick = (event: MouseEvent): void => {
    if (event.detail !== 3 || !(event.target instanceof win.Node)) return
    const current = currentIrSelection(win)
    if (!current?.editor.contains(event.target)) return
    const block = structuralBlock(
      event.target,
      elementAt(event.target)?.closest('td, th') ?? null,
    )
    if (block && current.editor.contains(block))
      applySelection(win, blockRange(block))
  }
  win.document.addEventListener('keydown', onKeydown, true)
  win.document.addEventListener('click', onClick, true)
  return () => {
    win.document.removeEventListener('keydown', onKeydown, true)
    win.document.removeEventListener('click', onClick, true)
  }
}

interface FindReplaceDeps {
  setApplying(applying: boolean): void
  postExact(markdown: string): void
  onError(error: unknown): void
  reportState(visible: boolean): void
}

type FindWidgetMode = Extract<
  HostMessage,
  { command: 'open-find-replace' }
>['mode']

let findReplaceDeps: FindReplaceDeps | undefined
let openInstalledFindReplace: ((mode: FindWidgetMode) => void) | undefined
let installedFindWidgetAction: ((action: FindWidgetAction) => void) | undefined
let pendingFindReplaceOpen: FindWidgetMode | undefined

export function configureFindReplaceActions(deps: FindReplaceDeps): void {
  findReplaceDeps = deps
}

export function openFindReplace(mode: FindWidgetMode = 'replace'): void {
  if (openInstalledFindReplace) openInstalledFindReplace(mode)
  else pendingFindReplaceOpen = mode
}

export function runFindWidgetAction(action: FindWidgetAction): void {
  installedFindWidgetAction?.(action)
}

const FIND_CARET_BASE = '\uE410VMDE_FIND_CARET'

function uniqueFindCaret(markdown: string): string {
  let counter = 0
  for (;;) {
    const marker = `${FIND_CARET_BASE}_${counter}\uE41F`
    if (!markdown.includes(marker)) return marker
    counter++
  }
}

function removeFindCaret(editor: HTMLElement, marker: string): number | null {
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

/** EditSync's exact bytes and Vditor's rendered serialization at action time. */
interface FindSnapshot {
  exact: string
  rendered: string
}

/** Task 196: one exact transaction. The plan was made on the exact bytes; the editor re-renders
 * once between two undo checkpoints, the exact before/after pair is recorded so Undo and Redo post
 * exact bytes (vditor-init's input hook), and the host receives the exact result. */
function applyFindReplaceResult(
  result: MarkdownReplaceResult,
  before: FindSnapshot,
): boolean {
  const deps = findReplaceDeps
  const outer = window.vditor
  const inner = innerVditor()
  const editor = outer ? activeModeElement(outer) : null
  const mode = inner?.currentMode
  if (!deps || !outer || !inner || !editor || !mode || !result.changed)
    return false
  const marker = uniqueFindCaret(result.markdown)
  const marked =
    result.markdown.slice(0, result.caretOffset) +
    marker +
    result.markdown.slice(result.caretOffset)
  const scrollTop = findScroller(editor).scrollTop
  // Undo matches this history against `getValue()` (vditor-init's input hook). EditSync's SV host
  // serialization differs from it (trailing newline span, NBSP), so read SV's own value; in IR and
  // WYSIWYG the snapshot's rendered text is that value already.
  const beforeRendered = mode === 'sv' ? outer.getValue() : before.rendered
  let nativeState: unknown
  let afterRendered = ''
  deps.setApplying(true)
  try {
    checkpointEditorUndo(inner)
    outer.setValue(marked)
    const fresh = activeModeElement(outer)
    const caret = fresh ? removeFindCaret(fresh, marker) : null
    if (!fresh || caret === null) {
      // No second attempt: restore the exact bytes the plan was made from.
      outer.setValue(before.exact)
      return false
    }
    checkpointEditorUndo(inner)
    nativeState = (
      inner.undo as { [key: string]: { undoStack?: unknown[] } } | undefined
    )?.[mode]?.undoStack?.at(-1)
    afterRendered = outer.getValue()
    const scroller = findScroller(fresh)
    scroller.scrollTop = Math.min(
      scrollTop,
      Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    )
    fresh.focus({ preventScroll: true })
    requestAnimationFrame(() => requestCaret({ textOffset: caret }))
  } catch (error) {
    deps.onError(error)
    return false
  } finally {
    deps.setApplying(false)
  }
  if (nativeState)
    recordRewrapDocumentHistory({
      owner: inner,
      mode,
      nativeState,
      beforeRendered,
      beforeExact: before.exact,
      afterRendered,
      afterExact: result.markdown,
    })
  deps.postExact(result.markdown)
  return true
}

interface FindReplaceElements {
  root: HTMLElement
  find: HTMLInputElement
  replace: HTMLInputElement
  replaceRow: HTMLElement
  toggleReplace: HTMLButtonElement
  status: HTMLElement
  caseButton: HTMLButtonElement
  wordButton: HTMLButtonElement
  overlay: HTMLElement
}

function localFindKeyAction(
  event: KeyboardEvent,
  elements: FindReplaceElements,
): FindWidgetAction | null {
  const plain = !event.ctrlKey && !event.altKey && !event.metaKey
  if (event.key === 'Escape') return plain ? 'close' : null
  if (event.key !== 'Enter') return null
  if (event.target === elements.find && plain)
    return event.shiftKey ? 'previous' : 'next'
  if (event.target !== elements.replace || event.shiftKey) return null
  if (plain) return 'replace-one'
  // Cmd+Enter is input-local on macOS and otherwise collides with Activate Link at Caret.
  // Ctrl/Alt-modified Enter belongs to the workbench's rebindable Replace All command.
  return isMac() && event.metaKey && !event.ctrlKey && !event.altKey
    ? 'replace-all'
    : null
}

function createFindReplaceElements(doc: Document): FindReplaceElements {
  const mac = isMac()
  const labels = {
    case: `Match Case (${mac ? 'Alt+Cmd+C' : 'Alt+C'})`,
    word: `Match Whole Word (${mac ? 'Alt+Cmd+W' : 'Alt+W'})`,
    previous: `Previous Match (${mac ? 'Shift+Cmd+G' : 'Shift+Enter'})`,
    next: `Next Match (${mac ? 'Cmd+G' : 'Enter'})`,
    replace: `Replace (${mac ? 'Shift+Cmd+1' : 'Enter'})`,
    replaceAll: `Replace All (${mac ? 'Alt+Cmd+Enter' : 'Ctrl+Alt+Enter'})`,
  }
  const root = doc.createElement('div')
  root.className = 'vmde-find-replace'
  root.hidden = true
  root.setAttribute('aria-hidden', 'true')
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'Find and replace')
  root.dataset.vmdeOverlay = '1'
  root.innerHTML = `
    <button class="vmde-find-replace__toggle" type="button" data-action="toggle-replace" aria-label="Toggle Replace" aria-expanded="false" aria-controls="vmde-find-replace-row">
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m6 3 5 5-5 5" /></svg>
    </button>
    <div class="vmde-find-replace__row">
      <div class="vmde-find-replace__input-wrap">
        <input type="text" data-find aria-label="Find" placeholder="Find" />
        <div class="vmde-find-replace__options">
          <button type="button" data-action="case" role="checkbox" aria-label="${labels.case}" aria-checked="false">Aa</button>
          <button type="button" data-action="word" role="checkbox" aria-label="${labels.word}" aria-checked="false"><span>ab</span></button>
        </div>
      </div>
      <span data-status role="status" aria-live="polite" data-no-results="true">No results</span>
      <div class="vmde-find-replace__controls vmde-find-replace__controls--find">
        <button type="button" data-action="previous" aria-label="${labels.previous}"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 13V3m0 0L4 7m4-4 4 4" /></svg></button>
        <button type="button" data-action="next" aria-label="${labels.next}"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 3v10m0 0 4-4m-4 4L4 9" /></svg></button>
        <button type="button" data-action="close" aria-label="Close (Escape)"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m3 3 10 10M13 3 3 13" /></svg></button>
      </div>
    </div>
    <div class="vmde-find-replace__row" id="vmde-find-replace-row" hidden>
      <div class="vmde-find-replace__input-wrap">
        <input type="text" data-replace aria-label="Replace" placeholder="Replace" />
      </div>
      <div class="vmde-find-replace__controls">
        <button type="button" data-action="replace" aria-label="${labels.replace}"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 4h10m0 0L9 1m3 3L9 7M4 12h10m-10 0 3-3m-3 3 3 3" /></svg></button>
        <button type="button" data-action="replace-all" aria-label="${labels.replaceAll}"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 3h10m0 0L9 1m3 2L9 5M2 8h10m0 0-3-2m3 2-3 2M2 13h10m0 0-3-2m3 2-3 2" /></svg></button>
      </div>
    </div>`
  const overlay = doc.createElement('div')
  overlay.className = 'vmde-find-overlays'
  overlay.setAttribute('aria-hidden', 'true')
  doc.body.append(overlay, root)
  return {
    root,
    find: root.querySelector('[data-find]') as HTMLInputElement,
    replace: root.querySelector('[data-replace]') as HTMLInputElement,
    replaceRow: root.querySelector('#vmde-find-replace-row') as HTMLElement,
    toggleReplace: root.querySelector(
      '[data-action="toggle-replace"]',
    ) as HTMLButtonElement,
    status: root.querySelector('[data-status]') as HTMLElement,
    caseButton: root.querySelector('[data-action="case"]') as HTMLButtonElement,
    wordButton: root.querySelector('[data-action="word"]') as HTMLButtonElement,
    overlay,
  }
}

// Task 196 rework: at most this many highlight fragments are painted per frame; the current match
// is always painted first. Matches beyond it keep their count and navigation.
const MAX_PAINTED_FRAGMENTS = 400
// Content-visibility can keep a current match at its intrinsic-size placeholder for multiple
// frames after a theme flip. Bound the retries even when that block never lays out.
const OVERLAY_SETTLE_ATTEMPTS = 3
// Quiet period after the last edit before Find recomputes its matches (coalesces typing; the
// recompute itself is bounded by the per-revision index build, not by this delay).
const FIND_REFRESH_QUIET_MS = 150
// Scroll corrections while off-screen blocks render at their real height during a reveal.
const REVEAL_PASSES = 4
// A line box can briefly be in view while its content-visibility ancestor still has placeholder
// height. Wait only a few rendering updates for that block to lay out before accepting the box.
const REVEAL_LAYOUT_WAITS = 4

function rectInVisibleBox(
  rect: DOMRect | undefined,
  box: VisibleBox | undefined,
): boolean {
  return Boolean(
    rect && box && rect.top >= box.top && rect.bottom <= box.bottom,
  )
}

/** The range's visible, de-duplicated line boxes (at most `budget`). Nested inline elements can
 * report the same box twice; one highlight per box keeps the fill from stacking. */
function paintableRects(
  range: Range,
  box: VisibleBox,
  budget: number,
): { rects: DOMRect[]; laidOut: boolean } {
  const seen = new Set<string>()
  const out: DOMRect[] = []
  let laidOut = false
  for (const rect of range.getClientRects()) {
    if (out.length >= budget) break
    if (rect.width <= 0 || rect.height <= 0) continue
    laidOut = true
    if (rect.bottom <= box.top || rect.top >= box.bottom) continue
    const key = [rect.left, rect.top, rect.width, rect.height]
      .map((value) => value.toFixed(2))
      .join(':')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(rect)
  }
  return { rects: out, laidOut }
}

/** The box of the nearest ancestor that has one (a `content-visibility: auto` block keeps its
 * intrinsic size while its contents are skipped). */
function laidOutAncestorRect(range: Range): DOMRect | null {
  for (
    let node: Node | null = range.startContainer;
    node;
    node = node.parentNode
  ) {
    if (!(node instanceof Element)) continue
    const rect = node.getBoundingClientRect()
    if (rect.width > 0 || rect.height > 0) return rect
  }
  return null
}

function rangeContentSkipped(range: Range): boolean {
  const start = range.startContainer
  const element = start instanceof Element ? start : start.parentElement
  return (
    typeof element?.checkVisibility === 'function' &&
    !element.checkVisibility({ contentVisibilityAuto: true })
  )
}

/** What Find reads the exact source from (finish-init passes the shared index and EditSync). */
export interface FindReplaceSourceDeps {
  index?: SourceBlockIndexHandle
  snapshotPair?(): { exact: string; rendered: string }
  snapshotRevision?(): object | undefined
}

// Rendered math/diagrams, IR markers and helper chrome do not represent literal source search
// text. Seeding is deliberately conservative there and never serializes or mutates the selection.
const UNSEARCHABLE_SELECTION =
  '.vditor-ir__marker, .vditor-ir__preview, .vditor-wysiwyg__preview, [data-render], .vditor-copy, svg, math, textarea, [contenteditable="false"]'
const FIND_SELECTION_BLOCK = 'p, div, li, td, th, pre, h1, h2, h3, h4, h5, h6'

function findCaretTextPoint(
  range: Range,
): { node: Text; offset: number } | null {
  let node = range.startContainer
  if (node.nodeType === Node.TEXT_NODE)
    return { node: node as Text, offset: range.startOffset }
  // A browser can leave a caret on the containing element at a word's edge. Resolve only the
  // adjacent child's edge, without moving the live range or walking through renderer/marker DOM.
  const atEnd = range.startOffset === node.childNodes.length
  let child = node.childNodes[range.startOffset - (atEnd ? 1 : 0)]
  while (child) {
    node = child
    if (elementAt(node)?.closest(UNSEARCHABLE_SELECTION)) return null
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text
      return { node: text, offset: atEnd ? text.data.length : 0 }
    }
    child = (atEnd ? node.lastChild : node.firstChild) ?? undefined
  }
  return null
}

function findSeedAtCaret(range: Range): string | null {
  const point = findCaretTextPoint(range)
  if (!point) return null
  let { node, offset } = point
  // Vditor splits words into adjacent text nodes at the caret. Read across those siblings only;
  // crossing an element could join a word to an IR Markdown marker.
  for (
    let previous = prevTextNode(node);
    previous;
    previous = prevTextNode(node)
  ) {
    node = previous
    offset += node.data.length
  }
  let text = node.data
  for (let next = nextTextNode(node); next; next = nextTextNode(node)) {
    node = next
    text += node.data
  }
  for (const match of text.matchAll(/[\p{L}\p{N}\p{M}_]+/gu)) {
    if (match.index <= offset && offset <= match.index + match[0].length)
      return match[0]
  }
  return null
}

function findSelectionSeed(doc: Document): string | null {
  const editor = activeModeElement(window.vditor)
  const selection = doc.getSelection()
  if (!editor || !selection?.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (
    !editor.contains(range.startContainer) ||
    !editor.contains(range.endContainer)
  )
    return null
  const start = elementAt(range.startContainer)
  const end = elementAt(range.endContainer)
  if (
    start?.closest(UNSEARCHABLE_SELECTION) ||
    end?.closest(UNSEARCHABLE_SELECTION)
  )
    return null
  const text = selection.toString()
  if (!text) return findSeedAtCaret(range)
  if (/[\r\n]/.test(text)) return null
  // Range text omits block and BR separators (notably in DOM unit tests). Treat those selections
  // as multiline too, instead of accidentally concatenating two authored lines into one query.
  if (
    start?.closest(FIND_SELECTION_BLOCK) !== end?.closest(FIND_SELECTION_BLOCK)
  )
    return null
  const fragment = range.cloneContents()
  if (fragment.querySelector(`br, ${UNSEARCHABLE_SELECTION}`)) return null
  if (fragment.querySelectorAll(FIND_SELECTION_BLOCK).length > 1) return null
  return text
}

/** Install the custom source-accurate find/replace widget. UI and overlay rectangles live outside
 * Vditor's editable DOM, so they cannot serialize or disturb Lute's marker structure. */
export function installFindReplace(
  doc: Document = document,
  sourceDeps: FindReplaceSourceDeps = {},
): () => void {
  const elements = createFindReplaceElements(doc)
  const toolbar = doc.querySelector<HTMLElement>('.vditor-toolbar')
  const contentBox = doc.querySelector<HTMLElement>('.vditor-content')
  // The pinned toolbar may have one or two rows, collapse to a 5px hover strip, or be an empty
  // shell when showToolbar is off. Measure its visible bottom instead of assuming a fixed height.
  const syncWidgetPosition = () => {
    const liveToolbar = doc.querySelector<HTMLElement>('.vditor-toolbar')
    const visible =
      liveToolbar?.querySelector('.vditor-toolbar__item') &&
      liveToolbar.getClientRects().length > 0 &&
      doc.defaultView?.getComputedStyle(liveToolbar).visibility !== 'hidden'
    const bottom = visible
      ? Math.max(0, liveToolbar.getBoundingClientRect().bottom)
      : 0
    const value = `${bottom}px`
    if (
      elements.root.style.getPropertyValue('--vmde-find-toolbar-bottom') !==
      value
    )
      elements.root.style.setProperty('--vmde-find-toolbar-bottom', value)
  }
  const tracker = createFindSourceTracker({
    index: sourceDeps.index,
    mode: () => window.vditor?.vditor?.currentMode,
    root: () => activeModeElement(window.vditor),
    snapshotPair:
      sourceDeps.snapshotPair ??
      (() => {
        const rendered = window.vditor?.getValue?.() ?? ''
        return { exact: rendered, rendered }
      }),
    snapshotRevision: sourceDeps.snapshotRevision ?? (() => undefined),
  })
  let result: FindResult | null = null
  let current = 0
  let frame = 0
  let settleFrame = 0
  let settleTimer = 0
  let refreshTimer = 0
  let refreshFrame = 0
  let mode: FindWidgetMode = 'find'

  const setMode = (next: FindWidgetMode) => {
    mode = next
    elements.replaceRow.hidden = mode === 'find'
    elements.toggleReplace.setAttribute(
      'aria-expanded',
      String(mode === 'replace'),
    )
  }

  const options = (): MarkdownFindOptions => ({
    caseSensitive: elements.caseButton.getAttribute('aria-checked') === 'true',
    wholeWord: elements.wordButton.getAttribute('aria-checked') === 'true',
  })
  const matchCount = () => result?.matches.length ?? 0
  // Without revision authority a result can never be proven current; it is painted as computed
  // and replaced by the next explicit refresh instead of triggering its own.
  let resultCacheable = false
  const liveMapper = () =>
    result && (!resultCacheable || tracker.isCurrent(result))
      ? findMapperFor(result.source)
      : null

  // The editor's own scroller bounds what is visible (the webview body in VS Code, an inner
  // container in narrower hosts); overlays are fixed-position, so clip them to it.
  const visibleBox = (): { scroller: HTMLElement; box: VisibleBox } | null => {
    const editor = activeModeElement(window.vditor)
    if (!editor) return null
    const scroller = findScroller(editor)
    if (
      scroller === doc.scrollingElement ||
      scroller === doc.documentElement ||
      scroller === doc.body
    )
      return { scroller, box: { top: 0, bottom: window.innerHeight } }
    const rect = scroller.getBoundingClientRect()
    return {
      scroller,
      box: {
        top: Math.max(0, rect.top),
        bottom: Math.min(window.innerHeight, rect.bottom),
      },
    }
  }

  const paintRange = (
    range: Range,
    isCurrent: boolean,
    box: VisibleBox,
    budget: number,
  ) => {
    const { rects, laidOut } = paintableRects(range, box, budget)
    for (const rect of rects) {
      const highlight = doc.createElement('div')
      highlight.className = 'vmde-find-overlay'
      if (isCurrent) highlight.classList.add('vmde-find-overlay--current')
      highlight.style.left = `${rect.left}px`
      highlight.style.top = `${rect.top}px`
      highlight.style.width = `${rect.width}px`
      highlight.style.height = `${rect.height}px`
      elements.overlay.append(highlight)
    }
    return { painted: rects.length, laidOut }
  }

  /** Paints the visible matches; returns how many had no line boxes yet (a skipped
   * `content-visibility` block that is only now entering the viewport). */
  const paintVisible = (
    mapper: FindMapper,
    matches: readonly MarkdownMatch[],
    box: VisibleBox,
    budget: number,
  ) => {
    let unpainted = 0
    // One screen of margin keeps a short scroll from exposing unpainted matches.
    for (const index of mapper.visible(matches, box, box.bottom - box.top)) {
      if (budget <= 0) break
      if (index === current) continue
      const range = mapper.range(matches[index])
      if (!range) continue
      const painted = paintRange(range, false, box, budget)
      if (!painted.laidOut) unpainted++
      budget -= painted.painted
    }
    return unpainted
  }

  // Paints the current match and the matches in or near the viewport only. Mapping work is
  // memoized per source, so scroll and resize frames never serialize or clone the editor.
  const cancelSettle = () => {
    if (settleFrame) cancelAnimationFrame(settleFrame)
    if (settleTimer) window.clearTimeout(settleTimer)
    settleFrame = 0
    settleTimer = 0
  }
  const scheduleSettle = (attempt: number) => {
    // Give a skipped content-visibility block a rendering update, then a task for the browser
    // to replace its placeholder line boxes before measuring the same cached match map again.
    settleFrame = requestAnimationFrame(() => {
      settleFrame = 0
      if (elements.root.hidden) return
      settleTimer = window.setTimeout(() => {
        settleTimer = 0
        if (!elements.root.hidden) renderOverlays(attempt)
      })
    })
  }
  const paintMatches = (
    mapper: FindMapper,
    matches: readonly MarkdownMatch[],
    box: VisibleBox,
  ) => {
    const currentRange = matches[current]
      ? mapper.range(matches[current])
      : null
    const currentPaint = currentRange
      ? paintRange(currentRange, true, box, MAX_PAINTED_FRAGMENTS)
      : null
    const budget = MAX_PAINTED_FRAGMENTS - (currentPaint?.painted ?? 0)
    const unpainted =
      paintVisible(mapper, matches, box, budget) +
      Number(Boolean(currentPaint && !currentPaint.laidOut))
    return { currentRange, unpainted }
  }
  const renderOverlays = (attempt = 0) => {
    frame = 0
    elements.overlay.replaceChildren()
    // A result from an older source (an edit, mode switch or rebuilt DOM) is never painted.
    if (result && resultCacheable && !tracker.isCurrent(result))
      scheduleRefresh()
    const mapper = liveMapper()
    const view = visibleBox()
    if (elements.root.hidden || !result || !mapper || !view || !matchCount())
      return
    const { currentRange, unpainted } = paintMatches(
      mapper,
      result.matches,
      view.box,
    )
    elements.status.title = currentRange
      ? ''
      : 'The current match is in source that is not visible in this editor mode.'
    if (unpainted && attempt < OVERLAY_SETTLE_ATTEMPTS)
      scheduleSettle(attempt + 1)
  }

  const scheduleOverlays = () => {
    cancelSettle()
    if (!frame) frame = requestAnimationFrame(() => renderOverlays())
  }

  // The overlays use viewport coordinates. Hiding the toolbar or resizing an editor pane moves
  // their source ranges without a scroll event; observe those stable boxes and repaint from the
  // cached match map on one frame, without re-reading source or rebuilding the index.
  const layoutResize =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          syncWidgetPosition()
          if (!elements.root.hidden) scheduleOverlays()
        })
      : undefined
  if (toolbar) layoutResize?.observe(toolbar)
  if (contentBox) layoutResize?.observe(contentBox)
  // Theme switches replace stylesheet links. Their load/error can move text line boxes without
  // changing the editor DOM or the boxes observed above, so repaint from the cached match map.
  const onStylesheetSettled = (event: Event) => {
    if (elements.root.hidden) return
    const target = event.target
    if (target instanceof HTMLLinkElement && target.rel === 'stylesheet')
      scheduleOverlays()
  }
  doc.addEventListener('load', onStylesheetSettled, true)
  doc.addEventListener('error', onStylesheetSettled, true)
  // A skipped block may acquire real line boxes without changing its DOM or a stylesheet link.
  const onContentVisibilityChange = () => {
    if (!elements.root.hidden) scheduleOverlays()
  }
  doc.addEventListener(
    'contentvisibilityautostatechange',
    onContentVisibilityChange,
    true,
  )

  // Task 196: an edit, mutation or mode switch while Find is open hides the now-stale highlights at
  // once and recomputes once typing pauses, at most once per frame. Each recompute is one index
  // build for the new source revision; keystrokes in between cost nothing.
  const scheduleRefresh = () => {
    if (elements.root.hidden) return
    elements.overlay.replaceChildren()
    if (refreshTimer) window.clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0
      if (!refreshFrame)
        refreshFrame = requestAnimationFrame(() => {
          refreshFrame = 0
          if (!elements.root.hidden) refresh(false)
        })
    }, FIND_REFRESH_QUIET_MS)
  }

  // Centre the current match in the editor's scroller (the window only when it is the scroller).
  // Large documents skip rendering off-screen blocks (`content-visibility: auto`): scrolling makes
  // the blocks in between render at their real height, which moves the target. After each scroll
  // (on the task after the next rendering update) re-measure and correct, until the match's own
  // line box is inside the visible box, at most REVEAL_PASSES times; then paint.
  let revealToken = 0
  const revealCurrent = (pass = 0, token = ++revealToken, waits = 0) => {
    if (token !== revealToken) return
    const match = result?.matches[current]
    const range = match ? liveMapper()?.range(match) : null
    const view = visibleBox()
    // Skipped content-visibility ranges can start with a zero-area rectangle at the origin.
    // Treating it as an on-screen line stops reveal while every paintable fragment is offscreen.
    // Use the same positive-area test as painting, or reveal the laid-out ancestor placeholder.
    const exact = Array.from(range?.getClientRects() ?? []).find(
      (rect) => rect.width > 0 && rect.height > 0,
    )
    const target = exact ?? (range ? laidOutAncestorRect(range) : null)
    const inBox = rectInVisibleBox(exact, view?.box)
    // Content-visibility may move an apparently visible line after its placeholder is replaced.
    // Keep repainting and re-measuring across bounded rendering updates without using a scroll pass.
    if (
      inBox &&
      range &&
      waits < REVEAL_LAYOUT_WAITS &&
      rangeContentSkipped(range)
    ) {
      scheduleOverlays()
      requestAnimationFrame(() =>
        window.setTimeout(() => revealCurrent(pass, token, waits + 1)),
      )
      return
    }
    const settled = !target || !view || inBox
    if (settled || pass >= REVEAL_PASSES) {
      scheduleOverlays()
      return
    }
    view.scroller.scrollBy({
      top: target.top - (view.box.top + view.box.bottom) / 2,
      behavior: 'instant',
    })
    requestAnimationFrame(() =>
      window.setTimeout(() => revealCurrent(pass + 1, token, waits)),
    )
  }

  const renderStatus = () => {
    const count = matchCount()
    elements.status.textContent =
      count === 0 ? 'No results' : `${current + 1} of ${count}`
    elements.status.dataset.noResults = String(count === 0)
  }

  const refresh = (resetCurrent = false) => {
    result = tracker.find(elements.find.value, options())
    resultCacheable = tracker.isCurrent(result)
    const count = matchCount()
    if (resetCurrent) current = 0
    else current = Math.min(current, Math.max(0, count - 1))
    renderStatus()
    revealCurrent()
  }

  const move = (delta: 1 | -1) => {
    const count = matchCount()
    if (count === 0) return
    current = (current + delta + count) % count
    renderStatus()
    const range = liveMapper()?.range(result!.matches[current])
    if (range) {
      const focused = doc.activeElement as HTMLElement | null
      requestCaret({
        anchor: { node: range.startContainer, offset: range.startOffset },
        focus: { node: range.endContainer, offset: range.endOffset },
      })
      // Navigation selects the editor match once; a caret retry must not steal input focus.
      invalidateCaret()
      if (focused && elements.root.contains(focused))
        focused.focus({ preventScroll: true })
    }
    revealCurrent()
  }

  const snapshot = (): FindSnapshot => {
    if (sourceDeps.snapshotPair) return sourceDeps.snapshotPair()
    const rendered = window.vditor?.getValue?.() ?? ''
    return { exact: rendered, rendered }
  }
  // Replace acts on the exact bytes at action time, and only while they are the bytes the shown
  // matches came from; otherwise it refreshes the matches instead of guessing offsets.
  const actionPlan = () => {
    const before = snapshot()
    if (!result || result.source.exact !== before.exact) {
      refresh(false)
      return null
    }
    return { before, matches: result.matches }
  }

  const afterReplacement = (focused: Element | null, resetCurrent: boolean) => {
    if (!(focused instanceof HTMLElement) || !elements.root.contains(focused)) {
      requestAnimationFrame(() => refresh(resetCurrent))
      return
    }
    focused.focus({ preventScroll: true })
    // The exact transaction schedules its editor caret first. Restore widget focus after that
    // placement, stopping its retries, but respect a close or a subsequent user focus change.
    requestAnimationFrame(() => {
      if (elements.root.hidden) return
      if (
        doc.activeElement === focused ||
        doc.activeElement === activeModeElement(window.vditor)
      ) {
        invalidateCaret()
        focused.focus({ preventScroll: true })
      }
      refresh(resetCurrent)
    })
  }

  const replaceCurrent = () => {
    if (elements.root.hidden || mode !== 'replace') return
    const focused = doc.activeElement
    const plan = actionPlan()
    const match = plan?.matches[current]
    if (!plan || !match) return
    if (
      applyFindReplaceResult(
        replaceMarkdownMatch(plan.before.exact, match, elements.replace.value),
        plan.before,
      )
    )
      afterReplacement(focused, false)
  }

  const replaceAll = () => {
    if (elements.root.hidden || mode !== 'replace') return
    const focused = doc.activeElement
    const plan = actionPlan()
    if (!plan) return
    if (
      applyFindReplaceResult(
        replaceAllMarkdownMatches(
          plan.before.exact,
          plan.matches,
          elements.replace.value,
        ),
        plan.before,
      )
    )
      afterReplacement(focused, true)
  }

  const close = () => {
    cancelSettle()
    elements.root.hidden = true
    elements.root.setAttribute('aria-hidden', 'true')
    result = null
    elements.overlay.replaceChildren()
    activeModeElement(window.vditor)?.focus({ preventScroll: true })
    findReplaceDeps?.reportState(false)
  }

  const open = (requestedMode: FindWidgetMode) => {
    syncWidgetPosition()
    let focus = elements.find
    if (elements.root.hidden) {
      const seed = findSelectionSeed(doc)
      // A rendered phrase may omit Markdown delimiters. Only seed a literal source substring;
      // preserve the previous query when the visible text cannot sensibly search the exact bytes.
      if (seed && tracker.source(true)?.exact.includes(seed))
        elements.find.value = seed
      setMode(requestedMode)
      elements.root.hidden = false
      elements.root.setAttribute('aria-hidden', 'false')
      refresh(true)
      findReplaceDeps?.reportState(true)
    } else if (requestedMode === 'replace') {
      if (doc.activeElement === elements.find) focus = elements.replace
      setMode('replace')
    }
    // An Undo checkpoint can arm a caret retry after the opening keydown. Retire that editor
    // intent before handing focus to Find, or its next selection write steals focus back.
    invalidateCaret()
    focus.focus()
    focus.select()
  }
  openInstalledFindReplace = open
  if (pendingFindReplaceOpen) {
    const pendingMode = pendingFindReplaceOpen
    pendingFindReplaceOpen = undefined
    open(pendingMode)
  }

  const toggleOption = (button: HTMLButtonElement) => {
    button.setAttribute(
      'aria-checked',
      button.getAttribute('aria-checked') === 'true' ? 'false' : 'true',
    )
    refresh(true)
  }

  const runAction = (action: FindWidgetAction) => {
    if (elements.root.hidden) return
    switch (action) {
      case 'next':
        move(1)
        break
      case 'previous':
        move(-1)
        break
      case 'toggle-case':
        toggleOption(elements.caseButton)
        break
      case 'toggle-whole-word':
        toggleOption(elements.wordButton)
        break
      case 'replace-one':
        replaceCurrent()
        break
      case 'replace-all':
        replaceAll()
        break
      case 'close':
        close()
        break
    }
  }
  installedFindWidgetAction = runAction

  const onClick = (event: MouseEvent) => {
    if (elements.root.hidden) return
    const action = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-action]',
    )?.dataset.action
    switch (action) {
      case 'previous':
        runAction('previous')
        break
      case 'next':
        runAction('next')
        break
      case 'replace':
        runAction('replace-one')
        break
      case 'replace-all':
        runAction('replace-all')
        break
      case 'close':
        runAction('close')
        break
      case 'case':
        runAction('toggle-case')
        break
      case 'word':
        runAction('toggle-whole-word')
        break
      case 'toggle-replace':
        setMode(mode === 'find' ? 'replace' : 'find')
        elements.toggleReplace.focus()
        break
    }
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (elements.root.hidden || guardComposition(event)) return
    const action = localFindKeyAction(event, elements)
    if (!action) return
    event.preventDefault()
    // VS Code forwards keydown at window; preventDefault alone still dispatches a host command.
    event.stopPropagation()
    runAction(action)
  }
  const onFindInput = () => refresh(true)
  const onEditorInput = (event: Event) => {
    if (!elements.root.contains(event.target as Node)) scheduleRefresh()
  }
  // A click never recomputes Find; it only notices a finished mode switch (a string compare).
  const onDocumentClick = (event: MouseEvent) => {
    if (
      !elements.root.hidden &&
      result &&
      !elements.root.contains(event.target as Node)
    )
      requestAnimationFrame(() => {
        if (result && result.source.mode !== window.vditor?.vditor?.currentMode)
          scheduleRefresh()
      })
  }
  // The shared index drains editor mutations and source revisions (it replaces Find's private
  // MutationObserver); SV edits arrive as editor input.
  const stopInvalidation = sourceDeps.index?.onInvalidate(scheduleRefresh)
  elements.root.addEventListener('click', onClick)
  elements.root.addEventListener('keydown', onKeydown)
  elements.find.addEventListener('input', onFindInput)
  doc.addEventListener('input', onEditorInput)
  doc.addEventListener('click', onDocumentClick, true)
  doc.addEventListener('scroll', scheduleOverlays, true)
  window.addEventListener('resize', scheduleOverlays)
  window.addEventListener('resize', syncWidgetPosition)

  return () => {
    if (openInstalledFindReplace === open) openInstalledFindReplace = undefined
    if (installedFindWidgetAction === runAction)
      installedFindWidgetAction = undefined
    if (!elements.root.hidden) findReplaceDeps?.reportState(false)
    stopInvalidation?.()
    elements.root.removeEventListener('click', onClick)
    elements.root.removeEventListener('keydown', onKeydown)
    elements.find.removeEventListener('input', onFindInput)
    doc.removeEventListener('input', onEditorInput)
    doc.removeEventListener('click', onDocumentClick, true)
    doc.removeEventListener('scroll', scheduleOverlays, true)
    window.removeEventListener('resize', scheduleOverlays)
    window.removeEventListener('resize', syncWidgetPosition)
    doc.removeEventListener('load', onStylesheetSettled, true)
    doc.removeEventListener('error', onStylesheetSettled, true)
    doc.removeEventListener(
      'contentvisibilityautostatechange',
      onContentVisibilityChange,
      true,
    )
    layoutResize?.disconnect()
    if (frame) cancelAnimationFrame(frame)
    cancelSettle()
    if (refreshFrame) cancelAnimationFrame(refreshFrame)
    if (refreshTimer) window.clearTimeout(refreshTimer)
    elements.root.remove()
    elements.overlay.remove()
  }
}
