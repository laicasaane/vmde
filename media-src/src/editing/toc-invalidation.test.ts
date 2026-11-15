// @vitest-environment jsdom
// Task 733 (D-13 B-11): the TOC invalidation decides from the scopes of a unit feed change while the
// feed describes its root, and keeps its own observer for every other case. The existing TOC cases
// live in `edit-activity.test.ts`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTocInvalidation } from './toc-invalidation'
import {
  type LiveUnit,
  provideUnitFeed,
  type UnitFeed,
  type UnitsChange,
} from '../util/unit-changes'
import { countBudget, type Factor, irFixture } from '../testing/budget-harness'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'

type Change = Pick<UnitsChange, 'whole'> &
  Partial<UnitsChange> & { scopes?: readonly HTMLElement[] }

function fakeFeed(feedRoot: HTMLElement) {
  const listeners = new Set<(change: UnitsChange) => void>()
  const feed: UnitFeed = {
    root: feedRoot,
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
  return (change: Change) => {
    const full: UnitsChange = {
      cause: 'mutation',
      changed: [],
      structural: [],
      ...change,
    }
    for (const listener of Array.from(listeners)) listener(full)
  }
}

function blockUnit(el: HTMLElement, kind: LiveUnit['kind']): LiveUnit {
  return { el, members: [el], kind, top: el }
}

function topBlock(ir: HTMLElement, test: (block: Element) => boolean) {
  return Array.from(ir.children).find(test) as HTMLElement
}

function nodesIn(node: Node): number {
  let count = 1
  for (let child = node.firstChild; child; child = child.nextSibling)
    count += nodesIn(child)
  return count
}

const settle = () => new Promise<void>((done) => setTimeout(done, 0))

const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  provideUnitFeed(window, undefined)
  document.body.replaceChildren()
})

// `outline` true: the native outline consumes headings, so a heading change refreshes.
function setup(factor: Factor, withFeed = true) {
  const ir = irFixture(tableHeavyMarkdown(factor), () => undefined).root
  const emit = withFeed ? fakeFeed(ir) : undefined
  const defer = vi.fn((_key: string, callback: () => void) => callback())
  const toc = installTocInvalidation(ir, defer)
  disposers.push(toc.dispose)
  const renderToc = vi.fn()
  const vditor = {
    currentMode: 'ir',
    ir: { element: ir },
    options: { outline: { enable: true } },
  }
  // The input hook registers its request before the edit's change arrives.
  const input = () => toc.request(vditor, renderToc)
  const paragraph = topBlock(ir, (block) =>
    Boolean(block.textContent?.startsWith('Fourth paragraph')),
  )
  const heading = topBlock(ir, (block) => block.textContent === '## Code')
  return { ir, emit, defer, renderToc, input, paragraph, heading }
}

// The factor-16 fixture takes seconds to mount in jsdom on a loaded machine.
const BUDGET_TIMEOUT_MS = 60_000

describe('TOC invalidation on unit feed changes (Task 733, B-11)', {
  timeout: BUDGET_TIMEOUT_MS,
}, () => {
  describe.each([1, 4, 16] as Factor[])('at factor %i', (factor) => {
    it('a paragraph change makes no root query and no refresh', async () => {
      const { ir, emit, defer, input, paragraph } = setup(factor)
      input()
      paragraph.firstChild!.textContent = 'Fourth paragraph, edited.'
      const { counts } = countBudget(ir, () =>
        emit!({
          whole: false,
          changed: [blockUnit(paragraph, 'paragraph')],
          scopes: [paragraph],
        }),
      )
      expect(counts.rootQueries).toBe(0)
      expect(counts.queriedNodes).toBeLessThanOrEqual(
        nodesIn(paragraph) + ir.childElementCount,
      )
      await settle()
      expect(defer).not.toHaveBeenCalled()
    })

    it('a heading change still refreshes the TOC, with no root query', () => {
      const { ir, emit, defer, renderToc, input, heading } = setup(factor)
      input()
      const { counts } = countBudget(ir, () =>
        emit!({
          whole: false,
          changed: [blockUnit(heading, 'heading')],
          scopes: [heading],
        }),
      )
      expect(defer).toHaveBeenCalledWith('renderToc', expect.any(Function))
      expect(renderToc).toHaveBeenCalledTimes(1)
      expect(counts.rootQueries).toBe(0)
    })
  })

  it('decides from the scopes of the change', () => {
    const { emit, renderToc, input, paragraph, heading } = setup(1)
    input()
    emit!({ whole: false, scopes: [paragraph] })
    expect(renderToc).not.toHaveBeenCalled()
    emit!({ whole: false, changed: [], scopes: [heading] })
    expect(renderToc).toHaveBeenCalledTimes(1)
  })

  it('refreshes on a whole change', () => {
    const { emit, renderToc, input } = setup(1)
    input()
    emit!({ whole: true, cause: 'rebind' })
    expect(renderToc).toHaveBeenCalledTimes(1)
  })

  it('leaves records inside the live feed root to the feed', async () => {
    const { defer, input, heading } = setup(1)
    input()
    heading.lastChild!.replaceWith(document.createTextNode('Source code'))
    await settle()
    expect(defer).not.toHaveBeenCalled()
  })

  it('keeps its own observer without a feed', async () => {
    const { renderToc, input, heading } = setup(1, false)
    input()
    heading.lastChild!.replaceWith(document.createTextNode('Source code'))
    await settle()
    expect(renderToc).toHaveBeenCalledTimes(1)
  })
})
