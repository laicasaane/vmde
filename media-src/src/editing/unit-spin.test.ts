// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveUnit } from '../util/unit-changes'
import {
  installUnitSpin,
  spinUnit,
  type UnitSpinDeps,
  type UnitSpinResult,
} from './unit-spin'

// Task 733 / 002-T: the five rules of `spinUnit` over a fake `UnitSpinDeps`.
const SPUN: UnitSpinResult = { kind: 'spun', html: 'NEW<wbr>' }

interface Fixture {
  root: HTMLElement
  table: HTMLElement
  cell: HTMLElement
  list: HTMLElement
  item: HTMLElement
  deps: UnitSpinDeps & {
    unit: LiveUnit | undefined
    cellCalls: string[]
    itemCalls: Array<[string, string]>
    counted: string[]
    settle: boolean
    listItemSpin: boolean
    cellResult: UnitSpinResult
    itemResult: UnitSpinResult
  }
}

function fixture(): Fixture {
  const root = document.createElement('div')
  root.innerHTML =
    '<table data-block="0"><thead><tr><th align="left">old<wbr></th></tr></thead></table>' +
    '<ul data-tight="true" data-type="ul" data-block="1"><li data-marker="-">item<wbr></li><li data-marker="-">two</li></ul>'
  document.body.appendChild(root)
  const table = root.querySelector('table') as HTMLElement
  const cell = root.querySelector('th') as HTMLElement
  const list = root.querySelector('ul') as HTMLElement
  const item = root.querySelector('li') as HTMLElement
  const deps = {
    unit: undefined as LiveUnit | undefined,
    cellCalls: [] as string[],
    itemCalls: [] as Array<[string, string]>,
    counted: [] as string[],
    settle: false,
    listItemSpin: true,
    cellResult: SPUN,
    itemResult: {
      kind: 'spun',
      html: '<li data-marker="-">NEW<wbr></li>',
    } as UnitSpinResult,
    liveUnitOf() {
      return this.unit
    },
    spinCell(html: string) {
      this.cellCalls.push(html)
      return this.cellResult
    },
    spinListItem(open: string, outer: string) {
      this.itemCalls.push([open, outer])
      return this.itemResult
    },
    isSettleRespin() {
      return this.settle
    },
    count(result: string) {
      this.counted.push(result)
    },
  }
  return { root, table, cell, list, item, deps: deps as Fixture['deps'] }
}

const cellUnit = (f: Fixture): LiveUnit => ({
  el: f.cell,
  members: [f.cell],
  kind: 'cell',
  top: f.table,
})
const itemUnit = (f: Fixture): LiveUnit => ({
  el: f.item,
  members: [f.item],
  kind: 'list-item',
  top: f.list,
})
const rangeIn = (node: Node): Range => {
  const range = document.createRange()
  range.setStart(node, 0)
  range.collapse(true)
  return range
}
const input = (inputType: string, data: string | null): InputEvent =>
  new InputEvent('input', { inputType, data })

afterEach(() => {
  document.body.replaceChildren()
})

describe('spinUnit rules', () => {
  it('rule 1: the IR root as block refuses not-a-unit before any lookup', () => {
    const f = fixture()
    f.deps.unit = cellUnit(f)
    const lookup = vi.spyOn(f.deps, 'liveUnitOf')
    expect(spinUnit(f.deps, rangeIn(f.cell), f.root, undefined)).toBe(false)
    expect(lookup).not.toHaveBeenCalled()
    expect(f.deps.counted).toEqual(['not-a-unit'])
  })

  it('rule 2: no live unit refuses model-off', () => {
    const f = fixture()
    expect(spinUnit(f.deps, rangeIn(f.cell), f.table, undefined)).toBe(false)
    expect(f.deps.counted).toEqual(['model-off'])
    expect(f.deps.cellCalls).toEqual([])
  })

  it('rule 3: a cell spun writes the cell innerHTML and keeps the element and align', () => {
    const f = fixture()
    f.deps.unit = cellUnit(f)
    const event = input('insertText', 'x')
    expect(spinUnit(f.deps, rangeIn(f.cell.firstChild!), f.table, event)).toBe(
      true,
    )
    expect(f.deps.cellCalls).toEqual(['old<wbr>'])
    expect(f.root.querySelector('th')).toBe(f.cell)
    expect(f.cell.innerHTML).toBe('NEW<wbr>')
    expect(f.cell.getAttribute('align')).toBe('left')
    expect(f.deps.counted).toEqual(['spun'])
  })

  it('rule 3: a cell qualifies for a paste (no event) and for any input type', () => {
    const f = fixture()
    f.deps.unit = cellUnit(f)
    expect(spinUnit(f.deps, rangeIn(f.cell), f.table, undefined)).toBe(true)
    f.cell.innerHTML = 'old<wbr>'
    expect(
      spinUnit(
        f.deps,
        rangeIn(f.cell),
        f.table,
        input('deleteContentBackward', null),
      ),
    ).toBe(true)
  })

  it('rule 3: a refused cell spin returns false and leaves the cell', () => {
    const f = fixture()
    f.deps.unit = cellUnit(f)
    f.deps.cellResult = { kind: 'refused', reason: 'shape' }
    expect(
      spinUnit(f.deps, rangeIn(f.cell), f.table, input('insertText', '|')),
    ).toBe(false)
    expect(f.cell.innerHTML).toBe('old<wbr>')
    expect(f.deps.counted).toEqual(['shape'])
  })

  it('rule 3: a cell whose top is not the block element is not a unit', () => {
    const f = fixture()
    f.deps.unit = cellUnit(f)
    expect(spinUnit(f.deps, rangeIn(f.cell), f.list, undefined)).toBe(false)
    expect(f.deps.counted).toEqual(['not-a-unit'])
  })

  it('rule 4 (Q-47): an item spun keeps the li element and writes its inner HTML, class and marker', () => {
    const f = fixture()
    f.deps.unit = itemUnit(f)
    expect(
      spinUnit(
        f.deps,
        rangeIn(f.item.firstChild!),
        f.list,
        input('insertText', 'a'),
      ),
    ).toBe(true)
    expect(f.deps.itemCalls).toHaveLength(1)
    expect(f.deps.itemCalls[0][0]).toMatch(/^<ul\b/u)
    expect(f.deps.itemCalls[0][0]).not.toContain('</ul>')
    expect(f.list.querySelectorAll('li')).toHaveLength(2)
    expect(f.list.firstElementChild).toBe(f.item)
    expect(f.item.innerHTML).toBe('NEW<wbr>')
    expect(f.item.getAttribute('data-marker')).toBe('-')
  })

  it('rule 4 (Q-47): the opening tag passed to the item spin is the list shell, read without the items', () => {
    const f = fixture()
    f.deps.unit = itemUnit(f)
    const listHtml = vi.spyOn(f.list, 'outerHTML', 'get')
    spinUnit(
      f.deps,
      rangeIn(f.item.firstChild!),
      f.list,
      input('insertText', 'a'),
    )
    expect(listHtml).not.toHaveBeenCalled()
    expect(f.deps.itemCalls[0][0]).toBe(
      '<ul data-tight="true" data-type="ul" data-block="1">',
    )
  })

  it('rule 4 (Q-47): two item spins in a row, with no sync between them, both find the same li', () => {
    const f = fixture()
    f.deps.unit = itemUnit(f)
    const first = f.list.firstElementChild
    for (const data of ['a', 'b']) {
      f.item.insertAdjacentHTML('beforeend', '<wbr>')
      expect(
        spinUnit(
          f.deps,
          rangeIn(f.item.firstChild!),
          f.list,
          input('insertText', data),
        ),
      ).toBe(true)
      // The unit's element is still attached and still the first child: the lookup keeps working.
      expect(f.item.isConnected).toBe(true)
      expect(f.list.firstElementChild).toBe(first)
    }
    expect(f.deps.itemCalls).toHaveLength(2)
  })

  it('rule 3/4: a unit whose top is not the block element is not a unit (caret in a nested list item)', () => {
    const f = fixture()
    const nested = document.createElement('ul')
    nested.setAttribute('data-block', '0')
    nested.innerHTML = '<li>n<wbr></li>'
    f.item.appendChild(nested)
    const nestedItem = nested.firstElementChild as HTMLElement
    // The model returns the top-level item; Vditor's block for the caret is the nested list.
    f.deps.unit = itemUnit(f)
    expect(
      spinUnit(
        f.deps,
        rangeIn(nestedItem.firstChild!),
        nested,
        input('insertText', 'a'),
      ),
    ).toBe(false)
    expect(f.deps.counted).toEqual(['not-a-unit'])
  })

  it('rule 2: a lookup without a unit counts not-a-unit while the model is live, model-off otherwise', () => {
    const f = fixture()
    f.deps.isModelLive = () => true
    spinUnit(f.deps, rangeIn(f.cell), f.table, undefined)
    f.deps.isModelLive = () => false
    spinUnit(f.deps, rangeIn(f.cell), f.table, undefined)
    expect(f.deps.counted).toEqual(['not-a-unit', 'model-off'])
  })

  it('rule 4: listItemSpin false refuses items with disabled', () => {
    const f = fixture()
    f.deps.unit = itemUnit(f)
    f.deps.listItemSpin = false
    expect(
      spinUnit(
        f.deps,
        rangeIn(f.item.firstChild!),
        f.list,
        input('insertText', 'a'),
      ),
    ).toBe(false)
    expect(f.deps.counted).toEqual(['disabled'])
    expect(f.deps.itemCalls).toEqual([])
  })

  it('rule 4 (Q-46): an item of an ordered list refuses disabled and keeps the block spin', () => {
    const f = fixture()
    const ordered = document.createElement('ol')
    ordered.setAttribute('data-block', '2')
    ordered.innerHTML = '<li data-marker="2.">item<wbr></li>'
    f.root.appendChild(ordered)
    const li = ordered.firstElementChild as HTMLElement
    f.deps.unit = { el: li, members: [li], kind: 'list-item', top: ordered }
    expect(
      spinUnit(
        f.deps,
        rangeIn(li.firstChild!),
        ordered,
        input('insertText', 'a'),
      ),
    ).toBe(false)
    expect(f.deps.counted).toEqual(['disabled'])
    expect(f.deps.itemCalls).toEqual([])
  })

  it('rule 4: an item with a nested list refuses nested', () => {
    const f = fixture()
    f.item.insertAdjacentHTML('beforeend', '<ul><li>n</li></ul>')
    f.deps.unit = itemUnit(f)
    expect(
      spinUnit(
        f.deps,
        rangeIn(f.item.firstChild!),
        f.list,
        input('insertText', 'a'),
      ),
    ).toBe(false)
    expect(f.deps.counted).toEqual(['nested'])
  })

  it('rule 4: other events refuse event; the settle re-spin qualifies', () => {
    const f = fixture()
    f.deps.unit = itemUnit(f)
    const range = rangeIn(f.item.firstChild!)
    expect(spinUnit(f.deps, range, f.list, input('insertText', 'ab'))).toBe(
      false,
    )
    expect(
      spinUnit(f.deps, range, f.list, input('insertFromPaste', null)),
    ).toBe(false)
    expect(spinUnit(f.deps, range, f.list, undefined)).toBe(false)
    expect(f.deps.counted).toEqual(['event', 'event', 'event'])
    f.deps.settle = true
    f.deps.counted.length = 0
    expect(spinUnit(f.deps, range, f.list, input('insertText', null))).toBe(
      true,
    )
    expect(f.deps.counted).toEqual(['spun'])
  })

  it('rule 4: the range widened over the caret marker (never collapsed in input()) still qualifies mid-item', () => {
    const f = fixture()
    f.deps.unit = itemUnit(f)
    const text = f.item.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 2)
    range.setEnd(f.item, f.item.childNodes.length)
    expect(range.collapsed).toBe(false)
    expect(
      spinUnit(f.deps, range, f.list, input('deleteContentBackward', null)),
    ).toBe(true)
  })

  it('N1: an item of a list with an adjacent list keeps the block spin (shape)', () => {
    const f = fixture()
    f.list.insertAdjacentHTML('afterend', '<ul data-block="2"><li>c</li></ul>')
    f.deps.unit = itemUnit(f)
    expect(
      spinUnit(
        f.deps,
        rangeIn(f.item.firstChild!),
        f.list,
        input('insertText', 'a'),
      ),
    ).toBe(false)
    expect(f.deps.counted).toEqual(['shape'])
    expect(f.deps.itemCalls).toEqual([])
  })

  it('rule 5: any other unit kind refuses not-a-unit', () => {
    const f = fixture()
    f.deps.unit = {
      el: f.table,
      members: [f.table],
      kind: 'paragraph',
      top: f.table,
    }
    expect(spinUnit(f.deps, rangeIn(f.cell), f.table, undefined)).toBe(false)
    expect(f.deps.counted).toEqual(['not-a-unit'])
  })

  it('a refused call allocates nothing observable: no dependency work and the same constant reason', () => {
    const f = fixture()
    f.deps.unit = undefined
    const reasons: unknown[] = []
    f.deps.count = (result: string) => reasons.push(result)
    const cell = vi.spyOn(f.deps, 'spinCell')
    const item = vi.spyOn(f.deps, 'spinListItem')
    const first = spinUnit(f.deps, rangeIn(f.cell), f.table, undefined)
    const second = spinUnit(f.deps, rangeIn(f.cell), f.table, undefined)
    expect([first, second]).toEqual([false, false])
    expect(reasons).toEqual(['model-off', 'model-off'])
    expect(cell).not.toHaveBeenCalled()
    expect(item).not.toHaveBeenCalled()
    expect(f.cell.innerHTML).toBe('old<wbr>')
  })
})

describe('installUnitSpin', () => {
  it('installs window.__vmdeSpinUnit and the uninstall removes it', () => {
    const f = fixture()
    f.deps.unit = cellUnit(f)
    const uninstall = installUnitSpin(window, f.deps)
    const hook = (
      window as unknown as { __vmdeSpinUnit?: (...args: unknown[]) => boolean }
    ).__vmdeSpinUnit
    expect(typeof hook).toBe('function')
    expect(hook!({}, rangeIn(f.cell), f.table, undefined)).toBe(true)
    uninstall()
    expect(
      (window as unknown as { __vmdeSpinUnit?: unknown }).__vmdeSpinUnit,
    ).toBeUndefined()
  })
})

describe('installUnitSpin beforeinput record (Q-50)', () => {
  type Hook = (
    vditor: unknown,
    range: Range,
    block: HTMLElement,
    event: InputEvent | undefined,
  ) => boolean
  const hookOf = (): Hook =>
    (window as unknown as { __vmdeSpinUnit: Hook }).__vmdeSpinUnit

  /** Sets the selection like the browser had it before the edit, then fires the capture listener. */
  function beforeInput(
    anchor: Node,
    anchorOffset: number,
    focus: Node = anchor,
    focusOffset: number = anchorOffset,
    inputType = 'deleteContentBackward',
  ): void {
    window
      .getSelection()
      ?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset)
    document.body.dispatchEvent(
      new InputEvent('beforeinput', { inputType, bubbles: true }),
    )
  }

  /** A table with two cells and a list with two items. */
  function twoUnits(f: Fixture) {
    f.cell
      .closest('tr')!
      .insertAdjacentHTML('beforeend', '<th>second<wbr></th>')
    const second = f.cell.nextElementSibling as HTMLElement
    const secondItem = f.item.nextElementSibling as HTMLElement
    return { second, secondItem }
  }

  const back = (): InputEvent => input('deleteContentBackward', null)
  let uninstall: (() => void) | undefined
  afterEach(() => {
    uninstall?.()
    uninstall = undefined
    window.getSelection()?.removeAllRanges()
  })

  it('a deletion over several cells refuses event (multi-cell selection)', () => {
    const f = fixture()
    const { second } = twoUnits(f)
    uninstall = installUnitSpin(window, f.deps)
    f.deps.unit = cellUnit(f)
    beforeInput(f.cell.firstChild!, 1, second.firstChild!, 2)
    expect(hookOf()({}, rangeIn(f.cell.firstChild!), f.table, back())).toBe(
      false,
    )
    expect(f.deps.counted).toEqual(['event'])
    expect(f.deps.cellCalls).toEqual([])
  })

  it('a deletion over a selection inside one cell is spun', () => {
    const f = fixture()
    uninstall = installUnitSpin(window, f.deps)
    f.deps.unit = cellUnit(f)
    beforeInput(f.cell.firstChild!, 0, f.cell.firstChild!, 2)
    expect(hookOf()({}, rangeIn(f.cell.firstChild!), f.table, back())).toBe(
      true,
    )
  })

  it('a deletion over items of two lists or a selection ending outside a unit refuses event', () => {
    const f = fixture()
    const { secondItem } = twoUnits(f)
    uninstall = installUnitSpin(window, f.deps)
    f.deps.unit = itemUnit(f)
    beforeInput(f.item.firstChild!, 1, secondItem.firstChild!, 1)
    expect(hookOf()({}, rangeIn(f.item.firstChild!), f.list, back())).toBe(
      false,
    )
    beforeInput(f.item.firstChild!, 1, f.root, f.root.childNodes.length)
    expect(hookOf()({}, rangeIn(f.item.firstChild!), f.list, back())).toBe(
      false,
    )
    expect(f.deps.counted).toEqual(['event', 'event'])
  })

  it('a deletion over a selection inside one item is spun', () => {
    const f = fixture()
    uninstall = installUnitSpin(window, f.deps)
    f.deps.unit = itemUnit(f)
    beforeInput(f.item.firstChild!, 0, f.item.firstChild!, 3)
    expect(hookOf()({}, rangeIn(f.item.firstChild!), f.list, back())).toBe(true)
  })

  it('a Backspace with the caret at an item start is refused; mid-item it is spun', () => {
    const f = fixture()
    uninstall = installUnitSpin(window, f.deps)
    f.deps.unit = itemUnit(f)
    beforeInput(f.item.firstChild!, 0)
    expect(hookOf()({}, rangeIn(f.item.firstChild!), f.list, back())).toBe(
      false,
    )
    expect(f.deps.counted).toEqual(['event'])
    beforeInput(f.item.firstChild!, 2)
    expect(hookOf()({}, rangeIn(f.item.firstChild!), f.list, back())).toBe(true)
  })

  it('the hook reads and clears the record: a call without a new beforeinput sees none', () => {
    const f = fixture()
    uninstall = installUnitSpin(window, f.deps)
    f.deps.unit = itemUnit(f)
    beforeInput(f.item.firstChild!, 0)
    expect(hookOf()({}, rangeIn(f.item.firstChild!), f.list, back())).toBe(
      false,
    )
    f.item.innerHTML = 'item<wbr>'
    expect(hookOf()({}, rangeIn(f.item.firstChild!), f.list, back())).toBe(true)
  })

  it('the uninstall removes the listener', () => {
    const f = fixture()
    const add = vi.spyOn(window, 'removeEventListener')
    installUnitSpin(window, f.deps)()
    expect(add).toHaveBeenCalledWith('beforeinput', expect.any(Function), true)
  })
})
