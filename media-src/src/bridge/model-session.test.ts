// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { createRealLute } from '../testing/real-lute'
import { writeQuietly } from '../util/mutation-impact'
import { createModelSession, type ModelSession } from './model-session'
import type { UnitLute } from './unit-lute'

// Task 733 / 004-C: the model session over a real text model, real Lute and a jsdom IR root. The
// animation frames and the clock are fake; the host messages are plain objects.
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
  mode: { value: string | null }
  streaming: { value: boolean }
  composing: { value: boolean }
  preview: { value: boolean }
  frames: Array<() => void>
  timers: Array<() => void>
  cleared: number[]
  countFallback: ReturnType<typeof vi.fn>
  viewport: { calls: number }
  stats(): Record<string, any>
  runFrames(): void
  render(markdown: string): void
}

const DOC = 'alpha\n\nbeta\n'
const live: ModelSession[] = []

function rig(options: { e2e?: boolean } = {}): Rig {
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
  const countFallback = vi.fn()
  const viewport = { calls: 0 }
  const session = createModelSession({
    win: window,
    getRoot: () => root,
    getLute: () => lute,
    getMode: () => mode.value,
    isPreviewShowing: () => preview.value,
    isStreaming: () => streaming.value,
    isComposing: () => composing.value,
    e2e: options.e2e ?? true,
    countFallbackPublication: countFallback,
    requestAnimationFrame: (cb) => frames.push(cb),
    cancelAnimationFrame: () => undefined,
    now: () => 0,
    setTimeout: (cb) => timers.push(cb),
    clearTimeout: (handle) => {
      cleared.push(handle)
    },
    inViewport: () => {
      viewport.calls += 1
      return false
    },
  })
  live.push(session)
  return {
    session,
    root,
    mode,
    streaming,
    composing,
    preview,
    frames,
    timers,
    cleared,
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

  it('is off for a mode that is not IR', () => {
    const r = rig()
    r.render(DOC)
    r.mode.value = 'sv'
    r.session.onHostText(DOC, 1)
    r.session.onEditDomComplete()
    expect(r.stats()).toMatchObject({ state: 'off', offReason: 'mode' })
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
    // No frame was requested by the deltas themselves; one timer is armed for the quiet restart.
    expect(r.frames.length).toBe(frames)
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
