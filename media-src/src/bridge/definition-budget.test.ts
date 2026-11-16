// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type MovableBlock,
  scanMovableBlocks,
} from '../../../src/shared/block-move'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { definitionHeavyMarkdown } from '../../../test/vscode-e2e/definition-heavy-markdown'
import {
  countBudget,
  countedLute,
  type Factor,
} from '../testing/budget-harness'
import { createRealLute } from '../testing/real-lute'
import type { UnitsChange } from '../util/unit-changes'
import { createModelSession, type ModelSession } from './model-session'
import { createTextModel } from './text-model'
import { createUnitDom } from './unit-dom'
import type { UnitLute } from './unit-lute'

// Task 733 / 017 (Q-130): DEFINITION_UNITS ships false until the definition path is proven in VS Code;
// these tests prove that path, so they read the constant as true (the guard-off cases pass `false`).
vi.mock('../util/unit-changes', async (original) => ({
  ...(await original<typeof import('../util/unit-changes')>()),
  DEFINITION_UNITS: true,
}))

// Task 733 / 017-T1 (task 017 section 6.8): the bridge rows of the counted budget tests (B-03, B-05,
// B-09, B-16, B-17 of the D-13 design section 5.2) repeated on the definitions fixture with the real
// Lute and the ToC option on. Before 017-I1 the model is off for this document ('unit-without-kind'),
// so every row fails on its first assertion; after it, the rows hold the D-13 budgets with the
// definition, footnote and toc units present.

const UNITS_MODULE = './definition-units'
type ScanModel = (text: string, options: { toc: boolean }) => MovableBlock[]
let scanModel: ScanModel | undefined
let lute: UnitLute & { SetToC(on: boolean): void }
beforeAll(async () => {
  try {
    scanModel = (await import(/* @vite-ignore */ UNITS_MODULE)).scanModelBlocks
  } catch {
    scanModel = undefined
  }
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  real.lute.SetToC(true)
  lute = countedLute(real.lute)
})

interface Rig {
  session: ModelSession
  root: HTMLElement
  markdown: string
  changes: UnitsChange[]
  runFrames(): void
  offReason(): unknown
}
const sessions: ModelSession[] = []

function open(factor: Factor): Rig {
  const markdown = definitionHeavyMarkdown(factor)
  const root = document.createElement('pre')
  root.className = 'vditor-reset vditor-ir'
  document.body.append(root)
  root.innerHTML = lute.Md2VditorIRDOM(markdown)
  const frames: Array<() => void> = []
  const session = createModelSession({
    win: window,
    getRoot: () => root,
    getLute: () => lute,
    getMode: () => 'ir',
    isPreviewShowing: () => false,
    isStreaming: () => false,
    isComposing: () => false,
    e2e: true,
    countFallbackPublication: () => undefined,
    requestAnimationFrame: (cb) => frames.push(cb),
    cancelAnimationFrame: () => undefined,
    now: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    inViewport: () => false,
  })
  sessions.push(session)
  const changes: UnitsChange[] = []
  session.onUnitsChanged((change) => {
    changes.push(change)
  })
  session.onHostText(markdown, 1)
  session.onEditDomComplete()
  return {
    session,
    root,
    markdown,
    changes,
    runFrames: () => {
      for (const cb of frames.splice(0)) cb()
    },
    offReason: () =>
      (window as unknown as Record<string, { offReason?: unknown } | undefined>)
        .__vmdeModelShadowStats?.offReason,
  }
}

function expectLive(r: Rig): void {
  expect(
    r.offReason(),
    'model live over the definitions fixture',
  ).toBeUndefined()
  expect(r.session.liveUnits()).toBeDefined()
}

/** The paragraph, list item or definition element whose text starts with `prefix`. */
function blockStarting(r: Rig, selector: string, prefix: string): HTMLElement {
  for (const el of r.root.querySelectorAll<HTMLElement>(selector))
    if ((el.textContent ?? '').startsWith(prefix)) return el
  throw new Error(`no ${selector} starting with ${prefix}`)
}

/** Appends `text` to the first text node of `el` the way typing does (pre-touch first). */
function typeInto(el: HTMLElement, text: string): void {
  el.dispatchEvent(new Event('beforeinput', { bubbles: true }))
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const node = walker.nextNode() as Text
  node.data += text
}

/**
 * Enter in the middle of `item`, as the browser and the spin hook write it (the 012-12 B-03 drive): a new
 * `li` after the item (one child-list record on the list), then the spin pair rewrites both texts.
 */
function enterInItem(item: HTMLElement) {
  const list = item.parentElement as HTMLElement
  item.dispatchEvent(new Event('beforeinput', { bubbles: true }))
  const text = item.firstChild as Text
  const cut = Math.floor(text.data.length / 2)
  const fresh = document.createElement('li')
  for (const attribute of Array.from(item.attributes))
    fresh.setAttribute(attribute.name, attribute.value)
  fresh.textContent = text.data.slice(cut)
  item.after(fresh)
  text.data = text.data.slice(0, cut)
  return { list, item, fresh }
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose()
  document.body.replaceChildren()
})

describe.each<Factor>([1, 4, 16])(
  'definitions fixture at factor %i',
  (factor) => {
    it('B-03: a list item Enter is a non-whole change scoped to the two items', () => {
      const r = open(factor)
      expectLive(r)
      const { list, item, fresh } = enterInItem(
        blockStarting(r, 'li', 'list item 2'),
      )
      r.changes.length = 0
      r.session.confirmedUnits() // drains the batch
      r.runFrames()
      const frame = r.changes.filter((c) => c.cause === 'mutation')
      expect(frame).toHaveLength(1)
      const change = frame[0] as UnitsChange & {
        readonly scopes?: readonly HTMLElement[]
      }
      expect(change.whole).toBe(false)
      expect(change.scopes).toEqual([item, fresh])
      expect(change.changed.length).toBeLessThanOrEqual(2)
      expect(change.structural).toEqual([list])
    })

    it('B-05: the observer batch of an item insert reports only the inserted item', () => {
      const markdown = definitionHeavyMarkdown(factor)
      const root = document.createElement('pre')
      root.className = 'vditor-reset vditor-ir'
      document.body.append(root)
      root.innerHTML = lute.Md2VditorIRDOM(markdown)
      const seen: unknown[][] = []
      const unitDom = createUnitDom(root, lute, {
        // The third argument (`inserted`, D-13 section 1.2) is read through the rest parameter.
        onBatch: ((...args: unknown[]) => {
          seen.push(args)
        }) as never,
      })
      const model = createTextModel(unitDom, (text) =>
        scanModel ? scanModel(text, { toc: true }) : scanMovableBlocks(text),
      )
      model.build(markdown)
      expect(
        model.offReason,
        'model live over the definitions fixture',
      ).toBeUndefined()
      unitDom.attach(model)
      const item = Array.from(root.querySelectorAll('li')).find((li) =>
        (li.textContent ?? '').startsWith('list item 3'),
      ) as HTMLElement
      const added = item.cloneNode(true) as HTMLElement
      item.after(added)
      unitDom.drain()
      const inserted = seen.at(-1)?.[2] as ReadonlySet<HTMLElement> | undefined
      expect(inserted ? [...inserted] : undefined).toEqual([added])
      unitDom.detach()
    })

    it('B-09: definition, footnote and toc units prove with at most two Lute calls each, at every factor', () => {
      const r = open(factor)
      expectLive(r)
      const kinds = new Set(['definition', 'footnote', 'toc'])
      const units = (r.session.liveUnits() ?? []).filter((unit) =>
        kinds.has(unit.kind as string),
      )
      expect(units.length).toBe(6)
      const { counts } = countBudget(r.root, () => {
        r.runFrames()
      })
      expect(counts.luteCalls).toBeLessThanOrEqual(2 * units.length + 2)
    })

    it('B-16: typing in a referencing paragraph publishes with one unit-sized Lute call', () => {
      const r = open(factor)
      expectLive(r)
      const paragraph = blockStarting(r, 'p', 'First paragraph')
      typeInto(paragraph, 'x')
      const { result, counts } = countBudget(r.root, () =>
        r.session.deltaPort().prepareDelta(1),
      )
      expect(result).toMatchObject({ kind: 'changes' })
      expect(counts.luteCalls).toBeLessThanOrEqual(1)
      // The unit and its referenced definitions, never the document.
      expect(counts.luteChars).toBeLessThanOrEqual(
        paragraph.outerHTML.length + 400,
      )
    })

    it('B-17: typing in a definition publishes that line only, with no whole-document call', () => {
      const r = open(factor)
      expectLive(r)
      const definition = blockStarting(
        r,
        '[data-type="link-ref-defs-block"]',
        '[guide]',
      )
      typeInto(definition, '')
      ;(definition.firstChild as Text).data =
        '[guide]: https://example.com/guidex\n'
      const { result, counts } = countBudget(r.root, () =>
        r.session.deltaPort().prepareDelta(1),
      )
      expect(result).toMatchObject({
        kind: 'changes',
        changes: [{ insert: 'x' }],
      })
      expect(counts.luteChars).toBeLessThan(r.markdown.length / 4)
      // The definition stays where it was written: before the tables.
      expect(
        r.session.confirmedSnapshot()?.text.indexOf('guidex'),
      ).toBeLessThan(r.markdown.indexOf('## Tables'))
    })
  },
  // A live model over the factor-16 fixture takes seconds to build (more under a parallel run).
  60_000,
)
