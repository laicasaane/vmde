// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Unit, UnitKind } from './text-model'
import {
  createUnitSchedule,
  installPreTouchListeners,
  type UnitSchedule,
  type UnitScheduleDeps,
} from './unit-schedule'

// Task 733 / 004-B: idle proof slices, the pre-touch proof, its listeners and the rotating audit.
// The model is a small stub whose `prove` costs one fake millisecond, so the slice budget is exact.

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
  }
  const deps: UnitScheduleDeps = {
    model: {
      units,
      unitOf: (el) => byElement.get(el),
      prove: (unit) => {
        clock.t += 1
        if (!options.luteReady) return 'none'
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

  it('falls back for a dirty unit that is not proven', () => {
    const r = rig(4)
    r.units[2].dirty = true
    expect(r.schedule.proveForSelection(select(r.units[2].el as Element))).toBe(
      'fallback',
    )
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
