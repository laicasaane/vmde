import { guardComposition } from '../util/caret-gesture'
import {
  runTableClear,
  runTableRectangleOperation,
  tableRectangleClipboard,
} from './table-actions'
import type { TableRectangleOperation } from './table-operations'

export interface TableCellSelection {
  select(anchor: HTMLTableCellElement, focus: HTMLTableCellElement): boolean
  clear(): boolean
  dimensions(): { rows: number; columns: number } | null
  cells(): HTMLTableCellElement[] | null
  dispose(): void
}

interface TableCellSelectionOptions {
  markdownForRectangle?: (
    table: HTMLTableElement,
    anchorRow: number,
    focusRow: number,
    anchorColumn: number,
    focusColumn: number,
  ) => string | null
}

interface CellPoint {
  table: HTMLTableElement
  row: number
  column: number
}

interface SelectionState {
  anchor: CellPoint
  focus: CellPoint
}

export type TablePanelAction =
  | 'insertRowA'
  | 'insertRowB'
  | 'insertColumnL'
  | 'insertColumnR'
  | 'deleteRow'
  | 'deleteColumn'

const controllers = new WeakMap<
  HTMLElement,
  { state: () => SelectionState | null; clear: () => boolean }
>()

function controllerRoot(table: HTMLTableElement): HTMLElement | null {
  // Vditor wraps the editable PRE in a `.vditor-ir`/`.vditor-wysiwyg` container. Controllers are
  // installed on that PRE, so resolve the registered ancestor instead of the visual outer shell.
  for (let node: Element | null = table; node; node = node.parentElement) {
    if (node instanceof HTMLElement && controllers.has(node)) return node
  }
  return null
}

function rangeOperation(action: TablePanelAction): TableRectangleOperation {
  return action === 'insertRowA'
    ? 'insertRowAbove'
    : action === 'insertRowB'
      ? 'insertRowBelow'
      : action === 'insertColumnL'
        ? 'insertColumnLeft'
        : action === 'insertColumnR'
          ? 'insertColumnRight'
          : action === 'deleteRow'
            ? 'deleteRows'
            : 'deleteColumns'
}

/** Routes an existing table-panel operation over the active fake rectangle, if any. */
export function runTablePanelRectangleAction(
  table: HTMLTableElement,
  action: TablePanelAction,
): boolean {
  const root = controllerRoot(table)
  if (!root) return false
  const controller = controllers.get(root)
  const state = controller?.state()
  if (!state || state.anchor.table !== table || state.focus.table !== table)
    return false
  const applied = runTableRectangleOperation(
    table,
    state.anchor.row,
    state.focus.row,
    state.anchor.column,
    state.focus.column,
    rangeOperation(action),
  )
  if (applied) controller.clear()
  return applied
}

function pointFor(cell: HTMLTableCellElement): CellPoint | null {
  const table = cell.closest('table')
  if (!(table instanceof HTMLTableElement)) return null
  if (table.querySelector('table,[rowspan],[colspan]')) return null
  const rows = Array.from(table.rows)
  const row = cell.parentElement?.closest('tr')
  const rowIndex = row ? rows.indexOf(row) : -1
  const column = row ? Array.from(row.cells).indexOf(cell) : -1
  const width = rows[0]?.cells.length ?? 0
  if (
    rowIndex < 0 ||
    column < 0 ||
    width === 0 ||
    rows.some((candidate) => candidate.cells.length !== width)
  ) {
    return null
  }
  return { table, row: rowIndex, column }
}

function cellAt(point: CellPoint): HTMLTableCellElement | null {
  if (!point.table.isConnected) return null
  return point.table.rows[point.row]?.cells[point.column] ?? null
}

function cellFromNode(node: Node | null): HTMLTableCellElement | null {
  const element = node instanceof Element ? node : node?.parentElement
  const cell = element?.closest('td,th')
  return cell instanceof HTMLTableCellElement ? cell : null
}

function visibleCellText(cell: HTMLTableCellElement): string {
  const clone = cell.cloneNode(true) as HTMLElement
  clone
    .querySelectorAll('.vditor-ir__marker, .vditor-wysiwyg__marker')
    .forEach((marker) => {
      marker.remove()
    })
  return clone.textContent ?? ''
}

function selectedCells(state: SelectionState): HTMLTableCellElement[] | null {
  if (state.anchor.table !== state.focus.table) return null
  const rowStart = Math.min(state.anchor.row, state.focus.row)
  const rowEnd = Math.max(state.anchor.row, state.focus.row)
  const columnStart = Math.min(state.anchor.column, state.focus.column)
  const columnEnd = Math.max(state.anchor.column, state.focus.column)
  const cells: HTMLTableCellElement[] = []
  for (let row = rowStart; row <= rowEnd; row++) {
    for (let column = columnStart; column <= columnEnd; column++) {
      const cell = cellAt({ ...state.anchor, row, column })
      if (!cell) return null
      cells.push(cell)
    }
  }
  return cells
}

function dimensions(state: SelectionState): { rows: number; columns: number } {
  return {
    rows: Math.abs(state.anchor.row - state.focus.row) + 1,
    columns: Math.abs(state.anchor.column - state.focus.column) + 1,
  }
}

/**
 * Paints a spreadsheet-like cell rectangle without inserting editable DOM. The state is kept
 * outside Lute-owned nodes and cleared on input, so a spin cannot leave a stale fake selection.
 */
export function installTableCellSelection(
  root: HTMLElement,
  options: TableCellSelectionOptions = {},
): TableCellSelection {
  let state: SelectionState | null = null
  let pointerAnchor: HTMLTableCellElement | null = null
  const status = document.createElement('div')
  status.className = 'vmde-cell-selection-status'
  status.setAttribute('aria-live', 'polite')
  status.setAttribute('aria-atomic', 'true')
  root.insertAdjacentElement('afterend', status)

  const paint = () => {
    for (const cell of root.querySelectorAll('.vmde-cell-selected'))
      cell.classList.remove('vmde-cell-selected')
    const cells = state ? selectedCells(state) : null
    if (!cells) {
      state = null
      status.textContent = ''
      return false
    }
    for (const cell of cells) cell.classList.add('vmde-cell-selected')
    const size = dimensions(state)
    status.textContent = `${size.rows} rows by ${size.columns} columns selected`
    return true
  }

  const clear = () => {
    const hadSelection = state !== null
    state = null
    paint()
    return hadSelection
  }

  const select = (
    anchor: HTMLTableCellElement,
    focus: HTMLTableCellElement,
  ) => {
    const anchorPoint = pointFor(anchor)
    const focusPoint = pointFor(focus)
    if (!anchorPoint || !focusPoint || anchorPoint.table !== focusPoint.table)
      return false
    state = { anchor: anchorPoint, focus: focusPoint }
    return paint()
  }

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null
    // The IR panel sits inside the editor root but is explicitly non-editable. Keeping the
    // rectangle through its mousedown lets the panel apply the range instead of reverting to a
    // one-cell native action.
    if (target?.closest('[contenteditable="false"]')) return
    clear()
    pointerAnchor = cellFromNode(
      event.target instanceof Node ? event.target : null,
    )
  }
  const onPointerMove = (event: PointerEvent) => {
    if (!pointerAnchor || event.buttons === 0) return
    const target = document.elementFromPoint(event.clientX, event.clientY)
    const focus = cellFromNode(target)
    if (focus && focus !== pointerAnchor) select(pointerAnchor, focus)
  }
  const onPointerUp = () => {
    pointerAnchor = null
  }
  const onPointerCancel = () => {
    pointerAnchor = null
    clear()
  }
  const onDocumentPointerDown = (event: PointerEvent) => {
    if (event.target instanceof Node && root.contains(event.target)) return
    const target = event.target instanceof Element ? event.target : null
    // WYSIWYG's table panel is a sibling of its editable PRE. It consumes a live rectangle just
    // like the IR's in-root panel, so a click there is not an outside-editor dismissal.
    if (target?.closest('.vditor-wysiwyg > .vditor-panel')) return
    clear()
  }
  const onInput = () => {
    pointerAnchor = null
    clear()
  }
  const onBeforeInput = (event: InputEvent) => {
    if (!state) return
    clear()
    if (
      event.inputType !== 'historyUndo' &&
      event.inputType !== 'historyRedo'
    ) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }
  const onCut = (event: ClipboardEvent) => {
    if (!state) return
    clear()
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const onCompositionStart = () => {
    pointerAnchor = null
    clear()
  }
  // Lute replaces table nodes on a spin and external document updates replace whole blocks. The
  // fake range owns DOM identities, so retire it only once its table detached; panel insertion is
  // also a child mutation but must retain the range long enough for the panel action to consume it.
  const tableMutationObserver = new MutationObserver(() => {
    if (
      state &&
      (!state.anchor.table.isConnected || !root.contains(state.anchor.table))
    )
      clear()
  })
  const onCopy = (event: ClipboardEvent) => {
    const cells = state ? selectedCells(state) : null
    if (!cells || !event.clipboardData) return
    const size = dimensions(state!)
    const rows = Array.from({ length: size.rows }, (_, row) =>
      cells
        .slice(row * size.columns, (row + 1) * size.columns)
        .map(visibleCellText)
        .join('\t'),
    )
    const markdown = (options.markdownForRectangle ?? tableRectangleClipboard)(
      state!.anchor.table,
      state!.anchor.row,
      state!.focus.row,
      state!.anchor.column,
      state!.focus.column,
    )
    if (!markdown) return
    event.clipboardData.setData('text/plain', rows.join('\n'))
    event.clipboardData.setData('text/markdown', markdown)
    event.preventDefault()
    // Vditor also owns copy on this root. Its later handler serializes the native collapsed Range
    // and overwrites our TSV, so stop it only after both rectangle formats are populated.
    event.stopImmediatePropagation()
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keeps Escape precedence and all four Shift+Arrow bounds in one state transition.
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.target instanceof Node) || !root.contains(event.target)) return
    if (guardComposition(event)) return
    if (
      state &&
      (event.ctrlKey || event.metaKey) &&
      (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')
    ) {
      clear()
      return
    }
    if (event.key === 'Escape' && clear()) {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && state) {
      const { anchor, focus } = state
      if (
        runTableClear(
          anchor.table,
          anchor.row,
          focus.row,
          anchor.column,
          focus.column,
        )
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        clear()
      }
      return
    }
    if (!event.shiftKey || !/^Arrow(?:Up|Down|Left|Right)$/u.test(event.key))
      return
    const anchor = state
      ? cellAt(state.anchor)
      : cellFromNode(document.getSelection()?.anchorNode ?? null)
    const focus = state ? cellAt(state.focus) : anchor
    const focusPoint = focus ? pointFor(focus) : null
    if (!anchor || !focusPoint) return
    const delta =
      event.key === 'ArrowUp'
        ? [-1, 0]
        : event.key === 'ArrowDown'
          ? [1, 0]
          : event.key === 'ArrowLeft'
            ? [0, -1]
            : [0, 1]
    const next = cellAt({
      ...focusPoint,
      row: focusPoint.row + delta[0],
      column: focusPoint.column + delta[1],
    })
    if (!next || !select(anchor, next)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  root.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('pointermove', onPointerMove, true)
  document.addEventListener('pointerup', onPointerUp, true)
  document.addEventListener('pointercancel', onPointerCancel, true)
  root.addEventListener('input', onInput, true)
  root.addEventListener('beforeinput', onBeforeInput, true)
  root.addEventListener('cut', onCut, true)
  root.addEventListener('compositionstart', onCompositionStart, true)
  tableMutationObserver.observe(root, { childList: true, subtree: true })
  root.addEventListener('copy', onCopy, true)
  // Escape's block-widening ladder also listens on document capture. Register on the same target
  // before that installer so the first Escape retires a rectangle instead of widening its cell.
  document.addEventListener('keydown', onKeyDown, true)
  controllers.set(root, { state: () => state, clear })
  return {
    select,
    clear,
    dimensions: () => (state ? dimensions(state) : null),
    cells: () => (state ? selectedCells(state) : null),
    dispose: () => {
      root.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerdown', onDocumentPointerDown, true)
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', onPointerCancel, true)
      root.removeEventListener('input', onInput, true)
      root.removeEventListener('beforeinput', onBeforeInput, true)
      root.removeEventListener('cut', onCut, true)
      root.removeEventListener('compositionstart', onCompositionStart, true)
      tableMutationObserver.disconnect()
      root.removeEventListener('copy', onCopy, true)
      document.removeEventListener('keydown', onKeyDown, true)
      controllers.delete(root)
      state = null
      paint()
      status.remove()
    },
  }
}
