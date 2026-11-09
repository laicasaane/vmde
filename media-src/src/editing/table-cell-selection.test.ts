// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  canMoveWithinCell,
  clearTableCellSelections,
  installTableCellSelection,
} from './table-cell-selection'

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

  // Task 580 CP2-3: Ctrl/Cmd+Z/Y are VS Code keybindings now; the history path clears instead.
  test('keeps the rectangle on Ctrl+Z/Y keys and clears it from the history path', () => {
    const root = editor()
    const selection = installTableCellSelection(root)
    const cells = root.querySelectorAll<HTMLTableCellElement>('th,td')
    selection.select(cells[0], cells[3])
    for (const key of ['z', 'y'])
      root.dispatchEvent(
        new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }),
      )
    expect(selection.dimensions()).toEqual({ rows: 2, columns: 2 })

    clearTableCellSelections()

    expect(selection.dimensions()).toBeNull()
    expect(root.querySelector('.vmde-cell-selected')).toBeNull()
    selection.dispose()
    expect(() => clearTableCellSelections()).not.toThrow()
  })

  test('extends from the active cell with Shift+Arrow without changing source', () => {
    const root = editor()
    const selection = installTableCellSelection(root)
    const cells = root.querySelectorAll<HTMLTableCellElement>('th,td')
    // Task 714 (D1): the rectangle starts only at the cell edge, so the caret sits at the end of `A`.
    const range = document.createRange()
    range.selectNodeContents(cells[0])
    range.collapse(false)
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

  // Task 580 CP2-6: Expand Selection's keys carry Shift+Arrow plus another modifier.
  test.each([
    { altKey: true },
    { ctrlKey: true },
    { ctrlKey: true, metaKey: true },
  ])('leaves Shift+ArrowRight with %o to VS Code', (modifiers) => {
    const root = editor()
    const selection = installTableCellSelection(root)
    const cells = root.querySelectorAll<HTMLTableCellElement>('th,td')
    const range = document.createRange()
    range.selectNodeContents(cells[0])
    range.collapse(true)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    })
    root.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(selection.dimensions()).toBeNull()
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

  test('retains the rectangle on its sibling IR panel, but clears on other outside targets', () => {
    const root = editor()
    const pane = document.createElement('div')
    pane.className = 'vditor-ir'
    root.replaceWith(pane)
    pane.append(root)
    const clip = document.createElement('div')
    clip.innerHTML =
      '<div id="fix-table-ir-wrapper" contenteditable="false"><div class="vditor-panel"><button type="button">Insert column</button></div></div>'
    pane.append(clip)
    const selection = installTableCellSelection(root)
    const cells = root.querySelectorAll<HTMLTableCellElement>('td')
    const pointerDown = (target: Element) =>
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    try {
      selection.select(cells[0], cells[1])
      pointerDown(clip.querySelector('button')!)
      expect(selection.dimensions()).toEqual({ rows: 1, columns: 2 })
      expect(selection.cells()).toEqual([...cells])

      pointerDown(pane)
      expect(selection.dimensions()).toBeNull()
      selection.select(cells[0], cells[1])
      const otherPane = document.createElement('div')
      otherPane.className = 'vditor-ir'
      document.body.append(otherPane)
      otherPane.append(clip)
      pointerDown(clip.querySelector('button')!)
      expect(selection.dimensions()).toBeNull()
    } finally {
      selection.dispose()
    }
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

// Task 714 (D1): plain Shift+Arrow is text selection while the focus can still move inside the cell;
// the rectangle starts only at the cell edge in that direction (or when one is already active).
// jsdom has no layout, so Range rects are stubbed: a text node wraps at WRAP characters, every line
// is LINE high, and the first line starts at top 0.
const WRAP = 11
const LINE = 16
const WRAPPED = 'first line second line'

describe('table cell Shift+Arrow text selection (Task 714)', () => {
  const originalGetClientRects = (
    Range.prototype as { getClientRects?: () => DOMRectList }
  ).getClientRects

  beforeEach(() => {
    ;(Range.prototype as { getClientRects: () => unknown }).getClientRects =
      function (this: Range) {
        const node = this.startContainer
        if (!(node instanceof Text)) return []
        const top = this.startOffset >= WRAP ? LINE + 4 : 0
        return [
          {
            top,
            bottom: top + LINE,
            height: LINE,
            left: 0,
            right: 1,
            width: 1,
          },
        ]
      }
  })

  afterEach(() => {
    if (originalGetClientRects)
      Range.prototype.getClientRects = originalGetClientRects
    else delete (Range.prototype as { getClientRects?: unknown }).getClientRects
  })

  function grid(centerHtml = WRAPPED) {
    document.body.innerHTML = `
      <div id="editor" contenteditable="true">
        <table><tbody>
          <tr><th>h0</th><th>h1</th><th>h2</th></tr>
          <tr><td>a0</td><td id="center">${centerHtml}</td><td>a2</td></tr>
          <tr><td>b0</td><td>b1</td><td>b2</td></tr>
        </tbody></table>
      </div>`
    const root = document.getElementById('editor') as HTMLElement
    const center = document.getElementById('center') as HTMLTableCellElement
    return { root, center, cells: root.querySelectorAll('th,td') }
  }

  function placeCaret(node: Node, offset: number, anchor?: [Node, number]) {
    const selection = document.getSelection()!
    selection.removeAllRanges()
    const range = document.createRange()
    range.setStart(...(anchor ?? [node, offset]))
    range.collapse(true)
    selection.addRange(range)
    if (anchor) selection.extend(node, offset)
  }

  function press(root: HTMLElement, key: string) {
    const event = new KeyboardEvent('keydown', {
      key,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    root.dispatchEvent(event)
    return event
  }

  describe('canMoveWithinCell', () => {
    test('judges Left and Right by the visible text before and after the focus', () => {
      const { center } = grid('hello')
      const text = center.firstChild as Text
      expect(canMoveWithinCell(center, text, 0, 'ArrowLeft')).toBe(false)
      expect(canMoveWithinCell(center, text, 3, 'ArrowLeft')).toBe(true)
      expect(canMoveWithinCell(center, text, 5, 'ArrowRight')).toBe(false)
      expect(canMoveWithinCell(center, text, 3, 'ArrowRight')).toBe(true)
    })

    test('ignores zero-width spaces and editor markers when measuring the edge', () => {
      const { center } = grid(
        '<span class="vditor-ir__marker">**</span>\u200bhello\u200b<span class="vditor-ir__marker">**</span>',
      )
      const text = center.childNodes[1] as Text
      expect(canMoveWithinCell(center, text, 1, 'ArrowLeft')).toBe(false)
      expect(canMoveWithinCell(center, text, 2, 'ArrowLeft')).toBe(true)
      expect(canMoveWithinCell(center, text, 6, 'ArrowRight')).toBe(false)
      expect(canMoveWithinCell(center, text, 5, 'ArrowRight')).toBe(true)
    })

    test('judges Up and Down by the focus line against the first and last line of the cell', () => {
      const { center } = grid()
      const text = center.firstChild as Text
      expect(canMoveWithinCell(center, text, 3, 'ArrowUp')).toBe(false)
      expect(canMoveWithinCell(center, text, 15, 'ArrowUp')).toBe(true)
      expect(canMoveWithinCell(center, text, 3, 'ArrowDown')).toBe(true)
      expect(canMoveWithinCell(center, text, 15, 'ArrowDown')).toBe(false)
    })

    test('treats a cell without measurable text as an edge in every direction', () => {
      const { center } = grid('')
      for (const key of [
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
      ] as const)
        expect(canMoveWithinCell(center, center, 0, key), key).toBe(false)
    })
  })

  test.each([
    ['ArrowLeft', 3],
    ['ArrowRight', 3],
    ['ArrowDown', 3],
    ['ArrowUp', 15],
  ])('leaves mid-cell Shift+%s to the native text selection', (key, offset) => {
    const { root, center } = grid()
    const selection = installTableCellSelection(root)
    placeCaret(center.firstChild!, offset)
    const event = press(root, key)
    expect(event.defaultPrevented).toBe(false)
    expect(selection.dimensions()).toBeNull()
    selection.dispose()
  })

  test.each([
    ['ArrowLeft', 0, { rows: 1, columns: 2 }],
    ['ArrowRight', WRAPPED.length, { rows: 1, columns: 2 }],
    ['ArrowUp', 3, { rows: 2, columns: 1 }],
    ['ArrowDown', 15, { rows: 2, columns: 1 }],
  ])('starts the rectangle from the %s cell edge', (key, offset, size) => {
    const { root, center } = grid()
    const selection = installTableCellSelection(root)
    placeCaret(center.firstChild!, offset)
    const event = press(root, key)
    expect(event.defaultPrevented).toBe(true)
    expect(selection.dimensions()).toEqual(size)
    expect(selection.cells()).toContain(center)
    expect(selection.cells()).toHaveLength(size.rows * size.columns)
    selection.dispose()
  })

  test.each([
    ['ArrowLeft', 0, true],
    ['ArrowUp', 0, true],
    ['ArrowRight', 8, false],
    ['ArrowDown', 8, false],
  ])(
    'does not consume Shift+%s at an edge without a neighbour',
    (key, index, atStart) => {
      const { root, cells } = grid()
      const selection = installTableCellSelection(root)
      // Corner cells: the top-left has no left/up neighbour, the bottom-right no right/down neighbour.
      const text = cells[index].firstChild as Text
      placeCaret(text, atStart ? 0 : text.length)
      const event = press(root, key)
      expect(event.defaultPrevented).toBe(false)
      expect(selection.dimensions()).toBeNull()
      selection.dispose()
    },
  )

  test('keeps extending an active rectangle even when the focus cell has text to move over', () => {
    const { root, center } = grid()
    const selection = installTableCellSelection(root)
    selection.select(center, center)
    placeCaret(center.firstChild!, 3)
    expect(press(root, 'ArrowRight').defaultPrevented).toBe(true)
    expect(selection.dimensions()).toEqual({ rows: 1, columns: 2 })
    expect(press(root, 'ArrowDown').defaultPrevented).toBe(true)
    expect(selection.dimensions()).toEqual({ rows: 2, columns: 2 })
    selection.dispose()
  })

  test('does not consume a text selection that spans two cells', () => {
    const { root, center, cells } = grid()
    const selection = installTableCellSelection(root)
    // Anchor in the left cell, focus at the start of the centre cell (edge of the centre cell).
    placeCaret(center.firstChild!, 0, [cells[3].firstChild!, 1])
    const event = press(root, 'ArrowLeft')
    expect(event.defaultPrevented).toBe(false)
    expect(selection.dimensions()).toBeNull()
    selection.dispose()
  })

  test('judges the cell at the selection focus, not the anchor', () => {
    const { root, center } = grid()
    const selection = installTableCellSelection(root)
    // A text selection grown inside the centre cell: anchor at its start, focus mid-text.
    placeCaret(center.firstChild!, 5, [center.firstChild!, 0])
    const event = press(root, 'ArrowLeft')
    expect(event.defaultPrevented).toBe(false)
    expect(selection.dimensions()).toBeNull()
    selection.dispose()
  })
})
