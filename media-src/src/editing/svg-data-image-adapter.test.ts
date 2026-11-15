// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DOMPurify from 'dompurify'
import {
  applySvgDataImagePreviews,
  maskSvgDataImagesForPreview,
  observeSvgDataImagePreviews,
} from './svg-data-image-adapter'
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

const SAFE_SVG =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjxwYXRoIGQ9Ik0wIDBoMXYxSDB6Ii8+PC9zdmc+'
const SCRIPT_SVG =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+YWxlcnQoMSk8L3NjcmlwdD48L3N2Zz4='

afterEach(() => {
  provideUnitFeed(window, undefined)
  vi.unstubAllGlobals()
  delete window.DOMPurify
})

describe('maskSvgDataImagesForPreview', () => {
  it('moves a raw SVG data URI into a sanitizer-safe preview-only attribute', () => {
    const source = `<img width="24" src="${SAFE_SVG}" alt="safe icon">`
    const masked = maskSvgDataImagesForPreview(source)

    expect(masked).toContain('data-vmde-svg-data=')
    expect(masked).not.toContain(`src="${SAFE_SVG}"`)
    expect(masked).toContain('alt="safe icon"')
  })

  it('leaves fenced HTML literal', () => {
    const source = `~~~html\n<img src="${SAFE_SVG}" alt="literal">\n~~~`
    expect(maskSvgDataImagesForPreview(source)).toBe(source)
  })
})

describe('applySvgDataImagePreviews', () => {
  beforeEach(() => {
    window.DOMPurify = DOMPurify
  })
  it('renders a sanitized SVG through a blob URL in a Lute-invisible preview node', () => {
    const createObjectURL = vi.fn(() => 'blob:vmde-safe')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    const root = document.createElement('div')
    root.innerHTML = `<img data-vmde-svg-data="${SAFE_SVG}" alt="safe icon">`

    applySvgDataImagePreviews(root)

    const preview = root.querySelector<HTMLElement>('[data-render="1"]')
    expect(preview?.getAttribute('contenteditable')).toBe('false')
    expect(preview?.querySelector('img')?.getAttribute('src')).toBe(
      'blob:vmde-safe',
    )
    expect(root.querySelector('img[data-vmde-svg-data]')).toBeNull()
    expect(createObjectURL).toHaveBeenCalledOnce()
  })

  it('rejects a script-bearing SVG without creating a blob URL', () => {
    const createObjectURL = vi.fn(() => 'blob:unsafe')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    const root = document.createElement('div')
    root.innerHTML = `<img data-vmde-svg-data="${SCRIPT_SVG}" alt="hostile">`

    applySvgDataImagePreviews(root)

    expect(root.querySelector('[data-render="1"]')).toBeNull()
    expect(root.querySelector('img[data-vmde-svg-data]')).not.toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('adds an IR/WYSIWYG render-only preview without changing the authored HTML marker', () => {
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:vmde-safe'),
      revokeObjectURL: vi.fn(),
    })
    const root = document.createElement('div')
    root.innerHTML = `<div data-type="html-block"><pre class="vditor-ir__marker--pre"><code>&lt;img src=&quot;${SAFE_SVG}&quot; alt=&quot;safe icon&quot;&gt;</code></pre><pre class="vditor-ir__preview" data-render="2"><img alt="safe icon"></pre></div>`
    const source = root.querySelector('code')?.textContent

    applySvgDataImagePreviews(root)

    expect(root.querySelector('code')?.textContent).toBe(source)
    expect(
      root
        .querySelector('.vditor-ir__preview [data-render="1"] img')
        ?.getAttribute('src'),
    ).toBe('blob:vmde-safe')
  })

  it('adds a Lute-invisible preview beside an inline HTML marker', () => {
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:vmde-safe'),
      revokeObjectURL: vi.fn(),
    })
    const root = document.createElement('div')
    root.innerHTML = `<p><span data-type="html-inline"><code>&lt;img src=&quot;${SAFE_SVG}&quot; alt=&quot;safe icon&quot;&gt;</code></span></p>`
    const source = root.querySelector('code')?.textContent

    applySvgDataImagePreviews(root)

    expect(root.querySelector('code')?.textContent).toBe(source)
    expect(
      root
        .querySelector('[data-type="html-inline"] [data-render="1"] img')
        ?.getAttribute('src'),
    ).toBe('blob:vmde-safe')
  })

  it("adds a WYSIWYG preview beside Vditor's inline code marker", () => {
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:vmde-safe'),
      revokeObjectURL: vi.fn(),
    })
    const root = document.createElement('div')
    root.innerHTML = `<p><code data-type="html-inline">​&lt;img src=&quot;${SAFE_SVG}&quot; alt=&quot;safe icon&quot;&gt;</code></p>`
    const source = root.querySelector('code')?.textContent

    applySvgDataImagePreviews(root)

    expect(root.querySelector('code')?.textContent).toBe(source)
    expect(
      root.querySelector('p > [data-render="1"] img')?.getAttribute('src'),
    ).toBe('blob:vmde-safe')
  })

  it('revokes the blob URL when a Preview rebuild removes its render-only node', async () => {
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:vmde-safe'),
      revokeObjectURL,
    })
    const root = document.createElement('div')
    document.body.appendChild(root)
    root.innerHTML = `<img data-vmde-svg-data="${SAFE_SVG}" alt="safe icon">`
    const dispose = observeSvgDataImagePreviews(root, 'local')
    revokeObjectURL.mockClear()

    root.replaceChildren()
    await Promise.resolve()

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:vmde-safe')
    dispose()
    root.remove()
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

const CANDIDATE = `<p><span data-type="html-inline"><code>&lt;img src=&quot;${SAFE_SVG}&quot; alt=&quot;safe icon&quot;&gt;</code></span></p>`
const PREVIEW = '.vmde-svg-data-image[data-render="1"]'

describe('SVG data image previews on unit feed changes (Task 733)', () => {
  let revokeObjectURL: ReturnType<typeof vi.fn>

  beforeEach(() => {
    window.DOMPurify = DOMPurify
    revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:vmde-safe'),
      revokeObjectURL,
    })
  })

  function tablesRoot() {
    const app = document.createElement('div')
    const table = '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>'
    // The feed describes the IR element nested in the observed container, as in the product.
    app.innerHTML = `<div class="ir">${table}${table}${table}</div>`
    document.body.appendChild(app)
    return app
  }

  function irOf(app: HTMLElement) {
    return app.firstElementChild as HTMLElement
  }

  function cellsOf(app: HTMLElement) {
    return Array.from(app.querySelectorAll<HTMLElement>('td'))
  }

  // Fresh candidates in two cells, as a typing respin would leave them.
  function respin(cells: HTMLElement[]) {
    for (const cell of cells) cell.innerHTML = CANDIDATE
  }

  function rootQueries(spy: ReturnType<typeof vi.spyOn>, selector: string) {
    return spy.mock.calls.filter(([used]) => used === selector)
  }

  it('previews only the changed cell and skips its own pass for records inside the feed root', async () => {
    const app = tablesRoot()
    const feed = fakeFeed(irOf(app))
    const dispose = observeSvgDataImagePreviews(app, 'local')
    const cells = cellsOf(app)
    respin([cells[2], cells[3]])
    const spy = vi.spyOn(app, 'querySelectorAll')

    feed.emit({ whole: false, changed: [cellUnit(cells[2])] })
    expect(spy).not.toHaveBeenCalled()
    expect(cells[2].querySelector(PREVIEW)).not.toBeNull()
    expect(cells[3].querySelector(PREVIEW)).toBeNull()

    await settle()
    expect(spy).not.toHaveBeenCalled()
    expect(cells[3].querySelector(PREVIEW)).toBeNull()
    dispose()
  })

  it('runs the full pass once for a whole change', () => {
    const app = tablesRoot()
    const feed = fakeFeed(irOf(app))
    const dispose = observeSvgDataImagePreviews(app, 'local')
    const cells = cellsOf(app)
    respin([cells[2], cells[3]])
    const spy = vi.spyOn(app, 'querySelectorAll')

    feed.emit({ whole: true, cause: 'rebind' })
    expect(rootQueries(spy, 'img[data-vmde-svg-data]')).toHaveLength(1)
    expect(cells[2].querySelector(PREVIEW)).not.toBeNull()
    expect(cells[3].querySelector(PREVIEW)).not.toBeNull()
    dispose()
  })

  it('still revokes the blob URL of a preview a record removes while the feed is live', async () => {
    const app = tablesRoot()
    const feed = fakeFeed(irOf(app))
    const dispose = observeSvgDataImagePreviews(app, 'local')
    const cells = cellsOf(app)
    cells[2].innerHTML = CANDIDATE
    feed.emit({ whole: false, changed: [cellUnit(cells[2])] })
    await settle()
    revokeObjectURL.mockClear()

    cells[2].replaceChildren()
    await settle()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:vmde-safe')
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
    const dispose = observeSvgDataImagePreviews(app, 'local')
    const cells = cellsOf(app)
    respin([cells[2], cells[3]])
    await settle()
    expect(cells[2].querySelector(PREVIEW)).not.toBeNull()
    expect(cells[3].querySelector(PREVIEW)).not.toBeNull()
    dispose()
  })

  it('uses a feed whose root is the observed root itself', async () => {
    const app = tablesRoot()
    const feed = fakeFeed(app)
    const dispose = observeSvgDataImagePreviews(app, 'local')
    const cells = cellsOf(app)
    respin([cells[2], cells[3]])
    feed.emit({ whole: false, changed: [cellUnit(cells[2])] })
    await settle()
    expect(cells[2].querySelector(PREVIEW)).not.toBeNull()
    expect(cells[3].querySelector(PREVIEW)).toBeNull()
    dispose()
  })

  it('covers only the container of a record outside the feed root, not the whole root', async () => {
    const app = tablesRoot()
    fakeFeed(irOf(app))
    const dispose = observeSvgDataImagePreviews(app, 'local')
    const cells = cellsOf(app)
    const outside = document.createElement('div')
    app.append(outside)
    outside.innerHTML = CANDIDATE
    respin([cells[2]])
    await settle()
    expect(outside.querySelector(PREVIEW)).not.toBeNull()
    // The feed owns the cells: the outside record does not trigger a pass over them.
    expect(cells[2].querySelector(PREVIEW)).toBeNull()
    dispose()
  })

  it('previews an html-block whose render node Vditor adds after the feed change', async () => {
    const app = tablesRoot()
    const ir = irOf(app)
    fakeFeed(ir)
    const dispose = observeSvgDataImagePreviews(app, 'local')
    const block = document.createElement('div')
    block.setAttribute('data-type', 'html-block')
    block.innerHTML = `<pre class="vditor-ir__marker--pre"><code>&lt;img src=&quot;${SAFE_SVG}&quot; alt=&quot;safe icon&quot;&gt;</code></pre>`
    ir.append(block)
    await settle()
    // A render-only record: the feed never reports it, so the reader must handle it.
    const render = document.createElement('pre')
    render.className = 'vditor-ir__preview'
    render.setAttribute('data-render', '2')
    block.append(render)
    await settle()
    expect(block.querySelector(PREVIEW)).not.toBeNull()
    dispose()
  })
})

// The factor-16 fixture takes seconds to mount in jsdom on a loaded machine.
const BUDGET_TIMEOUT_MS = 60_000

// Task 733 (D-13 B-04): counted budgets on the probe fixture, with the IR root observed directly.
describe('SVG data image scoped budgets (Task 733, B-04)', {
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

  const INLINE_CANDIDATE = `<span data-type="html-inline"><code>&lt;img src=&quot;${SAFE_SVG}&quot; alt=&quot;safe icon&quot;&gt;</code></span>`

  beforeEach(() => {
    window.DOMPurify = DOMPurify
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:preview'),
      revokeObjectURL: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(FACTORS)(
    'a list item Enter visits the two items only, with no root query, at factor %i',
    (factor) => {
      const ir = irFixture(tableHeavyMarkdown(factor), () => undefined).root
      const feed = fakeFeed(ir)
      const dispose = observeSvgDataImagePreviews(ir, 'local')
      const { added, change, budget } = enterSplit(ir)
      const { counts } = countBudget(ir, () => feed.emit(change))
      expect(counts.rootQueries).toBe(0)
      expect(cost(counts)).toBeLessThanOrEqual(budget)
      keep('enter', cost(counts))
      added.innerHTML = INLINE_CANDIDATE
      feed.emit(change)
      expect(added.querySelector(PREVIEW)).not.toBeNull()
      dispose()
    },
  )

  it('costs the same at every factor', () => {
    expect(costs.get('enter')).toEqual(
      Array(FACTORS.length).fill(costs.get('enter')?.[0]),
    )
  })
})

// ---- Task 733 / 013-T3: B-04 on the WYSIWYG fixture (D-13 design section 5.2; technical task 013) ----
//
// `observeSvgDataImagePreviews` over a live feed of Lute's WYSIWYG root: a list item Enter (a scoped change of the two items)
// and a selection change in a code block the feed does not map stay within their scope elements:
// no root query, and nodes walked plus nodes queried at most the scope's nodes plus 8, at every factor.
describe('013 B-04 observeSvgDataImagePreviews on the WYSIWYG fixture', () => {
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
    stop = observeSvgDataImagePreviews(app, 'local')
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
