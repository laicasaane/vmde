// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type LiveUnit,
  provideUnitFeed,
  type UnitFeed,
  type UnitsChange,
} from './unit-changes'
import { countBudget, scaledFixture } from '../testing/budget-harness'
import * as mutationImpact from './mutation-impact'
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

// ---- Task 733 / 012-19, B-02 (D-13 design sections 1.2 and 5.2): change scopes ----
//
// The helpers and the `scopes` field are added by 012-19-I. They are read through this interface so
// the file typechecks before they exist; until then each case fails for the missing helper.

type ScopedChange = UnitsChange & { readonly scopes?: readonly HTMLElement[] }
interface ScopeHelpers {
  forEachChangeScope(
    change: ScopedChange,
    visit: (element: HTMLElement) => void,
  ): void
  scopeOfChange(change: ScopedChange): { full: boolean; blocks: Set<Element> }
  provisionalScopeOf(root: HTMLElement, node: Node): HTMLElement | undefined
  observeScopedMutations(
    editorEl: HTMLElement,
    apply: {
      full: (editorEl: HTMLElement) => void
      within: (block: Element) => void
    },
    options?: { scope?: 'unit' | 'top' },
  ): () => void
}
const helpers = mutationImpact as unknown as ScopeHelpers

/** The B-02 document: a 500-item list and 2 tables of 2,080 rows, without Lute. */
function b02Fixture() {
  const root = scaledFixture({
    tables: 2,
    rows: 2080,
    listItems: 500,
    paragraphs: 2,
  })
  const list = root.querySelector(':scope > ul') as HTMLElement
  const items = Array.from(list.children) as HTMLElement[]
  const tables = Array.from(
    root.querySelectorAll<HTMLElement>(':scope > table'),
  )
  const cell = tables[1].querySelector(
    'tbody tr:nth-child(700) td:nth-child(3)',
  ) as HTMLElement
  const paragraph = root.querySelector(':scope > p') as HTMLElement
  return { root, list, items, tables, cell, paragraph }
}

const itemUnit = (item: HTMLElement): LiveUnit => ({
  el: item,
  members: [item],
  kind: 'list-item',
  top: item.parentElement as HTMLElement,
})

function scopedChange(partial: Partial<ScopedChange>): ScopedChange {
  return change(partial) as ScopedChange
}

describe('B-02 forEachChangeScope and scopeOfChange (012-19)', () => {
  it('visits the scopes of a list item Enter only, never the list, with no root query', () => {
    const { root, list, items } = b02Fixture()
    const pair = [items[200], items[201]]
    const enter = scopedChange({
      changed: [itemUnit(items[200])],
      structural: [list],
      scopes: pair,
    })
    const visited: HTMLElement[] = []
    const { counts } = countBudget(root, () =>
      helpers.forEachChangeScope(enter, (element) => visited.push(element)),
    )
    expect(visited).toEqual(pair)
    expect(counts.rootQueries).toBe(0)
    expect(counts.queriedNodes).toBe(0)
    expect(counts.nodesWalked).toBe(0)
  })

  it('falls back to forEachScopeElement when the change carries no scopes', () => {
    const { tables, cell, paragraph } = b02Fixture()
    const legacy = scopedChange({
      changed: [
        cellUnit(cell),
        {
          el: paragraph,
          members: [paragraph],
          kind: 'paragraph',
          top: paragraph,
        },
      ],
      structural: [tables[0]],
    })
    const visited: HTMLElement[] = []
    helpers.forEachChangeScope(legacy, (element) => visited.push(element))
    const expected: HTMLElement[] = []
    mutationImpact.forEachScopeElement(legacy, (element) =>
      expected.push(element),
    )
    expect(visited).toEqual(expected)
  })

  it('gives the scope elements as blocks, not their tables or lists', () => {
    const { root, items, cell } = b02Fixture()
    const edit = scopedChange({
      changed: [cellUnit(cell), itemUnit(items[3])],
      scopes: [items[3], cell],
    })
    const { result: scope, counts } = countBudget(root, () =>
      helpers.scopeOfChange(edit),
    )
    expect(scope.full).toBe(false)
    expect([...scope.blocks]).toEqual([items[3], cell])
    expect(counts.rootQueries).toBe(0)
  })

  it('never yields a full walk for a non-whole change, however many scopes it holds', () => {
    const { items } = b02Fixture()
    const many = scopedChange({
      changed: items.slice(0, 100).map(itemUnit),
      scopes: items.slice(0, 100),
    })
    const scope = helpers.scopeOfChange(many)
    expect(scope.full).toBe(false)
    expect(scope.blocks.size).toBe(100)
  })

  it('asks for a full walk for a whole change', () => {
    expect(
      helpers.scopeOfChange(
        scopedChange({ whole: true, cause: 'rebind', scopes: [] }),
      ).full,
    ).toBe(true)
  })
})

describe('B-02 provisionalScopeOf (012-19)', () => {
  it('returns the cell, the list item or the top-level block that holds a node', () => {
    const { root, items, cell, paragraph, tables } = b02Fixture()
    const { result, counts } = countBudget(root, () => ({
      inCell: helpers.provisionalScopeOf(root, cell.firstChild as Node),
      cell: helpers.provisionalScopeOf(root, cell),
      inItem: helpers.provisionalScopeOf(root, items[450].firstChild as Node),
      inParagraph: helpers.provisionalScopeOf(
        root,
        paragraph.firstChild as Node,
      ),
      table: helpers.provisionalScopeOf(root, tables[0]),
      root: helpers.provisionalScopeOf(root, root),
    }))
    expect(result.inCell).toBe(cell)
    expect(result.cell).toBe(cell)
    expect(result.inItem).toBe(items[450])
    expect(result.inParagraph).toBe(paragraph)
    expect(result.table).toBe(tables[0])
    expect(result.root).toBeUndefined()
    expect(counts.rootQueries).toBe(0)
    expect(counts.queriedNodes).toBe(0)
  })

  it('scopes a node in a new, not yet mapped list item to that item', () => {
    const { root, list, items } = b02Fixture()
    const fresh = document.createElement('li')
    fresh.innerHTML = '<strong>new</strong>'
    items[10].after(fresh)
    const node = (fresh.firstChild as Element).firstChild as Node
    expect(helpers.provisionalScopeOf(root, node)).toBe(fresh)
    expect(fresh.parentElement).toBe(list)
  })
})

describe('B-02 observeScopedMutations with { scope } (012-19)', () => {
  function setupList(scope?: 'unit' | 'top') {
    stubFrames()
    const fixture = b02Fixture()
    const app = fixture.root.parentElement as HTMLElement
    const feed = fakeFeed(fixture.root)
    const full = vi.fn()
    const within = vi.fn()
    const dispose = helpers.observeScopedMutations(
      app,
      { full, within },
      scope ? { scope } : undefined,
    )
    fireFrame()
    full.mockClear()
    within.mockClear()
    return { ...fixture, feed, full, within, dispose }
  }

  it("applies the change scopes with { scope: 'unit' }", () => {
    const { items, list, feed, full, within, dispose } = setupList('unit')
    feed.emit({
      cause: 'mutation',
      whole: false,
      changed: [itemUnit(items[5])],
      structural: [list],
      scopes: [items[5], items[6]],
    } as ScopedChange)
    expect(within.mock.calls.map(([block]) => block)).toEqual([
      items[5],
      items[6],
    ])
    expect(full).not.toHaveBeenCalled()
    dispose()
  })

  it('keeps the top-level blocks by default', () => {
    const { items, list, feed, full, within, dispose } = setupList()
    feed.emit({
      cause: 'mutation',
      whole: false,
      changed: [itemUnit(items[5])],
      structural: [list],
      scopes: [items[5], items[6]],
    } as ScopedChange)
    expect(within.mock.calls.map(([block]) => block)).toEqual([list])
    expect(full).not.toHaveBeenCalled()
    dispose()
  })
})
