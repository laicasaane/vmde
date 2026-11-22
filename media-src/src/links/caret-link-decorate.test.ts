// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import {
  countBudget,
  irFixture as budgetFixture,
  wysiwygFixture,
  type Factor,
} from '../testing/budget-harness'
import {
  type LiveUnit,
  provideUnitFeed,
  type UnitFeed,
  type UnitsChange,
} from '../util/unit-changes'
import { CARET_INSIDE_CLASS } from './caret-link'
import { observeCaretLink } from './caret-link-decorate'

// Task 457 — the DOM-observer half of caret-link.ts's pure core. Drives `vmde-caret-inside` off
// REAL `selectionchange` events (not a manual applyCaretInside call), which is the one thing
// caret-link.test.ts's jsdom-selection-object stubs can't exercise.
//
// Deterministic rAF (same pattern as callouts.test.ts's "observeCallouts scoping" block, and
// observe-coalesce.test.ts): coalescePerFrame's leading edge runs synchronously, but install
// itself ALSO calls `run()` once and so arms a trailing-edge rAF — every SUBSEQUENT selectionchange
// within the same synchronous test therefore only ever reaches the coalesced trailing pass, not the
// leading edge. A real, un-stubbed jsdom rAF won't resolve within a plain `await`, which would
// silently strand the update — so stub it and flush explicitly via `fireFrame()`.
let frameCallbacks: FrameRequestCallback[]
beforeEach(() => {
  frameCallbacks = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frameCallbacks.push(cb)
    return frameCallbacks.length
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    // Mark the slot cancelled so a later flush of frameCallbacks can't
    // re-invoke a callback the code under test already cancelled.
    frameCallbacks[id - 1] = () => {
      /* cancelled */
    }
  })
})
const fireFrame = () => {
  const cbs = frameCallbacks
  frameCallbacks = []
  for (const cb of cbs) cb(0)
}

// Accepts either an element (places the caret inside its first child/text) or a text node
// directly (places the caret at `offset` within it) — the "caret leaves the link for plain prose"
// test needs the latter to land in the paragraph's trailing text run. Fires selectionchange AND
// flushes the coalesced trailing rAF, so callers see the settled result.
function placeCaretIn(target: Node, offset = 1): void {
  const node =
    target.nodeType === Node.TEXT_NODE
      ? target
      : ((target as Element).firstChild ?? target)
  const textOffset =
    node.nodeType === Node.TEXT_NODE
      ? Math.min(offset, (node.textContent ?? '').length)
      : 0
  const range = document.createRange()
  range.setStart(node, textOffset)
  range.collapse(true)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  fireFrame()
}

let dispose: (() => void) | undefined

afterEach(() => {
  vi.unstubAllGlobals()
  dispose?.()
  dispose = undefined
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

describe('observeCaretLink', () => {
  it.each([
    ['IR label', '<span class="vditor-ir__link">label</span>'],
    [
      'wiki chip',
      '<span class="wiki-link-chip" data-wiki-link="1">Home</span>',
    ],
    [
      'code ref',
      '<code class="vmde-code-ref" data-code-ref="1">src/a.ts:1</code>',
    ],
  ])(
    'restores the %s class after root replacement and clears stale restored decorations',
    (_name, markup) => {
      document.body.innerHTML = `<div id="app"><pre class="vditor-reset"><p>${markup} after</p></pre></div>`
      const app = document.getElementById('app')!
      dispose = observeCaretLink(app)
      placeCaretIn(app.querySelector('p')!.firstChild!)
      expect(app.querySelector(`.${CARET_INSIDE_CLASS}`)).not.toBeNull()
      // setValue/mode/history rebuilds replace the editable DOM under the stable mount.
      app.innerHTML = `<pre class="vditor-reset"><p>${markup} after</p></pre>`
      const target = app.querySelector('p')!.firstElementChild!
      placeCaretIn(target)
      expect(target.classList.contains(CARET_INSIDE_CLASS)).toBe(true)
      const historyHtml = app.innerHTML
      app.innerHTML = historyHtml
      placeCaretIn(app.querySelector('p')!.lastChild!, 1)
      expect(app.querySelector(`.${CARET_INSIDE_CLASS}`)).toBeNull()
    },
  )

  it('decorates the wiki chip the caret moves into, on selectionchange', () => {
    document.body.innerHTML =
      '<div id="app"><p>before <span data-wiki-link="1">Page A</span> after</p></div>'
    const app = document.getElementById('app')!
    dispose = observeCaretLink(app)
    const chip = app.querySelector('[data-wiki-link]')!
    placeCaretIn(chip)
    expect(chip.classList.contains(CARET_INSIDE_CLASS)).toBe(true)
  })

  it('clears the decoration when the caret leaves the link for plain prose', () => {
    document.body.innerHTML =
      '<div id="app"><p>before <span data-wiki-link="1">Page A</span> after</p></div>'
    const app = document.getElementById('app')!
    dispose = observeCaretLink(app)
    const chip = app.querySelector('[data-wiki-link]')!
    const p = app.querySelector('p')!
    placeCaretIn(chip)
    expect(chip.classList.contains(CARET_INSIDE_CLASS)).toBe(true)
    placeCaretIn(p.lastChild!, 0) // trailing " after" text node
    expect(chip.classList.contains(CARET_INSIDE_CLASS)).toBe(false)
  })

  // Selectionchange is document-wide; a caret that lands OUTSIDE this instance's root must not
  // decorate anything inside it, even though `linkLikeInSelection` alone (with no root awareness)
  // would still resolve to whatever link-like element the anchor sits in.
  it('ignores a selection anchored outside this root (previewEl vs #app scoping)', () => {
    document.body.innerHTML =
      '<div id="app"><span data-wiki-link="1">In App</span></div>' +
      '<div id="preview"><span data-wiki-link="1">In Preview</span></div>'
    const app = document.getElementById('app')!
    const preview = document.getElementById('preview')!
    dispose = observeCaretLink(app)
    placeCaretIn(preview.querySelector('[data-wiki-link]')!)
    expect(
      app
        .querySelector('[data-wiki-link]')!
        .classList.contains(CARET_INSIDE_CLASS),
    ).toBe(false)
  })

  it('runs an initial sync on install (caret already placed before observeCaretLink is called)', () => {
    document.body.innerHTML =
      '<div id="app"><span data-wiki-link="1">Page A</span></div>'
    const app = document.getElementById('app')!
    const chip = app.querySelector('[data-wiki-link]')!
    const range = document.createRange()
    range.setStart(chip.firstChild!, 1)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    dispose = observeCaretLink(app) // install's own leading run reads the ALREADY-placed caret
    expect(chip.classList.contains(CARET_INSIDE_CLASS)).toBe(true)
  })

  it('the disposer stops further decoration on later selection changes', () => {
    document.body.innerHTML =
      '<div id="app"><span data-wiki-link="1">Page A</span></div>'
    const app = document.getElementById('app')!
    const stop = observeCaretLink(app)
    stop()
    placeCaretIn(app.querySelector('[data-wiki-link]')!)
    expect(
      app
        .querySelector('[data-wiki-link]')!
        .classList.contains(CARET_INSIDE_CLASS),
    ).toBe(false)
  })

  it('tolerates a null root, returning a no-op disposer', () => {
    expect(() => observeCaretLink(null)()).not.toThrow()
  })
})

describe('observeCaretLink without a root scan (Task 733)', () => {
  const chips =
    '<p><span data-wiki-link="1">A</span> mid <span data-wiki-link="1">B</span> end</p>'

  it('moves the class from the last decorated element to the new one without a root querySelectorAll', () => {
    document.body.innerHTML = `<div id="app"><pre class="vditor-reset">${chips}</pre></div>`
    const app = document.getElementById('app')!
    dispose = observeCaretLink(app)
    const [a, b] = Array.from(
      app.querySelectorAll<HTMLElement>('[data-wiki-link]'),
    )
    placeCaretIn(a)
    expect(a.classList.contains(CARET_INSIDE_CLASS)).toBe(true)
    const spy = vi.spyOn(app, 'querySelectorAll')

    placeCaretIn(b)
    expect(a.classList.contains(CARET_INSIDE_CLASS)).toBe(false)
    expect(b.classList.contains(CARET_INSIDE_CLASS)).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('clears the class when the caret leaves for prose, without a root querySelectorAll', () => {
    document.body.innerHTML = `<div id="app"><pre class="vditor-reset">${chips}</pre></div>`
    const app = document.getElementById('app')!
    dispose = observeCaretLink(app)
    const a = app.querySelector<HTMLElement>('[data-wiki-link]')!
    placeCaretIn(a)
    const spy = vi.spyOn(app, 'querySelectorAll')

    placeCaretIn(app.querySelector('p')!.lastChild!, 1)
    expect(a.classList.contains(CARET_INSIDE_CLASS)).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})

// Task 733 / 012-12-T (D-13 design section 5.2, B-04 links): counted work of the caret-link wiring on the
// table-heavy IR fixture. A list item Enter emits a change whose scopes are the two items; the stale-class
// strip must visit only those (`forEachChangeScope`), not the whole list that `forEachScopeElement` visits
// as a structural top (the C1 gap). A caret that enters and leaves an unmapped code block scans no root.
const nodesOf = (element: Node): number => {
  let count = 1
  for (let child = element.firstChild; child; child = child.nextSibling)
    count += nodesOf(child)
  return count
}
const enterSums = new Map<number, number>()

describe.each([1, 4, 16] as const)(
  'observeCaretLink budget at factor %i (Task 733 / 012-12, B-04)',
  (factor) => {
    // The factor-16 fixture takes seconds to render with Lute: built once here, outside the test timeout.
    beforeAll(() => {
      budgetFixture(tableHeavyMarkdown(factor))
    }, 60_000)
    const listeners = new Set<(change: UnitsChange) => void>()
    afterEach(() => {
      provideUnitFeed(window, undefined)
      listeners.clear()
    })

    /** The shared fixture under an `#app` container with a live feed over it, connected again after a reset. */
    function setup() {
      const ir = budgetFixture(tableHeavyMarkdown(factor)).root
      const app = ir.parentElement as HTMLElement
      app.id = 'app'
      if (!app.isConnected) document.body.append(app)
      const feed: UnitFeed = {
        root: ir,
        isLive: () => true,
        liveUnitOf: () => undefined,
        liveUnits: () => [],
        onUnitsChanged: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        confirmNow: () => true,
        confirmedLines: () => undefined,
      }
      provideUnitFeed(window, feed)
      dispose = observeCaretLink(app)
      fireFrame()
      return { ir }
    }

    it('a list item Enter change strips only the two items, with no root query', () => {
      const { ir } = setup()
      const list = ir.querySelector(':scope > ul') as HTMLElement
      const item = list.children[4] as HTMLElement
      const fresh = item.cloneNode(true) as HTMLElement
      item.after(fresh)
      try {
        const unit = (li: HTMLElement): LiveUnit => ({
          el: li,
          members: [li],
          kind: 'list-item',
          top: list,
        })
        const change = {
          cause: 'mutation',
          whole: false,
          changed: [unit(item), unit(fresh)],
          structural: [list],
          scopes: [item, fresh],
        } as UnitsChange
        const { counts } = countBudget(ir, () => {
          for (const listener of Array.from(listeners)) listener(change)
          fireFrame()
        })
        const sum = counts.nodesWalked + counts.queriedNodes
        enterSums.set(factor, sum)
        expect(counts.rootQueries).toBe(0)
        expect(sum).toBeLessThanOrEqual(nodesOf(item) + nodesOf(fresh) + 8)
      } finally {
        fresh.remove()
      }
    })

    it('a caret that enters and leaves an unmapped code block scans no root', () => {
      const { ir } = setup()
      const block = ir.querySelector(
        ':scope > [data-type="code-block"]',
      ) as HTMLElement
      const code = block.querySelector('code') as HTMLElement
      const para = ir.querySelector(':scope > p') as HTMLElement
      const { counts } = countBudget(ir, () => {
        placeCaretIn(code.firstChild as Node)
        placeCaretIn(para.firstChild as Node)
      })
      expect(counts.rootQueries).toBe(0)
      expect(counts.nodesWalked + counts.queriedNodes).toBeLessThanOrEqual(
        nodesOf(block) + 8,
      )
    })
  },
)

describe('observeCaretLink budget across factors (Task 733 / 012-12, B-04)', () => {
  it('strips the same nodes for a list item Enter at every factor', () => {
    expect(enterSums.size).toBe(3)
    expect(new Set(enterSums.values()).size).toBe(1)
  })
})

// ---- Task 733 / 013-T3: B-04 on the WYSIWYG fixture (D-13 design section 5.2; technical task 013) ----
//
// `observeCaretLink` over a live feed of Lute's WYSIWYG root: a list item Enter (a scoped change of the two items)
// and a selection change in a code block the feed does not map stay within their scope elements:
// no root query, and nodes walked plus nodes queried at most the scope's nodes plus 8, at every factor.
describe('013 B-04 observeCaretLink on the WYSIWYG fixture', () => {
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
    stop = observeCaretLink(app)
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

// H2 fix design rev2 (D5.5): a scoped change away from the caret runs no leading selection pass; a change
// that holds the caret still runs it. The stale-class cleanup of the scopes is unchanged.
describe('observeCaretLink scoped changes away from the caret (036 H2 D5.5)', () => {
  const listeners = new Set<(change: UnitsChange) => void>()
  afterEach(() => {
    provideUnitFeed(window, undefined)
    listeners.clear()
  })

  function setup() {
    document.body.innerHTML =
      '<div id="app"><pre class="vditor-reset"><p>one <span data-wiki-link="1">Link</span> x</p><p>two</p><p>three <span class="vmde-caret-inside">old</span></p></pre></div>'
    const app = document.getElementById('app') as HTMLElement
    const ir = app.querySelector('pre') as HTMLElement
    const feed: UnitFeed = {
      root: ir,
      isLive: () => true,
      liveUnitOf: () => undefined,
      liveUnits: () => [],
      onUnitsChanged: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      confirmNow: () => true,
      confirmedLines: () => undefined,
    }
    provideUnitFeed(window, feed)
    dispose = observeCaretLink(app)
    fireFrame()
    const [p1, p2, p3] = Array.from(ir.querySelectorAll('p')) as HTMLElement[]
    const emit = (scope: HTMLElement) => {
      const change = {
        cause: 'sync',
        whole: false,
        changed: [
          {
            el: scope,
            members: [scope],
            kind: 'paragraph',
            top: scope,
          } as LiveUnit,
        ],
        structural: [],
        scopes: [scope],
      } as UnitsChange
      for (const listener of Array.from(listeners)) listener(change)
    }
    return { p1, p2, p3, emit }
  }

  it('a change in another unit reads no selection; its stale class is still stripped', () => {
    const { p1, p3, emit } = setup()
    placeCaretIn(p1.querySelector('span')?.firstChild as Node)
    expect(
      p1.querySelector('span')?.classList.contains(CARET_INSIDE_CLASS),
    ).toBe(true)
    const reads = vi.spyOn(document, 'getSelection')
    emit(p3)
    expect(reads).not.toHaveBeenCalled()
    expect(p3.querySelector(`.${CARET_INSIDE_CLASS}`)).toBeNull()
    expect(
      p1.querySelector('span')?.classList.contains(CARET_INSIDE_CLASS),
    ).toBe(true)
  })

  it('a change that holds the caret runs the selection pass and decorates again', () => {
    const { p1, emit } = setup()
    placeCaretIn(p1.querySelector('span')?.firstChild as Node)
    fireFrame()
    const reads = vi.spyOn(document, 'getSelection')
    emit(p1)
    expect(reads).toHaveBeenCalled()
    expect(
      p1.querySelector('span')?.classList.contains(CARET_INSIDE_CLASS),
    ).toBe(true)
  })
})
