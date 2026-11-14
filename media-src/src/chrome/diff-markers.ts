// Git gutter rendering for the WYSIWYG/IR view (task 17) and full Preview (task 721).
//
// The host computes an exact line diff vs git HEAD (src/git-diff.ts) and posts
// `diff-info` with change ranges. Here we map each top-level editor block back to
// its source line range (same sample+indexOf trick as the cursor mapping) and
// render an absolutely-positioned bar for the blocks that overlap a change.
//
// Split into a pure core (computeBlockMarkers) that is unit-tested, and a DOM
// wrapper (renderDiffMarkers) covered by e2e on the real editor.

import { deferWhilePaused } from '../util/observe-coalesce'
import { writeQuietly } from '../util/mutation-impact'
import { activeModeElement } from '../util/source-map'
import {
  onUnitFeed,
  unitFeedOf,
  type UnitFeed,
  type UnitLines,
} from '../util/unit-changes'

export interface DiffChange {
  startLine: number
  endLine: number
  type: 'added' | 'removed' | 'modified'
}

// Geometry + text of one top-level block, as the pure core sees it.
export interface BlockBox {
  text: string
  top: number
  height: number
}

interface BlockMarker {
  top: number
  height: number
  type: DiffChange['type']
}

const BLOCK_SAMPLE = 25
const PRIORITY: Record<DiffChange['type'], number> = {
  removed: 3,
  modified: 2,
  added: 1,
}

// Locate a block's source line span by finding the first BLOCK_SAMPLE chars of
// its text in the markdown. Returns null when the text is empty or not found.
function blockLineRange(
  blockText: string,
  md: string,
): { startLine: number; lineCount: number } | null {
  const trimmed = blockText.trim()
  if (!trimmed) return null
  // A top-level list's DOM textContent concatenates adjacent <li> text without the Markdown
  // marker/newline between them. Prefer the full discriminator, then shorten only when that exact
  // DOM-shaped sample cannot exist in the source (for example, "first itemsecond item").
  const sampleLengths = [BLOCK_SAMPLE, 20, 15, 10, 8]
  let idx = -1
  for (const length of sampleLengths) {
    const sample = trimmed.substring(0, length)
    if (!sample) continue
    idx = md.indexOf(sample)
    if (idx >= 0) break
  }
  if (idx < 0) return null
  const startLine = md.substring(0, idx).split('\n').length - 1
  const endIdx = idx + trimmed.length
  const nextNewline = md.indexOf('\n', endIdx)
  const stop = nextNewline >= 0 ? nextNewline : md.length
  const lineCount = md.substring(0, stop).split('\n').length - startLine
  return { startLine, lineCount: Math.max(1, lineCount) }
}

// Pure core: decide the gutter bars. For each block, find overlapping changes
// and keep the highest-priority type.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: per-block overlap scan against every change with a highest-priority-type merge; pre-existing (task 469 baseline)
export function computeBlockMarkers(
  blocks: BlockBox[],
  md: string,
  changes: DiffChange[],
): BlockMarker[] {
  if (changes.length === 0) return []
  const markers: BlockMarker[] = []
  for (const block of blocks) {
    const range = blockLineRange(block.text, md)
    if (!range) continue
    const blockEnd = range.startLine + range.lineCount
    let bestType: DiffChange['type'] | null = null
    let bestPriority = -1
    for (const change of changes) {
      if (change.startLine >= blockEnd) continue
      if (change.endLine <= range.startLine) continue
      const priority = PRIORITY[change.type] ?? 0
      if (priority > bestPriority) {
        bestPriority = priority
        bestType = change.type
      }
    }
    if (bestType) {
      markers.push({ top: block.top, height: block.height, type: bestType })
    }
  }
  return markers
}

const MARKER_CLASS = 'me-diff-marker'
// The changes the Preview layer draws (Task 721, see renderPreviewDiffMarkers below).
let previewChanges: DiffChange[] = []

export function clearDiffMarkers(root: ParentNode = document): void {
  // A document-wide clear (the host dropped the diff) also stops the Preview layer redrawing.
  if (root === document) previewChanges = []
  // The bars are view-only: removing them is quiet, like appending them.
  writeQuietly(() => {
    root.querySelectorAll(`.${MARKER_CLASS}`).forEach((el) => {
      el.remove()
    })
  })
}

// DOM wrapper: read the live block geometry, compute the markers, and render a
// bar per changed block. Returns the number of markers rendered (handy for e2e).
export function renderDiffMarkers(vditor: any, changes: DiffChange[]): number {
  renderPreviewDiffMarkers(vditor, changes ?? [])
  const editor = activeModeElement(vditor)
  if (!editor) return 0
  clearDiffMarkers(editor)
  // The host's latest changes replace any re-render still waiting for confirmed units.
  awaitingUnits = undefined
  if (!changes || changes.length === 0) return 0

  // Task 733 / 006 (Q-28): while the model is live, the units' line ranges replace the whole
  // document serialize and the per-block text matching.
  const viaUnits = renderFromUnits(editor, vditor, changes)
  if (viaUnits !== undefined) return viaUnits

  const md: string = vditor.getValue ? vditor.getValue() : ''
  const blocks: BlockBox[] = []
  const blockEls: HTMLElement[] = []
  for (const child of Array.from(editor.children)) {
    if (!(child instanceof HTMLElement)) continue
    if (child.classList.contains(MARKER_CLASS)) continue
    blocks.push({
      text: child.textContent || '',
      top: child.offsetTop,
      height: child.offsetHeight,
    })
    blockEls.push(child)
  }

  const markers = computeBlockMarkers(blocks, md, changes)
  // ensure the editor is a positioning context so absolute bars anchor to it
  if (getComputedStyle(editor).position === 'static') {
    editor.style.position = 'relative'
  }
  for (const m of markers) {
    const bar = document.createElement('div')
    bar.className = `${MARKER_CLASS} ${MARKER_CLASS}--${m.type}`
    bar.style.top = `${m.top}px`
    bar.style.height = `${m.height}px`
    bar.contentEditable = 'false'
    // A view-only overlay in the IR root without `data-block`: quiet, so the unit-DOM shadow model
    // sees no edit.
    writeQuietly(() => editor.appendChild(bar))
  }
  return markers.length
}

// The feed when it describes this IR editor and the model is live; the WYSIWYG and every other
// case keep the existing path.
function modelFeedFor(editor: HTMLElement, vditor: any): UnitFeed | undefined {
  if (vditor?.vditor?.currentMode !== 'ir') return undefined
  const feed = unitFeedOf(window)
  return feed && feed.root === editor && feed.isLive() ? feed : undefined
}

// The confirmed line ranges, or `undefined` (the existing path). The bars are a display read: they
// never publish pending typing, which would split an Undo transition (Q-60); while typing is
// unpublished the existing path draws them.
function confirmedLinesOf(
  feed: UnitFeed,
  editor: HTMLElement,
): readonly UnitLines[] | undefined | null {
  try {
    if (feed.root !== editor) return null
    const lines = feed.confirmedLines()
    if (!lines) return undefined
    return lines.length > 0 ? lines : null
  } catch {
    // A feed failure must not hide the bars: the existing path draws them.
    return null
  }
}

// The bars from the model units, 0 while they wait for confirmed units, or `undefined` for the
// existing path.
function renderFromUnits(
  editor: HTMLElement,
  vditor: any,
  changes: DiffChange[],
): number | undefined {
  const feed = modelFeedFor(editor, vditor)
  const lines = feed ? confirmedLinesOf(feed, editor) : null
  if (feed && lines) return renderUnitMarkers(editor, feed, lines, changes)
  // Q-60: the bars are a display read and never publish typing. While the live model's units are
  // unconfirmed (`undefined`), the next feed change draws them from the units; the whole-document
  // path would cost a `getValue` per diff for a model that is about to confirm. A feed failure or a
  // foreign root (`null`) keeps the existing path.
  if (feed && lines === undefined) {
    awaitUnits(vditor, changes)
    return 0
  }
  return undefined
}

// The host's last changes, drawn again from the model units at the next feed change (Q-60).
let awaitingUnits: { vditor: any; changes: DiffChange[] } | undefined
// One subscription for the window's feed and every feed provided later.
let subscribed = false

// A confirmation can land with no feed change (the host's answer to a published edit), so the wait
// also checks again on a short timer, a bounded number of times.
const RECHECK_MS = 250
const RECHECKS = 8
let recheckTimer: ReturnType<typeof setTimeout> | undefined
let rechecksLeft = 0

function scheduleRecheck(): void {
  if (recheckTimer !== undefined || rechecksLeft <= 0) return
  rechecksLeft--
  recheckTimer = setTimeout(() => {
    recheckTimer = undefined
    onFeedChange()
    if (awaitingUnits) scheduleRecheck()
  }, RECHECK_MS)
}

function awaitUnits(vditor: any, changes: DiffChange[]): void {
  awaitingUnits = { vditor, changes }
  // A newer diff restarts the re-checks.
  if (recheckTimer !== undefined) clearTimeout(recheckTimer)
  recheckTimer = undefined
  rechecksLeft = RECHECKS
  scheduleRecheck()
  if (subscribed) return
  subscribed = true
  onUnitFeed(window, onFeedChange)
}

function onFeedChange(): void {
  const pending = awaitingUnits
  if (!pending) return
  // R-1: re-read the editor and the feed now; the mode or the root may have changed.
  const editor = activeModeElement(pending.vditor)
  if (!editor || !modelFeedFor(editor, pending.vditor)) {
    awaitingUnits = undefined
    return
  }
  const feed = modelFeedFor(editor, pending.vditor)!
  const lines = confirmedLinesOf(feed, editor)
  // Still unconfirmed: keep waiting for a later change; a failure drops the wait.
  if (lines === undefined) return
  awaitingUnits = undefined
  if (!lines) return
  clearDiffMarkers(editor)
  renderUnitMarkers(editor, feed, lines, pending.changes)
}

// Offset of `el` from the top of `editor`, summed along the offsetParent chain; `undefined` when the
// chain does not reach the editor.
function offsetWithin(
  el: HTMLElement,
  editor: HTMLElement,
): number | undefined {
  let top = 0
  let node: HTMLElement | null = el
  while (node && node !== editor) {
    top += node.offsetTop
    node = node.offsetParent as HTMLElement | null
  }
  return node === editor ? top : undefined
}

// A unit overlaps a change when the change's lines (end exclusive) meet the unit's (end inclusive).
// Highest priority per unit index; the map exists only when a change overlaps.
function markUnits(
  lines: readonly UnitLines[],
  changes: DiffChange[],
): Map<number, DiffChange['type']> | undefined {
  let marked: Map<number, DiffChange['type']> | undefined
  for (const change of changes) {
    // Last unit starting before the change ends, then walk back while units still reach it.
    let lo = 0
    let hi = lines.length - 1
    let at = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (lines[mid]!.startLine <= change.endLine - 1) {
        at = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    for (let i = at; i >= 0 && lines[i]!.endLine >= change.startLine; i--) {
      marked ??= new Map()
      const previous = marked.get(i)
      if (!previous || PRIORITY[change.type] > PRIORITY[previous]) {
        marked.set(i, change.type)
      }
    }
  }
  return marked
}

/**
 * One bar per top-level block, as the existing path draws them: a list item's (or a cell's) bar is
 * its list's (table's). The highest-priority type wins when several units of one block are marked.
 * Blocks come in document order; the walk back from each change collects units last-first.
 */
function markedBlocks(
  feed: UnitFeed,
  lines: readonly UnitLines[],
  marked: Map<number, DiffChange['type']>,
): Map<HTMLElement, { last: HTMLElement; type: DiffChange['type'] }> {
  const blocks = new Map<
    HTMLElement,
    { last: HTMLElement; type: DiffChange['type'] }
  >()
  for (const [index, type] of Array.from(marked).sort((a, b) => a[0] - b[0])) {
    const unit = lines[index]!
    const live = feed.liveUnitOf(unit.el)
    const nested = live?.kind === 'list-item' || live?.kind === 'cell'
    const members = live?.members ?? [unit.el]
    const first = nested ? live.top : members[0]!
    const last = nested ? live.top : members[members.length - 1]!
    const known = blocks.get(first)
    if (!known) blocks.set(first, { last, type })
    else if (PRIORITY[type] > PRIORITY[known.type]) known.type = type
  }
  return blocks
}

function renderUnitMarkers(
  editor: HTMLElement,
  feed: UnitFeed,
  lines: readonly UnitLines[],
  changes: DiffChange[],
): number {
  const marked = markUnits(lines, changes)
  if (!marked) return 0
  // Offsets of nested items depend on the editor being a positioning context, so set it first.
  if (getComputedStyle(editor).position === 'static') {
    editor.style.position = 'relative'
  }
  const blocks = markedBlocks(feed, lines, marked)
  let count = 0
  for (const [first, { last, type }] of blocks) {
    const top = offsetWithin(first, editor)
    const lastTop = offsetWithin(last, editor)
    if (top === undefined || lastTop === undefined) continue
    const bar = document.createElement('div')
    bar.className = `${MARKER_CLASS} ${MARKER_CLASS}--${type}`
    bar.style.top = `${top}px`
    bar.style.height = `${lastTop + last.offsetHeight - top}px`
    bar.contentEditable = 'false'
    writeQuietly(() => editor.appendChild(bar))
    count++
  }
  return count
}

// Task 721: full Preview shows the same change bars, read-only. They go in their own layer inside
// the Preview scroller (`preview.element`), never inside the Preview pane: the pane's children are
// the rendered blocks the Preview morph diffs against its baseline (editing/preview-morph.ts), and a
// foreign child would shift that diff. Bars are placed from measured rectangles, so a centred,
// width-limited pane and folded (hidden, zero-height) blocks are both placed right.
const PREVIEW_LAYER_CLASS = 'me-diff-layer'

function fullPreviewPanes(
  vditor: any,
): { scroller: HTMLElement; pane: HTMLElement } | null {
  const inner = vditor?.vditor
  const mode = inner?.currentMode
  const scroller = inner?.preview?.element
  const pane = inner?.preview?.previewElement
  // Vditor resets the Preview pane to `display: none` on every IR/WYSIWYG entry, so `block` in
  // those modes means full Preview; Split (sv) keeps no bars, as before.
  if (
    (mode !== 'ir' && mode !== 'wysiwyg') ||
    !(scroller instanceof HTMLElement) ||
    !(pane instanceof HTMLElement) ||
    scroller.style.display !== 'block'
  )
    return null
  return { scroller, pane }
}

/** Draw the bars for `changes` over the full Preview pane, or remove them when Preview is not
 *  shown. Returns the number of bars drawn. */
export function renderPreviewDiffMarkers(
  vditor: any,
  changes: DiffChange[],
): number {
  previewChanges = changes
  const panes = fullPreviewPanes(vditor)
  const inner = vditor?.vditor
  const existing = inner?.preview?.element?.querySelector?.(
    `:scope > .${PREVIEW_LAYER_CLASS}`,
  ) as HTMLElement | null
  if (!panes || changes.length === 0) {
    existing?.remove()
    return 0
  }
  const { scroller, pane } = panes
  const layer = existing ?? document.createElement('div')
  layer.className = PREVIEW_LAYER_CLASS
  layer.replaceChildren()
  if (!existing) scroller.append(layer)
  if (getComputedStyle(scroller).position === 'static')
    scroller.style.position = 'relative'
  const origin = scroller.getBoundingClientRect()
  const paneBox = pane.getBoundingClientRect()
  // Scroller coordinates: a rectangle's offset from the scroller's box plus its scroll offset.
  const top = (rect: DOMRect) => rect.top - origin.top + scroller.scrollTop
  layer.style.left = `${paneBox.left - origin.left + scroller.scrollLeft}px`
  const blocks: BlockBox[] = Array.from(pane.children).map((child) => {
    const rect = child.getBoundingClientRect()
    return {
      text: child.textContent || '',
      top: top(rect),
      height: rect.height,
    }
  })
  const md: string = vditor.getValue ? vditor.getValue() : ''
  const markers = computeBlockMarkers(blocks, md, changes)
  for (const m of markers) {
    if (m.height <= 0) continue
    const bar = document.createElement('div')
    bar.className = `${MARKER_CLASS} ${MARKER_CLASS}--${m.type}`
    bar.style.top = `${m.top}px`
    bar.style.height = `${m.height}px`
    layer.appendChild(bar)
  }
  return layer.childElementCount
}

/** Keep the Preview bars in step with the Preview: redraw after it is shown or hidden, after each
 *  render, and after a fold changes block heights. Returns a disposer. */
export function observePreviewDiffMarkers(vditor: any): () => void {
  const inner = vditor?.vditor
  const scroller = inner?.preview?.element
  const pane = inner?.preview?.previewElement
  if (!(scroller instanceof HTMLElement) || !(pane instanceof HTMLElement))
    return () => undefined
  let frame = 0
  const redraw = () => {
    if (frame || previewChanges.length === 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      // A streaming Preview render holds decorating observers back until its last chunk.
      if (!deferWhilePaused(draw)) draw()
    })
  }
  const draw = () => {
    renderPreviewDiffMarkers(vditor, previewChanges)
  }
  const observer = new MutationObserver(redraw)
  observer.observe(scroller, { attributes: true, attributeFilter: ['style'] })
  observer.observe(pane, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-vmde-fold-hidden'],
  })
  return () => {
    observer.disconnect()
    if (frame) cancelAnimationFrame(frame)
  }
}
