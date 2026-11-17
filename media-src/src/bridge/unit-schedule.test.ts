// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import {
  costClock,
  type Factor,
  fakeLanes,
  irFixture,
  type LaneDeps,
  countBudget,
  countedLute,
  wysiwygFixture,
} from '../testing/budget-harness'
import type { Unit, UnitKind } from './text-model'
import {
  createUnitSchedule,
  installPreTouchListeners,
  type UnitSchedule,
  type UnitScheduleDeps,
} from './unit-schedule'
import { scanMovableBlocks } from '../../../src/shared/block-move'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { createRealLute } from '../testing/real-lute'
import { createBackgroundScheduler } from '../util/background-budget'
import { installModelSync } from './model-structure'
import { createTextModel } from './text-model'
import { createUnitDom } from './unit-dom'
import type { UnitLute } from './unit-lute'
import * as unitLuteModule from './unit-lute'

// Task 733 / 004-B: idle proof slices, the pre-touch proof, its listeners and the rotating audit.
// The model is a small stub whose `prove` costs one fake millisecond, so the slice budget is exact.

// Task 733 / 012-20 (D-13 design section 1.1): the schedule runs its proofs, audits and queue rebuild
// as jobs of the background scheduler injected as `deps.scheduler`. The module is loaded by a
// computed specifier so this file typechecks before the module exists; every rig passes a scheduler
// built on the rig's own frames once it does, so the tests above drive either implementation.
type JobName =
  | 'unit-proof'
  | 'unit-audit'
  | 'proof-queue'
  | 'table-membership'
  | 'wrap-hints'
  | 'diagram-report'
interface TestJob {
  readonly name: JobName
  readonly lane: 'frame'
  step(budget: { spent(): boolean }): boolean
}
interface TestScheduler {
  post(job: TestJob): void
  cancel(job: TestJob): void
  stats(name: JobName): {
    readonly slices: number
    readonly overruns: number
    readonly maxSliceMs: number
  }
}
interface BudgetModule {
  FRAME_SLICE_MS: number
  MAX_UNIT_MS: number
  createBackgroundScheduler(deps: LaneDeps): TestScheduler
}
const BUDGET_MODULE: string = '../util/background-budget'
let budgetModule: BudgetModule | undefined
beforeAll(async () => {
  budgetModule = (await import(/* @vite-ignore */ BUDGET_MODULE).catch(
    () => undefined,
  )) as BudgetModule | undefined
})
const requireBudget = (): BudgetModule => {
  if (!budgetModule) throw new Error('util/background-budget is missing')
  return budgetModule
}

type U = Unit<HTMLElement>

interface Rig {
  root: HTMLElement
  units: U[]
  schedule: UnitSchedule
  proofs: U[]
  clock: { t: number }
  frames: Array<{ id: number; cb: () => void }>
  runFrame(): void
  runFrames(n: number): void
  timers: Map<number, { cb: () => void; at: number }>
  advanceTimers(ms: number): void
  audited: U[]
  structureMarks: Array<'root' | U>
  options: {
    viewport: Set<U>
    oversize: Set<U>
    luteReady: boolean
    active: boolean
    viewportCalls: number
    serialized: Map<U, string>
    opaque: Set<U>
  }
  deps: UnitScheduleDeps
}

function makeUnit(el: HTMLElement, kind: UnitKind = 'paragraph'): U {
  return {
    kind,
    el,
    members: [el],
    start: 0,
    end: 0,
    startLine: 0,
    proof: 'none',
    html: undefined,
    canon: undefined,
    forms: [],
    children: [],
    dirty: false,
    explicit: false,
    changedAt: 0,
  }
}

function rig(count: number): Rig {
  const root = document.createElement('div')
  root.className = 'vditor-reset vditor-ir'
  document.body.appendChild(root)
  const units: U[] = []
  const byElement = new Map<Element, U>()
  for (let i = 0; i < count; i += 1) {
    const el = document.createElement('p')
    el.setAttribute('data-block', '0')
    el.textContent = `block ${i}`
    root.appendChild(el)
    const unit = makeUnit(el)
    units.push(unit)
    byElement.set(el, unit)
  }
  const clock = { t: 0 }
  const frames: Array<{ id: number; cb: () => void }> = []
  let frameId = 0
  const proofs: U[] = []
  const audited: U[] = []
  const structureMarks: Array<'root' | U> = []
  const timers = new Map<number, { cb: () => void; at: number }>()
  let timerId = 0
  const options = {
    viewport: new Set<U>(),
    oversize: new Set<U>(),
    luteReady: true,
    active: true,
    viewportCalls: 0,
    serialized: new Map<U, string>(),
    /** Task 733 / 021: units whose proof finds a different serialized text (the model's `opaque`). */
    opaque: new Set<U>(),
  }
  const deps: UnitScheduleDeps = {
    model: {
      units,
      unitOf: (el) => byElement.get(el),
      prove: (unit) => {
        clock.t += 1
        if (!options.luteReady) return 'none'
        if (options.opaque.has(unit)) {
          unit.proof = 'opaque'
          return 'opaque'
        }
        unit.proof = 'proven'
        unit.html = unit.el?.outerHTML
        unit.canon = `canon ${unit.el?.textContent ?? ''}`
        proofs.push(unit)
        return 'proven'
      },
      markDirty: (unit) => {
        unit.dirty = true
      },
      markStructureDirty: (scope) => {
        structureMarks.push(scope)
      },
    },
    root,
    serialize: (_kind, members) => {
      clock.t += 1
      const unit = byElement.get(members[0]) as U
      audited.push(unit)
      return options.serialized.get(unit) ?? unit.canon ?? ''
    },
    htmlLength: (unit) => (options.oversize.has(unit) ? 20001 : 10),
    inViewport: (unit) => {
      options.viewportCalls += 1
      return options.viewport.has(unit)
    },
    isActive: () => options.active,
    drain: vi.fn(),
    requestAnimationFrame: (cb) => {
      frameId += 1
      frames.push({ id: frameId, cb })
      return frameId
    },
    cancelAnimationFrame: (handle) => {
      const at = frames.findIndex((frame) => frame.id === handle)
      if (at >= 0) frames.splice(at, 1)
    },
    now: () => clock.t,
    setTimeout: (cb, ms) => {
      timerId += 1
      timers.set(timerId, { cb, at: clock.t + ms })
      return timerId
    },
    clearTimeout: (handle) => {
      timers.delete(handle)
    },
  }
  // The scheduler shares the rig's frames and clock (see the note at the top of the file).
  ;(deps as unknown as { scheduler?: TestScheduler }).scheduler =
    budgetModule?.createBackgroundScheduler({
      now: deps.now,
      requestAnimationFrame: deps.requestAnimationFrame,
      cancelAnimationFrame: deps.cancelAnimationFrame,
      requestIdle: () => 0,
      cancelIdle: () => undefined,
      inputPending: () => false,
    })
  const schedule = createUnitSchedule(deps)
  return {
    root,
    units,
    schedule,
    proofs,
    clock,
    frames,
    runFrame() {
      frames.shift()?.cb()
    },
    runFrames(n) {
      for (let i = 0; i < n; i += 1) this.runFrame()
    },
    timers,
    advanceTimers(ms) {
      clock.t += ms
      for (const [id, timer] of Array.from(timers)) {
        if (timer.at <= clock.t) {
          timers.delete(id)
          timer.cb()
        }
      }
    },
    audited,
    structureMarks,
    options,
    deps,
  }
}

const pending = (r: Rig): number => r.frames.length

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function runUntilIdle(r: Rig, limit = 2000): number {
  let frames = 0
  while (pending(r) > 0 && frames < limit) {
    r.runFrame()
    frames += 1
  }
  return frames
}

describe('idle proof slices', () => {
  it('proves nothing during the first 4 paint frames', () => {
    const r = rig(10)
    r.schedule.start()
    r.runFrames(4)
    expect(r.proofs).toHaveLength(0)
    r.runFrame()
    expect(r.proofs.length).toBeGreaterThan(0)
  })

  it('spends at most 4 ms plus one proof per frame on 500 units that cost 1 ms each', () => {
    const r = rig(500)
    r.schedule.start()
    r.runFrames(4)
    let worst = 0
    while (pending(r) > 0) {
      const before = r.clock.t
      r.runFrame()
      worst = Math.max(worst, r.clock.t - before)
    }
    expect(worst).toBeLessThanOrEqual(5)
    expect(r.schedule.stats().proven).toBe(500)
  })

  it('proves the units in the viewport first, then in document order', () => {
    const r = rig(500)
    for (const unit of r.units.slice(400, 405)) r.options.viewport.add(unit)
    r.schedule.start()
    // Four paint frames, then 4 proofs per 4 ms slice.
    r.runFrames(6)
    expect(r.proofs.slice(0, 5)).toEqual(r.units.slice(400, 405))
    expect(r.proofs.slice(5, 8)).toEqual(r.units.slice(0, 3))
  })

  it('stops when no unit is left with proof none and restarts on start()', () => {
    const r = rig(8)
    r.schedule.start()
    runUntilIdle(r)
    expect(pending(r)).toBe(0)
    expect(r.schedule.stats().proven).toBe(8)
    // A rebuild gives a fresh unit; start() resumes the loop.
    r.units[3].proof = 'none'
    r.schedule.start()
    expect(pending(r)).toBe(1)
    runUntilIdle(r)
    expect(r.units[3].proof).toBe('proven')
  })

  it('proves an oversize unit last, one per frame', () => {
    const r = rig(10)
    const big1 = r.units[1]
    const big2 = r.units[2]
    r.options.oversize.add(big1)
    r.options.oversize.add(big2)
    r.schedule.start()
    r.runFrames(5)
    // Eight normal units fit in two slices; the oversize ones follow, one per frame.
    runUntilIdle(r)
    expect(r.proofs.slice(-2)).toEqual([big1, big2])
    expect(r.proofs.indexOf(big1)).toBeGreaterThan(7)
  })

  it('012-10: passes the slice deadline into every idle proof', () => {
    const r = rig(3)
    const deadlines: unknown[] = []
    const prove = r.deps.model.prove
    // The schedule reads `model.prove` at each call, so the wrapper sees every idle proof.
    r.deps.model.prove = (unit, ...rest: unknown[]) => {
      deadlines.push(rest[0])
      return prove(unit)
    }
    r.schedule.start()
    r.runFrames(5)
    expect(r.proofs).toHaveLength(3)
    expect(deadlines).toHaveLength(3)
    expect(deadlines.every((deadline) => deadline !== undefined)).toBe(true)
  })

  it('does not spin while Lute is not ready', () => {
    const r = rig(5)
    r.options.luteReady = false
    r.schedule.start()
    const frames = runUntilIdle(r)
    expect(frames).toBeLessThan(20)
    expect(pending(r)).toBe(0)
    expect(r.schedule.stats().proven).toBe(0)
    r.options.luteReady = true
    r.schedule.start()
    runUntilIdle(r)
    expect(r.schedule.stats().proven).toBe(5)
  })

  it('skips a dirty unit and stop() cancels the pending frame', () => {
    const r = rig(3)
    r.units[1].dirty = true
    r.schedule.start()
    runUntilIdle(r)
    expect(r.units[1].proof).toBe('none')
    r.schedule.start()
    r.schedule.stop()
    r.runFrames(10)
    expect(r.proofs).toHaveLength(2)
  })

  it('counts proven, opaque and the whole tree in stats', () => {
    const r = rig(3)
    r.units[0].proof = 'opaque'
    const row = makeUnit(document.createElement('tr'), 'row')
    r.units[2].children.push(row)
    r.schedule.start()
    runUntilIdle(r)
    expect(r.schedule.stats()).toMatchObject({
      units: 4,
      opaque: 1,
      proven: 3,
    })
  })
})

describe('restart and activity', () => {
  it('restart() does no work on the publication path: the queue is rebuilt inside the next frame', () => {
    const r = rig(6)
    r.schedule.start()
    runUntilIdle(r)
    r.options.viewportCalls = 0
    r.units[2].proof = 'none'
    r.schedule.restart()
    expect(r.options.viewportCalls).toBe(0)
    expect(pending(r)).toBe(1)
    runUntilIdle(r)
    // Only the top-level unit that had something to prove was tested against the viewport.
    expect(r.options.viewportCalls).toBe(1)
    expect(r.units[2].proof).toBe('proven')
  })

  it('stops the frame loop when the model is no longer active and resumes on restart()', () => {
    const r = rig(10)
    r.schedule.start()
    r.runFrames(5)
    r.options.active = false
    runUntilIdle(r)
    expect(pending(r)).toBe(0)
    expect(r.schedule.stats().none).toBeGreaterThan(0)
    r.options.active = true
    r.schedule.restart()
    runUntilIdle(r)
    expect(r.schedule.stats().none).toBe(0)
  })
})

describe('pre-touch proof', () => {
  const select = (el: Element): Range => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return range
  }

  it('proves 3 unproven units under the selection synchronously', () => {
    const r = rig(10)
    const range = document.createRange()
    range.setStartBefore(r.units[2].el as Node)
    range.setEndAfter(r.units[4].el as Node)
    expect(r.schedule.proveForSelection(range)).toBe('proven')
    expect(r.units.slice(2, 5).every((u) => u.proof === 'proven')).toBe(true)
    expect(r.units[5].proof).toBe('none')
    expect(r.units[2].html).toBeDefined()
    expect(r.deps.drain).toHaveBeenCalled()
  })

  it('proves 32 unproven units and falls back at 33', () => {
    const r = rig(40)
    const over = document.createRange()
    over.setStartBefore(r.units[0].el as Node)
    over.setEndAfter(r.units[32].el as Node)
    expect(r.schedule.proveForSelection(over)).toBe('fallback')
    expect(r.schedule.lastFallbackReason()).toBe('unproven-selection')
    expect(r.proofs).toHaveLength(0)
    const exact = document.createRange()
    exact.setStartBefore(r.units[0].el as Node)
    exact.setEndAfter(r.units[31].el as Node)
    expect(r.schedule.proveForSelection(exact)).toBe('proven')
    expect(r.proofs).toHaveLength(32)
  })

  it('falls back for an oversize unit before its idle proof', () => {
    const r = rig(4)
    r.options.oversize.add(r.units[1])
    expect(r.schedule.proveForSelection(select(r.units[1].el as Element))).toBe(
      'fallback',
    )
    expect(r.schedule.lastFallbackReason()).toBe('oversize-unit')
    expect(r.units[1].proof).toBe('none')
  })

  it('checks the count before the oversize bound', () => {
    const r = rig(40)
    r.options.oversize.add(r.units[1])
    const range = document.createRange()
    range.setStartBefore(r.units[0].el as Node)
    range.setEndAfter(r.units[32].el as Node)
    expect(r.schedule.proveForSelection(range)).toBe('fallback')
    expect(r.schedule.lastFallbackReason()).toBe('unproven-selection')
  })

  // Task 733 / 021 (Q-187): a dirty unit is refused only when its serialized text changed.
  it('falls back for a dirty unit that is not proven', () => {
    const r = rig(4)
    r.units[2].dirty = true
    r.options.opaque.add(r.units[2])
    expect(r.schedule.proveForSelection(select(r.units[2].el as Element))).toBe(
      'fallback',
    )
    expect(r.schedule.lastFallbackReason()).toBe('unproven-selection')
    expect(r.proofs).toHaveLength(0)
  })

  it('answers proven at once for an already proven unit and for a selection outside the units', () => {
    const r = rig(3)
    r.units[0].proof = 'proven'
    expect(r.schedule.proveForSelection(select(r.units[0].el as Element))).toBe(
      'proven',
    )
    expect(r.proofs).toHaveLength(0)
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    expect(r.schedule.proveForSelection(select(outside))).toBe('proven')
  })

  it('proves the cell under a collapsed caret and its table', () => {
    const r = rig(1)
    const table = document.createElement('table')
    table.setAttribute('data-block', '0')
    table.innerHTML = '<tbody><tr><td>c</td></tr></tbody>'
    r.root.appendChild(table)
    const tableUnit = makeUnit(table, 'table')
    const row = makeUnit(table.querySelector('tr') as HTMLElement, 'row')
    const cell = makeUnit(table.querySelector('td') as HTMLElement, 'cell')
    row.children.push(cell)
    tableUnit.children.push(row)
    r.units.push(tableUnit)
    const known = new Map<Element, U>([
      [table, tableUnit],
      [cell.el as Element, cell],
    ])
    r.deps.model.unitOf = (el) => known.get(el)
    const caret = document.createRange()
    caret.setStart(cell.el?.firstChild as Node, 0)
    caret.collapse(true)
    expect(r.schedule.proveForSelection(caret)).toBe('proven')
    expect(cell.proof).toBe('proven')
    expect(tableUnit.proof).toBe('proven')
    expect(row.proof).toBe('none')
  })
})

describe('rotating audit', () => {
  it('compares the proven, clean units with their canon and marks a difference dirty', () => {
    const r = rig(6)
    r.schedule.start()
    runUntilIdle(r)
    r.options.serialized.set(r.units[3], 'different')
    r.schedule.requestAudit(true)
    expect(r.audited).toHaveLength(6)
    expect(r.units[3].dirty).toBe(true)
    expect(r.units.filter((u) => u.dirty)).toHaveLength(1)
    const stats = r.schedule.stats()
    expect(stats.auditMismatch).toBe(1)
    expect(stats.auditMismatchByKind).toEqual({ paragraph: 1 })
  })

  it('m2: a detached unit marks the root structure dirty and counts as a mismatch', () => {
    const r = rig(4)
    r.schedule.start()
    runUntilIdle(r)
    r.units[2].el?.remove()
    r.schedule.requestAudit(true)
    expect(r.structureMarks).toContain('root')
    expect(r.schedule.stats().auditMismatch).toBeGreaterThan(0)
  })

  it('m2: a root child that no unit covers marks the root structure dirty', () => {
    const r = rig(4)
    r.schedule.start()
    runUntilIdle(r)
    r.root.appendChild(document.createElement('p'))
    r.schedule.requestAudit(true)
    expect(r.structureMarks).toEqual(['root'])
    expect(r.schedule.stats().auditMismatch).toBe(1)
  })

  it('m2: a swapped pair of root children marks the root structure dirty', () => {
    const r = rig(4)
    r.schedule.start()
    runUntilIdle(r)
    r.root.insertBefore(r.root.children[1], r.root.children[0])
    r.schedule.requestAudit(true)
    expect(r.structureMarks).toEqual(['root'])
  })

  it('N2: view-only root children (leading, gap, trailing, diff marker) are no mismatch', () => {
    const r = rig(3)
    const viewOnly = (make: () => HTMLElement, before: Element | null) =>
      r.root.insertBefore(make(), before)
    const p = (attr: string) => () => {
      const el = document.createElement('p')
      el.setAttribute(attr, '')
      return el
    }
    viewOnly(p('data-vmde-leading'), r.root.children[0])
    viewOnly(p('data-vmde-gap'), r.root.children[2])
    viewOnly(() => {
      const el = document.createElement('div')
      el.className = 'me-diff-marker'
      return el
    }, r.root.children[3])
    viewOnly(p('data-vmde-trailing'), null)
    r.schedule.start()
    runUntilIdle(r)
    r.schedule.requestAudit(true)
    expect(r.structureMarks).toEqual([])
    expect(r.schedule.stats().auditMismatch).toBe(0)
  })

  it('N2: a unit with several members matches each of them', () => {
    const r = rig(3)
    const extra = document.createElement('p')
    extra.setAttribute('data-block', '0')
    r.root.insertBefore(extra, r.units[1].el?.nextSibling ?? null)
    r.units[1].members = [r.units[1].el as HTMLElement, extra]
    r.schedule.start()
    runUntilIdle(r)
    r.schedule.requestAudit(true)
    expect(r.structureMarks).toEqual([])
    expect(r.schedule.stats().auditMismatch).toBe(0)
  })

  it('N2: a detached cell marks its table structure, not the root', () => {
    const r = rig(2)
    const table = r.units[0]
    table.kind = 'table'
    const cellEl = document.createElement('td')
    const cell = makeUnit(cellEl, 'cell')
    cell.proof = 'proven'
    cell.canon = 'c'
    table.children = [cell]
    table.canon = 'canon'
    r.schedule.requestAudit(true)
    expect(r.structureMarks).toEqual([table])
  })

  it('N2: requestAudit drops a half-finished structure walk', () => {
    const r = rig(4)
    r.schedule.start()
    runUntilIdle(r)
    r.schedule.requestAudit(false)
    r.runFrame()
    r.root.insertBefore(r.root.children[2], r.root.children[0])
    r.units.unshift(r.units.splice(2, 1)[0])
    r.schedule.requestAudit(true)
    expect(r.structureMarks).toEqual([])
  })

  it('m2: an intact root structure marks nothing', () => {
    const r = rig(4)
    r.schedule.start()
    runUntilIdle(r)
    r.schedule.requestAudit(true)
    expect(r.structureMarks).toEqual([])
    expect(r.schedule.stats().auditMismatch).toBe(0)
  })

  it('skips dirty and unproven units and units without canon', () => {
    const r = rig(4)
    r.units[0].proof = 'proven'
    r.units[0].canon = 'a'
    r.units[1].proof = 'proven'
    r.units[1].canon = 'b'
    r.units[1].dirty = true
    r.units[2].proof = 'proven'
    r.units[3].proof = 'opaque'
    r.units[3].canon = 'd'
    r.schedule.requestAudit(true)
    expect(r.audited).toEqual([r.units[0]])
  })

  it('runs a queued pass in the slices after the proofs', () => {
    const r = rig(10)
    r.schedule.start()
    runUntilIdle(r)
    r.audited.length = 0
    r.schedule.requestAudit(false)
    expect(pending(r)).toBe(1)
    const sizes: number[] = []
    while (pending(r) > 0) {
      const before = r.audited.length
      r.runFrame()
      sizes.push(r.audited.length - before)
    }
    expect(r.audited).toHaveLength(10)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(5)
    expect(sizes.length).toBeGreaterThan(1)
    expect(r.schedule.stats().auditPasses).toBe(1)
  })

  it('runs one full pass after one idle minute without any input, then one per minute', () => {
    const r = rig(3)
    r.schedule.start()
    runUntilIdle(r)
    r.audited.length = 0
    r.advanceTimers(59_000)
    expect(pending(r)).toBe(0)
    r.advanceTimers(2_000)
    runUntilIdle(r)
    expect(r.audited).toHaveLength(3)
    // The timer re-arms itself: another quiet minute, another pass.
    r.audited.length = 0
    r.advanceTimers(61_000)
    runUntilIdle(r)
    expect(r.audited).toHaveLength(3)
  })

  it('input restarts the quiet minute', () => {
    const r = rig(3)
    r.schedule.start()
    runUntilIdle(r)
    r.audited.length = 0
    r.advanceTimers(30_000)
    r.schedule.proveForSelection(document.createRange())
    r.advanceTimers(30_000)
    runUntilIdle(r)
    expect(r.audited).toHaveLength(0)
    r.advanceTimers(31_000)
    runUntilIdle(r)
    expect(r.audited).toHaveLength(3)
  })

  it('stop() clears the idle timer', () => {
    const r = rig(2)
    r.schedule.start()
    r.schedule.proveForSelection(document.createRange())
    expect(r.timers.size).toBe(1)
    r.schedule.stop()
    expect(r.timers.size).toBe(0)
  })
})

describe('installPreTouchListeners', () => {
  function setup(composing = false) {
    const r = rig(3)
    const proveForSelection = vi.fn<UnitSchedule['proveForSelection']>(
      () => 'proven',
    )
    const onFallback = vi.fn()
    const dispose = installPreTouchListeners({
      root: r.root,
      schedule: { proveForSelection },
      isComposing: () => composing,
      onFallback,
    })
    return { r, proveForSelection, onFallback, dispose }
  }

  const fire = (target: Element, event: Event): void => {
    target.dispatchEvent(event)
  }

  it('proves for beforeinput, paste, cut, drop and compositionstart inside the root', () => {
    const { r, proveForSelection, dispose } = setup()
    const target = r.units[0].el as HTMLElement
    for (const type of [
      'beforeinput',
      'paste',
      'cut',
      'drop',
      'compositionstart',
    ])
      fire(target, new Event(type, { bubbles: true }))
    expect(proveForSelection).toHaveBeenCalledTimes(5)
    dispose()
  })

  it('ignores events outside the root', () => {
    const { r, proveForSelection, dispose } = setup()
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    fire(outside, new Event('beforeinput', { bubbles: true }))
    expect(proveForSelection).not.toHaveBeenCalled()
    expect(r.root.contains(outside)).toBe(false)
    dispose()
  })

  it('counts editing keys but not navigation, modifiers, Ctrl+C or Ctrl+A', () => {
    const { r, proveForSelection, dispose } = setup()
    const target = r.units[0].el as HTMLElement
    const key = (init: KeyboardEventInit) =>
      fire(target, new KeyboardEvent('keydown', { bubbles: true, ...init }))
    for (const k of [
      'ArrowLeft',
      'Home',
      'End',
      'PageDown',
      'Escape',
      'F5',
      'Shift',
      'Control',
    ])
      key({ key: k })
    key({ key: 'c', ctrlKey: true })
    key({ key: 'a', metaKey: true })
    expect(proveForSelection).not.toHaveBeenCalled()
    key({ key: 'a' })
    key({ key: 'Backspace' })
    key({ key: 'x', ctrlKey: true })
    expect(proveForSelection).toHaveBeenCalledTimes(3)
    dispose()
  })

  it('does not prove keydown or beforeinput while composing, but compositionstart does', () => {
    const { r, proveForSelection, dispose } = setup(true)
    const target = r.units[0].el as HTMLElement
    fire(target, new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    fire(target, new Event('beforeinput', { bubbles: true }))
    expect(proveForSelection).not.toHaveBeenCalled()
    fire(target, new Event('compositionstart', { bubbles: true }))
    expect(proveForSelection).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('selects the list item for a task checkbox mousedown', () => {
    const { r, proveForSelection, dispose } = setup()
    const list = document.createElement('ul')
    list.innerHTML = '<li><input type="checkbox">task</li>'
    r.root.appendChild(list)
    const box = list.querySelector('input') as HTMLElement
    fire(box, new MouseEvent('mousedown', { bubbles: true }))
    const range = proveForSelection.mock.calls[0][0]
    expect(range.startContainer).toBe(list)
    expect(range.endContainer).toBe(list)
    expect(range.toString()).toBe('task')
    fire(
      r.units[0].el as HTMLElement,
      new MouseEvent('mousedown', { bubbles: true }),
    )
    expect(proveForSelection).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('reports a fallback reason to the callback and stops listening after dispose', () => {
    const { r, proveForSelection, onFallback, dispose } = setup()
    proveForSelection.mockReturnValue('fallback')
    const target = r.units[0].el as HTMLElement
    fire(target, new Event('paste', { bubbles: true }))
    expect(onFallback).toHaveBeenCalledTimes(1)
    dispose()
    fire(target, new Event('paste', { bubbles: true }))
    expect(proveForSelection).toHaveBeenCalledTimes(1)
  })

  it('uses the dragged node for a dragstart without a selection', () => {
    const { r, proveForSelection, dispose } = setup()
    const target = r.units[1].el as HTMLElement
    window.getSelection()?.removeAllRanges()
    fire(target, new Event('dragstart', { bubbles: true }))
    const range = proveForSelection.mock.calls[0][0]
    expect(range.commonAncestorContainer).toBe(r.root)
    dispose()
  })
})

// ---- B-09 (Task 733 / 012-20, D-13 design sections 1.1 and 5.2) ----
//
// The units of `irFixture(tableHeavyMarkdown(f))` as a stub tree: one unit per top-level block, one
// per list item, and the rows and cells of each table. Every cost is charged on the harness cost
// clock: a proof is one Lute call (0.5 ms plus 0.1 ms per 1,000 characters of its HTML; a row is one
// call per cell, the 012-10 granularity) and each visit of a unit by a tree walk is one node
// (0.001 ms; counted on the `children` read, which every walk of the schedule makes once per unit).
// The proof stub follows `proveTable` of `text-model.ts`: the deadline is checked before each row,
// and a table cut off answers `'pending'` and resumes at its `proofRow`.

const LUTE_CALL_MS = 0.5
const LUTE_MS_PER_1000_CHARS = 0.1
const NODE_MS = 0.001
/** The shared frame slice of the design (`FRAME_SLICE_MS`). */
const FRAME_SLICE_MS = 4
/** The overrun bound of one unit of work (`MAX_UNIT_MS`). */
const MAX_UNIT_MS = 2
interface BudgetRig {
  units: U[]
  all: U[]
  clock: ReturnType<typeof costClock>
  lanes: ReturnType<typeof fakeLanes>
  schedule: UnitSchedule
  scheduler: TestScheduler | undefined
  /** Frames the schedule itself requested (it should request none once it runs as jobs). */
  ownFrames: { count: number }
  visits: { count: number }
  luteCalls: { count: number }
  /**
   * The B-09 slice bound (D-13 design 13.13): `FRAME_SLICE_MS + max(MAX_UNIT_MS, largest row proof)`.
   * A table is proven row by row with the deadline checked between rows, so one row proof is the
   * indivisible unit that may run past the deadline; its cost is the cost-clock charge of its cells.
   */
  sliceBoundMs: number
}

const fixtureRoots = new Map<Factor, HTMLElement>()
function budgetFixture(factor: Factor): HTMLElement {
  let root = fixtureRoots.get(factor)
  if (!root) {
    root = irFixture(tableHeavyMarkdown(factor)).root
    // irFixture keeps its root for the file; the afterEach above empties the body, so the root is
    // detached here and every rig attaches it again.
    fixtureRoots.set(factor, root)
  }
  if (!root.isConnected) document.body.append(root.parentElement ?? root)
  return root
}

/** One Lute call on the cost clock: the call charge plus the per-character charge of its input. */
const lutePriceMs = (chars: number): number =>
  LUTE_CALL_MS + (LUTE_MS_PER_1000_CHARS * chars) / 1000

/** The cost-clock charge of the fixture's most expensive row proof: one Lute call per cell. */
function largestRowProofMs(
  all: readonly U[],
  kidsOf: WeakMap<U, U[]>,
  htmlCost: WeakMap<U, number>,
): number {
  let largest = 0
  for (const unit of all) {
    if (unit.kind !== 'row') continue
    let rowMs = 0
    for (const cell of kidsOf.get(unit) ?? [])
      rowMs += lutePriceMs(htmlCost.get(cell) ?? 0)
    largest = Math.max(largest, rowMs)
  }
  return largest
}

function budgetRig(factor: Factor): BudgetRig {
  const root = budgetFixture(factor)
  const clock = costClock()
  const lanes = fakeLanes(clock)
  const visits = { count: 0 }
  const luteCalls = { count: 0 }
  const ownFrames = { count: 0 }
  const htmlCost = new WeakMap<U, number>()
  const all: U[] = []
  const byElement = new Map<Element, U>()
  // Child lists the proof stub reads without counting: the proof itself walks no tree.
  const kidsOf = new WeakMap<U, U[]>()

  const stubUnit = (
    el: HTMLElement | undefined,
    kind: UnitKind,
    kids: U[],
    html: number,
  ): U => {
    const unit = makeUnit(el ?? document.createElement('tr'), kind)
    if (!el) unit.el = undefined
    Object.defineProperty(unit, 'children', {
      get() {
        visits.count += 1
        clock.advance(NODE_MS)
        return kids
      },
    })
    htmlCost.set(unit, html)
    kidsOf.set(unit, kids)
    all.push(unit)
    if (el) byElement.set(el, unit)
    return unit
  }
  const leaf = (el: HTMLElement, kind: UnitKind): U =>
    stubUnit(el, kind, [], el.outerHTML.length)

  const units: U[] = []
  for (const child of Array.from(root.children) as HTMLElement[]) {
    if (child.tagName === 'UL' || child.tagName === 'OL') {
      for (const item of Array.from(child.children) as HTMLElement[])
        units.push(leaf(item, 'list-item'))
      continue
    }
    if (child.tagName !== 'TABLE') {
      units.push(leaf(child, child.tagName === 'P' ? 'paragraph' : 'heading'))
      continue
    }
    const rows: U[] = []
    for (const tr of Array.from(child.querySelectorAll('tr'))) {
      const cells = (Array.from(tr.children) as HTMLElement[]).map((cell) =>
        stubUnit(cell, 'cell', [], cell.innerHTML.length),
      )
      const row = stubUnit(undefined, 'row', cells, 0)
      row.members = []
      rows.push(row)
    }
    units.push(stubUnit(child, 'table', rows, 0))
  }

  const largestRowMs = largestRowProofMs(all, kidsOf, htmlCost)
  const luteCall = (chars: number): void => {
    luteCalls.count += 1
    clock.advance(lutePriceMs(chars))
  }
  const proveLeaf = (unit: U): 'proven' => {
    luteCall(htmlCost.get(unit) ?? 0)
    unit.proof = 'proven'
    unit.canon = 'canon'
    return 'proven'
  }
  const proveRow = (row: U): void => {
    for (const cell of kidsOf.get(row) ?? [])
      if (cell.proof === 'none') proveLeaf(cell)
    row.proof = 'proven'
  }
  const deps = {
    model: {
      units,
      unitOf: (el: HTMLElement) => byElement.get(el),
      prove: (unit: U, spent?: () => boolean) => {
        if (unit.proof !== 'none') return unit.proof
        if (unit.kind === 'row') {
          proveRow(unit)
          return 'proven'
        }
        if (unit.kind !== 'table') return proveLeaf(unit)
        const rows = kidsOf.get(unit) ?? []
        for (let at = unit.proofRow ?? 0; at < rows.length; at++) {
          if (spent?.()) {
            unit.proofRow = at
            return 'pending'
          }
          proveRow(rows[at])
        }
        unit.proofRow = undefined
        unit.proof = 'proven'
        return 'proven'
      },
      markDirty: (unit: U) => {
        unit.dirty = true
      },
      markStructureDirty: () => undefined,
    },
    root,
    serialize: () => 'canon',
    htmlLength: (unit: U) => htmlCost.get(unit) ?? 0,
    inViewport: () => false,
    isActive: () => true,
    drain: () => undefined,
    requestAnimationFrame: (callback: () => void) => {
      ownFrames.count += 1
      return lanes.requestAnimationFrame(callback)
    },
    cancelAnimationFrame: (handle: number) =>
      lanes.cancelAnimationFrame(handle),
    now: () => clock.now(),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  }
  const scheduler = budgetModule?.createBackgroundScheduler(lanes)
  const schedule = createUnitSchedule({
    ...deps,
    scheduler,
  } as unknown as UnitScheduleDeps)
  return {
    units,
    all,
    clock,
    lanes,
    schedule,
    scheduler,
    ownFrames,
    visits,
    luteCalls,
    sliceBoundMs: FRAME_SLICE_MS + Math.max(MAX_UNIT_MS, largestRowMs),
  }
}

interface FrameRecord {
  ms: number
  visits: number
  luteCalls: number
}

/** Runs frames until no frame is queued (or `until` holds); returns what each frame cost. */
function runBudgetFrames(r: BudgetRig, until?: () => boolean): FrameRecord[] {
  const frames: FrameRecord[] = []
  let idle = 0
  for (let guard = 0; guard < 50_000; guard++) {
    if (until?.()) break
    const start = r.clock.now()
    const visits = r.visits.count
    const luteCalls = r.luteCalls.count
    r.lanes.runFrame()
    const record = {
      ms: r.clock.now() - start,
      visits: r.visits.count - visits,
      luteCalls: r.luteCalls.count - luteCalls,
    }
    frames.push(record)
    // The fake lanes do not tell whether a frame is queued: ten frames in a row without any cost
    // (the paint frames are four) mean nothing is left; they are not counted.
    if (record.ms === 0) idle += 1
    else idle = 0
    if (idle === 10 && !until) break
  }
  return idle === 10 ? frames.slice(0, -10) : frames
}

/** Wall-time limit of one f16 budget case (Q-120). */
const F16_CASE_TIMEOUT_MS = 30_000

const allProven = (r: BudgetRig): boolean =>
  r.all.every((unit) => unit.proof === 'proven')

/** Frames, by index, whose cost on the cost clock passes the rig's slice bound. */
const overBudget = (r: BudgetRig, frames: FrameRecord[]): string[] =>
  frames.flatMap((frame, index) =>
    frame.ms > r.sliceBoundMs + 1e-9
      ? [`frame ${index}: ${frame.ms.toFixed(3)} ms, ${frame.visits} visits`]
      : [],
  )

describe.each([1, 4, 16] as const)('B-09 proofs at factor %i', (factor) => {
  // An f16 case proves about 19,000 units over 1,600 frames (twice in the shared-budget case): it
  // needs more than the default 5 s of wall time, which the cost clock does not measure.
  const caseTimeout = factor === 16 ? F16_CASE_TIMEOUT_MS : undefined

  it(
    'proves the whole fixture in slices of at most 4 ms plus its largest row proof',
    () => {
      const r = budgetRig(factor)
      r.schedule.start()
      const frames = runBudgetFrames(r)
      expect(allProven(r)).toBe(true)
      expect(overBudget(r, frames)).toEqual([])
    },
    caseTimeout,
  )

  it(
    'proof-queue: the rebuild after restart() walks the unit tree under the slice budget',
    () => {
      const r = budgetRig(factor)
      r.schedule.start()
      runBudgetFrames(r)
      expect(allProven(r)).toBe(true)
      // An edit left the last cell of the last table unproven (its sync rebuilt it).
      const cell = r.all.filter((unit) => unit.kind === 'cell').at(-1) as U
      cell.proof = 'none'
      r.visits.count = 0
      r.schedule.restart()
      // The publication path pays nothing: the rebuild runs inside the frames.
      expect(r.visits.count).toBe(0)
      const frames = runBudgetFrames(r)
      expect(cell.proof).toBe('proven')
      expect(overBudget(r, frames)).toEqual([])
      // The walk covers the tree once in total, spread over frames by its cursor.
      const walked = frames.reduce((sum, frame) => sum + frame.visits, 0)
      expect(walked).toBeGreaterThanOrEqual(r.all.length)
    },
    caseTimeout,
  )

  it(
    'runs as the frame jobs unit-proof, proof-queue and unit-audit of the shared scheduler',
    () => {
      requireBudget()
      const r = budgetRig(factor)
      r.schedule.start()
      runBudgetFrames(r)
      r.all[0].proof = 'none'
      r.schedule.restart()
      runBudgetFrames(r)
      r.schedule.requestAudit(false)
      runBudgetFrames(r)
      expect(allProven(r)).toBe(true)
      // Every frame comes from the scheduler: the schedule requests none of its own.
      expect(r.ownFrames.count).toBe(0)
      const scheduler = r.scheduler as TestScheduler
      for (const name of ['unit-proof', 'proof-queue', 'unit-audit'] as const) {
        const stats = scheduler.stats(name)
        expect(stats.slices, `${name} slices`).toBeGreaterThan(0)
        // A row proof may end more than MAX_UNIT_MS past the deadline (13.13), which the scheduler
        // counts as an overrun; the queue walk and the audit have no such unit.
        if (name !== 'unit-proof')
          expect(stats.overruns, `${name} overruns`).toBe(0)
        expect(stats.maxSliceMs, `${name} maxSliceMs`).toBeLessThanOrEqual(
          r.sliceBoundMs,
        )
      }
    },
    caseTimeout,
  )

  it(
    'with the frame jobs of the table first pointer move queued, proves the fixture within twice the frames it takes alone',
    () => {
      requireBudget()
      // The baseline: the same schedule on its own scheduler, with no other job queued.
      const alone = budgetRig(factor)
      alone.schedule.start()
      const aloneFrames = runBudgetFrames(alone, () => allProven(alone))
      expect(allProven(alone)).toBe(true)
      const r = budgetRig(factor)
      const scheduler = r.scheduler as TestScheduler
      // Three finite jobs of the same frame lane, 100 units of 1 ms each, checking the budget before
      // each unit (the design's `table-membership`, `wrap-hints` and `diagram-report`).
      const others = (
        ['table-membership', 'wrap-hints', 'diagram-report'] as const
      ).map((name) => {
        let left = 100
        const job: TestJob = {
          name,
          lane: 'frame',
          step(budget) {
            while (left > 0) {
              if (budget.spent()) return true
              r.clock.advance(1)
              left -= 1
            }
            return false
          },
        }
        return job
      })
      for (const job of others) scheduler.post(job)
      r.schedule.start()
      const frames = runBudgetFrames(r, () => allProven(r))
      expect(allProven(r)).toBe(true)
      expect(overBudget(r, frames)).toEqual([])
      expect(frames.length).toBeLessThanOrEqual(2 * aloneFrames.length)
    },
    caseTimeout,
  )
})

// ---- Task 733 / 013-T1: B-09 on the WYSIWYG fixture (D-13 design section 5.2; technical task 013) ----
//
// A real model over Lute's WYSIWYG DOM (`createUnitDom` with `unitLuteOf(lute, 'wysiwyg')`, 013-I1) is
// proven by the schedule in frames on the cost clock: each frame stays inside its slice and the proven
// canons equal those of an unsliced proof.
describe('013 B-09 WYSIWYG proofs in frame slices', () => {
  let wysiwyg: object
  beforeAll(() => {
    installModelSync()
    const real = createRealLute('wysiwyg')
    patchLuteTableCodePipes(real.lute)
    patchLuteGapRepair(real.lute)
    wysiwyg = countedLute(real.lute)
  })
  function wysiwygPair(): UnitLute {
    const factory = (unitLuteModule as unknown as Record<string, unknown>)
      .unitLuteOf
    if (typeof factory !== 'function')
      throw new Error('unit-lute exports no unitLuteOf (013-I1)')
    return (factory as (lute: object, mode: 'wysiwyg') => UnitLute)(
      wysiwyg,
      'wysiwyg',
    )
  }
  function build(markdown: string) {
    const root = document.createElement('div')
    root.className = 'vditor-reset vditor-wysiwyg'
    root.innerHTML = wysiwygFixture(markdown).root.innerHTML
    document.body.appendChild(root)
    const dom = createUnitDom(root, wysiwygPair(), {
      mode: 'wysiwyg',
    } as Parameters<typeof createUnitDom>[2])
    const model = createTextModel(dom, scanMovableBlocks)
    model.build(markdown)
    expect(model.state, String(model.offReason)).toBe('live')
    return { root, dom, model }
  }
  /** Every canon of the unit tree, in tree order. */
  const canons = (units: readonly Unit<HTMLElement>[]): string[] => {
    const out: string[] = []
    const visit = (unit: Unit<HTMLElement>): void => {
      out.push(`${unit.kind}:${unit.proof}:${unit.canon ?? ''}`)
      for (const child of unit.children) visit(child)
    }
    for (const unit of units) visit(unit)
    return out
  }

  // D-13 design 13.13: a table proof checks its deadline between rows, so one row is the indivisible
  // unit; the slice bound is FRAME_SLICE_MS + max(MAX_UNIT_MS, the fixture's largest row proof on the
  // cost clock): the cells of the widest row times the Lute charge of a call whose input is the
  // largest cell's one-cell table.
  const FRAME_SLICE_MS = 4
  const MAX_UNIT_MS = 2
  const CHARGES = { luteCallMs: 0.5, luteMsPer1000Chars: 0.1 }
  const CELL_SHELL =
    '<table data-block="0"><thead><tr><th></th></tr></thead></table>'.length
  function largestRowProofMs(root: HTMLElement): number {
    let widest = 0
    let largestCell = 0
    for (const row of Array.from(root.querySelectorAll('tr'))) {
      widest = Math.max(widest, row.children.length)
      for (const cell of Array.from(row.children))
        largestCell = Math.max(largestCell, cell.innerHTML.length)
    }
    return (
      widest *
      (CHARGES.luteCallMs +
        (CHARGES.luteMsPer1000Chars * (CELL_SHELL + largestCell)) / 1000)
    )
  }

  describe.each([1, 4, 16] as const)('at factor %i', (factor) => {
    it('keeps each frame within 4 ms plus its largest row proof and proves the same canons as an unsliced proof', () => {
      const markdown = tableHeavyMarkdown(factor)
      const clock = costClock(CHARGES)
      const frames: Array<() => void> = []
      const sliced = build(markdown)
      // The shared background scheduler (012-20) on the test's frames and cost clock.
      const scheduler = createBackgroundScheduler({
        now: () => clock.now(),
        requestAnimationFrame: (cb) => frames.push(cb),
        cancelAnimationFrame: () => undefined,
        requestIdle: () => 0,
        cancelIdle: () => undefined,
        inputPending: () => false,
      })
      const schedule = createUnitSchedule({
        scheduler,
        model: sliced.model,
        root: sliced.root,
        serialize: (kind, members) => sliced.dom.serialize(kind, members),
        htmlLength: (unit) =>
          unit.members.reduce((sum, el) => sum + el.outerHTML.length, 0),
        inViewport: () => false,
        isActive: () => true,
        drain: () => sliced.dom.drain(),
        requestAnimationFrame: (cb) => frames.push(cb),
        cancelAnimationFrame: () => undefined,
        now: () => clock.now(),
        setTimeout: () => 0,
        clearTimeout: () => undefined,
      })
      schedule.start()
      let maxSlice = 0
      let guard = 0
      while (frames.length > 0 && guard++ < 100_000) {
        const frame = frames.shift() as () => void
        const started = clock.now()
        const { counts } = countBudget(sliced.root, frame)
        maxSlice = Math.max(maxSlice, clock.now() - started)
        expect(counts.rootQueries, 'root queries per frame').toBe(0)
      }
      schedule.stop()
      expect(frames).toHaveLength(0)
      expect(maxSlice, 'slice ms').toBeLessThanOrEqual(
        FRAME_SLICE_MS + Math.max(MAX_UNIT_MS, largestRowProofMs(sliced.root)),
      )
      const whole = build(markdown)
      for (const unit of whole.model.units) whole.model.prove(unit)
      expect(canons(sliced.model.units)).toEqual(canons(whole.model.units))
    }, 120_000)
  })
})

// Task 733 / 021 (Q-187, D-4): the first key's caret text split (the first-position record) marks an
// unproven unit dirty before the pre-touch proof runs. A dirty unit whose serialized text is unchanged
// is proven, so the edit that follows publishes a delta. Fails before the repair: `fallback`.
describe('021: pre-touch proof of a dirty unit', () => {
  it('proves a dirty unit whose serialized text is unchanged, and that unit only', () => {
    const r = rig(4)
    r.units[2].dirty = true
    const range = document.createRange()
    range.selectNodeContents(r.units[2].el as Element)
    expect(r.schedule.proveForSelection(range)).toBe('proven')
    expect(r.units[2].proof).toBe('proven')
    expect(r.proofs).toEqual([r.units[2]])
  })
})
