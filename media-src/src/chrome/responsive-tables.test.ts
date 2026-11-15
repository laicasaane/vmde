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
        return { width: this.tagName === 'TABLE' ? 400 : 50 } as DOMRect
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

  it('first measures a bounded row count, clones the table at most once, and still finds the widest row', async () => {
    fixResponsiveTables()
    await settle()

    expect(largestLayout).toBeGreaterThan(0)
    expect(largestLayout).toBeLessThanOrEqual(CLONE_ROW_BOUND)
    expect(tableClones).toBeLessThanOrEqual(1)
    // The widest cell sits far below the measured rows; the remaining rows are measured later.
    expect(storedWidth(1)).toBeGreaterThan(storedWidth(2))
  })

  it('measures at most one cell when the cell that held the column maximum shrinks', async () => {
    fixResponsiveTables()
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
  /** Store cells of the table: every row (head included) times two columns. */
  const STORE_CELLS = (BODY_ROWS + 1) * 2

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
    // The cells a slice left were measured by later slices, each once.
    expect(cellCopies.size).toBe(STORE_CELLS)
    expect(repeatedCells()).toBe(0)
    expect(storedWidth(1)).toBeGreaterThan(storedWidth(2))
  })

  // Research question 1 of the 012-M2 re-measurement: a paragraph edit outside the table, reported
  // scoped or whole by the feed, neither measures the table again nor starts its fill over.
  it.each(['scoped', 'whole'] as const)(
    'keeps the fill queue across a %s paragraph edit outside the table',
    async (form) => {
      useCostedSlices()
      fixResponsiveTables()
      for (let step = 0; step < 1000 && cellCopies.size < 200; step++)
        await vi.advanceTimersByTimeAsync(1)
      expect(cellCopies.size).toBeGreaterThan(0)
      expect(cellCopies.size).toBeLessThan(STORE_CELLS)
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
      expect(cellCopies.size).toBe(STORE_CELLS)
      expect(repeatedCells()).toBe(0)
    },
  )
})

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
