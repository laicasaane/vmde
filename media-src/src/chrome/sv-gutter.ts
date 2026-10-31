// Task 645 — line numbers for the Split View source pane (`.vditor-sv`).
//
// The pane is one editable block of Lute spans that is also its own scroll container, so the numbers
// cannot live inside it: they would reach Undo snapshots, Find, copy and the save path, and the
// editor-area mutation observers would fire on every update. Instead one aria-hidden overlay under
// <body> sits over the pane's left padding. Its inner layer is translated by the pane's scrollTop and
// holds labels only for a window of rows around the viewport, so pure scrolling costs a transform.
//
// Geometry is read in two passes, both coalesced into one requestAnimationFrame:
//  - the global pass reads every line break once to count the lines, estimates each line's rows from
//    the distance to the previous break, and measures exactly only the lines that look wrapped, to
//    find the widest sub-number (and with it the gutter width);
//  - the window pass measures the rows of the lines near the viewport and draws their labels.
// The current-row highlight (Task 645) needs no overlay: the pane paints a band with its own
// `background-attachment: local` gradient, and the caret's row position travels in two variables on
// the same CSSOM rule. It is recomputed on selection, focus and edit changes.
// Nothing is written inside `.vditor`; the one variable the pane's padding needs goes through a
// CSSOM rule in a <style> element in <head>.
import {
  type GutterLabel,
  estimateRowCount,
  groupRows,
  gutterColumns,
  maxSubNumber,
  planLabels,
  currentRowBand,
  type RowBox,
} from './sv-gutter-plan'

export interface SourcePaneOptions {
  lineNumbers: boolean
  currentLine: boolean
}

interface Stats {
  globalPasses: number
  windowPasses: number
  labelWrites: number
}

const PANE_SELECTOR = '.vditor-sv'
const STATE_STYLE_ID = 'vmde-sv-pane-state'
const GUTTER_COLUMNS_PROPERTY = '--vmde-sv-gutter-ch'
const LISTEN_OPTIONS: AddEventListenerOptions = { passive: true }
const UNLISTEN_OPTIONS: EventListenerOptions = { capture: false }

let options: SourcePaneOptions = { lineNumbers: false, currentLine: false }
let pane: HTMLElement | null = null
let overlay: HTMLElement | null = null
let layer: HTMLElement | null = null
let stateRule: CSSStyleRule | null = null
let stateStyle: HTMLStyleElement | null = null
let mutationObserver: MutationObserver | null = null
let resizeObserver: ResizeObserver | null = null
let watcher: MutationObserver | null = null
let frame = 0
let idle = 0
let idleIsTimer = false
let needGlobal = false
let columns = 0
// Widest sub-number of the last global pass; the quick path after an edit reuses it.
let widestSub = 0
// Set by edits: the line breaks are read again before the next window pass.
let needLines = false
let globalTimer = 0
const EDIT_GLOBAL_DELAY_MS = 250
// What the mounted controller was built for; a change of either option mounts again.
let mountedFor: SourcePaneOptions = { lineNumbers: false, currentLine: false }
// Rendered window in pane content coordinates (pixels from the top of the scrollable content).
let renderedFrom = 0
let renderedTo = 0
let lineBreaks: HTMLElement[] = []
// Exact rows of the lines that looked wrapped in the last global pass, by line index.
let wrappedRows = new Map<number, number>()

function stats(): Stats {
  const w = window as unknown as { __vmdeSvGutterStats?: Stats }
  if (!w.__vmdeSvGutterStats)
    w.__vmdeSvGutterStats = { globalPasses: 0, windowPasses: 0, labelWrites: 0 }
  return w.__vmdeSvGutterStats
}

function paneVisible(candidate: HTMLElement | null): candidate is HTMLElement {
  return (
    !!candidate && candidate.isConnected && candidate.style.display !== 'none'
  )
}

function ensureStateRule(): void {
  if (stateRule) return
  stateStyle = document.createElement('style')
  stateStyle.id = STATE_STYLE_ID
  document.head.appendChild(stateStyle)
  try {
    const sheet = stateStyle.sheet as CSSStyleSheet | null
    sheet?.insertRule(`${PANE_SELECTOR} {}`, 0)
    stateRule = (sheet?.cssRules[0] as CSSStyleRule | undefined) ?? null
  } catch {
    stateRule = null
  }
}

function setColumns(next: number): boolean {
  const changed = next !== columns
  columns = next
  stateRule?.style.setProperty(GUTTER_COLUMNS_PROPERTY, String(next))
  layer?.style.setProperty('width', `calc(${next} * 1ch)`)
  return changed
}

function cancelScheduled(): void {
  if (frame) cancelAnimationFrame(frame)
  if (idle) {
    if (idleIsTimer) clearTimeout(idle)
    else cancelIdleCallback(idle)
  }
  frame = 0
  idle = 0
}

function schedule(global: boolean): void {
  if (!pane) return
  needGlobal ||= global
  if (frame || idle) return
  // After the frame that painted the edit: running inside it would add this work to the typed
  // character's own frame. The idle callback is bounded so the gutter never lags for long.
  frame = requestAnimationFrame(() => {
    frame = 0
    idleIsTimer = typeof requestIdleCallback !== 'function'
    idle = idleIsTimer
      ? window.setTimeout(run, 0)
      : requestIdleCallback(run, { timeout: 120 })
  })
}

function onScroll(): void {
  if (!pane || !layer) return
  layer.style.transform = `translateY(${-pane.scrollTop}px)`
  const top = pane.scrollTop
  if (top < renderedFrom || top + pane.clientHeight > renderedTo)
    schedule(false)
}

function onFontsLoaded(): void {
  schedule(true)
}

// An edit changes the lines and maybe their wrapping. Typing must stay cheap on a large document,
// so each edit re-reads the line breaks and redraws the window now (a few milliseconds), and the
// exact wrap survey that sizes the gutter runs once the typing pauses.
function onEdit(): void {
  needLines = true
  schedule(false)
  clearTimeout(globalTimer)
  globalTimer = window.setTimeout(() => {
    globalTimer = 0
    schedule(true)
  }, EDIT_GLOBAL_DELAY_MS)
}

function onCaretChange(): void {
  schedule(false)
}

function mount(target: HTMLElement): void {
  pane = target
  mountedFor = { ...options }
  ensureStateRule()
  if (options.lineNumbers) {
    overlay = document.createElement('div')
    overlay.className = 'vmde-sv-gutter'
    overlay.setAttribute('aria-hidden', 'true')
    layer = document.createElement('div')
    layer.className = 'vmde-sv-gutter__layer'
    overlay.appendChild(layer)
    document.body.appendChild(overlay)
    pane.addEventListener('scroll', onScroll, LISTEN_OPTIONS)
    document.fonts?.addEventListener?.('loadingdone', onFontsLoaded)
  }
  if (options.currentLine) {
    document.addEventListener('selectionchange', onCaretChange)
    pane.addEventListener('focus', onCaretChange)
    pane.addEventListener('blur', onCaretChange)
  }
  mutationObserver = new MutationObserver(onEdit)
  mutationObserver.observe(pane, {
    childList: true,
    characterData: true,
    subtree: true,
  })
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => schedule(true))
    resizeObserver.observe(pane)
  }
  schedule(true)
}

function unmount(): void {
  cancelScheduled()
  clearTimeout(globalTimer)
  globalTimer = 0
  needGlobal = false
  needLines = false
  if (pane) {
    pane.removeEventListener('scroll', onScroll, UNLISTEN_OPTIONS)
    pane.removeEventListener('focus', onCaretChange)
    pane.removeEventListener('blur', onCaretChange)
  }
  document.removeEventListener('selectionchange', onCaretChange)
  document.fonts?.removeEventListener?.('loadingdone', onFontsLoaded)
  mutationObserver?.disconnect()
  resizeObserver?.disconnect()
  mutationObserver = null
  resizeObserver = null
  overlay?.remove()
  stateStyle?.remove()
  overlay = null
  layer = null
  stateStyle = null
  stateRule = null
  lineBreaks = []
  wrappedRows = new Map()
  columns = 0
  renderedFrom = 0
  renderedTo = 0
  pane = null
}

// Watches only the pane's own `style`/`class` (mode switches hide it; streaming marks it), never
// its text, so a hidden pane can mount again when it is shown.
function watchPane(target: HTMLElement | null): void {
  if (!target) {
    watcher?.disconnect()
    watcher = null
    return
  }
  if (!watcher) watcher = new MutationObserver(sync)
  watcher.disconnect()
  watcher.observe(target, {
    attributes: true,
    attributeFilter: ['style', 'class'],
  })
}

// Mount while line numbers or the current-row highlight are on and the pane is shown; unmount
// otherwise or when the set of active features changed.
function sync(): void {
  const target = document.querySelector<HTMLElement>(PANE_SELECTOR)
  const active = options.lineNumbers || options.currentLine
  if (active && paneVisible(target)) {
    const changed =
      mountedFor.lineNumbers !== options.lineNumbers ||
      mountedFor.currentLine !== options.currentLine
    if (pane !== target || changed) {
      if (pane) unmount()
      mount(target)
    }
  } else if (pane) unmount()
  watchPane(active ? target : null)
}

function readLineBreaks(target: HTMLElement): HTMLElement[] {
  return Array.from(
    target.querySelectorAll<HTMLElement>('[data-type="newline"]'),
  )
}

function breakRect(lineBreak: HTMLElement): DOMRect {
  return (lineBreak.firstElementChild ?? lineBreak).getBoundingClientRect()
}

// Exact visual rows of line `index`: the rects between the previous break and this one, grouped by
// top; an empty line has no text rects, so its own break marks the row.
function exactRows(
  target: HTMLElement,
  index: number,
  offset: number,
): RowBox[] {
  const range = document.createRange()
  if (index === 0) range.setStart(target, 0)
  else range.setStartAfter(lineBreaks[index - 1])
  range.setEndBefore(lineBreaks[index])
  const rects: RowBox[] = []
  // jsdom (unit tests) has no layout and no Range.getClientRects.
  const measured = range.getClientRects?.() ?? []
  for (const rect of measured)
    if (rect.height > 0 && rect.width > 0)
      rects.push({ top: rect.top + offset, bottom: rect.bottom + offset })
  const rows = groupRows(rects)
  if (rows.length) return rows
  const rect = breakRect(lineBreaks[index])
  return [{ top: rect.top + offset, bottom: rect.bottom + offset }]
}

function placeOverlay(target: HTMLElement): void {
  if (!overlay) return
  const rect = target.getBoundingClientRect()
  const style = getComputedStyle(target)
  overlay.style.left = `${rect.left + target.clientLeft}px`
  overlay.style.top = `${rect.top + target.clientTop}px`
  overlay.style.width = `${parseFloat(style.paddingLeft) || 0}px`
  overlay.style.height = `${target.clientHeight}px`
  overlay.style.fontFamily = style.fontFamily
  overlay.style.fontSize = style.fontSize
}

// Counts the lines and finds the widest sub-number. Returns whether the gutter width changed, which
// reflows the pane's text (its left padding follows the width), so the caller measures again.
function globalPass(target: HTMLElement): boolean {
  stats().globalPasses++
  lineBreaks = readLineBreaks(target)
  wrappedRows = new Map()
  const style = getComputedStyle(target)
  const pitch = parseFloat(style.lineHeight)
  const rect = target.getBoundingClientRect()
  let previousBottom =
    rect.top + target.clientTop + (parseFloat(style.paddingTop) || 0)
  const counts: number[] = []
  const origin = -(rect.top + target.clientTop) + target.scrollTop
  for (let i = 0; i < lineBreaks.length; i++) {
    const bottom = breakRect(lineBreaks[i]).bottom
    if (estimateRowCount(bottom - previousBottom, pitch) > 1) {
      const rows = exactRows(target, i, origin).length
      wrappedRows.set(i, rows)
      counts.push(rows)
    }
    previousBottom = bottom
  }
  placeOverlay(target)
  widestSub = maxSubNumber(counts)
  return setColumns(gutterColumns(lineBreaks.length, widestSub))
}

function windowPass(target: HTMLElement): void {
  if (!layer) return
  stats().windowPasses++
  const rect = target.getBoundingClientRect()
  const viewport = target.clientHeight
  const origin = -(rect.top + target.clientTop) + target.scrollTop
  const scrollTop = target.scrollTop
  renderedFrom = scrollTop - viewport
  renderedTo = scrollTop + 2 * viewport
  // First line whose break ends below the window top (binary search on the break rects).
  let low = 0
  let high = lineBreaks.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (breakRect(lineBreaks[mid]).bottom + origin < renderedFrom) low = mid + 1
    else high = mid
  }
  const planned: { line: number; rows: RowBox[] }[] = []
  for (let i = low; i < lineBreaks.length; i++) {
    const rows = exactRows(target, i, origin)
    planned.push({ line: i + 1, rows })
    if (rows[rows.length - 1].top > renderedTo) break
  }
  const fragment = document.createDocumentFragment()
  const labels = planLabels(planned)
  for (const label of labels) fragment.appendChild(labelElement(label))
  layer.replaceChildren(fragment)
  layer.style.transform = `translateY(${-scrollTop}px)`
  stats().labelWrites += labels.length
}

function labelElement(label: GutterLabel): HTMLElement {
  const element = document.createElement('div')
  element.style.top = `${label.top}px`
  element.style.height = `${label.height}px`
  element.style.lineHeight = `${label.height}px`
  if (label.kind === 'line') {
    element.className = 'vmde-sv-gutter__num'
    element.textContent = label.text
  } else {
    element.className = 'vmde-sv-gutter__sub'
    const mark = document.createElement('span')
    mark.className = 'vmde-sv-gutter__mark'
    mark.textContent = '↳'
    const number = document.createElement('span')
    number.className = 'vmde-sv-gutter__subnum'
    number.textContent = label.text
    element.append(mark, number)
  }
  return element
}

// The pane's row box for a collapsed caret. A caret at an element boundary has no client rect of its
// own: an empty line reports its line break, a caret after the last character of a text span reports
// the last rect of that span's contents.
function caretRow(range: Range): RowBox | null {
  const own = range.getClientRects?.()[0]
  if (own && own.height > 0) return { top: own.top, bottom: own.bottom }
  const container = range.startContainer
  const element =
    container.nodeType === Node.ELEMENT_NODE
      ? (container as HTMLElement)
      : container.parentElement
  if (!element) return null
  const lineBreak = element.closest('[data-type="newline"]')
  if (lineBreak) {
    const rect = breakRect(lineBreak as HTMLElement)
    return { top: rect.top, bottom: rect.bottom }
  }
  const contents = document.createRange()
  contents.selectNodeContents(element)
  const rects = contents.getClientRects?.()
  const last = rects?.[rects.length - 1]
  return last ? { top: last.top, bottom: last.bottom } : null
}

function caretRange(target: HTMLElement): Range | null {
  const selection = getSelection()
  if (
    document.activeElement !== target ||
    !selection ||
    !selection.rangeCount ||
    !selection.isCollapsed
  )
    return null
  const range = selection.getRangeAt(0)
  return target.contains(range.startContainer) ? range : null
}

// Line height of the row the caret is in: headings use their own, so ask the caret's element and
// fall back to the pane's when the element has none (`normal`, or no layout).
function rowLineHeight(range: Range, target: HTMLElement): number {
  const container = range.startContainer
  const owner =
    container.nodeType === Node.ELEMENT_NODE
      ? (container as HTMLElement)
      : container.parentElement
  const own = owner
    ? parseFloat(getComputedStyle(owner).lineHeight)
    : Number.NaN
  return Number.isFinite(own)
    ? own
    : parseFloat(getComputedStyle(target).lineHeight)
}

// Writes the band for the caret's visual row, or hides it (height 0) unless the pane has focus and
// the selection is a collapsed caret inside it.
function updateBand(target: HTMLElement): void {
  if (!stateRule) return
  let band: { top: number; height: number } | null = null
  const range = caretRange(target)
  const row = range ? caretRow(range) : null
  if (range && row) {
    const rect = target.getBoundingClientRect()
    band = currentRowBand(
      row,
      rowLineHeight(range, target),
      rect.top + target.clientTop,
      target.scrollTop,
    )
  }
  stateRule.style.setProperty('--vmde-sv-row-top', `${band?.top ?? 0}px`)
  stateRule.style.setProperty('--vmde-sv-row-height', `${band?.height ?? 0}px`)
}

// Cheap update after an edit: the new line count (and so the line-number digits) without surveying
// the wrapping of every line.
function refreshLines(target: HTMLElement): boolean {
  lineBreaks = readLineBreaks(target)
  return setColumns(gutterColumns(lineBreaks.length, widestSub))
}

function run(): void {
  idle = 0
  const target = pane
  if (!target) return
  if (target.classList.contains('vmde-streaming')) return
  const global = needGlobal
  needGlobal = false
  if (overlay) {
    if (global) {
      // A changed width reflows the text; measure once more against the new layout.
      if (globalPass(target)) globalPass(target)
    } else {
      // A changed digit count reflows the text, so survey the wrapping again.
      // The overlay only moves with the pane's box, which the resize observer reports.
      if (needLines && refreshLines(target)) globalPass(target)
    }
    needLines = false
    windowPass(target)
  }
  if (options.currentLine) updateBand(target)
}

/** Apply the Split View source pane options; called from applyBodyOptions on every config change. */
export function setSourcePaneOptions(next: SourcePaneOptions): void {
  options = { ...next }
  sync()
}

/** Run a pending update now. Tests use it instead of waiting for the next animation frame. */
export function flushSourceGutter(): void {
  if (!pane) return
  cancelScheduled()
  needGlobal = true
  run()
}
