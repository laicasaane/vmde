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
import { countBudget, countedLute } from '../testing/budget-harness'
import { createRealLute, svFixture } from '../testing/real-lute'
import type { LiveUnit, UnitFeed, UnitsChange } from '../util/unit-changes'
import * as previewMorph from './preview-morph'

// Task 733 / 015 (Q-129, Q-131): the 015 Source cases prove the Source path while the shipped
// `SOURCE_UNITS` stays false. `sourceUnitsOn` turns the constant on for those cases only (set in their
// describe blocks); every other case keeps the shipped value.
const sourceUnitsOn = vi.hoisted(() => ({ value: false }))
vi.mock('../util/unit-changes', async (original) => ({
  ...(await original<typeof import('../util/unit-changes')>()),
  get SOURCE_UNITS() {
    return sourceUnitsOn.value
  },
}))

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
    beforeEach(() => {
      sourceUnitsOn.value = true
    })
    afterEach(() => {
      sourceUnitsOn.value = false
    })
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

// Task 733 / 019 (C5, Q-157; C6, Q-158): the pane a unit render leaves equals a whole render of the
// same text, and the render that opens the pane gives it the unit baseline, so the next key morphs.
describe('019 Split separators and the pane-open baseline', () => {
  beforeEach(() => {
    sourceUnitsOn.value = true
  })
  afterEach(() => {
    sourceUnitsOn.value = false
  })
  const markdown = 'alpha\n\nbravo\n\ncharlie\n'
  /** Replaces the rig's pane by an empty one with no unit baseline. */
  const freshPane = (r: Rig): HTMLElement => {
    const pane = document.createElement('div')
    r.pane.replaceWith(pane)
    ;(r.vditor.preview as { previewElement: HTMLElement }).previewElement = pane
    return pane
  }
  const previewMorphModule = previewMorph as unknown as {
    previewUnitCount?(pane: HTMLElement): number | undefined
  }

  it('a key morph leaves the pane equal to a whole render (C5)', async () => {
    vi.useFakeTimers()
    const r = await rig(markdown)
    const div = divStarting(r.root, 'bravo')
    div.firstElementChild?.append('x')
    r.emit(unitChange(div))
    expect(hookOf()?.(r.vditor)).toBe(true)
    vi.runOnlyPendingTimers()
    expect(r.pane.innerHTML).toBe(lute.Md2HTML('alpha\n\nbravox\n\ncharlie\n'))
  })

  it('the whole render job keeps the separators (C5)', async () => {
    vi.useFakeTimers()
    const r = await rig(markdown)
    // A pane without a unit baseline is rendered whole, unit by unit, by the background job.
    const pane = freshPane(r)
    const div = divStarting(r.root, 'bravo')
    r.emit(unitChange(div))
    expect(hookOf()?.(r.vditor)).toBe(true)
    vi.runAllTimers()
    expect(pane.innerHTML).toBe(lute.Md2HTML(markdown))
  })

  it('the pane-open render sets the baseline and the next key morphs one unit (C6)', async () => {
    vi.useFakeTimers()
    const r = await rig(markdown)
    // The pane as Vditor's own render opens it: whole HTML, no unit baseline. Its render arrives with
    // the model text as `value` (Q-158).
    const pane = freshPane(r)
    pane.innerHTML = lute.Md2HTML(markdown)
    expect(hookOf()?.(r.vditor, markdown)).toBe(true)
    vi.runAllTimers()
    expect(previewMorphModule.previewUnitCount?.(pane)).toBe(3)
    const div = divStarting(r.root, 'charlie')
    div.firstElementChild?.append('x')
    r.emit(unitChange(div))
    const { counts } = countBudget(r.root, () => {
      hookOf()?.(r.vditor)
      vi.runOnlyPendingTimers()
    })
    expect(counts.luteCalls).toBe(1)
    expect(pane.textContent).toContain('charliex')
  })

  // Task 733 run 1 repair (`edit-counter-gates:789`): the front-matter renderer adds a view-only table
  // after the front matter's `pre`. The unit baseline counts it with its unit, so the next key still
  // morphs one unit instead of rendering the pane whole.
  it('a view-only element a renderer adds is counted with its unit (733 run 1)', async () => {
    vi.useFakeTimers()
    const withFrontMatter = '---\ntitle: x\n---\n\nalpha\n\nbravo\n'
    const r = await rig(withFrontMatter)
    const pane = freshPane(r)
    const div = divStarting(r.root, 'bravo')
    r.emit(unitChange(div))
    expect(hookOf()?.(r.vditor)).toBe(true)
    vi.runAllTimers()
    // The front-matter observer adds its view-only table after the `pre` (in the page, after the job).
    const table = document.createElement('div')
    table.className = 'vmde-front-matter'
    table.setAttribute('data-render', '1')
    table.setAttribute('contenteditable', 'false')
    pane.querySelector(':scope > pre')?.after(table)
    div.firstElementChild?.append('x')
    r.emit(unitChange(div))
    const { counts } = countBudget(r.root, () => {
      hookOf()?.(r.vditor)
      vi.runOnlyPendingTimers()
    })
    expect(counts.luteCalls).toBe(1)
    expect(pane.textContent).toContain('bravox')
    expect(pane.querySelectorAll(':scope > .vmde-front-matter').length).toBe(1)
  })
})
