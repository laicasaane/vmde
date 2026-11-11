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
  if (!changes || changes.length === 0) return 0

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
