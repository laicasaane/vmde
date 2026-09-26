// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  inner: null as any,
  rectangle: null as any,
}))
vi.mock('../util/inner-vditor', () => ({ innerVditor: () => state.inner }))
vi.mock('./table-actions', () => ({ runTableMove: vi.fn(() => true) }))
vi.mock('./table-cell-selection', () => ({
  tablePanelRectangleBounds: vi.fn(() => state.rectangle),
  runTablePanelRectangleAction: vi.fn(() => 'none'),
}))

import { installTableWysiwygControls } from './table-wysiwyg-controls'
import { runTableMove } from './table-actions'
import { runTablePanelRectangleAction } from './table-cell-selection'

function buildTable(cols = 3, rows = 2): HTMLTableElement {
  const table = document.createElement('table')
  const header = table.insertRow()
  for (let c = 0; c < cols; c++) {
    const th = document.createElement('th')
    th.textContent = `H${c}`
    header.append(th)
  }
  for (let r = 0; r < rows; r++) {
    const row = table.insertRow()
    for (let c = 0; c < cols; c++) {
      const td = row.insertCell()
      td.textContent = `${r}${c}`
    }
  }
  document.body.append(table)
  return table
}

function setCaretIn(cell: HTMLElement): void {
  const range = document.createRange()
  range.setStart(cell.firstChild!, 0)
  range.collapse(true)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

describe('installTableWysiwygControls', () => {
  let popover: HTMLElement
  let dispose: (() => void) | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    state.rectangle = null
    popover = document.createElement('div')
    document.body.append(popover)
    state.inner = { currentMode: 'wysiwyg', wysiwyg: { popover } }
    dispose = installTableWysiwygControls()
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    window.getSelection()?.removeAllRanges()
  })

  test('injects the move group exactly once and skips IR/SV mode and non-cell selections', () => {
    const table = buildTable()
    setCaretIn(table.rows[1].cells[1])
    document.dispatchEvent(new Event('selectionchange'))
    document.dispatchEvent(new Event('selectionchange'))
    document.dispatchEvent(new Event('selectionchange'))
    const groups = popover.querySelectorAll('#vmde-table-moves')
    expect(groups).toHaveLength(1)
    expect(groups[0].querySelectorAll('button')).toHaveLength(4)

    popover.innerHTML = ''
    state.inner.currentMode = 'ir'
    document.dispatchEvent(new Event('selectionchange'))
    expect(popover.querySelectorAll('#vmde-table-moves')).toHaveLength(0)
    state.inner.currentMode = 'wysiwyg'

    const div = document.createElement('div')
    div.textContent = 'outside'
    document.body.append(div)
    const range = document.createRange()
    range.setStart(div.firstChild!, 0)
    range.collapse(true)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    expect(popover.querySelectorAll('#vmde-table-moves')).toHaveLength(0)
  })

  test('disables move buttons at table edges and refreshes on a later selection', () => {
    // deleteRow/deleteColumn are Vditor's OWN native panel buttons, siblings of our injected
    // group inside the popover -- updateDisabledControls queries the whole popover for them, not
    // just the group it just built, so they must exist as real popover children to be found.
    const nativeDeleteRow = document.createElement('button')
    nativeDeleteRow.dataset.type = 'deleteRow'
    const nativeDeleteColumn = document.createElement('button')
    nativeDeleteColumn.dataset.type = 'deleteColumn'
    popover.append(nativeDeleteRow, nativeDeleteColumn)

    const table = buildTable(3, 2) // header + 2 body rows, 3 columns
    const disabled = (type: string) =>
      popover.querySelector<HTMLButtonElement>(`[data-type="${type}"]`)!
        .disabled

    setCaretIn(table.rows[0].cells[0]) // header, first column
    document.dispatchEvent(new Event('selectionchange'))
    expect(disabled('moveColumnLeft')).toBe(true)
    expect(disabled('moveColumnRight')).toBe(false)
    expect(disabled('moveRowUp')).toBe(true)
    expect(disabled('moveRowDown')).toBe(true)
    expect(disabled('deleteRow')).toBe(true) // header row is never a deletable row

    setCaretIn(table.rows[1].cells[2]) // first body row, last column
    document.dispatchEvent(new Event('selectionchange'))
    expect(disabled('moveColumnLeft')).toBe(false)
    expect(disabled('moveColumnRight')).toBe(true)
    expect(disabled('moveRowUp')).toBe(true) // still disabled directly below the header
    expect(disabled('moveRowDown')).toBe(false)
    expect(disabled('deleteRow')).toBe(false)

    setCaretIn(table.rows[2].cells[1]) // last row
    document.dispatchEvent(new Event('selectionchange'))
    expect(disabled('moveRowUp')).toBe(false)
    expect(disabled('moveRowDown')).toBe(true)

    state.rectangle = { rowStart: 0, rowEnd: 1, columnStart: 0, columnEnd: 2 }
    document.dispatchEvent(new Event('selectionchange'))
    expect(disabled('deleteColumn')).toBe(true) // spans the whole width
    expect(disabled('deleteRow')).toBe(true) // includes the header row

    state.rectangle = { rowStart: 1, rowEnd: 2, columnStart: 1, columnEnd: 1 }
    document.dispatchEvent(new Event('selectionchange'))
    expect(disabled('deleteColumn')).toBe(false) // partial width, not the full table
    expect(disabled('deleteRow')).toBe(false) // starts below the header
  })

  test('a 1-column table disables deleteColumn regardless of any rectangle', () => {
    const nativeDeleteColumn = document.createElement('button')
    nativeDeleteColumn.dataset.type = 'deleteColumn'
    popover.append(nativeDeleteColumn)
    const table = buildTable(1, 1)
    setCaretIn(table.rows[0].cells[0])
    document.dispatchEvent(new Event('selectionchange'))
    expect(nativeDeleteColumn.disabled).toBe(true)
  })

  test('clicking a move button calls runTableMove and its mousedown is default-prevented', () => {
    const table = buildTable()
    setCaretIn(table.rows[1].cells[1])
    document.dispatchEvent(new Event('selectionchange'))
    const button = popover.querySelector<HTMLButtonElement>(
      '[data-type="moveColumnLeft"]',
    )!
    const mousedown = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    })
    button.dispatchEvent(mousedown)
    expect(mousedown.defaultPrevented).toBe(true) // keeps the popover's own focus, not the button's

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(runTableMove).toHaveBeenCalledWith('moveColumnLeft')
  })

  test('native range capture maps insert/delete buttons by data-type and ordinal', () => {
    const table = buildTable()
    setCaretIn(table.rows[1].cells[1])
    document.dispatchEvent(new Event('selectionchange'))

    // Two same-typed buttons distinguish the "above/left" (ordinal 0) from "below/right"
    // (ordinal 1) native Vditor actions, exactly like Vditor's own unlabelled pair.
    const insertRowA = document.createElement('button')
    insertRowA.dataset.type = 'insertRow'
    const insertRowB = document.createElement('button')
    insertRowB.dataset.type = 'insertRow'
    const insertColumnL = document.createElement('button')
    insertColumnL.dataset.type = 'insertColumn'
    const insertColumnR = document.createElement('button')
    insertColumnR.dataset.type = 'insertColumn'
    const deleteRow = document.createElement('button')
    deleteRow.dataset.type = 'deleteRow'
    const deleteColumn = document.createElement('button')
    deleteColumn.dataset.type = 'deleteColumn'
    popover.append(
      insertRowA,
      insertRowB,
      insertColumnL,
      insertColumnR,
      deleteRow,
      deleteColumn,
    )
    const spies = new Map<HTMLButtonElement, ReturnType<typeof vi.fn>>()
    for (const button of [
      insertRowA,
      insertRowB,
      insertColumnL,
      insertColumnR,
      deleteRow,
      deleteColumn,
    ]) {
      const spy = vi.fn()
      button.addEventListener('click', spy)
      spies.set(button, spy)
    }

    ;(runTablePanelRectangleAction as any).mockReturnValue('none')
    for (const [button, action] of [
      [insertRowA, 'insertRowA'],
      [insertRowB, 'insertRowB'],
      [insertColumnL, 'insertColumnL'],
      [insertColumnR, 'insertColumnR'],
      [deleteRow, 'deleteRow'],
      [deleteColumn, 'deleteColumn'],
    ] as const) {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      button.dispatchEvent(click)
      expect(runTablePanelRectangleAction).toHaveBeenCalledWith(table, action)
      expect(spies.get(button)).toHaveBeenCalledTimes(1) // 'none' lets Vditor's own handler run
      expect(click.defaultPrevented).toBe(false)
    }

    for (const result of ['applied', 'rejected'] as const) {
      ;(runTablePanelRectangleAction as any).mockReturnValue(result)
      const spy = spies.get(deleteRow)!
      spy.mockClear()
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      deleteRow.dispatchEvent(click)
      expect(spy, result).not.toHaveBeenCalled() // consumed: never falls back to Vditor's own action
      expect(click.defaultPrevented, result).toBe(true)
    }
  })

  test('native range binding attaches only once per popover', () => {
    const table = buildTable()
    setCaretIn(table.rows[1].cells[1])
    document.dispatchEvent(new Event('selectionchange'))
    expect(popover.dataset.vmdeRangeBinding).toBe('1')
    document.dispatchEvent(new Event('selectionchange'))
    expect(popover.dataset.vmdeRangeBinding).toBe('1')
  })

  test('Ctrl/Cmd+Shift keyboard chords move the table and respect runTableMove', () => {
    const table = buildTable()
    setCaretIn(table.rows[1].cells[1])
    document.dispatchEvent(new Event('selectionchange'))

    const fire = (key: string, overrides: Partial<KeyboardEventInit> = {}) => {
      const event = new KeyboardEvent('keydown', {
        key,
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        ...overrides,
      })
      document.dispatchEvent(event)
      return event
    }

    ;(runTableMove as any).mockReturnValue(true)
    expect(fire('[').defaultPrevented).toBe(true)
    expect(runTableMove).toHaveBeenLastCalledWith('moveColumnLeft')
    expect(fire('{').defaultPrevented).toBe(true)
    expect(runTableMove).toHaveBeenLastCalledWith('moveColumnLeft')
    expect(fire(']').defaultPrevented).toBe(true)
    expect(runTableMove).toHaveBeenLastCalledWith('moveColumnRight')
    expect(fire('}').defaultPrevented).toBe(true)
    expect(runTableMove).toHaveBeenLastCalledWith('moveColumnRight')
    expect(fire('PageUp').defaultPrevented).toBe(true)
    expect(runTableMove).toHaveBeenLastCalledWith('moveRowUp')
    expect(fire('PageDown').defaultPrevented).toBe(true)
    expect(runTableMove).toHaveBeenLastCalledWith('moveRowDown')

    ;(runTableMove as any).mockClear()
    expect(fire('[', { shiftKey: false }).defaultPrevented).toBe(false)
    expect(runTableMove).not.toHaveBeenCalled()
    expect(fire('[', { altKey: true }).defaultPrevented).toBe(false)
    expect(runTableMove).not.toHaveBeenCalled()

    ;(runTableMove as any).mockReturnValue(false)
    expect(fire('[').defaultPrevented).toBe(false) // ran, but nothing to prevent for

    ;(runTableMove as any).mockReturnValue(true).mockClear()
    const outside = document.createElement('div')
    outside.textContent = 'x'
    document.body.append(outside)
    const range = document.createRange()
    range.setStart(outside.firstChild!, 0)
    range.collapse(true)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fire('[')
    expect(runTableMove).not.toHaveBeenCalled()

    setCaretIn(table.rows[1].cells[1])
    state.inner.currentMode = 'ir'
    fire('[')
    expect(runTableMove).not.toHaveBeenCalled()
    state.inner.currentMode = 'wysiwyg'
  })

  test('dispose removes every listener and the injected group', () => {
    const table = buildTable()
    setCaretIn(table.rows[1].cells[1])
    document.dispatchEvent(new Event('selectionchange'))
    expect(popover.querySelectorAll('#vmde-table-moves')).toHaveLength(1)

    dispose!()
    dispose = undefined
    expect(document.getElementById('vmde-table-moves')).toBeNull()

    document.dispatchEvent(new Event('selectionchange'))
    expect(popover.querySelectorAll('#vmde-table-moves')).toHaveLength(0)
    ;(runTableMove as any).mockClear()
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '[',
        ctrlKey: true,
        shiftKey: true,
      }),
    )
    expect(runTableMove).not.toHaveBeenCalled()
  })

  test('a click schedules the popover rebuild through requestAnimationFrame', () => {
    // Vditor (re)builds its WYSIWYG popover from its OWN click handler; installTableWysiwygControls
    // defers to the next frame so it appends to that freshly-created panel instead of a stale one
    // still mid-teardown. Fake timers stand in for rAF the same way edit-sync.test.ts does.
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 0),
    )
    const table = buildTable()
    setCaretIn(table.rows[1].cells[1])
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(popover.querySelectorAll('#vmde-table-moves')).toHaveLength(0)
    vi.advanceTimersByTime(0)
    expect(popover.querySelectorAll('#vmde-table-moves')).toHaveLength(1)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
})
