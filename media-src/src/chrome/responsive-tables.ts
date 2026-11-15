// Responsive-table normalization (split out of utils.ts, 185/3g).
//
// Vditor (and pasted HTML) pins tables with explicit width attributes/styles; normalize them
// to fluid `table-layout:fixed; width:100%` so tables track the column. Re-asserted on window
// resize, DOM mutations (Vditor rebuilds tables per keystroke), and container resizes.

import { debounce } from '../util/debounce'
import {
  classifyEditorMutations,
  recordHelperMutationPass,
  writeQuietly,
} from '../util/mutation-impact'
import {
  onUnitFeed,
  type LiveUnit,
  type UnitFeed,
  type UnitsChange,
  unitFeedOf,
} from '../util/unit-changes'
import { allocateColumnWidths } from './table-column-widths'
import {
  AUTO_WIDTH_CLASS_PREFIX,
  createMeasureHost,
  ensureSessionTableWidths,
  headerCells,
  type MeasureHost,
  type MeasureRowFilter,
  MIN_TABLE_COLUMN_WIDTH,
  mountCellMeasurer,
  mountMeasureClone,
  sessionTableWidths,
} from './table-resize'
import { findScroller } from './toolbar-scroll-guard'
import {
  hintMeasureClone,
  isOwnHintRecord,
  requestWrapHintReplan,
  withoutOwnHintRecords,
} from '../util/wrap-hint-mark'

let responsiveTableCleanup: (() => void) | null = null
let requestFullTableSync: (() => void) | null = null

/** Task 660: one full table re-sync, for a change the table observers cannot see (live config). */
export function resyncResponsiveTables(): void {
  requestFullTableSync?.()
}

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
/** Body rows of the first measurement clone of a large table; the other rows are measured when idle. */
const MEASURE_CLONE_ROWS = 32
/** One idle fill callback measures stored rows for at most this long. */
const FILL_SLICE_MS = 8
/** Cells mounted per layout pair (max-content, then min-content) in the idle fill. */
const FILL_BATCH = 32
/** Without idle callbacks, the delay before a fill slice. */
const FILL_FALLBACK_MS = 50
/** A cell measured alone differs from the stored column value only by more than this. */
const CELL_EPS_PX = 0.5

type Stale = 'none' | 'width' | 'content'

interface AutoState {
  className: string
  style: HTMLStyleElement
  widths: number[]
  /** Table width the widths were allocated for. */
  width: number
  stale: Stale
  /** The table's section-indent mark (its depth) when the widths were allocated (Task 660). */
  indent: string | null
  /** Per column, the min-content and max-content widths of the last measurement (Q-54). */
  min: number[]
  max: number[]
  /** Per column, the `table.rows` index that holds `min` / `max`; -1 until the per-row store is complete. */
  minRow: number[]
  maxRow: number[]
  /** Table width minus the sum of its first-row cells, as of the last measurement. */
  overhead: number
  /**
   * Task 733 (012-4): per column, the min-content and max-content width of each row measured alone,
   * indexed like `table.rows` (NaN: not measured yet). Empty while invalid; allocated once per
   * measurement after an invalidation (`remember`), never per edit.
   */
  rowMin: Float64Array[]
  rowMax: Float64Array[]
  /** The `table.rows` length the per-row store was allocated for. */
  rowCount: number
  /** The next store position the idle fill looks at, row-major (row * columns + column). */
  fillAt: number
  /** The last measurement laid out the whole table, so its column values are exact (kept by the fill). */
  whole: boolean
  /** A holder cell shrank before the store was complete: the fill folds the stored rows exactly. */
  refold: boolean
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

export interface ReplacedTablePair {
  previous: HTMLTableElement
  next: HTMLTableElement
  /** Same column count and text: the cached widths still fit without a new measurement. */
  unchanged: boolean
}

/** Column count and text: equal keys mean equal content, hence equal content-aware widths. */
function tableKey(table: HTMLTableElement): string {
  return `${table.rows[0]?.cells.length ?? 0}\u0000${table.textContent ?? ''}`
}

/**
 * Task 720 — the tables one childList record replaced, as removed/added pairs, both lists in
 * document order. One removed and one added table form the keystroke pair (Task 639). For a larger
 * rebuild (an Undo/Redo restore replaces the whole root), the equal-key runs at the start and at the
 * end of both lists pair up in order, and what remains between them pairs only when exactly one
 * table is left on each side (the edited table). Anything else stays unpaired, so a table never gets
 * the widths of a table it cannot be matched to.
 */
export function pairReplacedTables(
  removed: HTMLTableElement[],
  added: HTMLTableElement[],
): ReplacedTablePair[] {
  if (removed.length === 0 || added.length === 0) return []
  if (removed.length === 1 && added.length === 1)
    return [
      {
        previous: removed[0],
        next: added[0],
        unchanged: tableKey(removed[0]) === tableKey(added[0]),
      },
    ]
  const removedKeys = removed.map(tableKey)
  const addedKeys = added.map(tableKey)
  const limit = Math.min(removed.length, added.length)
  let lead = 0
  while (lead < limit && removedKeys[lead] === addedKeys[lead]) lead++
  let trail = 0
  while (
    trail < limit - lead &&
    removedKeys[removed.length - 1 - trail] ===
      addedKeys[added.length - 1 - trail]
  )
    trail++
  const pairs: ReplacedTablePair[] = []
  for (let index = 0; index < lead; index++)
    pairs.push({
      previous: removed[index],
      next: added[index],
      unchanged: true,
    })
  if (removed.length - lead - trail === 1 && added.length - lead - trail === 1)
    pairs.push({ previous: removed[lead], next: added[lead], unchanged: false })
  for (let index = 1; index <= trail; index++)
    pairs.push({
      previous: removed[removed.length - index],
      next: added[added.length - index],
      unchanged: true,
    })
  return pairs
}

/**
 * Min-content and max-content width of every column, read from detached clones in the shared
 * measurement host (see `createMeasureHost`): the two layouts the contract names, read from the
 * first-row cell widths.
 */
function measureColumns(
  tables: HTMLTableElement[],
  root: HTMLElement,
  rowsOf: (table: HTMLTableElement) => MeasureRowFilter | undefined,
): Array<{ min: number[]; max: number[] }> {
  const host = createMeasureHost(root)
  try {
    // Task 733 (012-4): a large table is laid out with a bounded set of rows (`rowsOf`), not whole.
    const clones = tables.map((table) =>
      mountMeasureClone(table, root, host.element, rowsOf(table)),
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
    // Task 640: the min-content layout counts the pieces a line can break into at the priority-1
    // positions, so a path column can shrink without breaking inside a word. The clone only; max
    // is read above, before any hint, and hints are zero width anyway.
    for (const [index, clone] of clones.entries())
      hintMeasureClone(clone, max[index], MIN_TABLE_COLUMN_WIDTH)
    const min = read('min')
    return tables.map((_, index) => ({ min: min[index], max: max[index] }))
  } finally {
    host.dispose()
  }
}

/** The parent's content width: client width minus its horizontal padding. */
function contentWidth(parent: HTMLElement): number {
  const style = getComputedStyle(parent)
  return (
    parent.clientWidth -
    (Number.parseFloat(style.paddingLeft) || 0) -
    (Number.parseFloat(style.paddingRight) || 0)
  )
}

/**
 * The width a table should fill: the room its parent gives (`inner`, the parent's content width)
 * minus what the table reserves at its start (`reserved`: indentation offset, else start margin).
 * Never the table's own `rect`: a table cannot shrink below its column widths, so after the pane
 * narrows its rect still shows the old, wider fit; reading that back as the room made the stale
 * column widths hold themselves in place (Task 713; Task 649/660 for the reservation). `rect` is
 * only the fallback with no parent (`inner` undefined) or no positive room left.
 */
export function tableFillWidth(
  rect: number,
  inner: number | undefined,
  reserved: number,
): number {
  if (inner === undefined) return rect
  const room = inner - (reserved > 0 ? reserved : 0)
  return room > 0 ? room : rect
}

// The factory owns one closure of mutable tracking state; its pieces are small named functions.
function fillWidth(table: HTMLTableElement, rect: number): number {
  const parent = table.parentElement
  if (!parent) return tableFillWidth(rect, undefined, 0)
  const inner = contentWidth(parent)
  // Task 660: the indentation offset, not the margin: a table that is capped (see syncTableFloor)
  // has a smaller margin, and filling to that would make the cap hold itself in place.
  const offset = indentOffset(table, inner)
  const reserved =
    offset > 0 ? offset : Number.parseFloat(getComputedStyle(table).marginLeft)
  return tableFillWidth(rect, inner, reserved)
}

/**
 * Task 733 (007): true when the live feed describes `table`: a top-level table of the feed root, whose
 * cells are units. A table nested in a quote, a list item or a details block is not split into cells
 * by the model, so it keeps the observers' own pass. O(1), no allocation.
 */
function feedDescribes(table: HTMLElement): UnitFeed | undefined {
  const feed = unitFeedOf(window)
  return feed?.isLive() && table.parentElement === feed.root ? feed : undefined
}

/** True when the per-row store is allocated for the table's current rows and the state's columns. */
function storeFits(state: AutoState, table: HTMLTableElement): boolean {
  return (
    state.rowMax.length > 0 &&
    state.rowMax.length === state.min.length &&
    state.rowCount === table.rows.length
  )
}

/** Drops the per-row store: the content changed, so every stored row width may be wrong. */
function markContentStale(state: AutoState): void {
  state.stale = 'content'
  state.rowMin = []
  state.rowMax = []
  state.rowCount = 0
  state.fillAt = 0
}

function allocateStore(state: AutoState, rows: number, columns: number): void {
  state.rowMin = []
  state.rowMax = []
  for (let column = 0; column < columns; column++) {
    state.rowMin.push(new Float64Array(rows).fill(Number.NaN))
    state.rowMax.push(new Float64Array(rows).fill(Number.NaN))
  }
  state.rowCount = rows
  state.fillAt = 0
}

/**
 * Folds the stored rows of `column` into the column values, with no layout. With every row known the
 * values and their holder rows are exact; otherwise the values never drop below `baseMin` and
 * `baseMax` and the holders stay unknown (-1) until the idle fill completes. True when complete.
 */
function foldColumn(
  state: AutoState,
  column: number,
  baseMin: number,
  baseMax: number,
): boolean {
  const mins = state.rowMin[column]
  const maxes = state.rowMax[column]
  let min = 0
  let max = 0
  let minRow = -1
  let maxRow = -1
  let known = 0
  for (let row = 0; row < maxes.length; row++) {
    const high = maxes[row]
    if (Number.isNaN(high)) continue
    known++
    if (high > max) {
      max = high
      maxRow = row
    }
    if (mins[row] > min) {
      min = mins[row]
      minRow = row
    }
  }
  const complete = known === maxes.length
  state.min[column] = complete ? min : Math.max(baseMin, min)
  state.max[column] = complete ? max : Math.max(baseMax, max)
  state.minRow[column] = complete ? minRow : -1
  state.maxRow[column] = complete ? maxRow : -1
  return complete
}

/**
 * How the stored rows settle into a column measured by a clone: `keep` the clone values (a whole
 * clone is exact, and a cell laid out alone can differ from it by a fraction of a pixel), `raise`
 * them only where a stored row is wider by more than `CELL_EPS_PX` (rows a bounded clone left out),
 * or take the stored rows `exact` (a holder shrank). The holders come from the store when it is
 * complete. True when complete.
 */
function settleColumn(
  state: AutoState,
  column: number,
  baseMin: number,
  baseMax: number,
  mode: 'keep' | 'raise' | 'exact',
): boolean {
  const complete = foldColumn(state, column, baseMin, baseMax)
  if (mode === 'exact') return complete
  if (mode === 'keep' || state.min[column] <= baseMin + CELL_EPS_PX)
    state.min[column] = baseMin
  if (mode === 'keep' || state.max[column] <= baseMax + CELL_EPS_PX)
    state.max[column] = baseMax
  return complete
}

/** Raises the column values to a cell wider than them; true when a value grew (its row holds it). */
function growColumn(
  state: AutoState,
  column: number,
  row: number,
  measured: { min: number; max: number },
): boolean {
  let grew = false
  if (measured.max > state.max[column] + CELL_EPS_PX) {
    state.max[column] = measured.max
    state.maxRow[column] = row
    grew = true
  }
  if (measured.min > state.min[column] + CELL_EPS_PX) {
    state.min[column] = measured.min
    state.minRow[column] = row
    grew = true
  }
  return grew
}

/** True when the cell held a column value (or the holder is not known yet) and is now narrower. */
function shrunkHolder(
  state: AutoState,
  column: number,
  row: number,
  measured: { min: number; max: number },
): boolean {
  const heldMax = state.maxRow[column] === -1 || state.maxRow[column] === row
  const heldMin = state.minRow[column] === -1 || state.minRow[column] === row
  return (
    (heldMax && measured.max < state.max[column] - CELL_EPS_PX) ||
    (heldMin && measured.min < state.min[column] - CELL_EPS_PX)
  )
}

/** True when column `column` moved by more than `CELL_EPS_PX` from `min` / `max`. */
function columnMoved(
  state: AutoState,
  column: number,
  min: number,
  max: number,
): boolean {
  return (
    Math.abs(state.min[column] - min) > CELL_EPS_PX ||
    Math.abs(state.max[column] - max) > CELL_EPS_PX
  )
}

/** A state whose per-row store still fits `table` with `columns` columns (a width-only re-fit). */
function keepsStore(
  state: AutoState | undefined,
  table: HTMLTableElement,
  columns: number,
): state is AutoState {
  return (
    state !== undefined &&
    state.min.length === columns &&
    storeFits(state, table)
  )
}

/** True when `row` holds a column minimum or maximum. */
function holdsColumn(state: AutoState, row: number): boolean {
  return state.minRow.includes(row) || state.maxRow.includes(row)
}

interface IdleDeadlineLike {
  timeRemaining(): number
}

/** An idle callback; without `requestIdleCallback`, a delayed timer with a `FILL_SLICE_MS` budget. Returns its cancel. */
function requestIdle(
  callback: (deadline: IdleDeadlineLike) => void,
): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(callback)
    return () => cancelIdleCallback(handle)
  }
  const timer = setTimeout(() => {
    const started = performance.now()
    callback({
      timeRemaining: () =>
        Math.max(0, started + FILL_SLICE_MS - performance.now()),
    })
  }, FILL_FALLBACK_MS)
  return () => clearTimeout(timer)
}

/** True when the browser reports pending input (Chromium `isInputPending`); the idle fill yields to it. */
function inputPending(): boolean {
  const scheduling = (
    navigator as Navigator & {
      scheduling?: { isInputPending?: () => boolean }
    }
  ).scheduling
  return scheduling?.isInputPending?.() === true
}

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
    else keepAuto(table, state)
  }

  /** A tracked table keeps its width class and, when its indentation mark changed, is re-fitted. */
  function keepAuto(table: HTMLTableElement, state: AutoState): void {
    if (!table.classList.contains(state.className))
      table.classList.add(state.className)
    // Task 660: a section-indent mark appearing, going away or changing depth changes the room the columns were
    // allocated for, without any resize. Re-fit once; the apply step then re-reads the floor.
    const indent = table.getAttribute(INDENT_ATTR)
    if (indent === state.indent) return
    state.indent = indent
    if (state.stale === 'none') state.stale = 'width'
    soon()
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
    const rect = table.getBoundingClientRect().width
    if (rect <= 0) return null
    const width = fillWidth(table, rect)
    const cells = Array.from(table.rows[0].cells)
    const columns = cells.length
    if (
      state?.stale === 'width' &&
      state.widths.length === columns &&
      Math.abs(width - state.width) < AUTO_WIDTH_CHANGE_PX
    ) {
      state.stale = 'none'
      syncTableFloor(table)
      return null
    }
    // The collapsed table border adds to the cells: assign the cells only what is left of the
    // table width, or the table grows past its container by that border.
    const cellsWidth = cells.reduce(
      (total, cell) => total + cell.getBoundingClientRect().width,
      0,
    )
    return { table, width, overhead: Math.max(0, rect - cellsWidth), columns }
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
      indent: table.getAttribute(INDENT_ATTR),
      min: [],
      max: [],
      minRow: [],
      maxRow: [],
      overhead: 0,
      rowMin: [],
      rowMax: [],
      rowCount: 0,
      fillAt: 0,
      whole: false,
      refold: false,
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

  /**
   * Keeps the last measurement per column and allocates an empty per-row store; the idle fill measures
   * every row alone and finds the rows that hold the column values.
   */
  function remember(
    state: AutoState,
    table: HTMLTableElement,
    measured: { min: number[]; max: number[] },
  ): void {
    state.min = measured.min
    state.max = measured.max
    state.minRow = measured.min.map(() => -1)
    state.maxRow = measured.max.map(() => -1)
    allocateStore(state, table.rows.length, measured.max.length)
  }

  /** Writes new widths for `table` unless every column moved by less than the hysteresis. */
  function commitWidths(
    table: HTMLTableElement,
    previous: AutoState | undefined,
    widths: number[],
    width: number,
  ): AutoState | undefined {
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
      syncTableFloor(table)
      return undefined
    }
    const state = previous ?? createState(table)
    state.widths = widths
    state.width = width
    state.stale = 'none'
    writeRules(table, state)
    // Task 660: the new column widths change the rendered width, which is the floor main.css caps by.
    syncTableFloor(table)
    // Task 640: the cells have new line boxes, so their priority-2/3 hints are planned again.
    requestWrapHintReplan(table)
    return state
  }

  /** Folds every column of the store into `base` (see `foldColumn`); true when all are complete. */
  function foldColumns(
    state: AutoState,
    base: { min: number[]; max: number[] },
    whole: boolean,
  ): boolean {
    const mode = whole ? 'keep' : 'raise'
    let complete = true
    for (let column = 0; column < state.rowMax.length; column++)
      complete =
        settleColumn(state, column, base.min[column], base.max[column], mode) &&
        complete
    return complete
  }

  /** True when the measurement clone of `table` holds every row (`cloneRows` gives no filter). */
  function clonesWhole(table: HTMLTableElement): boolean {
    return (
      table.rows.length - (table.tHead?.rows.length ?? 0) <= MEASURE_CLONE_ROWS
    )
  }

  function applyMeasurement(
    candidate: Candidate,
    measured: { min: number[]; max: number[] },
  ): void {
    const { table, width, overhead, columns } = candidate
    if (measured.min.length !== columns || measured.max.length !== columns)
      return
    const previous = states.get(table)
    // A width-only re-fit keeps the per-row store: it folds into the new measurement, no new fill.
    const kept = keepsStore(previous, table, columns)
    const whole = clonesWhole(table)
    const complete = kept && foldColumns(previous, measured, whole)
    const values = kept ? previous : measured
    const widths = allocateColumnWidths({
      min: values.min,
      max: values.max,
      available: width - overhead,
      minimum: MIN_TABLE_COLUMN_WIDTH,
    })
    const state = commitWidths(table, previous, widths, width) ?? previous
    if (!state) return
    state.overhead = overhead
    state.whole = whole
    state.refold = false
    if (!kept) remember(state, table, measured)
    if (!complete) scheduleFill(table)
  }

  /**
   * The body rows of the measurement clone. A table of at most `MEASURE_CLONE_ROWS` body rows is
   * cloned whole (the same layout cost). A larger one keeps the rows that hold the column values when
   * the store knows them all, else the first `MEASURE_CLONE_ROWS` rows and any known holder; the idle
   * fill measures the other rows alone.
   */
  function cloneRows(table: HTMLTableElement): MeasureRowFilter | undefined {
    if (clonesWhole(table)) return undefined
    const state = states.get(table)
    const store = state && storeFits(state, table) ? state : undefined
    const known =
      store?.minRow.every((row) => row >= 0) === true &&
      store.maxRow.every((row) => row >= 0)
    return (row, bodyIndex) =>
      (!known && bodyIndex < MEASURE_CLONE_ROWS) ||
      (store !== undefined && holdsColumn(store, row.rowIndex))
  }

  function flush(): void {
    prune()
    heldUntil = 0
    const now = performance.now()
    heldUntil = flushDirtyCells(now)
    const batch: Candidate[] = []
    let held = heldUntil > 0
    for (const table of near) {
      const candidate = candidateFor(table, now)
      if (candidate === 'held') held = true
      else if (candidate) batch.push(candidate)
    }
    if (batch.length > 0) {
      const measured = measureColumns(
        batch.map((candidate) => candidate.table),
        root,
        cloneRows,
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
   * removes the old table and adds the new one at the same position, which drops the class. An
   * Undo/Redo restore rebuilds the whole root in one record (Task 720), removing and adding every
   * table. The pairs come from that single record only (`pairReplacedTables`), so no table is given
   * another table's widths. The replacement gets the cached widths in the observer callback, before
   * the next paint, so the columns do not flash back to equal widths; the match also needs the same
   * surface and column count. An unchanged table is only checked against its width; a changed one is
   * measured again after the typing pause.
   */
  function replacementPairs(record: MutationRecord): ReplacedTablePair[] {
    if (record.type !== 'childList') return []
    return pairReplacedTables(
      Array.from(record.removedNodes).flatMap(tablesWithin),
      Array.from(record.addedNodes).flatMap(tablesWithin),
    )
  }

  function adoptReplacement(
    { previous, next, unchanged }: ReplacedTablePair,
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
    // Same text, same widths: only a changed table width (re-checked when the table is near) can
    // move them. Pausing it like an edit would hold every table of a restore for no reason.
    if (unchanged) {
      if (state.stale === 'none') state.stale = 'width'
      return false
    }
    markContentStale(state)
    holds.set(next, now + AUTO_PAUSE_MS)
    return true
  }

  /** Mark the table a mutation touched as edited; true when it carries cached widths. */
  function markEdited(record: MutationRecord, now: number): boolean {
    const table = owningTable(record.target)
    const state = table && states.get(table)
    if (!state) return false
    markContentStale(state)
    holds.set(table, now + AUTO_PAUSE_MS)
    return true
  }

  /** Tables whose edit records a live feed deferred to its next change. */
  const deferred = new Set<HTMLTableElement>()

  /** Marks the deferred tables as edited (the feed went off, or a whole change has no cell list). */
  function releaseDeferred(now: number): boolean {
    let marked = false
    for (const table of deferred) marked = markStale(table, now) || marked
    deferred.clear()
    return marked
  }

  /**
   * A record inside a table that the live feed describes is handled from the feed's changed units
   * (`onFeedChange`); the table is kept for a `whole` change, which has no per-cell list. Any other
   * record is marked as `markEdited` marks it, and when the feed is no longer live the deferred
   * tables are marked too: the feed will not report them.
   */
  function markOrDefer(record: MutationRecord, now: number): boolean {
    const table = owningTable(record.target)
    if (table && feedDescribes(table)) {
      if (states.has(table)) deferred.add(table)
      return false
    }
    const released = deferred.size > 0 && !unitFeedOf(window)?.isLive()
    const marked = released ? releaseDeferred(now) : false
    return markEdited(record, now) || marked
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
    if (owned.size === 0 || records.length === 0) return
    const now = performance.now()
    let adopted = false
    let edited = false
    let removed = false
    for (const record of records) {
      for (const pair of replacementPairs(record))
        adopted = adoptReplacement(pair, now) || adopted
      removed ||= removesCachedTable(record)
      edited = markOrDefer(record, now) || edited
    }
    if (adopted || edited) pauseUntil(now + AUTO_PAUSE_MS)
    // A removed table's width rules are dropped by the next flush.
    else if (removed) soon()
  }

  function markStale(table: HTMLTableElement, now: number): boolean {
    const state = states.get(table)
    if (!state) return false
    markContentStale(state)
    holds.set(table, now + AUTO_PAUSE_MS)
    return true
  }

  // Q-54: a changed cell is measured alone, never as a table clone. Cells wait here for the pause
  // flush (the layout read is not taken in the feed's frame callback).
  const dirtyCells = new Set<HTMLElement>()
  /** Pending idle fills per table: their cancel functions. */
  const fills = new Map<HTMLTableElement, () => void>()
  // Reused by every fill batch (idle work, allocated once per factory).
  const batchCopies: HTMLElement[] = []
  const batchShells: HTMLTableElement[] = []
  const batchTops: Element[] = []
  const batchSlots: number[] = []
  const batchMax: number[] = []
  const batchHintWidth: number[] = [0]

  /** The min-content and max-content widths of `cell` alone in the measurement host. */
  function measureCellAlone(
    host: MeasureHost,
    table: HTMLTableElement,
    cell: HTMLElement,
  ): { min: number; max: number } {
    const mounted = mountCellMeasurer(table, cell, root, host.element)
    host.layout('max')
    const max = mounted.cell.getBoundingClientRect().width
    hintMeasureClone(mounted.shell, [max], MIN_TABLE_COLUMN_WIDTH)
    host.layout('min')
    const min = mounted.cell.getBoundingClientRect().width
    host.element.lastElementChild?.remove()
    return { min, max }
  }

  /** Allocates the widths again from the stored column values (no table measurement). */
  function reallocate(table: HTMLTableElement, state: AutoState): void {
    const widths = allocateColumnWidths({
      min: state.min,
      max: state.max,
      available: state.width - state.overhead,
      minimum: MIN_TABLE_COLUMN_WIDTH,
    })
    commitWidths(table, state, widths, state.width)
  }

  /** Queues one idle fill slice for `table`; at most one is pending per table. */
  function scheduleFill(table: HTMLTableElement): void {
    if (fills.has(table)) return
    fills.set(
      table,
      requestIdle((deadline) => fillStep(table, deadline)),
    )
  }

  /** Mounts the cell at store position `slot` for the batch, unless it is measured already. */
  function mountFillCell(
    host: MeasureHost,
    table: HTMLTableElement,
    state: AutoState,
    slot: number,
  ): void {
    const columns = state.rowMax.length
    const row = Math.floor(slot / columns)
    const column = slot % columns
    if (!Number.isNaN(state.rowMax[column][row])) return
    const cell = table.rows[row]?.cells[column]
    if (!cell) {
      // A short row has no cell here: it sets nothing in this column.
      state.rowMin[column][row] = 0
      state.rowMax[column][row] = 0
      return
    }
    const mounted = mountCellMeasurer(table, cell, root, host.element)
    batchCopies.push(mounted.cell)
    batchShells.push(mounted.shell)
    batchTops.push(host.element.lastElementChild as Element)
    batchSlots.push(slot)
  }

  /**
   * Task 733 (012-9): the layout and read cost of one mounted cell in the last fill batch, in ms. A
   * batch stops mounting when the cells it holds would spend the rest of the slice on their layouts.
   */
  let fillCellCost = 0

  /** True when a batch holding `mounted` cells has spent the slice that ends at `end`. */
  function sliceSpent(mounted: number, end: number): boolean {
    return performance.now() + mounted * fillCellCost >= end || inputPending()
  }

  /** The write phase of a fill batch: mounts cells from `fillAt` until the batch is full or the slice spent. */
  function mountFillBatch(
    host: MeasureHost,
    table: HTMLTableElement,
    state: AutoState,
    end: number,
  ): void {
    const total = state.rowCount * state.rowMax.length
    batchCopies.length = 0
    batchShells.length = 0
    batchTops.length = 0
    batchSlots.length = 0
    for (
      ;
      state.fillAt < total && batchSlots.length < FILL_BATCH;
      state.fillAt++
    ) {
      if (batchSlots.length > 0 && sliceSpent(batchSlots.length, end)) break
      mountFillCell(host, table, state, state.fillAt)
    }
  }

  /**
   * Mounts up to `FILL_BATCH` unmeasured cells of the store, each alone in its own shell, lays them out
   * at max-content and then min-content (two layouts for the batch, not per cell) and stores both.
   * Task 733 (012-9): the slice deadline `end` is checked per mounted cell, so a batch stops when the
   * slice is spent and the cells left stay queued at `fillAt`. The first cell is always mounted, so
   * every slice makes progress. The reads of each layout run in one phase after the writes.
   */
  function fillBatch(
    host: MeasureHost,
    table: HTMLTableElement,
    state: AutoState,
    end: number,
  ): void {
    const columns = state.rowMax.length
    mountFillBatch(host, table, state, end)
    if (batchSlots.length === 0) return
    const laidOut = performance.now()
    host.layout('max')
    batchMax.length = 0
    for (const copy of batchCopies)
      batchMax.push(copy.getBoundingClientRect().width)
    // One reused width list: the hinter reads it synchronously, and each shell has one column.
    for (let index = 0; index < batchShells.length; index++) {
      batchHintWidth[0] = batchMax[index]
      hintMeasureClone(
        batchShells[index],
        batchHintWidth,
        MIN_TABLE_COLUMN_WIDTH,
      )
    }
    host.layout('min')
    for (let index = 0; index < batchCopies.length; index++) {
      const slot = batchSlots[index]
      const row = Math.floor(slot / columns)
      const column = slot % columns
      state.rowMin[column][row] =
        batchCopies[index].getBoundingClientRect().width
      state.rowMax[column][row] = batchMax[index]
    }
    for (const top of batchTops) top.remove()
    fillCellCost = (performance.now() - laidOut) / batchSlots.length
  }

  /**
   * One idle slice of the per-row store fill. It yields at the deadline (at most `FILL_SLICE_MS`) or
   * to pending input, and queues the next slice; once every row is known the column values are folded
   * exactly and the widths allocated again when they moved.
   */
  function fillStep(table: HTMLTableElement, deadline: IdleDeadlineLike): void {
    fills.delete(table)
    // Re-read the state after the wait: the table may be gone, edited or rebuilt.
    const state = states.get(table)
    if (
      !state ||
      !table.isConnected ||
      state.stale === 'content' ||
      !storeFits(state, table)
    )
      return
    const total = state.rowCount * state.rowMax.length
    const end =
      performance.now() + Math.min(deadline.timeRemaining(), FILL_SLICE_MS)
    const host = createMeasureHost(root)
    try {
      while (state.fillAt < total && performance.now() < end && !inputPending())
        fillBatch(host, table, state, end)
    } finally {
      host.dispose()
    }
    if (state.fillAt < total) scheduleFill(table)
    else finishFill(table, state)
  }

  /** The store is complete: the column values settle from it, and the widths follow when they moved. */
  function finishFill(table: HTMLTableElement, state: AutoState): void {
    let moved = false
    const mode = state.refold ? 'exact' : state.whole ? 'keep' : 'raise'
    state.refold = false
    for (let column = 0; column < state.rowMax.length; column++) {
      const min = state.min[column]
      const max = state.max[column]
      settleColumn(state, column, min, max, mode)
      moved ||= columnMoved(state, column, min, max)
    }
    if (moved) reallocate(table, state)
  }

  /**
   * One changed cell, measured alone and written to the per-row store. Wider than the column values,
   * the values grow and the widths are allocated again; when it held a column value (or the holder is
   * not known yet) and became narrower, the column is folded again from the stored rows (arithmetic,
   * no layout), or by the idle fill once the rows it has not measured yet are known. A cell inside the
   * values changes nothing; a table whose rows changed is measured as a whole.
   */
  function processCell(
    cell: HTMLElement,
    host: MeasureHost,
    now: number,
  ): void {
    const table = cell.closest('table')
    const state = table ? states.get(table) : undefined
    if (!table || !state || !cell.isConnected) return
    const row = cell.parentElement
    if (
      !(cell instanceof HTMLTableCellElement) ||
      !(row instanceof HTMLTableRowElement) ||
      cell.cellIndex >= state.min.length ||
      table.rows[0]?.cells.length !== state.widths.length ||
      !storeFits(state, table)
    ) {
      markStale(table, now)
      return
    }
    const column = cell.cellIndex
    const measured = measureCellAlone(host, table, cell)
    state.rowMin[column][row.rowIndex] = measured.min
    state.rowMax[column][row.rowIndex] = measured.max
    if (growColumn(state, column, row.rowIndex, measured)) {
      reallocate(table, state)
      return
    }
    if (shrunkHolder(state, column, row.rowIndex, measured))
      shrinkFromStore(table, state, column)
  }

  /** A holder shrank: the stored rows give the new values without a layout, once all are known. */
  function shrinkFromStore(
    table: HTMLTableElement,
    state: AutoState,
    column: number,
  ): void {
    const min = state.min[column]
    const max = state.max[column]
    if (!foldColumn(state, column, min, max)) {
      state.refold = true
      scheduleFill(table)
    } else if (columnMoved(state, column, min, max)) reallocate(table, state)
  }

  /** Runs in the pause flush: the changed cells of tables whose hold is over. Returns the latest hold left. */
  function flushDirtyCells(now: number): number {
    if (dirtyCells.size === 0) return 0
    let heldUntilCells = 0
    const host = createMeasureHost(root)
    try {
      for (const cell of dirtyCells) {
        const table = cell.closest('table')
        const hold = (table && holds.get(table)) || 0
        if (hold > now) {
          heldUntilCells = Math.max(heldUntilCells, hold)
          continue
        }
        dirtyCells.delete(cell)
        processCell(cell, host, now)
      }
    } finally {
      host.dispose()
    }
    return heldUntilCells
  }

  /** Records a changed unit of an owned, live-feed table; true when the table needs the pause. */
  function noteChangedUnit(unit: LiveUnit, now: number): boolean {
    const table = unit.top
    if (!(table instanceof HTMLTableElement) || !owned.has(table)) return false
    const state = states.get(table)
    if (!state || state.stale === 'content') return false
    // A unit that is not a cell (an opaque table) gives no cell to measure: the whole table.
    if (unit.kind !== 'cell') return markStale(table, now)
    dirtyCells.add(unit.el)
    holds.set(table, now + AUTO_PAUSE_MS)
    return true
  }

  /**
   * The unit feed (Task 733, 007): a whole change marks the tables whose records were deferred, a
   * structural table is marked as `markEdited` marks it, and a changed cell waits for the pause, where
   * it is measured alone (`processCell`).
   */
  function noteChanges(change: UnitsChange, now: number): boolean {
    let marked = false
    for (const table of change.structural)
      if (table instanceof HTMLTableElement)
        marked = markStale(table, now) || marked
    for (const unit of change.changed)
      marked = noteChangedUnit(unit, now) || marked
    return marked
  }

  function onFeedChange(change: UnitsChange): void {
    const now = performance.now()
    let marked = false
    if (change.whole) marked = releaseDeferred(now)
    else {
      deferred.clear()
      marked = noteChanges(change, now)
    }
    if (marked) pauseUntil(now + AUTO_PAUSE_MS)
  }

  const offFeed = onUnitFeed(window, onFeedChange)

  // Task 640: the wrap-hint engine's writes inside a cell are not edits (S1 probe 2 item 2: each one
  // would hold the table and run a measurement pass), so the batch is filtered first.
  const mutationObserver = new MutationObserver((records) =>
    onContentMutations(withoutOwnHintRecords(records)),
  )
  mutationObserver.observe(root, {
    childList: true,
    characterData: true,
    subtree: true,
  })

  // Web fonts change glyph widths after the first measurement.
  const onFontsLoaded = () => {
    for (const table of owned) {
      const state = states.get(table)
      if (state) markContentStale(state)
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
      offFeed()
      soon.cancel()
      if (pauseTimer) clearTimeout(pauseTimer)
      for (const cancel of fills.values()) cancel()
      fills.clear()
      dirtyCells.clear()
      deferred.clear()
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

// Task 649: the width a table fills. --vmde-indent-offset is set by the section-indent CSS on an
// indented top-level table (and is undefined elsewhere, so the fallback keeps today's 100%); an inline
// `!important` size cannot be overridden by a stylesheet, so the offset has to enter through here.
const TABLE_FILL = 'calc(100% - var(--vmde-indent-offset, 0px))'

// A var() value fires a style mutation record on every identical write in jsdom (which also drops the
// `!important` priority of such a value), so write only when the value differs; the observer's
// idempotence relies on it. The normalizer is the only writer of these two properties.
function setImportantOnChange(
  table: HTMLElement,
  property: string,
  value: string,
): void {
  if (table.style.getPropertyValue(property) === value) return
  table.style.setProperty(property, value, 'important')
}

// Task 660: an indented table that cannot shrink into the room left by its indentation (its columns
// have a physical floor: cell padding and border) would overflow the column by the difference.
// main.css reads --vmde-table-floor (an inline custom property, written here and nowhere else) to
// shrink that table's start margin by exactly its shortfall: margin-inline-start = max(0, min(offset,
// 100% - floor)). The floor is the table's rendered width, which does not depend on its margin, so
// the margin change cannot feed back into the measurement.
const INDENT_ATTR = 'data-vmde-indent'
const FLOOR_PROP = '--vmde-table-floor'
/** Sub-pixel layout noise below this does not count as an overflow. */
const FLOOR_SLACK_PX = 0.5
const PX_LENGTH = /^(-?\d*\.?\d+)px$/
const PERCENT_LENGTH = /^(-?\d*\.?\d+)%$/

/**
 * Resolves the computed `--vmde-indent-offset` to px. The property is registered as a
 * length-percentage, so the browser keeps its computed value unresolved (`min(320px, 40%)`, measured
 * in Chromium) and only `px`, `%` and `min()` of those occur (the main.css rules). The margin cannot
 * be read instead: with a floor set it is the capped value, and taking the floor off to read it would
 * rewrite the table's style on every pass. NaN when the value is not understood (no cap, as today).
 */
function resolveOffset(value: string, percentBase: number): number {
  const text = value.trim()
  const min = /^min\((.*)\)$/.exec(text)
  if (min)
    return Math.min(
      ...min[1].split(',').map((part) => resolveOffset(part, percentBase)),
    )
  const px = PX_LENGTH.exec(text)
  if (px) return Number(px[1])
  const percent = PERCENT_LENGTH.exec(text)
  return percent ? (Number(percent[1]) / 100) * percentBase : Number.NaN
}

/** The table's section-indent offset in px (0 for a table without the mark, or an unreadable one). */
function indentOffset(table: HTMLTableElement, inner: number): number {
  if (!table.hasAttribute(INDENT_ATTR)) return 0
  const offset = resolveOffset(
    getComputedStyle(table).getPropertyValue('--vmde-indent-offset'),
    inner,
  )
  return offset > 0 ? offset : 0
}

/**
 * Keeps --vmde-table-floor in step with the table: written (as the rendered width, only when it
 * differs) while the table is wider than `parent content width - indentation offset`, removed once
 * it fits or when the table is not an indented top-level block (setting off, nested table).
 */
function syncTableFloor(table: HTMLTableElement): void {
  const parent = table.parentElement
  // No mark (setting off, nested table): nothing to cap, and no layout is read for it.
  if (!parent || !table.hasAttribute(INDENT_ATTR)) {
    if (table.style.getPropertyValue(FLOOR_PROP))
      table.style.removeProperty(FLOOR_PROP)
    return
  }
  const inner = contentWidth(parent)
  const offset = indentOffset(table, inner)
  const width = offset > 0 ? table.getBoundingClientRect().width : 0
  if (!(offset > 0) || width <= inner - offset + FLOOR_SLACK_PX) {
    if (table.style.getPropertyValue(FLOOR_PROP))
      table.style.removeProperty(FLOOR_PROP)
    return
  }
  const floor = `${Math.round(width * 100) / 100}px`
  if (table.style.getPropertyValue(FLOOR_PROP) !== floor)
    table.style.setProperty(FLOOR_PROP, floor)
}

function isOwnedNormalizedAttribute(record: MutationRecord): boolean {
  if (record.type !== 'attributes' || !(record.target instanceof HTMLElement))
    return false
  // An indentation mark appearing or going away changes the room left, so it must reach the
  // normalizer even though the table's inline style is unchanged.
  if (record.attributeName === INDENT_ATTR) return false
  const element = record.target
  if (element instanceof HTMLTableElement) {
    return (
      !element.hasAttribute('width') &&
      element.style.getPropertyValue('display') === 'table' &&
      element.style.getPropertyValue('table-layout') === 'fixed' &&
      element.style.getPropertyValue('width') === TABLE_FILL &&
      element.style.getPropertyValue('max-width') === TABLE_FILL &&
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
  ]
    // Task 706: a table inside a diagram label (a d2 `|md` label, held in an svg foreignObject) is
    // part of the diagram picture, laid out before this pass. Styling it, and the auto-width class
    // only one pane's copy received, made the edit view and Preview markup of the same diagram
    // differ. HTML reaches an svg only through foreignObject, and `closest('svg')` avoids the
    // mixed-case foreignObject type selector (it does not match in jsdom). Filtered on the tables
    // already found: no extra work for a document without diagrams.
    .filter((table) => table.closest('.vditor-reset') && !table.closest('svg'))
    // Task 723: the front-matter properties table (and its nested map tables) is not a Markdown
    // table. It fits its name column to the longest name with an auto table layout (main.css), and
    // the inline `table-layout: fixed !important` below out-ranks every stylesheet rule, which gave
    // the name column one equal share again after a pass (measured 39 px in Preview). Left alone.
    .filter((table) => !table.closest('.vmde-front-matter'))
  tables.forEach((table) => {
    // Volatile width rules live outside Lute-owned DOM. The normalizer still owns every
    // pasted/Vditor inline width, while min-width lets a wide result scroll.
    const widths = sessionTableWidths(table)
    if (widths) ensureSessionTableWidths(table)
    // `width` is not an ignored attribute (class and style are): quiet, so the unit-DOM shadow model
    // sees no edit.
    // Quiet only when there is a width to remove: removing an absent attribute records nothing, and
    // the quiet hand-off costs a `takeRecords` per observer on every pass.
    if (table.hasAttribute('width'))
      writeQuietly(() => table.removeAttribute('width'))
    else table.removeAttribute('width')
    // Keep pasted/Vditor tables in table layout without outranking stateful visibility rules:
    // details collapse uses `display: none !important`, while build.mjs already patches Vditor's
    // base `.vditor-reset table` display. A normal-priority inline value preserves both contracts.
    table.style.setProperty('display', 'table')
    table.style.setProperty('table-layout', 'fixed', 'important')
    setImportantOnChange(table, 'width', TABLE_FILL)
    setImportantOnChange(table, 'max-width', widths ? 'none' : TABLE_FILL)
    table.style.setProperty(
      'min-width',
      widths ? `${widths.reduce((total, width) => total + width, 0)}px` : '0',
      'important',
    )
    table.style.setProperty('box-sizing', 'border-box')
    syncTableFloor(table)
    autoWidths.track(table)
  })

  for (const table of tables)
    for (const element of table.querySelectorAll<HTMLElement>(
      'colgroup col, th, td',
    ))
      clearCellWidth(element)
}

/** Removes the pinned widths of one cell or col (the per-element step of the table pass). */
function clearCellWidth(element: HTMLElement): void {
  if (element.hasAttribute('width'))
    writeQuietly(() => element.removeAttribute('width'))
  else element.removeAttribute('width')
  element.style.removeProperty('width')
  element.style.removeProperty('min-width')
  element.style.removeProperty('max-width')
  element.style.removeProperty('white-space')
}

/**
 * The units of a feed change that need the normalizer: a structural table gets its table pass, a cell
 * is normalized alone, an opaque table unit gets its table pass, and any other unit (a paragraph, a
 * list item) is not a table and keeps whatever other modules wrote on it.
 */
function queueFeedUnits(
  change: UnitsChange,
  blocks: Set<HTMLElement>,
  cells: Set<HTMLElement>,
): void {
  for (const table of change.structural) blocks.add(table)
  for (const unit of change.changed) {
    if (unit.kind === 'cell') cells.add(unit.el)
    else if (unit.el instanceof HTMLTableElement) blocks.add(unit.el)
  }
}

export function fixResponsiveTables() {
  responsiveTableCleanup?.()

  const root = (document.querySelector('.vditor') ??
    document.body) as HTMLElement
  const autoWidths = createAutoTableWidths(root)
  const pendingBlocks = new Set<HTMLElement>()
  // Changed cells of a live feed: only these are normalized, unless their table is in a block pass.
  const pendingCells = new Set<HTMLElement>()
  let pendingFull = false
  function normalizePendingCells(): void {
    for (const cell of pendingCells) {
      const table = cell.closest('table')
      if (cell.isConnected && !(table && pendingBlocks.has(table)))
        clearCellWidth(cell)
    }
  }
  const syncTables = debounce(() => {
    const full = pendingFull
    if (full) normalizeResponsiveTables(root, autoWidths, true)
    else {
      for (const block of pendingBlocks)
        normalizeResponsiveTables(block, autoWidths)
      normalizePendingCells()
    }
    pendingBlocks.clear()
    pendingCells.clear()
    pendingFull = false
    if (full) autoWidths.onFullPass()
  }, 16)

  const queueFull = () => {
    pendingBlocks.clear()
    pendingCells.clear()
    pendingFull = true
    syncTables()
  }

  queueFull()
  requestFullTableSync = queueFull

  const onResize = () => {
    queueFull()
  }

  window.addEventListener('resize', onResize)

  // Tables whose content records the live feed took over; an unhandled record while the feed is off
  // queues them (the feed will not report them any more).
  const deferredTables = new Set<HTMLElement>()

  /**
   * With a live feed, a content record (child list or text) inside a top-level table is handled from
   * the feed's units (`onFeedChange`). An attribute record is always handled here: the unit DOM
   * ignores `style`, so the feed would never report a cell whose inline width was written. A table
   * nested in a quote, a list item or a details block keeps this observer's own pass.
   */
  function handledByFeed(record: MutationRecord): boolean {
    if (record.type === 'attributes') return false
    const element =
      record.target instanceof Element
        ? record.target
        : record.target.parentElement
    const table = element?.closest('table')
    if (!table || !feedDescribes(table)) return false
    deferredTables.add(table)
    return true
  }

  /** The tables whose records were handed to the feed get their own pass. */
  function passDeferredTables(): void {
    if (deferredTables.size === 0) return
    if (!pendingFull)
      for (const table of deferredTables) pendingBlocks.add(table)
    deferredTables.clear()
    syncTables()
  }

  /** The feed went off since a record was handed to it: those tables get their own pass now. */
  function releaseDeferredTables(): void {
    if (deferredTables.size === 0 || unitFeedOf(window)?.isLive()) return
    passDeferredTables()
  }

  function onFeedChange(change: UnitsChange, feed: UnitFeed): void {
    if (!root.contains(feed.root)) return
    // Task 733 (012-9): only a build (open, mode switch) or a rebind (external update) is a
    // whole-document cause. A whole `mutation` or `sync` change is an edit the session could not
    // scope (a list structure change, for one); this observer saw its records, so the tables those
    // records touched get their pass: the ones handed to the feed here, the rest from the observer.
    if (
      change.whole &&
      (change.cause === 'build' || change.cause === 'rebind')
    ) {
      deferredTables.clear()
      queueFull()
      return
    }
    if (change.whole) {
      passDeferredTables()
      return
    }
    deferredTables.clear()
    if (change.structural.length === 0 && change.changed.length === 0) return
    if (!pendingFull) {
      queueFeedUnits(change, pendingBlocks, pendingCells)
    }
    syncTables()
  }

  const offFeed = onUnitFeed(window, onFeedChange)

  // This observer watches the attributes it also mutates (style/width) — the debounce plus
  // the idempotent normalization (re-setting identical values fires no mutation record) are
  // what keep it from looping. Don't widen the attributeFilter without re-checking that.
  const mutationObserver = new MutationObserver((records) => {
    // Our normalization writes the same style/width attributes this observer watches. Filter a
    // batch only when every record already reflects our exact normalized state; a mixed content or
    // externally changed attribute batch still reaches the conservative impact classifier.
    const relevant = records.filter(
      (record) =>
        !isOwnedNormalizedAttribute(record) &&
        !isOwnHintRecord(record) &&
        !handledByFeed(record) &&
        mutationMayAffectTable(record),
    )
    releaseDeferredTables()
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
    attributeFilter: ['style', 'width', INDENT_ATTR],
  })

  let resizeObserver: ResizeObserver | undefined
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      queueFull()
    })
    resizeObserver.observe(root)
  }

  responsiveTableCleanup = () => {
    if (requestFullTableSync === queueFull) requestFullTableSync = null
    window.removeEventListener('resize', onResize)
    offFeed()
    mutationObserver.disconnect()
    resizeObserver?.disconnect()
    syncTables.cancel()
    autoWidths.dispose()
  }
}
