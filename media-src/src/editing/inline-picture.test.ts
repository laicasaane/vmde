// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'

// Task 630: the dialog's captured source coordinate is a rendered-text offset; the test fixes it.
const cursor = vi.hoisted(() => ({ offset: -1 }))
vi.mock('../util/source-map', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../util/source-map')>()),
  getCursorSourceOffset: () => cursor.offset,
}))
vi.mock('./caret', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./caret')>()),
  requestCaret: vi.fn(),
}))

import {
  buildInlinePictureMarkup,
  configureInlinePictureInsertion,
  installInlinePictureInsertion,
  observeInlinePictures,
  planInlinePictureInsertion,
} from './inline-picture'
import {
  type LiveUnit,
  provideUnitFeed,
  type UnitFeed,
  type UnitsChange,
} from '../util/unit-changes'
import {
  type BudgetCounts,
  countBudget,
  type Factor,
  irFixture,
  wysiwygFixture,
} from '../testing/budget-harness'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'

function root(html: string) {
  document.body.innerHTML = `<div id="root">${html}</div>`
  return document.querySelector<HTMLElement>('#root')!
}

afterEach(() => {
  provideUnitFeed(window, undefined)
  document.body.replaceChildren()
})

describe('inline PICTURE source insertion', () => {
  it('generates ordered dark/light sources with escaped source-faithful attributes', () => {
    expect(
      buildInlinePictureMarkup({
        fallback: 'assets/light image.png?one=1&two=2',
        alt: 'A "bright" <example>',
        dark: 'https://cdn.example.test/dark.webp',
        light: './light.png',
      }),
    ).toBe(
      '<picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.example.test/dark.webp"><source media="(prefers-color-scheme: light)" srcset="./light.png"><img src="assets/light image.png?one=1&amp;two=2" alt="A &quot;bright&quot; &lt;example&gt;"></picture>',
    )
  })

  it('rejects missing fallback and non-raster or unsafe image locations', () => {
    for (const input of [
      { fallback: '', alt: '', dark: '', light: '' },
      { fallback: 'photo.svg', alt: '', dark: '', light: '' },
      { fallback: 'javascript:alert(1).png', alt: '', dark: '', light: '' },
      {
        fallback: 'https://example.test/photo.png',
        alt: '',
        dark: 'data:image/png;base64,x',
        light: '',
      },
    ])
      expect(buildInlinePictureMarkup(input)).toBeNull()
  })

  it('splices exactly one generated PICTURE into the canonical source without changing CRLF bytes', () => {
    expect(
      planInlinePictureInsertion('before\r\nafter\r\n', 8, {
        fallback: 'light.png',
        alt: 'Light',
        dark: '',
        light: '',
      }),
    ).toEqual({
      markdown:
        'before\r\n<picture><img src="light.png" alt="Light"></picture>after\r\n',
      caret: 60,
    })
  })
})

describe('inline PICTURE reader', () => {
  it('replaces one safe marker sequence with a Lute-invisible picture and leaves authored source markers intact', () => {
    const app = root(
      '<p>Text <span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;source media="(prefers-color-scheme: dark)" srcset="dark.png"&gt;</span><span data-type="html-inline">&lt;img src="light.png" alt="Example"&gt;</span><span data-type="html-inline">&lt;/picture&gt;</span> text.</p>',
    )
    const dispose = observeInlinePictures(app)
    const preview = app.querySelector<HTMLElement>(
      'picture[data-vmde-inline-picture="1"]',
    )!

    expect(preview.getAttribute('data-render')).toBe('1')
    expect(preview.getAttribute('contenteditable')).toBe('false')
    expect(preview.querySelector('source')?.getAttribute('srcset')).toBe(
      'dark.png',
    )
    expect(preview.querySelector('img')?.getAttribute('src')).toBe('light.png')
    expect(preview.querySelector('img')?.getAttribute('alt')).toBe('Example')
    expect(
      Array.from(app.querySelectorAll('[data-type="html-inline"]')).every(
        (marker) => (marker as HTMLElement).style.display === 'none',
      ),
    ).toBe(true)
    expect(app.textContent).toContain('<picture>')
    expect(app.textContent).toContain('light.png')
    dispose()
  })

  it('reveals the original markup on pointer entry and restores the render after focus leaves', () => {
    const app = root(
      '<p>x<span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;img src="photo.png" alt="Photo"&gt;</span><span data-type="html-inline">&lt;/picture&gt;</span>y</p>',
    )
    const dispose = observeInlinePictures(app)
    const preview = app.querySelector<HTMLElement>(
      '[data-vmde-inline-picture]',
    )!
    preview.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
    )

    expect(app.querySelector('[data-vmde-inline-picture]')).toBeNull()
    expect(
      Array.from(app.querySelectorAll('[data-type="html-inline"]')).every(
        (marker) => (marker as HTMLElement).style.display === '',
      ),
    ).toBe(true)

    const outside = document.createElement('p')
    outside.textContent = 'outside'
    app.append(outside)
    const range = document.createRange()
    range.setStart(outside.firstChild!, 0)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))

    expect(app.querySelector('[data-vmde-inline-picture]')).not.toBeNull()
    dispose()
  })

  it('fails closed for malformed, unsafe, and literal-code marker sequences', () => {
    const app = root(
      '<p><span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;img src="vector.svg" alt="Vector"&gt;</span><span data-type="html-inline">&lt;/picture&gt;</span></p><p><span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;img src="photo.png" alt="Photo"&gt;</span></p><pre><code><span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;img src="photo.png" alt="Photo"&gt;</span><span data-type="html-inline">&lt;/picture&gt;</span></code></pre>',
    )
    const dispose = observeInlinePictures(app)
    expect(app.querySelector('[data-vmde-inline-picture]')).toBeNull()
    dispose()
  })
})

// Task 630 S1 (RED): the dialog acquires exact authority on submit, plans on the acquired exact
// text and posts with a rollback. The module has no acquire seam yet, so `acquireExactAuthority` and
// `postExact(markdown, opts)` are declared here and cast onto the product type.
interface ExactEdit {
  rollback?: { restore(): void }
  before?: string
}
type AcquiredPair = { exact: string; rendered: string }
type ExactDeps = Parameters<typeof configureInlinePictureInsertion>[0] & {
  acquireExactAuthority(): Promise<AcquiredPair | null>
  postExact(markdown: string, opts?: ExactEdit): void
}

// Extra blank lines normalize away, so a rendered offset differs from the host offset.
const HOST_EXACT = 'Alpha\n\n\n\nBeta paragraph\n\n* * *\n\nGamma\n'
const RENDERED = 'Alpha\n\nBeta paragraph\n\n---\n\nGamma\n'
const PICTURE = '<picture><img src="light.png" alt="Light"></picture>'

function pictureHarness(acquire: () => Promise<AcquiredPair | null>) {
  document.body.innerHTML = '<div class="vditor-ir"><p>Alpha</p></div>'
  const editor = document.querySelector<HTMLElement>('.vditor-ir')!
  const host = { text: HOST_EXACT, owned: null as string | null, restored: 0 }
  let shown = RENDERED
  const setValue = vi.fn((value: string) => {
    shown = value
  })
  const inner = {
    currentMode: 'ir',
    ir: { element: editor },
    undo: { addToUndoStack: vi.fn() },
    toolbar: { elements: {} },
  }
  ;(window as any).vditor = {
    getCurrentMode: () => 'ir',
    getValue: () => shown,
    setValue,
    focus: () => undefined,
    insertValue: vi.fn(),
    vditor: inner,
  }
  const acquireExactAuthority = vi.fn(acquire)
  const postExact = vi.fn((markdown: string, opts?: ExactEdit) => {
    const before = opts?.before ?? host.owned
    if (before !== host.text) {
      shown = host.text
      opts?.rollback?.restore()
      host.restored++
      return
    }
    host.text = markdown
    host.owned = markdown
  })
  configureInlinePictureInsertion({
    setApplying: vi.fn(),
    postExact,
    snapshotMarkdown: () => RENDERED,
    acquireExactAuthority,
    onError: (error) => {
      throw error
    },
  } as ExactDeps)
  cursor.offset = RENDERED.indexOf('Gamma')
  const dispose = installInlinePictureInsertion()
  const submit = async () => {
    document.dispatchEvent(new Event('vmde-insert-picture'))
    const dialog = document.querySelector<HTMLFormElement>(
      '[data-vmde-picture-dialog]',
    )!
    ;(dialog.elements.namedItem('fallback') as HTMLInputElement).value =
      'light.png'
    ;(dialog.elements.namedItem('alt') as HTMLInputElement).value = 'Light'
    dialog.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
    // The delayed acquire case resolves on a timer, so settle past one macrotask too.
    await new Promise((done) => setTimeout(done, 10))
    for (let turn = 0; turn < 10; turn++) await Promise.resolve()
  }
  return {
    host,
    shown: () => shown,
    setValue,
    acquireExactAuthority,
    postExact,
    submit,
    dispose,
  }
}

describe('inline PICTURE exact authority (Task 630)', () => {
  it.each([
    ['after a trusted edit (host round trip)', true],
    ['on a fresh document (owned pair)', false],
  ] as const)(
    'Insert Picture %s acquires on submit and splices into the acquired exact text',
    async (_name, delayed) => {
      const h = pictureHarness(async () => {
        if (delayed) await new Promise((done) => setTimeout(done, 1))
        h.host.owned = h.host.text
        return { exact: h.host.text, rendered: h.shown() }
      })
      await h.submit()

      expect(h.acquireExactAuthority).toHaveBeenCalledOnce()
      expect(h.postExact).toHaveBeenCalledOnce()
      expect(h.postExact.mock.calls[0][1]).toEqual({
        rollback: { restore: expect.any(Function) },
      })
      // The picture lands at the mapped host offset; every other byte stays the host's.
      expect(h.host.text).toBe(HOST_EXACT.replace('Gamma', `${PICTURE}Gamma`))
      h.dispose()
    },
  )

  it('Insert Picture refuses a stale host: no write, rollback runs, the DOM shows the host text', async () => {
    const drifted = `${HOST_EXACT}Delta\n`
    const h = pictureHarness(async () => {
      h.host.owned = h.host.text
      const pair = { exact: h.host.text, rendered: h.shown() }
      h.host.text = drifted
      return pair
    })
    await h.submit()

    expect(h.acquireExactAuthority).toHaveBeenCalledOnce()
    expect(h.postExact.mock.calls[0][1]).toEqual({
      rollback: { restore: expect.any(Function) },
    })
    expect(h.host.restored).toBe(1)
    expect(h.host.text).toBe(drifted)
    expect(h.shown()).toBe(drifted)
    h.dispose()
  })

  it('Insert Picture declines without a write or a DOM change when acquisition fails', async () => {
    const h = pictureHarness(async () => null)
    await h.submit()

    expect(h.acquireExactAuthority).toHaveBeenCalledOnce()
    expect(h.setValue).not.toHaveBeenCalled()
    expect(h.postExact).not.toHaveBeenCalled()
    expect(h.shown()).toBe(RENDERED)
    h.dispose()
  })

  it('Insert Picture declines when the host rendering moved while the dialog was open', async () => {
    const h = pictureHarness(async () => ({
      exact: `${HOST_EXACT}Moved\n`,
      rendered: `${RENDERED}Moved\n`,
    }))
    await h.submit()

    expect(h.acquireExactAuthority).toHaveBeenCalledOnce()
    expect(h.setValue).not.toHaveBeenCalled()
    expect(h.postExact).not.toHaveBeenCalled()
    h.dispose()
  })
})

// Task 733: a fake unit feed over the test root; `emit` plays one per-frame unit change.
function fakeFeed(feedRoot: HTMLElement, live = true) {
  const listeners = new Set<(change: UnitsChange) => void>()
  const feed: UnitFeed = {
    root: feedRoot,
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

const settle = () => new Promise<void>((done) => setTimeout(done, 0))

const PICTURE_FRESH =
  '<span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;img src="a.png" alt="A"&gt;</span><span data-type="html-inline">&lt;/picture&gt;</span>'
const PICTURE_DECORATED = 'picture[data-vmde-inline-picture="1"]'

function tablesRoot() {
  const table = '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>'
  // The feed describes the IR element nested in the observed container, as in the product.
  return root(`<div class="ir">${table}${table}${table}</div>`)
}

function irOf(app: HTMLElement) {
  return app.firstElementChild as HTMLElement
}

function cellsOf(app: HTMLElement) {
  return Array.from(app.querySelectorAll<HTMLElement>('td'))
}

function respin(cells: HTMLElement[]) {
  for (const cell of cells) cell.innerHTML = PICTURE_FRESH
}

function containerQueries(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.filter(([selector]) => String(selector).includes('td'))
}

describe('inline PICTURE reader on unit feed changes (Task 733)', () => {
  it('decorates only the changed cell and skips its own pass for records inside the feed root', async () => {
    const app = tablesRoot()
    const feed = fakeFeed(irOf(app))
    const dispose = observeInlinePictures(app)
    const cells = cellsOf(app)
    respin([cells[2], cells[3]])
    const spy = vi.spyOn(app, 'querySelectorAll')

    feed.emit({ whole: false, changed: [cellUnit(cells[2])] })
    expect(containerQueries(spy)).toHaveLength(0)
    expect(cells[2].querySelector(PICTURE_DECORATED)).not.toBeNull()
    expect(cells[3].querySelector(PICTURE_DECORATED)).toBeNull()

    await settle()
    expect(containerQueries(spy)).toHaveLength(0)
    expect(cells[3].querySelector(PICTURE_DECORATED)).toBeNull()
    dispose()
  })

  it('runs the full pass once for a whole change', () => {
    const app = tablesRoot()
    const feed = fakeFeed(irOf(app))
    const dispose = observeInlinePictures(app)
    const cells = cellsOf(app)
    respin([cells[2], cells[3]])
    const spy = vi.spyOn(app, 'querySelectorAll')

    feed.emit({ whole: true, cause: 'rebind' })
    expect(containerQueries(spy)).toHaveLength(1)
    expect(cells[2].querySelector(PICTURE_DECORATED)).not.toBeNull()
    expect(cells[3].querySelector(PICTURE_DECORATED)).not.toBeNull()
    dispose()
  })

  it.each([
    ['no feed', () => undefined],
    [
      'a feed that is not live',
      (app: HTMLElement) => fakeFeed(irOf(app), false),
    ],
    ['a feed of another root', () => fakeFeed(document.createElement('div'))],
  ])('keeps the full observer pass with %s', async (_name, provide) => {
    const app = tablesRoot()
    provide(app)
    const dispose = observeInlinePictures(app)
    const cells = cellsOf(app)
    respin([cells[2], cells[3]])
    await settle()
    expect(cells[2].querySelector(PICTURE_DECORATED)).not.toBeNull()
    expect(cells[3].querySelector(PICTURE_DECORATED)).not.toBeNull()
    dispose()
  })

  it('uses a feed whose root is the observed root itself', async () => {
    const app = tablesRoot()
    const feed = fakeFeed(app)
    const dispose = observeInlinePictures(app)
    const cells = cellsOf(app)
    respin([cells[2], cells[3]])
    feed.emit({ whole: false, changed: [cellUnit(cells[2])] })
    await settle()
    expect(cells[2].querySelector(PICTURE_DECORATED)).not.toBeNull()
    expect(cells[3].querySelector(PICTURE_DECORATED)).toBeNull()
    dispose()
  })

  it('covers only the container of a record outside the feed root, not the whole root', async () => {
    const app = tablesRoot()
    fakeFeed(irOf(app))
    const dispose = observeInlinePictures(app)
    const cells = cellsOf(app)
    const outside = document.createElement('p')
    app.append(outside)
    outside.innerHTML = PICTURE_FRESH
    respin([cells[2]])
    await settle()
    expect(outside.querySelector(PICTURE_DECORATED)).not.toBeNull()
    // The feed owns the cells: the outside record does not trigger a pass over them.
    expect(cells[2].querySelector(PICTURE_DECORATED)).toBeNull()
    dispose()
  })
})

// The factor-16 fixture takes seconds to mount in jsdom on a loaded machine.
const BUDGET_TIMEOUT_MS = 60_000

// Task 733 (D-13 B-04): counted budgets on the probe fixture, with the IR root observed directly.
describe('inline picture scoped budgets (Task 733, B-04)', {
  timeout: BUDGET_TIMEOUT_MS,
}, () => {
  const FACTORS: Factor[] = [1, 4, 16]
  const costs = new Map<string, number[]>()
  const cost = (counts: BudgetCounts) =>
    counts.nodesWalked + counts.queriedNodes
  const keep = (name: string, value: number) =>
    costs.set(name, [...(costs.get(name) ?? []), value])
  const nodesIn = (node: Node): number => {
    let count = 1
    for (let child = node.firstChild; child; child = child.nextSibling)
      count += nodesIn(child)
    return count
  }
  // The Enter split of list item 3: the item and the new item after it, both in the scopes.
  const enterSplit = (ir: HTMLElement) => {
    const list = ir.querySelector<HTMLElement>(':scope > ul')!
    const item = list.children[2] as HTMLElement
    const added = document.createElement('li')
    added.setAttribute('data-marker', '-')
    added.textContent = 'list item 3b'
    item.after(added)
    const scopes = [item, added]
    const change = {
      whole: false,
      changed: scopes.map(
        (el): LiveUnit => ({ el, members: [el], kind: 'list-item', top: list }),
      ),
      structural: [list],
      scopes,
    }
    return { item, added, change, budget: nodesIn(item) + nodesIn(added) + 8 }
  }

  describe.each(FACTORS)('at factor %i', (factor) => {
    const fresh = () =>
      irFixture(tableHeavyMarkdown(factor), () => undefined).root

    it('a list item Enter visits the two items only, with no root query', () => {
      const ir = fresh()
      const feed = fakeFeed(ir)
      const dispose = observeInlinePictures(ir)
      const { added, change, budget } = enterSplit(ir)
      const { counts } = countBudget(ir, () => feed.emit(change))
      expect(counts.rootQueries).toBe(0)
      expect(cost(counts)).toBeLessThanOrEqual(budget)
      keep('enter', cost(counts))
      added.innerHTML = PICTURE_FRESH
      feed.emit(change)
      expect(added.querySelector(PICTURE_DECORATED)).not.toBeNull()
      dispose()
    })

    it('a selection change in a code block the feed does not map yet makes no root query', () => {
      const ir = fresh()
      fakeFeed(ir)
      const dispose = observeInlinePictures(ir)
      const block = ir.querySelector<HTMLElement>(
        ':scope > [data-type="code-block"]',
      )!
      document
        .getSelection()!
        .collapse(block.querySelector('code')!.firstChild!, 2)
      const { counts } = countBudget(ir, () =>
        document.dispatchEvent(new Event('selectionchange')),
      )
      expect(counts.rootQueries).toBe(0)
      expect(cost(counts)).toBeLessThanOrEqual(nodesIn(block) + 8)
      keep('selection', cost(counts))
      document.getSelection()?.removeAllRanges()
      dispose()
    })
  })

  it('costs the same at every factor', () => {
    for (const name of ['enter', 'selection'])
      expect(costs.get(name)).toEqual(
        Array(FACTORS.length).fill(costs.get(name)?.[0]),
      )
  })
})

// ---- Task 733 / 013-T3: B-04 on the WYSIWYG fixture (D-13 design section 5.2; technical task 013) ----
//
// `observeInlinePictures` over a live feed of Lute's WYSIWYG root: a list item Enter (a scoped change of the two items)
// and a selection change in a code block the feed does not map stay within their scope elements:
// no root query, and nodes walked plus nodes queried at most the scope's nodes plus 8, at every factor.
describe('013 B-04 observeInlinePictures on the WYSIWYG fixture', () => {
  const NODE_SLACK = 8
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
    window.getSelection()?.removeAllRanges()
    document.body.replaceChildren()
  })
  const runWysiwygFrames = (): void => {
    for (let round = 0; round < 5 && wysiwygFrames.length > 0; round++)
      for (const frame of wysiwygFrames.splice(0)) frame(0)
  }
  /** The observer callbacks of earlier writes run, then the frames they queued. */
  const settleWysiwyg = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    runWysiwygFrames()
  }
  const nodesOf = (elements: readonly Element[]): number =>
    elements.reduce((sum, el) => sum + 1 + el.querySelectorAll('*').length, 0)
  /** The WYSIWYG fixture under `app > pre.vditor-reset`, a live fake feed over it, the observer on `app`. */
  async function mountWysiwyg(factor: Factor) {
    const app = document.createElement('div')
    app.className = 'vditor-wysiwyg'
    const root = document.createElement('pre')
    root.className = 'vditor-reset'
    root.setAttribute('contenteditable', 'true')
    root.innerHTML = wysiwygFixture(tableHeavyMarkdown(factor)).root.innerHTML
    app.append(root)
    document.body.append(app)
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
    stop = observeInlinePictures(app)
    await settleWysiwyg()
    return { app, root }
  }

  describe.each([1, 4, 16] as const)('at factor %i', (factor) => {
    it('a list item Enter visits the two items only', async () => {
      const { root } = await mountWysiwyg(factor)
      const list = root.querySelector(':scope > ul') as HTMLElement
      const item = list.children[2] as HTMLElement
      const added = item.cloneNode(true) as HTMLElement
      item.after(added)
      await settleWysiwyg()
      const scopes = [item, added]
      const change = {
        cause: 'mutation',
        whole: false,
        changed: scopes.map(
          (el): LiveUnit => ({
            el,
            members: [el],
            kind: 'list-item',
            top: list,
          }),
        ),
        structural: [list],
        scopes,
      } as UnitsChange
      const { counts } = countBudget(root, () => {
        for (const listener of Array.from(feedListeners)) listener(change)
        runWysiwygFrames()
      })
      expect(counts.rootQueries, 'root queries').toBe(0)
      expect(
        counts.nodesWalked + counts.queriedNodes,
        'nodes walked and queried',
      ).toBeLessThanOrEqual(nodesOf(scopes) + NODE_SLACK)
    }, 60_000)

    it('a selection change in an unmapped code block stays inside the block', async () => {
      const { root } = await mountWysiwyg(factor)
      const block = root.querySelector(
        ':scope > [data-type="code-block"]',
      ) as HTMLElement
      const code = block.querySelector('code') as HTMLElement
      const range = document.createRange()
      range.setStart(code.firstChild as Text, 3)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      await settleWysiwyg()
      const { counts } = countBudget(root, () => {
        document.dispatchEvent(new Event('selectionchange'))
        runWysiwygFrames()
      })
      expect(counts.rootQueries, 'root queries').toBe(0)
      expect(
        counts.nodesWalked + counts.queriedNodes,
        'nodes walked and queried',
      ).toBeLessThanOrEqual(nodesOf([block]) + NODE_SLACK)
    }, 60_000)
  })
})
