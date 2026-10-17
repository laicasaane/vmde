import { findScroller } from './toolbar-scroll-guard'

// Task 219: column widths are view-only state. No source or host setting stores them.
// The handles and width rules live outside Vditor's editable DOM; only a class touches the table.

export const MIN_TABLE_COLUMN_WIDTH = 48

// Task 639: content-aware automatic widths use their own class family. A session width (a manual
// resize) always wins, so setting one strips this class; the resize observer ignores it like the
// session classes because it changes widths only.
export const AUTO_WIDTH_CLASS_PREFIX = 'vmde-table-auto-'

interface SessionWidths {
  widths: number[]
  className: string
  style: HTMLStyleElement
}

const widthsByTable = new WeakMap<HTMLTableElement, SessionWidths>()
const ownedTables = new Set<HTMLTableElement>()
let nextWidthId = 0

export function clampTableColumnWidth(width: number): number {
  return Math.max(MIN_TABLE_COLUMN_WIDTH, Math.round(width))
}

export interface TableResizeRect {
  left: number
  right: number
  top: number
  bottom: number
}

export interface TableResizeHandleLayout {
  left: number
  top: number
  height: number
  visible: boolean
}

/** Clip a header-border handle to the visible editor and nested table scrollports. */
export function tableResizeHandleLayout(
  cell: TableResizeRect,
  clip: TableResizeRect,
): TableResizeHandleLayout {
  const top = Math.max(cell.top, clip.top)
  const bottom = Math.min(cell.bottom, clip.bottom)
  return {
    left: cell.right - 4,
    top,
    height: Math.max(0, bottom - top),
    visible:
      cell.right >= clip.left &&
      cell.right <= clip.right &&
      bottom > top &&
      cell.right > cell.left,
  }
}

export function sessionTableWidths(table: HTMLTableElement): number[] | null {
  const state = widthsByTable.get(table)
  return state?.widths.length === table.rows[0]?.cells.length
    ? [...state.widths]
    : null
}

function clearSessionTableWidths(table: HTMLTableElement): void {
  const state = widthsByTable.get(table)
  if (!state) return
  table.classList.remove('vmde-table-resized', state.className)
  state.style.remove()
  widthsByTable.delete(table)
  ownedTables.delete(table)
}

/** Keep width rules outside Lute's editable table: a DOM colgroup makes GFM serialization blank. */
export function ensureSessionTableWidths(table: HTMLTableElement): boolean {
  const state = widthsByTable.get(table)
  if (!state) return false
  if (!sessionTableWidths(table)) {
    clearSessionTableWidths(table)
    return false
  }
  for (const name of Array.from(table.classList))
    if (name.startsWith(AUTO_WIDTH_CLASS_PREFIX)) table.classList.remove(name)
  table.classList.add('vmde-table-resized', state.className)
  const rules = state.widths
    .map(
      (width, index) =>
        `.vditor-reset table.${state.className} tr > :is(th, td):nth-child(${index + 1}) { box-sizing: border-box !important; width: ${width}px !important; }`,
    )
    .join('\n')
  if (state.style.textContent !== rules) state.style.textContent = rules
  return true
}

export function setSessionTableWidths(
  table: HTMLTableElement,
  widths: number[],
): boolean {
  if (
    !widths.length ||
    widths.length !== table.rows[0]?.cells.length ||
    widths.some((width) => !Number.isFinite(width))
  )
    return false
  let state = widthsByTable.get(table)
  if (!state) {
    const style = document.createElement('style')
    document.head.append(style)
    state = {
      widths: [],
      className: `vmde-table-width-${++nextWidthId}`,
      style,
    }
    widthsByTable.set(table, state)
    ownedTables.add(table)
  }
  state.widths = widths.map(clampTableColumnWidth)
  return ensureSessionTableWidths(table)
}

/** Header cells of a rectangular, ordinary table; empty for every table the width tools skip. */
export function headerCells(table: HTMLTableElement): HTMLTableCellElement[] {
  const row = table.rows[0]
  if (
    !row?.cells.length ||
    Array.from(row.cells).some((cell) => cell.tagName !== 'TH') ||
    table.querySelector('table,[colspan],[rowspan]') ||
    table.closest(
      '.vditor-ir__preview, .vditor-wysiwyg__preview, [data-type="html-block"], li, blockquote',
    ) ||
    Array.from(table.rows).some(
      (candidate) => candidate.cells.length !== row.cells.length,
    )
  )
    return []
  return Array.from(row.cells)
}

function measuredWidths(table: HTMLTableElement): number[] {
  return Array.from(table.rows[0].cells, (cell) =>
    clampTableColumnWidth(cell.getBoundingClientRect().width),
  )
}

// Measurement host (Tasks 219 and 639): detached clones of live tables are laid out in a hidden
// element appended to `body`, outside every observer's root, so no helper sees them. The ancestor
// chain of the table is mirrored by tag, class and attributes so editor CSS (cell padding, fonts,
// borders, theme) applies as it does in place. One stylesheet inside the host sets the two
// layouts the width tools read: `max` (nowrap, max-content) and `min` (normal wrapping,
// min-content), both with `overflow-wrap` and `word-break` back to `normal` because the editor
// sets both to break anywhere.
const MEASURE_RULES = `
[data-vmde-measure] table { table-layout: auto !important; max-width: none !important; min-width: 0 !important; }
[data-vmde-measure="max"] table { width: max-content !important; }
[data-vmde-measure="min"] table { width: min-content !important; }
[data-vmde-measure] :is(th, td) { overflow-wrap: normal !important; word-break: normal !important; }
[data-vmde-measure="max"] :is(th, td) { white-space: nowrap !important; }
[data-vmde-measure="min"] :is(th, td) { white-space: normal !important; }`

export interface MeasureHost {
  element: HTMLElement
  /** Switch every mounted clone to the `max` or `min` content layout. */
  layout(kind: 'max' | 'min'): void
  dispose(): void
}

export function createMeasureHost(root: HTMLElement): MeasureHost {
  const element = document.createElement('div')
  element.setAttribute('data-vmde-measure', 'max')
  element.className = root.className
  element.style.cssText =
    'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;'
  const rules = document.createElement('style')
  rules.textContent = MEASURE_RULES
  element.append(rules)
  document.body.append(element)
  return {
    element,
    layout: (kind) => element.setAttribute('data-vmde-measure', kind),
    dispose: () => element.remove(),
  }
}

/** Clone `table` into `host` under a mirror of its ancestor chain up to `root` (exclusive). */
export function mountMeasureClone(
  table: HTMLTableElement,
  root: HTMLElement,
  host: HTMLElement,
): HTMLTableElement {
  const chain: HTMLElement[] = []
  for (
    let element = table.parentElement;
    element && element !== root;
    element = element.parentElement
  )
    chain.unshift(element)
  let parent = host
  for (const source of chain) {
    const shell = document.createElement(source.localName)
    for (const { name, value } of Array.from(source.attributes))
      if (name !== 'id' && name !== 'style' && name !== 'contenteditable')
        shell.setAttribute(name, value)
    parent.append(shell)
    parent = shell
  }
  const clone = table.cloneNode(true) as HTMLTableElement
  // The normalizer's inline important layout would beat the host stylesheet.
  for (const property of ['table-layout', 'width', 'max-width', 'min-width'])
    clone.style.removeProperty(property)
  // Width classes of the live table must not shape its own measurement; the expanded IR marker
  // state is a transient caret effect (markers are zero width while collapsed).
  for (const name of Array.from(clone.classList))
    if (name.startsWith('vmde-table-')) clone.classList.remove(name)
  for (const expanded of clone.querySelectorAll('.vditor-ir__node--expand'))
    expanded.classList.remove('vditor-ir__node--expand')
  for (const identified of clone.querySelectorAll('[id]'))
    identified.removeAttribute('id')
  parent.append(clone)
  return clone
}

// The border-box width of the column at its max-content, measured inside the table's own
// ancestor chain so cell padding and borders count. Rounded up so a fitted column never wraps by a
// fraction of a pixel.
function autoFitWidth(table: HTMLTableElement, column: number): number {
  const root = document.querySelector<HTMLElement>('.vditor') ?? document.body
  const host = createMeasureHost(root)
  try {
    const clone = mountMeasureClone(table, root, host.element)
    host.layout('max')
    let widest = MIN_TABLE_COLUMN_WIDTH
    for (const row of Array.from(clone.rows)) {
      const cell = row.cells[column]
      if (cell) widest = Math.max(widest, cell.getBoundingClientRect().width)
    }
    return clampTableColumnWidth(Math.ceil(widest))
  } finally {
    host.dispose()
  }
}

interface ResizeHandle {
  element: HTMLElement
  column: number
}

interface TableMembership {
  row: HTMLTableRowElement
  cells: HTMLTableCellElement[]
  handles: ResizeHandle[]
}

interface ActiveSurface {
  mode: 'ir' | 'wysiwyg'
  root: HTMLElement
  scroller: HTMLElement
}

function sameHeaderCells(
  left: HTMLTableCellElement[],
  right: HTMLTableCellElement[],
): boolean {
  return (
    left.length === right.length &&
    left.every((cell, index) => cell === right[index])
  )
}

function isResizeWidthClassMutation(record: MutationRecord): boolean {
  if (
    record.attributeName !== 'class' ||
    !(record.target instanceof HTMLTableElement)
  )
    return false
  const previous = new Set(
    (record.oldValue ?? '').split(/\s+/u).filter(Boolean),
  )
  const current = new Set(record.target.classList)
  const changed = new Set([...previous, ...current])
  return [...changed]
    .filter((name) => previous.has(name) !== current.has(name))
    .every(
      (name) =>
        name === 'vmde-table-resized' ||
        name.startsWith('vmde-table-width-') ||
        name.startsWith(AUTO_WIDTH_CLASS_PREFIX),
    )
}

function containsTableStructure(node: Node): boolean {
  if (!(node instanceof Element)) return false
  return (
    node.matches('table,thead,tbody,tfoot,tr,th,td') ||
    node.querySelector('table,thead,tbody,tfoot,tr,th,td') !== null
  )
}

function clipsOverflow(value: string): boolean {
  return value !== 'visible' && value !== 'unset'
}

function scrollportBounds(scroller: HTMLElement): TableResizeRect {
  if (
    scroller === document.scrollingElement ||
    scroller === document.documentElement
  )
    return { left: 0, right: innerWidth, top: 0, bottom: innerHeight }
  const rect = scroller.getBoundingClientRect()
  const left = rect.left + scroller.clientLeft
  const top = rect.top + scroller.clientTop
  return {
    left,
    right: left + scroller.clientWidth,
    top,
    bottom: top + scroller.clientHeight,
  }
}

function tableClipBounds(
  table: HTMLTableElement,
  scroller: HTMLElement,
  rootBounds: TableResizeRect,
): TableResizeRect {
  const clip = { ...rootBounds }
  let ancestor = table.parentElement
  while (ancestor && ancestor !== scroller) {
    const style = getComputedStyle(ancestor)
    const clipsX = clipsOverflow(style.overflowX)
    const clipsY = clipsOverflow(style.overflowY)
    if (clipsX || clipsY) {
      const rect = ancestor.getBoundingClientRect()
      const left = rect.left + ancestor.clientLeft
      const top = rect.top + ancestor.clientTop
      if (clipsX) {
        clip.left = Math.max(clip.left, left)
        clip.right = Math.min(clip.right, left + ancestor.clientWidth)
      }
      if (clipsY) {
        clip.top = Math.max(clip.top, top)
        clip.bottom = Math.min(clip.bottom, top + ancestor.clientHeight)
      }
    }
    ancestor = ancestor.parentElement
  }
  return clip
}

/** Header-border controls for the active editable mode; disposed on editor re-init. */
export function installTableColumnResize(): () => void {
  const layer = document.createElement('div')
  layer.className = 'vmde-table-resize-layer'
  document.body.append(layer)
  const membership = new Map<HTMLTableElement, TableMembership>()
  const visibleTables = new Set<HTMLTableElement>()
  let activeRoot: HTMLElement | null = null
  let activeMode: ActiveSurface['mode'] | null = null
  let scroller: HTMLElement | null = null
  let intersectionObserver: IntersectionObserver | undefined
  let resizeObserver: ResizeObserver | undefined
  let frame = 0
  let membershipDirty = true
  let geometryDirty = true
  let drag: {
    table: HTMLTableElement
    column: number
    startX: number
    widths: number[]
  } | null = null

  const activeSurface = (): ActiveSurface | null => {
    const editor = window.vditor
    const mode = editor?.getCurrentMode()
    if (mode !== 'ir' && mode !== 'wysiwyg') return null
    const root = editor.vditor[mode]?.element as HTMLElement | undefined
    if (!root?.isConnected) return null
    return { mode, root, scroller: findScroller(root) }
  }

  function scheduleFrame(): void {
    if (!frame) frame = requestAnimationFrame(runFrame)
  }

  function scheduleMembership(): void {
    membershipDirty = true
    geometryDirty = true
    scheduleFrame()
  }

  function scheduleGeometry(): void {
    geometryDirty = true
    scheduleFrame()
  }

  function setHandleDisplay(element: HTMLElement, display: '' | 'none'): void {
    if (element.style.display !== display) element.style.display = display
  }

  function hideTableHandles(table: HTMLTableElement): void {
    for (const handle of membership.get(table)?.handles ?? [])
      setHandleDisplay(handle.element, 'none')
  }

  function hideAllHandles(): void {
    for (const table of membership.keys()) hideTableHandles(table)
  }

  function removeMembership(table: HTMLTableElement): void {
    const entry = membership.get(table)
    if (!entry) return
    intersectionObserver?.unobserve(entry.row)
    resizeObserver?.unobserve(entry.row)
    visibleTables.delete(table)
    for (const handle of entry.handles) handle.element.remove()
    membership.delete(table)
    if (!table.isConnected) clearSessionTableWidths(table)
  }

  function onUp(): void {
    if (!drag) return
    drag = null
    document.body.classList.remove('vmde-table-resizing')
    scheduleGeometry()
  }

  function makeHandle(table: HTMLTableElement, column: number): ResizeHandle {
    const element = document.createElement('div')
    element.className = 'vmde-table-resize-handle'
    element.setAttribute('role', 'separator')
    element.setAttribute('aria-orientation', 'vertical')
    element.setAttribute('aria-label', `Resize table column ${column + 1}`)
    element.setAttribute('aria-valuemin', String(MIN_TABLE_COLUMN_WIDTH))
    element.tabIndex = 0
    element.style.display = 'none'
    element.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      drag = {
        table,
        column,
        startX: event.clientX,
        widths: sessionTableWidths(table) ?? measuredWidths(table),
      }
      document.body.classList.add('vmde-table-resizing')
      scheduleGeometry()
    })
    element.addEventListener('dblclick', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const widths = sessionTableWidths(table) ?? measuredWidths(table)
      widths[column] = autoFitWidth(table, column)
      apply(table, widths)
    })
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const widths = sessionTableWidths(table) ?? measuredWidths(table)
      widths[column] = clampTableColumnWidth(
        widths[column] + (event.key === 'ArrowRight' ? 10 : -10),
      )
      apply(table, widths)
    })
    layer.append(element)
    return { element, column }
  }

  function apply(table: HTMLTableElement, widths: number[]): void {
    if (!table.isConnected || !setSessionTableWidths(table, widths)) return
    scheduleGeometry()
  }

  function onMove(event: MouseEvent): void {
    if (!drag) return
    const widths = [...drag.widths]
    widths[drag.column] = clampTableColumnWidth(
      drag.widths[drag.column] + event.clientX - drag.startX,
    )
    apply(drag.table, widths)
  }

  function onIntersection(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const table = (entry.target as HTMLElement).closest<HTMLTableElement>(
        'table',
      )
      if (!table || !membership.has(table)) continue
      if (
        entry.isIntersecting &&
        entry.intersectionRect.width > 0 &&
        entry.intersectionRect.height > 0
      )
        visibleTables.add(table)
      else {
        visibleTables.delete(table)
        if (drag?.table !== table) hideTableHandles(table)
      }
    }
    scheduleGeometry()
  }

  function replaceSurface(next: ActiveSurface | null): void {
    intersectionObserver?.disconnect()
    resizeObserver?.disconnect()
    for (const table of [...membership.keys()]) removeMembership(table)
    visibleTables.clear()
    if (drag) {
      drag = null
      document.body.classList.remove('vmde-table-resizing')
    }
    activeRoot = next?.root ?? null
    activeMode = next?.mode ?? null
    scroller = next?.scroller ?? null
    if (activeRoot && scroller) {
      intersectionObserver = new IntersectionObserver(onIntersection, {
        root: scroller,
        threshold: 0,
      })
      resizeObserver = new ResizeObserver(scheduleGeometry)
      resizeObserver.observe(activeRoot)
      if (scroller !== activeRoot) resizeObserver.observe(scroller)
    } else {
      intersectionObserver = undefined
      resizeObserver = undefined
    }
  }

  function refreshSurface(): boolean {
    const next = activeSurface()
    if (
      (next?.root ?? null) === activeRoot &&
      (next?.mode ?? null) === activeMode &&
      (next?.scroller ?? null) === scroller
    )
      return false
    replaceSurface(next)
    return true
  }

  function reconcileTable(
    table: HTMLTableElement,
    found: Set<HTMLTableElement>,
  ): void {
    const cells = headerCells(table)
    if (!cells.length) {
      removeMembership(table)
      return
    }
    if (widthsByTable.has(table) && !sessionTableWidths(table))
      clearSessionTableWidths(table)
    const row = cells[0].parentElement
    if (!(row instanceof HTMLTableRowElement)) {
      removeMembership(table)
      return
    }
    const previous = membership.get(table)
    if (
      previous &&
      previous.row === row &&
      sameHeaderCells(previous.cells, cells)
    ) {
      found.add(table)
      return
    }
    removeMembership(table)
    const entry: TableMembership = {
      row,
      cells,
      handles: cells.map((_, column) => makeHandle(table, column)),
    }
    membership.set(table, entry)
    intersectionObserver?.observe(row)
    resizeObserver?.observe(row)
    found.add(table)
  }

  function removeMissingMembership(found: Set<HTMLTableElement>): void {
    for (const table of [...membership.keys()]) {
      if (found.has(table)) continue
      removeMembership(table)
      if (!table.isConnected) clearSessionTableWidths(table)
    }
    for (const table of [...ownedTables])
      if (!table.isConnected) clearSessionTableWidths(table)
  }

  function reconcileMembership(): void {
    if (!activeRoot || !scroller) return
    const found = new Set<HTMLTableElement>()
    for (const table of activeRoot.querySelectorAll<HTMLTableElement>('table'))
      reconcileTable(table, found)
    removeMissingMembership(found)
  }

  function surfaceIsVisible(): boolean {
    if (
      !activeRoot?.isConnected ||
      !scroller?.isConnected ||
      document.visibilityState === 'hidden' ||
      scroller.clientWidth === 0 ||
      scroller.clientHeight === 0
    )
      return false
    const rect = activeRoot.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  function writeGeometry(
    handle: HTMLElement,
    layout: TableResizeHandleLayout,
    valueNow: number,
  ): void {
    const left = `${layout.left}px`
    const top = `${layout.top}px`
    const height = `${layout.height}px`
    const display = layout.visible ? '' : 'none'
    if (handle.style.left !== left) handle.style.left = left
    if (handle.style.top !== top) handle.style.top = top
    if (handle.style.height !== height) handle.style.height = height
    setHandleDisplay(handle, display)
    const current = String(valueNow)
    if (handle.getAttribute('aria-valuenow') !== current)
      handle.setAttribute('aria-valuenow', current)
    const minimum = String(MIN_TABLE_COLUMN_WIDTH)
    if (handle.getAttribute('aria-valuemin') !== minimum)
      handle.setAttribute('aria-valuemin', minimum)
  }

  function updateGeometry(): void {
    if (!activeRoot || !scroller || !surfaceIsVisible()) {
      hideAllHandles()
      return
    }
    const rootBounds = scrollportBounds(scroller)
    const candidates = new Set(visibleTables)
    if (drag && membership.has(drag.table)) candidates.add(drag.table)
    const measurements: Array<{
      handle: HTMLElement
      layout: TableResizeHandleLayout
      valueNow: number
    }> = []
    for (const table of candidates) {
      const entry = membership.get(table)
      if (!entry || !table.isConnected || !activeRoot.contains(table)) continue
      const clip = tableClipBounds(table, scroller, rootBounds)
      const widths = sessionTableWidths(table)
      entry.cells.forEach((cell, index) => {
        const rect = cell.getBoundingClientRect()
        measurements.push({
          handle: entry.handles[index].element,
          layout: tableResizeHandleLayout(rect, clip),
          valueNow: widths?.[index] ?? Math.round(rect.right - rect.left),
        })
      })
    }
    for (const measurement of measurements)
      writeGeometry(
        measurement.handle,
        measurement.layout,
        measurement.valueNow,
      )
  }

  function runFrame(): void {
    frame = 0
    if (refreshSurface()) membershipDirty = true
    if (membershipDirty) {
      membershipDirty = false
      reconcileMembership()
    }
    if (geometryDirty) {
      geometryDirty = false
      updateGeometry()
    }
    if (membershipDirty || geometryDirty) scheduleFrame()
  }

  function attributeMutationEffect(
    record: MutationRecord,
  ): 'membership' | 'geometry' | 'ignore' {
    const name = record.attributeName ?? ''
    if (name.startsWith('aria-')) return 'ignore'
    // Task 649: the section-indent marks only move the block's start margin, never table membership.
    if (
      name === 'style' ||
      name === 'data-vmde-indent' ||
      name === 'data-vmde-indent-root' ||
      isResizeWidthClassMutation(record)
    )
      return 'geometry'
    return 'membership'
  }

  function childListMutationEffect(
    record: MutationRecord,
  ): 'membership' | 'geometry' {
    if (
      [...record.addedNodes, ...record.removedNodes].some(
        containsTableStructure,
      )
    )
      return 'membership'
    const target =
      record.target instanceof Element
        ? record.target
        : record.target.parentElement
    return target?.closest('td,th') ? 'geometry' : 'membership'
  }

  function mutationEffect(
    record: MutationRecord,
  ): 'membership' | 'geometry' | 'ignore' {
    if (record.type === 'characterData') return 'geometry'
    if (record.type === 'attributes') return attributeMutationEffect(record)
    if (record.type === 'childList') return childListMutationEffect(record)
    return 'ignore'
  }

  function onMutations(records: MutationRecord[]): void {
    const effects = new Set(records.map(mutationEffect))
    if (effects.has('membership')) scheduleMembership()
    else if (effects.has('geometry')) scheduleGeometry()
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'hidden') hideAllHandles()
    else scheduleMembership()
  }

  const scrollRoot = document.querySelector('.vditor') ?? document.body
  const mutationObserver = new MutationObserver(onMutations)
  mutationObserver.observe(scrollRoot, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true,
  })
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('scroll', scheduleGeometry, true)
  window.addEventListener('resize', scheduleGeometry)
  document.fonts?.addEventListener('loadingdone', scheduleGeometry)
  scheduleMembership()

  return () => {
    onUp()
    if (frame) cancelAnimationFrame(frame)
    intersectionObserver?.disconnect()
    resizeObserver?.disconnect()
    mutationObserver.disconnect()
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('scroll', scheduleGeometry, true)
    window.removeEventListener('resize', scheduleGeometry)
    document.fonts?.removeEventListener('loadingdone', scheduleGeometry)
    for (const table of [...membership.keys()]) removeMembership(table)
    layer.remove()
    for (const table of [...ownedTables]) clearSessionTableWidths(table)
  }
}
