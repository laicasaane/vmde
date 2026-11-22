// Task 733 / 012-19 (D-13 design section 1.1, shared rules 3.10): one budgeted scheduler for the
// webview's background work. Each module used to keep its own slice (the unit proofs, the table
// fill, the wrap hints, the fold glyphs), and the slices added up inside one frame. Jobs posted here
// share one budget per animation frame and one per idle callback, served round-robin so no job
// starves another. Edit-path work and per-frame work bound to a change scope are not jobs.
//
// Allocation (rule 4): the lane queues are reused arrays, `post` on a queued job is a set test, the
// budget object is created once per scheduler. Per-job statistics exist only for a scheduler made
// by `createBackgroundScheduler` (tests) or in end-to-end runs (`__vmdeE2EReadiness`).

export type BackgroundLane = 'frame' | 'idle'
export type BackgroundJobName =
  | 'unit-proof'
  | 'unit-audit'
  | 'proof-queue'
  | 'table-fill'
  | 'table-normalize'
  | 'table-membership'
  | 'wrap-hints'
  | 'diagram-report'
  | 'diagram-decorate'
  | 'fold-apply'
  | 'fold-glyphs'
  // Task 733 / 017: the definition index's reference build (idle) and dependent re-render (frame).
  | 'definition-references'
  | 'definition-dependents'
  // Task 733 / 015: the whole Split pane render and the Source model build (task 015 section 6.2 D-8).
  | 'split-preview'
  | 'source-build'
  // Task 733 / 036 (fix design 2.2): the idle normalized hunk check and plan dry run of a Find record.
  | 'find-hunks'
export interface SliceBudget {
  /** True when the slice is spent (clock at or past the deadline) or input is pending. O(1), no allocation.
   *  A job calls it before each unit of work in every loop, collection loops included. */
  spent(): boolean
}
export interface BackgroundJob {
  readonly name: BackgroundJobName
  readonly lane: BackgroundLane
  /** Works until `budget.spent()`, keeps its own cursor; true when work is left. A step that throws is
   *  dropped (counted in stats) and not queued again. */
  step(budget: SliceBudget): boolean
}
export interface BackgroundStats {
  readonly slices: number
  readonly overruns: number
  readonly maxSliceMs: number
}
export interface BackgroundScheduler {
  /** Queues `job` on its lane; a queued job is not queued twice; no allocation after the job's first post. */
  post(job: BackgroundJob): void
  /** Removes `job`; the job keeps its cursor. */
  cancel(job: BackgroundJob): void
  /** Counts per job name (tests and end-to-end runs only; kinds and counts, SR-5). */
  stats(name: BackgroundJobName): BackgroundStats
}
export interface BackgroundSchedulerDeps {
  now(): number
  requestAnimationFrame(callback: () => void): number
  cancelAnimationFrame(handle: number): void
  requestIdle(callback: (deadline: { timeRemaining(): number }) => void): number
  cancelIdle(handle: number): void
  inputPending(): boolean
}
/** One budget per animation frame, shared by every frame job. */
export const FRAME_SLICE_MS = 4
/** One budget per idle callback: min(timeRemaining(), 8). */
export const IDLE_SLICE_MS = 8
/** A slice that ends more than this past its deadline counts an overrun. */
export const MAX_UNIT_MS = 2

interface MutableStats {
  slices: number
  overruns: number
  maxSliceMs: number
}

const NO_STATS: BackgroundStats = Object.freeze({
  slices: 0,
  overruns: 0,
  maxSliceMs: 0,
})

function createScheduler(
  deps: BackgroundSchedulerDeps,
  statsByName: Map<BackgroundJobName, MutableStats> | undefined,
): BackgroundScheduler {
  const queues: Record<BackgroundLane, BackgroundJob[]> = {
    frame: [],
    idle: [],
  }
  // Index of the job to serve first in the lane's next slice: the one after the job that ran last.
  const nextIndex: Record<BackgroundLane, number> = { frame: 0, idle: 0 }
  const queued = new Set<BackgroundJob>()
  let frameHandle = 0
  let idleHandle = 0
  let deadline = 0
  const budget: SliceBudget = {
    spent: () => deps.now() >= deadline || deps.inputPending(),
  }

  const record = (job: BackgroundJob, start: number, end: number): void => {
    if (!statsByName) return
    let stats = statsByName.get(job.name)
    if (!stats) {
      stats = { slices: 0, overruns: 0, maxSliceMs: 0 }
      statsByName.set(job.name, stats)
    }
    stats.slices++
    if (end > deadline + MAX_UNIT_MS) stats.overruns++
    if (end - start > stats.maxSliceMs) stats.maxSliceMs = end - start
  }

  const remove = (lane: BackgroundLane, index: number): void => {
    const job = queues[lane][index]
    queues[lane].splice(index, 1)
    queued.delete(job)
  }

  /** Serves the lane's jobs round-robin until the slice is spent; each job steps at most once per slice. */
  const runLane = (lane: BackgroundLane): void => {
    const queue = queues[lane]
    let index = nextIndex[lane]
    let remaining = queue.length
    while (remaining > 0 && queue.length > 0 && !budget.spent()) {
      if (index >= queue.length) index = 0
      const job = queue[index]
      remaining--
      const start = deps.now()
      let more: boolean
      try {
        more = job.step(budget)
      } catch {
        // A failing job is dropped so it cannot fail every later slice too.
        more = false
      }
      record(job, start, deps.now())
      if (more) index++
      else remove(lane, index)
    }
    nextIndex[lane] = queue.length > 0 ? index % queue.length : 0
    request(lane)
  }

  const onFrame = (): void => {
    frameHandle = 0
    deadline = deps.now() + FRAME_SLICE_MS
    runLane('frame')
  }

  const onIdle = (idle: { timeRemaining(): number }): void => {
    idleHandle = 0
    deadline = deps.now() + Math.min(idle.timeRemaining(), IDLE_SLICE_MS)
    runLane('idle')
  }

  function request(lane: BackgroundLane): void {
    if (queues[lane].length === 0) return
    if (lane === 'frame') {
      if (frameHandle === 0) frameHandle = deps.requestAnimationFrame(onFrame)
    } else if (idleHandle === 0) idleHandle = deps.requestIdle(onIdle)
  }

  return {
    post(job) {
      if (queued.has(job)) return
      queued.add(job)
      queues[job.lane].push(job)
      request(job.lane)
    },
    cancel(job) {
      if (!queued.has(job)) return
      const queue = queues[job.lane]
      remove(job.lane, queue.indexOf(job))
      if (queue.length > 0) return
      if (job.lane === 'frame' && frameHandle !== 0) {
        deps.cancelAnimationFrame(frameHandle)
        frameHandle = 0
      } else if (job.lane === 'idle' && idleHandle !== 0) {
        deps.cancelIdle(idleHandle)
        idleHandle = 0
      }
    },
    stats(name) {
      return statsByName?.get(name) ?? NO_STATS
    },
  }
}

/** A scheduler on `deps` that keeps per-job statistics (tests). */
export function createBackgroundScheduler(
  deps: BackgroundSchedulerDeps,
): BackgroundScheduler {
  return createScheduler(deps, new Map())
}

interface BackgroundWindow {
  __vmdeE2EReadiness?: unknown
  /** End-to-end runs only: slices, overruns and the largest slice per job name (counts, SR-5). */
  __vmdeBackgroundStats?: Record<string, BackgroundStats>
}

interface InputScheduling {
  scheduling?: { isInputPending?: () => boolean }
}

// Without `requestIdleCallback` (jsdom, older engines) an idle slice runs from a short timer with
// the full idle budget, as `chrome/responsive-tables.ts` `requestIdle` does.
const IDLE_FALLBACK_MS = 50

function windowDeps(win: Window): BackgroundSchedulerDeps {
  const timers = new Map<number, number>()
  let nextTimer = 1
  return {
    now: () => win.performance.now(),
    requestAnimationFrame: (callback) => win.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => win.cancelAnimationFrame(handle),
    requestIdle(callback) {
      if (typeof win.requestIdleCallback === 'function')
        return win.requestIdleCallback(callback)
      const handle = nextTimer++
      const timer = win.setTimeout(() => {
        timers.delete(handle)
        const started = win.performance.now()
        callback({
          timeRemaining: () =>
            Math.max(0, started + IDLE_SLICE_MS - win.performance.now()),
        })
      }, IDLE_FALLBACK_MS)
      timers.set(handle, timer)
      return handle
    },
    cancelIdle(handle) {
      if (typeof win.cancelIdleCallback === 'function') {
        win.cancelIdleCallback(handle)
        return
      }
      const timer = timers.get(handle)
      if (timer !== undefined) win.clearTimeout(timer)
      timers.delete(handle)
    },
    inputPending: () =>
      (win.navigator as InputScheduling).scheduling?.isInputPending?.() ??
      false,
  }
}

const schedulers = new WeakMap<Window, BackgroundScheduler>()

/** One scheduler per Window (WeakMap), with the browser services; `requestIdle` falls back to a timer. */
export function backgroundSchedulerOf(win: Window): BackgroundScheduler {
  let scheduler = schedulers.get(win)
  if (!scheduler) {
    const bg = win as unknown as BackgroundWindow
    let statsByName: Map<BackgroundJobName, MutableStats> | undefined
    if (bg.__vmdeE2EReadiness) {
      const stats = new Map<BackgroundJobName, MutableStats>()
      statsByName = stats
      // Read by the real-VS-Code counter spec; a live view of the per-name records.
      Object.defineProperty(bg, '__vmdeBackgroundStats', {
        configurable: true,
        get: () => Object.fromEntries(stats),
      })
    }
    scheduler = createScheduler(windowDeps(win), statsByName)
    schedulers.set(win, scheduler)
  }
  return scheduler
}
