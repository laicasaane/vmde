// @vitest-environment jsdom
import { afterEach, test, expect, beforeEach, describe, vi } from 'vitest'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import {
  type BudgetCounts,
  cellUnit,
  countBudget,
  type Factor,
  fakeUnitFeed,
  irFixture,
} from '../testing/budget-harness'
import { provideUnitFeed, type UnitsChange } from '../util/unit-changes'
import { ENGINES } from '../diagram-kit/engine-registry'
import {
  CUSTOM_DIAGRAM_ADAPTERS,
  customDiagramRenderers,
  observeCustomDiagrams,
  presentCustomLangs,
} from './custom-diagrams'
import { HOIST_SCOPE_CHANGE_EVENT } from '../nav/section-hoist'

beforeEach(() => {
  document.body.innerHTML = ''
})

// enrichMarkdownLabels (task 154) moved to diagram-engines/d2.test.ts (task 409, the deferred D2
// engine split) alongside the rest of the D2 engine.

// Drives observeCustomDiagrams' per-lang dispatch (task 164 §5): only engines whose lang is present
// get invoked + a yielded frame. Must be a SUPERSET of findBlocks (no edit-surface filter).
describe('presentCustomLangs', () => {
  test('empty doc → empty set (no-diagram sweeps skip every renderer)', () => {
    document.body.innerHTML =
      '<div id="app"><p>prose</p><pre><code>plain</code></pre></div>'
    expect(presentCustomLangs(document.getElementById('app')!).size).toBe(0)
  })

  test('picks out exactly the langs with an un-rendered block (incl. hyphenated vega-lite)', () => {
    document.body.innerHTML =
      '<div id="app">' +
      '<div class="language-d2"></div>' +
      '<code class="language-vega-lite hljs">{}</code>' +
      '<pre><code class="language-python">x=1</code></pre>' +
      '</div>'
    const present = presentCustomLangs(document.getElementById('app')!)
    expect(present.has('d2')).toBe(true)
    expect(present.has('vega-lite')).toBe(true)
    // A native/non-custom lang is still reported (harmless: it has no renderer in the array), but a
    // renderer whose lang is absent (e.g. wavedrom) is NOT — that's the whole point.
    expect(present.has('wavedrom')).toBe(false)
  })

  test('skips already-rendered blocks (data-processed="true")', () => {
    document.body.innerHTML =
      '<div id="app">' +
      '<div class="language-d2" data-processed="true"></div>' +
      '<div class="language-nomnoml"></div>' +
      '</div>'
    const present = presentCustomLangs(document.getElementById('app')!)
    expect(present.has('d2')).toBe(false) // done → not re-swept
    expect(present.has('nomnoml')).toBe(true)
  })

  test('skips languages present only in hoisted-away blocks', () => {
    document.body.innerHTML =
      '<div id="app"><div data-vmde-hoist-hidden>' +
      '<div class="language-d2"></div></div></div>'

    expect(presentCustomLangs(document.getElementById('app')!).has('d2')).toBe(
      false,
    )
  })

  test('SUPERSET of findBlocks: a lang only in an editable marker is still reported (safe false positive)', () => {
    // findBlocks would SKIP this (edit-surface .closest filter); the pre-scan must NOT — a false
    // negative would drop a real diagram, a false positive just degrades to a renderer no-op.
    document.body.innerHTML =
      '<div id="app"><pre class="vditor-ir__marker--pre">' +
      '<code class="language-wavedrom">{}</code></pre></div>'
    expect(
      presentCustomLangs(document.getElementById('app')!).has('wavedrom'),
    ).toBe(true)
  })

  test('a hoist scope-change reschedules custom diagrams that become visible', async () => {
    document.body.innerHTML =
      '<div id="app"><div data-vmde-hoist-hidden>' +
      '<div class="language-d2"></div></div></div>'
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const originalRender = CUSTOM_DIAGRAM_ADAPTERS.d2.render
    const render = vi.fn()
    CUSTOM_DIAGRAM_ADAPTERS.d2.render = render
    const app = document.getElementById('app')!
    const dispose = observeCustomDiagrams(app)
    frames.shift()?.(0)
    await Promise.resolve()
    expect(render).not.toHaveBeenCalled()

    app.firstElementChild?.removeAttribute('data-vmde-hoist-hidden')
    document.dispatchEvent(new Event(HOIST_SCOPE_CHANGE_EVENT))
    frames.shift()?.(0)
    await Promise.resolve()
    expect(render).toHaveBeenCalledWith(app)

    dispose()
    CUSTOM_DIAGRAM_ADAPTERS.d2.render = originalRender
    vi.unstubAllGlobals()
  })

  test('an unrelated prose mutation does not wake an unprocessed diagram in another block', async () => {
    document.body.innerHTML = `<div id="app"><pre class="vditor-reset">
      <div id="diagram" data-block="0"><div class="language-d2" data-processed="true"></div></div>
      <p id="prose" data-block="0">text</p>
    </pre></div>`
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const originalRender = CUSTOM_DIAGRAM_ADAPTERS.d2.render
    const render = vi.fn()
    CUSTOM_DIAGRAM_ADAPTERS.d2.render = render
    const app = document.getElementById('app')!
    const dispose = observeCustomDiagrams(app)
    frames.shift()?.(0)
    await Promise.resolve()
    app.querySelector('.language-d2')?.removeAttribute('data-processed')

    app.querySelector('#prose')?.appendChild(document.createTextNode('!'))
    await Promise.resolve()
    frames.shift()?.(0)
    await Promise.resolve()
    expect(render).not.toHaveBeenCalled()

    app.querySelector('#diagram')?.appendChild(document.createElement('span'))
    await Promise.resolve()
    frames.shift()?.(0)
    await Promise.resolve()
    expect(render).toHaveBeenCalledWith(app.querySelector('#diagram'))

    dispose()
    CUSTOM_DIAGRAM_ADAPTERS.d2.render = originalRender
    vi.unstubAllGlobals()
  })
})

// Task 404 phase 1: CUSTOM_DIAGRAM_ADAPTERS must cover EXACTLY the `family: 'custom'` engines —
// in both directions, so a new custom engine that forgets to register an adapter (the "N+1"
// silent-non-render risk the review flagged) fails this test instead of shipping unwired.
describe('CUSTOM_DIAGRAM_ADAPTERS completeness (task 404 phase 1)', () => {
  const customLangs = ENGINES.filter((e) => e.family === 'custom').map(
    (e) => e.lang,
  )

  test('every family:"custom" engine has an adapter entry', () => {
    for (const lang of customLangs) {
      expect(
        CUSTOM_DIAGRAM_ADAPTERS[lang],
        `missing adapter for "${lang}"`,
      ).toBeDefined()
    }
  })

  test('no adapter entry exists for a non-custom (or unknown) lang', () => {
    const adapterLangs = Object.keys(CUSTOM_DIAGRAM_ADAPTERS)
    for (const lang of adapterLangs) {
      expect(customLangs, `orphan adapter for "${lang}"`).toContain(lang)
    }
  })

  test('every adapter has a render and a reRender function', () => {
    for (const lang of Object.keys(CUSTOM_DIAGRAM_ADAPTERS)) {
      const adapter = CUSTOM_DIAGRAM_ADAPTERS[lang]
      expect(typeof adapter.render, `${lang}.render`).toBe('function')
      expect(typeof adapter.reRender, `${lang}.reRender`).toBe('function')
    }
  })
})

// Task 404 phase 2: observeCustomDiagrams used to carry its OWN hard-coded `{lang, render}` array —
// a byte-for-byte duplicate of CUSTOM_DIAGRAM_ADAPTERS (the exact "same knowledge in two places"
// engine-registry.ts exists to kill). customDiagramRenderers() is the single derivation both the
// completeness test above and observeCustomDiagrams' dispatch loop now read from.
describe('customDiagramRenderers (task 404 phase 2)', () => {
  test('langs + order match ENGINES family:"custom", in registry order', () => {
    const expectedLangs = ENGINES.filter((e) => e.family === 'custom').map(
      (e) => e.lang,
    )
    expect(customDiagramRenderers().map((r) => r.lang)).toEqual(expectedLangs)
  })

  test("each entry's render is the SAME function reference as CUSTOM_DIAGRAM_ADAPTERS[lang].render", () => {
    for (const { lang, render } of customDiagramRenderers()) {
      expect(render, lang).toBe(CUSTOM_DIAGRAM_ADAPTERS[lang].render)
    }
  })
})

// Task 733 / 031 (F-7): while the unit feed is live, records inside its root are left to the feed and
// its change scopes are queued; only render subtrees, which the feed never reports, still come from
// the observer. Building the factor 16 fixture with the real Lute can pass 5 s under a full run.
describe('scoped budgets (Task 733 / 031, F-7)', { timeout: 60_000 }, () => {
  const FACTORS: readonly Factor[] = [1, 4, 16]
  // Only the presence of the readiness object turns the statistics on; its fields are never read here.
  type StatsWindow = Omit<Window, '__vmdeE2EReadiness'> & {
    __vmdeE2EReadiness?: unknown
    __vmdeMutationImpactStats?: {
      helpers: Record<string, { full: number; local: number; skipped: number }>
    }
  }
  const win = window as unknown as StatsWindow
  let frames: FrameRequestCallback[] = []
  const runFrames = () => {
    while (frames.length > 0) frames.shift()?.(0)
  }
  // Lets the render loop finish its pass (it awaits between roots) so the next change starts a new one.
  const settle = () => new Promise<void>((done) => setTimeout(done, 0))

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    win.__vmdeE2EReadiness = {}
  })
  afterEach(() => {
    provideUnitFeed(window, undefined)
    vi.unstubAllGlobals()
    delete win.__vmdeE2EReadiness
    delete win.__vmdeMutationImpactStats
  })

  // The observer on the factor's fixture, after its opening full pass, with a live feed over the root.
  async function observed(factor: Factor) {
    const { root } = irFixture(tableHeavyMarkdown(factor))
    if (!root.isConnected) document.body.append(root.parentElement!)
    const feed = fakeUnitFeed<UnitsChange>(root)
    provideUnitFeed(window, feed)
    const dispose = observeCustomDiagrams(root.parentElement)
    runFrames()
    await settle()
    delete win.__vmdeMutationImpactStats
    return { root, feed, dispose }
  }

  const cellChange = (cell: HTMLElement): UnitsChange => ({
    cause: 'mutation',
    whole: false,
    changed: [cellUnit(cell)],
    structural: [],
    scopes: [cell],
  })
  const helperStats = () =>
    win.__vmdeMutationImpactStats?.helpers['custom-diagrams']

  async function cellKey(factor: Factor): Promise<{
    counts: BudgetCounts
    subtree: number
  }> {
    const { root, feed, dispose } = await observed(factor)
    try {
      const cell = root.querySelector<HTMLElement>('table tbody td')!
      const subtree = cell.getElementsByTagName('*').length + 1
      // The key's DOM write, then the feed's change for it; the observer sees the write a microtask later.
      const text = document.createTextNode('x')
      cell.append(text)
      feed.emit(cellChange(cell))
      await Promise.resolve()
      const { counts } = countBudget(root, runFrames)
      await settle()
      text.remove()
      await settle()
      return { counts, subtree }
    } finally {
      dispose()
    }
  }

  test.each(FACTORS)(
    'a cell change in a live feed queues the cell scope only at factor %i',
    async (factor) => {
      const { counts, subtree } = await cellKey(factor)
      expect(counts.tableQueries).toBe(0)
      expect(counts.rootQueries).toBe(0)
      expect(counts.queriedNodes).toBeLessThanOrEqual(subtree)
    },
  )

  test('costs the same at every factor', async () => {
    const costs: number[] = []
    for (const factor of FACTORS) {
      const { counts } = await cellKey(factor)
      costs.push(counts.queriedNodes + counts.nodesWalked)
    }
    expect(new Set(costs).size).toBe(1)
  })

  test('a feed cell change records a local pass', async () => {
    const { root, feed, dispose } = await observed(1)
    try {
      feed.emit(cellChange(root.querySelector<HTMLElement>('table tbody td')!))
      expect(helperStats()).toMatchObject({ full: 0, local: 1 })
    } finally {
      dispose()
    }
  })

  test('a whole feed change records a full pass', async () => {
    const { feed, dispose } = await observed(1)
    try {
      feed.emit({ cause: 'build', whole: true, changed: [], structural: [] })
      expect(helperStats()).toMatchObject({ full: 1, local: 0 })
    } finally {
      dispose()
    }
  })

  test('a render-subtree record inside the feed root still queues its container', async () => {
    document.body.innerHTML = `<div id="app"><pre class="vditor-reset">
      <div id="diagram" data-block="0" data-type="code-block"><pre class="vditor-ir__marker--pre"><code>a</code></pre><pre class="vditor-ir__preview" data-render="2"><div class="language-d2" data-processed="true"></div></pre></div>
      <p id="prose" data-block="0">text</p>
    </pre></div>`
    const app = document.getElementById('app')!
    provideUnitFeed(
      window,
      fakeUnitFeed<UnitsChange>(
        app.querySelector<HTMLElement>('.vditor-reset')!,
      ),
    )
    const originalRender = CUSTOM_DIAGRAM_ADAPTERS.d2.render
    const render = vi.fn()
    CUSTOM_DIAGRAM_ADAPTERS.d2.render = render
    const dispose = observeCustomDiagrams(app)
    try {
      runFrames()
      await settle()
      render.mockClear()
      // Vditor rewrites the preview's rendered content: the feed never reports it.
      app.querySelector('.vditor-ir__preview')!.innerHTML =
        '<div class="language-d2"></div>'
      await Promise.resolve()
      runFrames()
      await settle()
      expect(render).toHaveBeenCalledWith(app.querySelector('#diagram'))
    } finally {
      dispose()
      CUSTOM_DIAGRAM_ADAPTERS.d2.render = originalRender
    }
  })
})
