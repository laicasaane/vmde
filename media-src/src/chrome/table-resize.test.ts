// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  provideUnitFeed,
  type LiveUnit,
  type UnitFeed,
  type UnitsChange,
} from '../util/unit-changes'
import {
  clampTableColumnWidth,
  installTableColumnResize,
  setSessionTableWidths,
  sessionTableWidths,
  tableResizeHandleLayout,
} from './table-resize'
import { fixResponsiveTables } from './responsive-tables'

afterEach(() => document.body.replaceChildren())

it('clamps a dragged column to a usable width', () => {
  expect(clampTableColumnWidth(12)).toBe(48)
  expect(clampTableColumnWidth(125)).toBe(125)
})

it('keeps only session-owned col widths through responsive normalization', async () => {
  document.body.innerHTML = `<div class="vditor"><pre class="vditor-reset">
    <table id="resized"><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>
    <table id="ordinary"><colgroup><col style="width:300px"></colgroup><thead><tr><th>C</th></tr></thead></table>
  </pre></div>`
  const resized = document.getElementById('resized') as HTMLTableElement
  const ordinary = document.getElementById('ordinary') as HTMLTableElement
  setSessionTableWidths(resized, [120, 80])
  fixResponsiveTables()
  await new Promise((resolve) => setTimeout(resolve, 40))
  window.dispatchEvent(new Event('resize'))
  await new Promise((resolve) => setTimeout(resolve, 40))

  expect(sessionTableWidths(resized)).toEqual([120, 80])
  expect(resized.querySelector('colgroup')).toBeNull()
  expect(document.head.textContent).toContain('width: 120px !important')
  expect(document.head.textContent).toContain('width: 80px !important')
  expect(ordinary.querySelector('col')?.style.width).toBe('')
})

it('clips visible resize handles to the editor and nested horizontal scrollports', () => {
  const cell = { left: 20, right: 120, top: 20, bottom: 40 }
  expect(
    tableResizeHandleLayout(cell, {
      left: 0,
      right: 200,
      top: 0,
      bottom: 100,
    }),
  ).toEqual({ left: 116, top: 20, height: 20, visible: true })
  expect(
    tableResizeHandleLayout(cell, {
      left: 0,
      right: 100,
      top: 0,
      bottom: 100,
    }).visible,
  ).toBe(false)
  expect(
    tableResizeHandleLayout(
      { left: 20, right: 120, top: -5, bottom: 15 },
      { left: 0, right: 200, top: 0, bottom: 10 },
    ),
  ).toEqual({ left: 116, top: 0, height: 10, visible: true })
})

describe('table resize on the unit feed (Task 733 007)', () => {
  let emit: (change: UnitsChange) => void
  let surface: HTMLElement
  let frames: FrameRequestCallback[]
  let dispose: () => void
  let membershipScans: number
  let measuredTables: Set<string>

  const table = (id: string) =>
    `<table id="${id}"><thead><tr><th>k</th><th>v</th></tr></thead><tbody><tr><td>${id}-a</td><td>${id}-b</td></tr></tbody></table>`

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

  function fakeFeed(root: HTMLElement): UnitFeed {
    const listeners = new Set<(change: UnitsChange) => void>()
    emit = (next) => {
      for (const listener of listeners) listener(next)
    }
    return {
      root,
      isLive: () => true,
      liveUnitOf: () => undefined,
      // The observer path asks `isLive()`; building the unit list per record would be O(document).
      liveUnits: () => {
        throw new Error('liveUnits must not be read on the observer path')
      },
      onUnitsChanged(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      confirmNow: () => true,
      confirmedLines: () => undefined,
    }
  }

  /** Runs every queued animation frame, including frames that the callbacks queue. */
  function runFrames(): void {
    for (let round = 0; round < 5 && frames.length > 0; round++)
      for (const frame of frames.splice(0)) frame(performance.now())
  }

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    class FakeObserver {
      constructor(private readonly cb: (entries: never[]) => void) {}
      observe(target: Element) {
        if (this.cb.length === 0) return
        ;(this.cb as unknown as (entries: unknown[]) => void)([
          {
            target,
            isIntersecting: true,
            intersectionRect: { width: 10, height: 10 },
          },
        ])
      }
      unobserve() {
        // Nothing to release in the fake.
      }
      disconnect() {
        // Nothing to release in the fake.
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {
          // Nothing to observe in the fake.
        }
        unobserve() {
          // Nothing to release in the fake.
        }
        disconnect() {
          // Nothing to release in the fake.
        }
      },
    )
    document.body.innerHTML = `<div class="vditor"><pre class="vditor-reset" id="ir">${table('ta')}${table('tb')}<p id="para">text</p></pre></div>`
    surface = document.getElementById('ir') as HTMLElement
    for (const property of ['clientWidth', 'clientHeight'])
      Object.defineProperty(document.documentElement, property, {
        configurable: true,
        value: 800,
      })
    vi.stubGlobal('vditor', {
      getCurrentMode: () => 'ir',
      vditor: { ir: { element: surface } },
    })
    measuredTables = new Set()
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        const owner = this.closest('table')
        if (owner && this.tagName !== 'TABLE') measuredTables.add(owner.id)
        return {
          left: 0,
          right: 100,
          top: 0,
          bottom: 20,
          width: 100,
          height: 20,
        } as DOMRect
      },
    )
    provideUnitFeed(window, fakeFeed(surface))
    dispose = installTableColumnResize()
    runFrames()
    // Baseline: the first frame reconciled membership; count from here.
    membershipScans = 0
    measuredTables.clear()
    const original = surface.querySelectorAll.bind(surface)
    vi.spyOn(surface, 'querySelectorAll').mockImplementation(((
      selector: string,
    ) => {
      if (selector === 'table') membershipScans++
      return original(selector)
    }) as typeof surface.querySelectorAll)
  })
  afterEach(() => {
    dispose()
    provideUnitFeed(window, undefined)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('measures geometry for the table of a changed cell only and runs no membership pass', async () => {
    const cell = document.querySelector('#ta td') as HTMLElement
    cell.firstChild!.textContent = 'ab'
    await Promise.resolve()
    emit(change({ changed: [cellUnit(cell)] }))
    runFrames()

    expect(membershipScans).toBe(0)
    expect([...measuredTables]).toEqual(['ta'])
  })

  it('runs a membership pass for a structural table', async () => {
    const cell = document.querySelector('#ta td') as HTMLElement
    const tableA = document.getElementById('ta') as HTMLElement
    cell.firstChild!.textContent = 'ab'
    await Promise.resolve()
    emit(change({ changed: [cellUnit(cell)], structural: [tableA] }))
    runFrames()

    expect(membershipScans).toBe(1)
  })

  it('runs a membership pass for a whole change', async () => {
    emit(change({ whole: true, cause: 'rebind' }))
    runFrames()

    expect(membershipScans).toBe(1)
  })

  it('schedules nothing for a class toggle by a decorator outside a table', async () => {
    document.getElementById('para')!.classList.add('vmde-caret-inside')
    await Promise.resolve()
    emit(change({}))
    runFrames()

    expect(membershipScans).toBe(0)
    expect(measuredTables.size).toBe(0)
  })
})
