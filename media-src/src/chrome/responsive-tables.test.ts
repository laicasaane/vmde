// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  provideUnitFeed,
  type LiveUnit,
  type UnitFeed,
  type UnitsChange,
} from '../util/unit-changes'
import {
  setMeasureCloneHinter,
  WRAP_HINT_REPLAN_EVENT,
} from '../util/wrap-hint-mark'
import {
  fixResponsiveTables,
  pairReplacedTables,
  tableFillWidth,
} from './responsive-tables'
import {
  type BudgetCounts,
  type Factor,
  costClock,
  countBudget,
  fakeLanes,
  irFixture,
  wysiwygFixture,
} from '../testing/budget-harness'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'

function mountTables(): {
  firstBlock: HTMLElement
  first: HTMLTableElement
  second: HTMLTableElement
} {
  document.body.innerHTML = `<div class="vditor"><pre class="vditor-reset">
    <div id="first-block" data-block="0"><table id="first"><tbody><tr><td>A</td></tr></tbody></table></div>
    <div id="second-block" data-block="0"><table id="second"><tbody><tr><td>B</td></tr></tbody></table></div>
  </pre></div>`
  return {
    firstBlock: document.getElementById('first-block')!,
    first: document.getElementById('first') as HTMLTableElement,
    second: document.getElementById('second') as HTMLTableElement,
  }
}

async function flushMutationAndDebounce(): Promise<void> {
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(16)
}

describe('fixResponsiveTables mutation locality', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it('normalizes only the table inside the block changed by a mutation batch', async () => {
    const { first, second } = mountTables()
    fixResponsiveTables()
    await flushMutationAndDebounce()
    await flushMutationAndDebounce()
    const unrelatedRemove = vi.spyOn(second, 'removeAttribute')

    first.tBodies[0].appendChild(document.createElement('tr'))
    await flushMutationAndDebounce()

    expect(first.style.width).toBe(
      'calc(100% - var(--vmde-indent-offset, 0px))',
    )
    expect(unrelatedRemove).not.toHaveBeenCalled()
  })

  it('keeps window resize as a deliberate full-table normalization', async () => {
    const { second } = mountTables()
    fixResponsiveTables()
    await flushMutationAndDebounce()
    await flushMutationAndDebounce()
    const remove = vi.spyOn(second, 'removeAttribute')

    window.dispatchEvent(new Event('resize'))
    await vi.advanceTimersByTimeAsync(16)

    expect(remove).toHaveBeenCalledWith('width')
  })

  it('does not override an important details hidden-state display', async () => {
    const { first } = mountTables()
    const style = document.createElement('style')
    style.textContent =
      '.vditor-reset [data-vmde-details-hidden] { display: none !important; }'
    document.body.prepend(style)
    first.setAttribute('data-vmde-details-hidden', '')

    fixResponsiveTables()
    await flushMutationAndDebounce()
    await flushMutationAndDebounce()

    expect(getComputedStyle(first).display).toBe('none')
    first.removeAttribute('data-vmde-details-hidden')
    expect(getComputedStyle(first).display).toBe('table')
  })

  // Task 706: a table inside a d2 markdown label is part of the diagram picture. Styling it (and the
  // auto-width class only the Preview copy received) made the panes' markup differ.
  it('leaves a table inside a diagram label (svg foreignObject) untouched', async () => {
    document.body.innerHTML = `<div class="vditor"><div class="vditor-reset">
      <div class="language-d2"><svg><foreignObject><div class="vmde-d2-md"><table id="label" width="40"><tbody><tr><td>A</td></tr></tbody></table></div></foreignObject></svg></div>
    </div></div>`
    const label = document.getElementById('label')!
    const before = label.outerHTML

    fixResponsiveTables()
    await flushMutationAndDebounce()
    await flushMutationAndDebounce()
    window.dispatchEvent(new Event('resize'))
    await vi.advanceTimersByTimeAsync(16)

    expect(label.outerHTML).toBe(before)
  })

  // Task 723: the front-matter properties table sizes its own name column with an auto table layout.
  // The normalizer pins `table-layout: fixed !important` inline on a table, and that out-ranks any
  // stylesheet rule, so the properties table is left alone, in the first pass and after a resize.
  it('leaves the front-matter properties table untouched (task 723)', async () => {
    document.body.innerHTML = `<div class="vditor"><div class="vditor-reset">
      <div class="vmde-front-matter"><table id="props" class="vmde-front-matter__table"><tbody><tr><th>a</th><td><table id="inner"><tbody><tr><td>x</td></tr></tbody></table></td></tr></tbody></table></div>
      <table id="plain"><tbody><tr><td>B</td></tr></tbody></table>
    </div></div>`
    const props = document.getElementById('props')!
    const inner = document.getElementById('inner')!
    const plain = document.getElementById('plain')!
    const before = props.outerHTML

    fixResponsiveTables()
    await flushMutationAndDebounce()
    await flushMutationAndDebounce()
    window.dispatchEvent(new Event('resize'))
    await vi.advanceTimersByTimeAsync(16)

    expect(props.outerHTML).toBe(before)
    expect(props.style.tableLayout).toBe('')
    expect(inner.style.tableLayout).toBe('')
    expect(plain.style.tableLayout).toBe('fixed')
  })
})

// Task 660: an indented table that cannot shrink into the room left by its indentation records its
// rendered width as --vmde-table-floor, which main.css turns into a smaller start margin. jsdom does
// no layout, so the table's width, its uncapped start margin and the parent's content width are
// stubbed; the stubs stand in for the measurements the Chromium and real-webview specs make.
describe('fixResponsiveTables indentation floor (task 660)', () => {
  const FLOOR = '--vmde-table-floor'
  let layout: { offset: string; width: number }
  let rects: number

  beforeEach(() => {
    vi.useFakeTimers()
    layout = { offset: 'min(320px, 40%)', width: 811 }
    rects = 0
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  function mountIndented(attr: string | null = '5'): HTMLTableElement {
    const { first } = mountTables()
    if (attr !== null) first.setAttribute('data-vmde-indent', attr)
    Object.defineProperty(first.parentElement!, 'clientWidth', {
      configurable: true,
      value: 416,
    })
    const real = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const style = real(el, pseudo)
      if (el !== first) return style
      return new Proxy(style, {
        get(target, key) {
          if (key === 'getPropertyValue')
            return (name: string) =>
              name === '--vmde-indent-offset'
                ? layout.offset
                : target.getPropertyValue(name)
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    })
    first.getBoundingClientRect = () => {
      rects++
      return { width: layout.width } as DOMRect
    }
    return first
  }

  const run = async () => {
    await flushMutationAndDebounce()
    await flushMutationAndDebounce()
  }

  it('records the rendered width while the table is wider than the room left by the indentation', async () => {
    const table = mountIndented()
    fixResponsiveTables()
    await run()
    expect(table.style.getPropertyValue(FLOOR)).toBe('811px')
  })

  it('writes nothing while the table fits the room (40% of 416 = 166.4, so 249.6 left)', async () => {
    layout.width = 249.6
    const table = mountIndented()
    fixResponsiveTables()
    await run()
    expect(table.style.getPropertyValue(FLOOR)).toBe('')
  })

  it('writes nothing for a table without an indentation mark, or with a zero offset', async () => {
    const plain = mountIndented(null)
    fixResponsiveTables()
    await run()
    expect(plain.style.getPropertyValue(FLOOR)).toBe('')
    layout.offset = '0px'
    plain.setAttribute('data-vmde-indent', '5')
    await run()
    expect(plain.style.getPropertyValue(FLOOR)).toBe('')
  })

  it('clears the floor once the table fits again, and when the mark goes away', async () => {
    const table = mountIndented()
    fixResponsiveTables()
    await run()
    expect(table.style.getPropertyValue(FLOOR)).toBe('811px')
    layout.width = 200
    window.dispatchEvent(new Event('resize'))
    await run()
    expect(table.style.getPropertyValue(FLOOR)).toBe('')
    layout.width = 811
    window.dispatchEvent(new Event('resize'))
    await run()
    expect(table.style.getPropertyValue(FLOOR)).toBe('811px')
    table.removeAttribute('data-vmde-indent')
    await run()
    expect(table.style.getPropertyValue(FLOOR)).toBe('')
  })

  it('measures a table whose mark appears after the first pass (live toggle)', async () => {
    const table = mountIndented(null)
    fixResponsiveTables()
    await run()
    expect(table.style.getPropertyValue(FLOOR)).toBe('')
    table.setAttribute('data-vmde-indent', '5')
    await run()
    expect(table.style.getPropertyValue(FLOOR)).toBe('811px')
  })

  it('follows a changed width and settles: a stable table is not measured again by its own writes', async () => {
    const table = mountIndented()
    fixResponsiveTables()
    await run()
    layout.width = 600
    window.dispatchEvent(new Event('resize'))
    await run()
    expect(table.style.getPropertyValue(FLOOR)).toBe('600px')
    const settled = rects
    await run()
    await run()
    expect(rects).toBe(settled)
    expect(table.style.getPropertyValue(FLOOR)).toBe('600px')
  })
  it('resolves the offset forms main.css produces: a px value, a percentage, min() of both', async () => {
    const table = mountIndented()
    fixResponsiveTables()
    for (const [offset, floor] of [
      ['100px', '811px'], // room 316
      ['min(100px, 40%)', '811px'],
      ['75%', '811px'], // 312 of 416, room 104
      ['min(300px, 40%)', '811px'],
    ] as const) {
      layout.offset = offset
      window.dispatchEvent(new Event('resize'))
      await run()
      expect(table.style.getPropertyValue(FLOOR), offset).toBe(floor)
    }
    // A table that fits the smaller of the two terms is not capped.
    layout.offset = 'min(100px, 40%)'
    layout.width = 316
    window.dispatchEvent(new Event('resize'))
    await run()
    expect(table.style.getPropertyValue(FLOOR)).toBe('')
  })

  it("writes nothing when the offset is not understood (today's layout)", async () => {
    layout.offset = 'calc(10px + 5%)'
    const table = mountIndented()
    fixResponsiveTables()
    await run()
    expect(table.style.getPropertyValue(FLOOR)).toBe('')
  })
  it('re-fits the auto column widths when the indentation mark changes depth (1 to 4), not only on/off', async () => {
    class FakeIntersectionObserver {
      constructor(private readonly cb: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.cb(
          [{ target, isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        )
      }
      unobserve() {
        // Nothing to release in the fake.
      }
      disconnect() {
        // Nothing to release in the fake.
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    document.body.innerHTML = `<div class="vditor"><pre class="vditor-reset"><table id="t"><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></pre></div>`
    const table = document.getElementById('t') as HTMLTableElement
    Object.defineProperty(table.parentElement, 'clientWidth', {
      configurable: true,
      value: 416,
    })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        return { width: this.tagName === 'TABLE' ? 400 : 50 } as DOMRect
      },
    )
    const real = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const style = real(el, pseudo)
      if (el !== table) return style
      return new Proxy(style, {
        get(target, key) {
          if (key === 'getPropertyValue')
            return (name: string) =>
              name === '--vmde-indent-offset'
                ? `min(${Number(table.getAttribute('data-vmde-indent')) * 24}px, 40%)`
                : target.getPropertyValue(name)
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    })
    const rules = () =>
      [...document.head.querySelectorAll('style')]
        .map((style) => style.textContent)
        .join('|')
    fixResponsiveTables()
    await run()
    await vi.advanceTimersByTimeAsync(700)
    table.setAttribute('data-vmde-indent', '1')
    await run()
    const atOne = rules()
    expect(atOne).not.toBe('')
    table.setAttribute('data-vmde-indent', '4')
    await run()
    expect(rules()).not.toBe(atOne)
    vi.unstubAllGlobals()
  })
  it('reads no layout for a table without an indentation mark (setting off)', async () => {
    const { first } = mountTables()
    const parent = first.parentElement as HTMLElement
    const widthReads = vi.fn(() => 416)
    Object.defineProperty(parent, 'clientWidth', {
      configurable: true,
      get: widthReads,
    })
    const styleReads = vi.spyOn(window, 'getComputedStyle')
    first.getBoundingClientRect = vi.fn(() => ({ width: 800 }) as DOMRect)
    fixResponsiveTables()
    await run()
    expect(widthReads).not.toHaveBeenCalled()
    expect(styleReads).not.toHaveBeenCalled()
    expect(first.getBoundingClientRect).not.toHaveBeenCalled()
  })
})

// Task 640 S2d (acceptance item 1, tables): the Task 639 min-content layout is read from a clone
// that was stripped of the live table's hints and then hinted at priority 1. jsdom does no layout;
// the cell rects are stubbed by measurement layout, which is how the order is observed.
describe('fixResponsiveTables measurement clones (Task 640 S2d)', () => {
  const HINT = '<span class="vmde-wrap-hint" data-render="1"></span>'

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it('hints the clone between the max and the min read, never the live table, and announces the new widths', async () => {
    class FakeIntersectionObserver {
      constructor(private readonly cb: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.cb(
          [{ target, isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        )
      }
      unobserve() {
        // Nothing to release in the fake.
      }
      disconnect() {
        // Nothing to release in the fake.
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    document.body.innerHTML = `<div class="vditor"><pre class="vditor-reset"><table id="t"><thead><tr><th>file</th><th>note</th></tr></thead><tbody><tr><td>aaaa/${HINT}bbbb/cccc</td><td>x</td></tr></tbody></table></pre></div>`
    const table = document.getElementById('t') as HTMLTableElement
    Object.defineProperty(table.parentElement, 'clientWidth', {
      configurable: true,
      value: 416,
    })
    // Live cells 50 px, the table 400 px; in the measurement host the cells are 300 px at max-content
    // and 60 px at min-content.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        if (this.tagName === 'TABLE') return { width: 400 } as DOMRect
        const host = this.closest('[data-vmde-measure]')
        if (!host) return { width: 50 } as DOMRect
        return {
          width: host.getAttribute('data-vmde-measure') === 'max' ? 300 : 60,
        } as DOMRect
      },
    )
    const calls: Array<{
      layout: string | null
      hintsOnEntry: number
      widths: readonly number[]
      floor: number
      isLive: boolean
    }> = []
    const unregister = setMeasureCloneHinter((clone, widths, floor) => {
      calls.push({
        layout: clone
          .closest('[data-vmde-measure]')
          ?.getAttribute('data-vmde-measure') as string | null,
        hintsOnEntry: clone.querySelectorAll('.vmde-wrap-hint').length,
        widths,
        floor,
        isLive: clone === table,
      })
    })
    const targets: EventTarget[] = []
    document.addEventListener(WRAP_HINT_REPLAN_EVENT, (event) =>
      targets.push(event.target as EventTarget),
    )

    fixResponsiveTables()
    await flushMutationAndDebounce()
    await flushMutationAndDebounce()
    await flushMutationAndDebounce()
    unregister()

    // Called once, after the max read (layout still `max`), with the max widths and the column floor;
    // the copy of the live hint was stripped before the hinter ran.
    expect(calls).toEqual([
      {
        layout: 'max',
        hintsOnEntry: 0,
        widths: [300, 300],
        floor: 48,
        isLive: false,
      },
    ])
    // The live table keeps its own hint, and its widths were written and announced.
    expect(table.querySelectorAll('.vmde-wrap-hint')).toHaveLength(1)
    expect(document.head.textContent).toContain('width:')
    expect(targets).toEqual([table])
  })
})

describe('tableFillWidth (Task 713)', () => {
  it('returns the room, not a wider stale rect, when nothing is reserved', () => {
    expect(tableFillWidth(1133, 787, 0)).toBe(787)
  })

  it('returns the room when the rect is narrower than the room', () => {
    expect(tableFillWidth(300, 787, 0)).toBe(787)
  })

  it('subtracts the indentation offset or start margin from the room', () => {
    expect(tableFillWidth(1133, 787, 40)).toBe(747)
    expect(tableFillWidth(200, 787, 40)).toBe(747)
  })

  it('treats an unreadable reservation as none', () => {
    expect(tableFillWidth(1133, 787, Number.NaN)).toBe(787)
  })

  it('falls back to the rect with no parent', () => {
    expect(tableFillWidth(1133, undefined, 0)).toBe(1133)
  })

  it('falls back to the rect when the room is not positive', () => {
    expect(tableFillWidth(500, 0, 0)).toBe(500)
    expect(tableFillWidth(500, 40, 40)).toBe(500)
    expect(tableFillWidth(500, 30, 40)).toBe(500)
  })
})

// Task 720: an Undo/Redo restore replaces the whole editor root, every table with it, in one record.
describe('pairReplacedTables (Task 720)', () => {
  function tables(...rows: string[][]): HTMLTableElement[] {
    return rows.map((cells) => {
      const table = document.createElement('table')
      const row = table.insertRow()
      for (const text of cells) row.insertCell().textContent = text
      return table
    })
  }
  const shape = (
    pairs: ReturnType<typeof pairReplacedTables>,
    removed: HTMLTableElement[],
    added: HTMLTableElement[],
  ) =>
    pairs.map((pair) => [
      removed.indexOf(pair.previous),
      added.indexOf(pair.next),
      pair.unchanged,
    ])

  it('keeps the one-to-one keystroke pair, changed or not', () => {
    const [a] = tables(['a', 'b'])
    const [b] = tables(['a', 'bX'])
    const [c] = tables(['a', 'b'])
    expect(shape(pairReplacedTables([a], [b]), [a], [b])).toEqual([
      [0, 0, false],
    ])
    expect(shape(pairReplacedTables([a], [c]), [a], [c])).toEqual([
      [0, 0, true],
    ])
  })

  it('pairs every table of a rebuild in order when none changed', () => {
    const removed = tables(['a'], ['b', 'c'], ['d'])
    const added = tables(['a'], ['b', 'c'], ['d'])
    expect(shape(pairReplacedTables(removed, added), removed, added)).toEqual([
      [0, 0, true],
      [1, 1, true],
      [2, 2, true],
    ])
  })

  it('pairs the one edited table between the unchanged ones', () => {
    const removed = tables(['a'], ['b', 'c'], ['d'])
    const added = tables(['a'], ['b', 'cX'], ['d'])
    expect(shape(pairReplacedTables(removed, added), removed, added)).toEqual([
      [0, 0, true],
      [1, 1, false],
      [2, 2, true],
    ])
  })

  it('leaves the middle unpaired when a table was added or removed, or several changed', () => {
    const removed = tables(['a'], ['b'], ['d'])
    const inserted = tables(['a'], ['b'], ['new'], ['d'])
    expect(
      shape(pairReplacedTables(removed, inserted), removed, inserted),
    ).toEqual([
      [0, 0, true],
      [1, 1, true],
      [2, 3, true],
    ])
    const dropped = tables(['a'], ['d'])
    expect(
      shape(pairReplacedTables(removed, dropped), removed, dropped),
    ).toEqual([
      [0, 0, true],
      [2, 1, true],
    ])
    const twoChanged = tables(['a'], ['bX'], ['dX'])
    expect(
      shape(pairReplacedTables(removed, twoChanged), removed, twoChanged),
    ).toEqual([[0, 0, true]])
  })

  it('never pairs tables with equal text but a different column count', () => {
    const removed = tables(['ab'], ['c'])
    const added = tables(['a', 'b'], ['c'])
    expect(shape(pairReplacedTables(removed, added), removed, added)).toEqual([
      [0, 0, false],
      [1, 1, true],
    ])
  })

  it('pairs nothing when one side has no table', () => {
    expect(pairReplacedTables([], tables(['a']))).toEqual([])
    expect(pairReplacedTables(tables(['a']), [])).toEqual([])
  })
})

describe('fixResponsiveTables restore adoption (Task 720)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    class FakeIntersectionObserver {
      constructor(private readonly cb: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.cb(
          [{ target, isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        )
      }
      unobserve() {
        // Nothing to release in the fake.
      }
      disconnect() {
        // Nothing to release in the fake.
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        return { width: this.tagName === 'TABLE' ? 400 : 50 } as DOMRect
      },
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  const table = (id: string, value: string) =>
    `<table id="${id}"><thead><tr><th>k</th><th>v</th></tr></thead><tbody><tr><td>${id}</td><td>${value}</td></tr></tbody></table>`
  const autoClass = (el: Element | null) =>
    Array.from(el?.classList ?? []).find((name) =>
      name.startsWith('vmde-table-auto-'),
    )

  it('gives each rebuilt table its own cached width class before the next paint', async () => {
    document.body.innerHTML = `<div class="vditor"><pre class="vditor-reset">${table('t1', 'one')}<p>para</p>${table('t2', 'two')}${table('t3', 'three')}</pre></div>`
    const surface = document.querySelector('.vditor-reset') as HTMLElement
    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      value: 416,
    })
    fixResponsiveTables()
    await vi.advanceTimersByTimeAsync(700)
    const before = ['t1', 't2', 't3'].map((id) =>
      autoClass(document.getElementById(id)),
    )
    expect(before.every(Boolean)).toBe(true)
    expect(new Set(before).size).toBe(3)
    // The restore: the whole root at once, the paragraph and the third table's text changed.
    surface.innerHTML = `${table('t1', 'one')}<p>para edited</p>${table('t2', 'two')}${table('t3', 'three!')}`
    await Promise.resolve()
    const after = ['t1', 't2', 't3'].map((id) =>
      autoClass(document.getElementById(id)),
    )
    expect(after).toEqual(before)
    // Each class still has its width rules.
    const rules = [...document.head.querySelectorAll('style')]
      .map((style) => style.textContent)
      .join('\n')
    for (const name of before) expect(rules).toContain(`table.${name} `)
  })
})

describe('fixResponsiveTables on the unit feed (Task 733 007)', () => {
  let emit: (change: UnitsChange) => void
  let surface: HTMLElement
  let cloneCount: number
  let liveUnitsCalls: number

  function fakeFeed(root: HTMLElement): UnitFeed {
    const listeners = new Set<(change: UnitsChange) => void>()
    emit = (change) => {
      for (const listener of listeners) listener(change)
    }
    return {
      root,
      isLive: () => true,
      liveUnitOf: () => undefined,
      liveUnits: () => {
        liveUnitsCalls++
        return []
      },
      onUnitsChanged(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      confirmNow: () => true,
      confirmedLines: () => undefined,
    }
  }

  const cellUnit = (cell: HTMLElement): LiveUnit => ({
    el: cell,
    members: [cell],
    kind: 'cell',
    top: cell.closest('table') as HTMLElement,
  })

  const change = (partial: Partial<UnitsChange>): UnitsChange => ({
    cause: 'mutation',
    whole: false,
    changed: [],
    structural: [],
    ...partial,
  })

  const table = (id: string) =>
    `<table id="${id}"><thead><tr><th>k</th><th>v</th></tr></thead><tbody><tr><td>${id}-a</td><td>${id}-b</td></tr></tbody></table>`

  /** The stored width of column `index` (1-based) in the table's rule, from the head style. */
  function storedWidth(id: string, index: number): number {
    const cls = Array.from(document.getElementById(id)!.classList).find(
      (name) => name.startsWith('vmde-table-auto-'),
    )!
    const rules = [...document.head.querySelectorAll('style')]
      .map((style) => style.textContent ?? '')
      .join('\n')
    const match = new RegExp(
      `table\\.${cls} tr > :is\\(th, td\\):nth-child\\(${index}\\) \\{[^}]*?width: ([0-9.]+)px`,
    ).exec(rules)
    return Number(match?.[1])
  }

  /** Edits the cell text (the content observer sees a record) and settles one microtask. */
  async function editCell(cell: HTMLElement, text: string): Promise<void> {
    cell.firstChild!.textContent = text
    await Promise.resolve()
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    class FakeIntersectionObserver {
      constructor(private readonly cb: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.cb(
          [{ target, isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        )
      }
      unobserve() {
        // Nothing to release in the fake.
      }
      disconnect() {
        // Nothing to release in the fake.
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        // A cell measured alone in the host: long `w` text is wide (300 max, 60 min), the rest is 50.
        const wide =
          /^w{20,}$/.test(this.textContent ?? '') &&
          this.closest('[data-vmde-measure]')
        if (wide)
          return {
            width: wide.getAttribute('data-vmde-measure') === 'max' ? 300 : 60,
          } as DOMRect
        return { width: this.tagName === 'TABLE' ? 400 : 50 } as DOMRect
      },
    )
    document.body.innerHTML = `<div class="vditor"><pre class="vditor-reset">${table('ta')}${table('tb')}</pre></div>`
    surface = document.querySelector('.vditor-reset') as HTMLElement
    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      value: 416,
    })
    provideUnitFeed(window, fakeFeed(surface))
    fixResponsiveTables()
    await vi.advanceTimersByTimeAsync(700)
    // Every table has its stored widths; count the clones from here.
    cloneCount = 0
    liveUnitsCalls = 0
    const clone = HTMLTableElement.prototype.cloneNode
    vi.spyOn(HTMLTableElement.prototype, 'cloneNode').mockImplementation(
      function (this: HTMLTableElement, deep?: boolean) {
        if (deep) cloneCount++
        return clone.call(this, deep)
      },
    )
  })
  afterEach(() => {
    provideUnitFeed(window, undefined)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.body.replaceChildren()
    document.head.replaceChildren()
  })

  it('measures nothing and clones nothing for a changed cell inside the stored column values', async () => {
    const cell = document.querySelector('#ta td') as HTMLElement
    const before = document.head.textContent

    await editCell(cell, 'ab')
    emit(change({ changed: [cellUnit(cell)] }))
    await vi.advanceTimersByTimeAsync(700)

    expect(cloneCount).toBe(0)
    expect(document.head.textContent).toBe(before)
  })

  it('widens the column from the cell alone, with no table clone', async () => {
    const cell = document.querySelector('#ta td') as HTMLElement
    const before = storedWidth('ta', 1)

    await editCell(cell, 'w'.repeat(80))
    emit(change({ changed: [cellUnit(cell)] }))
    await vi.advanceTimersByTimeAsync(700)

    expect(cloneCount).toBe(0)
    expect(storedWidth('ta', 1)).toBeGreaterThan(before)
    // The other table keeps its rule.
    expect(storedWidth('tb', 1)).toBeGreaterThan(0)
  })

  it('scans the column again when the cell that held the maximum became narrower', async () => {
    const cell = document.querySelector('#ta td') as HTMLElement
    await editCell(cell, 'w'.repeat(80))
    emit(change({ changed: [cellUnit(cell)] }))
    await vi.advanceTimersByTimeAsync(700)
    const wide = storedWidth('ta', 1)

    await editCell(cell, 'ab')
    emit(change({ changed: [cellUnit(cell)] }))
    // The pause, then the column scan in timer slices.
    await vi.advanceTimersByTimeAsync(700)
    await vi.advanceTimersByTimeAsync(50)

    expect(cloneCount).toBe(0)
    expect(storedWidth('ta', 1)).toBeLessThan(wide)
  })

  it('never reads the unit list on the observer path', async () => {
    const cell = document.querySelector('#ta td') as HTMLElement

    await editCell(cell, 'ab')
    await editCell(cell, 'abc')
    emit(change({ changed: [cellUnit(cell)] }))
    await vi.advanceTimersByTimeAsync(700)

    expect(liveUnitsCalls).toBe(0)
  })

  it('marks a deferred table when the feed goes off before it reports the change', async () => {
    const cell = document.querySelector('#ta td') as HTMLElement
    const feed = {
      ...fakeFeed(surface),
      isLive: () => false,
    }
    await editCell(cell, 'ab') // deferred: the feed is live
    provideUnitFeed(window, feed)
    await editCell(cell, 'abc') // the feed is off now: the table is marked as before
    await vi.advanceTimersByTimeAsync(700)

    expect(cloneCount).toBe(1)
  })

  it('keeps the normalizer pass for a table nested in a blockquote', async () => {
    surface.insertAdjacentHTML(
      'beforeend',
      `<blockquote>${table('tn')}</blockquote>`,
    )
    await vi.advanceTimersByTimeAsync(700)
    const [changedCell, otherCell] = Array.from(
      document.querySelectorAll<HTMLElement>('#tn td'),
    )
    const removeOther = vi.spyOn(otherCell, 'removeAttribute')

    // The model does not split a nested table into cells, so the feed reports no unit for it.
    changedCell.innerHTML = '<b>x</b>'
    await vi.advanceTimersByTimeAsync(700)

    expect(removeOther).toHaveBeenCalledWith('width')
  })

  it('marks the table of an opaque table unit as a whole', async () => {
    const tableA = document.getElementById('ta') as HTMLElement
    const cell = document.querySelector('#ta td') as HTMLElement

    await editCell(cell, 'ab')
    emit(
      change({
        changed: [
          { el: tableA, members: [tableA], kind: 'table', top: tableA },
        ],
      }),
    )
    await vi.advanceTimersByTimeAsync(700)

    expect(cloneCount).toBe(1)
  })

  it('keeps the whole-table flush for a whole change', async () => {
    const cell = document.querySelector('#ta td') as HTMLElement

    await editCell(cell, 'ab')
    emit(change({ whole: true, cause: 'rebind' }))
    await vi.advanceTimersByTimeAsync(700)

    expect(cloneCount).toBe(1)
  })

  it('keeps the flush for a table listed as structural', async () => {
    const cell = document.querySelector('#ta td') as HTMLElement
    const tableA = document.getElementById('ta') as HTMLElement

    await editCell(cell, 'ab')
    emit(change({ changed: [cellUnit(cell)], structural: [tableA] }))
    await vi.advanceTimersByTimeAsync(700)

    expect(cloneCount).toBe(1)
  })

  // Run 1 `table-chrome-units` "a row insert recomputes the widths as before": the persistent host
  // (M4) is mounted once, so the measurement shows as a multi-row table clone mounted inside it.
  it('measures the table again inside the measurement host after a row insert', async () => {
    const tableA = document.getElementById('ta') as HTMLTableElement
    // The host stays mounted after the open fill; its clones come and go within one task.
    const host = document.querySelector('[data-vmde-measure]') as HTMLElement
    expect(host).not.toBeNull()
    let measured = 0
    const watcher = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (
            node instanceof HTMLElement &&
            (node.matches('table') || node.querySelector('table')) &&
            node.querySelector('tr + tr')
          )
            measured++
    })
    watcher.observe(host, { childList: true, subtree: true })
    const row = tableA.tBodies[0].rows[0].cloneNode(true) as HTMLTableRowElement
    tableA.tBodies[0].append(row)
    await Promise.resolve()
    emit({
      ...change({
        cause: 'sync',
        changed: Array.from(row.cells, (cell) => cellUnit(cell as HTMLElement)),
        structural: [tableA],
      }),
      scopes: [row],
    } as UnitsChange)
    await vi.advanceTimersByTimeAsync(700)
    await Promise.resolve()
    watcher.disconnect()

    expect(measured).toBeGreaterThanOrEqual(1)
  })

  it('runs the content observer path as before when no feed is provided', async () => {
    provideUnitFeed(window, undefined)
    const cell = document.querySelector('#ta td') as HTMLElement

    await editCell(cell, 'ab')
    await vi.advanceTimersByTimeAsync(700)

    expect(cloneCount).toBe(1)
  })

  it('normalizes only the changed cells for a non-whole change', async () => {
    const [changedCell, otherCell] = Array.from(
      document.querySelectorAll<HTMLElement>('#ta td'),
    )
    const removeOther = vi.spyOn(otherCell, 'removeAttribute')
    const removeChanged = vi.spyOn(changedCell, 'removeAttribute')

    changedCell.innerHTML = '<b>x</b>'
    await Promise.resolve()
    emit(change({ changed: [cellUnit(changedCell)] }))
    await vi.advanceTimersByTimeAsync(700)

    expect(removeChanged).toHaveBeenCalledWith('width')
    expect(removeOther).not.toHaveBeenCalled()
  })

  it('leaves the inline style of a changed paragraph alone', async () => {
    surface.insertAdjacentHTML('beforeend', '<p id="para">text</p>')
    const para = document.getElementById('para') as HTMLElement
    para.style.whiteSpace = 'pre'
    const cell = document.querySelector('#ta td') as HTMLElement

    emit(
      change({
        changed: [
          { el: para, members: [para], kind: 'paragraph', top: para },
          cellUnit(cell),
        ],
      }),
    )
    await vi.advanceTimersByTimeAsync(700)

    expect(para.style.whiteSpace).toBe('pre')
  })

  it('normalizes a cell whose inline width was written, as an attribute record', async () => {
    const [, otherCell] = Array.from(
      document.querySelectorAll<HTMLElement>('#ta td'),
    )
    otherCell.setAttribute('width', '80')
    await vi.advanceTimersByTimeAsync(700)

    expect(otherCell.hasAttribute('width')).toBe(false)
  })

  /**
   * Task 733 (012-9): inserts a list item into a top-level list before the tables and returns spies on
   * both tables' `removeAttribute`, which every table of a full normalization pass calls.
   */
  async function insertListItem(): Promise<{
    list: HTMLElement
    removeA: ReturnType<typeof vi.spyOn>
    removeB: ReturnType<typeof vi.spyOn>
  }> {
    surface.insertAdjacentHTML('afterbegin', '<ul id="list"><li>one</li></ul>')
    await vi.advanceTimersByTimeAsync(700)
    cloneCount = 0
    const list = document.getElementById('list') as HTMLElement
    const removeA = vi.spyOn(
      document.getElementById('ta') as HTMLElement,
      'removeAttribute',
    )
    const removeB = vi.spyOn(
      document.getElementById('tb') as HTMLElement,
      'removeAttribute',
    )
    const item = document.createElement('li')
    item.textContent = 'two'
    list.append(item)
    await Promise.resolve()
    return { list, removeA, removeB }
  }

  it('normalizes no table outside the list for a list item insert reported as list structure', async () => {
    const { list, removeA, removeB } = await insertListItem()

    emit(change({ cause: 'sync', structural: [list] }))
    await vi.advanceTimersByTimeAsync(700)

    expect(removeA).not.toHaveBeenCalled()
    expect(removeB).not.toHaveBeenCalled()
    expect(cloneCount).toBe(0)
  })

  // A list structure change that the session reports without a scope (a root notice that is no block
  // spin, or a sync that no batch explains) is not a whole-document cause: no full table pass.
  it.each(['mutation', 'sync'] as const)(
    'runs no full table pass for a list item insert reported as a whole %s change',
    async (cause) => {
      const { removeA, removeB } = await insertListItem()

      emit(change({ cause, whole: true }))
      await vi.advanceTimersByTimeAsync(700)

      expect(removeA).not.toHaveBeenCalled()
      expect(removeB).not.toHaveBeenCalled()
      expect(cloneCount).toBe(0)
    },
  )

  it.each(['build', 'rebind'] as const)(
    'keeps the full table pass for a whole %s change (open, mode switch, external update)',
    async (cause) => {
      const { removeA, removeB } = await insertListItem()

      emit(change({ cause, whole: true }))
      await vi.advanceTimersByTimeAsync(700)

      expect(removeA).toHaveBeenCalledWith('width')
      expect(removeB).toHaveBeenCalledWith('width')
    },
  )
})

/** Task 733 / 027: the rect of the document scroller, `height` px high, or undefined for another element. */
function documentScrollerRect(
  element: Element,
  height: number,
): DOMRect | undefined {
  if (
    element !== document.documentElement &&
    element !== document.scrollingElement
  )
    return undefined
  return { top: 0, bottom: height, height, width: 416 } as DOMRect
}

/** Task 733 / 027: a box `height` px high whose top is at `top` px, 400 px wide. */
function rowRect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, width: 400 } as DOMRect
}

/**
 * Task 733 / 027: a cell laid out in the measurement host, 7 px per character plus 26 px of padding
 * and border: the whole text at max-content, the longest word at min-content.
 */
function hostCellRect(
  cell: HTMLTableCellElement,
  layout: string | null,
): DOMRect {
  const text = (cell.textContent ?? '').trim()
  if (layout === 'max') return { width: 7 * text.length + 26 } as DOMRect
  let longest = 0
  for (const word of text.split(/\s+/u))
    longest = Math.max(longest, word.length)
  return { width: 7 * longest + 26 } as DOMRect
}

// Measuring every cell of 2,000 rows alone takes seconds in jsdom (no real layout to amortize).
describe('fixResponsiveTables on a 2,000-row table (Task 733 012-4)', {
  timeout: 30_000,
}, () => {
  const BODY_ROWS = 2000
  /** The body row whose first cell holds the column maximum. */
  const WIDE_ROW = 1500
  /** The most rows one measurement layout may hold for the first measurement of a table. */
  const CLONE_ROW_BOUND = 64

  let emit: (change: UnitsChange) => void
  let surface: HTMLElement
  let big: HTMLTableElement
  /** Deep clones of the live table: the `tableClone` counter of the edit counters. */
  let tableClones: number
  /** Shallow table clones: one per cell measured alone (`mountCellMeasurer`). */
  let cellMeasures: number
  /** The largest row count of a table laid out in the measurement host. */
  let largestLayout: number
  /** Task 733 / 027: the text of every cell laid out alone (one-row shell) in the measurement host. */
  let aloneTexts: Set<string>
  /** Task 733 / 027: the stubbed layout. Rows are `ROW_PX` high; `viewTop` is the `table.rows` index at the top. */
  const ROW_PX = 24
  const VIEWPORT_PX = 600
  let viewTop: number
  let viewport: number
  /** Sends one IntersectionObserver entry for `target` to the observer of the surface. */
  let intersect: (target: Element, isIntersecting: boolean) => void

  const textWidth = (text: string, layout: string | null) =>
    /^w{20,}$/.test(text) ? (layout === 'max' ? 300 : 60) : 50

  /**
   * A measured cell is as wide as the widest cell of its column in the table it is laid out in, as a
   * real table layout gives: a whole-table clone reports the column maximum from any row, a one-cell
   * shell reports the cell itself.
   */
  function hostCellWidth(cell: HTMLTableCellElement, layout: string | null) {
    const owner = cell.closest('table') as HTMLTableElement
    largestLayout = Math.max(largestLayout, owner.rows.length)
    if (owner.rows.length === 1) aloneTexts.add(cell.textContent ?? '')
    let width = 0
    for (const row of Array.from(owner.rows)) {
      const peer = row.cells[cell.cellIndex]
      if (peer)
        width = Math.max(width, textWidth(peer.textContent ?? '', layout))
    }
    return width
  }

  function mountBigTable(): void {
    const rows: string[] = []
    for (let index = 0; index < BODY_ROWS; index++)
      rows.push(
        `<tr><td>${index === WIDE_ROW ? 'w'.repeat(80) : `r${index}`}</td><td>v${index}</td></tr>`,
      )
    document.body.innerHTML = `<div class="vditor"><pre class="vditor-reset"><p id="para">intro</p><table id="big"><thead><tr><th>k</th><th>v</th></tr></thead><tbody>${rows.join('')}</tbody></table></pre></div>`
    surface = document.querySelector('.vditor-reset') as HTMLElement
    big = document.getElementById('big') as HTMLTableElement
    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      value: 416,
    })
  }

  function fakeFeed(root: HTMLElement): UnitFeed {
    const listeners = new Set<(change: UnitsChange) => void>()
    emit = (next) => {
      for (const listener of listeners) listener(next)
    }
    return {
      root,
      isLive: () => true,
      liveUnitOf: () => undefined,
      liveUnits: () => [],
      onUnitsChanged(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      confirmNow: () => true,
      confirmedLines: () => undefined,
    }
  }

  /** The stored width of column `index` (1-based) in the table's rule, from the head style. */
  function storedWidth(index: number): number {
    const cls = Array.from(big.classList).find((name) =>
      name.startsWith('vmde-table-auto-'),
    )!
    const rules = [...document.head.querySelectorAll('style')]
      .map((style) => style.textContent ?? '')
      .join('\n')
    const match = new RegExp(
      `table\\.${cls} tr > :is\\(th, td\\):nth-child\\(${index}\\) \\{[^}]*?width: ([0-9.]+)px`,
    ).exec(rules)
    return Number(match?.[1])
  }

  /** The typing pause, the flush, and every idle or timer slice queued after them. */
  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(700)
    await vi.advanceTimersByTimeAsync(5000)
  }

  /** The document scroller and the viewport are `height` px high (`innerHeight` and the root rect). */
  function setViewport(height: number): void {
    viewport = height
    vi.stubGlobal('innerHeight', height)
  }

  /**
   * Task 733 / 027: the view moves so `row` (a `table.rows` index) is at its top, and the document
   * scroller reports a scroll (the document scroller's scroll events fire at the `Document`).
   */
  function scrollToRow(row: number): void {
    viewTop = row
    document.dispatchEvent(new Event('scroll'))
  }

  /** The text of the cell in `WIDE_ROW`. */
  const WIDE_TEXT = 'w'.repeat(80)

  /**
   * Task 733 / 027: the document scroller spans the viewport; the rows of the live table sit `ROW_PX`
   * apart from the row at the top of the view. Undefined for every other element.
   */
  function viewRect(element: Element): DOMRect | undefined {
    const scroller = documentScrollerRect(element, viewport)
    if (scroller) return scroller
    if (
      element instanceof HTMLTableRowElement &&
      element.closest('table') === big
    )
      return rowRect(ROW_PX * (element.rowIndex - viewTop), ROW_PX)
    if (element === big)
      return rowRect(-ROW_PX * viewTop, ROW_PX * big.rows.length)
    return undefined
  }

  beforeEach(() => {
    vi.useFakeTimers()
    viewTop = 0
    setViewport(VIEWPORT_PX)
    aloneTexts = new Set()
    class FakeIntersectionObserver {
      constructor(private readonly cb: IntersectionObserverCallback) {
        intersect = (target, isIntersecting) =>
          this.cb(
            [{ target, isIntersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          )
      }
      observe(target: Element) {
        this.cb(
          [{ target, isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        )
      }
      unobserve() {
        // Nothing to release in the fake.
      }
      disconnect() {
        // Nothing to release in the fake.
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    // jsdom has no idle callbacks: an idle period comes after a timer, with time to spare.
    vi.stubGlobal(
      'requestIdleCallback',
      (callback: IdleRequestCallback) =>
        setTimeout(
          () => callback({ didTimeout: false, timeRemaining: () => 50 }),
          1,
        ) as unknown as number,
    )
    vi.stubGlobal('cancelIdleCallback', (handle: number) =>
      clearTimeout(handle),
    )
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        const host = this.closest('[data-vmde-measure]')
        if (host && this instanceof HTMLTableCellElement)
          return {
            width: hostCellWidth(this, host.getAttribute('data-vmde-measure')),
          } as DOMRect
        return (
          viewRect(this) ??
          ({ width: this.tagName === 'TABLE' ? 400 : 50 } as DOMRect)
        )
      },
    )
    tableClones = 0
    cellMeasures = 0
    largestLayout = 0
    const clone = HTMLTableElement.prototype.cloneNode
    vi.spyOn(HTMLTableElement.prototype, 'cloneNode').mockImplementation(
      function (this: HTMLTableElement, deep?: boolean) {
        if (deep && this === big) tableClones++
        if (!deep) cellMeasures++
        return clone.call(this, deep)
      },
    )
    mountBigTable()
    provideUnitFeed(window, fakeFeed(surface))
  })
  afterEach(() => {
    provideUnitFeed(window, undefined)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.body.replaceChildren()
    document.head.replaceChildren()
  })

  it('first measures a bounded row count, clones the table at most once, and finds the widest row after a scroll to it', async () => {
    fixResponsiveTables()
    await settle()

    expect(largestLayout).toBeGreaterThan(0)
    expect(largestLayout).toBeLessThanOrEqual(CLONE_ROW_BOUND)
    expect(tableClones).toBeLessThanOrEqual(1)
    // Task 733 / 027 (option (c)): the widest cell sits far below the view and its window, so it is
    // not measured and does not widen its column before a scroll.
    expect(aloneTexts.has(WIDE_TEXT)).toBe(false)
    expect(storedWidth(1)).toBeLessThanOrEqual(storedWidth(2))

    scrollToRow(WIDE_ROW)
    await settle()

    expect(aloneTexts.has(WIDE_TEXT)).toBe(true)
    expect(storedWidth(1)).toBeGreaterThan(storedWidth(2))
    expect(tableClones).toBeLessThanOrEqual(1)
  })

  it('measures at most one cell when the cell that held the column maximum shrinks', async () => {
    fixResponsiveTables()
    await settle()
    // Task 733 / 027: the holder is inside the window, so the fill measured it.
    scrollToRow(WIDE_ROW)
    await settle()
    const wide = storedWidth(1)
    cellMeasures = 0
    const cell = big.tBodies[0].rows[WIDE_ROW].cells[0]

    cell.firstChild!.textContent = 'ab'
    await Promise.resolve()
    emit({
      cause: 'mutation',
      whole: false,
      changed: [{ el: cell, members: [cell], kind: 'cell', top: big }],
      structural: [],
    })
    await settle()

    expect(cellMeasures).toBeLessThanOrEqual(1)
    expect(storedWidth(1)).toBeLessThan(wide)
  })

  /** The idle slice budget of the fill (`FILL_SLICE_MS`). */
  const SLICE_MS = 8
  /**
   * Task 733 / 027: the cells the fill measures with the view at the top. The planned rows are the
   * header and the first 32 body rows (the sample) and the window: the rows whose boxes meet one
   * viewport above and below the view, [-600, 1200) px, which are rows 0 to 49 of `table.rows`.
   * Two columns.
   */
  const PLANNED_CELLS = ((2 * VIEWPORT_PX) / ROW_PX) * 2
  /** One row that only touches a window edge may be planned too. */
  const EDGE_CELLS = 2
  /** The sample alone: the header and the first 32 body rows, two columns. */
  const SAMPLE_CELLS = (1 + 32) * 2

  /** Cells mounted alone in each idle slice, in slice order. */
  let sliceMounts: number[]
  /** Per live cell, how often the fill mounted a copy of it. */
  let cellCopies: Map<Element, number>
  let inSlice: boolean

  /**
   * Task 733 (012-9): a fake clock where each cell mounted alone costs 1 ms, and idle slices whose
   * deadline is spent `SLICE_MS` after they start. A fill that checks the deadline per mounted cell
   * mounts at most `SLICE_MS` cells per slice.
   */
  function useCostedSlices(): void {
    sliceMounts = []
    cellCopies = new Map()
    inSlice = false
    const now = () => Date.now() + cellMeasures
    vi.spyOn(performance, 'now').mockImplementation(now)
    vi.stubGlobal(
      'requestIdleCallback',
      (callback: IdleRequestCallback) =>
        setTimeout(() => {
          const start = now()
          const before = cellMeasures
          inSlice = true
          try {
            callback({
              didTimeout: false,
              timeRemaining: () => Math.max(0, start + SLICE_MS - now()),
            })
          } finally {
            inSlice = false
            sliceMounts.push(cellMeasures - before)
          }
        }, 1) as unknown as number,
    )
    const clone = HTMLTableCellElement.prototype.cloneNode
    vi.spyOn(HTMLTableCellElement.prototype, 'cloneNode').mockImplementation(
      function (this: HTMLTableCellElement, deep?: boolean) {
        if (deep && inSlice)
          cellCopies.set(this, (cellCopies.get(this) ?? 0) + 1)
        return clone.call(this, deep)
      },
    )
  }

  /** Cells the fill mounted more than once (a restarted or repeated fill). */
  const repeatedCells = () =>
    [...cellCopies.values()].filter((count) => count > 1).length

  it('mounts no cell after the slice deadline is spent and keeps the cells left queued', async () => {
    useCostedSlices()
    fixResponsiveTables()
    await settle()

    expect(sliceMounts.length).toBeGreaterThan(1)
    expect(Math.max(...sliceMounts)).toBeLessThanOrEqual(SLICE_MS)
    // The cells a slice left were measured by later slices, each once; only the planned rows.
    expect(cellCopies.size).toBeGreaterThanOrEqual(PLANNED_CELLS)
    expect(cellCopies.size).toBeLessThanOrEqual(PLANNED_CELLS + EDGE_CELLS)
    expect(repeatedCells()).toBe(0)

    // Task 733 / 027: the widest row is measured once a scroll plans it.
    scrollToRow(WIDE_ROW)
    await settle()

    expect(Math.max(...sliceMounts)).toBeLessThanOrEqual(SLICE_MS)
    expect(repeatedCells()).toBe(0)
    expect(storedWidth(1)).toBeGreaterThan(storedWidth(2))
  })

  it('measures only the sample rows when the scroller has no height (027)', async () => {
    setViewport(0)
    useCostedSlices()
    fixResponsiveTables()
    await settle()

    expect(cellCopies.size).toBeGreaterThan(0)
    expect(cellCopies.size).toBeLessThanOrEqual(SAMPLE_CELLS)
    expect(repeatedCells()).toBe(0)
  })

  it('measures the window of a table that becomes near without a scroll event (027-A2)', async () => {
    fixResponsiveTables()
    await settle()
    expect(storedWidth(1)).toBeLessThanOrEqual(storedWidth(2))

    // The table leaves the near margin, the view moves with no scroll event (a fold, a mode switch
    // or an edit above it), and the table becomes near again at the widest row.
    intersect(big, false)
    await settle()
    viewTop = WIDE_ROW
    intersect(big, true)
    await settle()

    expect(aloneTexts.has(WIDE_TEXT)).toBe(true)
    expect(storedWidth(1)).toBeGreaterThan(storedWidth(2))
  })

  // Run 1 P-6: the layout of a batch is paid at its first read, not when its cells are mounted. With
  // no measured cost yet, the first batch mounted all its cells and its layout ran far past the slice.
  it('keeps every fill slice within 8 + 2 ms when the layout reads carry the cost', async () => {
    let charged = 0
    const now = () => Date.now() + charged
    vi.spyOn(performance, 'now').mockImplementation(now)
    // Each read of a cell laid out in the host costs 1 ms of the slice (two reads per cell per batch).
    // The layout this describe's setup installed (the spy exists already; keep its widths).
    const measure = vi
      .mocked(Element.prototype.getBoundingClientRect)
      .getMockImplementation() as (this: Element) => DOMRect
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(
      function (this: Element) {
        if (
          this instanceof HTMLTableCellElement &&
          this.closest('[data-vmde-measure]')
        )
          charged += 1
        return measure.call(this)
      },
    )
    const slices: number[] = []
    vi.stubGlobal(
      'requestIdleCallback',
      (callback: IdleRequestCallback) =>
        setTimeout(() => {
          const start = now()
          callback({
            didTimeout: false,
            timeRemaining: () => Math.max(0, start + SLICE_MS - now()),
          })
          slices.push(now() - start)
        }, 1) as unknown as number,
    )
    fixResponsiveTables()
    await settle()

    expect(slices.length).toBeGreaterThan(1)
    expect(Math.max(...slices)).toBeLessThanOrEqual(SLICE_MS + 2)
  })

  // Research question 1 of the 012-M2 re-measurement: a paragraph edit outside the table, reported
  // scoped or whole by the feed, neither measures the table again nor starts its fill over.
  it.each(['scoped', 'whole'] as const)(
    'keeps the fill queue across a %s paragraph edit outside the table',
    async (form) => {
      useCostedSlices()
      fixResponsiveTables()
      // Task 733 / 027: stop in the middle of the planned cells.
      for (let step = 0; step < 1000 && cellCopies.size < 40; step++)
        await vi.advanceTimersByTimeAsync(1)
      expect(cellCopies.size).toBeGreaterThan(0)
      expect(cellCopies.size).toBeLessThan(PLANNED_CELLS)
      const clonesBefore = tableClones
      const para = document.getElementById('para') as HTMLElement

      para.firstChild!.textContent = 'edited intro'
      await Promise.resolve()
      emit({
        cause: 'mutation',
        whole: form === 'whole',
        changed:
          form === 'whole'
            ? []
            : [{ el: para, members: [para], kind: 'paragraph', top: para }],
        structural: [],
      })
      await settle()

      expect(tableClones).toBe(clonesBefore)
      expect(cellCopies.size).toBeGreaterThanOrEqual(PLANNED_CELLS)
      expect(cellCopies.size).toBeLessThanOrEqual(PLANNED_CELLS + EDGE_CELLS)
      expect(repeatedCells()).toBe(0)
    },
  )
})

// Task 733 / 027 (option (c), Q-133, Q-145): the idle fill measures the planned rows of a near table
// only: the header and the first 32 body rows, the known holders, and the rows within one scroller
// height above and below the view. The count of cells measured alone is bounded by the window, not by
// the table, so it is the same at factors 1, 4 and 16.
/** Cells measured alone per factor, compared across the factors of the block below. */
const fillWindowCells = new Map<Factor, number>()
/** A separate fixture root for this block (the fixture cache is keyed by the prepare callback). */
const fillWindowRoot = (_root: HTMLElement): void => {
  // No preparation: the key alone keeps this root apart from the B-08 roots.
}

describe.each([1, 4, 16] as const)(
  'fill window (027, option (c)) at factor %i',
  { timeout: 60_000 },
  (factor: Factor) => {
    /** Stubbed layout: rows are `ROW_PX` high from the top of the view; the viewport is `VIEWPORT_PX` high. */
    const ROW_PX = 24
    const VIEWPORT_PX = 600
    /** The first measurement's sample: the header and `MEASURE_CLONE_ROWS` (32) body rows. */
    const SAMPLE_ROWS = 1 + 32
    /** Rows whose boxes meet one viewport above and below the view, plus one row at an edge. */
    const WINDOW_ROWS = (3 * VIEWPORT_PX) / ROW_PX + 1

    let root: HTMLElement
    /** Per live table, the live cells the fill mounted alone (`mountCellMeasurer` copies them). */
    let measured: Map<HTMLTableElement, Set<Element>>

    beforeEach(() => {
      vi.useFakeTimers()
      root = irFixture(tableHeavyMarkdown(factor), fillWindowRoot).root
      const shell = document.createElement('div')
      shell.className = 'vditor'
      shell.append(root.parentElement as HTMLElement)
      document.body.replaceChildren(shell)
      Object.defineProperty(root, 'clientWidth', {
        configurable: true,
        value: 416,
      })
      vi.stubGlobal('innerHeight', VIEWPORT_PX)
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(private readonly cb: IntersectionObserverCallback) {}
          observe(target: Element) {
            this.cb(
              [{ target, isIntersecting: true } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            )
          }
          unobserve() {
            // Nothing to release in the fake.
          }
          disconnect() {
            // Nothing to release in the fake.
          }
        },
      )
      // jsdom has no idle callbacks: an idle period comes after a timer, with time to spare.
      vi.stubGlobal(
        'requestIdleCallback',
        (callback: IdleRequestCallback) =>
          setTimeout(
            () => callback({ didTimeout: false, timeRemaining: () => 50 }),
            1,
          ) as unknown as number,
      )
      vi.stubGlobal('cancelIdleCallback', (handle: number) =>
        clearTimeout(handle),
      )
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
        function (this: Element) {
          const host = this.closest('[data-vmde-measure]')
          if (host && this instanceof HTMLTableCellElement)
            return hostCellRect(this, host.getAttribute('data-vmde-measure'))
          const scroller = documentScrollerRect(this, VIEWPORT_PX)
          if (scroller) return scroller
          // Every table starts at the top of the view, so each one has the same window.
          if (this instanceof HTMLTableRowElement)
            return rowRect(ROW_PX * this.rowIndex, ROW_PX)
          if (this instanceof HTMLTableElement)
            return rowRect(0, ROW_PX * this.rows.length)
          return { width: 50 } as DOMRect
        },
      )
      measured = new Map()
      const clone = HTMLTableCellElement.prototype.cloneNode
      vi.spyOn(HTMLTableCellElement.prototype, 'cloneNode').mockImplementation(
        function (this: HTMLTableCellElement, deep?: boolean) {
          const table = this.closest('table')
          if (deep && table && !this.closest('[data-vmde-measure]')) {
            const cells = measured.get(table) ?? new Set<Element>()
            measured.set(table, cells)
            cells.add(this)
          }
          return clone.call(this, deep)
        },
      )
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      vi.useRealTimers()
      document.body.replaceChildren()
      document.head.replaceChildren()
    })

    it('measures alone at most (header + 32 + window rows) x columns per near table, the same at every factor', async () => {
      const tables = Array.from(
        root.querySelectorAll<HTMLTableElement>(':scope > table'),
      )
      expect(tables.length).toBe(2)

      fixResponsiveTables()
      await vi.advanceTimersByTimeAsync(700)
      await vi.advanceTimersByTimeAsync(10_000)

      let total = 0
      for (const table of tables) {
        const columns = table.rows[0].cells.length
        const count = measured.get(table)?.size ?? 0
        expect(count).toBeGreaterThan(0)
        expect(count).toBeLessThanOrEqual((SAMPLE_ROWS + WINDOW_ROWS) * columns)
        total += count
      }
      fillWindowCells.set(factor, total)
      const first = fillWindowCells.get(1)
      if (first !== undefined) expect(total).toBe(first)
    })
  },
)

// Task 733 (012-13, D-13 test B-08, job and normalize parts): the whole-document normalizer pass runs
// as the idle job `table-normalize` in slices of at most min(timeRemaining, 8) + 2 ms on the cost
// clock, and a list structure change normalizes no table. Every timer and idle callback is one task,
// run under the counters. The modules are imported again per test, so each test's fake lanes and
// clock reach every module-level registry (feed slot, scheduler, observers).
describe.each([1, 4, 16] as const)(
  'table normalize budget at factor %i (D-13 B-08)',
  { timeout: 60_000 },
  (factor: Factor) => {
    let root: HTMLElement
    let clock: ReturnType<typeof costClock>
    let lanes: ReturnType<typeof fakeLanes>
    let idles: Set<number>
    let emit: (change: UnitsChange & { scopes?: HTMLElement[] }) => void

    /** Runs the queued timers and idle callbacks one task at a time; each task's counts and ms. */
    function drainTasks(): Array<{ counts: BudgetCounts; ms: number }> {
      const tasks: Array<{ counts: BudgetCounts; ms: number }> = []
      for (let guard = 0; guard < 5000; guard++) {
        let run: (() => void) | undefined
        if (vi.getTimerCount() > 0) run = () => vi.advanceTimersToNextTimer()
        else if (idles.size > 0) run = () => lanes.runIdle(50)
        if (!run) break
        const start = clock.now()
        const { counts } = countBudget(root, run)
        tasks.push({ counts, ms: clock.now() - start })
      }
      return tasks
    }

    beforeEach(async () => {
      vi.resetModules()
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
        ],
      })
      root = irFixture(tableHeavyMarkdown(factor)).root
      const shell = document.createElement('div')
      shell.className = 'vditor'
      shell.append(root.parentElement as HTMLElement)
      document.body.replaceChildren(shell)
      clock = costClock()
      lanes = fakeLanes(clock)
      idles = new Set()
      vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
        const handle = lanes.requestIdle((deadline) => {
          idles.delete(handle)
          callback({ didTimeout: false, timeRemaining: deadline.timeRemaining })
        })
        idles.add(handle)
        return handle
      })
      vi.stubGlobal('cancelIdleCallback', (handle: number) => {
        idles.delete(handle)
        lanes.cancelIdle(handle)
      })
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
        setTimeout(() => callback(clock.now()), 16),
      )
      vi.stubGlobal('cancelAnimationFrame', (handle: number) =>
        clearTimeout(handle),
      )
      vi.spyOn(performance, 'now').mockImplementation(() => clock.now())
      // No table is on screen: the width fill never starts, so every task is normalizer work.
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          observe() {
            // Never intersecting.
          }
          unobserve() {
            // Nothing to release in the fake.
          }
          disconnect() {
            // Nothing to release in the fake.
          }
        },
      )
      const listeners = new Set<(change: UnitsChange) => void>()
      emit = (change) => {
        for (const listener of [...listeners]) listener(change)
      }
      const changes = await import('../util/unit-changes')
      changes.provideUnitFeed(window, {
        root,
        isLive: () => true,
        liveUnitOf: () => undefined,
        liveUnits: () => undefined,
        onUnitsChanged(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        confirmNow: () => true,
        confirmedLines: () => undefined,
      })
      const responsive = await import('./responsive-tables')
      responsive.fixResponsiveTables()
      await Promise.resolve()
      drainTasks()
    }, 60_000)
    afterEach(async () => {
      const changes = await import('../util/unit-changes')
      changes.provideUnitFeed(window, undefined)
      vi.useRealTimers()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }, 60_000)

    it('runs the whole-document pass of a build as idle slices of at most 8 + 2 ms', async () => {
      const tables = Array.from(
        root.querySelectorAll<HTMLElement>(':scope > table'),
      )
      for (const table of tables) table.style.removeProperty('table-layout')

      emit({ cause: 'build', whole: true, changed: [], structural: [] })
      const tasks = drainTasks()

      expect(tasks.length).toBeGreaterThan(0)
      expect(Math.max(...tasks.map((task) => task.ms))).toBeLessThanOrEqual(10)
      for (const table of tables)
        expect(table.style.getPropertyValue('table-layout')).toBe('fixed')
    })

    it('normalizes no table for a list item insert reported as list structure', async () => {
      const list = root.querySelector<HTMLElement>(':scope > ul') as HTMLElement
      const item = list.lastElementChild?.cloneNode(true) as HTMLElement
      list.append(item)
      await Promise.resolve()

      emit({
        cause: 'sync',
        whole: false,
        changed: [{ el: item, members: [item], kind: 'list-item', top: list }],
        structural: [list],
        scopes: [item],
      })
      const tasks = drainTasks()
      item.remove()

      expect(
        tasks.reduce((sum, task) => sum + task.counts.tableQueries, 0),
      ).toBe(0)
      expect(
        tasks.reduce((sum, task) => sum + task.counts.rootQueries, 0),
      ).toBe(0)
    })
  },
)

// ---- Task 733 / 013-T4: B-08 on the WYSIWYG fixture (D-13 design section 5.2; technical task 013) ----
//
// `fixResponsiveTables` over a live feed of Lute's WYSIWYG root (the table-heavy fixture). B-08: a list structure change normalizes only
// structural tables (0 for a list change) and a paragraph edit queries no table.
describe('013 B-08 fixResponsiveTables on the WYSIWYG fixture', () => {
  const feedListeners = new Set<(change: UnitsChange) => void>()
  let wysiwygFrames: FrameRequestCallback[] = []
  let stop: (() => void) | undefined
  beforeEach(() => {
    wysiwygFrames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      wysiwygFrames.push(cb)
      return wysiwygFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })
  afterEach(() => {
    stop?.()
    stop = undefined
    provideUnitFeed(window, undefined)
    feedListeners.clear()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })
  const runWysiwygFrames = (): void => {
    for (let round = 0; round < 5 && wysiwygFrames.length > 0; round++)
      for (const frame of wysiwygFrames.splice(0)) frame(0)
  }
  const settleWysiwyg = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    runWysiwygFrames()
  }
  /** The observer callbacks of the edit run; the frames they queue run inside the count. */
  const flushRecords = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
  }
  const emit = (partial: Partial<UnitsChange>): void => {
    const change = {
      cause: 'mutation',
      whole: false,
      changed: [],
      structural: [],
      ...partial,
    } as UnitsChange
    for (const listener of Array.from(feedListeners)) listener(change)
  }
  const unitOf = (
    el: HTMLElement,
    kind: LiveUnit['kind'],
    top = el,
  ): LiveUnit => ({
    el,
    members: [el],
    kind,
    top,
  })
  async function mountWysiwyg(factor: Factor) {
    const app = document.createElement('div')
    // The production mount: observers watch `#app`, so its queries count as root queries.
    app.id = 'app'
    app.className = 'vditor vditor-wysiwyg'
    const root = document.createElement('pre')
    root.className = 'vditor-reset'
    root.setAttribute('contenteditable', 'true')
    root.innerHTML = wysiwygFixture(MARKDOWN(factor)).root.innerHTML
    app.append(root)
    document.body.append(app)
    vi.stubGlobal('vditor', {
      getCurrentMode: () => 'wysiwyg',
      vditor: { currentMode: 'wysiwyg', wysiwyg: { element: root } },
    })
    const feed: UnitFeed = {
      root,
      isLive: () => true,
      liveUnitOf: () => undefined,
      liveUnits: () => [],
      onUnitsChanged: (listener) => {
        feedListeners.add(listener)
        return () => feedListeners.delete(listener)
      },
      confirmNow: () => true,
      confirmedLines: () => undefined,
    }
    provideUnitFeed(window, feed)
    fixResponsiveTables()
    await settleWysiwyg()
    return { app, root }
  }

  const MARKDOWN = (factor: Factor): string => tableHeavyMarkdown(factor)

  describe.each([1, 4, 16] as const)('at factor %i', (factor) => {
    it('a list structure change normalizes no table and queries nothing on the root', async () => {
      const { root } = await mountWysiwyg(factor)
      const list = root.querySelector(':scope > ul') as HTMLElement
      const item = list.children[2] as HTMLElement
      const added = item.cloneNode(true) as HTMLElement
      item.after(added)
      await flushRecords()
      const { counts } = countBudget(root, () => {
        emit({
          changed: [
            unitOf(item, 'list-item', list),
            unitOf(added, 'list-item', list),
          ],
          structural: [list],
          scopes: [item, added],
        } as Partial<UnitsChange>)
        runWysiwygFrames()
      })
      expect(counts.tableQueries, 'table queries').toBe(0)
      expect(counts.rootQueries, 'root queries').toBe(0)
    }, 60_000)

    it('a paragraph edit queries no table and nothing on the root', async () => {
      const { root } = await mountWysiwyg(factor)
      const paragraph = root.querySelector(':scope > p') as HTMLElement
      ;(paragraph.firstChild as Text).data += 'x'
      await flushRecords()
      const { counts } = countBudget(root, () => {
        emit({ changed: [unitOf(paragraph, 'paragraph')] })
        runWysiwygFrames()
      })
      expect(counts.tableQueries, 'table queries').toBe(0)
      expect(counts.rootQueries, 'root queries').toBe(0)
    }, 60_000)
  })
})
