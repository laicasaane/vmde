// Responsive-table normalization (split out of utils.ts, 185/3g).
//
// Vditor (and pasted HTML) pins tables with explicit width attributes/styles; normalize them
// to fluid `table-layout:fixed; width:100%` so tables track the column. Re-asserted on window
// resize, DOM mutations (Vditor rebuilds tables per keystroke), and container resizes.

import { debounce } from '../util/debounce'
import {
  classifyEditorMutations,
  recordHelperMutationPass,
} from '../util/mutation-impact'
import { allocateColumnWidths } from './table-column-widths'
import {
  AUTO_WIDTH_CLASS_PREFIX,
  createMeasureHost,
  ensureSessionTableWidths,
  headerCells,
  MIN_TABLE_COLUMN_WIDTH,
  mountMeasureClone,
  sessionTableWidths,
} from './table-resize'
import { findScroller } from './toolbar-scroll-guard'

let responsiveTableCleanup: (() => void) | null = null

// ---------------------------------------------------------------------------------------------
// Task 639 — content-aware column widths. View-only: a class on the table plus one head <style>
// of non-important `nth-child` width rules per table. Nothing enters a colgroup, the Lute DOM,
// the markdown, the host bytes, the dirty state or Undo. A manual resize (Task 219 session
// widths) always wins. Source-view tables are not under `.vditor-reset`, so they are untouched.
// ---------------------------------------------------------------------------------------------

/** Typing pause before a table that is being edited is measured again. */
const AUTO_PAUSE_MS = 600
/** Debounce for width-change and visibility triggers (the same cadence as the normalizer). */
const AUTO_SOON_MS = 16
/** A recompute that moves every column by less than this is dropped (hysteresis). */
const AUTO_MOVE_PX = 2
/** A table width change below this does not count as a width change. */
const AUTO_WIDTH_CHANGE_PX = 1

type Stale = 'none' | 'width' | 'content'

interface AutoState {
  className: string
  style: HTMLStyleElement
  widths: number[]
  /** Table width the widths were allocated for. */
  width: number
  stale: Stale
}

interface Candidate {
  table: HTMLTableElement
  width: number
  /** Table width minus the sum of its first-row cells: the collapsed outer border. */
  overhead: number
  columns: number
}

interface SurfaceObserver {
  scroller: HTMLElement
  observer: IntersectionObserver
}

interface AutoTableWidths {
  /** Start of a normalization pass; a full pass refreshes the scroller lookups once per surface. */
  beginPass(full: boolean): void
  /** Register a table found by a normalization pass. */
  track(table: HTMLTableElement): void
  /** A full pass ran (window or container resize): every table may have a new width. */
  onFullPass(): void
  dispose(): void
}

// Used where there is no IntersectionObserver (unit-test DOMs): every call does nothing.
const INERT_AUTO_WIDTHS: AutoTableWidths = {
  beginPass: () => undefined,
  track: () => undefined,
  onFullPass: () => undefined,
  dispose: () => undefined,
}

let nextAutoWidthId = 0

/**
 * An Undo/Redo restore brings back the class tokens of an older render; only the table's own
 * current class may stay.
 */
function dropStaleAutoClasses(
  table: HTMLTableElement,
  state: AutoState | undefined,
): void {
  for (const name of Array.from(table.classList))
    if (name.startsWith(AUTO_WIDTH_CLASS_PREFIX) && name !== state?.className)
      table.classList.remove(name)
}

/**
 * The element whose scrollport clips the surface. The surface itself when it is a scroll
 * container, whether or not it overflows yet (a surface that has not overflowed yet would
 * otherwise fall back to the viewport, and an ancestor that clips it would hide every table below
 * the fold from the observer); otherwise the nearest overflowing ancestor.
 */
function resolveScroller(surface: HTMLElement): HTMLElement {
  const overflow = getComputedStyle(surface).overflowY
  return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay'
    ? surface
    : findScroller(surface)
}

function owningTable(node: Node): HTMLTableElement | null {
  const element = node instanceof Element ? node : node.parentElement
  return element?.closest('table') ?? null
}

function tablesWithin(node: Node): HTMLTableElement[] {
  if (!(node instanceof Element)) return []
  return [
    ...(node instanceof HTMLTableElement ? [node] : []),
    ...Array.from(node.querySelectorAll<HTMLTableElement>('table')),
  ]
}

/**
 * Min-content and max-content width of every column, read from detached clones in the shared
 * measurement host (see `createMeasureHost`): the two layouts the contract names, read from the
 * first-row cell widths.
 */
function measureColumns(
  tables: HTMLTableElement[],
  root: HTMLElement,
): Array<{ min: number[]; max: number[] }> {
  const host = createMeasureHost(root)
  try {
    const clones = tables.map((table) =>
      mountMeasureClone(table, root, host.element),
    )
    const read = (kind: 'max' | 'min'): number[][] => {
      host.layout(kind)
      return clones.map((clone) =>
        Array.from(
          clone.rows[0].cells,
          (cell) => cell.getBoundingClientRect().width,
        ),
      )
    }
    const max = read('max')
    const min = read('min')
    return tables.map((_, index) => ({ min: min[index], max: max[index] }))
  } finally {
    host.dispose()
  }
}

// The factory owns one closure of mutable tracking state; its pieces are small named functions.
function createAutoTableWidths(root: HTMLElement): AutoTableWidths {
  if (typeof IntersectionObserver === 'undefined') return INERT_AUTO_WIDTHS

  const states = new WeakMap<HTMLTableElement, AutoState>()
  const owned = new Set<HTMLTableElement>()
  const tracked = new Map<HTMLTableElement, HTMLElement>()
  const near = new Set<HTMLTableElement>()
  const holds = new WeakMap<HTMLTableElement, number>()
  const surfaces = new Map<HTMLElement, SurfaceObserver>()
  const freshSurfaces = new Set<HTMLElement>()
  /** Latest end of a typing pause that a flush had to skip. */
  let heldUntil = 0
  let pauseTimer: ReturnType<typeof setTimeout> | undefined

  function onIntersection(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const table = entry.target as HTMLTableElement
      if (!tracked.has(table)) continue
      if (entry.isIntersecting) {
        near.add(table)
        // A table that scrolls back near (or reappears after a mode switch) may have a new width.
        const state = states.get(table)
        if (state?.stale === 'none') state.stale = 'width'
      } else near.delete(table)
    }
    soon()
  }

  function createObserver(scroller: HTMLElement): IntersectionObserver {
    const isDocument =
      scroller === document.scrollingElement ||
      scroller === document.documentElement
    // About one viewport of margin above and below: tables just outside the view are ready
    // before they scroll in, while far tables are never measured.
    return new IntersectionObserver(onIntersection, {
      root: isDocument ? null : scroller,
      rootMargin: '100% 0px',
      threshold: 0,
    })
  }

  /** The IntersectionObserver rooted on the surface's scroller; re-rooted when the scroller moves. */
  function observerFor(surface: HTMLElement): IntersectionObserver {
    const existing = surfaces.get(surface)
    if (existing && freshSurfaces.has(surface)) return existing.observer
    freshSurfaces.add(surface)
    // A scroller can change as a document grows, a mode appears or the editor resizes, so it is
    // re-resolved on each full pass (and when a surface is first seen), not on every keystroke.
    const scroller = resolveScroller(surface)
    if (existing?.scroller === scroller) return existing.observer
    existing?.observer.disconnect()
    const entry = { scroller, observer: createObserver(scroller) }
    surfaces.set(surface, entry)
    for (const [table, owner] of tracked)
      if (owner === surface) entry.observer.observe(table)
    return entry.observer
  }

  function track(table: HTMLTableElement): void {
    const surface = table.closest<HTMLElement>('.vditor-reset')
    if (!surface) return
    const observer = observerFor(surface)
    if (!tracked.has(table)) {
      tracked.set(table, surface)
      observer.observe(table)
    }
    const state = states.get(table)
    dropStaleAutoClasses(table, state)
    if (!state) {
      // A rebuilt table (a column added in place) has no cached widths: measure it when near.
      if (near.has(table) && eligible(table)) soon()
    } else if (sessionTableWidths(table)) clearAuto(table)
    else if (!table.classList.contains(state.className))
      table.classList.add(state.className)
  }

  function clearAuto(table: HTMLTableElement): void {
    const state = states.get(table)
    if (!state) return
    table.classList.remove(state.className)
    state.style.remove()
    states.delete(table)
    owned.delete(table)
  }

  function untrack(table: HTMLTableElement): void {
    const surface = tracked.get(table)
    if (!surface) return
    surfaces.get(surface)?.observer.unobserve(table)
    tracked.delete(table)
    near.delete(table)
  }

  function prune(): void {
    for (const table of [...tracked.keys()])
      if (!table.isConnected) {
        untrack(table)
        clearAuto(table)
      }
    for (const table of [...owned]) if (!table.isConnected) clearAuto(table)
    for (const [surface, entry] of [...surfaces])
      if (!surface.isConnected) {
        entry.observer.disconnect()
        surfaces.delete(surface)
        freshSurfaces.delete(surface)
      }
  }

  function eligible(table: HTMLTableElement): boolean {
    if (sessionTableWidths(table)) {
      clearAuto(table)
      return false
    }
    return headerCells(table).length > 0
  }

  /** Decide whether a near table needs measuring now; reads only this near table's width. */
  function candidateFor(
    table: HTMLTableElement,
    now: number,
  ): Candidate | 'held' | null {
    const state = states.get(table)
    if (state?.stale === 'none') return null
    const hold = holds.get(table) ?? 0
    if (hold > now) {
      heldUntil = Math.max(heldUntil, hold)
      return 'held'
    }
    if (!eligible(table)) return null
    const width = table.getBoundingClientRect().width
    if (width <= 0) return null
    const cells = Array.from(table.rows[0].cells)
    const columns = cells.length
    if (
      state?.stale === 'width' &&
      state.widths.length === columns &&
      Math.abs(width - state.width) < AUTO_WIDTH_CHANGE_PX
    ) {
      state.stale = 'none'
      return null
    }
    // The collapsed table border adds to the cells: assign the cells only what is left of the
    // table width, or the table grows past its container by that border.
    const cellsWidth = cells.reduce(
      (total, cell) => total + cell.getBoundingClientRect().width,
      0,
    )
    return { table, width, overhead: Math.max(0, width - cellsWidth), columns }
  }

  function createState(table: HTMLTableElement): AutoState {
    const style = document.createElement('style')
    document.head.append(style)
    const state: AutoState = {
      className: `${AUTO_WIDTH_CLASS_PREFIX}${++nextAutoWidthId}`,
      style,
      widths: [],
      width: 0,
      stale: 'none',
    }
    states.set(table, state)
    owned.add(table)
    return state
  }

  // The widths are border-box (what a first-row cell rect reports, and what the allocation sums
  // to the table width); cells default to content-box, which would add padding and border to each.
  function writeRules(table: HTMLTableElement, state: AutoState): void {
    table.classList.add(state.className)
    const rules = state.widths
      .map(
        (width, index) =>
          `.vditor-reset table.${state.className} tr > :is(th, td):nth-child(${index + 1}) { box-sizing: border-box; width: ${width}px; }`,
      )
      .join('\n')
    if (state.style.textContent !== rules) state.style.textContent = rules
  }

  function applyMeasurement(
    candidate: Candidate,
    measured: { min: number[]; max: number[] },
  ): void {
    const { table, width, overhead, columns } = candidate
    if (measured.min.length !== columns || measured.max.length !== columns)
      return
    const widths = allocateColumnWidths({
      min: measured.min,
      max: measured.max,
      available: width - overhead,
      minimum: MIN_TABLE_COLUMN_WIDTH,
    })
    const previous = states.get(table)
    if (
      previous &&
      previous.widths.length === widths.length &&
      widths.every(
        (value, index) =>
          Math.abs(value - previous.widths[index]) < AUTO_MOVE_PX,
      )
    ) {
      previous.stale = 'none'
      previous.width = width
      if (!table.classList.contains(previous.className))
        table.classList.add(previous.className)
      return
    }
    const state = previous ?? createState(table)
    state.widths = widths
    state.width = width
    state.stale = 'none'
    writeRules(table, state)
  }

  function flush(): void {
    prune()
    heldUntil = 0
    const now = performance.now()
    const batch: Candidate[] = []
    let held = false
    for (const table of near) {
      const candidate = candidateFor(table, now)
      if (candidate === 'held') held = true
      else if (candidate) batch.push(candidate)
    }
    if (batch.length > 0) {
      const measured = measureColumns(
        batch.map((candidate) => candidate.table),
        root,
      )
      for (const [index, candidate] of batch.entries())
        applyMeasurement(candidate, measured[index])
    }
    // A table still inside its typing pause is retried once the pause is over.
    if (held) pauseUntil(heldUntil)
  }

  const soon = debounce(flush, AUTO_SOON_MS)

  /** Flush once at `deadline`; the latest call wins, so repeated edits keep pushing the pause out. */
  function pauseUntil(deadline: number): void {
    if (pauseTimer) clearTimeout(pauseTimer)
    pauseTimer = setTimeout(
      () => {
        pauseTimer = undefined
        flush()
      },
      Math.max(0, deadline - performance.now()) + 1,
    )
  }

  /**
   * Vditor replaces the edited table on a keystroke (Task 639 probe) with one childList record that
   * removes the old table and adds the new one at the same position, which drops the class. The
   * pair is taken from that single record only (exactly one table removed and one added), never
   * from document order: a rebuild of several tables (an Undo/Redo restore, a mode switch) names
   * no pairs, so no table is given another table's widths. The replacement gets the cached widths
   * in the observer callback, before the next paint, so the columns do not flash back to equal
   * widths; the match needs the same surface and column count, and the table is measured again
   * after the typing pause.
   */
  function replacementPair(
    record: MutationRecord,
  ): [HTMLTableElement, HTMLTableElement] | null {
    if (record.type !== 'childList') return null
    const removed = Array.from(record.removedNodes).flatMap(tablesWithin)
    const added = Array.from(record.addedNodes).flatMap(tablesWithin)
    return removed.length === 1 && added.length === 1
      ? [removed[0], added[0]]
      : null
  }

  function adoptReplacement(
    previous: HTMLTableElement,
    next: HTMLTableElement,
    now: number,
  ): boolean {
    const state = states.get(previous)
    const surface = tracked.get(previous)
    if (
      !state ||
      !surface ||
      previous.isConnected ||
      !next.isConnected ||
      states.has(next) ||
      next.closest('.vditor-reset') !== surface ||
      state.widths.length !== next.rows[0]?.cells.length
    )
      return false
    states.delete(previous)
    owned.delete(previous)
    untrack(previous)
    states.set(next, state)
    owned.add(next)
    track(next)
    next.classList.add(state.className)
    state.stale = 'content'
    holds.set(next, now + AUTO_PAUSE_MS)
    return true
  }

  /** Mark the table a mutation touched as edited; true when it carries cached widths. */
  function markEdited(record: MutationRecord, now: number): boolean {
    const table = owningTable(record.target)
    const state = table && states.get(table)
    if (!state) return false
    state.stale = 'content'
    holds.set(table, now + AUTO_PAUSE_MS)
    return true
  }

  function removesCachedTable(record: MutationRecord): boolean {
    return (
      record.type === 'childList' &&
      Array.from(record.removedNodes).some((node) =>
        tablesWithin(node).some((table) => owned.has(table)),
      )
    )
  }

  function onContentMutations(records: MutationRecord[]): void {
    if (owned.size === 0) return
    const now = performance.now()
    let adopted = false
    let edited = false
    let removed = false
    for (const record of records) {
      const pair = replacementPair(record)
      if (pair) adopted = adoptReplacement(pair[0], pair[1], now) || adopted
      removed ||= removesCachedTable(record)
      edited = markEdited(record, now) || edited
    }
    if (adopted || edited) pauseUntil(now + AUTO_PAUSE_MS)
    // A removed table's width rules are dropped by the next flush.
    else if (removed) soon()
  }

  const mutationObserver = new MutationObserver(onContentMutations)
  mutationObserver.observe(root, {
    childList: true,
    characterData: true,
    subtree: true,
  })

  // Web fonts change glyph widths after the first measurement.
  const onFontsLoaded = () => {
    for (const table of owned) {
      const state = states.get(table)
      if (state) state.stale = 'content'
    }
    soon()
  }
  document.fonts?.addEventListener('loadingdone', onFontsLoaded)

  return {
    beginPass(full) {
      if (full) freshSurfaces.clear()
    },
    track,
    onFullPass() {
      for (const table of owned) {
        const state = states.get(table)
        if (state?.stale === 'none') state.stale = 'width'
      }
      soon()
    },
    dispose() {
      soon.cancel()
      if (pauseTimer) clearTimeout(pauseTimer)
      mutationObserver.disconnect()
      document.fonts?.removeEventListener('loadingdone', onFontsLoaded)
      for (const { observer } of surfaces.values()) observer.disconnect()
      surfaces.clear()
      for (const table of [...owned]) clearAuto(table)
      tracked.clear()
      near.clear()
    },
  }
}

function isOwnedNormalizedAttribute(record: MutationRecord): boolean {
  if (record.type !== 'attributes' || !(record.target instanceof HTMLElement))
    return false
  const element = record.target
  if (element instanceof HTMLTableElement) {
    return (
      !element.hasAttribute('width') &&
      element.style.getPropertyValue('display') === 'table' &&
      element.style.getPropertyValue('table-layout') === 'fixed' &&
      element.style.getPropertyValue('width') === '100%' &&
      element.style.getPropertyValue('max-width') === '100%' &&
      element.style.getPropertyValue('min-width') === '0' &&
      element.style.getPropertyValue('box-sizing') === 'border-box'
    )
  }
  if (!element.matches('col, th, td')) return false
  return (
    !element.hasAttribute('width') &&
    !element.style.getPropertyValue('width') &&
    !element.style.getPropertyValue('min-width') &&
    !element.style.getPropertyValue('max-width') &&
    !element.style.getPropertyValue('white-space')
  )
}

function mutationMayAffectTable(record: MutationRecord): boolean {
  const target =
    record.target.nodeType === Node.ELEMENT_NODE
      ? (record.target as Element)
      : record.target.parentElement
  if (target?.closest('table')) return true
  return [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]
    .filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE)
    .some(
      (element) =>
        element.matches('table') || element.querySelector('table') !== null,
    )
}

function normalizeResponsiveTables(
  root: ParentNode = document,
  autoWidths: AutoTableWidths = INERT_AUTO_WIDTHS,
  full = false,
) {
  autoWidths.beginPass(full)
  const tables = [
    ...(root instanceof HTMLTableElement ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLTableElement>('table')),
  ].filter((table) => table.closest('.vditor-reset'))
  tables.forEach((table) => {
    // Volatile width rules live outside Lute-owned DOM. The normalizer still owns every
    // pasted/Vditor inline width, while min-width lets a wide result scroll.
    const widths = sessionTableWidths(table)
    if (widths) ensureSessionTableWidths(table)
    table.removeAttribute('width')
    // Keep pasted/Vditor tables in table layout without outranking stateful visibility rules:
    // details collapse uses `display: none !important`, while build.mjs already patches Vditor's
    // base `.vditor-reset table` display. A normal-priority inline value preserves both contracts.
    table.style.setProperty('display', 'table')
    table.style.setProperty('table-layout', 'fixed', 'important')
    table.style.setProperty('width', '100%', 'important')
    table.style.setProperty('max-width', widths ? 'none' : '100%', 'important')
    table.style.setProperty(
      'min-width',
      widths ? `${widths.reduce((total, width) => total + width, 0)}px` : '0',
      'important',
    )
    table.style.setProperty('box-sizing', 'border-box')
    autoWidths.track(table)
  })

  for (const table of tables)
    for (const element of table.querySelectorAll<HTMLElement>(
      'colgroup col, th, td',
    )) {
      element.removeAttribute('width')
      element.style.removeProperty('width')
      element.style.removeProperty('min-width')
      element.style.removeProperty('max-width')
      element.style.removeProperty('white-space')
    }
}

export function fixResponsiveTables() {
  responsiveTableCleanup?.()

  const root = (document.querySelector('.vditor') ??
    document.body) as HTMLElement
  const autoWidths = createAutoTableWidths(root)
  const pendingBlocks = new Set<HTMLElement>()
  let pendingFull = false
  const syncTables = debounce(() => {
    const full = pendingFull
    if (full) normalizeResponsiveTables(root, autoWidths, true)
    else
      for (const block of pendingBlocks)
        normalizeResponsiveTables(block, autoWidths)
    pendingBlocks.clear()
    pendingFull = false
    if (full) autoWidths.onFullPass()
  }, 16)

  const queueFull = () => {
    pendingBlocks.clear()
    pendingFull = true
    syncTables()
  }

  queueFull()

  const onResize = () => {
    queueFull()
  }

  window.addEventListener('resize', onResize)

  // This observer watches the attributes it also mutates (style/width) — the debounce plus
  // the idempotent normalization (re-setting identical values fires no mutation record) are
  // what keep it from looping. Don't widen the attributeFilter without re-checking that.
  const mutationObserver = new MutationObserver((records) => {
    // Our normalization writes the same style/width attributes this observer watches. Filter a
    // batch only when every record already reflects our exact normalized state; a mixed content or
    // externally changed attribute batch still reaches the conservative impact classifier.
    const relevant = records.filter(
      (record) =>
        !isOwnedNormalizedAttribute(record) && mutationMayAffectTable(record),
    )
    if (relevant.length === 0) {
      recordHelperMutationPass('responsive-tables', records, 'skipped')
      return
    }
    const impact = classifyEditorMutations(relevant)
    recordHelperMutationPass(
      'responsive-tables',
      relevant,
      impact.full ? 'full' : 'local',
      impact.blocks.size,
    )
    if (impact.full) pendingFull = true
    if (!pendingFull)
      for (const block of impact.blocks) pendingBlocks.add(block)
    syncTables()
  })
  mutationObserver.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'width'],
  })

  let resizeObserver: ResizeObserver | undefined
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      queueFull()
    })
    resizeObserver.observe(root)
  }

  responsiveTableCleanup = () => {
    window.removeEventListener('resize', onResize)
    mutationObserver.disconnect()
    resizeObserver?.disconnect()
    syncTables.cancel()
    autoWidths.dispose()
  }
}
