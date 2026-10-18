// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  setMeasureCloneHinter,
  WRAP_HINT_REPLAN_EVENT,
} from '../util/wrap-hint-mark'
import { fixResponsiveTables } from './responsive-tables'

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
