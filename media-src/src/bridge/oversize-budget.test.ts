// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { scanMovableBlocks } from '../../../src/shared/block-move'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { countBudget, countedLute, costClock } from '../testing/budget-harness'
import { createRealLute } from '../testing/real-lute'
import { installModelSync } from './model-structure'
import {
  createTextModel,
  type TextModel,
  type Unit,
  type UnitHost,
} from './text-model'
import { createUnitDom, type UnitDomControl } from './unit-dom'
import type { UnitLute } from './unit-lute'
import { createUnitSchedule, type UnitScheduleDeps } from './unit-schedule'

// Task 733 / 012-20, B-18 (D-13 design section 5.2): the guard of the dropped task 016. An edit in
// an oversize unit publishes through the edit path with one Lute call whose input is that unit,
// never the document, and never through the whole-text fallback (`fullGetValue`). The list
// publishes per item. The proof of an oversize paragraph or quote takes the oversize queue of
// `unit-schedule` (`OVERSIZE_HTML`). A publication here is `model.sync()` after the mutation
// records are drained; a sync that answers `fallback` is the route that reads the whole document
// through `getValue` in the webview, so it is counted as `fullGetValue`.

type U = Unit<HTMLElement>
type Model = TextModel<HTMLElement>

/** `OVERSIZE_HTML` of `unit-schedule.ts`: a block unit with longer HTML is proven only in idle time. */
const OVERSIZE_HTML = 20000

/** Wall-time limit of one case: a 5,000-item list with real Lute is slow under a loaded machine. */
const CASE_TIMEOUT_MS = 30_000

const WORDS = 2000
const QUOTE_LINES = 300
const ITEMS = 5000

/** The gate fixtures of 016: a 2,000-word paragraph, a 300-line quote and a 5,000-item list. */
function oversizeMarkdown(): string {
  const words: string[] = []
  for (let i = 1; i <= WORDS; i++) words.push(`paragraph${i}`)
  const quote: string[] = []
  for (let i = 1; i <= QUOTE_LINES; i++)
    quote.push(
      `> quoted line ${i} of the long block quote, plain words only, and a few more words to fill it`,
    )
  const items: string[] = []
  for (let i = 1; i <= ITEMS; i++) items.push(`- list item ${i}`)
  return `${[
    '# Oversize units',
    words.join(' '),
    quote.join('\n'),
    items.join('\n'),
    'Closing paragraph.',
  ].join('\n\n')}\n`
}

// The schedule's injected background scheduler, when the module exists (D-13 design section 1.1).
// The module is loaded by a computed specifier so this file typechecks before the module exists.
interface SchedulerModule {
  createBackgroundScheduler(deps: {
    now(): number
    requestAnimationFrame(callback: () => void): number
    cancelAnimationFrame(handle: number): void
    requestIdle(
      callback: (deadline: { timeRemaining(): number }) => void,
    ): number
    cancelIdle(handle: number): void
    inputPending(): boolean
  }): unknown
}
const SCHEDULER_MODULE: string = '../util/background-budget'
let schedulerModule: SchedulerModule | undefined

let lute: UnitLute
let markdown: string
beforeAll(async () => {
  schedulerModule = (await import(/* @vite-ignore */ SCHEDULER_MODULE).catch(
    () => undefined,
  )) as SchedulerModule | undefined
  installModelSync()
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  // Counting wraps the patched methods, so every call of the model's Lute is counted.
  lute = countedLute(real.lute)
  markdown = oversizeMarkdown()
})

const attached: UnitDomControl[] = []
afterEach(() => {
  for (const dom of attached.splice(0)) dom.detach()
  document.body.replaceChildren()
})

interface Session {
  root: HTMLElement
  dom: UnitHost<HTMLElement> & UnitDomControl
  model: Model
}

function open(): Session {
  const root = document.createElement('div')
  root.className = 'vditor-reset vditor-ir'
  root.innerHTML = lute.Md2VditorIRDOM(markdown)
  document.body.appendChild(root)
  const dom = createUnitDom(root, lute)
  const model = createTextModel(dom, scanMovableBlocks)
  model.build(markdown)
  expect(model.state, String(model.offReason)).toBe('live')
  dom.attach(model)
  attached.push(dom)
  return { root, dom, model }
}

/** The HTML length the schedule's oversize bound reads (as `model-session.ts` computes it). */
const htmlLength = (unit: U): number =>
  unit.members.reduce((sum, el) => sum + el.outerHTML.length, 0)

const unitOfKind = (model: Model, kind: U['kind']): U => {
  const unit = model.units.find((candidate) => candidate.kind === kind)
  if (!unit) throw new Error(`no ${kind} unit`)
  return unit
}

/** Proves every unit with the schedule's idle frames; returns the units proven in each frame. */
function proveAll(session: Session): {
  perFrame: U[][]
  preTouch: 'proven' | 'fallback'
  preTouchReason: string | undefined
  paragraph: U
  quote: U
} {
  const { root, dom, model } = session
  const clock = costClock()
  let nextHandle = 1
  let frames = new Map<number, () => void>()
  const lanes = {
    now: () => clock.now(),
    requestAnimationFrame(callback: () => void): number {
      const handle = nextHandle++
      frames.set(handle, callback)
      return handle
    },
    cancelAnimationFrame(handle: number): void {
      frames.delete(handle)
    },
    requestIdle: (): number => 0,
    cancelIdle: (): void => undefined,
    inputPending: (): boolean => false,
  }
  const proven: U[] = []
  const deps = {
    model: {
      units: model.units,
      unitOf: (el: HTMLElement) => model.unitOf(el),
      prove: (unit: U, spent?: () => boolean) => {
        const result = model.prove(unit, spent)
        if (result === 'proven' || result === 'opaque') proven.push(unit)
        // Every proof charges one Lute call on the cost clock, so a frame holds a few of them.
        clock.advance(0.5)
        return result
      },
      markDirty: (unit: U) => model.markDirty(unit),
      markStructureDirty: (scope: 'root' | U) =>
        model.markStructureDirty(scope),
    },
    root,
    serialize: (kind: U['kind'], members: readonly HTMLElement[]) =>
      dom.serialize(kind, members),
    htmlLength,
    inViewport: () => false,
    isActive: () => true,
    drain: () => dom.drain(),
    ...lanes,
    scheduler: schedulerModule?.createBackgroundScheduler(lanes),
    setTimeout: (): number => 0,
    clearTimeout: (): void => undefined,
  }
  const schedule = createUnitSchedule(deps as UnitScheduleDeps)
  const paragraph = model.units.find(
    (unit) => unit.kind === 'paragraph' && htmlLength(unit) > OVERSIZE_HTML,
  ) as U
  const quote = unitOfKind(model, 'quote')
  // Before its idle proof, a pre-touch of the oversize paragraph answers the fallback.
  const range = document.createRange()
  range.selectNodeContents(paragraph.el as HTMLElement)
  const preTouch = schedule.proveForSelection(range)
  const preTouchReason = schedule.lastFallbackReason()
  schedule.start()
  const perFrame: U[][] = []
  for (let frame = 0; frame < 20_000 && frames.size > 0; frame++) {
    const before = proven.length
    const due = frames
    frames = new Map()
    for (const callback of due.values()) callback()
    perFrame.push(proven.slice(before))
  }
  schedule.stop()
  expect(frames.size, 'frames left after the proofs').toBe(0)
  return { perFrame, preTouch, preTouchReason, paragraph, quote }
}

/** One publication: drain the records, sync, and count the Lute calls and the route. */
function publish(
  session: Session,
  edit: () => void,
): {
  route: 'edit-path' | 'fallback'
  fullGetValue: number
  luteCalls: number
  largestCall: number
} {
  const { root, dom, model } = session
  edit()
  let largestCall = 0
  const { result, counts } = countBudget(root, () => {
    dom.drain()
    // The largest single call: the harness sums input lengths, so each call is measured alone.
    const original = lute.VditorIRDOM2Md
    lute.VditorIRDOM2Md = (html: string) => {
      largestCall = Math.max(largestCall, html.length)
      return original.call(lute, html)
    }
    try {
      return model.sync()
    } finally {
      lute.VditorIRDOM2Md = original
    }
  })
  return {
    route: result.kind === 'changes' ? 'edit-path' : 'fallback',
    fullGetValue: result.kind === 'fallback' ? 1 : 0,
    luteCalls: counts.luteCalls,
    largestCall,
  }
}

const lastText = (element: Element): Text => {
  const walker = element.ownerDocument.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
  )
  let last: Text | undefined
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if ((node as Text).data.trim() !== '') last = node as Text
  if (!last) throw new Error('no text')
  return last
}

describe('B-18 oversize units', () => {
  it(
    'the fixture holds an oversize paragraph and quote and a 5,000-item list',
    () => {
      const { model } = open()
      const paragraph = model.units.find((unit) => unit.kind === 'paragraph')
      expect(paragraph && htmlLength(paragraph)).toBeGreaterThan(OVERSIZE_HTML)
      expect(htmlLength(unitOfKind(model, 'quote'))).toBeGreaterThan(
        OVERSIZE_HTML,
      )
      expect(
        model.units.filter((unit) => unit.kind === 'list-item'),
      ).toHaveLength(ITEMS)
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'proves the paragraph and the quote through the oversize queue: last, one per frame',
    () => {
      const session = open()
      const { perFrame, preTouch, preTouchReason, paragraph, quote } =
        proveAll(session)
      expect(preTouch).toBe('fallback')
      expect(preTouchReason).toBe('oversize-unit')
      const frameOf = (unit: U): number =>
        perFrame.findIndex((proven) => proven.includes(unit))
      const paragraphFrame = frameOf(paragraph)
      const quoteFrame = frameOf(quote)
      expect(paragraphFrame).toBeGreaterThan(-1)
      expect(quoteFrame).toBeGreaterThan(-1)
      // Oversize units follow every other unit, at most one per frame: each is the last proof of its
      // frame, and the two take different frames.
      expect(perFrame[paragraphFrame].at(-1)).toBe(paragraph)
      expect(perFrame[quoteFrame].at(-1)).toBe(quote)
      expect(paragraphFrame).not.toBe(quoteFrame)
      const lastOther = Math.max(
        ...session.model.units
          .filter((unit) => unit !== paragraph && unit !== quote)
          .map(frameOf),
      )
      // The first oversize proof may share the frame in which the other units finish.
      expect(Math.min(paragraphFrame, quoteFrame)).toBeGreaterThanOrEqual(
        lastOther,
      )
      expect(paragraph.proof).toBe('proven')
      expect(quote.proof).toBe('proven')
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'publishes the paragraph with one Lute call no longer than its HTML, without the fallback',
    () => {
      const session = open()
      const { paragraph } = proveAll(session)
      const unitHtml = htmlLength(paragraph)
      const result = publish(session, () => {
        lastText(paragraph.el as HTMLElement).data += ' edited'
      })
      expect(result.route).toBe('edit-path')
      expect(result.fullGetValue).toBe(0)
      expect(result.luteCalls).toBe(1)
      expect(result.largestCall).toBeGreaterThan(0)
      expect(result.largestCall).toBeLessThanOrEqual(
        unitHtml + ' edited'.length,
      )
      expect(session.model.text).toContain('paragraph2000 edited')
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'publishes the quote with one Lute call no longer than its HTML, without the fallback',
    () => {
      const session = open()
      const { quote } = proveAll(session)
      const unitHtml = htmlLength(quote)
      const result = publish(session, () => {
        lastText(quote.el as HTMLElement).data += ' edited'
      })
      expect(result.route).toBe('edit-path')
      expect(result.fullGetValue).toBe(0)
      expect(result.luteCalls).toBe(1)
      expect(result.largestCall).toBeGreaterThan(0)
      expect(result.largestCall).toBeLessThanOrEqual(
        unitHtml + ' edited'.length,
      )
      expect(session.model.text).toContain('to fill it edited')
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'publishes one item of the 5,000-item list with calls no longer than that item',
    () => {
      const session = open()
      proveAll(session)
      const items = session.model.units.filter(
        (unit) => unit.kind === 'list-item',
      )
      const item = items[ITEMS / 2]
      const list = (item.el as HTMLElement).parentElement as HTMLElement
      const openTag = (list.cloneNode(false) as HTMLElement).outerHTML.length
      const largestItem = Math.max(...items.map(htmlLength))
      const result = publish(session, () => {
        lastText(item.el as HTMLElement).data += ' edited'
      })
      expect(result.route).toBe('edit-path')
      expect(result.fullGetValue).toBe(0)
      expect(result.luteCalls).toBeLessThanOrEqual(1)
      // The item path serializes the item inside an empty copy of its list, never the list.
      expect(result.largestCall).toBeLessThanOrEqual(
        largestItem + ' edited'.length + openTag,
      )
      expect(session.model.text).toContain(
        `- list item ${ITEMS / 2 + 1} edited`,
      )
    },
    CASE_TIMEOUT_MS,
  )
})
