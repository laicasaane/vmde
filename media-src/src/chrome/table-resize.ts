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

/** Header-border controls for the active editable mode; disposed on editor re-init. */
export function installTableColumnResize(): () => void {
  const layer = document.createElement('div')
  layer.className = 'vmde-table-resize-layer'
  document.body.append(layer)
  const handles = new Map<HTMLTableElement, ResizeHandle[]>()
  let frame = 0
  let drag: {
    table: HTMLTableElement
    column: number
    startX: number
    widths: number[]
  } | null = null

  const activeRoot = (): HTMLElement | null => {
    const editor = window.vditor
    const mode = editor?.getCurrentMode()
    if (mode !== 'ir' && mode !== 'wysiwyg') return null
    return editor.vditor[mode]?.element ?? null
  }

  const apply = (table: HTMLTableElement, widths: number[]) => {
    if (!table.isConnected || !setSessionTableWidths(table, widths)) return
    schedule()
  }

  const onMove = (event: MouseEvent) => {
    if (!drag) return
    const widths = [...drag.widths]
    widths[drag.column] = clampTableColumnWidth(
      drag.widths[drag.column] + event.clientX - drag.startX,
    )
    apply(drag.table, widths)
  }
  const onUp = () => {
    if (!drag) return
    drag = null
    document.body.classList.remove('vmde-table-resizing')
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)

  const makeHandle = (
    table: HTMLTableElement,
    column: number,
  ): ResizeHandle => {
    const element = document.createElement('div')
    element.className = 'vmde-table-resize-handle'
    element.setAttribute('role', 'separator')
    element.setAttribute('aria-orientation', 'vertical')
    element.setAttribute('aria-label', `Resize table column ${column + 1}`)
    element.tabIndex = 0
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

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: reconciles live table geometry, mode visibility, and detached handles in one animation frame.
  const sync = () => {
    frame = 0
    const root = activeRoot()
    const visible = new Set<HTMLTableElement>()
    if (root) {
      for (const table of root.querySelectorAll<HTMLTableElement>('table')) {
        const cells = headerCells(table)
        if (!cells.length) continue
        if (widthsByTable.has(table) && !sessionTableWidths(table))
          clearSessionTableWidths(table)
        visible.add(table)
        let row = handles.get(table)
        if (!row || row.length !== cells.length) {
          row?.forEach(({ element }) => {
            element.remove()
          })
          row = cells.map((_, column) => makeHandle(table, column))
          handles.set(table, row)
        }
        row.forEach(({ element, column }) => {
          const rect = cells[column].getBoundingClientRect()
          element.style.left = `${rect.right - 4}px`
          element.style.top = `${rect.top}px`
          element.style.height = `${rect.height}px`
          element.style.display =
            rect.width > 0 && rect.height > 0 ? '' : 'none'
          element.setAttribute(
            'aria-valuenow',
            String(
              sessionTableWidths(table)?.[column] ?? Math.round(rect.width),
            ),
          )
          element.setAttribute('aria-valuemin', String(MIN_TABLE_COLUMN_WIDTH))
        })
      }
    }
    for (const [table, row] of handles) {
      if (visible.has(table)) continue
      if (!table.isConnected) clearSessionTableWidths(table)
      row.forEach(({ element }) => {
        element.remove()
      })
      handles.delete(table)
    }
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(sync)
  }
  const root = document.querySelector('.vditor') ?? document.body
  const observer = new MutationObserver(schedule)
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  })
  window.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', schedule)
  schedule()

  return () => {
    onUp()
    if (frame) cancelAnimationFrame(frame)
    observer.disconnect()
    window.removeEventListener('scroll', schedule, true)
    window.removeEventListener('resize', schedule)
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    layer.remove()
    for (const table of ownedTables) clearSessionTableWidths(table)
  }
}
