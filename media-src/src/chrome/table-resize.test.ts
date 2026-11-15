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
import { findScroller } from './toolbar-scroll-guard'
import {
  type BudgetCounts,
  type Factor,
  costClock,
  countBudget,
  fakeLanes,
  irFixture,
  scaledFixture,
} from '../testing/budget-harness'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'

// Counts the scroller lookups (a forced layout each) and keeps the real lookup.
vi.mock('./toolbar-scroll-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./toolbar-scroll-guard')>()
  return { ...actual, findScroller: vi.fn(actual.findScroller) }
})

afterEach(() => document.body.replaceChildren())

it('clamps a dragged column to a usable width', () => {
  expect(clampTableColumnWidth(12)).toBe(48)
  expect(clampTableColumnWidth(125)).toBe(125)
})

it('keeps only session-owned col widths through responsive normalization', async () => {
  // Task 733 (012-13): the whole normalizer pass runs in budget slices on the shared scheduler
  // (`table-normalize`). On a slow real clock its first slice ran out and the rest waited for the
  // scheduler's 50 ms idle fallback timer, past this case's 40 ms waits. The clock is held still,
  // so every slice finishes its pass; the case checks the normalized result, not the slicing.
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
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
  clock.mockRestore()
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
    vi.mocked(findScroller).mockClear()
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

  /** Counts the header checks (`headerCells`) of one table: one table query each. */
  function countReconciles(table: HTMLElement): () => number {
    const original = table.querySelector.bind(table)
    let checks = 0
    vi.spyOn(table, 'querySelector').mockImplementation(((selector: string) => {
      checks++
      return original(selector)
    }) as typeof table.querySelector)
    return () => checks
  }

  // Task 733 (012-13, action 1): a structural table is reconciled alone, with no root scan.
  it('reconciles a structural table alone, with no membership scan of the root', async () => {
    const cell = document.querySelector('#ta td') as HTMLElement
    const tableA = document.getElementById('ta') as HTMLElement
    const reconciles = countReconciles(tableA)
    cell.firstChild!.textContent = 'ab'
    await Promise.resolve()
    emit(change({ changed: [cellUnit(cell)], structural: [tableA] }))
    runFrames()

    expect(membershipScans).toBe(0)
    expect(reconciles()).toBe(1)
  })

  it('reconciles a structural table, not a structural paragraph (Q-92), with no root scan', async () => {
    const para = document.getElementById('para') as HTMLElement
    const tableB = document.getElementById('tb') as HTMLElement
    const reconciles = countReconciles(tableB)
    emit(change({ structural: [para] }))
    runFrames()

    expect(membershipScans).toBe(0)
    expect(reconciles()).toBe(0)

    emit(change({ structural: [para, tableB] }))
    runFrames()

    expect(membershipScans).toBe(0)
    expect(reconciles()).toBe(1)
  })

  it('runs a membership pass for a whole change', async () => {
    emit(change({ whole: true, cause: 'rebind' }))
    runFrames()

    expect(membershipScans).toBe(1)
  })

  it('resolves the scroller once while the active root is unchanged, and again for a new root', async () => {
    const cell = document.querySelector('#ta td') as HTMLElement
    for (const text of ['ab', 'abc', 'abcd']) {
      cell.firstChild!.textContent = text
      await Promise.resolve()
      emit(change({ changed: [cellUnit(cell)] }))
      runFrames()
      window.dispatchEvent(new Event('scroll'))
      runFrames()
    }

    expect(findScroller).toHaveBeenCalledTimes(1)

    // An editor re-init gives a new root: its scroller is resolved again.
    const next = document.createElement('pre')
    next.className = 'vditor-reset'
    surface.after(next)
    vi.stubGlobal('vditor', {
      getCurrentMode: () => 'ir',
      vditor: { ir: { element: next } },
    })
    window.dispatchEvent(new Event('scroll'))
    runFrames()

    expect(findScroller).toHaveBeenCalledTimes(2)
    expect(findScroller).toHaveBeenLastCalledWith(next)
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

// Task 733 (012-13, D-13 tests B-06 and B-07): counted frame budgets of the table chrome on the
// unit feed. Each test imports the modules again after `vi.resetModules()`, so every module-level
// registry (the feed slot, the width rules, a per-window scheduler) starts empty and takes this
// test's fake frames, idle callbacks and cost clock.
type ScopedChange = UnitsChange & { readonly scopes?: readonly HTMLElement[] }

/** Lets the mutation observers take the records of the DOM writes made so far. */
const flushRecords = () => new Promise((resolve) => setTimeout(resolve, 0))

interface ChromeLanes {
  clock: ReturnType<typeof costClock>
  lanes: ReturnType<typeof fakeLanes>
}

/**
 * Mounts the fixture's `div.vditor-ir` under a new `div.vditor` editor shell in the body, as the
 * webview does: the chrome observes the shell, and its handle layer (in the body) stays outside it.
 * A new shell per test leaves the observers of an earlier test's module instance on a detached shell.
 */
function mountInEditorShell(root: HTMLElement): HTMLElement {
  for (const old of document.querySelectorAll('body > .vditor')) old.remove()
  const shell = document.createElement('div')
  shell.className = 'vditor'
  shell.append(root.parentElement as HTMLElement)
  document.body.append(shell)
  return root
}

/** Fake frames and idle callbacks on a cost clock, installed as the browser services. */
function installChromeLanes(
  charges?: Parameters<typeof costClock>[0],
): ChromeLanes {
  const clock = costClock(charges)
  const lanes = fakeLanes(clock)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    lanes.requestAnimationFrame(() => callback(clock.now())),
  )
  vi.stubGlobal('cancelAnimationFrame', (handle: number) =>
    lanes.cancelAnimationFrame(handle),
  )
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) =>
    lanes.requestIdle((deadline) =>
      callback({ didTimeout: false, timeRemaining: deadline.timeRemaining }),
    ),
  )
  vi.stubGlobal('cancelIdleCallback', (handle: number) =>
    lanes.cancelIdle(handle),
  )
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now())
  return { clock, lanes }
}

/** A frame (or idle callback) run under the counters: its counts and its cost-clock milliseconds. */
function countedTask(
  root: HTMLElement,
  { clock }: ChromeLanes,
  run: () => void,
): { counts: BudgetCounts; ms: number } {
  const start = clock.now()
  const { counts } = countBudget(root, run)
  return { counts, ms: clock.now() - start }
}

function sumCounts(tasks: Array<{ counts: BudgetCounts }>): BudgetCounts {
  const total = { ...tasks[0].counts }
  for (const { counts } of tasks.slice(1))
    for (const key of Object.keys(total) as Array<keyof BudgetCounts>)
      total[key] += counts[key]
  return total
}

/** Reports the header row of the first table under `root` as visible, every other row as hidden. */
function stubFirstTableVisible(root: () => HTMLElement): void {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        const visible =
          target.closest('table') === root().querySelector(':scope > table')
        this.callback(
          [
            {
              target,
              isIntersecting: visible,
              intersectionRect: {
                width: visible ? 10 : 0,
                height: visible ? 10 : 0,
              },
            } as unknown as IntersectionObserverEntry,
          ],
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
}

/** A laid-out surface: an 800 px viewport and 100 x 20 px boxes; the reads stay countable. */
function stubLayout(): void {
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(800)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    right: 100,
    top: 0,
    bottom: 20,
    width: 100,
    height: 20,
    x: 0,
    y: 0,
  } as DOMRect)
}

function liveFeedOn(root: HTMLElement): {
  feed: UnitFeed
  emit(change: ScopedChange): void
} {
  const listeners = new Set<(change: UnitsChange) => void>()
  return {
    emit(change) {
      for (const listener of [...listeners]) listener(change)
    },
    feed: {
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
    },
  }
}

const unitOf = (
  el: HTMLElement,
  kind: LiveUnit['kind'],
  top: HTMLElement = el,
): LiveUnit => ({ el, members: [el], kind, top })

const editChange = (partial: Partial<ScopedChange>): ScopedChange => ({
  cause: 'mutation',
  whole: false,
  changed: [],
  structural: [],
  ...partial,
})

/** The frames a change queues, each counted, until a frame queues nothing more (at most `limit`). */
function drainFrames(
  root: HTMLElement,
  lanes: ChromeLanes,
  limit = 400,
): Array<{ counts: BudgetCounts; ms: number }> {
  const frames: Array<{ counts: BudgetCounts; ms: number }> = []
  for (let index = 0; index < limit; index++) {
    let queued = false
    const original = lanes.lanes.requestAnimationFrame
    lanes.lanes.requestAnimationFrame = (callback) => {
      queued = true
      return original(callback)
    }
    try {
      frames.push(countedTask(root, lanes, () => lanes.lanes.runFrame()))
    } finally {
      lanes.lanes.requestAnimationFrame = original
    }
    if (!queued) break
  }
  return frames
}

describe.each([1, 4, 16] as const)(
  'table resize frame budget at factor %i (D-13 B-06)',
  { timeout: 60_000 },
  (factor: Factor) => {
    let root: HTMLElement
    let lanes: ChromeLanes
    let emit: (change: ScopedChange) => void
    let dispose: () => void

    const firstParagraph = () =>
      root.querySelector<HTMLElement>(':scope > p') as HTMLElement
    const tables = () =>
      Array.from(root.querySelectorAll<HTMLTableElement>(':scope > table'))

    beforeEach(async () => {
      vi.resetModules()
      root = mountInEditorShell(irFixture(tableHeavyMarkdown(factor)).root)
      // Layout reads are asserted as counts (`layoutReads`); charging them nothing leaves the
      // slice milliseconds to the membership work the table-membership job slices.
      lanes = installChromeLanes({ layoutReadMs: 0 })
      stubFirstTableVisible(() => root)
      stubLayout()
      vi.stubGlobal('vditor', {
        getCurrentMode: () => 'ir',
        vditor: { ir: { element: root } },
      })
      const changes = await import('../util/unit-changes')
      const live = liveFeedOn(root)
      emit = live.emit
      changes.provideUnitFeed(window, live.feed)
      const resize = await import('./table-resize')
      dispose = resize.installTableColumnResize()
      // Open: the membership pass, as many frames as it takes, and the records it caused.
      drainFrames(root, lanes)
      await flushRecords()
      drainFrames(root, lanes)
    }, 60_000)
    afterEach(async () => {
      dispose()
      const changes = await import('../util/unit-changes')
      changes.provideUnitFeed(window, undefined)
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }, 60_000)

    it('reads no table and no root after a paragraph change', async () => {
      const paragraph = firstParagraph()
      paragraph.firstChild!.textContent = `edited ${factor}`
      await flushRecords()
      emit(editChange({ changed: [unitOf(paragraph, 'paragraph')] }))
      const frames = drainFrames(root, lanes)
      const total = sumCounts(frames)

      // `tableQueries` is one per `headerCells` call (its nested-table and span check).
      expect(total.tableQueries).toBe(0)
      expect(total.rootQueries).toBe(0)
      expect(total.layoutReads).toBeLessThanOrEqual(1)
    })

    it('reads only the handle cells of the visible changed table after a cell change', async () => {
      const table = tables()[0]
      const cell = table.tBodies[0].rows[1].cells[1] as HTMLElement
      cell.firstChild!.textContent = `cell ${factor}`
      await flushRecords()
      emit(editChange({ changed: [unitOf(cell, 'cell', table)] }))
      const frames = drainFrames(root, lanes)
      const total = sumCounts(frames)
      const handleCells = table.rows[0].cells.length

      expect(total.tableQueries).toBe(0)
      expect(total.rootQueries).toBe(0)
      expect(total.layoutReads).toBeLessThanOrEqual(1 + handleCells)
    })

    it('reconciles only the table of an inserted row', async () => {
      const table = tables()[1]
      const body = table.tBodies[0]
      const row = body.rows[0].cloneNode(true) as HTMLTableRowElement
      body.append(row)
      await flushRecords()
      emit(
        editChange({
          cause: 'sync',
          changed: Array.from(row.cells, (cell) =>
            unitOf(cell as HTMLElement, 'cell', table),
          ),
          structural: [table],
          scopes: [row],
        }),
      )
      const total = sumCounts(drainFrames(root, lanes))
      row.remove()

      expect(total.tableQueries).toBe(1)
      expect(total.rootQueries).toBe(0)
    })

    it('runs a whole change as frame slices of at most 4 + 2 ms', async () => {
      emit(editChange({ cause: 'rebind', whole: true }))
      const frames = drainFrames(root, lanes)

      expect(frames.length).toBeGreaterThan(0)
      expect(Math.max(...frames.map((frame) => frame.ms))).toBeLessThanOrEqual(
        6,
      )
      expect(
        document.querySelectorAll('.vmde-table-resize-handle').length,
      ).toBe(
        tables().reduce((sum, table) => sum + table.rows[0].cells.length, 0),
      )
    })
  },
)

describe('table resize on 200 tables (D-13 B-06, task 012-13 action 4)', {
  timeout: 60_000,
}, () => {
  const TABLES = 200
  let root: HTMLElement
  let lanes: ChromeLanes
  let emit: (change: ScopedChange) => void
  let dispose: () => void

  beforeEach(async () => {
    vi.resetModules()
    root = mountInEditorShell(
      scaledFixture({ tables: TABLES, rows: 20, listItems: 4, paragraphs: 3 }),
    )
    // A child walk costs 0.01 ms here, so one frame cannot reconcile 200 tables within its slice;
    // layout reads are counted, not charged (see the factor tests).
    lanes = installChromeLanes({ nodeMs: 0.01, layoutReadMs: 0 })
    stubFirstTableVisible(() => root)
    stubLayout()
    vi.stubGlobal('vditor', {
      getCurrentMode: () => 'ir',
      vditor: { ir: { element: root } },
    })
    const changes = await import('../util/unit-changes')
    const live = liveFeedOn(root)
    emit = live.emit
    changes.provideUnitFeed(window, live.feed)
    const resize = await import('./table-resize')
    dispose = resize.installTableColumnResize()
    drainFrames(root, lanes)
    await flushRecords()
    drainFrames(root, lanes)
  }, 60_000)
  afterEach(async () => {
    dispose()
    const changes = await import('../util/unit-changes')
    changes.provideUnitFeed(window, undefined)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  }, 60_000)

  it('calls headerCells 0 times in the frame after a paragraph edit', async () => {
    const paragraph = root.querySelector<HTMLElement>(':scope > p')!
    const next = paragraph.cloneNode(true) as HTMLElement
    next.textContent = 'edited paragraph'
    paragraph.replaceWith(next)
    await flushRecords()
    emit(
      editChange({
        changed: [unitOf(next, 'paragraph')],
        structural: [next],
        scopes: [next],
      }),
    )
    const total = sumCounts(drainFrames(root, lanes))

    expect(total.tableQueries).toBe(0)
    expect(total.rootQueries).toBe(0)
  })

  it('reconciles one table for a row insert, not 200', async () => {
    const table = root.querySelectorAll<HTMLTableElement>(':scope > table')[57]
    const row = table.tBodies[0].rows[0].cloneNode(true) as HTMLTableRowElement
    table.tBodies[0].append(row)
    await flushRecords()
    emit(
      editChange({
        cause: 'sync',
        changed: [unitOf(row.cells[0] as HTMLElement, 'cell', table)],
        structural: [table],
        scopes: [row],
      }),
    )
    const total = sumCounts(drainFrames(root, lanes))

    expect(total.tableQueries).toBe(1)
  })

  it('reconciles a whole change as the table-membership job in slices of at most 4 + 2 ms', async () => {
    emit(editChange({ cause: 'rebind', whole: true }))
    const frames = drainFrames(root, lanes)

    expect(frames.length).toBeGreaterThan(1)
    expect(Math.max(...frames.map((frame) => frame.ms))).toBeLessThanOrEqual(6)
    expect(document.querySelectorAll('.vmde-table-resize-handle').length).toBe(
      TABLES * 5,
    )
  })
})

describe('persistent measurement host (D-13 B-07, M4)', {
  timeout: 120_000,
}, () => {
  const SLICES = 100
  let root: HTMLElement
  let lanes: ChromeLanes

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
    root = mountInEditorShell(irFixture(tableHeavyMarkdown(16)).root)
    lanes = installChromeLanes()
    stubFirstTableVisible(() => root)
    stubLayout()
    const changes = await import('../util/unit-changes')
    changes.provideUnitFeed(window, liveFeedOn(root).feed)
    const responsive = await import('./responsive-tables')
    responsive.fixResponsiveTables()
    // The first pass and the typing pause before the first fill slice.
    await vi.advanceTimersByTimeAsync(700)
  }, 60_000)
  afterEach(async () => {
    const changes = await import('../util/unit-changes')
    changes.provideUnitFeed(window, undefined)
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.className = ''
  }, 60_000)

  /** One idle slice of 50 ms and the timers it queued, counted together. */
  async function fillSlice(): Promise<BudgetCounts> {
    const slice = countedTask(root, lanes, () => lanes.lanes.runIdle(50))
    await vi.advanceTimersByTimeAsync(60)
    return slice.counts
  }

  it('inserts at most one stylesheet over 100 fill slices', async () => {
    let styleInsertions = 0
    for (let slice = 0; slice < SLICES; slice++)
      styleInsertions += (await fillSlice()).styleInsertions

    expect(styleInsertions).toBeLessThanOrEqual(1)
  })

  it('copies the root class into the host at the next slice start', async () => {
    for (let slice = 0; slice < 3; slice++) await fillSlice()
    const shell = document.querySelector<HTMLElement>('.vditor') as HTMLElement
    shell.className = 'vditor vscode-dark vmde-theme-changed'
    await fillSlice()
    const host = document.querySelector<HTMLElement>('[data-vmde-measure]')

    expect(host).not.toBeNull()
    expect(host?.className).toBe(shell.className)
  })
})
