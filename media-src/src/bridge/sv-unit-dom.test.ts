// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { MovableBlock } from '../../../src/shared/block-move'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import { countBudget, countedLute } from '../testing/budget-harness'
import {
  createRealLute,
  type RealLute,
  svBlocksHtml,
  svFixture,
} from '../testing/real-lute'
import { svSourceDerivesFrom } from './sv-source-relation'
import { createTextModel, type TextModel, type UnitHost } from './text-model'
import type { UnitDomControl } from './unit-dom'

// Task 733 / 015-T1 (task 015 sections 6.2 D-1, D-2, D-4 and 6.3): the Source unit host and the text
// model over Vditor's Source DOM. S-02 build, S-03 publication of one key, S-04 a split and a merge,
// S-08 the one-block shape of today's Source `setValue`, S-12 the guard constant. A key is simulated
// the way the patched Source input (V-S1) handles it: the caret block's text is spun alone and its div
// is replaced by the split spin output. The modules are loaded by computed specifiers so this file
// typechecks before they exist; the signatures are those of task 015 section 6.4.

type Batch = (
  changed: ReadonlySet<unknown>,
  structure: ReadonlySet<unknown>,
  inserted: ReadonlySet<HTMLElement>,
) => void
interface SvUnitsModule {
  createSourceUnitDom(
    root: HTMLElement,
    options: { onBatch?: Batch },
  ): UnitHost<HTMLElement> & UnitDomControl
}
interface SvChunksModule {
  scanSourceChunks(markdown: string): MovableBlock[]
}
interface UnitChangesModule {
  SOURCE_UNITS?: unknown
}
const UNITS: string = './sv-units'
const CHUNKS: string = './sv-chunks'
const CHANGES: string = '../util/unit-changes'
const loadUnits = async (): Promise<SvUnitsModule> =>
  (await import(/* @vite-ignore */ UNITS)) as SvUnitsModule
const loadChunks = async (): Promise<SvChunksModule> =>
  (await import(/* @vite-ignore */ CHUNKS)) as SvChunksModule

let spin: RealLute
beforeAll(() => {
  spin = createRealLute('sv')
  countedLute(spin.lute)
})
afterEach(() => {
  document.body.replaceChildren()
})

interface Rig {
  root: HTMLElement
  dom: UnitHost<HTMLElement> & UnitDomControl
  model: TextModel<HTMLElement>
  inserted: HTMLElement[]
}

interface Modules {
  units: SvUnitsModule
  chunks: SvChunksModule
}
const loadModules = async (): Promise<Modules> => ({
  units: await loadUnits(),
  chunks: await loadChunks(),
})

/** Builds the Source host and the text model over `root` synchronously (so a count can wrap it). */
function build(modules: Modules, markdown: string, root: HTMLElement): Rig {
  const inserted: HTMLElement[] = []
  const dom = modules.units.createSourceUnitDom(root, {
    onBatch: (_changed, _structure, added) => {
      for (const el of added) inserted.push(el)
    },
  })
  const model = createTextModel(dom, modules.chunks.scanSourceChunks)
  model.build(markdown)
  dom.attach(model)
  return { root, dom, model, inserted }
}

async function open(
  markdown: string,
  root = svFixture(markdown),
): Promise<Rig> {
  return build(await loadModules(), markdown, root)
}

/** `serializeSvForHost` (`B/edit-sync.ts:573-586`): the whole Source text the fallback posts. */
function wholeSourceText(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement
  clone
    .querySelector(
      ':scope > [data-block]:last-child > [data-type="newline"]:last-child',
    )
    ?.remove()
  return (clone.textContent ?? '').replace(/\u200B(?=\n*$)/gu, '')
}

/**
 * The unit path's text equals the fallback's whole Source text up to the tail rule of
 * `sv-source-relation` (`svSourceDerivesFrom`): a document that ends with a table leaves an empty div,
 * so the fallback shows one more trailing line break; the unit path keeps the host's tail. Nothing else
 * may differ, so the fallback text must start with the unit text.
 */
function expectSourceText(model: string, root: HTMLElement): void {
  const whole = wholeSourceText(root)
  expect(whole.startsWith(model)).toBe(true)
  expect(svSourceDerivesFrom(model, whole)).toBe(true)
}

const divStarting = (root: HTMLElement, prefix: string): HTMLElement => {
  for (const child of Array.from(root.children))
    if (child.textContent?.startsWith(prefix)) return child as HTMLElement
  throw new Error(`no Source block starts with ${prefix}`)
}

/** Replaces `div` by the split spin of `text`, as the patched Source input does for the caret block. */
function respin(div: HTMLElement, text: string): void {
  div.outerHTML = svBlocksHtml(spin.render(text))
}

/** Types `insert` at `offset` of the block's text. */
function typeInto(div: HTMLElement, offset: number, insert: string): void {
  const text = div.textContent ?? ''
  respin(div, text.slice(0, offset) + insert + text.slice(offset))
}

const PLACES = [
  { name: 'paragraph', prefix: 'Second paragraph' },
  { name: 'table', prefix: '| Name' },
  { name: 'list', prefix: '- list item' },
  { name: 'code block', prefix: '```ts' },
] as const

// Task 733 / 015: factors 4 and 16 build Source or IR fixtures of 51 KB and 208 KB with the real Lute in
// jsdom; the suite timeout is explicit (family rule 13.17).
const FIXTURE_TIMEOUT_MS = 30_000

describe.each([1, 4, 16] as const)(
  'factor %i',
  { timeout: FIXTURE_TIMEOUT_MS },
  (factor) => {
    const markdown = tableHeavyMarkdown(factor)

    it('S-02 builds live with no Lute call', async () => {
      const modules = await loadModules()
      const root = svFixture(markdown)
      const { counts, result: r } = countBudget(root, () =>
        build(modules, markdown, root),
      )
      expect(r.model.state).toBe('live')
      expect(counts.luteCalls).toBe(0)
      expect(r.model.text).toBe(markdown)
    })

    it.each(PLACES)(
      'S-03 publishes one key in the $name by its unit only',
      async (place) => {
        const r = await open(markdown)
        const div = divStarting(r.root, place.prefix)
        typeInto(div, 2, 'x')
        const { result, counts } = countBudget(r.root, () => {
          r.dom.drain()
          return r.model.sync(1)
        })
        expect(result.kind).toBe('changes')
        if (result.kind !== 'changes') return
        expect(result.changes).toHaveLength(1)
        expect(counts.luteCalls).toBe(0)
        expect(counts.rootQueries).toBe(0)
        expect(counts.innerHtmlReads).toBe(0)
        expectSourceText(r.model.text, r.root)
      },
    )

    it('S-04 a typed blank line splits the unit within its window', async () => {
      const r = await open(markdown)
      const div = divStarting(r.root, 'Second paragraph')
      const before = r.model.text.indexOf('Second paragraph')
      typeInto(div, 6, '\n\n')
      r.dom.drain()
      const result = r.model.sync(1)
      expect(result.kind).toBe('changes')
      if (result.kind !== 'changes') return
      for (const change of result.changes) {
        expect(change.from).toBeGreaterThanOrEqual(before)
        expect(change.to).toBeLessThanOrEqual(before + 80)
      }
      expectSourceText(r.model.text, r.root)
      // The second half is a div the spin inserted: it is reported to `onBatch`.
      expect(r.inserted.length).toBeGreaterThan(0)
    })

    it('S-04 a deleted blank line merges two units within their window', async () => {
      const r = await open(markdown)
      const first = divStarting(r.root, 'First paragraph')
      const second = divStarting(r.root, 'Second paragraph')
      const joined = `${(first.textContent ?? '').replace(/\n\n$/u, '\n')}${second.textContent ?? ''}`
      second.remove()
      respin(first, joined)
      r.dom.drain()
      const result = r.model.sync(1)
      expect(result.kind).toBe('changes')
      expectSourceText(r.model.text, r.root)
    })

    it("S-08 today's one-block Source setValue shape keeps the model off", async () => {
      const root = document.createElement('pre')
      root.className = 'vditor-sv vditor-reset'
      // `V/index.ts:317`: the whole spin in one `data-block`, no split.
      root.innerHTML = `<div data-block='0'>${spin.render(markdown)}</div>`
      document.body.append(root)
      const r = await open(markdown, root)
      expect(r.model.state).toBe('off')
    })
  },
)

describe('S-02 forms (D-4)', () => {
  it('keeps the host bytes of a unit the spin reformatted until that unit changes', async () => {
    const host = '3. x\n5. y\n\nlast paragraph\n'
    const r = await open(host)
    // The spin renumbers the list (`5.` shown as `4.`), yet the model holds the host bytes.
    expect(r.root.textContent).toContain('4. y')
    expect(r.model.text).toBe(host)
    typeInto(divStarting(r.root, 'last'), 4, 'x')
    r.dom.drain()
    r.model.sync(1)
    expect(r.model.text).toBe('3. x\n5. y\n\nlastx paragraph\n')
  })

  it('S-01 an unlisted shape keeps the model off instead of guessing', async () => {
    const root = svFixture('a\n\nb\n')
    // A div the scanner cannot pair: the chunk count no longer matches the units.
    root.append(root.firstElementChild?.cloneNode(true) as HTMLElement)
    const r = await open('a\n\nb\n', root)
    expect(r.model.state).toBe('off')
  })
})

describe('S-12 guard constant', () => {
  it('SOURCE_UNITS is a boolean of util (task 015 section 6.9 item 1)', async () => {
    const changes = (await import(
      /* @vite-ignore */ CHANGES
    )) as UnitChangesModule
    expect(typeof changes.SOURCE_UNITS).toBe('boolean')
  })
})
