import { innerVditor } from '../util/inner-vditor'
import { runTableMove } from './table-actions'
import { runTablePanelRectangleAction } from './table-cell-selection'
import type { TableMove } from './table-operations'

type WysiwygTableAction =
  | TableMove
  | 'insertRowA'
  | 'insertRowB'
  | 'insertColumnL'
  | 'insertColumnR'
  | 'deleteRow'
  | 'deleteColumn'

function selectedTable(): HTMLTableElement | null {
  const node = document.getSelection()?.anchorNode
  const element = node instanceof Element ? node : node?.parentElement
  const table = element?.closest('table')
  return table instanceof HTMLTableElement ? table : null
}

function isMove(action: WysiwygTableAction): action is TableMove {
  return action.startsWith('move')
}

const actions: Array<{
  type: WysiwygTableAction
  label: string
  glyph: string
}> = [
  { type: 'moveColumnLeft', label: 'Move column left', glyph: '←' },
  { type: 'moveColumnRight', label: 'Move column right', glyph: '→' },
  { type: 'moveRowUp', label: 'Move row up', glyph: '↑' },
  { type: 'moveRowDown', label: 'Move row down', glyph: '↓' },
  { type: 'insertRowA', label: 'Insert rows above selection', glyph: '⇡' },
  { type: 'insertRowB', label: 'Insert rows below selection', glyph: '⇣' },
  {
    type: 'insertColumnL',
    label: 'Insert columns left of selection',
    glyph: '⇐',
  },
  {
    type: 'insertColumnR',
    label: 'Insert columns right of selection',
    glyph: '⇒',
  },
  { type: 'deleteRow', label: 'Delete selected rows', glyph: '−' },
  { type: 'deleteColumn', label: 'Delete selected columns', glyph: '×' },
]

/** Adds VMDE move actions to Vditor's WYSIWYG table popover without replacing native controls. */
export function installTableWysiwygControls(): () => void {
  const update = () => {
    const inner = innerVditor()
    const popover = inner?.wysiwyg?.popover
    if (inner?.currentMode !== 'wysiwyg' || !popover) return
    if (popover.querySelector('#vmde-table-moves')) return
    const node = document.getSelection()?.anchorNode
    const element = node instanceof Element ? node : node?.parentElement
    if (!element?.closest('td,th')) return
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
        if (isMove(action.type)) runTableMove(action.type)
        else runTablePanelRectangleAction(table, action.type)
      })
      group.append(button)
    }
    popover.append(group)
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
      event.key === '['
        ? 'moveColumnLeft'
        : event.key === ']'
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
