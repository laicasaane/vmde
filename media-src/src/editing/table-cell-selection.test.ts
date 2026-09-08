// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest'
import { installTableCellSelection } from './table-cell-selection'

function editor() {
  document.body.innerHTML = `
    <div id="editor" contenteditable="true">
      <table><tbody>
        <tr><th>A</th><th>B</th></tr>
        <tr><td>1</td><td>2</td></tr>
      </tbody></table>
    </div>`
  return document.getElementById('editor') as HTMLElement
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('table cell rectangle selection', () => {
  test('paints an inclusive backward rectangle with classes only', () => {
    const root = editor()
    const selection = installTableCellSelection(root)
    const cells = root.querySelectorAll<HTMLTableCellElement>('th,td')
    selection.select(cells[3], cells[0])

    expect([...root.querySelectorAll('.vmde-cell-selected')]).toEqual([
      cells[0],
      cells[1],
      cells[2],
      cells[3],
    ])
    expect(root.innerHTML).not.toContain('data-render')
    expect(selection.dimensions()).toEqual({ rows: 2, columns: 2 })
    selection.dispose()
  })

  test('clears on Escape before the editor can widen its normal selection scope', () => {
    const root = editor()
    const selection = installTableCellSelection(root)
    const cells = root.querySelectorAll<HTMLTableCellElement>('th,td')
    selection.select(cells[0], cells[3])
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    root.dispatchEvent(event)

    expect(selection.dimensions()).toBeNull()
    expect(root.querySelector('.vmde-cell-selected')).toBeNull()
    selection.dispose()
  })

  test('extends from the active cell with Shift+Arrow without changing source', () => {
    const root = editor()
    const selection = installTableCellSelection(root)
    const cells = root.querySelectorAll<HTMLTableCellElement>('th,td')
    const range = document.createRange()
    range.selectNodeContents(cells[0])
    range.collapse(true)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    const before = root.textContent

    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        shiftKey: true,
        bubbles: true,
      }),
    )

    expect(selection.dimensions()).toEqual({ rows: 1, columns: 2 })
    expect(root.textContent).toBe(before)
    expect([...root.querySelectorAll('.vmde-cell-selected')]).toEqual([
      cells[0],
      cells[1],
    ])
    selection.dispose()
  })

  test('copies visible TSV alongside a source-backed Markdown table fragment', () => {
    const root = editor()
    const selection = installTableCellSelection(root, {
      markdownForRectangle: () => '| *one* | `two` |\n|---|---|',
    })
    const cells = root.querySelectorAll<HTMLTableCellElement>('th,td')
    selection.select(cells[2], cells[3])
    const values = new Map<string, string>()
    const event = new Event('copy', { bubbles: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', {
      value: {
        setData: (type: string, value: string) => values.set(type, value),
      },
    })
    root.dispatchEvent(event)

    expect(values.get('text/plain')).toBe('1\t2')
    expect(values.get('text/markdown')).toBe('| *one* | `two` |\n|---|---|')
    selection.dispose()
  })

  test('retires a rectangle on an ordinary different-cell pointerdown or cancellation', () => {
    const root = editor()
    const selection = installTableCellSelection(root)
    const cells = root.querySelectorAll<HTMLTableCellElement>('th,td')
    selection.select(cells[0], cells[3])
    cells[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(selection.dimensions()).toBeNull()

    selection.select(cells[0], cells[3])
    document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }))
    expect(selection.dimensions()).toBeNull()
    selection.dispose()
  })

  test('blocks native beforeinput and cut while a rectangle is armed', () => {
    const root = editor()
    const selection = installTableCellSelection(root)
    const cells = root.querySelectorAll<HTMLTableCellElement>('th,td')
    selection.select(cells[0], cells[3])
    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: 'x',
    })
    root.dispatchEvent(beforeInput)
    expect(beforeInput.defaultPrevented).toBe(true)
    expect(selection.dimensions()).toBeNull()

    selection.select(cells[0], cells[3])
    const cut = new Event('cut', { bubbles: true, cancelable: true })
    root.dispatchEvent(cut)
    expect(cut.defaultPrevented).toBe(true)
    expect(selection.dimensions()).toBeNull()
    selection.dispose()
  })

  test('drops a rectangle when a renderer replacement changes the table tree', async () => {
    const root = editor()
    const selection = installTableCellSelection(root)
    const cells = root.querySelectorAll<HTMLTableCellElement>('th,td')
    selection.select(cells[0], cells[3])
    root.querySelector('table')!.replaceWith(document.createElement('table'))
    await Promise.resolve()
    expect(selection.dimensions()).toBeNull()
    selection.dispose()
  })
})
