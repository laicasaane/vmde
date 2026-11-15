// @vitest-environment jsdom

import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { createBlockAnchor, resolveBlockAnchor } from './block-anchor'
import {
  countBudget,
  type Factor,
  irFixture,
  wysiwygFixture,
} from '../testing/budget-harness'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import {
  provideUnitFeed,
  type UnitFeed,
  type UnitsChange,
} from '../util/unit-changes'

function blocks(markup: string): HTMLElement[] {
  document.body.innerHTML = `<main>${markup}</main>`
  return Array.from(document.querySelector('main')!.children) as HTMLElement[]
}

describe('block anchors', () => {
  it('reanchors the same block by content after blocks are inserted above it', () => {
    const before = blocks(`
      <h1 data-block="0">Guide</h1>
      <p data-block="0">Alpha</p>
      <p data-block="0">Remember me</p>
    `)
    const anchor = createBlockAnchor(before[2], before)
    const after = blocks(`
      <h1 data-block="0">Guide</h1>
      <p data-block="0">Inserted</p>
      <p data-block="0">Alpha</p>
      <p data-block="0">Remember me</p>
    `)

    expect(resolveBlockAnchor(anchor, after)).toBe(after[3])
  })

  it('uses the heading path to disambiguate duplicate block content', () => {
    const before = blocks(`
      <h1 data-block="0">First</h1><p data-block="0">Same</p>
      <h1 data-block="0">Second</h1><p data-block="0">Same</p>
    `)
    const anchor = createBlockAnchor(before[3], before)
    const after = blocks(`
      <h1 data-block="0">Inserted</h1><p data-block="0">Same</p>
      <h1 data-block="0">First</h1><p data-block="0">Same</p>
      <h1 data-block="0">Second</h1><p data-block="0">Same</p>
    `)

    expect(resolveBlockAnchor(anchor, after)).toBe(after[5])
  })

  it('falls back to the bounded original index when content no longer matches', () => {
    const before = blocks(
      '<h1 data-block="0">Title</h1><p data-block="0">Old</p>',
    )
    const anchor = createBlockAnchor(before[1], before)
    const after = blocks(
      '<h1 data-block="0">Title</h1><p data-block="0">Rewritten</p>',
    )

    expect(resolveBlockAnchor(anchor, after)).toBe(after[1])
  })
})

describe('block anchor text (Task 733, 007)', () => {
  it('ignores transient markers and does not clone a table block', () => {
    const table = blocks(
      '<table data-block="0"><tbody><tr><td>one<span class="vditor-ir__marker">|</span></td><td>two<span class="vmde-find-overlay">found</span></td></tr></tbody></table>',
    )
    const plain = blocks(
      '<table data-block="0"><tbody><tr><td>one</td><td>two</td></tr></tbody></table>',
    )
    const first = table[0]
    let clones = 0
    const clone = first.cloneNode
    first.cloneNode = function (this: Node, deep?: boolean) {
      clones++
      return clone.call(this, deep)
    } as typeof first.cloneNode
    const marked = createBlockAnchor(first, table).hash
    expect(clones).toBe(0)
    expect(marked).toBe(createBlockAnchor(plain[0], plain).hash)
  })
})

// The factor-16 fixture takes seconds to mount in jsdom on a loaded machine.
const BUDGET_TIMEOUT_MS = 60_000

// Task 733 (D-13 B-11): an anchor reads the anchored block and the heading path above it; it never
// queries the root, and its cost does not grow with the rest of the document.
describe('block anchor budgets (Task 733, B-11)', {
  timeout: BUDGET_TIMEOUT_MS,
}, () => {
  const FACTORS: Factor[] = [1, 4, 16]
  const costs: number[] = []
  const nodesIn = (node: Node): number => {
    let count = 1
    for (let child = node.firstChild; child; child = child.nextSibling)
      count += nodesIn(child)
    return count
  }

  it.each(FACTORS)(
    'anchors a paragraph below the tables without a root query at factor %i',
    (factor) => {
      const { root } = irFixture(tableHeavyMarkdown(factor))
      const blocks = Array.from(root.children) as HTMLElement[]
      const block = blocks.find((candidate) =>
        candidate.textContent?.startsWith('Sixth paragraph'),
      )!
      const { result, counts } = countBudget(root, () =>
        createBlockAnchor(block, blocks),
      )
      expect(result.index).toBe(blocks.indexOf(block))
      expect(result.headingPath).toEqual(['1:Overview', '2:Tables'])
      expect(counts.rootQueries).toBe(0)
      expect(counts.nodesWalked + counts.queriedNodes).toBeLessThanOrEqual(
        nodesIn(block) + blocks.length,
      )
      costs.push(counts.nodesWalked + counts.queriedNodes)
    },
  )

  it('costs the same at every factor', () => {
    expect(costs).toHaveLength(FACTORS.length)
    expect(new Set(costs).size).toBe(1)
  })
})

// ---- Task 733 / 013-T5: B-11 on the WYSIWYG fixture (D-13 design section 5.2; technical task 013) ----
//
// `createBlockAnchor` over a live feed of Lute's WYSIWYG root (the table-heavy fixture). B-11: an anchor reads only the given top-level blocks.
describe('013 B-11 createBlockAnchor on the WYSIWYG fixture', () => {
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
    document.body.replaceChildren()
  })
  const runWysiwygFrames = (): void => {
    for (let round = 0; round < 5 && wysiwygFrames.length > 0; round++)
      for (const frame of wysiwygFrames.splice(0)) frame(0)
  }
  const settleWysiwyg = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    runWysiwygFrames()
  }
  const nodesOf = (elements: readonly Element[]): number =>
    elements.reduce((sum, el) => sum + 1 + el.querySelectorAll('*').length, 0)
  async function mountWysiwyg(factor: Factor) {
    const app = document.createElement('div')
    // The production mount: observers watch `#app`, so its queries count as root queries.
    app.id = 'app'
    app.className = 'vditor vditor-wysiwyg'
    const root = document.createElement('pre')
    root.className = 'vditor-reset'
    root.setAttribute('contenteditable', 'true')
    root.innerHTML = wysiwygFixture(MARKDOWN(factor)).root.innerHTML
    app.append(root)
    document.body.append(app)
    vi.stubGlobal('vditor', {
      getCurrentMode: () => 'wysiwyg',
      vditor: { currentMode: 'wysiwyg', wysiwyg: { element: root } },
    })
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
    // The anchor functions are pure.
    await settleWysiwyg()
    return { app, root }
  }

  const MARKDOWN = (factor: Factor): string => tableHeavyMarkdown(factor)

  describe.each([1, 4, 16] as const)('at factor %i', (factor) => {
    it('an anchor of a block reads nothing on the root and at most the top-level blocks', async () => {
      const { root } = await mountWysiwyg(factor)
      const paragraph = root.querySelectorAll(':scope > p')[3] as HTMLElement
      const blocks = Array.from(root.children) as HTMLElement[]
      const { result, counts } = countBudget(root, () =>
        createBlockAnchor(paragraph, blocks),
      )
      expect(counts.rootQueries, 'root queries').toBe(0)
      expect(counts.queriedNodes, 'queried nodes').toBeLessThanOrEqual(
        nodesOf([paragraph]) + blocks.length,
      )
      expect(resolveBlockAnchor(result, blocks)).toBe(paragraph)
    }, 60_000)
  })
})
