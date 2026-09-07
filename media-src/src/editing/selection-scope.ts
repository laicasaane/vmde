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
import { blockIndexForSourceLine, offsetToLine } from '../util/source-map'
import { hasClosestBlock } from 'vditor/src/ts/util/hasClosest'
import { guardComposition } from '../util/caret-gesture'
import { innerVditor } from '../util/inner-vditor'
import { findScroller } from '../chrome/toolbar-scroll-guard'
import { scrollBehavior } from '../util/reduced-motion'

export interface MarkdownFindOptions {
  caseSensitive: boolean
  wholeWord: boolean
}

export interface MarkdownMatch {
  start: number
  end: number
  line: number
  blockIndex: number | null
}

export interface MarkdownReplaceResult {
  changed: boolean
  markdown: string
  replacements: number
  caretOffset: number
}

const FIND_WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u

function isWholeWord(markdown: string, start: number, end: number): boolean {
  const beforeStart =
    start > 1 &&
    /[\uDC00-\uDFFF]/.test(markdown[start - 1] ?? '') &&
    /[\uD800-\uDBFF]/.test(markdown[start - 2] ?? '')
      ? start - 2
      : start - 1
  const before =
    start > 0
      ? String.fromCodePoint(markdown.codePointAt(beforeStart)!)
      : undefined
  const after =
    end < markdown.length
      ? String.fromCodePoint(markdown.codePointAt(end)!)
      : undefined
  return !(
    (before !== undefined && FIND_WORD_CHAR.test(before)) ||
    (after !== undefined && FIND_WORD_CHAR.test(after))
  )
}

/** Lowercase each candidate only after it is sliced at the original UTF-16 offsets. Turkish
 * dotted I expands under lowercasing, so lowering the entire document shifts later matches. */
function findCaseFold(value: string): string {
  return value.toLocaleLowerCase().replaceAll('\u0307', '')
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: literal source matching retains exact offsets while handling case and whole-word boundaries.
export function findMarkdownMatches(
  markdown: string,
  query: string,
  options: MarkdownFindOptions,
): MarkdownMatch[] {
  if (!query) return []
  const needle = options.caseSensitive ? query : findCaseFold(query)
  const matches: MarkdownMatch[] = []
  let from = 0
  while (from <= markdown.length - query.length) {
    let start = -1
    for (let index = from; index <= markdown.length - query.length; index++) {
      const candidate = markdown.slice(index, index + query.length)
      if (
        (options.caseSensitive ? candidate : findCaseFold(candidate)) === needle
      ) {
        start = index
        break
      }
    }
    if (start < 0) break
    const end = start + query.length
    if (!options.wholeWord || isWholeWord(markdown, start, end)) {
      const line = offsetToLine(markdown, start)
      matches.push({
        start,
        end,
        line,
        blockIndex: blockIndexForSourceLine(markdown, line),
      })
    }
    from = Math.max(end, start + 1)
  }
  return matches
}

export function replaceMarkdownMatch(
  markdown: string,
  match: MarkdownMatch,
  replacement: string,
): MarkdownReplaceResult {
  if (match.start < 0 || match.end < match.start || match.end > markdown.length)
    return {
      changed: false,
      markdown,
      replacements: 0,
      caretOffset: Math.max(0, match.start),
    }
  return {
    changed: markdown.slice(match.start, match.end) !== replacement,
    markdown:
      markdown.slice(0, match.start) + replacement + markdown.slice(match.end),
    replacements: 1,
    caretOffset: match.start + replacement.length,
  }
}

export function replaceAllMarkdownMatches(
  markdown: string,
  matches: readonly MarkdownMatch[],
  replacement: string,
): MarkdownReplaceResult {
  if (matches.length === 0)
    return { changed: false, markdown, replacements: 0, caretOffset: 0 }
  let output = ''
  let cursor = 0
  for (const match of matches) {
    output += markdown.slice(cursor, match.start) + replacement
    cursor = match.end
  }
  output += markdown.slice(cursor)
  return {
    changed: output !== markdown,
    markdown: output,
    replacements: matches.length,
    caretOffset: matches[0].start + replacement.length,
  }
}

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

/** Install IR-only structural selection. Ctrl+D and Ctrl+L deliberately remain Vditor's promoted
 * strike/list shortcuts; this task predates those shipped bindings and must not steal them. */
export function installStructuralSelection(
  win: Window & typeof globalThis = window,
): () => void {
  const onKeydown = (event: KeyboardEvent): void => {
    const action = structuralKeyAction(event)
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
}

let findReplaceDeps: FindReplaceDeps | undefined
let openInstalledFindReplace: (() => void) | undefined
let pendingFindReplaceOpen = false

export function configureFindReplaceActions(deps: FindReplaceDeps): void {
  findReplaceDeps = deps
}

export function openFindReplace(): void {
  if (openInstalledFindReplace) openInstalledFindReplace()
  else pendingFindReplaceOpen = true
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

function applyFindReplaceResult(result: MarkdownReplaceResult): boolean {
  const deps = findReplaceDeps
  const outer = window.vditor
  const inner = innerVditor()
  const editor = outer ? activeModeElement(outer) : null
  if (!deps || !outer || !inner || !editor || !result.changed) return false
  const marker = uniqueFindCaret(result.markdown)
  const marked =
    result.markdown.slice(0, result.caretOffset) +
    marker +
    result.markdown.slice(result.caretOffset)
  const scrollTop = findScroller(editor).scrollTop
  deps.setApplying(true)
  try {
    inner.undo?.addToUndoStack?.(inner)
    outer.setValue(marked)
    const fresh = activeModeElement(outer)
    const caret = fresh ? removeFindCaret(fresh, marker) : null
    if (!fresh || caret === null) {
      outer.setValue(result.markdown)
      return false
    }
    inner.undo?.addToUndoStack?.(inner)
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
  deps.postExact(result.markdown)
  return true
}

interface FindReplaceElements {
  root: HTMLElement
  find: HTMLInputElement
  replace: HTMLInputElement
  status: HTMLElement
  caseButton: HTMLButtonElement
  wordButton: HTMLButtonElement
  overlay: HTMLElement
}

function createFindReplaceElements(doc: Document): FindReplaceElements {
  const root = doc.createElement('div')
  root.className = 'vmde-find-replace'
  root.hidden = true
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'Find and replace')
  root.dataset.vmdeOverlay = '1'
  root.innerHTML = `
    <div class="vmde-find-replace__row">
      <input type="text" data-find aria-label="Find" placeholder="Find" />
      <button type="button" data-action="previous" aria-label="Previous match">↑</button>
      <button type="button" data-action="next" aria-label="Next match">↓</button>
      <button type="button" data-action="case" aria-label="Match case" aria-pressed="false">Aa</button>
      <button type="button" data-action="word" aria-label="Match whole word" aria-pressed="false">W</button>
      <span data-status role="status" aria-live="polite">0/0</span>
      <button type="button" data-action="close" aria-label="Close find and replace">×</button>
    </div>
    <div class="vmde-find-replace__row">
      <input type="text" data-replace aria-label="Replace with" placeholder="Replace" />
      <button type="button" data-action="replace">Replace</button>
      <button type="button" data-action="replace-all">Replace All</button>
    </div>`
  const overlay = doc.createElement('div')
  overlay.className = 'vmde-find-overlays'
  overlay.setAttribute('aria-hidden', 'true')
  doc.body.append(overlay, root)
  return {
    root,
    find: root.querySelector('[data-find]') as HTMLInputElement,
    replace: root.querySelector('[data-replace]') as HTMLInputElement,
    status: root.querySelector('[data-status]') as HTMLElement,
    caseButton: root.querySelector('[data-action="case"]') as HTMLButtonElement,
    wordButton: root.querySelector('[data-action="word"]') as HTMLButtonElement,
    overlay,
  }
}

interface SourcePoint {
  node: Text
  offset: number
}

interface FindPointCache {
  editor: HTMLElement
  markdown: string
  mode: string
  points: Map<number, SourcePoint>
}

function isSerializableFindText(node: Text): boolean {
  const parent = node.parentElement
  return !parent?.closest(
    '.vditor-ir__marker, .vditor-ir__preview [data-render], .vditor-copy, svg, textarea, wbr, [contenteditable="false"]',
  )
}

function isCodePointBoundary(text: string, offset: number): boolean {
  return !(
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1] ?? '') &&
    /[\uDC00-\uDFFF]/.test(text[offset] ?? '')
  )
}

function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text) nodes.push(node)
  }
  return nodes
}

function pointsFromSerialized(
  serialized: string,
  markdown: string,
  sentinel: string,
  boundaries: readonly SourcePoint[],
): Map<number, SourcePoint> | null {
  if (serialized.split(sentinel).join('') !== markdown) return null
  const points = new Map<number, SourcePoint>()
  let sourceOffset = 0
  let boundaryIndex = 0
  for (let index = 0; index < serialized.length; ) {
    if (serialized.startsWith(sentinel, index)) {
      const point = boundaries[boundaryIndex++]
      if (!point) return null
      if (!points.has(sourceOffset)) points.set(sourceOffset, point)
      index += sentinel.length
    } else {
      sourceOffset++
      index++
    }
  }
  return boundaryIndex === boundaries.length && sourceOffset === markdown.length
    ? points
    : null
}

function uniqueFindSentinel(markdown: string, editor: HTMLElement): string {
  let sentinel = '\uE000'
  while (markdown.includes(sentinel) || editor.textContent?.includes(sentinel))
    sentinel += '\uE000'
  return sentinel
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one detached serializer probe must retain source bytes, token boundaries, and original DOM points together.
function serializeFindClone(
  editor: HTMLElement,
  markdown: string,
  mode: string,
  candidateIndexes: readonly number[],
): Map<number, SourcePoint> | null {
  const nodes = textNodes(editor)
  const clone = editor.cloneNode(true) as HTMLElement
  const cloneNodes = textNodes(clone)
  const lute = window.vditor?.vditor?.lute
  const serialize =
    mode === 'wysiwyg'
      ? lute?.VditorDOM2Md?.bind(lute)
      : lute?.VditorIRDOM2Md?.bind(lute)
  if (!serialize || nodes.length !== cloneNodes.length) return null
  const sentinel = uniqueFindSentinel(markdown, clone)
  const boundaries: SourcePoint[] = []
  for (const index of candidateIndexes) {
    const original = nodes[index]
    const cloneNode = cloneNodes[index]
    if (!original || !cloneNode || original.data !== cloneNode.data) return null
    let marked = ''
    for (let offset = 0; offset <= cloneNode.data.length; offset++) {
      if (isCodePointBoundary(cloneNode.data, offset)) {
        boundaries.push({ node: original, offset })
        marked += sentinel
      }
      if (offset < cloneNode.data.length) marked += cloneNode.data[offset]
    }
    cloneNode.data = marked
  }
  try {
    return pointsFromSerialized(
      serialize(clone.innerHTML),
      markdown,
      sentinel,
      boundaries,
    )
  } catch {
    return null
  }
}

/** Map source offsets by sentinel batches. A failing special node is isolated and omitted while
 * serializer-stable prose remains usable; no failed node can turn into a block approximation. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: merges bounded serializer probes and the raw SV path while preserving only exact source points.
function sourcePoints(
  editor: HTMLElement,
  markdown: string,
  mode: string,
): Map<number, SourcePoint> | null {
  const nodes = textNodes(editor)
  if (mode === 'sv') {
    let base = 0
    const points = new Map<number, SourcePoint>()
    for (const node of nodes) {
      for (let index = 0; index <= node.data.length; index++) {
        if (!isCodePointBoundary(node.data, index)) continue
        const point = { node, offset: index }
        if (!points.has(base + index)) points.set(base + index, point)
      }
      base += node.data.length
    }
    const text = nodes.map((node) => node.data).join('')
    if (text !== markdown) return null
    return points
  }

  const points = new Map<number, SourcePoint>()
  const candidates = nodes.flatMap((node, index) =>
    isSerializableFindText(node) ? [index] : [],
  )
  for (let start = 0; start < candidates.length; start += 24) {
    const batch = candidates.slice(start, start + 24)
    const batchPoints = serializeFindClone(editor, markdown, mode, batch)
    if (batchPoints) {
      for (const [offset, point] of batchPoints) points.set(offset, point)
      continue
    }
    for (const index of batch) {
      const nodePoints = serializeFindClone(editor, markdown, mode, [index])
      if (!nodePoints) continue
      for (const [offset, point] of nodePoints) points.set(offset, point)
    }
  }
  return points
}

function rangeInText(root: Node, start: number, end: number): Range | null {
  const nodes = textNodes(root)
  let offset = 0
  let first: SourcePoint | undefined
  let last: SourcePoint | undefined
  for (const node of nodes) {
    const next = offset + node.data.length
    if (!first && start >= offset && start <= next)
      first = { node, offset: start - offset }
    if (end >= offset && end <= next) {
      last = { node, offset: end - offset }
      break
    }
    offset = next
  }
  if (!first || !last) return null
  const range = document.createRange()
  range.setStart(first.node, first.offset)
  range.setEnd(last.node, last.offset)
  return range
}

interface SourceRegion {
  start: number
  end: number
}

function fencedBodies(markdown: string): SourceRegion[] {
  const out: SourceRegion[] = []
  const pattern = /(^|\n) {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/g
  for (const open of markdown.matchAll(pattern)) {
    const marker = open[2]!
    const start = open.index! + open[0].length
    const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`, 'm')
    const found = close.exec(markdown.slice(start))
    if (found) out.push({ start, end: start + found.index })
  }
  return out
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: preserves exact GFM cell offsets while distinguishing escaped separators and delimiter rows.
function tableCellRegions(markdown: string): SourceRegion[] {
  const out: SourceRegion[] = []
  let offset = 0
  for (const line of markdown.split('\n')) {
    const delimiter =
      /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line)
    if (delimiter) {
      offset += line.length + 1
      continue
    }
    if (!line.includes('|')) {
      offset += line.length + 1
      continue
    }
    let cellStart = line.startsWith('|') ? 1 : 0
    let escaped = false
    for (let index = cellStart; index <= line.length; index++) {
      const pipe = line[index] === '|' && !escaped
      if (pipe || index === line.length) {
        if (index === line.length && cellStart === line.length) break
        const raw = line.slice(cellStart, index)
        const leading = raw.length - raw.trimStart().length
        const trailing = raw.length - raw.trimEnd().length
        out.push({
          start: offset + cellStart + leading,
          end: offset + index - trailing,
        })
        cellStart = index + 1
      }
      escaped = line[index] === '\\' && !escaped
      if (line[index] !== '\\') escaped = false
    }
    offset += line.length + 1
  }
  return out
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validates code and table ownership independently before exposing a source-backed DOM range.
function specialMatchRange(
  editor: HTMLElement,
  match: MarkdownMatch,
  markdown: string,
): Range | null {
  const codeBlocks = Array.from(
    editor.querySelectorAll<HTMLElement>('[data-type="code-block"]'),
  )
  for (const [index, body] of fencedBodies(markdown).entries()) {
    if (match.start < body.start || match.end > body.end) continue
    const preview = codeBlocks[index]?.querySelector<HTMLElement>(
      '.vditor-ir__preview code',
    )
    const source = markdown.slice(body.start, body.end)
    if (!preview || preview.textContent !== source) continue
    const range = rangeInText(
      preview,
      match.start - body.start,
      match.end - body.start,
    )
    if (range?.toString() === markdown.slice(match.start, match.end))
      return range
  }
  const cells = Array.from(
    editor.querySelectorAll<HTMLElement>('table td, table th'),
  )
  for (const [index, cell] of tableCellRegions(markdown).entries()) {
    if (match.start < cell.start || match.end > cell.end) continue
    const target = cells[index]
    const source = markdown.slice(cell.start, cell.end)
    if (!target || target.textContent !== source) continue
    const range = rangeInText(
      target,
      match.start - cell.start,
      match.end - cell.start,
    )
    if (range?.toString() === markdown.slice(match.start, match.end))
      return range
  }
  return null
}

function visibleMatchRange(
  match: MarkdownMatch,
  markdown: string,
  points: Map<number, SourcePoint>,
): Range | null {
  const start = points.get(match.start)
  const end = points.get(match.end)
  if (!start || !end) return null
  try {
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    return range.toString() === markdown.slice(match.start, match.end)
      ? range
      : null
  } catch {
    return null
  }
}

/** Install the custom source-accurate find/replace widget. UI and overlay rectangles live outside
 * Vditor's editable DOM, so they cannot serialize or disturb Lute's marker structure. */
export function installFindReplace(doc: Document = document): () => void {
  const elements = createFindReplaceElements(doc)
  let matches: MarkdownMatch[] = []
  let current = 0
  let frame = 0
  let pointCache: FindPointCache | undefined
  let mappingObserver: MutationObserver | undefined

  const options = (): MarkdownFindOptions => ({
    caseSensitive: elements.caseButton.getAttribute('aria-pressed') === 'true',
    wholeWord: elements.wordButton.getAttribute('aria-pressed') === 'true',
  })

  const cachePoints = (markdown: string) => {
    const editor = activeModeElement(window.vditor)
    const mode = window.vditor?.vditor?.currentMode ?? ''
    const points = editor ? sourcePoints(editor, markdown, mode) : null
    pointCache =
      editor && points ? { editor, markdown, mode, points } : undefined
    mappingObserver?.disconnect()
    if (!editor) return
    mappingObserver = new MutationObserver(() => {
      pointCache = undefined
      if (!elements.root.hidden) requestAnimationFrame(() => refresh(false))
    })
    mappingObserver.observe(editor, {
      childList: true,
      characterData: true,
      subtree: true,
    })
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one paint pass owns cache refresh, exact ranges, fragment de-duplication, and current state.
  const renderOverlays = () => {
    frame = 0
    elements.overlay.replaceChildren()
    if (elements.root.hidden || matches.length === 0) return
    const editor = activeModeElement(window.vditor)
    if (!editor) return
    const mode = window.vditor?.vditor?.currentMode ?? ''
    if (!pointCache || pointCache.editor !== editor || pointCache.mode !== mode)
      return
    if (!pointCache) return
    let visibleMatches = 0
    for (const [index, match] of matches.entries()) {
      const range =
        visibleMatchRange(match, pointCache.markdown, pointCache.points) ??
        specialMatchRange(editor, match, pointCache.markdown)
      if (!range) continue
      const seen = new Set<string>()
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0 || rect.height <= 0) continue
        const key = [rect.left, rect.top, rect.width, rect.height]
          .map((value) => value.toFixed(2))
          .join(':')
        if (seen.has(key)) continue
        seen.add(key)
        const highlight = doc.createElement('div')
        highlight.className = 'vmde-find-overlay'
        if (index === current)
          highlight.classList.add('vmde-find-overlay--current')
        highlight.style.left = `${rect.left}px`
        highlight.style.top = `${rect.top}px`
        highlight.style.width = `${rect.width}px`
        highlight.style.height = `${rect.height}px`
        elements.overlay.append(highlight)
        visibleMatches++
      }
    }
    elements.status.title =
      visibleMatches < matches.length
        ? `${matches.length - visibleMatches} source match${matches.length - visibleMatches === 1 ? '' : 'es'} are not visible in this editor mode.`
        : ''
  }

  const scheduleOverlays = () => {
    if (!frame) frame = requestAnimationFrame(renderOverlays)
  }

  const revealCurrent = () => {
    const match = matches[current]
    const range =
      match && pointCache
        ? (visibleMatchRange(match, pointCache.markdown, pointCache.points) ??
          specialMatchRange(pointCache.editor, match, pointCache.markdown))
        : null
    const target = range?.getClientRects()[0]
    if (target) {
      const viewport = doc.defaultView
      viewport?.scrollBy({
        top: target.top - viewport.innerHeight / 2,
        behavior: scrollBehavior(),
      })
    }
    scheduleOverlays()
  }

  const refresh = (resetCurrent = false) => {
    const markdown = window.vditor?.getValue?.() ?? ''
    matches = findMarkdownMatches(markdown, elements.find.value, options())
    if (matches.length > 0) cachePoints(markdown)
    else pointCache = undefined
    if (resetCurrent) current = 0
    else current = Math.min(current, Math.max(0, matches.length - 1))
    elements.status.textContent =
      matches.length === 0 ? '0/0' : `${current + 1}/${matches.length}`
    revealCurrent()
  }

  const move = (delta: 1 | -1) => {
    if (matches.length === 0) return
    current = (current + delta + matches.length) % matches.length
    elements.status.textContent = `${current + 1}/${matches.length}`
    revealCurrent()
  }

  const replaceCurrent = () => {
    const markdown = window.vditor?.getValue?.() ?? ''
    const live = findMarkdownMatches(markdown, elements.find.value, options())
    const match = live[Math.min(current, Math.max(0, live.length - 1))]
    if (!match) return
    if (
      applyFindReplaceResult(
        replaceMarkdownMatch(markdown, match, elements.replace.value),
      )
    )
      requestAnimationFrame(() => refresh(false))
  }

  const replaceAll = () => {
    const markdown = window.vditor?.getValue?.() ?? ''
    const live = findMarkdownMatches(markdown, elements.find.value, options())
    if (
      applyFindReplaceResult(
        replaceAllMarkdownMatches(markdown, live, elements.replace.value),
      )
    )
      requestAnimationFrame(() => refresh(true))
  }

  const close = () => {
    elements.root.hidden = true
    matches = []
    elements.overlay.replaceChildren()
    activeModeElement(window.vditor)?.focus({ preventScroll: true })
  }

  const open = () => {
    elements.root.hidden = false
    refresh(true)
    elements.find.focus()
    elements.find.select()
  }
  openInstalledFindReplace = open
  if (pendingFindReplaceOpen) {
    pendingFindReplaceOpen = false
    open()
  }

  const toggleOption = (button: HTMLButtonElement) => {
    button.setAttribute(
      'aria-pressed',
      button.getAttribute('aria-pressed') === 'true' ? 'false' : 'true',
    )
    refresh(true)
  }

  const onClick = (event: MouseEvent) => {
    const action = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-action]',
    )?.dataset.action
    if (action === 'previous') move(-1)
    else if (action === 'next') move(1)
    else if (action === 'replace') replaceCurrent()
    else if (action === 'replace-all') replaceAll()
    else if (action === 'close') close()
    else if (action === 'case' || action === 'word')
      toggleOption(event.target as HTMLButtonElement)
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (guardComposition(event)) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      move(event.shiftKey ? -1 : 1)
    }
  }
  const onFindInput = () => refresh(true)
  const onEditorInput = (event: Event) => {
    if (!elements.root.hidden && !elements.root.contains(event.target as Node))
      requestAnimationFrame(() => refresh(false))
  }
  const onDocumentClick = (event: MouseEvent) => {
    if (!elements.root.hidden && !elements.root.contains(event.target as Node))
      requestAnimationFrame(() => refresh(false))
  }
  elements.root.addEventListener('click', onClick)
  elements.root.addEventListener('keydown', onKeydown)
  elements.find.addEventListener('input', onFindInput)
  doc.addEventListener('input', onEditorInput)
  doc.addEventListener('click', onDocumentClick, true)
  doc.addEventListener('scroll', scheduleOverlays, true)
  window.addEventListener('resize', scheduleOverlays)

  return () => {
    if (openInstalledFindReplace === open) openInstalledFindReplace = undefined
    elements.root.removeEventListener('click', onClick)
    elements.root.removeEventListener('keydown', onKeydown)
    elements.find.removeEventListener('input', onFindInput)
    doc.removeEventListener('input', onEditorInput)
    doc.removeEventListener('click', onDocumentClick, true)
    doc.removeEventListener('scroll', scheduleOverlays, true)
    window.removeEventListener('resize', scheduleOverlays)
    if (frame) cancelAnimationFrame(frame)
    mappingObserver?.disconnect()
    elements.root.remove()
    elements.overlay.remove()
  }
}
