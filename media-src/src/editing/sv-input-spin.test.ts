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
import { countBudget } from '../testing/budget-harness'
import {
  createRealLute,
  type RealLute,
  svBlocksHtml,
  svFixture,
} from '../testing/real-lute'
import type { UnitFeed } from '../util/unit-changes'

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

// Task 733 / 015-T1, S-05 (task 015 sections 6.2 D-3 and 6.9 item 2): the window hooks of the patched
// Source input. `__vmdeSvLocalSpin` decides whether the caret block is spun alone; `__vmdeSvPlaceCaret`
// finds the caret marker only in the elements the spin wrote and writes the selection once. Both read
// the Source feed (`sourceUnitFeedOf`, task 015 section 6.4). The installer name is provisional (task
// 015 section 6.4 names the hooks, not their installer; see the 015-T1 handoff). The modules are loaded
// by computed specifiers so this file typechecks before they exist.

interface SvInputSpinModule {
  installSourceInputHooks(win: Window): () => void
}
interface SourceFeedModule {
  provideSourceUnitFeed?(win: Window, feed: UnitFeed | undefined): void
}
interface Hooks {
  __vmdeSvLocalSpin?(vditor: unknown, block: HTMLElement): boolean
  __vmdeSvPlaceCaret?(
    vditor: unknown,
    before: Element | null,
    after: Element | null,
    range: Range,
  ): boolean
}
const SPIN: string = './sv-input-spin'
const CHANGES: string = '../util/unit-changes'
const hooks = () => window as unknown as Hooks
/** Lute's caret marker (`Lute.Caret`); the spin writes it back as a `wbr` element. */
const CARET = '\u2038'

let spin: RealLute
let uninstall: (() => void) | undefined
beforeAll(() => {
  spin = createRealLute('sv')
})
afterEach(async () => {
  uninstall?.()
  uninstall = undefined
  const feeds = (await import(/* @vite-ignore */ CHANGES)) as SourceFeedModule
  feeds.provideSourceUnitFeed?.(window, undefined)
  document.body.replaceChildren()
})

/** A live Source feed over `root` (the hooks read only `root` and `isLive`). */
const unsubscribe = (): void => undefined
function feedOf(root: HTMLElement, live = true): UnitFeed {
  return {
    root,
    isLive: () => live,
    liveUnitOf: () => undefined,
    liveUnits: () => undefined,
    onUnitsChanged: () => unsubscribe,
    confirmNow: () => live,
    confirmedLines: () => undefined,
  }
}

async function install(root: HTMLElement, live = true): Promise<void> {
  const feeds = (await import(/* @vite-ignore */ CHANGES)) as SourceFeedModule
  expect(typeof feeds.provideSourceUnitFeed).toBe('function')
  feeds.provideSourceUnitFeed?.(window, feedOf(root, live))
  const module = (await import(/* @vite-ignore */ SPIN)) as SvInputSpinModule
  uninstall = module.installSourceInputHooks(window)
}

const vditorOf = (root: HTMLElement) => ({
  currentMode: 'sv',
  sv: { element: root },
})

const divStarting = (root: HTMLElement, prefix: string): HTMLElement => {
  for (const child of Array.from(root.children))
    if (child.textContent?.startsWith(prefix)) return child as HTMLElement
  throw new Error(`no Source block starts with ${prefix}`)
}

describe('S-05 __vmdeSvLocalSpin', () => {
  beforeEach(() => {
    sourceUnitsOn.value = true
  })
  afterEach(() => {
    sourceUnitsOn.value = false
  })
  it('spins the caret block alone after a blank line', async () => {
    const root = svFixture('first\n\nsecond\n')
    await install(root)
    const block = divStarting(root, 'second')
    expect(hooks().__vmdeSvLocalSpin?.(vditorOf(root), block)).toBe(true)
  })
  it('spins the first block alone', async () => {
    const root = svFixture('first\n\nsecond\n')
    await install(root)
    expect(
      hooks().__vmdeSvLocalSpin?.(vditorOf(root), divStarting(root, 'first')),
    ).toBe(true)
  })
  it('keeps the upstream merge when the previous block no longer ends with a blank line', async () => {
    const root = svFixture('first\n\nsecond\n')
    await install(root)
    const first = divStarting(root, 'first')
    // The blank line between the two blocks was deleted: its two newline spans are gone.
    first.lastElementChild?.remove()
    expect(
      hooks().__vmdeSvLocalSpin?.(vditorOf(root), divStarting(root, 'second')),
    ).toBe(false)
  })
  it('keeps the upstream path for the root, front matter and a link reference definition', async () => {
    const root = svFixture('---\nb: c\n---\n\nz\n\n[r]: http://example.test\n')
    await install(root)
    const vditor = vditorOf(root)
    expect(hooks().__vmdeSvLocalSpin?.(vditor, root)).toBe(false)
    expect(hooks().__vmdeSvLocalSpin?.(vditor, divStarting(root, '---'))).toBe(
      false,
    )
    expect(hooks().__vmdeSvLocalSpin?.(vditor, divStarting(root, '[r]'))).toBe(
      false,
    )
  })
  it('keeps the upstream path while the Source feed is not live', async () => {
    const root = svFixture('first\n\nsecond\n')
    await install(root, false)
    expect(
      hooks().__vmdeSvLocalSpin?.(vditorOf(root), divStarting(root, 'second')),
    ).toBe(false)
  })
})

// Task 733 / 015: factors 4 and 16 build Source or IR fixtures of 51 KB and 208 KB with the real Lute in
// jsdom; the suite timeout is explicit (family rule 13.17).
const FIXTURE_TIMEOUT_MS = 30_000

describe.each([1, 4, 16] as const)(
  'S-05 __vmdeSvPlaceCaret at factor %i',
  { timeout: FIXTURE_TIMEOUT_MS },
  (factor) => {
    beforeEach(() => {
      sourceUnitsOn.value = true
    })
    afterEach(() => {
      sourceUnitsOn.value = false
    })
    const markdown = tableHeavyMarkdown(factor)

    it('finds the marker in the new elements only and flushes at most once', async () => {
      const root = svFixture(markdown)
      await install(root)
      const block = divStarting(root, 'Second paragraph')
      const before = block.previousElementSibling
      const after = block.nextElementSibling
      const text = block.textContent ?? ''
      // The patched input spins the block with the caret marker, as `inputEvent.ts:118-121` inserts it.
      block.outerHTML = svBlocksHtml(
        spin.render(`${text.slice(0, 6)}x${CARET}${text.slice(6)}`),
      )
      const range = document.createRange()
      const fresh: Element[] = []
      for (
        let el = before?.nextElementSibling ?? null;
        el && el !== after;
        el = el.nextElementSibling
      )
        fresh.push(el)
      const nodes = fresh.reduce(
        (sum, el) =>
          sum + el.getElementsByTagName('*').length + el.childNodes.length,
        0,
      )
      const { result, counts } = countBudget(root, () =>
        hooks().__vmdeSvPlaceCaret?.(vditorOf(root), before, after, range),
      )
      expect(result).toBe(true)
      expect(counts.rootQueries).toBe(0)
      expect(counts.flushes).toBeLessThanOrEqual(1)
      expect(counts.nodesWalked + counts.queriedNodes).toBeLessThanOrEqual(
        nodes + 8,
      )
      const selection = window.getSelection()
      expect(selection?.isCollapsed).toBe(true)
      expect(
        selection?.anchorNode &&
          fresh.some((el) => el.contains(selection.anchorNode)),
      ).toBe(true)
    })

    it('returns false when the new elements hold no marker', async () => {
      const root = svFixture(markdown)
      await install(root)
      const block = divStarting(root, 'Second paragraph')
      const range = document.createRange()
      expect(
        hooks().__vmdeSvPlaceCaret?.(
          vditorOf(root),
          block.previousElementSibling,
          block.nextElementSibling,
          range,
        ),
      ).toBe(false)
    })
  },
)
