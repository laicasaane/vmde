// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import { countBudget, countedLute } from '../testing/budget-harness'
import { createRealLute, svBlocksHtml } from '../testing/real-lute'
import { writeQuietly } from '../util/mutation-impact'
import type { UnitsChange } from '../util/unit-changes'
import { createModelSession, type ModelSession } from './model-session'
import type { UnitLute } from './unit-lute'
import { wysiwygFixture } from '../testing/budget-harness'

// Task 733 / 004-C: the model session over a real text model, real Lute and a jsdom IR root. The
// animation frames and the clock are fake; the host messages are plain objects.
// Task 733 / 015-T1 (S-12): `SOURCE_UNITS` (`U/unit-changes.ts`, task 015 section 6.9 item 1) as a
// switch the Source tests set; the other tests leave it on.
const sourceUnits = vi.hoisted(() => ({ value: true }))
vi.mock('../util/unit-changes', async (original) => ({
  ...(await original<typeof import('../util/unit-changes')>()),
  get SOURCE_UNITS() {
    return sourceUnits.value
  },
}))

let lute: UnitLute
beforeAll(() => {
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  lute = real.lute
})

interface Rig {
  session: ModelSession
  root: HTMLElement
  /** The Source root (`pre.vditor-sv`); empty until a test switches to Source. */
  sourceRoot: HTMLElement
  mode: { value: string | null }
  streaming: { value: boolean }
  composing: { value: boolean }
  preview: { value: boolean }
  frames: Array<() => void>
  timers: Array<() => void>
  cleared: number[]
  cancelledFrames: number[]
  countFallback: ReturnType<typeof vi.fn>
  viewport: { calls: number }
  stats(): Record<string, any>
  runFrames(): void
  render(markdown: string): void
}

const DOC = 'alpha\n\nbeta\n'
const live: ModelSession[] = []

// Since 012-20 the unit schedule runs as jobs of the window's background scheduler, which asks the
// window for its frames. Each rig points the window's frame services at its own fake frames, so the
// proofs and audits run in `runFrames()` as before; the originals come back after each test.
const windowFrames = {
  request: window.requestAnimationFrame,
  cancel: window.cancelAnimationFrame,
}

function rig(options: { e2e?: boolean; wysiwygUnits?: boolean } = {}): Rig {
  const root = document.createElement('div')
  root.className = 'vditor-reset vditor-ir'
  document.body.appendChild(root)
  const mode = { value: 'ir' as string | null }
  const streaming = { value: false }
  const composing = { value: false }
  const preview = { value: false }
  const frames: Array<() => void> = []
  const timers: Array<() => void> = []
  const cleared: number[] = []
  const cancelledFrames: number[] = []
  const countFallback = vi.fn()
  const viewport = { calls: 0 }
  window.requestAnimationFrame = (cb) => frames.push(() => cb(0))
  window.cancelAnimationFrame = () => undefined
  // Task 733 / 015: the Source root (`pre.vditor-sv`), empty until a test switches to Source.
  const sourceRoot = document.createElement('pre')
  sourceRoot.className = 'vditor-sv vditor-reset'
  document.body.appendChild(sourceRoot)
  // Task 733 / 013: these rigs hold an IR root only, so WYSIWYG units stay off here (the 013 block
  // below builds WYSIWYG rigs); a mode change to WYSIWYG keeps its pre-013 meaning.
  const session = createModelSession({
    wysiwygUnits: options.wysiwygUnits ?? false,
    win: window,
    getSourceRoot: () => sourceRoot,
    getRoot: () => root,
    getLute: () => lute,
    getMode: () => mode.value,
    isPreviewShowing: () => preview.value,
    isStreaming: () => streaming.value,
    isComposing: () => composing.value,
    e2e: options.e2e ?? true,
    countFallbackPublication: countFallback,
    requestAnimationFrame: (cb) => frames.push(cb),
    cancelAnimationFrame: (handle) => {
      cancelledFrames.push(handle)
    },
    now: () => 0,
    setTimeout: (cb) => timers.push(cb),
    clearTimeout: (handle) => {
      cleared.push(handle)
    },
    inViewport: () => {
      viewport.calls += 1
      return false
    },
  } as Parameters<typeof createModelSession>[0])
  live.push(session)
  return {
    session,
    root,
    sourceRoot,
    mode,
    streaming,
    composing,
    preview,
    frames,
    timers,
    cleared,
    cancelledFrames,
    countFallback,
    viewport,
    stats: () =>
      (window as unknown as Record<string, any>).__vmdeModelShadowStats,
    runFrames() {
      for (const cb of frames.splice(0)) cb()
    },
    render(markdown) {
      root.innerHTML = lute.Md2VditorIRDOM(markdown)
    },
  }
}

/** A model that is built and live over `markdown`. */
function open(markdown = DOC, epoch = 3, options?: { e2e?: boolean }): Rig {
  const r = rig(options)
  r.render(markdown)
  r.session.onHostText(markdown, epoch)
  r.session.onEditDomComplete()
  return r
}

const paragraph = (r: Rig, index: number): Text =>
  r.root.querySelectorAll('p')[index].firstChild as Text

/** Types into a paragraph the way the editor does: the pre-touch proof runs before the DOM changes. */
function type(r: Rig, index: number, text: string): void {
  const target = r.root.querySelectorAll('p')[index]
  target.dispatchEvent(new Event('beforeinput', { bubbles: true }))
  ;(target.firstChild as Text).data = text
}

afterEach(() => {
  for (const session of live.splice(0)) session.dispose()
  window.requestAnimationFrame = windowFrames.request
  window.cancelAnimationFrame = windowFrames.cancel
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('build', () => {
  it('builds once the complete edit DOM exists and a host text is held', () => {
    const r = rig()
    r.render(DOC)
    r.session.onHostText(DOC, 3)
    expect(r.stats().state).toBe('off')
    r.session.onEditDomComplete()
    expect(r.stats().state).toBe('live')
    expect(r.stats().units).toBeGreaterThan(0)
    expect(r.session.confirmedSnapshot()).toEqual({ text: DOC, epoch: 3 })
  })

  it('holds the host text while no edit DOM exists and builds when it is complete', () => {
    const r = rig()
    r.render(DOC)
    r.session.onEditDomComplete()
    expect(r.stats().state).toBe('off')
    expect(r.stats().offReason).toBe('not-mounted')
    r.session.onHostText(DOC, 1)
    expect(r.frames).toHaveLength(1)
    r.runFrames()
    expect(r.stats().state).toBe('live')
  })

  it('is off for a mode the model does not serve', () => {
    // Task 733 / 015: Source is served while SOURCE_UNITS is on; with it off, Source keeps the 'mode' reason.
    sourceUnits.value = false
    const r = rig()
    r.render(DOC)
    r.mode.value = 'sv'
    r.session.onHostText(DOC, 1)
    r.session.onEditDomComplete()
    expect(r.stats()).toMatchObject({ state: 'off', offReason: 'mode' })
    sourceUnits.value = true
  })

  it('is off not-mounted while streaming and builds when the stream is done', () => {
    const r = rig()
    r.render(DOC)
    r.streaming.value = true
    r.session.onHostText(DOC, 1)
    r.session.onEditDomComplete()
    expect(r.stats()).toMatchObject({ state: 'off', offReason: 'not-mounted' })
    r.streaming.value = false
    r.session.onEditDomComplete()
    expect(r.stats().state).toBe('live')
  })

  it('normalizes CRLF in the host text', () => {
    const r = open()
    r.render('one\n\ntwo\n')
    r.session.onHostText('one\r\n\r\ntwo\r\n', 4)
    r.runFrames()
    expect(r.session.confirmedSnapshot()).toEqual({
      text: 'one\n\ntwo\n',
      epoch: 4,
    })
  })

  it('rebuilds on the next animation frame after an update and is off until then', () => {
    const r = open()
    r.render('new\n\ntext\n')
    r.session.onHostText('new\n\ntext\n', 4)
    expect(r.stats().state).toBe('off')
    r.runFrames()
    expect(r.stats().state).toBe('live')
  })

  it('turns off on a mode change and stays off until the next host text', () => {
    const r = open()
    r.session.onModeChange('wysiwyg')
    expect(r.stats()).toMatchObject({ state: 'off', offReason: 'mode' })
    r.session.onModeChange('ir')
    expect(r.stats().state).toBe('off')
    r.session.onHostText(DOC, 5)
    r.runFrames()
    expect(r.stats().state).toBe('live')
  })

  it('publishes stats only in end-to-end runs and never the document text', () => {
    const quiet = open(DOC, 1, { e2e: false })
    expect(quiet.stats()).toBeUndefined()
    const r = open(DOC, 1)
    expect(JSON.stringify(r.stats())).not.toMatch(/alpha|beta/u)
    r.session.dispose()
    expect(
      (window as unknown as Record<string, unknown>).__vmdeModelShadowStats,
    ).toBeUndefined()
  })
})

describe('whole-text publication and rebind', () => {
  const edit = type

  it('awaits its sequence and confirms the units on the matching rebind', () => {
    const r = open()
    edit(r, 0, 'alpha2')
    expect(r.session.beforeWholeTextPost(1)).toEqual({ rebind: true })
    expect(r.session.confirmedUnits()).toBeUndefined()
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content: 'alpha2\n\nbeta\n',
      editSequence: 1,
    })
    expect(r.session.confirmedUnits()).toBeDefined()
    expect(r.stats()).toMatchObject({ compared: 1, equal: 1, mismatch: 0 })
  })

  it('applies only the rebind of the later of two posts', () => {
    const r = open()
    edit(r, 0, 'alpha2')
    r.session.beforeWholeTextPost(1)
    edit(r, 1, 'beta2')
    r.session.beforeWholeTextPost(2)
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content: 'alpha2\n\nbeta\n',
      editSequence: 1,
    })
    expect(r.session.confirmedUnits()).toBeUndefined()
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content: 'alpha2\n\nbeta2\n',
      editSequence: 2,
    })
    expect(r.session.confirmedUnits()).toBeDefined()
  })

  it('ignores a rebind without editSequence at an equal epoch and applies one at a newer epoch', () => {
    const r = open()
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content: 'alpha\n\nbeta\n\nextra\n',
    })
    expect(r.session.confirmedSnapshot()?.text).toBe(DOC)
    r.session.onRebind({
      command: 'rebind',
      epoch: 4,
      afterSequence: 0,
      content: 'alpha\r\n\r\nbeta\r\n',
    })
    expect(r.session.confirmedSnapshot()).toEqual({ text: DOC, epoch: 4 })
  })

  it('keeps a unit typed in after the post dirty when its rebind arrives', () => {
    const r = open()
    edit(r, 0, 'alpha2')
    r.session.beforeWholeTextPost(1)
    edit(r, 1, 'beta2')
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content: 'alpha2\n\nbeta\n',
      editSequence: 1,
    })
    expect(r.stats().dirtyNow).toBe(1)
    expect(r.session.confirmedUnits()).toBeUndefined()
  })

  it('classifies a different text with equal canon outside the agreement subset as expectedDifference', () => {
    const r = open()
    edit(r, 0, 'alpha2')
    edit(r, 1, 'beta2')
    r.session.beforeWholeTextPost(1)
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content: 'alpha2\n\n\nbeta2\n',
      editSequence: 1,
    })
    expect(r.stats()).toMatchObject({
      compared: 1,
      expectedDifference: 1,
      mismatch: 0,
    })
  })

  it('classifies a difference inside the agreement subset as a mismatch', () => {
    const r = open()
    edit(r, 0, 'alpha2')
    r.session.beforeWholeTextPost(1)
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content: 'alpha2\n\nbeta',
      editSequence: 1,
    })
    expect(r.stats()).toMatchObject({ compared: 1, mismatch: 1 })
  })

  it('classifies a different canon as a mismatch', () => {
    const r = open()
    edit(r, 0, 'alpha2')
    r.session.beforeWholeTextPost(1)
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content: 'other\n\nbeta\n',
      editSequence: 1,
    })
    expect(r.stats()).toMatchObject({ compared: 1, mismatch: 1 })
  })

  it('does not predict during a composition or for the exact post', () => {
    for (const mode of ['composing', 'exact'] as const) {
      const r = open()
      edit(r, 0, 'alpha2')
      r.composing.value = mode === 'composing'
      expect(
        r.session.beforeWholeTextPost(
          1,
          mode === 'exact' ? { predict: false } : undefined,
        ),
      ).toEqual({ rebind: true })
      r.session.onRebind({
        command: 'rebind',
        epoch: 3,
        afterSequence: 0,
        content: 'alpha2\n\nbeta\n',
        editSequence: 1,
      })
      expect(r.stats().compared).toBe(0)
      expect(r.session.confirmedUnits()).toBeDefined()
      r.session.dispose()
    }
  })

  it('counts a fallback publication by reason and asks for the answer', () => {
    const r = open()
    const stray = document.createElement('div')
    stray.setAttribute('data-block', '0')
    r.root.appendChild(stray)
    expect(r.session.beforeWholeTextPost(1)).toEqual({ rebind: true })
    expect(r.countFallback).toHaveBeenCalledTimes(1)
    const reasons = r.stats().fallbacks as Record<string, number>
    expect(Object.values(reasons).reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('asks for nothing while the model is off', () => {
    const r = rig()
    expect(r.session.beforeWholeTextPost(1)).toBeUndefined()
  })
})

describe('history transitions, outcomes and refusals', () => {
  it('an Undo or Redo transition stops trusting the model text until the next answer (round 1)', () => {
    const r = open()
    r.session.onHistoryTransition()
    expect(r.session.confirmedUnits()).toBeUndefined()
    expect(r.session.confirmedSnapshot()).toBeUndefined()
    // The next whole-text publication is not predicted; it asks for the host bytes, and the answer
    // brings the model back.
    type(r, 0, 'alpha2')
    expect(r.session.beforeWholeTextPost(1)).toEqual({ rebind: true })
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content: 'alpha2\n\nbeta\n',
      editSequence: 1,
    })
    expect(r.stats().compared).toBe(0)
    expect(r.session.confirmedUnits()).toBeDefined()
    // A model that is off has nothing to flag.
    const off = rig()
    off.session.onHistoryTransition()
    expect(off.stats().state).toBe('off')
  })

  it('D2: an applied outcome adopts its epoch, drops the prediction and rebuilds on the next frame', () => {
    const r = open()
    type(r, 0, 'alpha2')
    r.session.beforeWholeTextPost(1)
    r.render('moved\n\ntext\n')
    r.session.onHostWriteOutcome({
      status: 'applied',
      epoch: 6,
      content: 'moved\r\n\r\ntext\r\n',
    })
    expect(r.stats().state).toBe('off')
    r.runFrames()
    expect(r.session.confirmedSnapshot()).toEqual({
      text: 'moved\n\ntext\n',
      epoch: 6,
    })
    r.session.onRebind({
      command: 'rebind',
      epoch: 6,
      afterSequence: 0,
      content: 'x',
      editSequence: 1,
    })
    expect(r.stats().compared).toBe(0)
  })

  it('D2: an outcome that is not applied, or has no epoch, changes nothing', () => {
    const r = open()
    r.session.onHostWriteOutcome({ status: 'stale', epoch: 6, content: 'x' })
    r.session.onHostWriteOutcome({ status: 'applied', content: 'x' })
    expect(r.stats().state).toBe('live')
  })

  it('D3: a refused exact edit ends the awaiting state; the next update confirms again', () => {
    const r = open()
    type(r, 0, 'alpha2')
    r.session.beforeWholeTextPost(1, { predict: false })
    r.session.onExactRefused()
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content: 'x',
      editSequence: 1,
    })
    expect(r.session.confirmedUnits()).toBeUndefined()
    r.render(DOC)
    r.session.onHostText(DOC, 4)
    r.runFrames()
    expect(r.session.confirmedUnits()).toBeDefined()
  })

  it('D3: an applied update ends an awaiting state', () => {
    const r = open()
    type(r, 0, 'alpha2')
    r.session.beforeWholeTextPost(1)
    r.render('fresh\n\ntext\n')
    r.session.onHostText('fresh\n\ntext\n', 4)
    r.runFrames()
    expect(r.session.confirmedUnits()).toBeDefined()
  })

  it('gives no snapshot while a unit is dirty or an answer is awaited', () => {
    const r = open()
    expect(r.session.confirmedSnapshot()).toBeDefined()
    paragraph(r, 0).data = 'typed'
    expect(r.session.confirmedSnapshot()).toBeUndefined()
  })
})

describe('listeners and dispose', () => {
  it('notifies unit listeners on a build and stops after unsubscribe', () => {
    const r = rig()
    r.render(DOC)
    const listener = vi.fn()
    const off = r.session.onUnitsChanged(listener)
    r.session.onHostText(DOC, 1)
    r.session.onEditDomComplete()
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    r.session.onHostText(DOC, 2)
    r.runFrames()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('dispose removes the pre-touch listeners and the stats', () => {
    const r = open()
    const remove = vi.spyOn(window, 'removeEventListener')
    r.session.dispose()
    expect(remove.mock.calls.some(([type]) => type === 'paste')).toBe(true)
    expect(r.stats()).toBeUndefined()
  })
})

describe('review repairs', () => {
  const rebind = (
    editSequence: number | undefined,
    content: string,
    epoch = 3,
  ) => ({
    command: 'rebind' as const,
    epoch,
    afterSequence: 0,
    content,
    ...(editSequence === undefined ? {} : { editSequence }),
  })

  it('M1: a publication tests no viewport; the queue is rebuilt inside a frame', () => {
    const r = open()
    for (let i = 0; i < 20; i += 1) r.runFrames()
    r.viewport.calls = 0
    type(r, 0, 'alpha2')
    r.session.beforeWholeTextPost(1)
    expect(r.viewport.calls).toBe(0)
    r.session.onRebind(rebind(1, 'alpha2\n\nbeta\n'))
    expect(r.viewport.calls).toBe(0)
  })

  it('M2: a save queues one audit pass in the idle slices', () => {
    const r = open()
    for (let i = 0; i < 40; i += 1) r.runFrames()
    expect(r.frames).toHaveLength(0)
    r.session.onSave()
    expect(r.frames).toHaveLength(1)
  })

  it('m9: the audit hook resolves with the mismatches of the pass it ran', async () => {
    const r = open()
    for (let i = 0; i < 40; i += 1) r.runFrames()
    const audit = (
      window as unknown as { __vmdeModelShadowAudit(): Promise<number> }
    ).__vmdeModelShadowAudit
    // A quiet DOM change the model never saw: its canon no longer matches the DOM.
    writeQuietly(() => {
      paragraph(r, 0).data = 'quiet change'
    })
    expect(await audit()).toBe(1)
    expect(await audit()).toBe(0)
    expect(r.stats().auditMismatch).toBe(1)
  })

  it('M4: a host-write request awaits its outcome or the next update', () => {
    const r = open()
    r.session.onHostWriteRequested()
    expect(r.session.confirmedUnits()).toBeUndefined()
    r.session.onHostWriteOutcome({ status: 'stale' })
    expect(r.session.confirmedUnits()).toBeDefined()
    r.session.onHostWriteRequested()
    r.session.onHostWriteEnded()
    expect(r.session.confirmedUnits()).toBeDefined()
    r.session.onHostWriteRequested()
    r.render(DOC)
    r.session.onHostText(DOC, 4)
    r.runFrames()
    expect(r.session.confirmedUnits()).toBeDefined()
  })

  it('m1: a refusal for an earlier exact post keeps waiting for the later answer', () => {
    const r = open()
    type(r, 0, 'alpha2')
    r.session.beforeWholeTextPost(5, { predict: false, requestId: 'exact-5' })
    type(r, 1, 'beta2')
    r.session.beforeWholeTextPost(6)
    r.session.onExactRefused('exact-5')
    r.session.onRebind(rebind(6, 'alpha2\n\nbeta2\n'))
    expect(r.session.confirmedUnits()).toBeDefined()
    // A refusal naming the awaited exact post ends the wait.
    type(r, 0, 'alpha3')
    r.session.beforeWholeTextPost(7, { predict: false, requestId: 'exact-7' })
    r.session.onExactRefused('exact-7')
    r.session.onRebind(rebind(7, 'x'))
    expect(r.session.confirmedUnits()).toBeUndefined()
  })

  it('m3: an update whose text the editor already shows keeps every proof', () => {
    const r = open()
    for (let i = 0; i < 40; i += 1) r.runFrames()
    const before = r.stats()
    r.session.onHostText(DOC, 9, { sameDom: true })
    // The model is live at once: no rebuild frame, no lost proof.
    expect(r.stats().state).toBe('live')
    const after = r.stats()
    expect(after.state).toBe('live')
    expect(after.proven).toBe(before.proven)
    expect(r.session.confirmedSnapshot()).toEqual({ text: DOC, epoch: 9 })
  })

  it('m2: turnOff leaves the model off until the next host text', () => {
    const r = open()
    r.session.turnOff('sync-error')
    expect(r.stats()).toMatchObject({ state: 'off', offReason: 'sync-error' })
    expect(r.session.beforeWholeTextPost(1)).toBeUndefined()
    r.session.onHostText(DOC, 5)
    r.runFrames()
    expect(r.stats().state).toBe('live')
  })

  it('m8: a unit typed in after a fallback publication stays dirty when its rebind arrives', () => {
    const r = open()
    type(r, 0, 'alpha2')
    r.composing.value = true
    r.session.beforeWholeTextPost(1)
    r.composing.value = false
    type(r, 1, 'beta2')
    r.session.onRebind(rebind(1, 'alpha2\n\nbeta\n'))
    expect(r.stats().dirtyNow).toBe(1)
    expect(r.session.confirmedUnits()).toBeUndefined()
  })

  it('m8: a rebind after a fallback that turned the model off builds it again', () => {
    const r = open()
    const stray = document.createElement('div')
    stray.setAttribute('data-block', '0')
    r.root.appendChild(stray)
    r.session.beforeWholeTextPost(1)
    stray.remove()
    r.session.onRebind(rebind(1, DOC))
    expect(r.stats().state).toBe('live')
    expect(r.session.confirmedSnapshot()).toEqual({ text: DOC, epoch: 3 })
  })
})

describe('round 1 repairs', () => {
  const answer = (content: string, editSequence = 1) => ({
    command: 'rebind' as const,
    epoch: 3,
    afterSequence: 0,
    content,
    editSequence,
  })

  it('classifies a document with two blank lines between blocks as an expected difference', () => {
    // The model keeps the gaps it was given; the host answers with Lute's canonical single blank line.
    const doc = 'First block.\n\n\nMiddle block.\n\n\nLast block.\n'
    const r = open(doc)
    type(r, 1, 'Middle blockx.')
    expect(r.session.beforeWholeTextPost(1)).toEqual({ rebind: true })
    r.session.onRebind(
      answer('First block.\n\nMiddle blockx.\n\nLast block.\n'),
    )
    expect(r.stats()).toMatchObject({
      compared: 1,
      equal: 0,
      expectedDifference: 1,
      mismatch: 0,
    })
  })

  it('still calls a difference on a canonical one-unit document a mismatch', () => {
    const r = open('First block.\n\nMiddle block.\n\nLast block.\n')
    type(r, 1, 'Middle blockx.')
    r.session.beforeWholeTextPost(1)
    r.session.onRebind(answer('First block.\n\nMiddle blockx.\n\nLast block'))
    expect(r.stats()).toMatchObject({ compared: 1, mismatch: 1 })
  })

  it('predicts an Enter followed by typing in a paragraph exactly', () => {
    const r = open()
    const first = r.root.querySelectorAll('p')[0]
    const added = document.createElement('p')
    added.setAttribute('data-block', '0')
    added.textContent = '\u200b'
    first.after(added)
    added.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    added.textContent = 'x'
    expect(r.session.beforeWholeTextPost(1)).toEqual({ rebind: true })
    r.session.onRebind(answer('alpha\n\nx\n\nbeta\n'))
    expect(r.stats()).toMatchObject({ compared: 1, equal: 1, mismatch: 0 })
  })

  it('does its own Lute work through the functions bound at build, not the editor wrappers', () => {
    const r = open()
    let wrapped = 0
    const original = lute.VditorIRDOM2Md.bind(lute)
    const live = lute as unknown as { VditorIRDOM2Md: (html: string) => string }
    live.VditorIRDOM2Md = (html) => {
      wrapped += 1
      return original(html)
    }
    try {
      for (let i = 0; i < 40; i += 1) r.runFrames()
      type(r, 0, 'alpha2')
      r.session.beforeWholeTextPost(1)
      r.session.onRebind(answer('alpha2\n\nbeta\n'))
      const audit = (
        window as unknown as { __vmdeModelShadowAudit(): Promise<number> }
      ).__vmdeModelShadowAudit
      void audit()
      expect(wrapped).toBe(0)
    } finally {
      live.VditorIRDOM2Md = original
    }
  })
})

describe('round 2 repairs', () => {
  it('does no proof or audit work while the Preview pane is showing', () => {
    const r = open()
    r.preview.value = true
    r.session.onSave()
    for (let i = 0; i < 60; i += 1) r.runFrames()
    // The loop ended without proving or auditing anything; nothing keeps asking for frames.
    expect(r.frames).toHaveLength(0)
    expect(r.stats().proven).toBeLessThan(r.stats().units)
    r.preview.value = false
    // Back in IR the next restart resumes the proofs.
    paragraph(r, 0).data = 'alpha2'
    r.session.onHostText('alpha2\n\nbeta\n', 4, { sameDom: true })
    for (let i = 0; i < 60; i += 1) r.runFrames()
    expect(r.stats().proven).toBe(r.stats().units)
  })
})

describe('round 2 classifier', () => {
  it('calls the front-matter junction an expected difference, not a mismatch', () => {
    const doc = '---\ntitle: T\n---\n\n# Overview\n\nbody text\n'
    const r = open(doc)
    type(r, 0, 'body textx')
    expect(r.session.beforeWholeTextPost(1)).toEqual({ rebind: true })
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content: '---\ntitle: T\n---\n# Overview\n\nbody textx\n',
      editSequence: 1,
    })
    expect(r.stats()).toMatchObject({
      compared: 1,
      expectedDifference: 1,
      mismatch: 0,
    })
  })
})

// Task 733 / 007-B: the session as the model side of the delta publisher.
describe('delta port (007-B)', () => {
  it('prepareDelta reports the typed change against the text before the call and keeps the model confirmed', () => {
    const r = open()
    const port = r.session.deltaPort()
    type(r, 0, 'alphaX')
    const result = port.prepareDelta(1)
    expect(result).toMatchObject({
      kind: 'changes',
      before: DOC,
      changes: [{ from: 5, to: 5, insert: 'X' }],
    })
    expect(port.modelText()).toBe('alphaX\n\nbeta\n')
    expect(port.epoch()).toBe(3)
    expect(port.awaiting()).toBe(false)
    expect(r.session.confirmedSnapshot()?.text).toBe('alphaX\n\nbeta\n')
  })

  it('prepareDelta answers nothing for an untouched DOM', () => {
    const r = open()
    expect(r.session.deltaPort().prepareDelta(1)).toEqual({
      kind: 'changes',
      before: DOC,
      changes: [],
    })
  })

  it('canPublishDelta follows the live IR model; ownsText also needs a trusted, unawaited text', () => {
    const r = open()
    expect(r.session.canPublishDelta()).toBe(true)
    expect(r.session.ownsText()).toBe(true)
    r.session.onWholeTextPublished(4)
    expect(r.session.canPublishDelta()).toBe(true)
    expect(r.session.ownsText()).toBe(false)
    r.mode.value = 'wysiwyg'
    expect(r.session.canPublishDelta()).toBe(false)
    expect(rig().session.canPublishDelta()).toBe(false)
  })

  it('is awaiting from a whole-text post until its matched rebind', () => {
    const r = open()
    const port = r.session.deltaPort()
    r.session.onWholeTextPublished(4)
    expect(port.awaiting()).toBe(true)
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content: DOC,
      editSequence: 3,
    })
    expect(port.awaiting()).toBe(true)
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content: DOC,
      editSequence: 4,
    })
    expect(port.awaiting()).toBe(false)
  })

  it('is awaiting while a host-write request is outstanding', () => {
    const r = open()
    r.session.onHostWriteRequested()
    expect(r.session.deltaPort().awaiting()).toBe(true)
    r.session.onHostWriteEnded()
    expect(r.session.deltaPort().awaiting()).toBe(false)
  })

  it('an Undo or Redo leaves the model untrusted: prepareDelta falls back until the next rebind', () => {
    const r = open()
    const port = r.session.deltaPort()
    r.session.onHistoryTransition()
    expect(port.prepareDelta(1)).toEqual({
      kind: 'fallback',
      reason: 'history-transition',
    })
    r.session.onWholeTextPublished(5)
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content: DOC,
      editSequence: 5,
    })
    expect(port.prepareDelta(1).kind).toBe('changes')
  })

  it('a flush during a composition still gets the model changes (handoff 6.3)', () => {
    const r = open()
    const port = r.session.deltaPort()
    const target = r.root.querySelectorAll('p')[0]
    target.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    r.composing.value = true
    ;(target.firstChild as Text).data = 'alphaX'
    expect(port.prepareDelta(1)).toMatchObject({
      kind: 'changes',
      changes: [{ from: 5, to: 5, insert: 'X' }],
    })
  })

  it('hints the line scan with a unit at or before the first change', () => {
    const r = open('one\n\ntwo\n\nthree\n')
    type(r, 2, 'threeX')
    const result = r.session.deltaPort().prepareDelta(1)
    if (result.kind !== 'changes') throw new Error('expected changes')
    // `three` starts at offset 10 on line 4.
    expect(result.hint).toEqual({ offset: 10, line: 4 })
  })

  it('m5: hints the line scan from the changed cell, not the table start', () => {
    const md = 'intro\n\n| a | b |\n| - | - |\n| c | d |\n| e | f |\n'
    const r = open(md)
    const cell = r.root.querySelectorAll('td')[3] as HTMLElement
    cell.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    ;(cell.firstChild as Text).data = 'fX'
    const result = r.session.deltaPort().prepareDelta(1)
    if (result.kind !== 'changes') throw new Error('expected changes')
    const fAt = md.lastIndexOf('f')
    // The cell's content starts at the `f`; its row is on line 5.
    expect(result.hint).toEqual({ offset: fAt, line: 5 })
  })

  it('does not rebuild the proof queues for every delta: one restart after a quiet moment', () => {
    const r = open()
    const port = r.session.deltaPort()
    r.runFrames()
    const frames = r.frames.length
    r.timers.length = 0
    for (const text of ['alphaA', 'alphaAB', 'alphaABC']) {
      type(r, 0, text)
      port.prepareDelta(1)
    }
    // Every frame the deltas requested (the unit change feed) was cancelled by the sync that took its
    // batch; one timer is armed for the quiet restart.
    const requested = Array.from(
      { length: r.frames.length - frames },
      (_, index) => frames + index + 1,
    )
    expect(
      requested.every((handle) => r.cancelledFrames.includes(handle)),
    ).toBe(true)
    expect(r.cleared.length).toBeGreaterThanOrEqual(1)
  })

  it('a host-originated rebind with a new epoch resets changedAt (3.5 A)', () => {
    const r = open()
    type(r, 0, 'alphaX')
    r.session.deltaPort().prepareDelta(1)
    const changed = (): number[] => {
      const out: number[] = []
      const walk = (units: readonly any[]): void => {
        for (const unit of units) {
          out.push(unit.changedAt)
          walk(unit.children)
        }
      }
      walk(r.session.confirmedUnits() ?? [])
      return out
    }
    expect(changed()).toContain(1)
    r.session.onRebind({
      command: 'rebind',
      epoch: 4,
      afterSequence: 0,
      content: 'alphaX\n\nbeta\n',
    })
    expect(changed().every((value) => value === 0)).toBe(true)
  })

  it('a refused pre-touch proof falls back', () => {
    const r = open()
    const port = r.session.deltaPort()
    const target = r.root.querySelectorAll('p')[0]
    target.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    const result = port.prepareDelta(1)
    expect(['changes', 'fallback']).toContain(result.kind)
  })

  it('an exact-edit-refused without a request id makes the model untrusted (3.2 A)', () => {
    const r = open()
    r.session.onWholeTextPublished(4)
    r.session.onExactRefused(undefined)
    const port = r.session.deltaPort()
    expect(port.awaiting()).toBe(false)
    expect(port.prepareDelta(1)).toEqual({
      kind: 'fallback',
      reason: 'history-transition',
    })
  })

  it('a refusal of the awaited exact post makes the model untrusted; an older one does not', () => {
    const r = open()
    r.session.beforeWholeTextPost(4, { predict: false, requestId: 'a' })
    r.session.beforeWholeTextPost(5, { predict: false, requestId: 'b' })
    r.session.onExactRefused('a')
    expect(r.session.deltaPort().awaiting()).toBe(true)
    r.session.onExactRefused('b')
    expect(r.session.deltaPort().awaiting()).toBe(false)
    expect(r.session.deltaPort().prepareDelta(1).kind).toBe('fallback')
  })

  it('an update with a new epoch ends the awaiting state and the epoch follows', () => {
    const r = open()
    r.session.onWholeTextPublished(4)
    r.session.onHostText(DOC, 4, { sameDom: true })
    const port = r.session.deltaPort()
    expect(port.awaiting()).toBe(false)
    expect(port.epoch()).toBe(4)
  })

  it('markPublishedWhole clears the dirty flags', () => {
    const r = open()
    const port = r.session.deltaPort()
    type(r, 0, 'alphaX')
    expect(port.hasDirty()).toBe(true)
    port.markPublishedWhole()
    expect(port.hasDirty()).toBe(false)
  })

  it('rebind replaces the model text and the held host text', () => {
    const r = open()
    const port = r.session.deltaPort()
    port.rebind('alpha\n\nbeta changed\n')
    expect(port.modelText()).toBe('alpha\n\nbeta changed\n')
  })

  it('clearForms hands the keep rule to the model', () => {
    const r = open()
    const keep = vi.fn(() => false)
    r.session.deltaPort().clearForms(keep)
    expect(keep).toHaveBeenCalled()
  })

  it('recordFallback counts the reason in the stats and the page counter', () => {
    const r = open()
    r.session.recordFallback('awaiting-rebind')
    r.session.recordFallback('history-transition')
    expect(r.countFallback).toHaveBeenCalledTimes(2)
    expect(r.stats().fallbacks).toEqual({
      'awaiting-rebind': 1,
      'history-transition': 1,
    })
  })

  it('has no epoch and does not publish while the model is off', () => {
    const r = rig()
    const port = r.session.deltaPort()
    expect(port.epoch()).toBeUndefined()
    expect(port.modelText()).toBeUndefined()
    expect(port.prepareDelta(1).kind).toBe('fallback')
    r.session.onWholeTextPublished(4)
    expect(port.awaiting()).toBe(false)
  })
})

describe('model text digest (e2e only)', () => {
  const digest = (): (() => { length: number; hash: number } | null) =>
    (window as unknown as Record<string, any>).__vmdeModelTextDigest

  it('is the length and a hash of the model text, and null while the model is off', () => {
    const r = open('abc\n')
    expect(digest()()).toEqual({ length: 4, hash: expect.any(Number) })
    const same = digest()()
    r.session.deltaPort().rebind('abd\n')
    expect(digest()()?.hash).not.toBe(same?.hash)
    r.mode.value = 'wysiwyg'
    r.session.onModeChange('wysiwyg')
    expect(digest()()).toBeNull()
  })

  it('is not defined outside end-to-end runs', () => {
    const r = open('abc\n', 3, { e2e: false })
    r.session.dispose()
    expect(
      (window as unknown as Record<string, unknown>).__vmdeModelTextDigest,
    ).toBeUndefined()
  })
})

describe('entering IR again (3.6)', () => {
  it('the first IR post asks for the host bytes and a matched rebind rebuilds the model', () => {
    const r = open()
    r.session.onModeChange('wysiwyg')
    r.mode.value = 'wysiwyg'
    expect(r.session.canPublishDelta()).toBe(false)
    r.mode.value = 'ir'
    r.session.onModeChange('ir')
    expect(r.session.beforeWholeTextPost(7)).toEqual({ rebind: true })
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content: DOC,
      editSequence: 7,
    })
    r.runFrames()
    expect(r.stats().state).toBe('live')
    expect(r.session.canPublishDelta()).toBe(true)
  })

  it('a model that was never live asks for no rebind', () => {
    const r = rig()
    expect(r.session.beforeWholeTextPost(1)).toBeUndefined()
  })
})

// Task 733 / 002-T: the live unit lookup of the unit spin. `liveUnitOf` does not exist yet.
describe('liveUnitOf (002)', () => {
  const TABLE_DOC = 'intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- one\n- two\n'

  it('returns the cell unit for a text node in a td while the cell is dirty', () => {
    const r = open(TABLE_DOC)
    const cell = r.root.querySelectorAll('td')[0] as HTMLElement
    cell.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    ;(cell.firstChild as Text).data = '1x'
    const unit = r.session.liveUnitOf(cell.firstChild as Text)
    expect(unit?.kind).toBe('cell')
    expect(unit?.el).toBe(cell)
    expect(unit?.top).toBe(r.root.querySelector('table'))
  })

  it('returns the list-item unit for a node inside a top-level li', () => {
    const r = open(TABLE_DOC)
    const item = r.root.querySelectorAll('li')[0] as HTMLElement
    const unit = r.session.liveUnitOf(item.firstChild as Node)
    expect(unit?.kind).toBe('list-item')
    expect(unit?.el).toBe(item)
    expect(unit?.top).toBe(r.root.querySelector('ul'))
  })

  it('returns the block unit for a paragraph node', () => {
    const r = open(TABLE_DOC)
    const unit = r.session.liveUnitOf(paragraph(r, 0))
    expect(unit?.kind).toBe('paragraph')
    expect(unit?.el).toBe(r.root.querySelector('p'))
    expect(unit?.top).toBe(unit?.el)
  })

  it('returns a list-item unit whose top is the top-level list for a node in a nested li', () => {
    const r = open('- a\n  - b\n- c\n')
    const nested = r.root.querySelector('ul ul li') as HTMLElement
    const unit = r.session.liveUnitOf(nested.firstChild as Node)
    expect(unit?.kind).toBe('list-item')
    // The top is the root-level list, not the nested one: the spin then refuses `nested` or `not-a-unit`.
    expect(unit?.top).toBe(r.root.querySelector('ul'))
    expect(unit?.top.parentElement).toBe(r.root)
  })

  it('isLive follows the model state', () => {
    const r = rig()
    r.render(TABLE_DOC)
    r.session.onHostText(TABLE_DOC, 3)
    expect(r.session.isLive()).toBe(false)
    r.session.onEditDomComplete()
    expect(r.session.isLive()).toBe(true)
  })

  it('returns undefined when the model is not live', () => {
    const r = rig()
    r.render(TABLE_DOC)
    r.session.onHostText(TABLE_DOC, 3)
    // No edit DOM is complete yet, so the model is off.
    expect(r.session.liveUnitOf(paragraph(r, 0))).toBeUndefined()
    const off = open(TABLE_DOC)
    off.mode.value = 'wysiwyg'
    off.session.onHostText(TABLE_DOC, 4)
    expect(off.session.liveUnitOf(paragraph(off, 0))).toBeUndefined()
  })
})

describe('unit change feed (Task 733 / 005-A)', () => {
  const FEED_DOC =
    'alpha\n\nbeta\n\n# Head\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'

  /** An open session whose build frames have run, with a recording listener. */
  function openFeed(markdown = FEED_DOC) {
    const r = open(markdown)
    r.runFrames()
    const changes: UnitsChange[] = []
    r.session.onUnitsChanged((change) => {
      changes.push(change)
    })
    return { r, changes }
  }

  it('merges two batches of one frame into one mutation change in document order', () => {
    const { r, changes } = openFeed()
    type(r, 1, 'beta2')
    r.session.confirmedUnits() // drains the first batch
    type(r, 0, 'alpha2')
    r.session.confirmedUnits() // drains the second batch
    type(r, 0, 'alpha3') // the same unit again: no duplicate
    r.session.confirmedUnits()
    expect(changes).toHaveLength(0)
    r.runFrames()
    expect(changes).toHaveLength(1)
    const change = changes[0]
    expect(change.cause).toBe('mutation')
    expect(change.whole).toBe(false)
    expect(change.changed.map((unit) => unit.el)).toEqual([
      r.root.querySelectorAll('p')[0],
      r.root.querySelectorAll('p')[1],
    ])
    expect(change.structural).toEqual([])
    r.runFrames()
    expect(changes).toHaveLength(1)
  })

  it('reports a cell with its table as top and an align record as a structural table', () => {
    const { r, changes } = openFeed()
    const table = r.root.querySelector('table') as HTMLElement
    ;(table.querySelector('td') as HTMLElement).append('x')
    r.session.confirmedUnits()
    ;(table.querySelector('th') as HTMLElement).setAttribute('align', 'right')
    r.session.confirmedUnits()
    r.runFrames()
    expect(changes).toHaveLength(1)
    expect(changes[0].changed.map((unit) => unit.kind)).toEqual(['cell'])
    expect(changes[0].changed[0].top).toBe(table)
    expect(changes[0].structural).toEqual([table])
  })

  it('counts a list structure change as the list and a root structure change as whole', () => {
    const { r, changes } = openFeed()
    const list = r.root.querySelector(':scope > ul') as HTMLElement
    list.appendChild(list.firstElementChild?.cloneNode(true) as Node)
    r.session.confirmedUnits()
    r.runFrames()
    expect(changes[0].whole).toBe(false)
    expect(changes[0].structural).toEqual([list])
    r.root.appendChild(document.createElement('p'))
    r.session.confirmedUnits()
    r.runFrames()
    expect(changes[1].whole).toBe(true)
  })

  it('drops a unit that was removed before the frame', () => {
    const { r, changes } = openFeed()
    type(r, 0, 'alpha2')
    type(r, 1, 'beta2')
    r.session.confirmedUnits()
    r.root.querySelectorAll('p')[1].remove()
    r.runFrames()
    const units = changes.flatMap((change) => change.changed)
    expect(units.map((unit) => unit.el)).not.toContain(undefined)
    expect(units.every((unit) => unit.el.isConnected)).toBe(true)
  })

  it('emits whole changes for a build and a rebind', () => {
    const r = rig()
    r.render(FEED_DOC)
    const changes: UnitsChange[] = []
    r.session.onUnitsChanged((change) => {
      changes.push(change)
    })
    r.session.onHostText(FEED_DOC, 1)
    r.session.onEditDomComplete()
    expect(changes.map((c) => [c.cause, c.whole])).toEqual([['build', true]])
    r.session.deltaPort().rebind(FEED_DOC)
    expect(changes.map((c) => [c.cause, c.whole])).toEqual([
      ['build', true],
      ['rebind', true],
    ])
  })

  it('emits a sync change with the changed units when a delta is prepared', () => {
    const { r, changes } = openFeed()
    type(r, 0, 'alpha2')
    const result = r.session.deltaPort().prepareDelta(1)
    expect(result.kind).toBe('changes')
    const sync = changes.filter((change) => change.cause === 'sync')
    expect(sync).toHaveLength(1)
    expect(sync[0].changed.map((unit) => unit.el)).toEqual([
      r.root.querySelectorAll('p')[0],
    ])
    r.runFrames()
    expect(changes.filter((change) => change.cause === 'mutation')).toEqual([])
  })

  it('keeps a dirty cell visible in liveUnits while confirmedUnits is undefined', () => {
    const { r } = openFeed()
    const table = r.root.querySelector('table') as HTMLElement
    const cell = table.querySelector('td') as HTMLElement
    cell.append('x')
    expect(r.session.confirmedUnits()).toBeUndefined()
    const units = r.session.liveUnits()
    expect(units).toBeDefined()
    // The table is a top-level unit; the dirty cell resolves to a live unit held by it.
    expect(units?.map((unit) => unit.el)).toContain(table)
    expect(r.session.liveUnitOf(cell)?.top).toBe(table)
  })

  it('lists live units for lists expanded to items and none when not live', () => {
    const { r } = openFeed()
    expect(r.session.liveUnits()?.map((unit) => unit.kind)).toEqual([
      'paragraph',
      'paragraph',
      'heading',
      'list-item',
      'list-item',
      'table',
    ])
    r.mode.value = 'wysiwyg'
    r.session.onModeChange('wysiwyg')
    expect(r.session.liveUnits()).toBeUndefined()
    expect(r.session.confirmedLines()).toBeUndefined()
  })

  it('gives the line ranges of the first five confirmed units without a Lute call', () => {
    const { r } = openFeed()
    const calls = vi.spyOn(lute, 'VditorIRDOM2Md')
    const lines = r.session.confirmedLines()
    expect(calls).not.toHaveBeenCalled()
    expect(lines?.slice(0, 5).map((l) => [l.startLine, l.endLine])).toEqual([
      [0, 0],
      [2, 2],
      [4, 4],
      [6, 6],
      [7, 7],
    ])
    expect(lines?.[0].el).toBe(r.root.querySelectorAll('p')[0])
    expect(lines?.[5]).toMatchObject({ startLine: 9, endLine: 11 })
  })

  it('gives no confirmed lines while a unit is dirty', () => {
    const { r } = openFeed()
    type(r, 0, 'alpha2')
    expect(r.session.confirmedLines()).toBeUndefined()
  })

  it('still runs an old listener that takes no argument', () => {
    const r = rig()
    r.render(FEED_DOC)
    const legacy = vi.fn(() => undefined)
    r.session.onUnitsChanged(legacy)
    r.session.onHostText(FEED_DOC, 1)
    r.session.onEditDomComplete()
    expect(legacy).toHaveBeenCalledTimes(1)
  })

  it('cancels the pending frame on dispose', () => {
    const { r, changes } = openFeed()
    type(r, 0, 'alpha2')
    r.session.confirmedUnits()
    r.session.dispose()
    expect(r.cancelledFrames.length).toBeGreaterThan(0)
    r.runFrames()
    expect(changes).toEqual([])
  })
})

// Task 733 / 012-1: a publication after the feed frame and the block spin of a top-level block report
// only the changed units; `whole` stays for a change the model cannot name.
describe('scoped feed emissions (Task 733 / 012-1)', () => {
  const SPIN_DOC = 'alpha\n\nbeta\n\n```js\nx\n```\n\ngamma\n'

  /** An open session whose build frames have run, with a recording listener. */
  function openFeed(markdown = SPIN_DOC) {
    const r = open(markdown)
    r.runFrames()
    const changes: UnitsChange[] = []
    r.session.onUnitsChanged((change) => {
      changes.push(change)
    })
    return { r, changes }
  }

  /** Replaces a top-level block the way Vditor's IR input spins it: one `outerHTML` write on the root. */
  function spin(block: HTMLElement, markdown: string): void {
    block.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    block.outerHTML = lute.Md2VditorIRDOM(markdown)
  }

  const codeBlock = (r: Rig): HTMLElement =>
    r.root.querySelector(':scope > [data-type="code-block"]') as HTMLElement

  /** Every emitted change after the feed frame and the publication's sync. */
  function frameThenDelta(r: Rig, changes: UnitsChange[]): UnitsChange[] {
    r.session.confirmedUnits() // drains the batch
    r.runFrames()
    expect(r.session.deltaPort().prepareDelta(1).kind).toBe('changes')
    r.runFrames()
    return changes
  }

  it('a delta prepared after the feed frame is no whole change', () => {
    const { r, changes } = openFeed()
    type(r, 0, 'alpha2')
    frameThenDelta(r, changes)
    const first = r.root.querySelectorAll('p')[0]
    expect(changes.map((c) => [c.cause, c.whole])).not.toContainEqual([
      'sync',
      true,
    ])
    // The sync reports the unit it wrote, or nothing new.
    for (const change of changes.filter((c) => c.cause === 'sync'))
      expect(change.changed.map((unit) => unit.el)).toEqual([first])
  })

  it('a whole-text post after the feed frame is no whole change', () => {
    const { r, changes } = openFeed()
    type(r, 1, 'beta2')
    r.session.confirmedUnits()
    r.runFrames()
    expect(r.session.beforeWholeTextPost(1)).toEqual({ rebind: true })
    const second = r.root.querySelectorAll('p')[1]
    const sync = changes.filter((c) => c.cause === 'sync')
    expect(sync.map((c) => c.whole)).not.toContain(true)
    for (const change of sync)
      expect(change.changed.map((unit) => unit.el)).toEqual([second])
  })

  it('a spun top-level paragraph is reported as that block, not as a whole change', () => {
    const { r, changes } = openFeed()
    spin(r.root.querySelectorAll('p')[0], 'alpha2\n')
    frameThenDelta(r, changes)
    const spun = r.root.querySelectorAll('p')[0]
    expect(r.session.deltaPort().modelText()).toBe(
      SPIN_DOC.replace('alpha', 'alpha2'),
    )
    expect(changes.map((c) => c.whole)).not.toContain(true)
    expect(changes.flatMap((c) => c.structural)).toContain(spun)
  })

  it('a paragraph spun into two paragraphs (Enter) reports both new blocks', () => {
    const { r, changes } = openFeed()
    spin(r.root.querySelectorAll('p')[0], 'al\n\npha\n')
    frameThenDelta(r, changes)
    const [left, right] = Array.from(r.root.querySelectorAll('p'))
    expect(r.session.deltaPort().modelText()).toBe(
      SPIN_DOC.replace('alpha', 'al\n\npha'),
    )
    expect(changes.map((c) => c.whole)).not.toContain(true)
    const structural = changes.flatMap((c) => c.structural)
    expect(structural).toContain(left)
    expect(structural).toContain(right)
  })

  it('a spun top-level code block is reported as that block, not as a whole change', () => {
    const { r, changes } = openFeed()
    spin(codeBlock(r), '```js\nxy\n```\n')
    frameThenDelta(r, changes)
    expect(r.session.deltaPort().modelText()).toBe(
      SPIN_DOC.replace('```js\nx\n```', '```js\nxy\n```'),
    )
    expect(changes.map((c) => c.whole)).not.toContain(true)
    expect(changes.flatMap((c) => c.structural)).toContain(codeBlock(r))
  })

  it('a write inside a spun block before any sync (the wbr removal) is no whole change', () => {
    const { r, changes } = openFeed()
    const old = r.root.querySelectorAll('p')[0]
    old.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    old.outerHTML = lute.Md2VditorIRDOM('alpha2\n')
    const spun = r.root.querySelectorAll('p')[0]
    spun.append(document.createElement('wbr'))
    r.session.confirmedUnits()
    spun.querySelector('wbr')?.remove()
    frameThenDelta(r, changes)
    expect(changes.map((c) => c.whole)).not.toContain(true)
    expect(changes.flatMap((c) => c.structural)).toContain(spun)
  })

  it('a second spin of a block no sync has mapped yet is no whole change', () => {
    const { r, changes } = openFeed()
    spin(r.root.querySelectorAll('p')[0], 'alpha2\n')
    r.session.confirmedUnits()
    r.runFrames()
    spin(r.root.querySelectorAll('p')[0], 'alpha23\n')
    frameThenDelta(r, changes)
    expect(r.session.deltaPort().modelText()).toBe(
      SPIN_DOC.replace('alpha', 'alpha23'),
    )
    expect(changes.map((c) => c.whole)).not.toContain(true)
    expect(changes.flatMap((c) => c.structural)).toContain(
      r.root.querySelectorAll('p')[0],
    )
  })

  it('a root record whose new element the model cannot map is still a whole change', () => {
    const { r, changes } = openFeed()
    const foreign = document.createElement('div')
    foreign.textContent = 'foreign'
    r.root.querySelectorAll('p')[0].replaceWith(foreign)
    r.session.confirmedUnits()
    r.runFrames()
    expect(changes.filter((c) => c.cause === 'mutation')).toHaveLength(1)
    expect(changes[0].whole).toBe(true)
  })
})

// Task 733 / 010-T: `applyText` writes a text change into the IR DOM unit by unit (shared rules 3.7).
describe('applyText (Task 733 / 010)', () => {
  const THREE = 'alpha\n\nbeta\n\ngamma\n'
  const change = (text: string, needle: string, insert: string) => {
    const from = text.indexOf(needle)
    return { from, to: from + needle.length, insert }
  }

  it('applies an exact change by units: the DOM and the model text hold it, untouched elements stay', () => {
    const r = open(THREE)
    const first = r.root.querySelectorAll('p')[0]
    const last = r.root.querySelectorAll('p')[2]
    const outcome = r.session.applyText(
      [change(THREE, 'beta', 'BETA')],
      'exact',
    )
    expect(outcome).toEqual({ kind: 'applied' })
    expect(r.session.deltaPort().modelText()).toBe('alpha\n\nBETA\n\ngamma\n')
    const paragraphs = r.root.querySelectorAll('p')
    expect(paragraphs[1].textContent).toContain('BETA')
    expect(paragraphs[0]).toBe(first)
    expect(paragraphs[2]).toBe(last)
  })

  it('is not re-published as typing: the next delta preparation finds no change', () => {
    const r = open(THREE)
    r.session.applyText([change(THREE, 'beta', 'BETA')], 'exact')
    expect(r.session.deltaPort().hasDirty()).toBe(false)
    expect(r.session.deltaPort().prepareDelta(1)).toMatchObject({
      kind: 'changes',
      changes: [],
    })
  })

  it('emits one sync change that names the new unit and is not whole', () => {
    const r = open(THREE)
    const changes: UnitsChange[] = []
    r.session.onUnitsChanged((c) => changes.push(c))
    r.session.applyText([change(THREE, 'beta', 'BETA')], 'exact')
    r.runFrames()
    expect(changes).toHaveLength(1)
    expect(changes[0].cause).toBe('sync')
    expect(changes[0].whole).toBe(false)
    expect(changes[0].changed.map((unit) => unit.el)).toEqual([
      r.root.querySelectorAll('p')[1],
    ])
  })

  it('makes no model build and keeps the epoch', () => {
    const r = open(THREE, 7)
    r.session.applyText([change(THREE, 'beta', 'BETA')], 'exact')
    r.runFrames()
    expect(r.session.deltaPort().epoch()).toBe(7)
    expect(r.stats().state).toBe('live')
    expect(r.session.ownsText()).toBe(true)
  })

  it('falls back model-off while the model is off and leaves the DOM alone', () => {
    const r = rig()
    r.render(THREE)
    const before = r.root.innerHTML
    expect(
      r.session.applyText([change(THREE, 'beta', 'BETA')], 'exact'),
    ).toEqual({ kind: 'fallback', reason: 'model-off' })
    expect(r.root.innerHTML).toBe(before)
  })

  it('falls back dependent-construct for a reference definition and leaves the DOM alone', () => {
    const r = open(THREE)
    const before = r.root.innerHTML
    expect(
      r.session.applyText(
        [
          {
            from: THREE.length,
            to: THREE.length,
            insert: '\n[r]: https://e.com\n',
          },
        ],
        'exact',
      ),
    ).toEqual({ kind: 'fallback', reason: 'dependent-construct' })
    expect(r.root.innerHTML).toBe(before)
  })

  it('origin host over a dirty unit falls back dirty-overlap', () => {
    const r = open(THREE)
    type(r, 1, 'beta typed')
    expect(
      r.session.applyText([change(THREE, 'beta', 'BETA')], 'host'),
    ).toEqual({ kind: 'fallback', reason: 'dirty-overlap' })
    expect(paragraph(r, 1).data).toBe('beta typed')
  })

  it('origin host posts nothing and keeps a dirty unit outside the window dirty', () => {
    const r = open(THREE)
    type(r, 2, 'gamma typed')
    const typedEl = r.root.querySelectorAll('p')[2]
    expect(
      r.session.applyText([change(THREE, 'alpha', 'ALPHA')], 'host'),
    ).toEqual({ kind: 'applied' })
    expect(r.session.deltaPort().hasDirty()).toBe(true)
    expect(r.root.querySelectorAll('p')[2]).toBe(typedEl)
    expect(r.root.querySelectorAll('p')[0].textContent).toContain('ALPHA')
    const prepared = r.session.deltaPort().prepareDelta(1)
    expect(prepared.kind).toBe('changes')
    if (prepared.kind === 'changes')
      expect(prepared.changes.map((c) => c.insert).join('')).toContain('typed')
  })

  it('origin host keeps a dirty table cell outside the window dirty and the cell element (Q-62)', () => {
    const doc = 'intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
    const r = open(doc)
    const cell = r.root.querySelector('tbody td') as HTMLElement
    cell.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    ;(cell.firstChild as Text).data = '1x'
    expect(
      r.session.applyText([change(doc, 'intro', 'INTRO')], 'host'),
    ).toEqual({ kind: 'applied' })
    expect(r.root.querySelector('tbody td')).toBe(cell)
    expect(r.session.deltaPort().hasDirty()).toBe(true)
  })

  it('Undo of an applied change over an unproven removed paragraph restores its bytes', () => {
    const r = open(THREE)
    const port = r.session.historyPort()
    expect(r.stats().proven).toBe(0)
    port.capture()
    expect(
      r.session.applyText([change(THREE, 'beta', 'BETA')], 'exact'),
    ).toEqual({ kind: 'applied' })
    const capture = port.capture()
    expect(capture).toBeDefined()
    expect(port.restore(capture!, 'before')).toBe(true)
    expect(r.root.querySelectorAll('p')[1].textContent).toContain('beta')
    const prepared = r.session.deltaPort().prepareDelta(2)
    expect(prepared).toMatchObject({ kind: 'changes' })
    expect(r.session.deltaPort().modelText()).toBe(THREE)
  })
})

describe('rebuildAfterExact (Task 733 / 010)', () => {
  it("builds over a caller's setValue in the same epoch", () => {
    const r = open('alpha\n\nbeta\n', 5)
    const next = 'beta\n\nalpha\n'
    r.render(next)
    r.session.rebuildAfterExact(next)
    r.runFrames()
    expect(r.stats().state).toBe('live')
    expect(r.session.deltaPort().epoch()).toBe(5)
    expect(r.session.deltaPort().modelText()).toBe(next)
    expect(r.session.ownsText()).toBe(true)
  })
})

describe('adoptHostEpoch (Task 733 / 010, Q-80)', () => {
  it('takes the host text and epoch after an apply by units and keeps the units', () => {
    const doc = 'alpha\n\nbeta\n'
    const r = open(doc, 3)
    const kept = r.root.querySelectorAll('p')[1]
    const next = 'ALPHA\n\nbeta\n'
    expect(
      r.session.applyText([{ from: 0, to: 5, insert: 'ALPHA' }], 'host'),
    ).toEqual({ kind: 'applied' })
    r.session.adoptHostEpoch(next, 4)
    expect(r.session.deltaPort().epoch()).toBe(4)
    expect(r.session.deltaPort().modelText()).toBe(next)
    expect(r.session.confirmedSnapshot()).toEqual({ text: next, epoch: 4 })
    expect(r.session.ownsText()).toBe(true)
    expect(r.root.querySelectorAll('p')[1]).toBe(kept)
    r.runFrames()
    expect(r.stats().state).toBe('live')
  })

  it('does nothing while the model is off', () => {
    const r = rig()
    r.session.adoptHostEpoch('x\n', 9)
    expect(r.session.deltaPort().epoch()).toBeUndefined()
  })
})

describe('applyText feed and epoch costs (010-R F11, F12)', () => {
  it('a row apply names its table in the feed, not a whole change', () => {
    const doc = 'intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n'
    const r = open(doc)
    const changes: UnitsChange[] = []
    r.session.onUnitsChanged((c) => changes.push(c))
    const from = doc.indexOf('| 3 |') + 2
    expect(
      r.session.applyText([{ from, to: from + 1, insert: 'X' }], 'exact'),
    ).toEqual({ kind: 'applied' })
    expect(changes).toHaveLength(1)
    expect(changes[0].whole).toBe(false)
    expect(changes[0].changed.map((unit) => unit.kind)).toEqual(['table'])
  })

  it('a deletion names the neighbouring units, not a whole change', () => {
    const doc = 'alpha\n\nbeta\n\ngamma\n'
    const r = open(doc)
    const changes: UnitsChange[] = []
    r.session.onUnitsChanged((c) => changes.push(c))
    const from = doc.indexOf('beta')
    expect(
      r.session.applyText([{ from, to: from + 6, insert: '' }], 'exact'),
    ).toEqual({ kind: 'applied' })
    expect(r.session.deltaPort().modelText()).toBe('alpha\n\ngamma\n')
    expect(changes).toHaveLength(1)
    expect(changes[0].whole).toBe(false)
    expect(changes[0].changed.length).toBeGreaterThan(0)
  })

  it('adoptHostEpoch still resets changedAt after a delta set one in the epoch', () => {
    const r = open('alpha\n\nbeta\n', 3)
    type(r, 1, 'beta2')
    const prepared = r.session.deltaPort().prepareDelta(1)
    expect(prepared.kind).toBe('changes')
    const typedUnit = r.session.confirmedUnits()?.[1]
    expect(typedUnit?.changedAt).toBe(1)
    r.session.applyText([{ from: 0, to: 5, insert: 'ALPHA' }], 'host')
    r.session.adoptHostEpoch('ALPHA\n\nbeta2\n', 4)
    expect(r.session.confirmedUnits()?.[1]?.changedAt).toBe(0)
  })
})

describe('Undo of a list item move applied by units (DR1)', () => {
  it('restores a lazy continuation item order', () => {
    const doc = '- first\nlazy continuation\n- second\n'
    const moved = '- second\n- first\nlazy continuation\n'
    const r = open(doc)
    const port = r.session.historyPort()
    port.capture()
    const changes = [
      { from: 0, to: doc.length - 1, insert: moved.slice(0, -1) },
    ]
    expect(r.session.applyText(changes, 'exact')).toEqual({ kind: 'applied' })
    expect(r.session.deltaPort().modelText()).toBe(moved)
    const capture = port.capture()
    expect(capture).toBeDefined()
    expect(port.restore(capture!, 'before')).toBe(true)
    r.session.deltaPort().prepareDelta(2)
    expect(r.session.deltaPort().modelText()).toBe(doc)
  })
})

describe('reopenTyping (DR2)', () => {
  it('makes typing taken by prepareDelta pending again as a whole-text publication', () => {
    const doc = 'alpha\n\nbeta\n'
    const r = open(doc)
    type(r, 1, 'beta2')
    const taken = r.session.deltaPort().prepareDelta(1)
    expect(taken.kind).toBe('changes')
    expect(r.session.deltaPort().hasDirty()).toBe(false)
    r.session.reopenTyping(doc)
    expect(r.session.deltaPort().modelText()).toBe(doc)
    expect(r.session.deltaPort().hasDirty()).toBe(true)
    // The next publication is whole-text: it carries the DOM, the typing included.
    expect(r.session.deltaPort().prepareDelta(2).kind).toBe('fallback')
  })
})

// Task 733 / 012-12-T (D-13 design section 5.2, B-03): the change a list item Enter emits names the two
// items of the spin pair as its scopes. Without `scopes` (the C1 gap), feed consumers fall back
// to `scopeUnits` and rescan the whole list (`U/mutation-impact.ts` `scopeUnits`). The documents are the
// table-heavy fixture (a list of 10 x factor items) and a 500-item list, rendered fresh per test with the
// production Lute patches because the case writes the DOM and needs a live model.
describe('list item Enter scopes (Task 733 / 012-12, B-03)', () => {
  // A live model over the factor-16 fixture takes seconds to build (several times that under a full parallel run).
  const BUILD_TIMEOUT_MS = 60_000
  type ScopedChange = UnitsChange & { readonly scopes?: readonly HTMLElement[] }
  const LONG_LIST = `${Array.from({ length: 500 }, (_, i) => `- entry ${i + 1}`).join('\n')}\n`

  /**
   * Enter in the middle of item `index`, as the browser and the spin hook write it: a new `li` after the
   * item (one child-list record on the list), then the spin pair rewrites the text of both items.
   */
  function enterInItem(r: Rig, index: number) {
    const list = r.root.querySelector(':scope > ul') as HTMLElement
    const item = list.children[index] as HTMLElement
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

  function openScoped(markdown: string) {
    const r = open(markdown)
    r.runFrames()
    const changes: ScopedChange[] = []
    r.session.onUnitsChanged((change) => {
      changes.push(change)
    })
    return { r, changes }
  }

  const cases: Array<[string, () => string, number]> = [
    ['the table-heavy fixture at factor 1', () => tableHeavyMarkdown(1), 4],
    ['the table-heavy fixture at factor 4', () => tableHeavyMarkdown(4), 4],
    ['the table-heavy fixture at factor 16', () => tableHeavyMarkdown(16), 4],
    ['a 500-item list', () => LONG_LIST, 249],
  ]

  it.each(cases)(
    'the feed frame change of an Enter in %s scopes the two items',
    (_name, markdown, index) => {
      const { r, changes } = openScoped(markdown())
      const { list, item, fresh } = enterInItem(r, index)
      r.session.confirmedUnits() // drains the batch
      r.runFrames()
      const frame = changes.filter((c) => c.cause === 'mutation')
      expect(frame).toHaveLength(1)
      const change = frame[0]
      expect(change.whole).toBe(false)
      expect(change.scopes).toEqual([item, fresh])
      expect(change.changed.length).toBeLessThanOrEqual(2)
      for (const unit of change.changed)
        expect([item, fresh]).toContain(unit.el)
      expect(change.structural).toEqual([list])
    },
    BUILD_TIMEOUT_MS,
  )

  it.each(cases)(
    'the sync after an Enter in %s is no whole change and scopes only the items',
    (_name, markdown, index) => {
      const { r, changes } = openScoped(markdown())
      const { item, fresh } = enterInItem(r, index)
      r.session.confirmedUnits()
      r.runFrames()
      expect(r.session.deltaPort().prepareDelta(1).kind).toBe('changes')
      r.runFrames()
      const sync = changes.filter((c) => c.cause === 'sync')
      expect(sync.map((c) => c.whole)).not.toContain(true)
      for (const change of sync) {
        expect(change.scopes).toBeDefined()
        for (const scope of change.scopes ?? [])
          expect([item, fresh]).toContain(scope)
      }
    },
    BUILD_TIMEOUT_MS,
  )
})

// ---- Task 733 / 013-T1: the model in WYSIWYG (technical task 013 section 6.2, shared rules 3.12) ----
//
// A rig with both mode roots, as Vditor keeps them: `getRoot` answers the root of the served mode. The
// WYSIWYG root holds Lute's WYSIWYG DOM (`wysiwygFixture` HTML), the IR root Lute's IR DOM.
describe('013 WYSIWYG model session', () => {
  let wysiwygLute: UnitLute & Record<string, (value: string) => string>
  beforeAll(() => {
    const real = createRealLute('wysiwyg')
    patchLuteTableCodePipes(real.lute)
    patchLuteGapRepair(real.lute)
    wysiwygLute = real.lute
  })

  function modeRig(options: { mode: 'ir' | 'wysiwyg'; wysiwygUnits: boolean }) {
    const irRoot = document.createElement('div')
    irRoot.className = 'vditor-reset vditor-ir'
    const wysiwygRoot = document.createElement('div')
    wysiwygRoot.className = 'vditor-reset vditor-wysiwyg'
    document.body.append(irRoot, wysiwygRoot)
    const mode = { value: options.mode as string }
    const frames: Array<() => void> = []
    const session = createModelSession({
      wysiwygUnits: options.wysiwygUnits,
      win: window,
      getRoot: () => (mode.value === 'wysiwyg' ? wysiwygRoot : irRoot),
      getLute: () => (mode.value === 'wysiwyg' ? wysiwygLute : lute),
      getMode: () => mode.value,
      isPreviewShowing: () => false,
      isStreaming: () => false,
      isComposing: () => false,
      e2e: true,
      countFallbackPublication: () => undefined,
      requestAnimationFrame: (cb: () => void) => frames.push(cb),
      cancelAnimationFrame: () => undefined,
      now: () => 0,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      inViewport: () => false,
    } as Parameters<typeof createModelSession>[0])
    live.push(session)
    return {
      session,
      irRoot,
      wysiwygRoot,
      mode,
      stats: () =>
        (window as unknown as Record<string, any>).__vmdeModelShadowStats,
      runFrames() {
        for (const cb of frames.splice(0)) cb()
      },
      /** Renders `markdown` into both roots, as the two mode trees of Vditor. */
      render(markdown: string) {
        irRoot.innerHTML = lute.Md2VditorIRDOM(markdown)
        wysiwygRoot.innerHTML = wysiwygFixture(markdown).root.innerHTML
      },
    }
  }

  /** A WYSIWYG model built and live over `markdown`. */
  function openWysiwyg(markdown: string, wysiwygUnits = true) {
    const r = modeRig({ mode: 'wysiwyg', wysiwygUnits })
    r.render(markdown)
    r.session.onHostText(markdown, 3)
    r.session.onEditDomComplete()
    return r
  }

  const TABLE_DOC =
    'intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- one\n- two\n\n```ts\nconst a = 1\n```\n'

  it('builds over the WYSIWYG root and publishes typing as a delta', () => {
    const r = openWysiwyg(TABLE_DOC)
    expect(r.stats()).toMatchObject({ state: 'live', mode: 'wysiwyg' })
    expect(r.session.canPublishDelta()).toBe(true)
    expect(r.session.confirmedSnapshot()).toEqual({ text: TABLE_DOC, epoch: 3 })
    const paragraph = r.wysiwygRoot.querySelector('p') as HTMLElement
    paragraph.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    ;(paragraph.firstChild as Text).data = 'intro2'
    const port = r.session.deltaPort()
    expect(port.prepareDelta(1).kind).toBe('changes')
    expect(port.modelText()).toBe(TABLE_DOC.replace('intro', 'intro2'))
  })

  it('serves cells and items of the WYSIWYG DOM as live units', () => {
    const r = openWysiwyg(TABLE_DOC)
    const cell = r.wysiwygRoot.querySelector('td') as HTMLElement
    expect(r.session.liveUnitOf(cell.firstChild as Text)?.kind).toBe('cell')
    const item = r.wysiwygRoot.querySelector('li') as HTMLElement
    expect(r.session.liveUnitOf(item.firstChild as Text)?.kind).toBe(
      'list-item',
    )
  })

  it("stays off with reason mode when WYSIWYG units are off (today's path)", () => {
    const r = openWysiwyg(TABLE_DOC, false)
    expect(r.stats()).toMatchObject({ state: 'off', offReason: 'mode' })
    expect(r.session.canPublishDelta()).toBe(false)
    expect(r.session.beforeWholeTextPost(1)).toBeUndefined()
  })

  // Task 733 / 020 (Q-164, written ownership extension): the 013 case asserted the re-entry path (each
  // first post asked for the host bytes). A switch between IR and WYSIWYG now keeps the owned text, so
  // each mode's model builds on the next frame with the same epoch and no rebind.
  it('keeps the owned text on IR to WYSIWYG to IR: each mode builds on the next frame with no rebind', () => {
    const r = modeRig({ mode: 'ir', wysiwygUnits: true })
    r.render(TABLE_DOC)
    r.session.onHostText(TABLE_DOC, 3)
    r.session.onEditDomComplete()
    expect(r.stats()).toMatchObject({ state: 'live', mode: 'ir' })
    for (const next of ['wysiwyg', 'ir'] as const) {
      r.mode.value = next
      r.session.onModeChange(next)
      r.runFrames()
      expect(r.stats(), next).toMatchObject({ state: 'live', mode: next })
      expect(r.session.canPublishDelta()).toBe(true)
      expect(r.session.confirmedSnapshot()).toEqual({
        text: TABLE_DOC,
        epoch: 3,
      })
    }
  })

  // Run 1 triage 4.3 (R-2): the session can learn of a switch late (no `onModeChange` yet). While the
  // shown mode differs from the built one, nothing may answer for the hidden model: the unit engine
  // would claim the WYSIWYG history over the IR root and consumers would see the IR feed as live.
  it('answers for no model while the shown mode differs from the built one', () => {
    const r = modeRig({ mode: 'ir', wysiwygUnits: true })
    r.render(TABLE_DOC)
    r.session.onHostText(TABLE_DOC, 3)
    r.session.onEditDomComplete()
    const port = (
      r.session as ModelSession & {
        historyPort(): { claimable(): boolean; ready(): boolean }
      }
    ).historyPort()
    const cell = r.irRoot.querySelector('td') as HTMLElement
    expect(port.claimable()).toBe(true)
    expect(r.session.isLive()).toBe(true)
    // Vditor shows WYSIWYG; the session has not been told.
    r.mode.value = 'wysiwyg'
    expect(port.claimable(), 'history port claimable').toBe(false)
    expect(port.ready(), 'history port ready').toBe(false)
    expect(r.session.isLive(), 'feed live').toBe(false)
    expect(r.session.liveUnits(), 'live units').toBeUndefined()
    expect(r.session.liveUnitOf(cell.firstChild as Text)).toBeUndefined()
    expect(r.session.confirmedUnits(), 'confirmed units').toBeUndefined()
    // Back in IR the same model answers again.
    r.mode.value = 'ir'
    expect(port.claimable()).toBe(true)
    expect(r.session.isLive()).toBe(true)
  })

  // B-03 on the WYSIWYG fixture (D-13 design section 5.2): a list item Enter is a scoped change.
  describe.each([1, 4, 16] as const)(
    'B-03 list item Enter at factor %i',
    (factor) => {
      it('reports whole false, the two items as scopes and the list as structural', () => {
        const markdown = tableHeavyMarkdown(factor)
        const r = openWysiwyg(markdown)
        r.runFrames()
        const changes: UnitsChange[] = []
        r.session.onUnitsChanged((change) => {
          changes.push(change)
        })
        const list = r.wysiwygRoot.querySelector(':scope > ul') as HTMLElement
        const item = list.children[2] as HTMLElement
        item.dispatchEvent(new Event('beforeinput', { bubbles: true }))
        // Enter inside the item, as the browser and the 011 pair spin leave it: the item split in two.
        const text = item.firstChild as Text
        const added = item.cloneNode(false) as HTMLElement
        added.textContent = text.data.slice('list item'.length)
        text.data = text.data.slice(0, 'list item'.length)
        item.after(added)
        r.session.confirmedUnits()
        r.runFrames()
        expect(changes).toHaveLength(1)
        const change = changes[0] as UnitsChange & {
          scopes?: readonly HTMLElement[]
        }
        expect(change.whole).toBe(false)
        expect(change.scopes).toEqual([item, added])
        expect(change.changed.length).toBeLessThanOrEqual(2)
        expect(change.structural).toEqual([list])
      }, 60_000)
    },
  )
})

// Task 733 / 015-T1, S-07 and S-12 (task 015 sections 6.2 D-5 and 6.3): the model survives a switch
// to Source and back with its epoch, with no `rebind` round trip and no whole-document IR
// serialization by the session. With unpublished typing, or with `SOURCE_UNITS` off, today's path runs:
// the host text is dropped and the IR re-entry asks for a `rebind`. The two session members are those
// of task 015 section 6.4, read through a cast so this file typechecks before they exist.
interface SourceSessionApi {
  liveMode?(): 'ir' | 'sv' | undefined
  modeSwitchText?(): string | undefined
}
const sourceApi = (r: Rig) => r.session as unknown as SourceSessionApi

// Factor 16 renders the IR DOM of a 208 KB document twice with the real Lute (about 7 s in jsdom).
const SWITCH_TIMEOUT_MS = 30_000

describe.each([1, 4, 16] as const)(
  'S-07 mode switch at factor %i',
  (factor) => {
    const markdown = tableHeavyMarkdown(factor)
    let sv: ReturnType<typeof createRealLute>
    beforeAll(() => {
      sv = createRealLute('sv')
      countedLute(lute)
    })
    afterEach(() => {
      sourceUnits.value = true
    })

    /** Vditor's switch into Source: the spin of `text`, split into `data-block` divs. */
    const toSource = (r: Rig, text: string) => {
      r.mode.value = 'sv'
      r.sourceRoot.innerHTML = svBlocksHtml(sv.render(text))
      return countBudget(r.root, () => {
        r.session.onModeChange('sv')
        r.session.onEditDomComplete()
        r.runFrames()
      }).counts
    }
    const toIr = (r: Rig, text: string) => {
      r.mode.value = 'ir'
      r.render(text)
      r.session.onModeChange('ir')
      r.session.onEditDomComplete()
      r.runFrames()
    }

    it(
      'keeps the text and epoch through IR, Source and IR',
      () => {
        const r = open(markdown, 3)
        const api = sourceApi(r)
        expect(typeof api.modeSwitchText).toBe('function')
        expect(api.modeSwitchText?.()).toBe(markdown)
        const counts = toSource(r, markdown)
        expect(counts.luteCalls).toBe(0)
        expect(api.liveMode?.()).toBe('sv')
        expect(r.session.confirmedSnapshot()).toEqual({
          text: markdown,
          epoch: 3,
        })
        expect(api.modeSwitchText?.()).toBe(markdown)
        toIr(r, markdown)
        expect(api.liveMode?.()).toBe('ir')
        // No `onRebind` was delivered: the model is confirmed from the kept host text.
        expect(r.session.confirmedSnapshot()).toEqual({
          text: markdown,
          epoch: 3,
        })
      },
      SWITCH_TIMEOUT_MS,
    )

    it(
      'takes the rebind path when typing is unpublished at the switch',
      () => {
        const r = open(markdown, 3)
        const api = sourceApi(r)
        expect(typeof api.modeSwitchText).toBe('function')
        type(r, 0, 'typed but not published')
        expect(api.modeSwitchText?.()).toBeUndefined()
      },
      SWITCH_TIMEOUT_MS,
    )

    it(
      'S-12 with SOURCE_UNITS off keeps the model off in Source and asks for a rebind in IR',
      () => {
        sourceUnits.value = false
        const r = open(markdown, 3)
        const api = sourceApi(r)
        expect(typeof api.liveMode).toBe('function')
        toSource(r, markdown)
        expect(api.liveMode?.()).toBeUndefined()
        toIr(r, markdown)
        expect(r.session.confirmedSnapshot()).toBeUndefined()
      },
      SWITCH_TIMEOUT_MS,
    )
  },
)

// Task 733 / 019 (Q-154, D-7 of the Source design): with the Source model built, the session's history
// port is the Source port; in IR it stays the IR port. 019-A3: a Text split in a Source unit (the unit
// engine's `splitAtCaret`, Vditor's caret marker) changes no text, so the session still owns the text.
describe('019 Source history port and owned text', () => {
  let sv: ReturnType<typeof createRealLute>
  beforeAll(() => {
    sv = createRealLute('sv')
  })
  const toSource = (r: Rig, text: string) => {
    r.mode.value = 'sv'
    r.sourceRoot.innerHTML = svBlocksHtml(sv.render(text))
    r.session.onModeChange('sv')
    r.session.onEditDomComplete()
    r.runFrames()
  }
  const toIr = (r: Rig, text: string) => {
    r.mode.value = 'ir'
    r.render(text)
    r.session.onModeChange('ir')
    r.session.onEditDomComplete()
    r.runFrames()
  }

  it('serves the Source port while the Source model is built and the IR port in IR', () => {
    const r = open(DOC, 3)
    const irPort = r.session.historyPort()
    expect(irPort).toBeDefined()
    toSource(r, DOC)
    expect(sourceApi(r).liveMode?.()).toBe('sv')
    const sourcePort = r.session.historyPort()
    expect(sourcePort).toBeDefined()
    expect(sourcePort).not.toBe(irPort)
    expect(sourcePort?.claimable()).toBe(true)
    expect(sourcePort?.ready()).toBe(true)
    toIr(r, DOC)
    expect(sourceApi(r).liveMode?.()).toBe('ir')
    expect(r.session.historyPort()).toBe(irPort)
  })

  it('owns the text after a Text node of a Source unit is split (019-A3)', () => {
    const r = open(DOC, 3)
    toSource(r, DOC)
    expect(sourceApi(r).modeSwitchText?.()).toBe(DOC)
    const walker = document.createTreeWalker(r.sourceRoot, NodeFilter.SHOW_TEXT)
    let text = walker.nextNode() as Text | null
    while (text && text.data.length < 2) text = walker.nextNode() as Text | null
    expect(text).not.toBeNull()
    text?.splitText(1)
    expect(sourceApi(r).modeSwitchText?.()).toBe(DOC)
  })
})

// Task 733 / 020 (W-A, Q-164): a switch between IR and WYSIWYG keeps the owned text, as a switch into
// or out of Source does. The model of the new mode builds on the next frame from that text, with no
// `rebind` round trip; with WYSIWYG units off the switch keeps today's path.
describe('020 IR and WYSIWYG switch keeps the owned text', () => {
  let wysiwygLute: UnitLute
  beforeAll(() => {
    const real = createRealLute('wysiwyg')
    patchLuteTableCodePipes(real.lute)
    patchLuteGapRepair(real.lute)
    wysiwygLute = real.lute
  })

  const SWITCH_DOC =
    'intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- one\n- two\n\nTail.\n'

  /** A live IR model over SWITCH_DOC with both mode trees rendered. */
  function openIr(wysiwygUnits: boolean) {
    const irRoot = document.createElement('div')
    irRoot.className = 'vditor-reset vditor-ir'
    const wysiwygRoot = document.createElement('div')
    wysiwygRoot.className = 'vditor-reset vditor-wysiwyg'
    document.body.append(irRoot, wysiwygRoot)
    irRoot.innerHTML = lute.Md2VditorIRDOM(SWITCH_DOC)
    wysiwygRoot.innerHTML = wysiwygFixture(SWITCH_DOC).root.innerHTML
    const mode = { value: 'ir' }
    const frames: Array<() => void> = []
    const session = createModelSession({
      wysiwygUnits,
      win: window,
      getRoot: () => (mode.value === 'wysiwyg' ? wysiwygRoot : irRoot),
      getLute: () => (mode.value === 'wysiwyg' ? wysiwygLute : lute),
      getMode: () => mode.value,
      isPreviewShowing: () => false,
      isStreaming: () => false,
      isComposing: () => false,
      e2e: true,
      countFallbackPublication: () => undefined,
      requestAnimationFrame: (cb: () => void) => frames.push(cb),
      cancelAnimationFrame: () => undefined,
      now: () => 0,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      inViewport: () => false,
    } as Parameters<typeof createModelSession>[0])
    live.push(session)
    session.onHostText(SWITCH_DOC, 3)
    session.onEditDomComplete()
    const runFrames = () => {
      for (const cb of frames.splice(0)) cb()
    }
    runFrames()
    const stats = () =>
      (window as unknown as Record<string, any>).__vmdeModelShadowStats
    const switchTo = (next: 'ir' | 'wysiwyg') => {
      mode.value = next
      session.onModeChange(next)
    }
    return { session, stats, runFrames, switchTo, frames }
  }

  it('IR to WYSIWYG builds the WYSIWYG model on the next frame from the kept text, with no rebind', () => {
    const r = openIr(true)
    expect(r.stats()).toMatchObject({ state: 'live', mode: 'ir' })
    r.switchTo('wysiwyg')
    expect(r.frames.length, 'a build frame is requested').toBeGreaterThan(0)
    r.runFrames()
    expect(r.stats()).toMatchObject({ state: 'live', mode: 'wysiwyg' })
    expect(r.session.canPublishDelta()).toBe(true)
    // The host epoch is kept: the model owns the same bytes, with no re-entry post.
    expect(r.session.confirmedSnapshot()).toEqual({
      text: SWITCH_DOC,
      epoch: 3,
    })
  })

  it('WYSIWYG back to IR keeps the text the same way', () => {
    const r = openIr(true)
    r.switchTo('wysiwyg')
    r.runFrames()
    r.switchTo('ir')
    r.runFrames()
    expect(r.stats()).toMatchObject({ state: 'live', mode: 'ir' })
    expect(r.session.confirmedSnapshot()).toEqual({
      text: SWITCH_DOC,
      epoch: 3,
    })
  })

  it("with WYSIWYG units off, IR to WYSIWYG turns the model off with reason mode (today's path)", () => {
    const r = openIr(false)
    r.switchTo('wysiwyg')
    r.runFrames()
    expect(r.stats()).toMatchObject({ state: 'off', offReason: 'mode' })
    expect(r.session.canPublishDelta()).toBe(false)
  })
})
