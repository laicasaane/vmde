// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import { countBudget, countedLute } from '../testing/budget-harness'
import { createRealLute, svFixture } from '../testing/real-lute'
import type { LiveUnit, UnitFeed, UnitsChange } from '../util/unit-changes'
import * as previewMorph from './preview-morph'

// Task 733 / 015-T1, S-10 (task 015 sections 6.2 D-6 and 6.4): the Split pane renders only the Source
// units that changed. The hook `__vmdeRenderSplitPreview` is the one patch V-S4 calls at the top of
// `Preview.render`; its installer name is provisional (section 6.4 names the hook only; see the 015-T1
// handoff). The pane is prepared with a unit baseline, a feed change names one unit, and the debounced
// render must make one `Md2HTML` call on that unit's text. Loaded by computed specifiers so this file
// typechecks before the modules exist.

interface SplitPreviewModule {
  installSplitPreviewRoute(owner: unknown): () => void
}
interface SourceFeedModule {
  provideSourceUnitFeed?(win: Window, feed: UnitFeed | undefined): void
}
type Hook = (vditor: unknown, value?: string) => boolean
const SPLIT: string = './split-preview-units'
const CHANGES: string = '../util/unit-changes'
const morph = previewMorph as unknown as {
  setPreviewUnitBaseline?(
    pane: HTMLElement,
    elementCounts: readonly number[],
  ): void
}
const hookOf = (): Hook | undefined =>
  (window as unknown as { __vmdeRenderSplitPreview?: Hook })
    .__vmdeRenderSplitPreview

let lute: any
let uninstall: (() => void) | undefined
beforeAll(() => {
  lute = countedLute(createRealLute('ir').lute)
})
afterEach(async () => {
  uninstall?.()
  uninstall = undefined
  const feeds = (await import(/* @vite-ignore */ CHANGES)) as SourceFeedModule
  feeds.provideSourceUnitFeed?.(window, undefined)
  vi.useRealTimers()
  document.body.replaceChildren()
})

interface Rig {
  root: HTMLElement
  pane: HTMLElement
  vditor: Record<string, unknown>
  emit(change: UnitsChange): void
}

async function rig(markdown: string, mode = 'both'): Promise<Rig> {
  const root = svFixture(markdown)
  const units: LiveUnit[] = Array.from(root.children, (el) => ({
    el: el as HTMLElement,
    members: [el as HTMLElement],
    kind: 'paragraph',
    top: el as HTMLElement,
  }))
  const listeners = new Set<(change: UnitsChange) => void>()
  const feed: UnitFeed = {
    root,
    isLive: () => true,
    liveUnitOf: (node) => units.find((unit) => unit.el.contains(node)),
    liveUnits: () => units,
    onUnitsChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    confirmNow: () => true,
    confirmedLines: () => undefined,
  }
  const feeds = (await import(/* @vite-ignore */ CHANGES)) as SourceFeedModule
  expect(typeof feeds.provideSourceUnitFeed).toBe('function')
  feeds.provideSourceUnitFeed?.(window, feed)
  const wrapper = document.createElement('div')
  wrapper.style.display = 'block'
  const pane = document.createElement('div')
  wrapper.append(pane)
  document.body.append(wrapper)
  // The pane as a previous whole render left it: one element group per unit, with its baseline.
  const counts: number[] = []
  for (const unit of units) {
    const holder = document.createElement('template')
    holder.innerHTML = lute.Md2HTML(unit.el.textContent ?? '')
    counts.push(holder.content.children.length)
    pane.append(holder.content)
  }
  morph.setPreviewUnitBaseline?.(pane, counts)
  const vditor = {
    currentMode: 'sv',
    sv: { element: root },
    lute,
    options: { preview: { mode, delay: 0 } },
    preview: { element: wrapper, previewElement: pane },
  }
  const module = (await import(/* @vite-ignore */ SPLIT)) as SplitPreviewModule
  uninstall = module.installSplitPreviewRoute(vditor)
  return {
    root,
    pane,
    vditor,
    emit: (change) => {
      for (const listener of listeners) listener(change)
    },
  }
}

const divStarting = (root: HTMLElement, prefix: string): HTMLElement => {
  for (const child of Array.from(root.children))
    if (child.textContent?.startsWith(prefix)) return child as HTMLElement
  throw new Error(`no Source block starts with ${prefix}`)
}

/** A one-unit change as the Source feed reports it (`scopes`: shared rules 3.3 as amended by D-13). */
const unitChange = (el: HTMLElement): UnitsChange =>
  ({
    cause: 'mutation',
    whole: false,
    changed: [{ el, members: [el], kind: 'paragraph', top: el }],
    structural: [],
    scopes: [el],
  }) as UnitsChange

// Task 733 / 015: factors 4 and 16 build Source or IR fixtures of 51 KB and 208 KB with the real Lute in
// jsdom; the suite timeout is explicit (family rule 13.17).
const FIXTURE_TIMEOUT_MS = 30_000

describe.each([1, 4, 16] as const)(
  'S-10 at factor %i',
  { timeout: FIXTURE_TIMEOUT_MS },
  (factor) => {
    const markdown = tableHeavyMarkdown(factor)

    it('renders the changed unit alone', async () => {
      vi.useFakeTimers()
      const r = await rig(markdown)
      const div = divStarting(r.root, 'Second paragraph')
      const firstChild = r.pane.firstElementChild
      const lastChild = r.pane.lastElementChild
      div.firstElementChild?.append('x')
      r.emit(unitChange(div))
      const { result, counts } = countBudget(r.root, () => {
        const routed = hookOf()?.(r.vditor)
        vi.runOnlyPendingTimers()
        return routed
      })
      expect(result).toBe(true)
      expect(counts.luteCalls).toBe(1)
      expect(counts.luteChars).toBeLessThanOrEqual(
        (div.textContent ?? '').length,
      )
      expect(counts.rootQueries).toBe(0)
      expect(r.pane.textContent).toContain('still plain prose.x')
      // Elements of other units stay the same nodes (a diagram there keeps its instance).
      expect(r.pane.firstElementChild).toBe(firstChild)
      expect(r.pane.lastElementChild).toBe(lastChild)
    })
  },
)

describe('S-10 routes', () => {
  it('leaves Preview.render to Vditor outside Split, for an explicit value, and with definitions', async () => {
    const r = await rig('a\n\nb\n', 'editor')
    expect(hookOf()?.(r.vditor)).toBe(false)
    uninstall?.()
    const split = await rig('a\n\nb\n')
    expect(hookOf()?.(split.vditor, '<p>given</p>')).toBe(false)
    uninstall?.()
    const defs = await rig('x [r]\n\n[r]: http://example.test\n')
    expect(hookOf()?.(defs.vditor)).toBe(false)
  })
})
