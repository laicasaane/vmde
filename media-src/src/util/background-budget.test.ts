// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { costClock, fakeLanes } from '../testing/budget-harness'
import {
  type BackgroundJob,
  type BackgroundJobName,
  type BackgroundLane,
  type BackgroundStats,
  backgroundSchedulerOf,
  createBackgroundScheduler,
  FRAME_SLICE_MS,
  IDLE_SLICE_MS,
  MAX_UNIT_MS,
  type SliceBudget,
} from './background-budget'

// Task 733 / 012-19, B-01 (D-13 design sections 1.1 and 5.2): the budgeted background scheduler.
// The job types come from the module; the scheduler interface below is the one of shared rules
// section 3.10, and the module is checked against it.

interface BackgroundScheduler {
  post(job: BackgroundJob): void
  cancel(job: BackgroundJob): void
  stats(name: BackgroundJobName): BackgroundStats
}
interface BackgroundBudgetModule {
  FRAME_SLICE_MS: number
  IDLE_SLICE_MS: number
  MAX_UNIT_MS: number
  createBackgroundScheduler(
    deps: ReturnType<typeof fakeLanes>,
  ): BackgroundScheduler
  backgroundSchedulerOf(win: Window): BackgroundScheduler
}

const load = async (): Promise<BackgroundBudgetModule> => ({
  FRAME_SLICE_MS,
  IDLE_SLICE_MS,
  MAX_UNIT_MS,
  createBackgroundScheduler,
  backgroundSchedulerOf,
})

const UNITS = 2000
const UNIT_MS = 1

/** A job of `units` units of `unitMs` each on the cost clock; it checks the budget before each unit. */
function unitJob(
  name: BackgroundJobName,
  lane: BackgroundLane,
  clock: { advance(ms: number): void },
  log: BackgroundJobName[],
  units = UNITS,
  unitMs = UNIT_MS,
) {
  let cursor = 0
  const job = {
    name,
    lane,
    steps: 0,
    get done() {
      return cursor
    },
    step(budget: SliceBudget): boolean {
      job.steps++
      while (cursor < units) {
        if (budget.spent()) return true
        clock.advance(unitMs)
        log.push(name)
        cursor++
      }
      return false
    },
  }
  return job
}

/** The 3-frame windows in which a job with work left ran no unit (empty when every job was served). */
function unservedWindows(
  perFrame: BackgroundJobName[][],
  names: BackgroundJobName[],
): string[] {
  const done = new Map(names.map((name) => [name, 0]))
  const missed: string[] = []
  for (let frame = 0; frame + 3 <= perFrame.length; frame++) {
    const served = new Set(perFrame.slice(frame, frame + 3).flat())
    for (const name of names)
      if ((done.get(name) ?? 0) < UNITS && !served.has(name))
        missed.push(`${name} in frames ${frame} to ${frame + 2}`)
    for (const unit of perFrame[frame])
      done.set(unit, (done.get(unit) ?? 0) + 1)
  }
  return missed
}

const NAMES: BackgroundJobName[] = [
  'unit-proof',
  'table-membership',
  'wrap-hints',
]

describe('B-01 background scheduler: frame lane', () => {
  it('exports the slice constants of the design', async () => {
    const budget = await load()
    expect(budget.FRAME_SLICE_MS).toBe(4)
    expect(budget.IDLE_SLICE_MS).toBe(8)
    expect(budget.MAX_UNIT_MS).toBe(2)
  })

  it('shares one 4 ms budget per frame between 3 jobs of 2,000 units, round-robin, with no overrun', async () => {
    const budget = await load()
    const clock = costClock()
    const lanes = fakeLanes(clock)
    const scheduler = budget.createBackgroundScheduler(lanes)
    const log: BackgroundJobName[] = []
    const jobs = NAMES.map((name) => unitJob(name, 'frame', clock, log))
    for (const job of jobs) scheduler.post(job)
    const perFrame: BackgroundJobName[][] = []
    for (
      let frame = 0;
      frame < 3 * UNITS && jobs.some((j) => j.done < UNITS);
      frame++
    ) {
      const start = clock.now()
      const before = log.length
      lanes.runFrame()
      expect(
        clock.now() - start,
        `frame ${frame} slice ms`,
      ).toBeLessThanOrEqual(budget.FRAME_SLICE_MS + budget.MAX_UNIT_MS)
      perFrame.push(log.slice(before))
    }
    for (const job of jobs) expect(job.done).toBe(UNITS)
    // Every job that still had work is served within any 3 consecutive frames.
    expect(unservedWindows(perFrame, NAMES)).toEqual([])
    // Round-robin: the first three frames start with three different jobs.
    expect(new Set(perFrame.slice(0, 3).map((units) => units[0])).size).toBe(3)
    for (const name of NAMES) {
      const stats = scheduler.stats(name)
      expect(stats.overruns, `${name} overruns`).toBe(0)
      expect(stats.slices, `${name} slices`).toBeGreaterThan(0)
      expect(stats.maxSliceMs, `${name} maxSliceMs`).toBeLessThanOrEqual(
        budget.FRAME_SLICE_MS + budget.MAX_UNIT_MS,
      )
    }
  })

  it('ends the slice before the next unit when input is pending', async () => {
    const budget = await load()
    const clock = costClock()
    const lanes = fakeLanes(clock)
    const scheduler = budget.createBackgroundScheduler(lanes)
    const log: BackgroundJobName[] = []
    const job = unitJob('unit-proof', 'frame', clock, log)
    lanes.inputPending = () => log.length >= 2
    scheduler.post(job)
    lanes.runFrame()
    expect(job.done).toBe(2)
    lanes.inputPending = () => false
    lanes.runFrame()
    expect(job.done).toBe(6)
  })

  it('does not queue a queued job twice and does not step a finished job again', async () => {
    const budget = await load()
    const clock = costClock()
    const lanes = fakeLanes(clock)
    const scheduler = budget.createBackgroundScheduler(lanes)
    const log: BackgroundJobName[] = []
    const job = unitJob('wrap-hints', 'frame', clock, log, 6)
    scheduler.post(job)
    scheduler.post(job)
    lanes.runFrame()
    expect(job.done).toBe(4)
    const stepsAfterFirst = job.steps
    expect(stepsAfterFirst).toBe(1)
    lanes.runFrame()
    expect(job.done).toBe(6)
    const steps = job.steps
    for (let frame = 0; frame < 3; frame++) lanes.runFrame()
    expect(job.steps).toBe(steps)
  })

  it('cancel removes a job, which keeps its cursor when posted again', async () => {
    const budget = await load()
    const clock = costClock()
    const lanes = fakeLanes(clock)
    const scheduler = budget.createBackgroundScheduler(lanes)
    const log: BackgroundJobName[] = []
    const job = unitJob('table-membership', 'frame', clock, log, 10)
    scheduler.post(job)
    lanes.runFrame()
    expect(job.done).toBe(4)
    scheduler.cancel(job)
    lanes.runFrame()
    expect(job.done).toBe(4)
    scheduler.post(job)
    lanes.runFrame()
    expect(job.done).toBe(8)
  })

  it('counts an overrun when a unit ends more than 2 ms past the deadline', async () => {
    const budget = await load()
    const clock = costClock()
    const lanes = fakeLanes(clock)
    const scheduler = budget.createBackgroundScheduler(lanes)
    const job = unitJob('diagram-report', 'frame', clock, [], 3, 7)
    scheduler.post(job)
    lanes.runFrame()
    expect(scheduler.stats('diagram-report').overruns).toBe(1)
    expect(scheduler.stats('diagram-report').maxSliceMs).toBe(7)
  })

  it('drops a job whose step throws and keeps serving the others', async () => {
    const budget = await load()
    const clock = costClock()
    const lanes = fakeLanes(clock)
    const scheduler = budget.createBackgroundScheduler(lanes)
    let thrown = 0
    const failing: BackgroundJob = {
      name: 'fold-apply',
      lane: 'frame',
      step() {
        thrown++
        throw new Error('step failed')
      },
    }
    const log: BackgroundJobName[] = []
    const other = unitJob('unit-audit', 'frame', clock, log, 12)
    scheduler.post(failing)
    scheduler.post(other)
    for (let frame = 0; frame < 4; frame++) lanes.runFrame()
    expect(thrown).toBe(1)
    expect(other.done).toBe(12)
  })
})

describe('B-01 background scheduler: idle lane', () => {
  it.each([3, 8, 20])(
    'an idle callback with %i ms remaining runs a slice of at most min(t, 8) + 2 ms',
    async (remaining) => {
      const budget = await load()
      const clock = costClock()
      const lanes = fakeLanes(clock)
      const scheduler = budget.createBackgroundScheduler(lanes)
      const log: BackgroundJobName[] = []
      const jobs = (
        ['table-fill', 'table-normalize', 'fold-glyphs'] as const
      ).map((name) => unitJob(name, 'idle', clock, log))
      for (const job of jobs) scheduler.post(job)
      // Idle jobs never run in a frame.
      lanes.runFrame()
      expect(log.length).toBe(0)
      for (let callback = 0; callback < 20; callback++) {
        const start = clock.now()
        lanes.runIdle(remaining)
        expect(
          clock.now() - start,
          `idle callback ${callback}`,
        ).toBeLessThanOrEqual(
          Math.min(remaining, budget.IDLE_SLICE_MS) + budget.MAX_UNIT_MS,
        )
      }
      expect(new Set(log)).toEqual(new Set(jobs.map((job) => job.name)))
      for (const job of jobs) expect(scheduler.stats(job.name).overruns).toBe(0)
    },
  )
})

describe('backgroundSchedulerOf', () => {
  it('returns one scheduler per window', async () => {
    const budget = await load()
    expect(budget.backgroundSchedulerOf(window)).toBe(
      budget.backgroundSchedulerOf(window),
    )
  })
})
