// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { countedLute } from '../testing/budget-harness'
import {
  createRealLute,
  type RealLute,
  svBlocksHtml,
  svFixture,
} from '../testing/real-lute'
import type { HistoryCapture, HistoryModelPort } from '../util/unit-changes'
import { scanSourceChunks } from './sv-chunks'
import { createSourceUnitDom } from './sv-units'
import { createTextModel, type TextModel, type Unit } from './text-model'

// Task 733 / 019 (D-7 of the Source design, Q-154): the history port of the Source model. A capture is
// the run of Source divs whose outer HTML changed since the previous capture; a restore puts one side
// back after checking every window. The port is loaded by a computed specifier so this file typechecks
// before the export exists.

interface SourceHistoryCapture {
  readonly port: HistoryModelPort
  onBatch(
    changed: ReadonlySet<Unit<HTMLElement>>,
    structure: ReadonlySet<'root' | Unit<HTMLElement>>,
  ): void
  hold(): void
  invalidate(): void
}
interface SourceHistoryModule {
  createSourceHistoryCapture?(deps: {
    model(): TextModel<HTMLElement> | undefined
    root(): HTMLElement | undefined
    drain(): void
    ready(): boolean
    claimable(): boolean
  }): SourceHistoryCapture
}
const UNITS: string = './sv-units'

let spin: RealLute
beforeAll(() => {
  spin = createRealLute('sv')
  countedLute(spin.lute)
})
afterEach(() => {
  document.body.replaceChildren()
})

const MARKDOWN = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n'

interface Rig {
  root: HTMLElement
  model: TextModel<HTMLElement>
  history: SourceHistoryCapture
}

async function open(markdown = MARKDOWN): Promise<Rig> {
  const module = (await import(/* @vite-ignore */ UNITS)) as SourceHistoryModule
  expect(typeof module.createSourceHistoryCapture).toBe('function')
  const root = svFixture(markdown)
  let history: SourceHistoryCapture | undefined
  const dom = createSourceUnitDom(root, {
    onBatch: (changed, structure) => history?.onBatch(changed, structure),
  })
  const model = createTextModel(dom, scanSourceChunks)
  model.build(markdown)
  dom.attach(model)
  history = module.createSourceHistoryCapture?.({
    model: () => model,
    root: () => root,
    drain: () => dom.drain(),
    ready: () => true,
    claimable: () => true,
  })
  return { root, model, history: history as SourceHistoryCapture }
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

/** The first Text node of `div` gets `insert` at `offset` in place (no spin). */
function typeInPlace(div: HTMLElement, offset: number, insert: string): void {
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT)
  const text = walker.nextNode() as Text
  text.insertData(offset, insert)
}

describe('Source history port (019)', () => {
  it('a one-unit edit gives one window, and restoring before puts the old div back', async () => {
    const r = await open()
    expect(r.history.port.capture()).toBeUndefined()
    const second = divStarting(r.root, 'Second')
    const before = second.outerHTML
    const first = divStarting(r.root, 'First')
    const third = divStarting(r.root, 'Third')
    typeInPlace(second, 6, 'X')
    expect(r.history.port.pending()).toBe(true)
    const capture = r.history.port.capture() as HistoryCapture
    expect(capture).toBeDefined()
    expect(r.history.port.restore(capture, 'before')).toBe(true)
    // The window held one unit: the neighbours stay the same nodes.
    expect(r.root.children[0]).toBe(first)
    expect(r.root.children[2]).toBe(third)
    expect((r.root.children[1] as HTMLElement).outerHTML).toBe(before)
    expect(r.history.port.restore(capture, 'after')).toBe(true)
    expect(r.root.children[1]?.textContent?.startsWith('SecondX')).toBe(true)
  })

  it('a stale anchor answers false and writes nothing', async () => {
    const r = await open()
    const second = divStarting(r.root, 'Second')
    typeInPlace(second, 6, 'X')
    const capture = r.history.port.capture() as HistoryCapture
    expect(capture).toBeDefined()
    // The window's current HTML is no longer the capture's `after`.
    typeInPlace(divStarting(r.root, 'SecondX'), 0, 'Y')
    const html = r.root.innerHTML
    expect(r.history.port.restore(capture, 'before')).toBe(false)
    expect(r.root.innerHTML).toBe(html)
  })

  it('a spin that inserted a div widens the window to the divs it replaced', async () => {
    const r = await open()
    const original = r.root.innerHTML
    const second = divStarting(r.root, 'Second')
    const text = second.textContent ?? ''
    // Enter twice in the middle of the paragraph: the spin gives two divs where there was one.
    respin(second, `${text.slice(0, 6)}\n\n${text.slice(6)}`)
    expect(r.root.children.length).toBe(4)
    const capture = r.history.port.capture() as HistoryCapture
    expect(capture).toBeDefined()
    expect(r.history.port.restore(capture, 'before')).toBe(true)
    expect(r.root.innerHTML).toBe(original)
  })

  it('a restored div holds the Source text the caret offsets of Undo and Redo refer to (019-A2)', async () => {
    const r = await open()
    const second = divStarting(r.root, 'Second')
    const start = r.root.textContent?.indexOf('Second') ?? -1
    // Four keys typed at offset 6 of the unit, as one history step.
    const text = second.textContent ?? ''
    respin(second, `${text.slice(0, 6)}WXYZ${text.slice(6)}`)
    const capture = r.history.port.capture() as HistoryCapture
    expect(r.history.port.restore(capture, 'before')).toBe(true)
    // After Undo the caret belongs where the first key was typed: that offset holds the old text.
    expect(r.root.textContent?.slice(start, start + 7)).toBe('Second ')
    expect(r.root.children[1]?.isConnected).toBe(true)
    expect(r.history.port.restore(capture, 'after')).toBe(true)
    // After Redo the caret belongs after the fourth key.
    expect(r.root.textContent?.slice(start, start + 10)).toBe('SecondWXYZ')
  })
})
