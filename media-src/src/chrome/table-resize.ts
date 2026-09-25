import { findScroller } from './toolbar-scroll-guard'

// Task 219: column widths are view-only state. No source or host setting stores them.
// The handles and width rules live outside Vditor's editable DOM; only a class touches the table.

export const MIN_TABLE_COLUMN_WIDTH = 48

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

export function clearSessionTableWidths(table: HTMLTableElement): void {
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
  table.classList.add('vmde-table-resized', state.className)
  const rules = state.widths
    .map(
      (width, index) =>
        `.vditor-reset table.${state.className} tr > :is(th, td):nth-child(${index + 1}) { width: ${width}px !important; }`,
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

function headerCells(table: HTMLTableElement): HTMLTableCellElement[] {
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

function autoFitWidth(table: HTMLTableElement, column: number): number {
  let widest = MIN_TABLE_COLUMN_WIDTH
  for (const row of Array.from(table.rows)) {
    const cell = row.cells[column]
    if (!cell) continue
    const copy = cell.cloneNode(true) as HTMLElement
    copy.style.position = 'fixed'
    copy.style.visibility = 'hidden'
    copy.style.width = 'max-content'
    copy.style.minWidth = '0'
    copy.style.maxWidth = 'none'
    copy.style.whiteSpace = 'nowrap'
    copy.style.overflowWrap = 'normal'
    document.body.append(copy)
    widest = Math.max(widest, copy.getBoundingClientRect().width)
    copy.remove()
  }
  return clampTableColumnWidth(widest)
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
        name === 'vmde-table-resized' || name.startsWith('vmde-table-width-'),
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
    if (name === 'style' || isResizeWidthClassMutation(record))
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
