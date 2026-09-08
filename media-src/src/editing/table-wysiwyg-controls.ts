import { innerVditor } from '../util/inner-vditor'
import { runTableMove } from './table-actions'
import {
  tablePanelRectangleBounds,
  runTablePanelRectangleAction,
  type TablePanelAction,
} from './table-cell-selection'
import type { TableMove } from './table-operations'

function selectedTable(): HTMLTableElement | null {
  const node = document.getSelection()?.anchorNode
  const element = node instanceof Element ? node : node?.parentElement
  const table = element?.closest('table')
  return table instanceof HTMLTableElement ? table : null
}

const actions: Array<{
  type: TableMove
  label: string
  glyph: string
}> = [
  { type: 'moveColumnLeft', label: 'Move column left', glyph: '←' },
  { type: 'moveColumnRight', label: 'Move column right', glyph: '→' },
  { type: 'moveRowUp', label: 'Move row up', glyph: '↑' },
  { type: 'moveRowDown', label: 'Move row down', glyph: '↓' },
]

function nativeRangeAction(
  popover: HTMLElement,
  button: HTMLElement,
): TablePanelAction | null {
  if (button.dataset.type === 'deleteRow') return 'deleteRow'
  if (button.dataset.type === 'deleteColumn') return 'deleteColumn'
  const buttons = Array.from(popover.querySelectorAll<HTMLElement>('button'))
  const ordinal = buttons
    .filter((candidate) => candidate.dataset.type === button.dataset.type)
    .indexOf(button)
  if (button.dataset.type === 'insertRow')
    return ordinal === 0 ? 'insertRowA' : ordinal === 1 ? 'insertRowB' : null
  if (button.dataset.type === 'insertColumn')
    return ordinal === 0
      ? 'insertColumnL'
      : ordinal === 1
        ? 'insertColumnR'
        : null
  return null
}

function bindNativeRangeButtons(popover: HTMLElement): void {
  if (popover.dataset.vmdeRangeBinding === '1') return
  popover.dataset.vmdeRangeBinding = '1'
  // Capture precedes Vditor's per-button onclick. Only a live rectangle is intercepted; the
  // ordinary one-cell controls keep Vditor's original behavior and labels unchanged.
  popover.addEventListener(
    'click',
    (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>(
        'button',
      )
      if (!button || button.closest('#vmde-table-moves')) return
      const action = nativeRangeAction(popover, button)
      const table = selectedTable()
      if (!action || !table) return
      const result = runTablePanelRectangleAction(table, action)
      if (result === 'none') return
      // `rejected` is still consumed: Vditor must not reinterpret a refused rectangle as a
      // single-cell operation that could delete the only remaining GFM column.
      event.preventDefault()
      event.stopImmediatePropagation()
    },
    true,
  )
}

function updateDisabledControls(
  popover: HTMLElement,
  table: HTMLTableElement,
): void {
  const node = document.getSelection()?.anchorNode
  const cell = (node instanceof Element ? node : node?.parentElement)?.closest(
    'td,th',
  )
  const row = cell?.closest('tr')
  const rowIndex = row ? Array.from(table.rows).indexOf(row) : -1
  const column = row
    ? Array.from(row.cells).indexOf(cell as HTMLTableCellElement)
    : -1
  const width = table.rows[0]?.cells.length ?? 0
  const rectangle = tablePanelRectangleBounds(table)
  const disabled = (selector: string, value: boolean) =>
    popover.querySelectorAll<HTMLButtonElement>(selector).forEach((button) => {
      button.disabled = value
    })
  disabled('[data-type="moveColumnLeft"]', column <= 0)
  disabled('[data-type="moveColumnRight"]', column < 0 || column >= width - 1)
  disabled('[data-type="moveRowUp"]', rowIndex <= 1)
  disabled(
    '[data-type="moveRowDown"]',
    rowIndex <= 0 || rowIndex >= table.rows.length - 1,
  )
  disabled(
    '[data-type="deleteColumn"]',
    width <= 1 ||
      (rectangle?.columnEnd === width - 1 && rectangle.columnStart === 0),
  )
  disabled(
    '[data-type="deleteRow"]',
    rowIndex === 0 || rectangle?.rowStart === 0,
  )
}

/** Adds VMDE move actions to Vditor's WYSIWYG table popover without replacing native controls. */
export function installTableWysiwygControls(): () => void {
  const update = () => {
    const inner = innerVditor()
    const popover = inner?.wysiwyg?.popover
    if (inner?.currentMode !== 'wysiwyg' || !popover) return
    const node = document.getSelection()?.anchorNode
    const element = node instanceof Element ? node : node?.parentElement
    if (!element?.closest('td,th')) return
    const table = selectedTable()
    if (!table) return
    // Selection changes reuse Vditor's existing popover. Refresh disabled state before returning
    // for an already-injected move group, otherwise a newly armed range keeps stale buttons.
    if (popover.querySelector('#vmde-table-moves')) {
      updateDisabledControls(popover, table)
      return
    }
    const group = document.createElement('span')
    group.id = 'vmde-table-moves'
    for (const action of actions) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'vditor-icon vditor-tooltipped vditor-tooltipped__n'
      button.dataset.type = action.type
      button.setAttribute('aria-label', action.label)
      button.textContent = action.glyph
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', () => {
        const table = selectedTable()
        if (!table) return
        runTableMove(action.type)
      })
      group.append(button)
    }
    popover.append(group)
    bindNativeRangeButtons(popover)
    updateDisabledControls(popover, table)
  }
  const afterClick = () => requestAnimationFrame(update)
  document.addEventListener('selectionchange', update)
  // Vditor constructs the WYSIWYG popover in its click handler. Run on the next frame rather than
  // capture phase so our controls append to that freshly-created panel instead of a stale one.
  document.addEventListener('click', afterClick)
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one guarded chord map keeps all moves in the table-local handler.
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey)
      return
    const inner = innerVditor()
    if (inner?.currentMode !== 'wysiwyg') return
    const node = document.getSelection()?.anchorNode
    const element = node instanceof Element ? node : node?.parentElement
    if (!element?.closest('td,th')) return
    const move =
      event.key === '[' || event.key === '{'
        ? 'moveColumnLeft'
        : event.key === ']' || event.key === '}'
          ? 'moveColumnRight'
          : event.key === 'PageUp'
            ? 'moveRowUp'
            : event.key === 'PageDown'
              ? 'moveRowDown'
              : null
    if (!move || !runTableMove(move)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  document.addEventListener('keydown', onKeyDown, true)
  return () => {
    document.removeEventListener('selectionchange', update)
    document.removeEventListener('click', afterClick)
    document.removeEventListener('keydown', onKeyDown, true)
    document.getElementById('vmde-table-moves')?.remove()
  }
}
