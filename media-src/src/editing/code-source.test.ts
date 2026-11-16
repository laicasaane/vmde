// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import {
  cellUnit,
  countBudget,
  type Factor,
  fakeUnitFeed,
  irFixture,
} from '../testing/budget-harness'
import { provideUnitFeed, type UnitsChange } from '../util/unit-changes'
import { CUSTOM_LANGS, observeCodeSource, tagCodeSource } from './code-source'

function markerPre(lang: string): HTMLElement {
  const pre = document.createElement('pre')
  pre.className = 'vditor-ir__marker--pre'
  const code = document.createElement('code')
  code.className = `language-${lang}`
  pre.appendChild(code)
  return pre
}

// A `.vditor-reset` root with 2 top-level code-block nodes, matching Vditor's real IR shape closely
// enough for mutation-scope.ts's topLevelBlock climb (`ir.element` IS the `.vditor-reset` node).
function irWithTwoBlocks(): {
  ir: HTMLElement
  nodeA: HTMLElement
  nodeB: HTMLElement
} {
  const ir = document.createElement('pre')
  ir.className = 'vditor-reset'
  const nodeA = document.createElement('div')
  nodeA.className = 'vditor-ir__node'
  nodeA.setAttribute('data-type', 'code-block')
  nodeA.appendChild(markerPre('js'))
  const nodeB = document.createElement('div')
  nodeB.className = 'vditor-ir__node'
  nodeB.setAttribute('data-type', 'code-block')
  nodeB.appendChild(markerPre('python'))
  ir.append(nodeA, nodeB)
  document.body.appendChild(ir)
  return { ir, nodeA, nodeB }
}

describe('tagCodeSource', () => {
  it('tags real code-block source with .hljs (theme-driven edit == render)', () => {
    const root = document.createElement('div')
    root.append(markerPre('js'), markerPre('python'))
    tagCodeSource(root)
    for (const code of Array.from(root.querySelectorAll('code'))) {
      expect(code.classList.contains('hljs')).toBe(true)
    }
  })

  it('leaves diagram-language source alone (no .hljs code panel — sits on the page bg)', () => {
    // Every custom-diagram renderer must be excluded, or its editable source gets the dark
    // code panel instead of the page background (the bug behind "te nowe trzeba poprawic").
    for (const lang of [
      'd2',
      'wavedrom',
      'nomnoml',
      'geojson',
      'topojson',
      'vega',
      'vega-lite',
      'stl',
      'smiles',
      'mermaid',
    ]) {
      const root = document.createElement('div')
      root.append(markerPre(lang))
      tagCodeSource(root)
      const code = root.querySelector('code')!
      expect(code.classList.contains('hljs')).toBe(false)
    }
  })

  it('CUSTOM_LANGS covers every custom-diagram renderer', () => {
    for (const lang of [
      'wavedrom',
      'nomnoml',
      'geojson',
      'topojson',
      'vega',
      'vega-lite',
      'stl',
      'd2',
    ]) {
      expect(CUSTOM_LANGS.has(lang)).toBe(true)
    }
  })
})

// Task 173: observeCodeSource is scoped via mutation-scope.ts instead of a whole-root tagCodeSource
// on every batch. These exercise the REAL MutationObserver-driven path (not a direct tagCodeSource
// call), the same way the product actually runs it, so the scoped branch is covered.
//
// Deterministic rAF (same pattern as observe-coalesce.test.ts): coalescePerFrameWithRecords's leading
// edge runs synchronously, but it ALSO arms a trailing-edge rAF — a real, un-stubbed jsdom rAF may not
// resolve within a plain `await`, which would silently strand a same-"frame" edit in `pending`. Stub
// it so the trailing pass is triggered explicitly via `fireFrame()`.
describe('observeCodeSource (task 173 scoping)', () => {
  let dispose: (() => void) | null = null
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
  afterEach(() => {
    vi.unstubAllGlobals()
    dispose?.()
    dispose = null
    document.body.innerHTML = ''
  })
  const fireFrame = () => {
    const cbs = frameCallbacks
    frameCallbacks = []
    for (const cb of cbs) cb(0)
  }

  it('tags both sources on mount (initial full-walk pass)', () => {
    const { ir } = irWithTwoBlocks()
    dispose = observeCodeSource(ir)
    for (const code of Array.from(ir.querySelectorAll('code')))
      expect(code.classList.contains('hljs')).toBe(true)
  })

  it('a real outerHTML replace of ONE block re-tags the FRESH code element via the scoped path', async () => {
    const { ir, nodeA } = irWithTwoBlocks()
    dispose = observeCodeSource(ir) // mount's leading run also arms a trailing-edge rAF
    // Mirrors the spin's `blockElement.outerHTML = html`: the pre-existing `<code>` is destroyed and
    // a brand-new one takes its place — the real regression risk task 173 warns about (a freshly
    // recreated node the scoped re-tag pass must still find).
    nodeA.outerHTML =
      '<div class="vditor-ir__node" data-type="code-block"><pre class="vditor-ir__marker--pre"><code class="language-ts">const x = 1</code></pre></div>'
    await Promise.resolve() // flush the MutationObserver microtask → coalesced into `pending` (mount's rAF is still armed)
    fireFrame() // …flush the trailing pass, which resolves the scoped block via mutation-scope.ts
    const codes = Array.from(ir.querySelectorAll('code'))
    expect(codes).toHaveLength(2)
    for (const code of codes) expect(code.classList.contains('hljs')).toBe(true)
  })
})

// Task 733 / 031 (F-7): with the live feed, one cell key rescans the cell only, never its table or the
// whole root, so the cost does not grow with the document.
// Building the factor 16 fixture with the real Lute can pass 5 s under a full parallel run.
describe('scoped budgets (Task 733 / 031, F-7)', { timeout: 60_000 }, () => {
  const FACTORS: readonly Factor[] = [1, 4, 16]

  afterEach(() => {
    provideUnitFeed(window, undefined)
  })

  // Installs the observer on the factor's fixture and counts one change of its first body cell.
  function cellKey(factor: Factor) {
    const { root } = irFixture(tableHeavyMarkdown(factor))
    const feed = fakeUnitFeed<UnitsChange>(root)
    provideUnitFeed(window, feed)
    const dispose = observeCodeSource(root)
    try {
      const cell = root.querySelector<HTMLElement>('table tbody td')!
      const subtree = cell.getElementsByTagName('*').length + 1
      const { counts } = countBudget(root, () =>
        feed.emit({
          cause: 'mutation',
          whole: false,
          changed: [cellUnit(cell)],
          structural: [],
          scopes: [cell],
        }),
      )
      return { counts, subtree }
    } finally {
      dispose()
    }
  }

  it.each(FACTORS)(
    'a cell key queries no table and no root at factor %i',
    (factor) => {
      const { counts, subtree } = cellKey(factor)
      expect(counts.tableQueries).toBe(0)
      expect(counts.rootQueries).toBe(0)
      expect(counts.queriedNodes + counts.nodesWalked).toBeLessThanOrEqual(
        subtree + 8,
      )
    },
  )

  it('costs the same at every factor', () => {
    const costs = FACTORS.map((factor) => {
      const { counts } = cellKey(factor)
      return counts.queriedNodes + counts.nodesWalked
    })
    expect(new Set(costs).size).toBe(1)
  })

  it('a code block change still tags its new code', () => {
    const { ir, nodeA } = irWithTwoBlocks()
    const feed = fakeUnitFeed<UnitsChange>(ir)
    provideUnitFeed(window, feed)
    const dispose = observeCodeSource(ir)
    try {
      const fresh = document.createElement('code')
      fresh.className = 'language-ts'
      nodeA.querySelector('code')!.replaceWith(fresh)
      feed.emit({
        cause: 'mutation',
        whole: false,
        changed: [{ el: nodeA, members: [nodeA], kind: 'fence', top: nodeA }],
        structural: [],
        scopes: [nodeA],
      })
      expect(fresh.classList.contains('hljs')).toBe(true)
    } finally {
      dispose()
      document.body.innerHTML = ''
    }
  })
})
