// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { createRealLute } from '../testing/real-lute'
import type { HistoryCapture } from '../util/unit-changes'
import { createModelSession, type ModelSession } from './model-session'
import type { UnitLute } from './unit-lute'

// Task 733 / 017 (Q-130): DEFINITION_UNITS ships false until the definition path is proven in VS Code;
// these tests prove that path, so they read the constant as true.
vi.mock('../util/unit-changes', async (original) => ({
  ...(await original<typeof import('../util/unit-changes')>()),
  DEFINITION_UNITS: true,
}))
vi.mock('vditor/src/ts/util/processCode', () => ({
  processCodeRender: vi.fn(),
}))

// Task 733 / 021 (design 021 sections 3.2, 3.3 and 7.2): edits of definition and footnote units over a
// real text model, real Lute and a jsdom IR root. The pre-touch proof reaches a footnote definition
// (D-4); the history capture treats a footnote definition as an item of its footnotes block (D-3a,
// D-3c) and survives a failed form hand-over; a restored definition reaches the definition index
// (D-3b). Fails before 021-I by assertion.

let lute: UnitLute
beforeAll(() => {
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  lute = real.lute
})

interface Port {
  capture(): HistoryCapture | undefined
  restore(capture: HistoryCapture, side: 'before' | 'after'): boolean
}
type WithPort = ModelSession & { historyPort(): Port }
interface Stats {
  state: string
  units: number
  proven: number
}

const DOC =
  'See note[^note] and [guide].\n\n[guide]: https://example.com/guide\n\nMiddle para.\n\n[^note]: The first note.\n\n[^two]: The second note.\n'
const RENAMED = DOC.replace('[guide]: ', '[guidex]: ')
const EDITED = DOC.replace('The first note.', 'The first note. More')

const live: ModelSession[] = []
const frames: Array<() => void> = []

const stats = (): Stats =>
  (window as unknown as { __vmdeModelShadowStats: Stats })
    .__vmdeModelShadowStats

function open(markdown: string) {
  const root = document.createElement('div')
  root.className = 'vditor-reset vditor-ir'
  document.body.appendChild(root)
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
  live.push(session)
  frames.length = 0
  root.innerHTML = lute.Md2VditorIRDOM(markdown)
  session.onHostText(markdown, 1)
  session.onEditDomComplete()
  const port = (session as WithPort).historyPort()
  const delta = session.deltaPort()
  let sequence = 0
  return {
    root,
    session,
    port,
    delta,
    /** One publication's sync; the result kind and, for a fallback, its reason. */
    prepare(): { kind: string; reason?: string } {
      sequence += 1
      return delta.prepareDelta(sequence) as { kind: string; reason?: string }
    },
    /** A sync that must not fall back; returns the model text. */
    sync(): string | undefined {
      sequence += 1
      const result = delta.prepareDelta(sequence) as {
        kind: string
        reason?: string
      }
      expect(result.kind, `sync result (${result.reason ?? ''})`).not.toBe(
        'fallback',
      )
      return delta.modelText()
    },
    /** Runs frames and waits until every unit is proven (at most 2 s). */
    async allProven(): Promise<void> {
      for (let i = 0; i < 40; i++) {
        for (const cb of frames.splice(0)) cb()
        if (stats()?.proven === stats()?.units) return
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(stats()?.proven, 'every unit proven').toBe(stats()?.units)
    },
  }
}
type Rig = ReturnType<typeof open>

afterEach(() => {
  for (const session of live.splice(0)) session.dispose()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const footnoteParagraphs = (r: Rig): HTMLElement[] =>
  Array.from(
    r.root.querySelectorAll<HTMLElement>('[data-type="footnotes-def"] p'),
  )
const definitionOf = (r: Rig): HTMLElement =>
  r.root.querySelector('[data-type="link-ref-defs-block"]') as HTMLElement

function caretIn(node: Node, offset: number): void {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  getSelection()?.removeAllRanges()
  getSelection()?.addRange(range)
}

/** Types the footnote edit the way the editor does: the pre-touch proof runs before the DOM changes. */
function editFirstNote(r: Rig): void {
  const p = footnoteParagraphs(r)[0]
  caretIn(p.firstChild as Text, 3)
  p.dispatchEvent(new Event('beforeinput', { bubbles: true }))
  ;(p.firstChild as Text).data = 'The first note. More'
}

/** Renames `[guide]` to `[guidex]` in place, after the pre-touch event. */
function renameGuide(r: Rig): void {
  const def = definitionOf(r)
  const text = def.firstChild as Text
  caretIn(text, 3)
  def.dispatchEvent(new Event('beforeinput', { bubbles: true }))
  text.data = text.data.replace('[guide]', '[guidex]')
}

describe('pre-touch proof of footnote units (D-4)', () => {
  it('a caret in a footnote definition proves that footnote', () => {
    const r = open(DOC)
    expect(stats().proven).toBe(0)
    const p = footnoteParagraphs(r)[0]
    caretIn(p.firstChild as Text, 3)
    p.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    expect(stats().proven).toBe(1)
  })

  it('a selection across two footnote definitions proves both', () => {
    const r = open(DOC)
    expect(stats().proven).toBe(0)
    const [first, second] = footnoteParagraphs(r)
    const range = document.createRange()
    range.setStart(first.firstChild as Text, 2)
    range.setEnd(second.firstChild as Text, 2)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
    first.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    expect(stats().proven).toBe(2)
  })

  it('typing in an unproven footnote publishes a delta', () => {
    const r = open(DOC)
    editFirstNote(r)
    const result = r.prepare()
    expect(result.kind, `sync result (${result.reason ?? ''})`).not.toBe(
      'fallback',
    )
    expect(r.delta.modelText()).toContain('[^note]: The first note. More')
  })
})

describe('history capture of footnote units (D-3a, D-3c)', () => {
  it('Undo and Redo of a footnote edit keep the footnotes block', async () => {
    const r = open(DOC)
    await r.allProven()
    expect(r.port.capture()).toBeUndefined()
    editFirstNote(r)
    const capture = r.port.capture() as HistoryCapture
    expect(capture).toBeDefined()
    expect(r.sync()).toBe(EDITED)
    expect(r.port.restore(capture, 'before')).toBe(true)
    const last = r.root.lastElementChild as HTMLElement
    expect(last.getAttribute('data-type')).toBe('footnotes-block')
    expect(last.children).toHaveLength(2)
    expect(r.sync()).toBe(DOC)
    expect(r.port.restore(capture, 'after')).toBe(true)
    expect(r.sync()).toContain('The first note. More')
  })

  it('a root window over a document with footnotes restores only the changed definition', async () => {
    const r = open(DOC)
    await r.allProven()
    expect(r.port.capture()).toBeUndefined()
    const blocks = Array.from(
      r.root.querySelectorAll('[data-type="footnotes-block"]'),
    )
    // The view-only gap paragraph of a click above the first block (E/gap-click.ts), added and removed.
    const gap = document.createElement('p')
    gap.setAttribute('data-block', '0')
    gap.setAttribute('data-vmde-gap', '')
    gap.textContent = '​'
    r.root.firstElementChild?.before(gap)
    gap.remove()
    renameGuide(r)
    const capture = r.port.capture() as HistoryCapture
    expect(capture).toBeDefined()
    expect(r.sync()).toBe(RENAMED)
    let restored: boolean | undefined
    expect(() => {
      restored = r.port.restore(capture, 'before')
    }).not.toThrow()
    expect(restored).toBe(true)
    expect(r.sync()).toBe(DOC)
    const after = Array.from(
      r.root.querySelectorAll('[data-type="footnotes-block"]'),
    )
    expect(after).toHaveLength(blocks.length)
    for (let i = 0; i < after.length; i++) expect(after[i]).toBe(blocks[i])
  })

  it('a failed form hand-over still completes the restore', async () => {
    // The model binds its Lute calls at build, so the spy is in place before the open.
    const serialize = vi.spyOn(lute, 'VditorIRDOM2Md')
    const r = open(DOC)
    await r.allProven()
    expect(r.port.capture()).toBeUndefined()
    renameGuide(r)
    const capture = r.port.capture() as HistoryCapture
    expect(r.sync()).toBe(RENAMED)
    serialize.mockImplementationOnce(() => {
      throw new Error('test')
    })
    let restored: boolean | undefined
    expect(() => {
      restored = r.port.restore(capture, 'before')
    }).not.toThrow()
    expect(restored).toBe(true)
    expect(r.sync()).toBe(DOC)
  })

  it('a repeated hand-over failure falls back and never throws', async () => {
    // The model binds its Lute calls at build, so the spy is in place before the open.
    const serialize = vi.spyOn(lute, 'VditorIRDOM2Md')
    const r = open(DOC)
    await r.allProven()
    expect(r.port.capture()).toBeUndefined()
    renameGuide(r)
    const capture = r.port.capture() as HistoryCapture
    expect(r.sync()).toBe(RENAMED)
    serialize.mockImplementation(() => {
      throw new Error('test')
    })
    let restored: boolean | undefined
    expect(() => {
      restored = r.port.restore(capture, 'before')
    }).not.toThrow()
    expect(restored).toBe(true)
    let result: { kind: string; reason?: string } | undefined
    expect(() => {
      result = r.prepare()
    }).not.toThrow()
    expect(result).toEqual(
      expect.objectContaining({ kind: 'fallback', reason: 'sync-error' }),
    )
  })
})

describe('a restored definition reaches the definition index (D-3b)', () => {
  it('after Undo of a rename the session answers the old label', async () => {
    const r = open(DOC)
    await r.allProven()
    expect(r.port.capture()).toBeUndefined()
    renameGuide(r)
    const capture = r.port.capture() as HistoryCapture
    expect(r.sync()).toBe(RENAMED)
    expect(r.port.restore(capture, 'before')).toBe(true)
    expect(r.sync()).toBe(DOC)
    expect(r.session.definitionContextFor('x [guide]')).toBeDefined()
    expect(r.session.definitionContextFor('x [guidex]')).toBeUndefined()
  })
})
