// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type LiveUnit,
  provideUnitFeed,
  type UnitFeed,
  type UnitsChange,
} from '../util/unit-changes'
import {
  applyLinkLikeSemantics,
  observeLinkLikeSemantics,
} from './link-like-semantics'

describe('injected link-like semantics', () => {
  it('labels wiki, missing-wiki, prose code-ref, and inline-code ref shapes', () => {
    document.body.innerHTML = `
      <div id="root">
        <span data-wiki-link="1" data-wiki-target="Home">Home</span>
        <span data-wiki-link="1" data-wiki-target="Missing" data-wiki-missing="1">Missing</span>
        <span data-code-ref="1" data-code-ref-path="src/a.ts" data-code-ref-line="4" data-code-ref-col="2">src/a.ts:4:2</span>
        <code data-code-ref="1" data-code-ref-path="src/b.ts" data-code-ref-line="9">src/b.ts:9</code>
      </div>`
    const root = document.getElementById('root')!

    applyLinkLikeSemantics(root)

    const elements = root.querySelectorAll<HTMLElement>(
      '[data-wiki-link], [data-code-ref]',
    )
    expect(
      [...elements].map((element) => element.getAttribute('role')),
    ).toEqual(['link', 'link', 'link', 'link'])
    expect(
      [...elements].map((element) => element.getAttribute('aria-label')),
    ).toEqual([
      'Open wiki page Home',
      'Missing wiki page Missing',
      'Open code reference src/a.ts, line 4, column 2',
      'Open code reference src/b.ts, line 9',
    ])
  })

  it('labels a bare URL span with its href (Task 655)', () => {
    document.body.innerHTML = `
      <div id="root"><span class="vmde-bare-url" data-bare-url="1" data-bare-url-href="mailto:a@b.co">a@b.co</span></div>`
    const root = document.getElementById('root')!
    applyLinkLikeSemantics(root)
    const span = root.querySelector<HTMLElement>('[data-bare-url]')!
    expect(span.getAttribute('role')).toBe('link')
    expect(span.getAttribute('aria-label')).toBe('Open link mailto:a@b.co')
  })

  it('is idempotent and leaves ordinary prose unchanged', () => {
    document.body.innerHTML = '<p id="root">ordinary prose</p>'
    const root = document.getElementById('root')!
    applyLinkLikeSemantics(root)
    applyLinkLikeSemantics(root)
    expect(root.attributes).toHaveLength(1)
    expect(root.textContent).toBe('ordinary prose')
  })
})

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
function irFixture(cellHtml: string) {
  const app = document.createElement('div')
  const table = (n: number) =>
    `<table data-block="${n}"><tbody><tr><td>${cellHtml}</td><td>${cellHtml}</td></tr></tbody></table>`
  app.innerHTML = `<pre class="vditor-reset" contenteditable="true">${table(0)}${table(1)}${table(2)}<p data-block="3">tail</p></pre>`
  document.body.appendChild(app)
  const ir = app.firstElementChild as HTMLElement
  const tables = Array.from(ir.querySelectorAll<HTMLElement>('table'))
  const cells = tables.map((t) => Array.from(t.querySelectorAll('td')))
  const para = ir.querySelector('p') as HTMLElement
  return { app, ir, tables, cells, para }
}

// Lets the MutationObserver callbacks of earlier writes run.
const flushRecords = async () => {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve()
}

const CHIP = '<span data-wiki-link="1" data-wiki-target="A">A</span>'
const LABELLED = '[role="link"]'

afterEach(() => {
  provideUnitFeed(window, undefined)
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('observeLinkLikeSemantics on unit feed changes (Task 733)', () => {
  it('labels the chips of the changed cell only and skips its own pass for records inside the feed root', async () => {
    const { app, ir, cells } = irFixture(CHIP)
    const feed = fakeFeed(ir)
    const dispose = observeLinkLikeSemantics(app)
    // Edits to existing chips raise no child-list record: only the feed change reaches them.
    for (const cell of [cells[1][0], cells[2][0]])
      cell.querySelector('[data-wiki-link]')?.removeAttribute('role')
    const spies = [app, ir].map((el) => vi.spyOn(el, 'querySelectorAll'))

    feed.emit({ whole: false, changed: [cellUnit(cells[1][0])] })
    expect(cells[1][0].querySelector(LABELLED)).not.toBeNull()
    expect(cells[2][0].querySelector(LABELLED)).toBeNull()

    await flushRecords()
    expect(cells[2][0].querySelector(LABELLED)).toBeNull()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    dispose()
  })

  it('runs the full pass for a whole change', () => {
    const { app, ir, cells } = irFixture(CHIP)
    const feed = fakeFeed(ir)
    const dispose = observeLinkLikeSemantics(app)
    cells[1][0].innerHTML = CHIP
    cells[2][0].innerHTML = CHIP

    feed.emit({ whole: true, cause: 'rebind' })
    expect(cells[1][0].querySelector(LABELLED)).not.toBeNull()
    expect(cells[2][0].querySelector(LABELLED)).not.toBeNull()
    dispose()
  })

  it.each([
    ['no feed', () => undefined],
    ['a feed that is not live', (ir: HTMLElement) => fakeFeed(ir, false)],
  ])('keeps the full observer pass with %s', async (_name, provide) => {
    const { app, ir, cells } = irFixture(CHIP)
    provide(ir)
    const dispose = observeLinkLikeSemantics(app)
    cells[1][0].innerHTML = CHIP
    cells[2][0].innerHTML = CHIP
    await flushRecords()
    expect(cells[1][0].querySelector(LABELLED)).not.toBeNull()
    expect(cells[2][0].querySelector(LABELLED)).not.toBeNull()
    dispose()
  })

  it('labels only the container of a record outside the feed root', async () => {
    const { app, ir } = irFixture(CHIP)
    fakeFeed(ir)
    const dispose = observeLinkLikeSemantics(app)
    const outside = document.createElement('div')
    app.append(outside)
    outside.innerHTML = CHIP
    await flushRecords()
    expect(outside.querySelector(LABELLED)).not.toBeNull()
    dispose()
  })

  it('labels a chip that a decorator writes inside the feed root, with no feed change', async () => {
    const { app, ir, cells } = irFixture('x')
    fakeFeed(ir)
    const dispose = observeLinkLikeSemantics(app)
    cells[1][0].insertAdjacentHTML('beforeend', CHIP)
    await flushRecords()
    const chip = cells[1][0].querySelector<HTMLElement>('[data-wiki-link]')
    expect(chip?.getAttribute('role')).toBe('link')
    expect(chip?.getAttribute('aria-label')).toContain('wiki page')
    dispose()
  })
})
