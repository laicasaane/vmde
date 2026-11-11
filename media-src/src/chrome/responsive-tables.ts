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
      syncTableFloor(table)
      return
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
    if (owned.size === 0 || records.length === 0) return
    const now = performance.now()
    let adopted = false
    let edited = false
    let removed = false
    for (const record of records) {
      for (const pair of replacementPairs(record))
        adopted = adoptReplacement(pair, now) || adopted
      removed ||= removesCachedTable(record)
      edited = markEdited(record, now) || edited
    }
    if (adopted || edited) pauseUntil(now + AUTO_PAUSE_MS)
    // A removed table's width rules are dropped by the next flush.
    else if (removed) soon()
  }

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
    )) {
      if (element.hasAttribute('width'))
        writeQuietly(() => element.removeAttribute('width'))
      else element.removeAttribute('width')
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
  requestFullTableSync = queueFull

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
        !isOwnedNormalizedAttribute(record) &&
        !isOwnHintRecord(record) &&
        mutationMayAffectTable(record),
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
    mutationObserver.disconnect()
    resizeObserver?.disconnect()
    syncTables.cancel()
    autoWidths.dispose()
  }
}
