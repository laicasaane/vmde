// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type LiveUnit,
  provideUnitFeed,
  type UnitFeed,
  type UnitsChange,
} from './unit-changes'
import { observeScopedMutations, scopeUnits } from './mutation-impact'
// Task 733: a fake unit feed over the IR root (`ir`); the observers under test watch the wider
// `app` that holds it, as `boot/finish-init.ts` binds them. `emit` plays one per-frame unit change.
function fakeFeed(ir: HTMLElement, live = true) {
  const listeners = new Set<(change: UnitsChange) => void>()
  const feed: UnitFeed = {
    root: ir,
    isLive: () => live,
    liveUnitOf: () => undefined,
    liveUnits: () => (live ? [] : undefined),
    onUnitsChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    confirmNow: () => live,
    confirmedLines: () => undefined,
  }
  provideUnitFeed(window, feed)
  return {
    emit(change: Partial<UnitsChange> & Pick<UnitsChange, 'whole'>) {
      const full: UnitsChange = {
        cause: 'mutation',
        changed: [],
        structural: [],
        ...change,
      }
      for (const listener of Array.from(listeners)) listener(full)
    },
  }
}

function cellUnit(cell: HTMLElement): LiveUnit {
  return {
    el: cell,
    members: [cell],
    kind: 'cell',
    top: cell.closest('table') as HTMLElement,
  }
}

// Three 2-cell tables and a paragraph: top-level `[data-block]` children of the IR root.
function irFixture(cellHtml: string, tableCount = 3) {
  const app = document.createElement('div')
  const table = (n: number) =>
    `<table data-block="${n}"><tbody><tr><td>${cellHtml}</td><td>${cellHtml}</td></tr></tbody></table>`
  app.innerHTML = `<pre class="vditor-reset" contenteditable="true">${Array.from({ length: tableCount }, (_, n) => table(n)).join('')}<p data-block="3">tail</p></pre>`
  document.body.appendChild(app)
  const ir = app.firstElementChild as HTMLElement
  const tables = Array.from(ir.querySelectorAll<HTMLElement>('table'))
  const cells = tables.map((t) => Array.from(t.querySelectorAll('td')))
  const para = ir.querySelector('p') as HTMLElement
  return { app, ir, tables, cells, para }
}

// Deterministic frames: the coalescers' leading edge is synchronous, the trailing edge waits here.
let frameCallbacks: FrameRequestCallback[] = []
const fireFrame = () => {
  const callbacks = frameCallbacks
  frameCallbacks = []
  for (const callback of callbacks) callback(0)
}
const stubFrames = () => {
  frameCallbacks = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frameCallbacks.push(cb)
    return frameCallbacks.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
}
// Lets the MutationObserver callbacks of earlier writes run.
const flushRecords = async () => {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve()
}

afterEach(() => {
  provideUnitFeed(window, undefined)
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

function change(partial: Partial<UnitsChange>): UnitsChange {
  return {
    cause: 'mutation',
    whole: false,
    changed: [],
    structural: [],
    ...partial,
  }
}

describe('scopeUnits (Task 733)', () => {
  it('returns the top-level blocks of the changed units, once each', () => {
    const { tables, cells, para } = irFixture('x')
    const scope = scopeUnits(
      change({
        changed: [
          cellUnit(cells[0][0]),
          cellUnit(cells[0][1]),
          cellUnit(cells[2][0]),
          { el: para, members: [para], kind: 'paragraph', top: para },
        ],
      }),
    )
    expect(scope.full).toBe(false)
    expect([...scope.blocks]).toEqual([tables[0], tables[2], para])
  })

  it('adds the structural tables and lists', () => {
    const { tables, cells } = irFixture('x')
    const scope = scopeUnits(
      change({ changed: [cellUnit(cells[0][0])], structural: [tables[1]] }),
    )
    expect(scope.full).toBe(false)
    expect(new Set(scope.blocks)).toEqual(new Set([tables[0], tables[1]]))
  })

  it('asks for a full walk for a whole change', () => {
    const scope = scopeUnits(change({ whole: true, cause: 'rebind' }))
    expect(scope.full).toBe(true)
  })

  it('returns no block and no full walk for a change with nothing in it', () => {
    const scope = scopeUnits(change({}))
    expect(scope.full).toBe(false)
    expect(scope.blocks.size).toBe(0)
  })

  it('never falls back to a full walk for a non-whole change with more than 6 units', () => {
    const { tables, cells } = irFixture('x', 8)
    const scope = scopeUnits(
      change({ changed: cells.map((row) => cellUnit(row[0])) }),
    )
    expect(scope.full).toBe(false)
    expect([...scope.blocks]).toEqual(tables)
  })
})

describe('observeScopedMutations on unit feed changes (Task 733)', () => {
  function setup(tableCount = 3) {
    stubFrames()
    const fixture = irFixture('x', tableCount)
    const feed = fakeFeed(fixture.ir)
    const full = vi.fn()
    const within = vi.fn()
    const dispose = observeScopedMutations(fixture.app, { full, within })
    fireFrame()
    full.mockClear()
    within.mockClear()
    return { ...fixture, feed, full, within, dispose }
  }

  it('applies the scope of a feed change and skips the records inside the feed root', async () => {
    const { tables, cells, feed, full, within, dispose } = setup()
    cells[1][0].innerHTML = '<b>y</b>'
    feed.emit({ whole: false, changed: [cellUnit(cells[1][0])] })
    expect(within).toHaveBeenCalledTimes(1)
    expect(within).toHaveBeenCalledWith(tables[1])

    await flushRecords()
    fireFrame()
    expect(within).toHaveBeenCalledTimes(1)
    expect(full).not.toHaveBeenCalled()
    dispose()
  })

  it('applies every block of a non-whole change with more than 6 units, with no full walk', () => {
    const { cells, feed, full, within, dispose } = setup(8)
    feed.emit({ whole: false, changed: cells.map((row) => cellUnit(row[0])) })
    expect(within).toHaveBeenCalledTimes(8)
    expect(full).not.toHaveBeenCalled()
    dispose()
  })

  it('runs the full pass once for a whole change', () => {
    const { app, feed, full, within, dispose } = setup()
    feed.emit({ whole: true, cause: 'rebind' })
    expect(full).toHaveBeenCalledTimes(1)
    expect(full).toHaveBeenCalledWith(app)
    expect(within).not.toHaveBeenCalled()
    dispose()
  })

  it('keeps the record scope for a record outside the feed root', async () => {
    const { app, full, dispose } = setup()
    const outside = document.createElement('div')
    app.append(outside)
    await flushRecords()
    fireFrame()
    expect(full).toHaveBeenCalled()
    dispose()
  })

  it('keeps the record scope with no feed', async () => {
    stubFrames()
    const { app, cells, tables } = irFixture('x')
    const full = vi.fn()
    const within = vi.fn()
    const dispose = observeScopedMutations(app, { full, within })
    fireFrame()
    within.mockClear()
    cells[1][0].innerHTML = '<b>y</b>'
    await flushRecords()
    fireFrame()
    expect(within).toHaveBeenCalledWith(tables[1])
    dispose()
  })
})
