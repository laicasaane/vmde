// Task 597 — the restore-time caret fallback for Undo/Redo snapshots without a usable caret marker.
//
// Vditor bakes the caret into each undo snapshot as a `<wbr>` marker, but only when the live range
// starts inside the editor. A snapshot recorded while focus sat in another input (the Find widget, a
// popover field, a debounced checkpoint after focus left) has no marker, and a range collapsed on
// the editable root records a marker at the root. Restoring either left the selection outside the
// editable blocks: the next key was dropped and Vditor's toolbar highlighting, which requires a
// selection inside the editor, kept stale state. The patched `Undo.renderDiff`
// (esbuild-shared.mjs's patchUndoRestoreCaretFallback) calls this bridge at three points:
//
// - `capture` before the old DOM, selection and `lastText` are replaced. It only records the root,
//   the two snapshot strings Vditor already holds, the direction and a structural bookmark of the
//   live focus endpoint. It never parses, serializes, writes or moves the selection.
// - `usableMarker` after the restored DOM is in place. It removes markers that cannot hold a caret
//   (at the root while real blocks exist, inside a rendered preview or a non-editable subtree) and
//   reports whether a usable one remains for Vditor's own `setRangeByWbr`.
// - `restore` when no usable marker remains. It places one collapsed caret through the caret
//   authority, in this order: the change site (Undo: the start of the change, Redo: its end), the
//   pre-Undo focus endpoint, then the start of the first editable block. Only a change site is
//   revealed when it is off-screen; the fallbacks never scroll.
//
// The change site compares top-level blocks by tag and source-side text in inert templates, never
// by HTML: IDs, fold attributes, classes and rendered previews differ between equal snapshots.
import {
  findScroller,
  markIntentionalHistoryReveal,
} from '../chrome/toolbar-scroll-guard'
import { isCompositionActive } from '../util/caret-gesture'
import { activeModeElement } from '../util/source-map'
import { hasLiveCaretIntent, resolveCaretIntent } from './caret'
import { caretLineRect } from './nav-geometry'
import {
  GAP_ATTR,
  isEmptyGapParagraph,
  TRAILING_ATTR,
} from './trailing-paragraph'

// The nearest of these encloses a caret bookmark; it matches patchUndoCaretSplitRestore's capture
// with table cells instead of rows, so a bookmark names the cell it was in.
const SEMANTIC_BLOCK =
  'p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, pre, [data-block]'
// Wrappers worth descending into to find a block start when a top-level block has no text.
const BLOCK_CONTAINER = `${SEMANTIC_BLOCK}, ul, ol, table, thead, tbody, tr`
// Rendered output and non-editable chrome: never a caret target and never part of the source text.
const EXCLUDED =
  '.vditor-ir__preview, .vditor-wysiwyg__preview, [data-render="1"], [data-render="2"], [contenteditable="false"]'
const MARKER = 'wbr, .vditor-wbr'
// VMDE's manufactured paragraphs (the EOF trailing paragraph and gap stops, trailing-paragraph.ts).
// While empty they carry no source, and one snapshot can hold one where the other does not
// (measured in real VS Code SV: the pre-Replace snapshot had the trailing paragraph, so Redo paired
// the changed block with it and landed at the end of the document).
const HELPER_PARAGRAPH = `p[${TRAILING_ATTR}], p[${GAP_ATTR}]`
// Same breathing room caret-scroll.ts keeps between a revealed caret and the scroller edge.
const REVEAL_MARGIN = 12
// A large document skips rendering off-screen blocks (`content-visibility: auto`, main.css), so a
// reveal's scroll renders the blocks it passes at their real height and moves the change site
// (measured in real VS Code on the large fixture: one scroll left the caret ~1,500 px below the
// view). The reveal re-measures after each rendering update and corrects at most this many times,
// the same bound Find's reveal uses (selection-scope.ts).
const REVEAL_STEPS = 8

interface BlockIntent {
  blockPath: number[]
  offsetInBlock: number
}
interface Endpoint {
  node: Node
  offset: number
}
type RestoreIntent = BlockIntent | Endpoint | 'document-start'

export interface UndoRestoreCapture {
  readonly root: HTMLElement
  readonly previousHtml: string
  readonly restoredHtml: string
  readonly isRedo: boolean
  readonly focus: BlockIntent | null
}

interface UndoRestoreCaretBridge {
  capture(
    root: HTMLElement,
    previousHtml: string,
    restoredHtml: string,
    isRedo: boolean,
  ): UndoRestoreCapture
  usableMarker(root: HTMLElement): boolean
  restore(capture: UndoRestoreCapture): boolean
}

interface ProjectedBlock {
  tag: string
  text: string
  // Index among the root's element children, markers excluded; excluded blocks keep their slot.
  ordinal: number
}

interface ChangeSite {
  ordinal: number
  tag: string
  offset: number
  // Undo lands before the first changed character, Redo after the last one.
  forward: boolean
}

function insideExcluded(node: Node, root: Node): boolean {
  const el =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const hit = el?.closest(EXCLUDED)
  return !!hit && hit !== root && root.contains(hit)
}

// Text nodes of `container` in document order, skipping rendered and non-editable subtrees.
function sourceTextWalker(container: Node): TreeWalker {
  return document.createTreeWalker(
    container,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT
        return (node as Element).matches(EXCLUDED)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP
      },
    },
  )
}

function sourceText(container: Node): string {
  const walker = sourceTextWalker(container)
  let text = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    text += (node as Text).data
  return text
}

const isHelperParagraph = (el: Element) =>
  el.matches(HELPER_PARAGRAPH) && isEmptyGapParagraph(el as HTMLElement)

function projectBlocks(container: ParentNode): ProjectedBlock[] {
  const blocks: ProjectedBlock[] = []
  let ordinal = 0
  for (const child of Array.from(container.children)) {
    if (child.matches(MARKER)) continue
    const index = ordinal++
    if (child.matches(EXCLUDED) || isHelperParagraph(child)) continue
    blocks.push({ tag: child.tagName, text: sourceText(child), ordinal: index })
  }
  return blocks
}

// An inert parse: template content runs no scripts and loads no resources.
function parseSnapshot(html: string): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

// Move an offset that falls between the halves of a surrogate pair to the pair's earlier or later
// edge; a caret must never split a code point.
function alignToCodePoint(
  text: string,
  offset: number,
  later: boolean,
): number {
  if (
    offset > 0 &&
    offset < text.length &&
    isHighSurrogate(text.charCodeAt(offset - 1)) &&
    isLowSurrogate(text.charCodeAt(offset))
  )
    return later ? offset + 1 : offset - 1
  return offset
}

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let index = 0
  while (index < max && a.charCodeAt(index) === b.charCodeAt(index)) index++
  return index
}

// The end of the changed span in `restored`. The common suffix is bounded so it never overlaps
// the common prefix, which keeps a pure insertion's end after the inserted text.
function changeEnd(previous: string, restored: string): number {
  const max =
    Math.min(previous.length, restored.length) -
    commonPrefix(previous, restored)
  let suffix = 0
  while (
    suffix < max &&
    previous.charCodeAt(previous.length - 1 - suffix) ===
      restored.charCodeAt(restored.length - 1 - suffix)
  )
    suffix++
  return restored.length - suffix
}

const sameBlock = (a: ProjectedBlock, b: ProjectedBlock) =>
  a.tag === b.tag && a.text === b.text

function siteAt(
  block: ProjectedBlock,
  offset: number,
  forward: boolean,
): ChangeSite {
  return {
    ordinal: block.ordinal,
    tag: block.tag,
    offset: alignToCodePoint(block.text, offset, !forward),
    forward,
  }
}

// Counts of equal leading and trailing blocks; the trailing run never overlaps the leading one.
function equalEnds(
  previous: ProjectedBlock[],
  restored: ProjectedBlock[],
): { lead: number; trail: number } {
  const limit = Math.min(previous.length, restored.length)
  let lead = 0
  while (lead < limit && sameBlock(previous[lead], restored[lead])) lead++
  let trail = 0
  while (
    trail < limit - lead &&
    sameBlock(
      previous[previous.length - 1 - trail],
      restored[restored.length - 1 - trail],
    )
  )
    trail++
  return { lead, trail }
}

// Pure removal: the following surviving block's start, else the preceding block's end.
function removalSite(
  restored: ProjectedBlock[],
  lead: number,
): ChangeSite | null {
  const following = restored[lead]
  if (following) return siteAt(following, 0, true)
  const preceding = restored[lead - 1]
  return preceding ? siteAt(preceding, preceding.text.length, false) : null
}

// The caret target in the restored blocks: the start of the changed interval for Undo, its end for
// Redo. Equal leading and trailing blocks are stripped first, so an inserted or removed block is
// never paired with an unrelated surviving one. A corresponding block with the same tag narrows the
// target to the changed text; an inserted block or a tag-only replacement uses its source start
// (Undo) or end (Redo). Null when the projections are equal (a caret-, attribute- or preview-only
// change).
function findChangeSite(
  previous: ProjectedBlock[],
  restored: ProjectedBlock[],
  isRedo: boolean,
): ChangeSite | null {
  const { lead, trail } = equalEnds(previous, restored)
  if (lead === previous.length && lead === restored.length) return null
  const previousEnd = previous.length - trail
  const restoredEnd = restored.length - trail
  if (restoredEnd === lead) return removalSite(restored, lead)
  const index = isRedo ? restoredEnd - 1 : lead
  const block = restored[index]
  const partnerIndex = isRedo ? previousEnd - 1 : lead
  const partner = previousEnd > lead ? previous[partnerIndex] : undefined
  if (!partner || partner.tag !== block.tag)
    return siteAt(block, isRedo ? block.text.length : 0, !isRedo)
  const offset = isRedo
    ? changeEnd(partner.text, block.text)
    : commonPrefix(partner.text, block.text)
  return siteAt(block, offset, !isRedo)
}

// The live top-level block matching a projected ordinal. A mismatched tag means the live DOM is not
// the snapshot the site was computed from; the caller falls back instead of guessing.
function liveBlock(root: HTMLElement, site: ChangeSite): Element | null {
  let ordinal = 0
  for (const child of Array.from(root.children)) {
    if (child.matches(MARKER)) continue
    if (ordinal++ !== site.ordinal) continue
    return child.tagName === site.tag && !child.matches(EXCLUDED) ? child : null
  }
  return null
}

function isHidden(node: Node, block: Element): boolean {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (getComputedStyle(el).display === 'none') return true
    if (el === block) break
  }
  return false
}

function sourceTexts(block: Element): Text[] {
  const walker = sourceTextWalker(block)
  const texts: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if ((node as Text).data.length > 0) texts.push(node as Text)
  return texts
}

// The positions after the character before `offset` and before the character at `offset`, with
// the index of the text holding the latter (texts.length at the end).
function boundarySides(texts: Text[], offset: number) {
  let before: Endpoint | null = null
  let after: Endpoint | null = null
  let afterIndex = texts.length
  let start = 0
  for (let index = 0; index < texts.length && !after; index++) {
    const node = texts[index]
    const end = start + node.data.length
    if (offset > start && offset <= end)
      before = { node, offset: offset - start }
    if (offset >= start && offset < end) {
      after = { node, offset: offset - start }
      afterIndex = index
    }
    start = end
  }
  return { before, after, afterIndex }
}

// The nearest visible text from `index`: the next one's start, else the previous one's end.
function nearestVisible(
  texts: Text[],
  index: number,
  block: Element,
): Endpoint | null {
  const next = texts.slice(index).find((node) => !isHidden(node, block))
  if (next) return { node: next, offset: 0 }
  const previous = texts
    .slice(0, index)
    .reverse()
    .find((node) => !isHidden(node, block))
  return previous ? { node: previous, offset: previous.data.length } : null
}

// The live endpoint `offset` source characters into `block`. `forward` places it before the
// character at `offset` (the start of a change), otherwise after the character before it (the end
// of a change), which decides the side of a boundary between two text nodes or two nested blocks.
// A hidden text node (an SV newline, a collapsed IR marker) cannot paint a caret, so the other side
// of the boundary, then the nearest visible text, is used instead.
function endpointIn(
  block: Element,
  offset: number,
  forward: boolean,
): Endpoint {
  const texts = sourceTexts(block)
  if (texts.length === 0) {
    let el: Element = block
    while (el.firstElementChild?.matches(BLOCK_CONTAINER))
      el = el.firstElementChild
    return { node: el, offset: 0 }
  }
  const { before, after, afterIndex } = boundarySides(texts, offset)
  const sides = forward ? [after, before] : [before, after]
  const visible = sides.find(
    (side): side is Endpoint => !!side && !isHidden(side.node, block),
  )
  const last = texts[texts.length - 1]
  return (
    visible ??
    nearestVisible(texts, afterIndex, block) ??
    sides.find((side): side is Endpoint => !!side) ?? {
      node: last,
      offset: last.data.length,
    }
  )
}

// A structural bookmark: the element-child path to the nearest editable semantic block plus the raw
// text offset in it. caret.ts's `{blockPath, offsetInBlock}` resolver re-resolves it every frame.
function encode(
  root: HTMLElement,
  node: Node,
  offset: number,
): BlockIntent | null {
  const host =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const block = host?.closest(SEMANTIC_BLOCK)
  if (!block || block === root || !root.contains(block)) return null
  const blockPath: number[] = []
  for (let walk: Element = block; walk !== root; ) {
    const parent = walk.parentElement
    if (!parent) return null
    blockPath.unshift(Array.prototype.indexOf.call(parent.children, walk))
    walk = parent
  }
  const range = document.createRange()
  range.selectNodeContents(block)
  range.setEnd(node, offset)
  return { blockPath, offsetInBlock: range.toString().length }
}

// Prefer the structural bookmark, which caret.ts re-resolves every frame across Vditor's re-spins.
// Its resolver walks ALL text, previews included, and keeps the earlier node at a boundary, so the
// bookmark is used only when it resolves to a visible source position; otherwise the exact node
// position is requested.
function intentFor(
  root: HTMLElement,
  endpoint: Endpoint,
): RestoreIntent | null {
  if (endpoint.node === root || insideExcluded(endpoint.node, root)) return null
  const encoded = encode(root, endpoint.node, endpoint.offset)
  const resolved = encoded && resolveCaretIntent(encoded, root)
  if (
    resolved &&
    !insideExcluded(resolved.node, root) &&
    (resolved.node.nodeType !== Node.TEXT_NODE ||
      !isHidden(resolved.node, root))
  )
    return encoded
  return endpoint
}

function changeSiteIntent(capture: UndoRestoreCapture): RestoreIntent | null {
  const site = findChangeSite(
    projectBlocks(parseSnapshot(capture.previousHtml)),
    projectBlocks(parseSnapshot(capture.restoredHtml)),
    capture.isRedo,
  )
  const block = site && liveBlock(capture.root, site)
  return block && site
    ? intentFor(capture.root, endpointIn(block, site.offset, site.forward))
    : null
}

function focusIntent(
  root: HTMLElement,
  focus: BlockIntent | null,
): RestoreIntent | null {
  if (!focus) return null
  const resolved = resolveCaretIntent(focus, root)
  if (
    !resolved ||
    resolved.node === root ||
    insideExcluded(resolved.node, root)
  )
    return null
  return focus
}

// Literal offset zero of the first editable block. caret.ts's 'document-start' intent resolves to
// the END of the first text node, so it is only the deferred fallback for a blockless root, where
// the gap and caret authorities establish the first block.
function documentStartIntent(root: HTMLElement): RestoreIntent {
  for (const child of Array.from(root.children)) {
    if (child.matches(MARKER) || child.matches(EXCLUDED)) continue
    return intentFor(root, endpointIn(child, 0, true)) ?? 'document-start'
  }
  return 'document-start'
}

function focusBookmark(root: HTMLElement): BlockIntent | null {
  const selection = window.getSelection()
  const node = selection?.focusNode
  if (!selection || !node || node === root || !root.contains(node)) return null
  if (insideExcluded(node, root)) return null
  return encode(root, node, selection.focusOffset)
}

function isUsableMarker(root: HTMLElement, marker: Element): boolean {
  if (insideExcluded(marker, root)) return false
  if (marker.parentElement !== root) return true
  // A root-level marker can stand only for an empty document.
  return Array.from(root.children).every((child) => child.matches(MARKER))
}

function usableMarker(root: HTMLElement): boolean {
  let usable = false
  for (const marker of Array.from(root.querySelectorAll('wbr'))) {
    if (isUsableMarker(root, marker)) usable = true
    else marker.remove()
  }
  return usable
}

const activeRoot = () =>
  activeModeElement((window as unknown as { vditor?: unknown }).vditor)

let restoreGeneration = 0
let revealFrame = 0
let revealTimer = 0

function cancelReveal(): void {
  if (revealFrame) cancelAnimationFrame(revealFrame)
  if (revealTimer) clearTimeout(revealTimer)
  revealFrame = 0
  revealTimer = 0
}

function viewportOf(scroller: HTMLElement) {
  if (
    scroller === document.scrollingElement ||
    scroller === document.documentElement
  )
    return {
      top: 0,
      bottom: window.innerHeight,
      left: 0,
      right: window.innerWidth,
    }
  return scroller.getBoundingClientRect()
}

// Whether the caret's block still has its rendering skipped (a content-visibility placeholder).
function contentSkipped(range: Range): boolean {
  const node = range.startContainer
  const el =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return (
    typeof el?.checkVisibility === 'function' &&
    !el.checkVisibility({ contentVisibilityAuto: true })
  )
}

type RevealOutcome = 'shown' | 'scrolled' | 'pending'

// Scroll just enough to show the caret line: nearest edge vertically, and horizontally only when
// the caret is entirely outside the view. A visible caret leaves the scroll position alone; one
// that is in view but not laid out yet, or not measurable, is 'pending'.
function revealCaret(root: HTMLElement): RevealOutcome {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return 'pending'
  const range = selection.getRangeAt(0)
  if (range.startContainer === root || !root.contains(range.startContainer))
    return 'pending'
  const rect = caretLineRect(range)
  if (!rect || rect.height <= 0) return 'pending'
  const scroller = findScroller(root)
  const view = viewportOf(scroller)
  let dy = 0
  if (rect.top < view.top + REVEAL_MARGIN)
    dy = rect.top - (view.top + REVEAL_MARGIN)
  else if (rect.bottom > view.bottom - REVEAL_MARGIN)
    dy = rect.bottom - (view.bottom - REVEAL_MARGIN)
  let dx = 0
  if (rect.right < view.left) dx = rect.left - (view.left + REVEAL_MARGIN)
  else if (rect.left > view.right)
    dx = rect.right - (view.right - REVEAL_MARGIN)
  if (!dy && !dx) return contentSkipped(range) ? 'pending' : 'shown'
  // A toolbar click's scroll pin must not pull this intentional reveal back.
  markIntentionalHistoryReveal()
  scroller.scrollTop += dy
  scroller.scrollLeft += dx
  return 'scrolled'
}

// Until the caret line is shown, re-measure on the task after the next rendering update (when the
// blocks a scroll passed have their real height) and correct, at most REVEAL_STEPS times. Dropped
// after a newer restore, a root or mode change, a composition, or a user gesture (which
// invalidates the authority's intent).
function revealChangeSite(
  root: HTMLElement,
  generation: number,
  step = 0,
): void {
  if (revealCaret(root) === 'shown' || step >= REVEAL_STEPS) return
  revealFrame = requestAnimationFrame(() => {
    revealFrame = 0
    revealTimer = window.setTimeout(() => {
      revealTimer = 0
      if (
        generation !== restoreGeneration ||
        activeRoot() !== root ||
        isCompositionActive() ||
        !hasLiveCaretIntent()
      )
        return
      revealChangeSite(root, generation, step + 1)
    })
  })
}

function restore(capture: UndoRestoreCapture): boolean {
  restoreGeneration++
  cancelReveal()
  const request = window.__vmdeRequestCaret
  // Without the caret authority, upstream's (guarded) collapse stays in charge.
  if (!request) return false
  const { root } = capture
  // Handled without placing anything: a stale root or an active IME composition must not be
  // focused or armed, and upstream's collapse would put the selection outside the editor.
  if (!root.isConnected || activeRoot() !== root || isCompositionActive())
    return true
  const site = changeSiteIntent(capture)
  const intent =
    site ?? focusIntent(root, capture.focus) ?? documentStartIntent(root)
  // requestCaret does not focus; the marker path's setRangeByWbr moves focus the same way.
  root.focus({ preventScroll: true })
  request(intent)
  if (site) revealChangeSite(root, restoreGeneration)
  return true
}

const bridge: UndoRestoreCaretBridge = {
  capture: (root, previousHtml, restoredHtml, isRedo) => ({
    root,
    previousHtml,
    restoredHtml,
    isRedo,
    focus: focusBookmark(root),
  }),
  usableMarker,
  restore,
}

declare global {
  interface Window {
    // Bridge for PATCHED VENDORED Vditor source (media-src/esbuild-shared.mjs's
    // patchUndoRestoreCaretFallback, Task 597), which is outside the webview's TS module graph
    // (ADR-0004) — the same pattern as __vmdeRequestCaret.
    __vmdeUndoRestoreCaret?: UndoRestoreCaretBridge
  }
}

/** Install the bridge the patched Vditor undo module calls (Task 597). Idempotent; main.ts calls it
 *  right after installCaretWindowBridge. */
export function installUndoRestoreCaret(): void {
  window.__vmdeUndoRestoreCaret = bridge
}

// Test-only: drop a pending reveal frame and forget earlier restores.
export function resetUndoRestoreCaretForTests(): void {
  cancelReveal()
  restoreGeneration = 0
}
