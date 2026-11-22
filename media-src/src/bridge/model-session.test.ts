// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import { countBudget, countedLute } from '../testing/budget-harness'
import { createRealLute, svBlocksHtml } from '../testing/real-lute'
import { writeQuietly } from '../util/mutation-impact'
import type { UnitsChange } from '../util/unit-changes'
import { createModelSession, type ModelSession } from './model-session'
import { tracePublication } from './delta-sync'
import type { UnitLute } from './unit-lute'
import { wysiwygFixture } from '../testing/budget-harness'
import { normalizeReplaceHunks } from '../editing/find-engine'
import {
  installWebviewContext,
  webviewContextDrainFor,
} from '../chrome/webview-context'

// Task 733 / 004-C: the model session over a real text model, real Lute and a jsdom IR root. The
// animation frames and the clock are fake; the host messages are plain objects.
// Task 733 / 015-T1 (S-12): `SOURCE_UNITS` (`U/unit-changes.ts`, task 015 section 6.9 item 1) as a
// switch the Source tests set; the other tests leave it on.
const sourceUnits = vi.hoisted(() => ({ value: true }))
// H2 fix design rev2 (review point 4): a switch that makes every replay group's expected-old check fail, so a
// test reaches the engine's mismatch stop; off for every other test.
const forceMismatch = vi.hoisted(() => ({ value: false }))
vi.mock('./replay-target', async (original) => {
  const actual = await original<typeof import('./replay-target')>()
  return {
    ...actual,
    createReplayTarget: (
      ...args: Parameters<typeof actual.createReplayTarget>
    ) => {
      const target = actual.createReplayTarget(...args)
      if (target && forceMismatch.value) target.checkOld = () => false
      return target
    },
  }
})
// H2 fix design rev2 (D5.4): counts the whole-text constructions (one new model text each); pass-through.
// S4 repair (fixes 1-2): `mode` makes the commit's text build throw, or write one extra character.
const wholeTexts = vi.hoisted(() => ({
  count: 0,
  mode: 'none' as 'none' | 'throw' | 'corrupt',
}))
vi.mock('./change-set', async (original) => {
  const actual = await original<typeof import('./change-set')>()
  return {
    ...actual,
    applyChanges: (...args: Parameters<typeof actual.applyChanges>) => {
      wholeTexts.count++
      if (wholeTexts.mode === 'throw') throw new Error('commit failed')
      const text = actual.applyChanges(...args)
      return wholeTexts.mode === 'corrupt' ? `${text}X` : text
    },
  }
})
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

function rig(
  options: {
    e2e?: boolean
    wysiwygUnits?: boolean
    /** Task 733 / 036: dependencies the session does not have yet (provisional names). */
    deps?: Record<string, unknown>
  } = {},
): Rig {
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
    ...options.deps,
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
function open(
  markdown = DOC,
  epoch = 3,
  options?: { e2e?: boolean; deps?: Record<string, unknown> },
): Rig {
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

  it('036: counts pending structure windows in structureDirty, apart from dirtyNow', () => {
    const r = open()
    expect(r.stats().structureDirty).toBe(0)
    r.root.appendChild(document.createElement('p'))
    const stats = r.stats()
    expect(stats.structureDirty).toBeGreaterThan(0)
    expect(stats.dirtyNow).toBe(0)
  })

  it('036: trace entries record the touched proof and the structure state in end-to-end runs only', () => {
    const slot = globalThis as unknown as {
      __vmdeE2EReadiness?: unknown
      __vmdePublicationTrace?: Array<Record<string, unknown>>
    }
    slot.__vmdeE2EReadiness = {}
    try {
      const r = open()
      tracePublication('fallback', 0, 'sync-error')
      type(r, 0, 'alpha2')
      tracePublication('fallback', 0, 'sync-error')
      r.root.appendChild(document.createElement('p'))
      r.stats() // drains the observer
      tracePublication('fallback', 0, 'sync-error')
      expect(
        (slot.__vmdePublicationTrace ?? []).map(
          ({ touched, structureDirty }) => [touched, structureDirty],
        ),
      ).toEqual([
        ['none', 0],
        ['proven', 0],
        ['proven', 1],
      ])
      r.session.dispose()
      const quiet = open(DOC, 1, { e2e: false })
      type(quiet, 0, 'alpha3')
      tracePublication('delta', 1)
      const last = slot.__vmdePublicationTrace?.at(-1) ?? {}
      expect('touched' in last || 'structureDirty' in last).toBe(false)
    } finally {
      delete slot.__vmdeE2EReadiness
      delete slot.__vmdePublicationTrace
    }
  })

  it('036: a pre-touch proof that falls back records unproven at the fallback decision', () => {
    const slot = globalThis as unknown as {
      __vmdeE2EReadiness?: unknown
      __vmdePublicationTrace?: Array<Record<string, unknown>>
    }
    slot.__vmdeE2EReadiness = {}
    try {
      const r = open()
      // A change the pre-touch proof did not see: the unit is dirty and its DOM no longer
      // serializes to its bytes, so the next editing event's proof refuses it.
      paragraph(r, 0).data = 'alpha **'
      r.stats()
      r.root
        .querySelectorAll('p')[0]
        .dispatchEvent(new Event('beforeinput', { bubbles: true }))
      expect(r.session.deltaPort().prepareDelta(1)).toEqual({
        kind: 'fallback',
        reason: 'unproven-selection',
      })
      tracePublication('fallback', 0, 'unproven-selection')
      expect(slot.__vmdePublicationTrace?.at(-1)?.touched).toBe('unproven')
    } finally {
      delete slot.__vmdeE2EReadiness
      delete slot.__vmdePublicationTrace
    }
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

// Task 733 / 021 (run 1 repair, `edit-path-scans:316`): a paragraph typed into a definition is spun into a
// new definitions div that the model lists only at the next sync. A key in it before that sync must find a
// definition unit, or the unit spin refuses and Vditor's whole-root spin moves the definition to the end.
describe('liveUnitOf: a definitions div typed since the last sync (021 run 1)', () => {
  const DEF_DOC = 'intro\n\ntail\n'

  /** Inserts an unmapped top-level div before the second paragraph, as the block spin writes it. */
  function insertBeforeTail(r: Rig, html: string): HTMLElement {
    const template = document.createElement('template')
    template.innerHTML = html
    const div = template.content.firstElementChild as HTMLElement
    r.root.insertBefore(div, r.root.querySelectorAll('p')[1])
    return div
  }

  it('answers the unmapped definitions div as a definition unit', () => {
    const r = open(DEF_DOC)
    const div = insertBeforeTail(
      r,
      '<div data-block="0" data-type="link-ref-defs-block">[r]: https\n</div>',
    )
    const unit = r.session.liveUnitOf(div.firstChild as Text)
    expect(unit?.kind).toBe('definition')
    expect(unit?.el).toBe(div)
    expect(unit?.top).toBe(div)
  })

  it('answers nothing for any other unmapped top-level block (guard)', () => {
    const r = open(DEF_DOC)
    const div = insertBeforeTail(r, '<p data-block="0">fresh</p>')
    expect(r.session.liveUnitOf(div.firstChild as Text)).toBeUndefined()
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

// Task 733 / 022 (Q-183): Vditor's engine runs an Undo while a whole post awaits its rebind answer. The
// session keeps the text from before that post and publishes the transition with exact host bytes at
// the answer, then builds the model from the kept text with no `rebind` pairing.
describe('022: history during a pending rebind', () => {
  type HoldApi = {
    holdHistoryTransition(
      kind: 'undo' | 'redo',
      publish: (transition: {
        kind: 'undo' | 'redo'
        before: string
        after: string
      }) => number | undefined,
    ): boolean
    publicationHeld(): boolean
  }
  const REPLACED = 'ZZZZ\n\nbeta\n'
  const holdApi = (r: Rig) => r.session as unknown as HoldApi

  /** A live model over DOC, then a root rewrite to REPLACED published as an unshadowed whole post 1. */
  function replaceAll() {
    const r = open()
    r.runFrames()
    r.render(REPLACED)
    expect(r.session.beforeWholeTextPost(1, { predict: false })).toEqual({
      rebind: true,
    })
    const causes: string[] = []
    r.session.onUnitsChanged((change) => causes.push(change.cause))
    return { r, causes }
  }
  const answer = (r: Rig, content: string, editSequence: number) =>
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content,
      editSequence,
    })

  it('holds an Undo after an unshadowed whole post with the model live', () => {
    const { r } = replaceAll()
    const publish = vi.fn(() => 2)
    expect(holdApi(r).holdHistoryTransition('undo', publish)).toBe(true)
    expect(holdApi(r).publicationHeld()).toBe(true)
    expect(publish).not.toHaveBeenCalled()
  })

  it('publishes the exact texts at the answer and builds the kept text with no rebind', () => {
    const { r, causes } = replaceAll()
    const publish = vi.fn(() => 2)
    holdApi(r).holdHistoryTransition('undo', publish)
    // Vditor's restore of the DOM, at once.
    r.render(DOC)
    answer(r, REPLACED, 1)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      kind: 'undo',
      before: REPLACED,
      after: DOC,
    })
    expect(holdApi(r).publicationHeld()).toBe(false)
    r.runFrames()
    expect(r.stats().state).toBe('live')
    expect(causes).not.toContain('rebind')
    // The host answers the sequenced transition once with its bytes: the kept model stays live.
    answer(r, DOC, 2)
    expect(r.session.confirmedSnapshot()).toEqual({ text: DOC, epoch: 3 })
  })

  it('holds nothing when no answer is awaited, and nothing a second time', () => {
    const r = open()
    r.runFrames()
    expect(holdApi(r).holdHistoryTransition('undo', vi.fn())).toBe(false)
    const { r: held } = replaceAll()
    expect(holdApi(held).holdHistoryTransition('undo', vi.fn())).toBe(true)
    expect(holdApi(held).holdHistoryTransition('redo', vi.fn())).toBe(false)
  })

  it('a mode switch while held clears the hold and publishes nothing', () => {
    const { r } = replaceAll()
    const publish = vi.fn(() => 2)
    holdApi(r).holdHistoryTransition('undo', publish)
    r.mode.value = 'wysiwyg'
    r.session.onModeChange('wysiwyg')
    expect(holdApi(r).publicationHeld()).toBe(false)
    answer(r, REPLACED, 1)
    expect(publish).not.toHaveBeenCalled()
  })

  it('a build that fails pairing still publishes, and the model ends off', () => {
    const { r } = replaceAll()
    const publish = vi.fn(() => 2)
    holdApi(r).holdHistoryTransition('undo', publish)
    // The user typed after the Undo: the DOM no longer renders the kept text.
    r.render('other\n\ntext\n\nmore\n')
    answer(r, REPLACED, 1)
    expect(publish).toHaveBeenCalledTimes(1)
    r.runFrames()
    expect(r.stats().state).toBe('off')
  })
})

// Task 733 / 036 (F6 publication and admission). `awaitExactHistory(sequence)` holds publication until the
// matched answer, which clears it and rebinds; a refusing `update` (host text) also clears it. `rebind`
// carries `exactRequestId` (the pair the host admitted) and `exactEvicted` (the pair its FIFO dropped);
// both are read before the matched-sequence check, so a superseded answer still confirms. The record
// calls go through `confirmExactHistory` / `evictExactHistory` dependencies (provisional names, settled in
// the contract step). None of this exists before step 6.
describe('036', () => {
  type ExactSessionApi = {
    awaitExactHistory(sequence: number): void
    publicationHeld(): boolean
    holdHistoryTransition(
      kind: 'undo' | 'redo',
      publish: (transition: {
        kind: 'undo' | 'redo'
        before: string
        after: string
      }) => number | undefined,
    ): boolean
  }
  const exactApi = (r: Rig) => r.session as unknown as ExactSessionApi
  const records = () => ({
    confirmExactHistory: vi.fn((_id: string) => undefined),
    evictExactHistory: vi.fn((_id: string) => undefined),
  })
  const rebind = (
    r: Rig,
    editSequence: number,
    extra: { exactRequestId?: string; exactEvicted?: string } = {},
    content = DOC,
  ) =>
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content,
      editSequence,
      ...extra,
    } as Parameters<ModelSession['onRebind']>[0])

  it('awaitExactHistory holds publication, and the matched answer makes the model live again', () => {
    const r = open()
    r.runFrames()
    exactApi(r).awaitExactHistory(5)
    expect(exactApi(r).publicationHeld()).toBe(true)

    rebind(r, 5)
    r.runFrames()

    expect(exactApi(r).publicationHeld()).toBe(false)
    expect(r.stats().state).toBe('live')
    expect(r.session.confirmedSnapshot()).toEqual({ text: DOC, epoch: 3 })
  })

  it('a refusing update clears the wait and the model rebuilds from the host text', () => {
    const r = open()
    r.runFrames()
    exactApi(r).awaitExactHistory(5)

    const host = 'host\n\nbytes\n'
    r.session.onHostText(host, 4)
    expect(exactApi(r).publicationHeld()).toBe(false)
    r.render(host)
    r.session.onEditDomComplete()
    r.runFrames()

    expect(r.stats().state).toBe('live')
    expect(r.session.confirmedSnapshot()).toEqual({ text: host, epoch: 4 })
  })

  it('exactRequestId confirms once, also on a superseded answer', () => {
    const deps = records()
    const r = open(DOC, 3, { deps })
    r.runFrames()
    exactApi(r).awaitExactHistory(5)

    rebind(r, 4, { exactRequestId: 'find-1' })
    expect(exactApi(r).publicationHeld()).toBe(true)
    rebind(r, 5)

    expect(deps.confirmExactHistory.mock.calls).toEqual([['find-1']])
    expect(deps.evictExactHistory).not.toHaveBeenCalled()
  })

  it('exactEvicted evicts the named pair', () => {
    const deps = records()
    const r = open(DOC, 3, { deps })
    r.runFrames()

    rebind(r, 1, { exactRequestId: 'find-9', exactEvicted: 'find-1' })

    expect(deps.confirmExactHistory.mock.calls).toEqual([['find-9']])
    expect(deps.evictExactHistory.mock.calls).toEqual([['find-1']])
  })

  it('a delayed confirmation followed by an eviction of the same pair ends evicted', () => {
    const deps = records()
    const order: string[] = []
    deps.confirmExactHistory.mockImplementation(
      (id) => void order.push(`confirm:${id}`),
    )
    deps.evictExactHistory.mockImplementation(
      (id) => void order.push(`evict:${id}`),
    )
    const r = open(DOC, 3, { deps })
    r.runFrames()
    exactApi(r).awaitExactHistory(7)

    rebind(r, 2, { exactRequestId: 'find-2' })
    rebind(r, 3, { exactEvicted: 'find-2' })

    expect(order).toEqual(['confirm:find-2', 'evict:find-2'])
  })

  // review of revision 4, point 4: Undo while Find's confirmation is outstanding and an input timer
  // is pending. The record is still `posted`, so `peekExact` is false and the preparation flush posts the
  // unchanged text as a second whole post. That post must not clear the kept text: the 022 hold still
  // takes the Undo, and the answer publishes the exact transition.
  it('a preparation whole post during an outstanding Find post keeps the 022 hold exact', () => {
    const replaced = 'ZZZZ\n\nbeta\n'
    const r = open()
    r.runFrames()
    r.render(replaced)
    expect(r.session.beforeWholeTextPost(1, { predict: false })).toEqual({
      rebind: true,
    })
    // The preparation flush: a whole post of the same DOM.
    r.session.beforeWholeTextPost(2, { predict: false })
    const publish = vi.fn(() => 3)

    expect(exactApi(r).holdHistoryTransition('undo', publish)).toBe(true)
    r.render(DOC)
    rebind(r, 2, {}, replaced)

    expect(publish).toHaveBeenCalledWith({
      kind: 'undo',
      before: replaced,
      after: DOC,
    })
  })
})

// Task 733 / 036 (B0, fix design 3.7 and second-opinion point 5): a history move is answered by
// `replay-ack`, not `rebind`. The ack that covers the awaited operation completes the sliced-restore join
// with the webview's own target text of the record (the host proved the raw bytes); the watchdog posts
// `replay-query` instead of abandoning; a failed slice posts `replay-abandon` with the operation.
describe('036 B0 transition', () => {
  type B0SessionApi = {
    awaitExactHistory(
      sequence: number,
      replay?: { epoch: number; replayOp: number; requestId: string },
    ): void
    publicationHeld(): boolean
    onReplayAck(
      message: { epoch: number; replayOp: number; acceptedSequence: number },
      targetOf?: (requestId: string) => string | undefined,
    ): boolean
    onReplayStatus(
      message: {
        epoch: number
        replayOp: number
        state: string
        applied: number
        acceptedSequence: number
      },
      targetOf?: (requestId: string) => string | undefined,
    ): boolean
  }
  const api = (r: Rig) => r.session as unknown as B0SessionApi
  const target = (id: string) => (id === 'find-1' ? DOC : undefined)

  it('a replay-ack covering the awaited operation joins with the target text', () => {
    const r = open()
    r.runFrames()
    api(r).awaitExactHistory(5, { epoch: 3, replayOp: 1, requestId: 'find-1' })
    expect(api(r).publicationHeld()).toBe(true)

    expect(
      api(r).onReplayAck(
        { epoch: 3, replayOp: 1, acceptedSequence: 0 },
        target,
      ),
    ).toBe(true)
    r.runFrames()

    expect(api(r).publicationHeld()).toBe(false)
    expect(r.stats().state).toBe('live')
    expect(r.session.confirmedSnapshot()).toEqual({ text: DOC, epoch: 3 })
  })

  it('an ack of an older operation or another epoch keeps waiting', () => {
    const r = open()
    r.runFrames()
    api(r).awaitExactHistory(5, { epoch: 3, replayOp: 2, requestId: 'find-1' })
    expect(
      api(r).onReplayAck(
        { epoch: 3, replayOp: 1, acceptedSequence: 0 },
        target,
      ),
    ).toBe(false)
    expect(
      api(r).onReplayAck(
        { epoch: 4, replayOp: 2, acceptedSequence: 0 },
        target,
      ),
    ).toBe(false)
    expect(api(r).publicationHeld()).toBe(true)
  })

  it('replay-status applied joins as the ack does', () => {
    const r = open()
    r.runFrames()
    api(r).awaitExactHistory(5, { epoch: 3, replayOp: 1, requestId: 'find-1' })
    expect(
      api(r).onReplayStatus(
        {
          epoch: 3,
          replayOp: 1,
          state: 'applied',
          applied: 1,
          acceptedSequence: 0,
        },
        target,
      ),
    ).toBe(true)
    expect(api(r).publicationHeld()).toBe(false)
  })

  it('the watchdog posts replay-query (again every 5 s) and never abandons', () => {
    const postReplay = vi.fn()
    const r = open(DOC, 3, { deps: { postReplay } })
    r.runFrames()
    vi.useFakeTimers()
    try {
      api(r).awaitExactHistory(5, {
        epoch: 3,
        replayOp: 1,
        requestId: 'find-1',
      })
      vi.advanceTimersByTime(5000)
      vi.advanceTimersByTime(5000)
    } finally {
      vi.useRealTimers()
    }
    expect(postReplay.mock.calls).toEqual([
      [{ command: 'replay-query', epoch: 3, replayOp: 1 }],
      [{ command: 'replay-query', epoch: 3, replayOp: 1 }],
    ])
    expect(api(r).publicationHeld()).toBe(true)
  })
})

// Task 733 / 036 (step B, fix design 2.3-2.8): the replay engine renders the pending groups of a tagged
// Undo or Redo from Find's hunks, one atomic per group under the 15 ms budget, and the acknowledgement
// takes the target text with no rebind and no whole change. The record comes through `exactHunksOf`.
describe('036 B replay engine', () => {
  type EngineApi = {
    awaitExactHistory(
      sequence: number,
      replay?: { epoch: number; replayOp: number; requestId: string },
    ): void
    publicationHeld(): boolean
    onReplayAck(
      message: { epoch: number; replayOp: number; acceptedSequence: number },
      targetOf?: (requestId: string) => string | undefined,
    ): boolean
  }
  const api = (r: Rig) => r.session as unknown as EngineApi

  /** Find's record for replacing every `ncjw` of `before` with `ZZZZ`. */
  const recordOf = (before: string, insert = 'ZZZZ') => {
    const starts: number[] = []
    for (
      let at = before.indexOf('ncjw');
      at >= 0;
      at = before.indexOf('ncjw', at + 4)
    )
      starts.push(at)
    const hunks = {
      starts: Int32Array.from(starts),
      ends: Int32Array.from(starts.map((at) => at + 4)),
      insert,
    }
    const after = before.replaceAll('ncjw', insert)
    return {
      after,
      record: {
        hunks,
        beforeExact: before,
        afterExact: after,
        normalized: normalizeReplaceHunks(before, after, hunks),
      },
    }
  }

  /** Opens the replaced text, starts an Undo and runs frames until the engine settles. */
  async function undo(
    before: string,
    options: {
      now?: () => number
      prepare?: (r: Rig) => void
      deps?: Record<string, unknown>
    } = {},
  ) {
    const { after, record } = recordOf(before)
    const postReplay = vi.fn()
    const r = open(after, 3, {
      deps: {
        exactHunksOf: () => record,
        postReplay,
        ...(options.now ? { now: options.now } : {}),
        ...options.deps,
      },
    })
    r.runFrames()
    options.prepare?.(r)
    const changes: UnitsChange[] = []
    r.session.onUnitsChanged((change) => void changes.push(change))
    api(r).awaitExactHistory(5, { epoch: 3, replayOp: 1, requestId: 'find-1' })
    const port = r.session.historyPort()
    const done = port.restoreSliced?.({} as never, 'before')
    for (let n = 0; n < 50 && r.frames.length > 0; n++) {
      r.runFrames()
      await Promise.resolve()
    }
    const ok = await done
    return { r, ok, after, changes, postReplay }
  }

  const replayStats = (r: Rig) => r.stats().replay

  it('renders every group, and the acknowledgement makes no rebind and no whole change', async () => {
    const before = 'one ncjw two\n\nthree ncjw\n\nfour\n'
    const { r, ok, changes } = await undo(before)
    expect(ok).toBe(true)
    expect(r.root.textContent).toContain('one ncjw two')
    expect(r.root.textContent).not.toContain('ZZZZ')
    expect(replayStats(r)).toMatchObject({
      engine: 1,
      whole: 0,
      unbounded: 0,
      mismatch: 0,
    })
    expect(api(r).publicationHeld()).toBe(true)
    const atAck = changes.length
    expect(
      api(r).onReplayAck(
        { epoch: 3, replayOp: 1, acceptedSequence: 0 },
        () => before,
      ),
    ).toBe(true)
    r.runFrames()
    expect(changes.slice(atAck).some((change) => change.whole)).toBe(false)
    expect(changes.some((change) => change.cause === 'rebind')).toBe(false)
    expect(replayStats(r).rebinds).toBe(0)
    expect(api(r).publicationHeld()).toBe(false)
    expect(r.session.confirmedSnapshot()).toEqual({ text: before, epoch: 3 })
  })

  // Task 733 / 036 (step D, 2.7): the session registers the page-context observer as a write drain, so
  // each group's write hands its records to the stamp inside the write.
  it('hands the records of every replay write to the page-context drain inside the write', async () => {
    const disposeContext = installWebviewContext(document.body)
    const drain = webviewContextDrainFor(document.body)
    if (!drain) throw new Error('no page-context drain')
    const stamp = drain.own
    let inside = 0
    ;(drain as { own(records: MutationRecord[]): void }).own = (records) => {
      if (records.length > 0) inside++
      stamp(records)
    }
    try {
      const { r, ok } = await undo('one ncjw two\n\nthree ncjw\n\nfour\n')
      expect(ok).toBe(true)
      expect(replayStats(r)).toMatchObject({ engine: 1, whole: 0 })
      expect(inside).toBeGreaterThanOrEqual(2)
    } finally {
      disposeContext()
    }
  })

  it('a table group with the automatic-sizing class and inline widths renders (H finding 1)', async () => {
    const before = '| a | b |\n| --- | --- |\n| ncjw | x |\n| y | ncjw |\n'
    const { r, ok } = await undo(before, {
      prepare: (rig) => {
        const table = rig.root.querySelector('table') as HTMLElement
        table.classList.add('vmde-table-auto-1')
        table.style.width = '320px'
      },
    })
    expect(ok).toBe(true)
    expect(replayStats(r)).toMatchObject({ engine: 1, whole: 0, mismatch: 0 })
    const cells = Array.from(r.root.querySelectorAll('td')).map(
      (td) => td.textContent,
    )
    expect(cells).toEqual(['ncjw', 'x', 'y', 'ncjw'])
    api(r).onReplayAck(
      { epoch: 3, replayOp: 1, acceptedSequence: 0 },
      () => before,
    )
    expect(r.session.confirmedSnapshot()).toEqual({ text: before, epoch: 3 })
  })

  it('a host text during the replay stops it before its next atomic (correlation)', async () => {
    const before = 'one ncjw\n\ntwo ncjw\n'
    const { after, record } = recordOf(before)
    const r = open(after, 3, { deps: { exactHunksOf: () => record } })
    r.runFrames()
    api(r).awaitExactHistory(5, { epoch: 3, replayOp: 1, requestId: 'find-1' })
    const done = r.session.historyPort().restoreSliced?.({} as never, 'before')
    r.session.onHostText(after, 4)
    r.runFrames()
    expect(await done).toBe(false)
    expect(r.root.textContent).not.toContain('ncjw')
  })

  it('spreads the atomics over frames by the per-class estimate, with no budget-miss', async () => {
    let t = 0
    const before = 'a ncjw\n\nb ncjw\n\nc ncjw\n'
    // Every clock read advances 4 ms: one atomic and the frame's emission (H2 fix design rev2, D9.2) each
    // cost 4 ms; two atomics plus twice the median (D9.1) do not fit the 15 ms frame, so a third waits.
    const { r, ok } = await undo(before, { now: () => (t += 4) })
    expect(ok).toBe(true)
    const stats = replayStats(r)
    expect(stats.atomics).toBe(3)
    expect(stats.frames).toBeGreaterThan(1)
    expect(stats.budget.classes.leaf.atomics).toBe(3)
    expect(stats.budget.budgetMisses).toBe(0)
  })

  it('counts replay-whole and takes the sliced restore when the model text is not the start', async () => {
    const before = 'one ncjw\n'
    const { record } = recordOf(before)
    const r = open('other text\n', 3, { deps: { exactHunksOf: () => record } })
    r.runFrames()
    api(r).awaitExactHistory(5, { epoch: 3, replayOp: 1, requestId: 'find-1' })
    void r.session
      .historyPort()
      .restoreSliced?.({ generation: -1, steps: [] } as never, 'before')
    expect(replayStats(r)).toMatchObject({ engine: 0, whole: 1 })
  })

  it('Q-G: a window referencing the globally fifth footnote renders through the context and shows 5', async () => {
    const defs = ['a', 'b', 'c', 'd', 'e']
      .map((l) => `[^${l}]: note ${l}`)
      .join('\n\n')
    const before = `ref ncjw[^e]\n\n${defs}\n`
    const { r, ok } = await undo(before)
    expect(replayStats(r)).toMatchObject({
      engine: 1,
      unbounded: 0,
      mismatch: 0,
    })
    expect(ok).toBe(true)
    const p = r.root.querySelector('p') as HTMLElement
    const sup = p.querySelector('sup[data-type="footnotes-ref"]') as HTMLElement
    expect(sup.querySelector('[data-render]')?.textContent).toBe('5')
    // Against a full render of the target: the same paragraph text and the same reference label.
    const full = document.createElement('div')
    full.innerHTML = lute.Md2VditorIRDOM(before)
    const fullP = full.querySelector('p') as HTMLElement
    expect(sup.getAttribute('data-footnotes-label')).toBe(
      fullP.querySelector('sup')?.getAttribute('data-footnotes-label'),
    )
    expect(p.firstChild?.textContent).toBe(fullP.firstChild?.textContent)
  })

  it('a hunk inside a footnote definition is replay-unbounded and the replay is abandoned', async () => {
    const before = 'text[^a]\n\n[^a]: ncjw note\n'
    const { r, ok, postReplay } = await undo(before)
    expect(ok).toBe(false)
    expect(replayStats(r).unbounded).toBe(1)
    expect(postReplay).toHaveBeenCalledWith({
      command: 'replay-abandon',
      epoch: 3,
      replayOp: 1,
    })
  })

  it('a heading change in a document with a TOC is replay-unbounded', async () => {
    const before = '[toc]\n\nintro\n\nmore\n\n# ncjw\n'
    const tocLute = lute as UnitLute & { SetToC(on: boolean): void }
    tocLute.SetToC(true)
    const { r, ok } = await undo(before, {
      deps: { tocEnabled: () => true },
    }).finally(() => tocLute.SetToC(false))
    expect(ok).toBe(false)
    expect(replayStats(r)).toMatchObject({ engine: 1, unbounded: 1 })
  })

  // ---- H2 fix design rev2 (D5.1, D8.1, D9.2): time packs frames and counts misses; it never stops a replay ----

  /** A clock that the atomic's composition check advances by `step()` ms once armed (inside each atomic). */
  const slowClock = (step: (call: number) => number) => {
    const state = { t: 0, armed: false, calls: 0 }
    return {
      state,
      now: () => state.t,
      isComposing: () => {
        if (state.armed) state.t += step(++state.calls)
        return false
      },
    }
  }

  it('D5.1: one slow valid atomic (40 ms) counts a budget-miss and the replay goes on to the end', async () => {
    const c = slowClock((call) => (call === 1 ? 40 : 1))
    const before = 'a ncjw\n\nb ncjw\n\nc ncjw\n'
    const { r, ok, postReplay } = await undo(before, {
      now: c.now,
      deps: { isComposing: c.isComposing },
      prepare: () => {
        c.state.armed = true
      },
    })
    expect(ok).toBe(true)
    const stats = replayStats(r)
    expect(stats).toMatchObject({
      engine: 1,
      atomics: 3,
      unbounded: 0,
      mismatch: 0,
    })
    expect(stats.budget.classes.leaf.maxMs).toBeGreaterThanOrEqual(40)
    expect(stats.budget.budgetMisses).toBe(1)
    expect(
      postReplay.mock.calls.some(
        (call) => call[0]?.command === 'replay-abandon',
      ),
    ).toBe(false)
    expect(r.root.textContent).not.toContain('ZZZZ')
  })

  it('D9.2: the frame emission is timed inside the frame and counts toward its miss', async () => {
    const c = slowClock(() => 12)
    const before = 'a ncjw\n'
    let emissions = 0
    const { r, ok } = await undo(before, {
      now: c.now,
      deps: { isComposing: c.isComposing },
      prepare: (rig) => {
        c.state.armed = true
        rig.session.onUnitsChanged((change) => {
          if (change.cause !== 'sync' || change.whole) return
          emissions++
          c.state.t += 4
        })
      },
    })
    expect(ok).toBe(true)
    expect(emissions).toBeGreaterThanOrEqual(1)
    const { budget } = replayStats(r)
    expect(budget.classes.emission?.maxMs).toBeGreaterThanOrEqual(4)
    expect(budget.budgetMisses).toBeGreaterThanOrEqual(1)
    expect(budget.maxTaskMs).toBeGreaterThanOrEqual(16)
  })

  it('D5.4: each replay atomic builds the new model text once (one flatten per commit)', async () => {
    const before = 'a ncjw\n\nb ncjw\n\nc ncjw\n\nd ncjw\n'
    let atStart = 0
    const { r, ok } = await undo(before, {
      prepare: () => {
        atStart = wholeTexts.count
      },
    })
    expect(ok).toBe(true)
    expect(replayStats(r).atomics).toBe(4)
    expect(wholeTexts.count - atStart).toBe(4)
  })

  it('S4r1 fix 1: an exception during the commit settles the replay as a mismatch, never escaping the frame', async () => {
    const before = 'a ncjw\n\nb ncjw\n'
    try {
      const { r, ok } = await undo(before, {
        prepare: () => {
          wholeTexts.mode = 'throw'
        },
      })
      expect(ok).toBe(false)
      expect(replayStats(r)).toMatchObject({ mismatch: 1, atomics: 0 })
      expect(r.frames.length).toBe(0)
    } finally {
      wholeTexts.mode = 'none'
    }
  })

  it('S4r1 fix 2: the post-commit proof checks the length change and the adjoining bytes', async () => {
    const before = 'a ncjw\n\nb ncjw\n'
    try {
      const { r, ok } = await undo(before, {
        prepare: () => {
          wholeTexts.mode = 'corrupt'
        },
      })
      expect(ok).toBe(false)
      expect(replayStats(r).mismatch).toBe(1)
    } finally {
      wholeTexts.mode = 'none'
    }
  })

  it('S4r1 fix 6: a first atomic that does not fit the frame runs alone and is counted', async () => {
    const c = slowClock(() => 20)
    const before = 'a ncjw\n\nb ncjw\n\nc ncjw\n'
    const { r, ok } = await undo(before, {
      now: c.now,
      deps: { isComposing: c.isComposing },
      prepare: () => {
        c.state.armed = true
      },
    })
    expect(ok).toBe(true)
    const stats = replayStats(r)
    expect(stats.atomics).toBe(3)
    // The first atomic has no sample; the next two do not fit (2 x 20 > 15) and run alone.
    expect(stats.forced).toBe(2)
    expect(stats.frames).toBeGreaterThanOrEqual(3)
  })

  it('S4r1 fix 9: the deferred outline does nothing after teardown', async () => {
    const render = vi.fn()
    const holder = window as unknown as { vditor?: unknown }
    holder.vditor = { vditor: { outline: { render } } }
    try {
      const { r, ok } = await undo('# a ncjw\n\n# b ncjw\n')
      expect(ok).toBe(true)
      r.session.dispose()
      for (const cb of r.timers.splice(0)) cb()
      expect(render).not.toHaveBeenCalled()
    } finally {
      holder.vditor = undefined
    }
  })

  it('S4r1 fix 9: the deferred outline does nothing after the model is rebuilt over a new adapter', async () => {
    const render = vi.fn()
    const holder = window as unknown as { vditor?: unknown }
    holder.vditor = { vditor: { outline: { render } } }
    try {
      const before = '# a ncjw\n\n# b ncjw\n'
      const { r, ok } = await undo(before)
      expect(ok).toBe(true)
      // Leaving IR and entering it again builds a new model over a new adapter (supersession).
      r.mode.value = 'sv'
      r.session.onModeChange?.('sv')
      r.mode.value = 'ir'
      r.render(before)
      r.session.onHostText(before, 4)
      r.session.onEditDomComplete()
      for (const cb of r.timers.splice(0)) cb()
      expect(render).not.toHaveBeenCalled()
    } finally {
      holder.vditor = undefined
    }
  })

  it('D8.1: four heading groups render the outline once, after the last group, as a charged outline task', async () => {
    const render = vi.fn()
    const holder = window as unknown as { vditor?: unknown }
    holder.vditor = { vditor: { outline: { render } } }
    try {
      const before = '# a ncjw\n\n# b ncjw\n\n# c ncjw\n\n# d ncjw\n'
      const { r, ok } = await undo(before)
      expect(ok).toBe(true)
      expect(replayStats(r).atomics).toBe(4)
      expect(render).not.toHaveBeenCalled()
      for (const cb of r.timers.splice(0)) cb()
      expect(render).toHaveBeenCalledTimes(1)
      expect(replayStats(r).budget.classes.outline?.atomics).toBe(1)
    } finally {
      holder.vditor = undefined
    }
  })
})

// Task 733 / 036 (step B, repair round 1): one scoped change per replay frame (4.3), and the idle check of
// a confirmed Find record (2.2): the normalized hunks and a plan dry run before the key.
describe('036 B replay frame change and idle check', () => {
  type Api = {
    awaitExactHistory(
      sequence: number,
      replay?: { epoch: number; replayOp: number; requestId: string },
    ): void
  }
  const api = (r: Rig) => r.session as unknown as Api
  const recordOf = (before: string) => {
    const starts: number[] = []
    for (
      let at = before.indexOf('ncjw');
      at >= 0;
      at = before.indexOf('ncjw', at + 4)
    )
      starts.push(at)
    const hunks = {
      starts: Int32Array.from(starts),
      ends: Int32Array.from(starts.map((at) => at + 4)),
      insert: 'ZZZZ',
    }
    const after = before.replaceAll('ncjw', 'ZZZZ')
    return {
      after,
      record: {
        hunks,
        beforeExact: before,
        afterExact: after,
        normalized: normalizeReplaceHunks(before, after, hunks),
      },
    }
  }
  const idle: Array<(deadline: { timeRemaining(): number }) => void> = []
  const originalIdle = window.requestIdleCallback
  afterEach(() => {
    window.requestIdleCallback = originalIdle
    idle.length = 0
  })
  // The window's scheduler is shared by every rig of this file: an idle request an earlier test left on
  // the timer fallback (50 ms) runs first, then the stubbed idle callbacks.
  const runIdle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 120))
    for (let n = 0; n < 20 && idle.length > 0; n++)
      for (const cb of idle.splice(0)) cb({ timeRemaining: () => 50 })
  }
  async function replay(r: Rig) {
    api(r).awaitExactHistory(5, { epoch: 3, replayOp: 1, requestId: 'find-1' })
    const done = r.session.historyPort().restoreSliced?.({} as never, 'before')
    for (let n = 0; n < 50 && r.frames.length > 0; n++) {
      r.runFrames()
      await Promise.resolve()
    }
    return done
  }
  const confirm = (r: Rig) =>
    r.session.onRebind({
      command: 'rebind',
      epoch: 3,
      afterSequence: 0,
      content: r.session.confirmedSnapshot()?.text ?? '',
      editSequence: 99,
      exactRequestId: 'find-1',
    } as Parameters<ModelSession['onRebind']>[0])

  it('reports the atomics of one frame as one scoped change', async () => {
    const before = 'a ncjw\n\nb ncjw\n\nc ncjw\n'
    const { after, record } = recordOf(before)
    const r = open(after, 3, { deps: { exactHunksOf: () => record } })
    r.runFrames()
    const changes: UnitsChange[] = []
    r.session.onUnitsChanged((change) => void changes.push(change))
    expect(await replay(r)).toBe(true)
    const writes = changes.filter((change) => change.cause === 'sync')
    expect(writes).toHaveLength(1)
    expect(writes[0].whole).toBe(false)
    expect(writes[0].changed).toHaveLength(3)
    expect(r.stats().replay.frames).toBe(1)
  })

  it('computes the normalized hunks on an idle frame after the confirmation', async () => {
    window.requestIdleCallback = (cb) => idle.push(cb as never)
    const { after, record } = recordOf('one ncjw\n')
    const exactHunksOf = vi.fn(() => record)
    const r = open(after, 3, { deps: { exactHunksOf } })
    r.runFrames()
    confirm(r)
    expect(exactHunksOf).not.toHaveBeenCalled()
    await runIdle()
    expect(exactHunksOf).toHaveBeenCalledWith('find-1')
  })

  it('a group whose dry run cannot plan is known before the key: the Undo takes today path with no abandon', async () => {
    window.requestIdleCallback = (cb) => idle.push(cb as never)
    const before = 'text[^a]\n\n[^a]: ncjw note\n'
    const { after, record } = recordOf(before)
    const postReplay = vi.fn()
    const r = open(after, 3, {
      deps: { exactHunksOf: () => record, postReplay },
    })
    r.runFrames()
    confirm(r)
    await runIdle()
    api(r).awaitExactHistory(5, { epoch: 3, replayOp: 1, requestId: 'find-1' })
    void r.session
      .historyPort()
      .restoreSliced?.({ generation: -1, steps: [] } as never, 'before')
    expect(r.stats().replay).toMatchObject({
      engine: 0,
      unplannable: 1,
      whole: 1,
      unbounded: 0,
    })
    expect(postReplay).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: 'replay-abandon' }),
    )
  })

  it('a record whose groups all plan still replays group by group', async () => {
    window.requestIdleCallback = (cb) => idle.push(cb as never)
    const { after, record } = recordOf('one ncjw\n\ntwo ncjw\n')
    const r = open(after, 3, { deps: { exactHunksOf: () => record } })
    r.runFrames()
    confirm(r)
    await runIdle()
    expect(await replay(r)).toBe(true)
    expect(r.stats().replay).toMatchObject({ engine: 1, unplannable: 0 })
  })

  // 036 S5.2 (S5 design rev 2 section 2): the state of the record's dry run is counted at the key.
  const key = (r: Rig) => {
    api(r).awaitExactHistory(5, { epoch: 3, replayOp: 1, requestId: 'find-1' })
    return r.session
      .historyPort()
      .restoreSliced?.({ generation: -1, steps: [] } as never, 'before')
  }
  const zeroAtKey = {
    pendingAtKey: 0,
    runningAtKey: 0,
    interruptedAtKey: 0,
    skippedAtKey: 0,
    completedAtKey: 0,
    absentAtKey: 0,
  }

  it('a key with no check of the record counts absent (S5.2)', async () => {
    const { after, record } = recordOf('one ncjw\n')
    const r = open(after, 3, { deps: { exactHunksOf: () => record } })
    r.runFrames()
    void key(r)
    expect(r.stats().replay.dryRun).toEqual({ ...zeroAtKey, absentAtKey: 1 })
    expect(r.stats().replay.engine).toBe(1)
  })

  it('a key before the idle check counts pending and keeps the engine route (S5.2)', async () => {
    window.requestIdleCallback = (cb) => idle.push(cb as never)
    const { after, record } = recordOf('one ncjw\n')
    const r = open(after, 3, { deps: { exactHunksOf: () => record } })
    r.runFrames()
    confirm(r)
    void key(r)
    expect(r.stats().replay.dryRun).toEqual({ ...zeroAtKey, pendingAtKey: 1 })
    expect(r.stats().replay.lastDryRun).toEqual({
      state: 'pending',
      checked: 0,
      total: 0,
      refused: 0,
      reason: undefined,
    })
    expect(r.stats().replay.engine).toBe(1)
    // The idle request is served, so the window's scheduler asks for the next one.
    await runIdle()
  })

  it('a completed check counts completed; with a refusal it records the first reason (S5.2)', async () => {
    window.requestIdleCallback = (cb) => idle.push(cb as never)
    const clean = recordOf('one ncjw\n\ntwo ncjw\n')
    const r = open(clean.after, 3, {
      deps: { exactHunksOf: () => clean.record },
    })
    r.runFrames()
    confirm(r)
    await runIdle()
    void key(r)
    expect(r.stats().replay.dryRun).toEqual({
      ...zeroAtKey,
      completedAtKey: 1,
    })
    // A clean completed check builds no record.
    expect(r.stats().replay.lastDryRun).toBeUndefined()
    r.session.dispose()

    const refused = recordOf('text[^a]\n\n[^a]: ncjw note\n')
    const s = open(refused.after, 3, {
      deps: { exactHunksOf: () => refused.record },
    })
    s.runFrames()
    confirm(s)
    await runIdle()
    void key(s)
    expect(s.stats().replay.dryRun).toEqual({
      ...zeroAtKey,
      completedAtKey: 1,
    })
    expect(s.stats().replay.lastDryRun).toMatchObject({
      state: 'completed',
      checked: 1,
      total: 1,
      refused: 1,
    })
    expect(typeof s.stats().replay.lastDryRun.reason).toBe('string')
    expect(s.stats().replay.route.dryRun).toBe(1)
  })

  it('a model text other than the record end counts skipped, not done (S5.2)', async () => {
    window.requestIdleCallback = (cb) => idle.push(cb as never)
    const { record } = recordOf('one ncjw\n')
    const r = open('other text\n', 3, { deps: { exactHunksOf: () => record } })
    r.runFrames()
    confirm(r)
    await runIdle()
    void key(r)
    expect(r.stats().replay.dryRun).toEqual({ ...zeroAtKey, skippedAtKey: 1 })
    expect(r.stats().replay.lastDryRun).toMatchObject({
      state: 'skipped',
      checked: 0,
      refused: 0,
    })
  })

  it('a yield then the key counts interrupted and keeps a known refusal apart from unchecked hunks (S5.2)', async () => {
    window.requestIdleCallback = (cb) => idle.push(cb as never)
    await runIdle()
    const nav = window.navigator as unknown as Record<string, unknown>
    // Once the check has read its record, the budget holds for the first hunk and is spent before the
    // second (the scheduler's own questions before that do not count). Only the record under test opens
    // the gate: the disposed rig's yielded check reads its own record first.
    let read = false
    let gated: unknown
    let asked = 0
    Object.defineProperty(nav, 'scheduling', {
      configurable: true,
      value: { isInputPending: () => read && ++asked > 1 },
    })
    const reading = (record: unknown) => () => {
      if (record === gated) read = true
      return record
    }
    try {
      const refused = recordOf(
        'text[^a]\n\n[^a]: ncjw note\n\nb ncjw\n\nc ncjw\n',
      )
      gated = refused.record
      const r = open(refused.after, 3, {
        deps: { exactHunksOf: reading(refused.record) },
      })
      r.runFrames()
      confirm(r)
      await runIdle()
      void key(r)
      expect(r.stats().replay.dryRun).toEqual({
        ...zeroAtKey,
        interruptedAtKey: 1,
      })
      expect(r.stats().replay.lastDryRun).toMatchObject({
        state: 'interrupted',
        checked: 1,
        total: 3,
        refused: 1,
      })
      // The known refusal routes as a completed one does.
      expect(r.stats().replay).toMatchObject({ engine: 0, unplannable: 1 })
      r.session.dispose()

      read = false
      asked = 0
      const clean = recordOf('a ncjw\n\nb ncjw\n\nc ncjw\n')
      gated = clean.record
      const s = open(clean.after, 3, {
        deps: { exactHunksOf: reading(clean.record) },
      })
      s.runFrames()
      confirm(s)
      await runIdle()
      void key(s)
      expect(s.stats().replay.lastDryRun).toMatchObject({
        state: 'interrupted',
        checked: 1,
        total: 3,
        refused: 0,
      })
      expect(s.stats().replay).toMatchObject({ engine: 1, unplannable: 0 })
    } finally {
      delete nav.scheduling
    }
  })
})

// Task 733 / 036 (step C, fix design 2.3, 2.6, 2.7): input and history moves during an exact replay go
// through the logical text `L`: typing is published as replay deltas in `L` coordinates while groups are
// pending, endpoints render before an input, captured intents keep their range, Copy and Cut write `L`,
// a superseding move keeps the rendered half, and an untagged Undo is reserved.
describe('036 C replay input', () => {
  type Change = {
    start: { line: number; character: number }
    end: { line: number; character: number }
    oldText: string
    text: string
  }
  type Post = {
    command: string
    changes?: Change[]
    replayOp: number
    kind?: string
    recoveryOf?: { epoch: number; replayOp: number }
    epoch?: number
  }

  const recordOf = (before: string, insert = 'ZZZZ') => {
    const starts: number[] = []
    for (
      let at = before.indexOf('ncjw');
      at >= 0;
      at = before.indexOf('ncjw', at + 4)
    )
      starts.push(at)
    const hunks = {
      starts: Int32Array.from(starts),
      ends: Int32Array.from(starts.map((at) => at + 4)),
      insert,
    }
    const after = before.replaceAll('ncjw', insert)
    return {
      after,
      record: {
        hunks,
        beforeExact: before,
        afterExact: after,
        normalized: normalizeReplaceHunks(before, after, hunks),
      },
    }
  }

  /** The delta publisher's replay operations, recorded; `ledger` is what the host has not acknowledged. */
  const fakeSync = () => {
    const posts: Post[] = []
    const ledger: number[] = []
    let sequence = 10
    let op = 1
    const state: {
      publisher: { publish(cause: string): string } | undefined
    } = { publisher: undefined }
    const sync = {
      setLogicalPublisher: (publisher: never) => {
        state.publisher = publisher
      },
      // 036 core C2: `publish` delegates to the logical publisher, as delta-sync does during a replay.
      publish: (cause: string) => state.publisher?.publish(cause) ?? 'nothing',
      postAgainstHost: (changes: Change[], epoch: number) => {
        sequence += 1
        posts.push({ command: 'edit-delta', changes, replayOp: 0, epoch })
        return true
      },
      postReplayDelta: (
        changes: Change[],
        _perf?: unknown,
        recoveryOf?: { epoch: number; replayOp: number },
      ) => {
        sequence += 1
        op += 1
        ledger.push(op)
        posts.push({
          command: 'edit-delta',
          changes,
          replayOp: op,
          ...(recoveryOf ? { recoveryOf } : {}),
        })
        return { sequence, replayOp: op }
      },
      reserveReplayHistory: (kind: string) => {
        sequence += 1
        op += 1
        ledger.push(op)
        posts.push({ command: 'replay-reserve', kind, replayOp: op })
        return { epoch: 3, replayOp: op, sequence }
      },
      postReservedHistory: (
        reservation: { replayOp: number },
        kind: string,
        _steps: number,
        changes: Change[],
      ) => {
        posts.push({
          command: 'history-delta',
          kind,
          changes,
          replayOp: reservation.replayOp,
        })
      },
      lastPostedSequence: () => sequence,
      replayLedger: () => ledger,
      oldestReplay: () => undefined,
    }
    return { posts, ledger, state, sync }
  }

  const offsetOf = (text: string, pos: { line: number; character: number }) => {
    let at = 0
    for (let line = 0; line < pos.line; line++) at = text.indexOf('\n', at) + 1
    return at + pos.character
  }
  /** Applies one delta's changes as the host does: positions and `oldText` against the text before it. */
  const applyDelta = (text: string, changes: readonly Change[]): string => {
    let out = text
    for (const change of [...changes].reverse()) {
      const from = offsetOf(text, change.start)
      const to = offsetOf(text, change.end)
      expect(text.slice(from, to)).toBe(change.oldText)
      out = out.slice(0, from) + change.text + out.slice(to)
    }
    return out
  }
  const applyPosts = (text: string, posts: readonly Post[]): string =>
    posts.reduce(
      (current, post) =>
        post.changes ? applyDelta(current, post.changes) : current,
      text,
    )

  /** Opens the replaced text, starts an Undo; no frame has run, so every group is pending. */
  function start(
    before: string,
    options: {
      insert?: string
      select?: (r: Rig) => void
      deps?: Record<string, unknown>
    } = {},
  ) {
    const { after, record } = recordOf(before, options.insert)
    const postReplay = vi.fn()
    const r = open(after, 3, {
      deps: { exactHunksOf: () => record, postReplay, ...options.deps },
    })
    r.runFrames()
    // The pre-touch proof of each block, as the editor's first key over it makes (sync needs proven units).
    for (const block of Array.from(r.root.children)) {
      document.getSelection()?.selectAllChildren(block)
      block.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    }
    document.getSelection()?.removeAllRanges()
    const fake = fakeSync()
    r.session.bindReplaySync(fake.sync as never)
    options.select?.(r)
    r.session.awaitExactHistory(5, {
      epoch: 3,
      replayOp: 1,
      requestId: 'find-1',
    })
    const done = r.session.historyPort().restoreSliced?.({} as never, 'before')
    return { r, fake, done, after, record, postReplay }
  }
  async function settle(r: Rig, done: Promise<boolean> | undefined) {
    for (let n = 0; n < 50 && r.frames.length > 0; n++) {
      r.runFrames()
      await Promise.resolve()
    }
    return done
  }
  const select = (
    anchor: Text,
    anchorOffset: number,
    focus: Text = anchor,
    focusOffset = anchorOffset,
  ) =>
    document
      .getSelection()
      ?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset)
  const paragraphText = (r: Rig, index: number) =>
    r.root.querySelectorAll('p')[index].textContent

  it('typing while groups are pending is one replay delta in L positions, not held', async () => {
    const before = 'one ncjw two\n\nthree ncjw\n\nfour\n'
    // Each target hunk spans two lines, so `L` and `R` lines differ before the typed paragraph.
    const { r, fake, done } = start(before, { insert: 'Z\nZ' })
    expect(r.session.replayLive()).toBe(true)
    expect(r.session.publicationHeld()).toBe(false)
    paragraph(r, 2).data = 'four!'
    expect(fake.state.publisher?.publish('idle')).toBe('delta')
    expect(fake.posts).toHaveLength(1)
    expect(fake.posts[0].changes?.[0].start).toEqual({ line: 4, character: 4 })
    const logical = 'one ncjw two\n\nthree ncjw\n\nfour!\n'
    expect(applyPosts(before, fake.posts)).toBe(logical)
    expect(await settle(r, done)).toBe(true)
    // The history move is answered; the typing is still unacknowledged, so the replay stays live.
    r.session.onReplayAck(
      { epoch: 3, replayOp: 1, acceptedSequence: 0 },
      () => before,
    )
    expect(r.session.replayLive()).toBe(true)
    fake.ledger.length = 0
    r.session.onReplayAck(
      { epoch: 3, replayOp: 2, acceptedSequence: 11 },
      () => before,
    )
    expect(r.session.replayLive()).toBe(false)
    expect(r.session.confirmedSnapshot()).toEqual({ text: logical, epoch: 3 })
  })

  it('typing right after the last group and before the acknowledgement is a replay delta', async () => {
    const before = 'one ncjw\n\ntwo\n'
    const { r, fake, done } = start(before)
    expect(await settle(r, done)).toBe(true)
    paragraph(r, 1).data = 'two?'
    expect(fake.state.publisher?.publish('idle')).toBe('delta')
    expect(applyPosts(before, fake.posts)).toBe('one ncjw\n\ntwo?\n')
    expect(r.session.replayLive()).toBe(true)
  })

  it('a key before the caret group renders renders that group first and keeps the caret (2.7)', () => {
    const before = 'x ncjw\n\ny ncjw\n\nz\n'
    const { r } = start(before)
    select(paragraph(r, 0), 6)
    r.session.beforeReplayInput(new KeyboardEvent('keydown', { key: 'a' }))
    expect(paragraphText(r, 0)).toBe('x ncjw')
    expect(paragraphText(r, 1)).toBe('y ZZZZ')
    const selection = document.getSelection()
    expect(selection?.focusNode).toBe(paragraph(r, 0))
    expect(selection?.focusOffset).toBe(6)
    expect(r.stats().replay.caretFallback).toBe(0)
  })

  it('the caret intent picks the group that renders first', () => {
    const before = 'x ncjw\n\ny ncjw\n\nz\n'
    const { r } = start(before, {
      select: (rig) => select(paragraph(rig, 1), 1),
    })
    r.session.renderReplayCaretGroup()
    expect(paragraphText(r, 1)).toBe('y ncjw')
    expect(paragraphText(r, 0)).toBe('x ZZZZ')
  })

  it('a paste over a selection that contains a pending group keeps the whole intent range', async () => {
    const before = 'a\n\nb ncjw\n\nc\n'
    const { r, fake, done } = start(before)
    select(paragraph(r, 0), 0, paragraph(r, 2), 1)
    r.session.beforeReplayInput(new Event('paste'))
    // Only the endpoints render: the contained group is still pending.
    expect(paragraphText(r, 1)).toBe('b ZZZZ')
    paragraph(r, 0).data = 'A'
    fake.state.publisher?.publish('idle')
    expect(fake.posts).toHaveLength(1)
    expect(fake.posts[0].changes?.[0].oldText).toBe('a\n\nb ncjw\n\nc')
    expect(applyPosts(before, fake.posts)).toBe('A\n\nb ZZZZ\n\nc\n')
    // The contained group was dropped: the replay has nothing left to render.
    expect(await settle(r, done)).toBe(true)
    expect(paragraphText(r, 1)).toBe('b ZZZZ')
  })

  it('an IME commit during the replay is published at its end, with no refusal or resync', () => {
    const before = 'x ncjw\n\nz\n'
    const { r, fake, postReplay } = start(before)
    select(paragraph(r, 1), 1)
    r.session.beforeReplayInput(new Event('compositionstart'))
    r.composing.value = true
    paragraph(r, 1).data = 'zあ'
    expect(fake.state.publisher?.publish('idle')).toBe('nothing')
    r.composing.value = false
    expect(fake.state.publisher?.publish('idle')).toBe('delta')
    expect(applyPosts(before, fake.posts)).toBe('x ncjw\n\nzあ\n')
    expect(postReplay).not.toHaveBeenCalled()
    expect(r.stats().replay.inputFailed).toBe(0)
  })

  it('a drop inside the editor renders its three endpoints and publishes one operation', () => {
    const before = 'x ncjw\n\ny ncjw\n\nz ncjw\n'
    const { r, fake } = start(before)
    select(paragraph(r, 0), 0, paragraph(r, 0), 1)
    const dropAt = paragraph(r, 2)
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range
    }
    doc.caretRangeFromPoint = () => {
      const range = document.createRange()
      range.setStart(dropAt, 1)
      return range
    }
    try {
      r.session.beforeReplayInput(new Event('drop'))
    } finally {
      delete doc.caretRangeFromPoint
    }
    expect(paragraphText(r, 0)).toBe('x ncjw')
    expect(paragraphText(r, 1)).toBe('y ZZZZ')
    expect(paragraphText(r, 2)).toBe('z ncjw')
    // The move: `x` leaves the first paragraph and lands in the third.
    paragraph(r, 0).data = ' ncjw'
    paragraph(r, 2).data = 'zx ncjw'
    fake.state.publisher?.publish('idle')
    expect(fake.posts).toHaveLength(1)
    expect(applyPosts(before, fake.posts)).toBe(
      r.session.deltaPort().modelText(),
    )
  })

  it('a rectangle Copy over a pending table reads its logical bytes after rendering it', () => {
    const before = '| a | b |\n| --- | --- |\n| ncjw | x |\n\nend ncjw\n'
    const { r } = start(before)
    const table = r.root.querySelector('table') as HTMLElement
    expect(r.session.replayTableSource(table)).toBe(
      '| a | b |\n| --- | --- |\n| ncjw | x |',
    )
    expect(
      Array.from(r.root.querySelectorAll('td')).map((td) => td.textContent),
    ).toEqual(['ncjw', 'x'])
    expect(r.root.textContent).toContain('end ZZZZ')
  })

  it('Redo right after Undo supersedes it and keeps the rendered half (Q-B)', async () => {
    const before = 'x ncjw\n\ny ncjw\n\nz\n'
    const { r, done, after } = start(before, {
      select: (rig) => select(paragraph(rig, 1), 1),
    })
    r.session.renderReplayCaretGroup()
    expect(paragraphText(r, 1)).toBe('y ncjw')
    r.session.awaitExactHistory(6, {
      epoch: 3,
      replayOp: 2,
      requestId: 'find-1',
    })
    const redo = r.session.historyPort().restoreSliced?.({} as never, 'after')
    await settle(r, done)
    expect(await settle(r, redo)).toBe(true)
    expect(r.stats().replay).toMatchObject({ superseded: 1, whole: 0 })
    expect(paragraphText(r, 0)).toBe('x ZZZZ')
    expect(paragraphText(r, 1)).toBe('y ZZZZ')
    r.session.onReplayAck(
      { epoch: 3, replayOp: 2, acceptedSequence: 0 },
      () => after,
    )
    expect(r.session.confirmedSnapshot()).toEqual({ text: after, epoch: 3 })
  })

  it('an untagged Undo during the replay is reserved, then posted against L', () => {
    const before = 'x ncjw\n\nz\n'
    const { r, fake } = start(before)
    // The restore of a typed entry wrote the paragraph back.
    paragraph(r, 1).data = 'q'
    expect(r.session.publishReplayHistory('undo', 1)).toBe('delta')
    expect(fake.posts.map((post) => post.command)).toEqual([
      'replay-reserve',
      'history-delta',
    ])
    expect(fake.posts[1].replayOp).toBe(fake.posts[0].replayOp)
    expect(applyPosts(before, fake.posts)).toBe('x ncjw\n\nq\n')
  })

  // ---- Task 733 / 036 (E, E2, fix design 3.5-3.6): a host text ends the replay; recovery ----

  /** Runs every queued frame (the recovery render spreads over frames). */
  const drain = (r: Rig) => {
    for (let n = 0; n < 50 && r.frames.length > 0; n++) r.runFrames()
  }
  const recoveryDone = (postReplay: ReturnType<typeof vi.fn>) =>
    postReplay.mock.calls.filter((c) => c[0]?.command === 'recovery-done')

  it('E: a newer host text ends the replay at once and renders through the bounded writer, no whole change', async () => {
    const before = 'one ncjw\n\ntwo\n\nthree\n'
    const { r, fake, postReplay, done } = start(before)
    expect(r.session.replayLive()).toBe(true)
    const changes: { whole: boolean }[] = []
    r.session.onUnitsChanged((change) => changes.push(change))
    const whole = vi.fn()
    // The host refused the move (replayAfterOp 0) and holds an outside change in the last paragraph.
    const host = 'one ncjw\n\ntwo\n\nTHREE\n'
    expect(r.session.recoverReplay(host, 4, 0, whole)).toBe('recovering')
    // The replay ended at once: input and the logical publisher are no longer live, publication is held.
    expect(r.session.replayLive()).toBe(false)
    expect(fake.state.publisher).toBeUndefined()
    expect(r.session.publicationHeld()).toBe(true)
    expect(r.session.exactBusy()).toBe(true)
    drain(r)
    // The stopped engine resolves false; the sliced restore it joined ends with it.
    expect(await done).toBe(false)
    expect(whole).not.toHaveBeenCalled()
    expect(r.session.deltaPort().modelText()).toBe(host)
    expect(r.root.textContent).toBe('one ncjwtwoTHREE')
    expect(changes.some((change) => change.whole)).toBe(false)
    expect(r.session.ownsText()).toBe(true)
    expect(r.session.exactBusy()).toBe(false)
    expect(r.session.confirmedSnapshot()).toEqual({ text: host, epoch: 4 })
    expect(recoveryDone(postReplay)).toEqual([
      [{ command: 'recovery-done', epoch: 3 }],
    ])
    // The old epoch's replay acknowledgement now changes nothing.
    expect(
      r.session.onReplayAck(
        { epoch: 3, replayOp: 1, acceptedSequence: 0 },
        () => before,
      ),
    ).toBe(false)
  })

  it('E: a large host text renders by chunks of the bounded writer and ends equal to it, with no whole render', () => {
    const block = (n: number) => `p${n} ${'x'.repeat(900)}`
    const blocks = Array.from({ length: 12 }, (_, n) => block(n))
    const before = `one ncjw\n\n${blocks.join('\n\n')}\n`
    const { r } = start(before)
    const host = `one ncjw\n\n${blocks.map((b) => b.toUpperCase()).join('\n\n')}\n`
    const whole = vi.fn()
    let frames = 0
    expect(r.session.recoverReplay(host, 4, 0, whole)).toBe('recovering')
    const writes: number[] = []
    r.session.onUnitsChanged((change) => {
      if (change.cause === 'sync') writes.push(frames)
    })
    for (; frames < 20 && r.frames.length > 0; frames++) r.runFrames()
    expect(whole).not.toHaveBeenCalled()
    expect(r.session.deltaPort().modelText()).toBe(host)
    // About 11,000 changed characters in chunks of about 4,096, reported as scoped frame changes.
    expect(writes.length).toBeGreaterThanOrEqual(1)
    expect(r.root.querySelectorAll('p')).toHaveLength(13)
  })

  // ---- H2 fix design rev2 (S3 review point 3): recovery chunks aligned on both structures ----

  /** The recorded x4 window (offset 266544 of 4 copies) is offset 92026 of one copy: a fence, then an ordered list. */
  const RECORDED = (() => {
    const large = readFileSync(
      'test/vscode-e2e/fixtures/large-observable-models-synthetic.md',
      'utf8',
    )
    const from = large.lastIndexOf('\n\n```', 92026) + 2
    const to = large.indexOf('\n\n', 98787 + 400) + 1
    return large.slice(from, to)
  })()
  const recoveryStats = (r: Rig) => r.stats().replay.recovery

  it('S3-3: the recorded window (inside a fence, into an ordered list) recovers by units, bytes equal, no whole render', () => {
    const before = `intro ncjw\n\n${RECORDED}`
    expect(RECORDED.startsWith('```')).toBe(true)
    expect(/\n\d+\. /u.test(RECORDED)).toBe(true)
    const { r, postReplay } = start(before)
    const whole = vi.fn()
    expect(r.session.recoverReplay(before, 4, 0, whole)).toBe('recovering')
    drain(r)
    expect(whole).not.toHaveBeenCalled()
    expect(r.session.deltaPort().modelText()).toBe(before)
    expect(recoveryStats(r)).toMatchObject({ whole: 0 })
    expect(recoveryStats(r).atomics).toBeGreaterThanOrEqual(2)
    expect(recoveryDone(postReplay)).toHaveLength(1)
  })

  it('S3-3: unequal-length and structural edits (a block inserted, an item removed) recover with exact bytes', () => {
    const before =
      'p0 ncjw\n\n```js\nconst a = ncjw\n```\n\n1. one ncjw\n2. two\n3. three ncjw\n\npara ncjw end\n\n- x\n- y ncjw\n'
    const { r } = start(before, { insert: 'Q' })
    const host = before
      .replace('2. two\n', '')
      .replace('para ncjw end', 'new block\n\npara ncjw end, longer now')
    const whole = vi.fn()
    expect(r.session.recoverReplay(host, 4, 0, whole)).toBe('recovering')
    drain(r)
    expect(whole).not.toHaveBeenCalled()
    expect(r.session.deltaPort().modelText()).toBe(host)
    const fresh = document.createElement('div')
    fresh.innerHTML = lute.Md2VditorIRDOM(host)
    expect(r.root.textContent).toBe(fresh.textContent)
  })

  it('S3-3: equal spans are skipped: only the changed units are written', () => {
    const blocks = Array.from({ length: 30 }, (_, n) => `block ${n} text`)
    blocks[3] = 'block 3 ncjw'
    blocks[27] = 'block 27 ncjw'
    const before = `${blocks.join('\n\n')}\n`
    const { r } = start(before)
    const kept = r.root.querySelectorAll('p')[15]
    expect(r.session.recoverReplay(before, 4, 0, vi.fn())).toBe('recovering')
    drain(r)
    expect(r.session.deltaPort().modelText()).toBe(before)
    // The paragraph between the two changed units is the same element.
    expect(r.root.querySelectorAll('p')[15]).toBe(kept)
    expect(recoveryStats(r).atomics).toBe(2)
  })

  it('S4r1 fix 3: the recovery scan never reads more than 80,000 characters of the host text', () => {
    const before = 'p ncjw\n\nend\n'
    const { r } = start(before)
    const host = `p ncjw\n\n\`\`\`\n${'line\n'.repeat(20_000)}\`\`\`\n`
    const original = String.prototype.slice
    let longest = 0
    const spy = vi
      .spyOn(String.prototype, 'slice')
      .mockImplementation(function (this: string, ...args: [number?, number?]) {
        const out = original.apply(this, args)
        if (this.length === host.length && out.length > longest)
          longest = out.length
        return out
      })
    try {
      expect(r.session.recoverReplay(host, 4, 0, vi.fn())).toBe('recovering')
      drain(r)
    } finally {
      spy.mockRestore()
    }
    expect(longest).toBeGreaterThan(0)
    expect(longest).toBeLessThanOrEqual(80_000)
  })

  it('S4r1 fix 4: a host fence opened over the rendered suffix extends the tail; bytes equal, no whole render', () => {
    // The rendered tail starts at `Y`; the host opens a fence before `b` that the four-backtick line closes,
    // so `Y` lies inside a host fence (the rendered four-backtick fence keeps both texts balanced).
    const before = 'a ncjw\n\nb\n\nX\n\nY\n\n````\nq\n```\n````\n\nW\n'
    const { r, after } = start(before)
    const host = after.replace('\n\nb\n', '\n\n```\nb\n')
    const whole = vi.fn()
    expect(r.session.recoverReplay(host, 4, 0, whole)).toBe('recovering')
    drain(r)
    expect(whole).not.toHaveBeenCalled()
    expect(r.session.deltaPort().modelText()).toBe(host)
    expect(recoveryStats(r).tailDropped).toBe(1)
  })

  it('S4r1 fix 5: a unit over 4,096 characters renders alone in its frame', () => {
    const big = `big ncjw ${'w'.repeat(5000)}`
    const before = `${big}\n\nsmall ncjw\n`
    const { r } = start(before)
    expect(r.session.recoverReplay(before, 4, 0, vi.fn())).toBe('recovering')
    r.runFrames()
    expect(recoveryStats(r)).toMatchObject({ atomics: 1, oversize: 1 })
    drain(r)
    expect(r.session.deltaPort().modelText()).toBe(before)
    expect(recoveryStats(r).atomics).toBe(2)
  })

  it('S4r1 fix 7: an input that renders a pending group is charged to the replay account', () => {
    const before = 'x ncjw\n\ny ncjw\n\nz\n'
    const { r } = start(before)
    select(paragraph(r, 0), 6)
    r.session.beforeReplayInput(new KeyboardEvent('keydown', { key: 'a' }))
    expect(paragraphText(r, 0)).toBe('x ncjw')
    expect(r.stats().replay.budget.classes['endpoint-render']?.atomics).toBe(1)
  })

  it('S3-3: a caret after the change in a recovered unit keeps its place; one in an unchanged unit is untouched', () => {
    const before = 'a ncjw tail\n\nkeep me\n\nz ncjw\n'
    const { r } = start(before)
    const first = paragraph(r, 0)
    select(first, first.data.length)
    expect(r.session.recoverReplay(before, 4, 0, vi.fn())).toBe('recovering')
    drain(r)
    expect(r.session.deltaPort().modelText()).toBe(before)
    const selection = document.getSelection()
    expect(selection?.anchorNode?.textContent).toBe('a ncjw tail')
    expect(selection?.anchorOffset).toBe('a ncjw tail'.length)
    expect(selection?.isCollapsed).toBe(true)
    // A caret in the unchanged middle paragraph keeps its node object.
    const { r: r2 } = start(before)
    const middle = paragraph(r2, 1)
    select(middle, 2)
    expect(r2.session.recoverReplay(before, 4, 0, vi.fn())).toBe('recovering')
    drain(r2)
    expect(document.getSelection()?.anchorNode).toBe(middle)
    expect(document.getSelection()?.anchorOffset).toBe(2)
  })

  it('E: an older-epoch host text with no recovery running is not a recovery', () => {
    const { r } = start('one ncjw\n\ntwo\n')
    expect(r.session.recoverReplay('x\n', 3, 0, vi.fn())).toBe('none')
    expect(r.session.replayLive()).toBe(true)
  })

  it('E: no replay active: none', () => {
    const r = open('one\n\ntwo\n', 3)
    r.runFrames()
    expect(r.session.recoverReplay('x\n', 4, 0, vi.fn())).toBe('none')
  })

  it('E2: a proven refused edit is reapplied with recoveryOf before recovery-done; the journal follows the acknowledgement', () => {
    const before = 'one ncjw\n\ntwo\n\nthree\n'
    const { r, fake, postReplay, done } = start(before)
    void done
    // Typing in a rendered unit during the replay: replay operation 2 of epoch 3.
    paragraph(r, 1).data = 'two!'
    expect(fake.state.publisher?.publish('idle')).toBe('delta')
    expect(fake.posts.at(-1)?.replayOp).toBe(2)
    const postSpy = vi.spyOn(fake.sync, 'postReplayDelta')
    // The host applied the move (op 1) and refused the typing; its text holds an outside change elsewhere.
    const host = 'ONE ncjw\n\ntwo\n\nthree\n'
    expect(r.session.recoverReplay(host, 4, 1, vi.fn())).toBe('recovering')
    drain(r)
    expect(postSpy).toHaveBeenCalledOnce()
    const reapplied = fake.posts.at(-1)
    expect(reapplied?.recoveryOf).toEqual({ epoch: 3, replayOp: 2 })
    // The reapplication is expressed against the host text and gives the host text plus the typing.
    expect(applyPosts(host, [reapplied as Post])).toBe(
      'ONE ncjw\n\ntwo!\n\nthree\n',
    )
    expect(r.session.deltaPort().modelText()).toBe(
      'ONE ncjw\n\ntwo!\n\nthree\n',
    )
    // recovery-done names the ended epoch and comes after the last reapplication.
    const doneCalls = recoveryDone(postReplay)
    expect(doneCalls).toEqual([[{ command: 'recovery-done', epoch: 3 }]])
    const doneOrder =
      postReplay.mock.invocationCallOrder[
        postReplay.mock.calls.findIndex(
          (c) => c[0]?.command === 'recovery-done',
        )
      ]
    expect(postSpy.mock.invocationCallOrder[0]).toBeLessThan(doneOrder)
  })

  it('E2: an acknowledged edit is not reapplied (the journal drops it at its replay-ack)', () => {
    const before = 'one ncjw\n\ntwo\n'
    const { r, fake } = start(before)
    paragraph(r, 1).data = 'two!'
    expect(fake.state.publisher?.publish('idle')).toBe('delta')
    r.session.onReplayAck(
      { epoch: 3, replayOp: 2, acceptedSequence: 11 },
      () => before,
    )
    const postSpy = vi.spyOn(fake.sync, 'postReplayDelta')
    expect(
      r.session.recoverReplay('one ncjw\n\ntwo!\n\nX\n', 4, 2, vi.fn()),
    ).toBe('recovering')
    drain(r)
    expect(postSpy).not.toHaveBeenCalled()
  })

  it('E2: an insertion whose unit is not proven stays a host entry (changed unit; repeated unit)', () => {
    for (const host of [
      // The outside change rewrote the typed unit: its text before the edit no longer occurs.
      'one ncjw\n\nTWO\n\nthree\n',
      // The unit occurs twice: its position is not proven.
      'one ncjw\n\ntwo\n\ntwo\n',
    ]) {
      const before = 'one ncjw\n\ntwo\n\nthree\n'
      const { r, fake, postReplay } = start(before)
      paragraph(r, 1).data = 'two!'
      expect(fake.state.publisher?.publish('idle')).toBe('delta')
      const postSpy = vi.spyOn(fake.sync, 'postReplayDelta')
      expect(r.session.recoverReplay(host, 4, 1, vi.fn())).toBe('recovering')
      drain(r)
      expect(postSpy).not.toHaveBeenCalled()
      expect(r.session.deltaPort().modelText()).toBe(host)
      expect(recoveryDone(postReplay)).toEqual([
        [{ command: 'recovery-done', epoch: 3 }],
      ])
      r.session.dispose()
    }
  })

  it('E2: typing not yet posted at the refusal is reapplied as a new operation without recoveryOf', () => {
    const before = 'one ncjw\n\ntwo\n\nthree\n'
    const { r, fake } = start(before)
    paragraph(r, 1).data = 'two?'
    const host = 'one ncjw\n\ntwo\n\nthree\n'
    expect(r.session.recoverReplay(host, 4, 1, vi.fn())).toBe('recovering')
    drain(r)
    const reapplied = fake.posts.at(-1)
    expect(reapplied?.command).toBe('edit-delta')
    expect(reapplied?.recoveryOf).toBeUndefined()
    expect(applyPosts(host, [reapplied as Post])).toBe(
      'one ncjw\n\ntwo?\n\nthree\n',
    )
  })

  it('E2: an edit typed after the recovery publishes against the host text on the new epoch', () => {
    const before = 'one ncjw\n\ntwo\n\nthree\n'
    const { r } = start(before)
    const host = 'one ncjw\n\ntwo\n\nTHREE\n'
    expect(r.session.recoverReplay(host, 4, 0, vi.fn())).toBe('recovering')
    drain(r)
    type(r, 1, 'twoX')
    const port = r.session.deltaPort()
    expect(port.epoch()).toBe(4)
    const prepared = port.prepareDelta(1)
    expect(prepared.kind).toBe('changes')
    if (prepared.kind !== 'changes') return
    expect(prepared.before).toBe(host)
    expect(prepared.changes).toEqual([{ from: 13, to: 13, insert: 'X' }])
  })

  it('E2: a recovery that cannot finish by units renders the host text whole and still posts recovery-done', async () => {
    const before = 'one ncjw\n\ntwo\n'
    const { r, postReplay, fake, done } = start(before)
    const whole = vi.fn()
    expect(r.session.recoverReplay('one ncjw\n\nTWO\n', 4, 0, whole)).toBe(
      'recovering',
    )
    // A DOM change the recovery cannot place (036 core C5, M2 path 3: two units) arrives before its first
    // frame. R3.2: `recovery-done` follows the rebuild of the whole render.
    paragraph(r, 0).data = 'one ncjw~'
    paragraph(r, 1).data = 'two~'
    const postSpy = vi.spyOn(fake.sync, 'postReplayDelta')
    drain(r)
    expect(whole).toHaveBeenCalledOnce()
    expect(recoveryDone(postReplay)).toEqual([])
    r.render('one ncjw\n\nTWO\n')
    r.session.onHostText('one ncjw\n\nTWO\n', 4)
    r.runFrames()
    expect(postSpy).not.toHaveBeenCalled()
    expect(recoveryDone(postReplay)).toEqual([
      [{ command: 'recovery-done', epoch: 3 }],
    ])
    expect(await done).toBe(false)
    expect(r.session.exactBusy()).toBe(false)
  })

  // ---- H2 fix design rev2 (D6.1-D6.3, D7, review point 4): the abandoned state and its resync ----

  /** The abandon of the awaited move: its acknowledgement names no target, so the host bytes are needed. */
  const abandon = (r: Rig) =>
    r.session.onReplayAck(
      { epoch: 3, replayOp: 1, acceptedSequence: 0 },
      () => undefined,
    )
  const abandons = (postReplay: ReturnType<typeof vi.fn>) =>
    postReplay.mock.calls.filter((c) => c[0]?.command === 'replay-abandon')

  it('D6.1: abandoned, a typed key is posted as an old-epoch replay operation; the update recovers and reapplies it', async () => {
    const before = 'one ncjw\n\ntwo\n\nthree\n'
    const { r, fake, postReplay, done } = start(before)
    abandon(r)
    expect(abandons(postReplay)).toEqual([
      [{ command: 'replay-abandon', epoch: 3, replayOp: 1 }],
    ])
    // Rendering stopped; the logical text stays with its frozen group.
    r.runFrames()
    expect(paragraphText(r, 0)).toBe('one ZZZZ')
    expect(r.session.replayLive()).toBe(true)
    expect(r.session.exactBusy()).toBe(true)
    expect(r.session.publicationHeld()).toBe(false)
    expect(r.session.publicationHeld(true)).toBe(true)
    paragraph(r, 1).data = 'two!'
    expect(fake.state.publisher?.publish('idle')).toBe('delta')
    expect(fake.posts).toHaveLength(1)
    expect(fake.posts[0].replayOp).toBe(2)
    // In `L` positions: the pending group's target bytes, not the rendered ones.
    expect(applyPosts(before, fake.posts)).toBe('one ncjw\n\ntwo!\n\nthree\n')
    const postSpy = vi.spyOn(fake.sync, 'postReplayDelta')
    // The resync: the host text is the move's target; operation 2 was dropped by its epoch.
    expect(r.session.recoverReplay(before, 4, 1, vi.fn())).toBe('recovering')
    drain(r)
    expect(postSpy).toHaveBeenCalledOnce()
    expect(fake.posts.at(-1)?.recoveryOf).toEqual({ epoch: 3, replayOp: 2 })
    expect(r.session.deltaPort().modelText()).toBe(
      'one ncjw\n\ntwo!\n\nthree\n',
    )
    expect(r.session.replayLive()).toBe(false)
    // The stopped engine resolves false; the sliced restore it joined ends with it.
    expect(await done).toBe(false)
    expect(r.session.exactBusy()).toBe(false)
    expect(recoveryDone(postReplay)).toEqual([
      [{ command: 'recovery-done', epoch: 3 }],
    ])
  })

  it('D6.2: abandoned, then the update: the bounded recovery renders it, not the whole path', async () => {
    const before = 'one ncjw\n\ntwo\n'
    const { r, postReplay, done } = start(before)
    abandon(r)
    // The engine stopped before the resync arrives.
    r.runFrames()
    expect(await done).toBe(false)
    const whole = vi.fn()
    expect(r.session.recoverReplay(before, 4, 1, whole)).toBe('recovering')
    drain(r)
    expect(whole).not.toHaveBeenCalled()
    expect(r.session.deltaPort().modelText()).toBe(before)
    expect(paragraphText(r, 0)).toBe('one ncjw')
    expect(recoveryDone(postReplay)).toHaveLength(1)
  })

  it('D6.1: abandoned, a key whose endpoint lies in a pending group is refused and renders nothing', () => {
    const before = 'one ncjw\n\ntwo\n'
    const { r, fake } = start(before)
    abandon(r)
    select(paragraph(r, 0), 6)
    const key = new KeyboardEvent('keydown', { key: 'a', cancelable: true })
    r.session.beforeReplayInput(key)
    expect(key.defaultPrevented).toBe(true)
    expect(paragraphText(r, 0)).toBe('one ZZZZ')
    r.session.renderReplayCaretGroup()
    expect(paragraphText(r, 0)).toBe('one ZZZZ')
    expect(fake.posts).toHaveLength(0)
    expect(r.stats().replay.abandonRefused).toBe(1)
  })

  it('D6.1: abandoned typing not posted yet is posted as an old-epoch operation before the recovery, so it is a host entry', () => {
    const before = 'one ncjw\n\ntwo\n'
    const { r, fake } = start(before)
    abandon(r)
    paragraph(r, 1).data = 'two?'
    // An update of the same epoch flushes nothing; the newer one does, before the publisher follows it.
    r.session.flushAbandonedInput(3)
    expect(fake.posts).toHaveLength(0)
    r.session.flushAbandonedInput(4)
    expect(r.session.recoverReplay(before, 4, 1, vi.fn())).toBe('recovering')
    expect(fake.posts).toHaveLength(1)
    expect(fake.posts[0].replayOp).toBe(2)
    expect(fake.posts[0].recoveryOf).toBeUndefined()
    expect(applyPosts(before, fake.posts)).toBe('one ncjw\n\ntwo?\n')
    drain(r)
    expect(fake.posts.at(-1)?.recoveryOf).toEqual({ epoch: 3, replayOp: 2 })
  })

  it('D6.1: a fallback recovery keeps the posted operations host-side; nothing is kept only in the webview', () => {
    const before = 'one ncjw\n\ntwo\n'
    const { r, fake, postReplay } = start(before)
    abandon(r)
    paragraph(r, 1).data = 'two!'
    fake.state.publisher?.publish('idle')
    expect(fake.posts).toHaveLength(1)
    const whole = vi.fn()
    expect(r.session.recoverReplay(before, 4, 1, whole)).toBe('recovering')
    // A DOM change the recovery cannot place (036 core C5, M2 path 3: two units) arrives before its first
    // frame. R3.2: `recovery-done` follows the rebuild of the whole render.
    paragraph(r, 0).data = 'one ZZZZ~'
    paragraph(r, 1).data = 'two!~'
    const postSpy = vi.spyOn(fake.sync, 'postReplayDelta')
    drain(r)
    expect(whole).toHaveBeenCalledOnce()
    r.render(before)
    r.session.onHostText(before, 4)
    r.runFrames()
    // R3.2: the journaled typing (operation 2 of epoch 3) is proven against the rebuilt model and
    // reapplied as a `recoveryOf` op of the new epoch before recovery-done.
    expect(postSpy).toHaveBeenCalledOnce()
    expect(postSpy.mock.calls[0][2]).toEqual({ epoch: 3, replayOp: 2 })
    expect(fake.posts.map((post) => post.replayOp).slice(0, 1)).toEqual([2])
    expect(recoveryDone(postReplay)).toEqual([
      [{ command: 'recovery-done', epoch: 3 }],
    ])
  })

  it('D6.1: lost update: the abandoned operation is queried every 5 s; ended asks for the host state', () => {
    const before = 'one ncjw\n\ntwo\n'
    vi.useFakeTimers()
    try {
      const { r, postReplay } = start(before)
      abandon(r)
      postReplay.mockClear()
      vi.advanceTimersByTime(5000)
      vi.advanceTimersByTime(5000)
      expect(postReplay.mock.calls).toEqual([
        [{ command: 'replay-query', epoch: 3, replayOp: 1 }],
        [{ command: 'replay-query', epoch: 3, replayOp: 1 }],
      ])
      postReplay.mockClear()
      r.session.onReplayStatus({
        epoch: 3,
        replayOp: 1,
        state: 'ended',
        applied: 1,
        acceptedSequence: 0,
      })
      expect(postReplay.mock.calls).toEqual([
        [{ command: 'host-state-query', requestId: 'replay-3-1' }],
      ])
      // The `host-state` of the newer epoch is handled as the update.
      expect(r.session.recoverReplay(before, 4, 1, vi.fn())).toBe('recovering')
      drain(r)
      postReplay.mockClear()
      vi.advanceTimersByTime(10_000)
      expect(postReplay).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  const status = (r: Rig, replayOp: number, state: string) =>
    r.session.onReplayStatus({
      epoch: 3,
      replayOp,
      state,
      applied: 1,
      acceptedSequence: 0,
    })
  const PROBE = Number.MAX_SAFE_INTEGER

  it('D6.1: applied does not tell the epoch apart: it asks for the host state and probes the epoch', () => {
    const before = 'one ncjw\n\ntwo\n'
    const { r, postReplay } = start(before)
    abandon(r)
    postReplay.mockClear()
    status(r, 1, 'applied')
    expect(postReplay.mock.calls).toEqual([
      [{ command: 'host-state-query', requestId: 'replay-3-1' }],
      [{ command: 'replay-query', epoch: 3, replayOp: PROBE }],
    ])
    expect(abandons(postReplay)).toHaveLength(0)
  })

  it('D6.1: lost abandon: the probe finds the epoch current, so the abandon is posted again', () => {
    const before = 'one ncjw\n\ntwo\n'
    const { r, postReplay } = start(before)
    abandon(r)
    postReplay.mockClear()
    status(r, PROBE, 'unknown')
    expect(postReplay.mock.calls).toEqual([
      [{ command: 'replay-abandon', epoch: 3, replayOp: 1 }],
    ])
    postReplay.mockClear()
    status(r, 1, 'queued')
    expect(abandons(postReplay)).toHaveLength(1)
    expect(r.session.exactBusy()).toBe(true)
  })

  it('D6.1: lost update: the probe finds the epoch ended, so only the host state is asked for', () => {
    const before = 'one ncjw\n\ntwo\n'
    const { r, postReplay } = start(before)
    abandon(r)
    postReplay.mockClear()
    status(r, PROBE, 'ended')
    expect(postReplay.mock.calls).toEqual([
      [{ command: 'host-state-query', requestId: 'replay-3-1' }],
    ])
  })

  it('D6.1: the old-epoch allocator survives the update: the flush before the epoch change posts replayOp 2 of epoch 3', async () => {
    const before = 'one ncjw\n\ntwo\n'
    const { after, record } = recordOf(before)
    const postReplay = vi.fn()
    const r = open(after, 3, {
      deps: { exactHunksOf: () => record, postReplay },
    })
    r.runFrames()
    for (const block of Array.from(r.root.children)) {
      document.getSelection()?.selectAllChildren(block)
      block.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    }
    document.getSelection()?.removeAllRanges()
    const posted: Array<{
      command: string
      epoch?: number
      replayOp?: number
    }> = []
    const { createDeltaSync } = await import('./delta-sync')
    const sync = createDeltaSync({
      session: r.session.deltaPort(),
      postMessage: (message) => posted.push(message as never),
      publishWhole: vi.fn(),
      countFallback: vi.fn(),
      isComposing: () => false,
      now: () => 0,
    })
    r.session.bindReplaySync(sync as never)
    // The history move takes replay operation 1 of epoch 3.
    sync.reserveReplayHistory('undo')
    r.session.awaitExactHistory(5, {
      epoch: 3,
      replayOp: 1,
      requestId: 'find-1',
    })
    void r.session.historyPort().restoreSliced?.({} as never, 'before')
    abandon(r)
    paragraph(r, 1).data = 'two?'
    posted.length = 0
    // The router's order: the flush, then the publisher follows the new epoch, then the recovery.
    r.session.flushAbandonedInput(4)
    sync.onUpdate({ epoch: 4, afterSequence: 1 })
    expect(r.session.recoverReplay(before, 4, 1, vi.fn())).toBe('recovering')
    expect(posted[0]).toMatchObject({
      command: 'edit-delta',
      epoch: 3,
      replayOp: 2,
    })
  })

  it('D6.1: a superseding move while abandoned, then the resync: the new move ends and the host text renders', async () => {
    const before = 'x ncjw\n\ny ncjw\n\nz\n'
    const { r, done, postReplay } = start(before, {
      select: (rig) => select(paragraph(rig, 1), 1),
    })
    r.session.renderReplayCaretGroup()
    abandon(r)
    expect(r.session.exactBusy()).toBe(true)
    // Redo of the same record supersedes the abandoned Undo; the abandoned state is cleared by it.
    r.session.awaitExactHistory(6, {
      epoch: 3,
      replayOp: 2,
      requestId: 'find-1',
    })
    const redo = r.session.historyPort().restoreSliced?.({} as never, 'after')
    expect(r.session.replayLive()).toBe(true)
    // The resync the abandon asked for arrives while the new move renders.
    const host = before
    expect(r.session.recoverReplay(host, 4, 1, vi.fn())).toBe('recovering')
    drain(r)
    await settle(r, done)
    expect(await settle(r, redo)).toBe(false)
    expect(r.session.deltaPort().modelText()).toBe(host)
    expect(r.session.replayLive()).toBe(false)
    expect(r.session.exactBusy()).toBe(false)
    expect(r.session.editsRefused()).toBe(false)
    expect(recoveryDone(postReplay)).toHaveLength(1)
  })

  it('D6.1: the resync first, then a new move: it starts on the new epoch with no abandoned state left', async () => {
    const before = 'x ncjw\n\nz\n'
    const { r, done, postReplay } = start(before)
    abandon(r)
    expect(r.session.recoverReplay(before, 4, 1, vi.fn())).toBe('recovering')
    drain(r)
    await settle(r, done)
    postReplay.mockClear()
    vi.useFakeTimers()
    try {
      r.session.awaitExactHistory(7, {
        epoch: 4,
        replayOp: 1,
        requestId: 'find-1',
      })
      vi.advanceTimersByTime(5000)
    } finally {
      vi.useRealTimers()
    }
    // Only the new move's own query: nothing of the abandoned operation is queried or re-posted.
    expect(postReplay.mock.calls).toEqual([
      [{ command: 'replay-query', epoch: 4, replayOp: 1 }],
    ])
    expect(r.session.editsRefused()).toBe(false)
  })

  it('review point 4: a mismatch ends the logical text; nothing is translated through the frozen mapping', async () => {
    const before = 'one ncjw\n\ntwo\n'
    forceMismatch.value = true
    try {
      const { r, fake, done, postReplay } = start(before)
      expect(await settle(r, done)).toBe(false)
      expect(r.stats().replay.mismatch).toBe(1)
      expect(abandons(postReplay)).toHaveLength(1)
      expect(r.session.replayLive()).toBe(false)
      expect(fake.state.publisher).toBeUndefined()
      // Every publication is held until the resync: the unit history refuses the input meanwhile.
      expect(r.session.exactBusy()).toBe(true)
      expect(r.session.publicationHeld()).toBe(true)
      expect(r.session.editsRefused()).toBe(true)
      expect(fake.posts).toHaveLength(0)
    } finally {
      forceMismatch.value = false
    }
  })

  it('review point 4: typing accepted before the mismatch is posted first and reapplied after the resync', async () => {
    const before = 'one ncjw\n\ntwo\n'
    // The switch applies to the replay target built at the key.
    forceMismatch.value = true
    let started: ReturnType<typeof start>
    try {
      started = start(before)
    } finally {
      forceMismatch.value = false
    }
    const { r, fake, done } = started
    expect(r.session.editsRefused()).toBe(false)
    // Typed before the frame that fails: the frame absorbs it before its first atomic.
    paragraph(r, 1).data = 'two!'
    expect(await settle(r, done)).toBe(false)
    expect(r.stats().replay.mismatch).toBe(1)
    expect(fake.posts).toHaveLength(1)
    expect(fake.posts[0].replayOp).toBe(2)
    expect(applyPosts(before, fake.posts)).toBe('one ncjw\n\ntwo!\n')
    expect(r.session.recoverReplay(before, 4, 1, vi.fn())).toBe('recovering')
    drain(r)
    expect(r.session.deltaPort().modelText()).toBe('one ncjw\n\ntwo!\n')
    expect(r.session.editsRefused()).toBe(false)
  })

  it('D7: an abandoned move still reaches its target through the resync: the rendered text is the host text', async () => {
    const before = 'one ncjw\n\ntwo ncjw\n'
    const { r, done } = start(before)
    abandon(r)
    r.runFrames()
    expect(await done).toBe(false)
    // The host text after the history move (the replay's target).
    expect(r.session.recoverReplay(before, 4, 1, vi.fn())).toBe('recovering')
    drain(r)
    expect(r.session.deltaPort().modelText()).toBe(before)
    expect(r.root.textContent).toBe('one ncjwtwo ncjw')
  })

  // ---- Task 733 / 036 (H2 fix design rev2, D1.1, D1.2, D10.1): the selection across a replay render ----

  /** Opens `before` and starts a Redo of the replacement; no frame has run, so every group is pending. */
  function startRedo(
    before: string,
    options: { select?: (r: Rig) => void } = {},
  ) {
    const { after, record } = recordOf(before)
    const r = open(before, 3, {
      deps: { exactHunksOf: () => record, postReplay: vi.fn() },
    })
    r.runFrames()
    for (const block of Array.from(r.root.children)) {
      document.getSelection()?.selectAllChildren(block)
      block.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    }
    document.getSelection()?.removeAllRanges()
    const fake = fakeSync()
    r.session.bindReplaySync(fake.sync as never)
    options.select?.(r)
    r.session.awaitExactHistory(5, {
      epoch: 3,
      replayOp: 1,
      requestId: 'find-1',
    })
    const done = r.session.historyPort().restoreSliced?.({} as never, 'after')
    return { r, fake, done, after }
  }
  const selectionNow = () => {
    const selection = document.getSelection()
    return {
      anchorNode: selection?.anchorNode,
      anchorOffset: selection?.anchorOffset,
      focusNode: selection?.focusNode,
      focusOffset: selection?.focusOffset,
    }
  }

  it('H2 D1.1: a frame atomic over the caret unit keeps a collapsed text caret, never an element point', async () => {
    const { r, done } = start('x ncjw y\n\nz\n', {
      select: (rig) => select(paragraph(rig, 0), 8),
    })
    r.runFrames()
    expect(paragraphText(r, 0)).toBe('x ncjw y')
    expect(selectionNow()).toEqual({
      anchorNode: paragraph(r, 0),
      anchorOffset: 8,
      focusNode: paragraph(r, 0),
      focusOffset: 8,
    })
    expect(await settle(r, done)).toBe(true)
  })

  it('H2 D1.1: a backward range inside the replaced unit keeps both endpoints and its direction', () => {
    const { r } = start('ab ncjw cd\n\nz\n', {
      select: (rig) => select(paragraph(rig, 0), 9, paragraph(rig, 0), 1),
    })
    r.runFrames()
    expect(paragraphText(r, 0)).toBe('ab ncjw cd')
    expect(selectionNow()).toEqual({
      anchorNode: paragraph(r, 0),
      anchorOffset: 9,
      focusNode: paragraph(r, 0),
      focusOffset: 1,
    })
  })

  it('H2 D1.1: an endpoint outside the replaced window is left alone, with no selection write', () => {
    const { r } = start('x ncjw\n\nz end\n', {
      select: (rig) => select(paragraph(rig, 1), 2),
    })
    const kept = paragraph(r, 1)
    const selection = document.getSelection() as Selection
    const writes = [
      vi.spyOn(selection, 'setBaseAndExtent'),
      vi.spyOn(selection, 'addRange'),
      vi.spyOn(selection, 'collapse'),
      vi.spyOn(selection, 'removeAllRanges'),
    ]
    r.runFrames()
    expect(paragraphText(r, 0)).toBe('x ncjw')
    for (const write of writes) expect(write).not.toHaveBeenCalled()
    expect(selection.anchorNode).toBe(kept)
    expect(selection.anchorOffset).toBe(2)
  })

  it('H2 D1.1: a Redo replay maps a caret inside a hunk to the hunk end', () => {
    const { r } = startRedo('x ncjw y\n\nz\n', {
      select: (rig) => select(paragraph(rig, 0), 4),
    })
    r.runFrames()
    expect(paragraphText(r, 0)).toBe('x ZZZZ y')
    expect(selectionNow()).toMatchObject({
      anchorNode: paragraph(r, 0),
      anchorOffset: 6,
    })
  })

  it('H2 D1.1: a row atomic replaces the live row and keeps the caret in its cell', () => {
    const { r } = start('| a | b |\n| --- | --- |\n| ncjw | xy |\n\nend\n', {
      select: (rig) => {
        const cell = rig.root.querySelectorAll('td')[1]
        select(cell.firstChild as Text, 1)
      },
    })
    const row = r.root.querySelectorAll('tr')[1]
    r.runFrames()
    expect(row.isConnected).toBe(false)
    const cell = r.root.querySelectorAll('td')[1]
    expect(cell.textContent).toBe('xy')
    expect(selectionNow()).toEqual({
      anchorNode: cell.firstChild,
      anchorOffset: 1,
      focusNode: cell.firstChild,
      focusOffset: 1,
    })
  })

  it('H2 D1.1: an intentional root selection keeps both root endpoints across an atomic over the last block', () => {
    const { r } = start('a\n\nb ncjw\n', {
      select: (rig) =>
        document
          .getSelection()
          ?.setBaseAndExtent(rig.root, 0, rig.root, rig.root.childNodes.length),
    })
    r.runFrames()
    expect(paragraphText(r, 1)).toBe('b ncjw')
    expect(selectionNow()).toEqual({
      anchorNode: r.root,
      anchorOffset: 0,
      focusNode: r.root,
      focusOffset: r.root.childNodes.length,
    })
  })

  it('H2 D10.1: a boundary U+00A0 from the browser is posted as the ordinary path posts it (replay off gives the same bytes)', () => {
    // The browser's paragraph split before a space in one unsplit text node: Chromium writes U+00A0 and
    // keeps the space (measured with the replay off, the same bytes reach the host).
    const split = (rig: Rig, index: number) => {
      const block = rig.root.querySelectorAll('p')[index]
      document.getSelection()?.selectAllChildren(block)
      block.dispatchEvent(new Event('beforeinput', { bubbles: true }))
      ;(block.firstChild as Text).data = 'ldgwck'
      const next = block.cloneNode(false) as HTMLElement
      next.textContent = 'q  nzw'
      block.after(next)
    }
    const plain = open('ldgwck nzw\n\nend\n', 3)
    plain.runFrames()
    split(plain, 0)
    const prepared = plain.session.deltaPort().prepareDelta(1)
    expect(prepared).toMatchObject({ kind: 'changes' })
    const ordinary = plain.session.deltaPort().modelText()
    expect(ordinary).toBe('ldgwck\n\nq  nzw\n\nend\n')
    const before = 'x ncjw\n\nldgwck nzw\n\nend\n'
    const { r, fake } = start(before)
    split(r, 1)
    expect(fake.state.publisher?.publish('idle')).toBe('delta')
    expect(applyPosts(before, fake.posts)).toBe(`x ncjw\n\n${ordinary}`)
  })

  describe('036 H2 D3', () => {
    /** A Cut or Copy as the browser sends it: the before-event, then the event, on `target`. */
    const clipEvent = (type: string, setData = vi.fn(), data = true) => {
      const event = new Event(type, { cancelable: true, bubbles: true })
      if (data)
        Object.defineProperty(event, 'clipboardData', { value: { setData } })
      return event
    }
    const dispatchTo = (r: Rig, target: Node, event: Event) => {
      const handler = (e: Event) => r.session.beforeReplayInput(e)
      target.addEventListener(event.type, handler, { once: true })
      target.dispatchEvent(event)
    }
    const clipboard = (
      r: Rig,
      kind: 'cut' | 'copy',
      target: Node = r.root,
      options: { before?: boolean; data?: boolean; between?: () => void } = {},
    ) => {
      const setData = vi.fn()
      const before = clipEvent(`before${kind}`)
      if (options.before !== false) dispatchTo(r, target, before)
      options.between?.()
      const event = clipEvent(kind, setData, options.data !== false)
      dispatchTo(r, target, event)
      return { setData, before, event }
    }
    const key = (r: Rig, name: string) => {
      const event = new KeyboardEvent('keydown', {
        key: name,
        cancelable: true,
        bubbles: true,
      })
      dispatchTo(r, r.root, event)
      return event
    }
    const selectRoot = (r: Rig) =>
      document
        .getSelection()
        ?.setBaseAndExtent(r.root, 0, r.root, r.root.childNodes.length)
    const items = (r: Rig) => r.root.querySelectorAll('li')

    it('(a) a collapsed Cut in a list item cuts its L line in one operation, no execCommand', () => {
      const before = 'a ncjw\n\n- i1 ncjw\n- i2\n\nc\n'
      const { r, fake } = start(before)
      // jsdom has no `execCommand`: a spy stands in, so a call would be seen.
      const exec = vi.fn()
      Object.defineProperty(document, 'execCommand', {
        value: exec,
        configurable: true,
      })
      // The list's first item holds a pending group; the caret is in the second.
      select(items(r)[1].firstChild as Text, 1)
      const { setData, before: pre, event } = clipboard(r, 'cut')
      expect(pre.defaultPrevented).toBe(true)
      expect(event.defaultPrevented).toBe(true)
      expect(setData).toHaveBeenCalledTimes(1)
      expect(setData).toHaveBeenCalledWith('text/plain', '- i2\n')
      expect(exec).not.toHaveBeenCalled()
      expect(fake.posts).toHaveLength(1)
      expect(applyPosts(before, fake.posts)).toBe('a ncjw\n\n- i1 ncjw\n\nc\n')
      expect(r.stats().replay.deletes).toBe(1)
      delete (document as { execCommand?: unknown }).execCommand
    })

    // S2 hand-over: Undo after a guarded Cut during the replay restores the pre-Cut bytes with one entry.
    it('Undo after a guarded Cut during the replay: one Undo entry, host and DOM back to the pre-Cut bytes', () => {
      const before = 'a ncjw\n\n- i1 ncjw\n- i2\n\nc\n'
      const { r, fake } = start(before)
      const port = r.session.historyPort()
      // The replay's own writes are no Undo entry.
      expect(port.capture()).toBeUndefined()
      const html = r.root.innerHTML
      const text = r.root.textContent
      select(items(r)[1].firstChild as Text, 1)
      const { setData } = clipboard(r, 'cut')
      expect(setData).toHaveBeenCalledWith('text/plain', '- i2\n')
      expect(applyPosts(before, fake.posts)).toBe('a ncjw\n\n- i1 ncjw\n\nc\n')
      // Exactly one entry: the Cut.
      const entry = port.capture()
      expect(entry).toBeDefined()
      expect(port.capture()).toBeUndefined()
      // The unit history's Undo: the restore, then the move goes out as a reserved history delta.
      expect(port.restore(entry as never, 'before')).toBe(true)
      expect(r.session.publishReplayHistory('undo', 1)).toBe('delta')
      expect(fake.posts.map((post) => post.command)).toEqual([
        'edit-delta',
        'replay-reserve',
        'history-delta',
      ])
      expect(applyPosts(before, fake.posts)).toBe(before)
      expect(r.root.textContent).toBe(text)
      expect(r.root.innerHTML).toBe(html)
      expect(port.capture()).toBeUndefined()
    })

    it('(a) a pending item line copies its L bytes, the target of its group', () => {
      const before = 'a\n\n- i1 ncjw\n- i2\n'
      const { r, fake } = start(before)
      select(items(r)[0].firstChild as Text, 1)
      const { setData } = clipboard(r, 'copy')
      expect(setData).toHaveBeenCalledWith('text/plain', '- i1 ncjw\n')
      expect(fake.posts).toHaveLength(0)
      expect(items(r)[0].textContent).toBe('i1 ZZZZ')
    })

    it('(b) a collapsed Cut at an element caret is refused: clipboard, document and host unchanged', () => {
      const before = 'a ncjw\n\n- i1\n- i2\n\nc\n'
      const { r, fake } = start(before)
      const html = r.root.innerHTML
      for (const [node, offset] of [
        [r.root.querySelector('ul') as Node, 1],
        [r.root, 1],
      ] as const) {
        document.getSelection()?.setBaseAndExtent(node, offset, node, offset)
        const { setData, event } = clipboard(r, 'cut')
        expect(event.defaultPrevented).toBe(true)
        expect(setData).not.toHaveBeenCalled()
      }
      expect(r.root.innerHTML).toBe(html)
      expect(fake.posts).toHaveLength(0)
      expect(r.stats().replay.clipboardRefused).toBe(2)
    })

    it('(c, D2) a root selection Cut writes all of L and deletes it to an empty model', () => {
      const before = 'a1\n\nb ncjw\n\n- i1\n- i2\n\nc1\n'
      const { r, fake } = start(before)
      selectRoot(r)
      const { setData } = clipboard(r, 'cut')
      expect(setData).toHaveBeenCalledWith('text/plain', before)
      expect(fake.posts).toHaveLength(1)
      expect(fake.posts[0].changes?.[0].oldText).toHaveLength(before.length)
      expect(applyPosts(before, fake.posts)).toBe('')
      expect(r.session.deltaPort().modelText()).toBe('')
      expect(r.root.innerHTML).toBe('<p data-block="0"></p>')
      // Nothing is left to publish: no second post.
      expect(fake.state.publisher?.publish('idle')).toBe('nothing')
      expect(fake.posts).toHaveLength(1)
    })

    it('(D2) Select All then Backspace during the replay posts one deletion of all of L', () => {
      const before = 'a1\n\nb ncjw\n\nc1\n'
      const { r, fake } = start(before)
      selectRoot(r)
      const backspace = key(r, 'Backspace')
      expect(backspace.defaultPrevented).toBe(true)
      expect(fake.posts).toHaveLength(1)
      expect(fake.posts[0].changes?.[0]).toMatchObject({ text: '' })
      expect(fake.posts[0].changes?.[0].oldText).toHaveLength(before.length)
      expect(applyPosts(before, fake.posts)).toBe('')
      expect(r.session.deltaPort().modelText()).toBe('')
      // The input of the same key is cancelled: the deletion ran once.
      const input = new InputEvent('beforeinput', {
        inputType: 'deleteContentBackward',
        cancelable: true,
        bubbles: true,
      })
      dispatchTo(r, r.root, input)
      expect(input.defaultPrevented).toBe(true)
      expect(fake.posts).toHaveLength(1)
    })

    it('(D2) the same after the last group, before the acknowledgement', async () => {
      const before = 'a1\n\nb ncjw\n\nc1\n'
      const { r, fake, done } = start(before)
      expect(await settle(r, done)).toBe(true)
      expect(r.session.replayLive()).toBe(true)
      selectRoot(r)
      key(r, 'Delete')
      expect(fake.posts).toHaveLength(1)
      expect(applyPosts(before, fake.posts)).toBe('')
      expect(r.session.deltaPort().modelText()).toBe('')
    })

    it('(d) a partial list selection (non-positional items) is refused', () => {
      const before = 'a ncjw\n\n- i1 one\n- i2 two\n'
      const { r, fake } = start(before)
      const html = r.root.innerHTML
      select(
        items(r)[0].firstChild as Text,
        2,
        items(r)[1].firstChild as Text,
        2,
      )
      const { setData, event } = clipboard(r, 'cut')
      expect(event.defaultPrevented).toBe(true)
      expect(setData).not.toHaveBeenCalled()
      expect(r.root.innerHTML).toBe(html)
      expect(fake.posts).toHaveLength(0)
      // An expanded Delete over the same selection is refused too.
      const del = key(r, 'Delete')
      expect(del.defaultPrevented).toBe(true)
      expect(r.root.innerHTML).toBe(html)
      expect(r.stats().replay.deleteRefused).toBe(1)
    })

    it('(e) escaped text: IR shows the backslash, so a range over it cuts its exact source bytes', () => {
      const before = 'x ncjw\n\na\\*b c\n'
      const { r, fake } = start(before)
      const text = r.root.querySelectorAll('p')[1]
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
      const first = walker.nextNode() as Text
      walker.nextNode()
      const star = walker.nextNode() as Text
      select(first, 0, star, 1)
      const { setData } = clipboard(r, 'cut')
      expect(setData).toHaveBeenCalledWith('text/plain', 'a\\*')
      expect(applyPosts(before, fake.posts)).toBe('x ncjw\n\nb c\n')
    })

    it('(e) a range in a unit whose rendered text is not its source is refused', () => {
      const before = 'x ncjw\n\n- a\\*b c\n'
      const { r, fake } = start(before)
      const item = items(r)[0]
      const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
      const first = walker.nextNode() as Text
      select(first, 0, first, 1)
      const { setData, event } = clipboard(r, 'cut')
      expect(event.defaultPrevented).toBe(true)
      expect(setData).not.toHaveBeenCalled()
      expect(fake.posts).toHaveLength(0)
    })

    it('(f) a positional range over a pending group: L.slice, the group dropped, one deletion', async () => {
      const before = 'a1\n\nb ncjw\n\nc1\n'
      const { r, fake, done } = start(before)
      select(paragraph(r, 0), 1, paragraph(r, 2), 1)
      const { setData } = clipboard(r, 'cut')
      expect(setData).toHaveBeenCalledWith('text/plain', '1\n\nb ncjw\n\nc')
      expect(fake.posts).toHaveLength(1)
      expect(fake.posts[0].changes?.[0].oldText).toBe('1\n\nb ncjw\n\nc')
      expect(applyPosts(before, fake.posts)).toBe('a1\n')
      expect(r.session.deltaPort().modelText()).toBe('a1\n')
      expect(fake.state.publisher?.publish('idle')).toBe('nothing')
      expect(await settle(r, done)).toBe(true)
    })

    it('(g) Copy over a root selection and over a range gives the Cut bytes and deletes nothing', () => {
      const before = 'a1\n\nb ncjw\n\nc1\n'
      const { r, fake } = start(before)
      const html = r.root.innerHTML
      selectRoot(r)
      expect(clipboard(r, 'copy').setData).toHaveBeenCalledWith(
        'text/plain',
        before,
      )
      select(paragraph(r, 0), 1, paragraph(r, 2), 1)
      expect(clipboard(r, 'copy').setData).toHaveBeenCalledWith(
        'text/plain',
        '1\n\nb ncjw\n\nc',
      )
      expect(r.root.innerHTML).toBe(html)
      expect(fake.posts).toHaveLength(0)
    })

    it('(h) a table rectangle keeps its own handlers; during the recovery the refusal comes first', () => {
      const before = '| a | b |\n| --- | --- |\n| ncjw | x |\n\nend ncjw\n'
      const { r } = start(before)
      const cell = r.root.querySelector('td') as HTMLElement
      cell.classList.add('vmde-cell-selected')
      select(cell.firstChild as Text, 0, cell.firstChild as Text, 1)
      const live = clipboard(r, 'copy')
      expect(live.before.defaultPrevented).toBe(false)
      expect(live.event.defaultPrevented).toBe(false)
      expect(r.session.recoverReplay(before, 4, 0, vi.fn())).toBe('recovering')
      const recovering = clipboard(r, 'copy')
      expect(recovering.event.defaultPrevented).toBe(true)
      expect(recovering.setData).not.toHaveBeenCalled()
    })

    it('(i) during the recovery Cut, Copy and Delete are refused', () => {
      const before = 'a1\n\nb ncjw\n\nc1\n'
      const { r, fake } = start(before)
      expect(r.session.recoverReplay(before, 4, 0, vi.fn())).toBe('recovering')
      select(paragraph(r, 0), 0, paragraph(r, 0), 2)
      for (const kind of ['cut', 'copy'] as const) {
        const { setData, event } = clipboard(r, kind)
        expect(event.defaultPrevented).toBe(true)
        expect(setData).not.toHaveBeenCalled()
      }
      expect(key(r, 'Backspace').defaultPrevented).toBe(true)
      expect(fake.posts).toHaveLength(0)
    })

    it('(i) right after completion the native handlers run; a token taken during the replay is still refused', async () => {
      const before = 'a1\n\nb ncjw\n\nc1\n'
      const { r, done } = start(before)
      expect(await settle(r, done)).toBe(true)
      r.session.onReplayAck(
        { epoch: 3, replayOp: 1, acceptedSequence: 0 },
        () => before,
      )
      expect(r.session.replayLive()).toBe(false)
      select(paragraph(r, 0), 0, paragraph(r, 0), 2)
      const after = clipboard(r, 'cut')
      expect(after.before.defaultPrevented).toBe(false)
      expect(after.event.defaultPrevented).toBe(false)
      expect(after.setData).not.toHaveBeenCalled()
    })

    it('(i) a replay that ends between beforecut and cut keeps the cancellation', async () => {
      const before = 'a1\n\nb ncjw\n\nc1\n'
      const { r, done } = start(before)
      expect(await settle(r, done)).toBe(true)
      select(paragraph(r, 0), 0, paragraph(r, 0), 2)
      const html = r.root.innerHTML
      const { setData, event } = clipboard(r, 'cut', r.root, {
        between: () =>
          r.session.onReplayAck(
            { epoch: 3, replayOp: 1, acceptedSequence: 0 },
            () => before,
          ),
      })
      expect(r.session.replayLive()).toBe(false)
      expect(event.defaultPrevented).toBe(true)
      expect(setData).not.toHaveBeenCalled()
      expect(r.root.innerHTML).toBe(html)
    })

    it('a missing before-event, unavailable clipboardData or a same-length edit between the events refuses', () => {
      const before = 'a1 two\n\nb ncjw\n\nc1\n'
      const { r, fake } = start(before)
      const html = r.root.innerHTML
      select(paragraph(r, 0), 0, paragraph(r, 0), 3)
      const missing = clipboard(r, 'cut', r.root, { before: false })
      expect(missing.event.defaultPrevented).toBe(true)
      expect(missing.setData).not.toHaveBeenCalled()
      const noData = clipboard(r, 'cut', r.root, { data: false })
      expect(noData.event.defaultPrevented).toBe(true)
      expect(r.root.innerHTML).toBe(html)
      // The same length, generation and epoch, other bytes in the selection.
      const edited = clipboard(r, 'copy', r.root, {
        between: () => {
          paragraph(r, 0).data = 'A1 two'
          select(paragraph(r, 0), 0, paragraph(r, 0), 3)
        },
      })
      expect(edited.event.defaultPrevented).toBe(true)
      expect(edited.setData).not.toHaveBeenCalled()
      expect(fake.posts).toHaveLength(0)
      expect(r.stats().replay.clipboardRefused).toBe(3)
    })

    it('a token is taken once: a second cut without its before-event is refused', () => {
      const before = 'a1 two\n\nb ncjw\n\nc1\n'
      const { r, fake } = start(before)
      select(paragraph(r, 0), 0, paragraph(r, 0), 2)
      const first = clipboard(r, 'copy')
      expect(first.setData).toHaveBeenCalledTimes(1)
      const second = clipEvent('copy')
      dispatchTo(r, r.root, second)
      expect(second.defaultPrevented).toBe(true)
      expect(fake.posts).toHaveLength(0)
    })

    it('(j) the plan succeeds and the render refuses: clipboard, DOM, model and host unchanged', () => {
      // Removing the first item of an ordered list moves its number to the next item, which a kept list
      // cannot follow: the render refuses, after `planApply` planned the window.
      const before = 'x ncjw\n\n1. a\n2. b\n'
      const { r, fake } = start(before)
      const html = r.root.innerHTML
      const text = r.session.deltaPort().modelText()
      const item = items(r)[0]
      document
        .getSelection()
        ?.setBaseAndExtent(item, 0, item, item.childNodes.length)
      const { setData, event } = clipboard(r, 'cut')
      expect(event.defaultPrevented).toBe(true)
      expect(setData).not.toHaveBeenCalled()
      expect(r.root.innerHTML).toBe(html)
      expect(r.session.deltaPort().modelText()).toBe(text)
      expect(fake.posts).toHaveLength(0)
    })
  })

  // 036 S5.2 (S5 design rev 2 section 3, review point 3): every route from the engine to the sliced
  // restore is counted by its kind.
  describe('routes to the sliced restore (S5.2)', () => {
    const zeroRoutes = {
      exactReplay: 0,
      exactPending: 0,
      unavailable: 0,
      notLive: 0,
      sv: 0,
      noHunks: 0,
      dryRun: 0,
      dirty: 0,
      startText: 0,
      supersede: 0,
      target: 0,
    }
    let sv: ReturnType<typeof createRealLute>
    beforeAll(() => {
      sv = createRealLute('sv')
    })
    const tagged = { epoch: 3, replayOp: 1, requestId: 'find-1' }
    const empty = { generation: -1, steps: [] } as never
    const routes = (r: Rig) => r.stats().replay.route

    it('counts a move with no tagged replay', () => {
      const { after, record } = recordOf('one ncjw\n')
      const r = open(after, 3, { deps: { exactHunksOf: () => record } })
      r.runFrames()
      r.session.awaitExactHistory(5)
      void r.session.historyPort().restoreSliced?.(empty, 'before')
      expect(routes(r)).toEqual({ ...zeroRoutes, exactReplay: 1 })
      expect(r.stats().replay.whole).toBe(1)
    })

    it('counts a move with no built model', () => {
      const { record } = recordOf('one ncjw\n')
      const r = rig({ deps: { exactHunksOf: () => record } })
      r.session.awaitExactHistory(5, tagged)
      void r.session.historyPort().restoreSliced?.(empty, 'before')
      expect(routes(r)).toEqual({ ...zeroRoutes, unavailable: 1 })
    })

    it('counts a move while the model is not live', () => {
      const { after, record } = recordOf('one ncjw\n')
      const r = open(after, 3, { deps: { exactHunksOf: () => record } })
      r.runFrames()
      // A rebind answer the units cannot pair turns the attached model off.
      type(r, 0, 'one ZZZZ!')
      r.session.beforeWholeTextPost(1)
      r.session.onRebind({
        command: 'rebind',
        epoch: 3,
        afterSequence: 0,
        content: '# other\n\n- shape\n',
        editSequence: 1,
      })
      expect(r.stats().state).toBe('off')
      r.session.awaitExactHistory(5, tagged)
      void r.session.historyPort().restoreSliced?.(empty, 'before')
      expect(routes(r)).toEqual({ ...zeroRoutes, notLive: 1 })
    })

    it('counts a move over the Source model', () => {
      const { after, record } = recordOf('one ncjw\n')
      const r = open(after, 3, { deps: { exactHunksOf: () => record } })
      r.runFrames()
      const port = r.session.historyPort()
      r.mode.value = 'sv'
      r.sourceRoot.innerHTML = svBlocksHtml(sv.render(after))
      r.session.onModeChange('sv')
      r.session.onEditDomComplete()
      r.runFrames()
      r.session.awaitExactHistory(5, tagged)
      void port.restoreSliced?.(empty, 'before')
      expect(routes(r)).toEqual({ ...zeroRoutes, sv: 1 })
    })

    it('counts a record with no hunks', () => {
      const r = open('one ZZZZ\n', 3, {
        deps: { exactHunksOf: () => undefined },
      })
      r.runFrames()
      r.session.awaitExactHistory(5, tagged)
      void r.session.historyPort().restoreSliced?.(empty, 'before')
      expect(routes(r)).toEqual({ ...zeroRoutes, noHunks: 1 })
    })

    it('counts typing that is not published at the key', () => {
      const { after, record } = recordOf('one ncjw\n\ntwo ncjw\n')
      const r = open(after, 3, { deps: { exactHunksOf: () => record } })
      r.runFrames()
      r.session.awaitExactHistory(5, tagged)
      type(r, 0, 'one ZZZZ!')
      void r.session.historyPort().restoreSliced?.(empty, 'before')
      expect(routes(r)).toEqual({ ...zeroRoutes, dirty: 1 })
    })

    it('counts a model text that is not the move start', () => {
      const { record } = recordOf('one ncjw\n')
      const r = open('other text\n', 3, {
        deps: { exactHunksOf: () => record },
      })
      r.runFrames()
      r.session.awaitExactHistory(5, tagged)
      void r.session.historyPort().restoreSliced?.(empty, 'before')
      expect(routes(r)).toEqual({ ...zeroRoutes, startText: 1 })
    })

    it('counts a move that cannot supersede the live replay', async () => {
      const { r, done } = start('x ncjw\n\ny ncjw\n')
      // A second Undo starts at the record end, but the logical text is already its start.
      r.session.awaitExactHistory(6, { ...tagged, replayOp: 2 })
      const again = r.session.historyPort().restoreSliced?.(empty, 'before')
      await settle(r, done)
      await settle(r, again)
      expect(routes(r)).toEqual({ ...zeroRoutes, supersede: 1 })
    })

    it('counts a record the replay target refuses', () => {
      const { after, record } = recordOf('one ncjw\n')
      // The record does not describe this text: the target is one character longer than the hunks allow.
      const wrong = {
        ...record,
        normalized: {
          ...record.normalized,
          before: `${record.normalized.before}x`,
        },
      }
      const r = open(after, 3, { deps: { exactHunksOf: () => wrong } })
      r.runFrames()
      r.session.awaitExactHistory(5, tagged)
      void r.session.historyPort().restoreSliced?.(empty, 'before')
      expect(routes(r)).toEqual({ ...zeroRoutes, target: 1 })
    })
  })

  // ---- 036 core C2 (R31.2, R32.2, R33.4): the budget owner token, `endRun` and bound recovery callbacks ----

  describe('036 core C2 budget owner and teardown', () => {
    const account = (r: Rig) => r.session.replayAccount?.()
    const LARGE = (() => {
      const blocks = Array.from(
        { length: 12 },
        (_, n) => `p${n} ${'x'.repeat(900)}`,
      )
      return {
        before: `one ncjw\n\n${blocks.join('\n\n')}\n`,
        host: `one ncjw\n\n${blocks.map((b) => b.toUpperCase()).join('\n\n')}\n`,
      }
    })()

    it('R31.2: the old replay callback after recovery opened the account leaves it open; recovery closes it', async () => {
      const { r, done } = start(LARGE.before)
      // The replay's first frame is scheduled; the host text starts a recovery before it runs.
      expect(r.frames.length).toBeGreaterThan(0)
      expect(r.session.recoverReplay(LARGE.host, 4, 0, vi.fn())).toBe(
        'recovering',
      )
      // The replay's old callback alone: it was queued first; the recovery frame is queued after it.
      r.frames.shift()?.()
      expect(account(r)?.isOpen()).toBe(true)
      expect(r.session.exactBusy()).toBe(true)
      expect(await done).toBe(false)
      drain(r)
      expect(r.session.deltaPort().modelText()).toBe(LARGE.host)
      expect(account(r)?.isOpen()).toBe(false)
      expect(account(r)?.stats().staleFinish).toBe(0)
    })

    it('R32.2: dispose before the replay frame runs closes the account at once and settles the restore once', async () => {
      const { r, fake, done } = start('one ncjw\n\ntwo ncjw\n')
      const scheduled = r.frames.length
      expect(scheduled).toBeGreaterThan(0)
      const settled = vi.fn()
      void done?.then(settled)
      r.session.dispose()
      expect(account(r)?.isOpen()).toBe(false)
      // The run's frame was cancelled.
      expect(r.cancelledFrames).toContain(scheduled)
      expect(await done).toBe(false)
      r.runFrames()
      await Promise.resolve()
      expect(settled).toHaveBeenCalledTimes(1)
      expect(fake.posts).toEqual([])
      expect(account(r)?.isOpen()).toBe(false)
    })

    it('R32.2 and R33.4: dispose during a recovery cancels its frame, settles every promise and closes the account', async () => {
      const { r, done } = start(LARGE.before)
      expect(r.session.recoverReplay(LARGE.host, 4, 0, vi.fn())).toBe(
        'recovering',
      )
      // The replay's old callback runs; the recovery frame stays queued.
      r.frames.shift()?.()
      expect(r.session.exactBusy()).toBe(true)
      const text = r.root.textContent
      const cancelled = r.cancelledFrames.length
      r.session.dispose()
      expect(r.cancelledFrames.length).toBe(cancelled + 1)
      expect(account(r)?.isOpen()).toBe(false)
      expect(await done).toBe(false)
      // A recovery callback delivered after the disposal writes nothing.
      r.runFrames()
      expect(r.root.textContent).toBe(text)
      expect(account(r)?.isOpen()).toBe(false)
    })

    it('R32.2: an old recovery callback delivered after a new recovery started does not touch the new run', () => {
      const { r, postReplay } = start(LARGE.before)
      expect(r.session.recoverReplay(LARGE.host, 4, 0, vi.fn())).toBe(
        'recovering',
      )
      const second = `${LARGE.host}tail\n`
      expect(r.session.recoverReplay(second, 5, undefined, vi.fn())).toBe(
        'recovering',
      )
      drain(r)
      expect(r.session.deltaPort().modelText()).toBe(second)
      expect(account(r)?.isOpen()).toBe(false)
      expect(account(r)?.stats().staleFinish).toBe(0)
      expect(recoveryDone(postReplay)).toHaveLength(1)
    })
  })

  // ---- 036 core C4 (R34.1, R35.1, M1): publication at observer delivery, move order, admission ----

  describe('036 core C4 publication and admission', () => {
    const delivered = () =>
      new Promise<void>((resolve) => setTimeout(resolve, 0))
    const BEFORE = 'one ncjw\n\ntwo\n\nthree ncjw\n'

    it('R34.1: a paste without input (a DOM write) posts one replay op at its observer delivery', async () => {
      const { r, fake } = start(BEFORE)
      paragraph(r, 1).data = 'two pasted'
      expect(fake.posts).toHaveLength(0)
      await delivered()
      expect(fake.posts).toHaveLength(1)
      expect(applyPosts(BEFORE, fake.posts)).toBe(
        'one ncjw\n\ntwo pasted\n\nthree ncjw\n',
      )
    })

    it('R34.1: typing and a paste in one task are one op', async () => {
      const { r, fake } = start(BEFORE)
      paragraph(r, 1).data = 'two!'
      paragraph(r, 1).data = 'two! and more'
      await delivered()
      expect(fake.posts).toHaveLength(1)
      expect(applyPosts(BEFORE, fake.posts)).toBe(
        'one ncjw\n\ntwo! and more\n\nthree ncjw\n',
      )
    })

    it('R34.1: the replay quiet writes post nothing at delivery', async () => {
      const { r, fake, done } = start(BEFORE)
      r.runFrames()
      await delivered()
      expect(fake.posts).toHaveLength(0)
      await settle(r, done)
    })

    it('R35.1: type, then a reserved Undo in one task: typing op, reservation, history delta with the restoration', async () => {
      const { r, fake } = start(BEFORE)
      paragraph(r, 1).data = 'two!'
      // The transition wrapper's drain, then the unit engine's restoration and the reserved publication.
      r.session.drainReplayInput()
      paragraph(r, 1).data = 'two'
      expect(r.session.publishReplayHistory('undo', 1)).toBe('delta')
      await delivered()
      expect(fake.posts.map((p) => p.command)).toEqual([
        'edit-delta',
        'replay-reserve',
        'history-delta',
      ])
      expect(fake.posts[2].changes?.length).toBeGreaterThan(0)
      expect(applyPosts(BEFORE, fake.posts)).toBe(BEFORE)
    })

    it('R35.1: the reserved-Undo probe: a restoration alone goes into the history delta, no edit delta', async () => {
      const { r, fake } = start(BEFORE)
      paragraph(r, 1).data = 'two!'
      await delivered()
      expect(fake.posts).toHaveLength(1)
      r.session.drainReplayInput()
      paragraph(r, 1).data = 'two'
      r.session.publishReplayHistory('undo', 1)
      await delivered()
      expect(fake.posts.map((p) => p.command)).toEqual([
        'edit-delta',
        'replay-reserve',
        'history-delta',
      ])
      expect(fake.posts[2].changes?.length).toBeGreaterThan(0)
    })

    it('R35.1 real restore: type, delivery sync, root change, reserved Undo through historyPort()', async () => {
      const { r, fake } = start(BEFORE)
      const port = r.session.historyPort()
      paragraph(r, 1).data = 'two!'
      await delivered()
      expect(fake.posts).toHaveLength(1)
      const block = r.root.querySelectorAll('p')[1]
      block.replaceWith(block.cloneNode(true))
      r.session.drainReplayInput()
      const capture = port.capture()
      expect(capture).toBeDefined()
      expect(port.restore(capture as never, 'before')).toBe(true)
      expect(r.session.publishReplayHistory('undo', 1)).toBe('delta')
      await delivered()
      expect(fake.posts.map((p) => p.command)).toEqual([
        'edit-delta',
        'replay-reserve',
        'history-delta',
      ])
      expect(fake.posts[2].changes?.length).toBeGreaterThan(0)
      expect(applyPosts(BEFORE, fake.posts)).toBe(BEFORE)
      await delivered()
      expect(fake.posts).toHaveLength(3)
    })

    it('K12: a reentrant move refused by the wrapper is counted', () => {
      const { r } = start(BEFORE)
      r.session.refuseReplayReentry()
      expect(r.stats().replay.replayMoveReentry).toBe(1)
    })

    it('admit-after-endpoint-prepare: an insertion into a pending group is prepared, then admitted, and posts once', async () => {
      const { r, fake } = start(BEFORE)
      const text = paragraph(r, 0)
      // Before the preparation the unit holds a pending group: admission would refuse it.
      expect(
        r.session.replayAcceptsInput({
          startContainer: text,
          endContainer: text,
        }),
      ).toBe(false)
      document.getSelection()?.collapse(text, 2)
      const event = new Event('beforeinput', { cancelable: true })
      r.session.beforeReplayInput(event)
      expect(event.defaultPrevented).toBe(false)
      expect(r.stats().replay.replayInputRefused).toBe(0)
      const prepared = paragraph(r, 0)
      prepared.data = `${prepared.data}X`
      await delivered()
      expect(fake.posts).toHaveLength(1)
      expect(applyPosts(BEFORE, fake.posts)).toBe(
        'one ncjwX\n\ntwo\n\nthree ncjw\n',
      )
    })

    it('untranslatable-input-refused: an input whose unit keeps a pending group is refused before mutation', () => {
      const { r, fake } = start(BEFORE)
      const text = paragraph(r, 2)
      // A forced translation failure: the endpoint render is skipped, so the group stays pending.
      expect(
        r.session.replayAcceptsInput({
          startContainer: text,
          endContainer: text,
        }),
      ).toBe(false)
      const event = new Event('beforeinput', { cancelable: true })
      r.session.refuseReplayInput(event)
      expect(event.defaultPrevented).toBe(true)
      expect(r.stats().replay.replayInputRefused).toBe(1)
      expect(fake.posts).toHaveLength(0)
      expect(paragraph(r, 2).data).toBe('three ZZZZ')
    })

    it('stale-abandon-typing-refused: after an abandon without the logical text, every input is refused', async () => {
      forceMismatch.value = true
      try {
        const { r, done } = start(BEFORE)
        expect(await settle(r, done)).toBe(false)
        const text = paragraph(r, 1)
        expect(r.session.editsRefused()).toBe(true)
        expect(
          r.session.replayAcceptsInput({
            startContainer: text,
            endContainer: text,
          }),
        ).toBe(false)
      } finally {
        forceMismatch.value = false
      }
    })

    it('a recovery refuses input; outside a replay everything is admitted', () => {
      const plain = open()
      const p = paragraph(plain, 0)
      expect(
        plain.session.replayAcceptsInput({
          startContainer: p,
          endContainer: p,
        }),
      ).toBe(true)
      const { r } = start(BEFORE)
      expect(r.session.recoverReplay(BEFORE, 4, 0, vi.fn())).toBe('recovering')
      const q = paragraph(r, 1)
      expect(
        r.session.replayAcceptsInput({ startContainer: q, endContainer: q }),
      ).toBe(false)
    })
  })

  // ---- 036 core C5 (M2, R3.1, R3.2, R4.2, R5.1): late writes during a recovery, pending reapplication ----

  describe('036 core C5 recovery writes', () => {
    const blocks = Array.from(
      { length: 12 },
      (_, n) => `p${n} ${'x'.repeat(900)}`,
    )
    const BEFORE = `one ncjw\n\n${blocks.join('\n\n')}\n`
    // The rendered text before the replay is the Find result; the host changes blocks 5 and 11 only.
    const R = BEFORE.replace('ncjw', 'ZZZZ')
    const upper = (n: number) => R.replace(blocks[n], blocks[n].toUpperCase())
    const HOST = upper(5).replace(blocks[11], blocks[11].toUpperCase())
    /** The text node of block `n` (the first paragraph is `one ...`). */
    const block = (r: Rig, n: number) =>
      r.root.querySelectorAll('p')[n + 1].firstChild as Text
    /** The posts that carry the late write's `!` (a reapplied op names no operation: never journaled). */
    const bang = (fake: {
      posts: Array<{ changes?: Array<{ text: string }> }>
    }) => fake.posts.filter((p) => p.changes?.some((c) => c.text.includes('!')))
    const oneFrame = (r: Rig) => {
      for (const cb of r.frames.splice(0)) cb()
    }
    function recovering(whole: (text: string) => void = vi.fn()) {
      const started = start(BEFORE)
      expect(started.r.session.recoverReplay(HOST, 4, 0, whole)).toBe(
        'recovering',
      )
      return started
    }
    const settleAll = async (r: Rig) => {
      for (let n = 0; n < 60 && r.frames.length > 0; n++) {
        oneFrame(r)
        await Promise.resolve()
        await Promise.resolve()
        // R2.2 invariant (`recovery-never-idle-busy`): never busy with nothing scheduled.
        expect(!r.session.exactBusy() || r.frames.length > 0).toBe(true)
      }
    }

    it('late-ime-write-whole-recovery (path 1): a write in the rendered prefix posts against the host bytes and stays', async () => {
      const { r, fake, postReplay } = recovering()
      block(r, 0).data = `${blocks[0]}!`
      await settleAll(r)
      const posted = fake.posts.filter((p) => p.epoch === 4)
      expect(posted).toHaveLength(1)
      const expected = HOST.replace(blocks[0], `${blocks[0]}!`)
      expect(applyPosts(HOST, posted)).toBe(expected)
      expect(r.session.deltaPort().modelText()).toBe(expected)
      expect(block(r, 0).data).toBe(`${blocks[0]}!`)
      expect(recoveryDone(postReplay)).toHaveLength(1)
    })

    it('late-ime-write-unrendered-region (path 2): a proven write ahead of the render is reapplied after recovery-done', async () => {
      const { r, fake, postReplay } = recovering()
      block(r, 8).data = `${blocks[8]}!`
      await settleAll(r)
      expect(recoveryDone(postReplay)).toHaveLength(1)
      const reapplied = bang(fake as never)
      expect(reapplied).toHaveLength(1)
      expect(r.session.deltaPort().modelText()).toBe(
        HOST.replace(blocks[8], `${blocks[8]}!`),
      )
      expect(r.stats().replay.recovery.lateWriteUnpublished).toBe(0)
    })

    /** A write across two units, one in the prefix and one ahead: no path places it. */
    const unplaceable = (r: Rig) => {
      block(r, 1).data = `${blocks[1]}?`
      block(r, 9).data = `${blocks[9]}?`
    }

    it('late-ime-write-unpublishable (path 3): an unplaceable write ends the recovery whole, counted, nothing busy', async () => {
      const whole = vi.fn()
      const { r, postReplay } = recovering(whole)
      unplaceable(r)
      await settleAll(r)
      expect(whole).toHaveBeenCalledOnce()
      expect(r.stats().replay.recovery.lateWriteUnpublished).toBe(1)
      expect(r.session.replayAccount?.().isOpen()).toBe(false)
      // recovery-done waits for the rebuilt model (R3.2).
      expect(recoveryDone(postReplay)).toHaveLength(0)
    })

    it('late-ime-write-prefix-then-whole (R3.1): the whole render receives the spliced target', async () => {
      const whole = vi.fn()
      const { r } = recovering(whole)
      // One atomic per progress frame from now on (L1), so the recovery spans frames.
      r.session.noteInput()
      block(r, 0).data = `${blocks[0]}!`
      oneFrame(r)
      unplaceable(r)
      await settleAll(r)
      expect(whole).toHaveBeenCalledOnce()
      expect(whole.mock.calls[0][0]).toBe(
        HOST.replace(blocks[0], `${blocks[0]}!`),
      )
    })

    /** A path-2 capture, then a whole fallback; returns the rig and the whole renderer's target. */
    async function pathTwoThenWhole() {
      const targets: string[] = []
      const started = recovering((text) => targets.push(text))
      const { r } = started
      r.session.noteInput()
      block(r, 8).data = `${blocks[8]}!`
      oneFrame(r)
      unplaceable(r)
      await settleAll(r)
      expect(targets).toHaveLength(1)
      return { ...started, target: targets[0] }
    }
    const renderWhole = (r: Rig, text: string) => {
      r.render(text)
      r.session.onHostText(text, 4)
    }

    it('path2-whole-fallback-reapplies: after the rebuild the kept op posts as recoveryOf, then recovery-done', async () => {
      const { r, fake, postReplay, target } = await pathTwoThenWhole()
      expect(target).toBe(HOST)
      renderWhole(r, target)
      expect(recoveryDone(postReplay)).toHaveLength(0)
      r.runFrames()
      const reapplied = bang(fake as never)
      expect(reapplied).toHaveLength(1)
      expect(applyPosts(HOST, reapplied as never)).toBe(
        HOST.replace(blocks[8], `${blocks[8]}!`),
      )
      expect(recoveryDone(postReplay)).toHaveLength(1)
    })

    it('path2-host-changed-unit: a newer host text changed the unit: counted, zero posts for it, recovery-done once', async () => {
      const { r, fake, postReplay } = await pathTwoThenWhole()
      const changed = HOST.replace(blocks[8], 'p8 host')
      renderWhole(r, changed)
      r.session.onHostText(changed, 5)
      r.runFrames()
      expect(bang(fake as never)).toHaveLength(0)
      expect(recoveryDone(postReplay)).toHaveLength(1)
      expect(r.stats().replay.recovery.lateWriteUnpublished).toBe(2)
    })

    it('pending-reapply-survives-dispose: disposal before the rebuild posts the provable op once, then recovery-done', async () => {
      const { r, fake, postReplay, target } = await pathTwoThenWhole()
      renderWhole(r, target)
      const before = fake.posts.length
      r.session.dispose()
      const posted = fake.posts.slice(before).filter((p) => p.epoch === 4)
      expect(posted).toHaveLength(1)
      expect(applyPosts(HOST, posted)).toBe(
        HOST.replace(blocks[8], `${blocks[8]}!`),
      )
      expect(recoveryDone(postReplay)).toHaveLength(1)
    })

    it('pending-reapply-dispose-host-changed: the host changed the unit: counted, zero posts for it, recovery-done once', async () => {
      // The host also changes block 8, where the late write lands.
      const host8 = HOST.replace(blocks[8], blocks[8].toUpperCase())
      const targets: string[] = []
      const started = start(BEFORE)
      const { r, fake, postReplay } = started
      expect(
        r.session.recoverReplay(host8, 4, 0, (text) => targets.push(text)),
      ).toBe('recovering')
      r.session.noteInput()
      block(r, 8).data = `${blocks[8]}!`
      oneFrame(r)
      unplaceable(r)
      await settleAll(r)
      expect(targets).toEqual([host8])
      renderWhole(r, host8)
      const unpublished = r.stats().replay.recovery.lateWriteUnpublished
      const before = fake.posts.length
      r.session.dispose()
      expect(bang(fake as never)).toHaveLength(0)
      expect(fake.posts.slice(before)).toHaveLength(0)
      expect(recoveryDone(postReplay)).toHaveLength(1)
      expect(unpublished).toBe(1)
    })

    it('pending-reapply-dispose-dom-incomplete (Vitest form): disposal before the whole render posts only host-proven bytes, once', async () => {
      // The session has no flag for an unfinished setValue; the disposal build proves against the host text.
      const { r, fake, postReplay } = await pathTwoThenWhole()
      const before = fake.posts.length
      r.session.dispose()
      const posted = fake.posts.slice(before)
      expect(posted.length).toBeLessThanOrEqual(1)
      if (posted.length === 1)
        expect(applyPosts(HOST, posted)).toBe(
          HOST.replace(blocks[8], `${blocks[8]}!`),
        )
      expect(recoveryDone(postReplay)).toHaveLength(1)
    })

    it('pending-reapply-two-ops: two provable ops in one unit, disposed: both post, in order, against the advancing target', async () => {
      const targets: string[] = []
      const started = recovering((text) => targets.push(text))
      const { r, fake, postReplay } = started
      r.session.noteInput()
      block(r, 8).data = `${blocks[8]}!`
      oneFrame(r)
      block(r, 8).data = `${blocks[8]}!?`
      oneFrame(r)
      unplaceable(r)
      await settleAll(r)
      expect(targets).toEqual([HOST])
      renderWhole(r, HOST)
      const before = fake.posts.length
      r.session.dispose()
      const posted = fake.posts.slice(before).filter((p) => p.epoch === 4)
      expect(posted).toHaveLength(2)
      expect(applyPosts(HOST, posted.slice(0, 1))).toBe(
        HOST.replace(blocks[8], `${blocks[8]}!`),
      )
      expect(applyPosts(HOST, posted)).toBe(
        HOST.replace(blocks[8], `${blocks[8]}!?`),
      )
      expect(recoveryDone(postReplay)).toHaveLength(1)
    })

    it('pending-reapply-substring-elsewhere: the host changed the unit; its old text is only a substring of another paragraph: zero posts, counted', async () => {
      // Block 3 holds block 8's bytes as a substring, so a substring search would place the write there.
      const twin = [...blocks]
      twin[3] = `${twin[8]} tail`
      const before2 = `one ncjw\n\n${twin.join('\n\n')}\n`
      const host2 = before2
        .replace('ncjw', 'ZZZZ')
        .replace(`\n${twin[8]}\n`, `\n${twin[8].toUpperCase()}\n`)
      const targets: string[] = []
      const { r, fake, postReplay } = start(before2)
      expect(
        r.session.recoverReplay(host2, 4, 0, (text) => targets.push(text)),
      ).toBe('recovering')
      r.session.noteInput()
      block(r, 8).data = `${twin[8]}!`
      oneFrame(r)
      unplaceable(r)
      await settleAll(r)
      expect(targets).toEqual([host2])
      renderWhole(r, host2)
      // The rebuild of the whole-rendered DOM disposes of the op (the host changed its unit).
      const unpublished = r.stats().replay.recovery.lateWriteUnpublished
      const before = fake.posts.length
      r.session.dispose()
      expect(fake.posts.slice(before)).toHaveLength(0)
      expect(bang(fake as never)).toHaveLength(0)
      expect(unpublished).toBe(1)
      // The other paragraph keeps its bytes.
      expect(block(r, 3).data).toBe(twin[3])
      expect(recoveryDone(postReplay)).toHaveLength(1)
    })
  })

  // ---- 036 core C5 (R33.2, R34.3, R35.3): IME during a replay ----
  describe('036 core C5 IME', () => {
    const startComposition = (r: Rig, target: Node) => {
      target.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true }),
      )
      r.session.beforeReplayInput(new Event('compositionstart'))
      r.composing.value = true
    }
    // The editor's own lock is still set when the window's listener sees the end (the bubble phase runs
    // last in the browser, but the session must not depend on that).
    const endComposition = (r: Rig, target: Node, data: string) => {
      target.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data }),
      )
      r.composing.value = false
    }

    it('ime-commit: the committed DOM bytes post as one replay op at compositionend', () => {
      const before = 'x ncjw\n\nz\n'
      const { r, fake, postReplay } = start(before)
      select(paragraph(r, 1), 1)
      startComposition(r, paragraph(r, 1))
      paragraph(r, 1).data = 'zあ'
      expect(fake.posts).toHaveLength(0)
      endComposition(r, paragraph(r, 1), 'あ')
      expect(fake.posts).toHaveLength(1)
      expect(applyPosts(before, fake.posts)).toBe('x ncjw\n\nzあ\n')
      expect(postReplay).not.toHaveBeenCalled()
    })

    it('ime-trailing-space: the posted bytes are the serialized text, not the event data', () => {
      const before = 'x ncjw\n\nz\n'
      const { r, fake } = start(before)
      select(paragraph(r, 1), 1)
      startComposition(r, paragraph(r, 1))
      // The IME reports a trailing space; the DOM holds a no-break space, as the browser writes it.
      paragraph(r, 1).data = 'zあ\u00a0'
      endComposition(r, paragraph(r, 1), 'あ ')
      expect(fake.posts).toHaveLength(1)
      const posted = applyPosts(before, fake.posts)
      expect(posted).toBe(r.session.replayLogicalText())
      expect(posted).not.toBe('x ncjw\n\nzあ \n')
    })

    it('ime-cancel over a pending group: zero ops, the group renders later with exact bytes', async () => {
      const before = 'a\n\nb ncjw\n\nc\n'
      const { r, fake, done } = start(before)
      select(paragraph(r, 0), 0, paragraph(r, 2), 1)
      startComposition(r, paragraph(r, 0))
      // Only the endpoints render: the contained group is still pending.
      expect(paragraphText(r, 1)).toBe('b ZZZZ')
      endComposition(r, paragraph(r, 0), '')
      expect(fake.posts).toHaveLength(0)
      expect(await settle(r, done)).toBe(true)
      expect(paragraphText(r, 1)).toBe('b ncjw')
      expect(fake.posts).toHaveLength(0)
    })

    it('ime-identical-rendered commit over a pending group posts the logical replacement', async () => {
      const before = 'a\n\nb ncjw\n\nc\n'
      const { r, fake, done } = start(before)
      select(paragraph(r, 0), 0, paragraph(r, 2), 1)
      startComposition(r, paragraph(r, 0))
      endComposition(r, paragraph(r, 0), 'a\n\nb ZZZZ\n\nc')
      expect(fake.posts).toHaveLength(1)
      expect(applyPosts(before, fake.posts)).toBe('a\n\nb ZZZZ\n\nc\n')
      await settle(r, done)
      expect(paragraphText(r, 1)).toBe('b ZZZZ')
    })

    it('ime-update-before-end: the update is deferred, the old-epoch op posts first, then the update once', () => {
      const before = 'x ncjw\n\nz\n'
      const { r, fake } = start(before)
      select(paragraph(r, 1), 1)
      startComposition(r, paragraph(r, 1))
      paragraph(r, 1).data = 'zあ'
      const msg = { command: 'update', epoch: 4 }
      const postsAtDelivery: number[] = []
      const deliver = vi.fn((m: object) => {
        postsAtDelivery.push(fake.posts.length)
        // A delivered update is never queued again.
        expect(r.session.deferUpdateForComposition?.(m, deliver)).toBe(false)
      })
      expect(r.session.deferUpdateForComposition?.(msg, deliver)).toBe(true)
      expect(deliver).not.toHaveBeenCalled()
      expect(fake.posts).toHaveLength(0)
      endComposition(r, paragraph(r, 1), 'あ')
      expect(deliver).toHaveBeenCalledOnce()
      expect(deliver.mock.calls[0][0]).toBe(msg)
      expect(postsAtDelivery).toEqual([1])
      expect(r.stats().replay.compositionForced).toBe(0)
    })

    it('ime-no-defer outside a replay or without a composition', () => {
      const r = open('a\n\nb\n')
      const deliver = vi.fn()
      expect(r.session.deferUpdateForComposition?.({}, deliver)).toBe(false)
      paragraph(r, 0).dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true }),
      )
      expect(r.session.deferUpdateForComposition?.({}, deliver)).toBe(false)
    })

    const clock = { value: 0 }
    const causes: Array<[string, (r: Rig) => void]> = [
      ['blur', (r) => r.root.dispatchEvent(new FocusEvent('blur'))],
      [
        'hidden',
        () => {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'hidden',
          })
          try {
            document.dispatchEvent(new Event('visibilitychange'))
          } finally {
            delete (document as unknown as Record<string, unknown>)
              .visibilityState
          }
        },
      ],
      ['pagehide', () => window.dispatchEvent(new Event('pagehide'))],
      ['mode switch', (r) => r.session.onModeChange('sv')],
      [
        'pointerdown outside',
        (r) =>
          paragraph(r, 0).dispatchEvent(
            new Event('pointerdown', { bubbles: true }),
          ),
      ],
      ['the 5 s timer', (r) => r.timers[r.timers.length - 1]()],
      [
        'resume after 5 s',
        () => {
          clock.value = 6000
          window.dispatchEvent(new Event('focus'))
        },
      ],
    ]
    for (const [cause, trigger] of causes)
      it(`ime-release by ${cause}: released once, the late compositionend releases nothing`, () => {
        clock.value = 0
        const before = 'x ncjw\n\nz\n'
        const { r, fake } = start(before, { deps: { now: () => clock.value } })
        select(paragraph(r, 1), 1)
        startComposition(r, paragraph(r, 1))
        paragraph(r, 1).data = 'zあ'
        const deliver = vi.fn()
        expect(r.session.deferUpdateForComposition?.({}, deliver)).toBe(true)
        const forced = r.stats().replay.compositionForced
        trigger(r)
        expect(deliver).toHaveBeenCalledOnce()
        const posts = fake.posts.length
        if (cause !== 'mode switch') {
          expect(r.stats().replay.compositionForced).toBe(forced + 1)
          // The mixed rule: the DOM's bytes at the release post in the old epoch.
          expect(applyPosts(before, fake.posts)).toBe('x ncjw\n\nzあ\n')
        }
        endComposition(r, paragraph(r, 1), 'あ')
        expect(deliver).toHaveBeenCalledOnce()
        expect(fake.posts).toHaveLength(posts)
      })

    it('ime-resume before 5 s releases nothing', () => {
      clock.value = 0
      const { r } = start('x ncjw\n\nz\n', {
        deps: { now: () => clock.value },
      })
      select(paragraph(r, 1), 1)
      startComposition(r, paragraph(r, 1))
      const deliver = vi.fn()
      r.session.deferUpdateForComposition?.({}, deliver)
      clock.value = 4000
      window.dispatchEvent(new Event('focus'))
      expect(deliver).not.toHaveBeenCalled()
    })

    it('ime-late final input after a forced release is absorbed in the current epoch', () => {
      const before = 'x ncjw\n\nz\n'
      const { r, fake } = start(before)
      select(paragraph(r, 1), 1)
      startComposition(r, paragraph(r, 1))
      r.root.dispatchEvent(new FocusEvent('blur'))
      // The IME's last write after the release, then its native end.
      paragraph(r, 1).data = 'zあ'
      endComposition(r, paragraph(r, 1), 'あ')
      expect(fake.state.publisher?.publish('idle')).toBe('delta')
      expect(applyPosts(before, fake.posts)).toBe('x ncjw\n\nzあ\n')
    })

    it('ime-save-wake: a Save during a composition with two queued updates wakes once, after both', async () => {
      const { r } = start('x ncjw\n\nz\n')
      select(paragraph(r, 1), 1)
      startComposition(r, paragraph(r, 1))
      const order: string[] = []
      r.session.onSaveWake(() => order.push('wake'))
      expect(r.session.saveBlocked()).toBe(true)
      r.session.deferUpdateForComposition?.({}, () => order.push('u1'))
      r.session.deferUpdateForComposition?.({}, () => order.push('u2'))
      endComposition(r, paragraph(r, 1), '')
      expect(order).toEqual(['u1', 'u2'])
      await Promise.resolve()
      expect(order).toEqual(['u1', 'u2', 'wake'])
    })
  })

  // ---- 036 core C10 (R2.2, T6a): the passive replay-end signal ----
  describe('036 core C10 replay-end-e2e', () => {
    const endSignal = () =>
      (window as unknown as Record<string, unknown>).__vmdeE2EReplayEnd
    // Earlier tests' completed replays leave the signal on the shared window.
    const clearSignal = () => {
      delete (window as unknown as Record<string, unknown>).__vmdeE2EReplayEnd
    }
    beforeEach(clearSignal)
    afterEach(clearSignal)

    it('replay-end-e2e: a completed run writes its own sequence once', async () => {
      const { r, done } = start('x ncjw\n\ny ncjw\n')
      expect(endSignal()).toBeUndefined()
      expect(await settle(r, done)).toBe(true)
      expect(endSignal()).toEqual({ sequence: 5, at: 0 })
    })

    it('replay-end-e2e: an abandoned or superseded run writes nothing', async () => {
      const { r, done } = start('x ncjw\n\ny ncjw\n')
      // A host text ends the replay before its groups rendered (the run stops, not ok).
      r.session.onHostText('x ncjw\n\ny ncjw\n', 4)
      await settle(r, done)
      expect(endSignal()).toBeUndefined()
    })

    it('replay-end-e2e: with e2e false no property is defined', async () => {
      const { r, done } = start('x ncjw\n\ny ncjw\n', { deps: { e2e: false } })
      expect(await settle(r, done)).toBe(true)
      expect(
        Object.hasOwn(window as unknown as object, '__vmdeE2EReplayEnd'),
      ).toBe(false)
    })
  })

  // ---- 036 core C6 (S1, S2, R2.4, R33.3): Save during a replay ----
  describe('036 core C6 Save', () => {
    it('ownership token: set by the replay, kept clean, ended by a resync (which marks the Save unproven)', () => {
      const { r } = start('x ncjw\n\nz\n')
      expect(r.session.ownsHostForSave()).toBe(true)
      expect(r.session.saveBlocked()).toBe(false)
      const mark = r.session.saveProofMark()
      r.session.onHostText('x ncjw\n\nz\n', 4)
      expect(r.session.ownsHostForSave()).toBe(false)
      expect(r.session.saveProofMark()).toBe(mark + 1)
    })

    it('outside a replay: no token, nothing held (Task 196 path unchanged)', () => {
      const r = open('a\n\nb\n')
      expect(r.session.ownsHostForSave()).toBe(false)
      paragraph(r, 0).data = 'a!'
      expect(r.session.saveBlocked()).toBe(false)
    })

    it('a plain exact post (no replay operation) owns nothing', () => {
      const r = open('a\n\nb\n')
      r.session.awaitExactHistory(5)
      expect(r.session.ownsHostForSave()).toBe(false)
    })

    it('held while the replay DOM holds unpublished typing; free once it is published', () => {
      const { r, fake } = start('x ncjw\n\nz\n')
      paragraph(r, 1).data = 'z!'
      expect(r.session.saveBlocked()).toBe(true)
      expect(fake.state.publisher?.publish('flush')).toBe('delta')
      expect(r.session.saveBlocked()).toBe(false)
    })

    it('held during a composition in the replay', () => {
      const { r } = start('x ncjw\n\nz\n')
      select(paragraph(r, 1), 1)
      paragraph(r, 1).dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true }),
      )
      expect(r.session.saveBlocked()).toBe(true)
    })

    it('a failed absorb publishes fallback, never delta or nothing, and marks the Save unproven', () => {
      const { r, fake } = start('x ncjw\n\nz\n')
      const mark = r.session.saveProofMark()
      paragraph(r, 1).data = 'z!'
      // The model no longer serves the shown mode: the absorb cannot reach the logical text.
      r.mode.value = 'wysiwyg'
      expect(fake.state.publisher?.publish('flush')).toBe('fallback')
      expect(r.session.saveProofMark()).toBeGreaterThan(mark)
    })

    for (const [name, trigger] of [
      [
        'an ordinary rebind answer',
        (r: Rig) =>
          r.session.onRebind({
            command: 'rebind',
            epoch: 3,
            afterSequence: 0,
            content: 'x\n',
          } as never),
      ],
      [
        'a host write outcome',
        (r: Rig) =>
          r.session.onHostWriteOutcome({ status: 'refused' } as never),
      ],
      ['a host write end', (r: Rig) => r.session.onHostWriteEnded()],
      ['a mode change', (r: Rig) => r.session.onModeChange('sv')],
      ['a resync update', (r: Rig) => r.session.onHostText('y\n', 4)],
    ] as const)
      it(`wakes the Save waiters at ${name}, once per task`, async () => {
        const { r } = start('x ncjw\n\nz\n')
        const wake = vi.fn()
        r.session.onSaveWake(wake)
        trigger(r)
        trigger(r)
        expect(wake).not.toHaveBeenCalled()
        await Promise.resolve()
        expect(wake).toHaveBeenCalledOnce()
      })

    it('wakes the Save waiters at recovery-done', async () => {
      const { r, postReplay } = start('x ncjw\n\nz\n')
      const wake = vi.fn()
      r.session.onSaveWake(wake)
      expect(r.session.recoverReplay('x ncjw\n\nz\n', 4, 0, vi.fn())).toBe(
        'recovering',
      )
      for (let n = 0; n < 20 && r.frames.length > 0; n++) {
        r.runFrames()
        await Promise.resolve()
      }
      expect(recoveryDone(postReplay)).toHaveLength(1)
      expect(wake).toHaveBeenCalled()
      expect(r.session.saveBlocked()).toBe(false)
    })
  })

  // ---- 036 core C3 (L1, R31.2, R3.1): the replay yields the frame after an input ----

  describe('036 core C3 replay yield', () => {
    const SIX = Array.from({ length: 6 }, (_, n) => `p${n} ncjw`).join('\n\n')
    const stats = (r: Rig) => r.stats().replay
    const oneFrame = (r: Rig) => {
      const batch = r.frames.splice(0)
      for (const cb of batch) cb()
    }

    it('skip branch: an input makes the next frame skip with no replay work and no beginFrame', () => {
      // Each clock read costs 4 ms, so a frame packs two atomics; the first renders the caret group.
      let t = 0
      const { r } = start(`${SIX}\n`, { deps: { now: () => (t += 4) } })
      oneFrame(r)
      expect(stats(r).frames).toBe(1)
      const atomics = stats(r).atomics
      r.session.noteInput()
      const account = r.session.replayAccount?.()
      const begin = vi.spyOn(account as never, 'beginFrame')
      oneFrame(r)
      expect(stats(r).yielded).toBe(1)
      expect(stats(r).frames).toBe(1)
      expect(stats(r).atomics).toBe(atomics)
      expect(begin).not.toHaveBeenCalled()
      expect(account?.isOpen()).toBe(true)
      // The next frame makes progress.
      oneFrame(r)
      expect(stats(r).frames).toBe(2)
      expect(stats(r).atomics).toBeGreaterThan(atomics)
    })

    it('alternation: an input before every frame gives yielded <= frames + 1 and frames <= atomics, and the replay ends', async () => {
      const { r, done } = start(`${SIX}\n`)
      for (let n = 0; n < 60 && r.frames.length > 0; n++) {
        r.session.noteInput()
        oneFrame(r)
        await Promise.resolve()
      }
      expect(await done).toBe(true)
      const { yielded, frames, atomics } = stats(r)
      expect(yielded).toBeGreaterThan(0)
      expect(yielded).toBeLessThanOrEqual(frames + 1)
      expect(frames).toBeLessThanOrEqual(atomics)
      // 2A + 1 bound over the run's eligible callbacks.
      expect(frames + yielded).toBeLessThanOrEqual(2 * atomics + 1)
    })

    it('one atomic per progress frame while the last input is under 150 ms old', async () => {
      const clock = { t: 0 }
      const { r, done } = start(`${SIX}\n`, {
        deps: { now: () => (clock.t += 4) },
      })
      // The caret group and its neighbours render first (no input yet).
      oneFrame(r)
      const first = stats(r).atomics
      expect(first).toBeGreaterThan(1)
      r.session.noteInput()
      oneFrame(r)
      expect(stats(r).yielded).toBe(1)
      oneFrame(r)
      expect(stats(r).atomics).toBe(first + 1)
      oneFrame(r)
      expect(stats(r).atomics).toBe(first + 2)
      await settle(r, done)
    })

    it('caret group: a skip frame renders the pending caret group charged, and counts as progress', async () => {
      const { r, done } = start(`${SIX}\n`, {
        select: (rig) =>
          document.getSelection()?.collapse(paragraph(rig, 4), 2),
      })
      r.session.noteInput()
      oneFrame(r)
      expect(stats(r).yielded).toBe(0)
      expect(stats(r).frames).toBe(1)
      expect(stats(r).atomics).toBe(1)
      // The Undo writes the group's old bytes back.
      expect(paragraphText(r, 4)).toBe('p4 ncjw')
      expect(await settle(r, done)).toBe(true)
    })

    it('closure: the account closes in the frame of the last atomic', async () => {
      const { r, done } = start(`${SIX}\n`)
      const account = r.session.replayAccount?.()
      let frames = 0
      while (r.frames.length > 0 && stats(r).atomics < 6) {
        oneFrame(r)
        frames++
      }
      expect(stats(r).atomics).toBe(6)
      expect(account?.isOpen()).toBe(false)
      expect(frames).toBeGreaterThan(0)
      expect(await done).toBe(true)
    })

    it('the e2e first-slice hold runs no replay work until released; the forced busy flag holds exactBusy', async () => {
      const win = window as unknown as {
        __vmdeE2EReplayHold?: boolean
        __vmdeE2EForceBusy?: boolean
      }
      win.__vmdeE2EReplayHold = true
      try {
        const { r, done } = start(`${SIX}\n`)
        for (let n = 0; n < 5; n++) oneFrame(r)
        expect(stats(r).atomics).toBe(0)
        expect(stats(r).frames).toBe(0)
        expect(r.session.replayAccount?.().isOpen()).toBe(true)
        delete win.__vmdeE2EReplayHold
        expect(await settle(r, done)).toBe(true)
        const plain = open()
        expect(plain.session.exactBusy()).toBe(false)
        win.__vmdeE2EForceBusy = true
        expect(plain.session.exactBusy()).toBe(true)
        expect(plain.session.replayLive()).toBe(false)
      } finally {
        delete win.__vmdeE2EReplayHold
        delete win.__vmdeE2EForceBusy
      }
    })

    it('a recovery yields to an input once, then makes progress', () => {
      const blocks = Array.from(
        { length: 12 },
        (_, n) => `p${n} ${'x'.repeat(900)}`,
      )
      const { r } = start(`one ncjw\n\n${blocks.join('\n\n')}\n`)
      const host = `one ncjw\n\n${blocks.map((b) => b.toUpperCase()).join('\n\n')}\n`
      expect(r.session.recoverReplay(host, 4, 0, vi.fn())).toBe('recovering')
      // The stopped replay's callback, then the recovery frame after an input: it skips.
      r.session.noteInput()
      oneFrame(r)
      expect(stats(r).recovery.yielded).toBe(1)
      for (let n = 0; n < 50 && r.frames.length > 0; n++) oneFrame(r)
      expect(r.session.deltaPort().modelText()).toBe(host)
      expect(r.session.replayAccount?.().isOpen()).toBe(false)
    })
  })
})

// ---- 036 core C2 (R2.3, R3.3, M3): a user teardown flushes the outstanding user edits of their epoch ----

describe('036 core C2 teardown flush', () => {
  type Delta = {
    command: string
    epoch?: number
    changes?: Array<{
      start: { line: number; character: number }
      end: { line: number; character: number }
      oldText: string
      text: string
    }>
  }
  const offsetOf = (text: string, pos: { line: number; character: number }) => {
    let at = 0
    for (let line = 0; line < pos.line; line++) at = text.indexOf('\n', at) + 1
    return at + pos.character
  }
  const applyDeltas = (text: string, posts: readonly Delta[]): string => {
    let out = text
    for (const post of posts) {
      const base = out
      for (const change of [...(post.changes ?? [])].reverse()) {
        const from = offsetOf(base, change.start)
        const to = offsetOf(base, change.end)
        expect(base.slice(from, to)).toBe(change.oldText)
        out = out.slice(0, from) + change.text + out.slice(to)
      }
    }
    return out
  }
  async function withSync(r: Rig) {
    const posted: Delta[] = []
    const { createDeltaSync } = await import('./delta-sync')
    const sync = createDeltaSync({
      session: r.session.deltaPort(),
      postMessage: (message) => posted.push(message as never),
      publishWhole: vi.fn(),
      countFallback: vi.fn(),
      isComposing: () => false,
      now: () => 0,
    })
    r.session.bindReplaySync(sync as never)
    return posted
  }
  const deltas = (posted: readonly Delta[]) =>
    posted.filter((m) => m.command === 'edit-delta')

  it('same-task-dispose-before-delivery: an insertion then a dispose in the same task posts one delta with exact bytes', async () => {
    const r = open()
    r.runFrames()
    const posted = await withSync(r)
    type(r, 1, 'beta!')
    r.session.dispose()
    expect(deltas(posted)).toHaveLength(1)
    expect(deltas(posted)[0].epoch).toBe(3)
    expect(applyDeltas(DOC, deltas(posted))).toBe('alpha\n\nbeta!\n')
    // Nothing stays scheduled that would post later.
    r.runFrames()
    for (const run of r.timers.splice(0)) run()
    expect(deltas(posted)).toHaveLength(1)
    expect(r.session.replayAccount?.().isOpen()).toBe(false)
  })

  it('host-rebuild-no-repost: a host setValue then the rebuild teardown posts nothing; the host applies its text once', async () => {
    const r = open()
    r.runFrames()
    const posted = await withSync(r)
    const next = 'alpha\n\nbeta host\n'
    // The host's own write is pending as records when the rebuild tears the model down.
    r.render(next)
    r.session.onHostText(next, 4)
    r.runFrames()
    r.session.dispose()
    expect(deltas(posted)).toEqual([])
  })

  it('stale-epoch-edit-not-flushed: a dirty user edit of an ended epoch posts nothing at a user teardown', async () => {
    const r = open()
    r.runFrames()
    const posted = await withSync(r)
    type(r, 1, 'beta!')
    // Delivered: the edit's epoch is 3. The host then moves to epoch 4 with the model still dirty.
    expect(r.session.deltaPort().hasDirty()).toBe(true)
    r.session.adoptHostEpoch(DOC, 4)
    r.session.dispose()
    expect(deltas(posted)).toEqual([])
  })

  it('mode-switch-visible-insertion: the edit is posted before the mode change; the later flush posts nothing', async () => {
    const r = open()
    r.runFrames()
    const posted = await withSync(r)
    type(r, 0, 'alpha!')
    // The `setEditMode` hook (R4.3) runs while Vditor still shows IR.
    r.session.flushUserEdits()
    expect(deltas(posted)).toHaveLength(1)
    expect(applyDeltas(DOC, deltas(posted))).toBe('alpha!\n\nbeta\n')
    r.mode.value = 'sv'
    r.session.onModeChange('sv')
    expect(deltas(posted)).toHaveLength(1)
    r.runFrames()
    expect(deltas(posted)).toHaveLength(1)
  })

  it('mode-switch-visible-insertion (safety net): onModeChange flushes first when no hook ran', async () => {
    const r = open()
    r.runFrames()
    const posted = await withSync(r)
    type(r, 1, 'beta?')
    // The switch is processed while the surface still serves IR (the hook did not run).
    r.session.onModeChange('sv')
    expect(deltas(posted)).toHaveLength(1)
    expect(deltas(posted)[0].epoch).toBe(3)
    expect(applyDeltas(DOC, deltas(posted))).toBe('alpha\n\nbeta?\n')
  })
})
