// Task 733 / 036 (fix design 4.2): the time account of an exact history replay. Every atomic is timed
// end to end and kept per cost class (running maximum fixed cost and cost per KB, reported; the medians
// of fixed cost and cost per KB and the second-largest fixed sample of the last 16, used), so the
// scheduler packs atomics into a frame while their worst-case cost fits what is left of the task's budget
// (036 core C10, R-1). H2 fix design rev2 (D5.1, D5.2): elapsed time only packs frames and
// counts misses; it never refuses a group (no estimate guarantees 50 ms: measured long tasks do). Deferred callbacks
// that a replay write causes (a refold, a resize observer, a decorator pass) are marked with `expect`
// and timed inside `charged`; their time is charged to the task they run in and carried into the next
// frame's catch-up budget. A task whose replay-attributed work exceeds the budget counts one
// `budget-miss`. Pure: the clock is injected.

/** Replay work per task, emission and charged deferred work included (4.2). */
export const REPLAY_BUDGET_MS = 15

type ReplayCostClass =
  | 'leaf'
  | 'list-run'
  | 'table'
  | 'code'
  | 'count-change'
  | 'endpoint-render'
  | 'whole-post'
  /** Deferred work charged to the replay (refold, resize, decorators, proof lane). */
  | 'deferred'
  /** H2 fix design rev2 (D9.2): the scoped change a replay frame emits, and its listeners. */
  | 'emission'
  /** H2 fix design rev2 (D8.1): the one outline render deferred to after a replay's last group. */
  | 'outline'

interface ReplayClassStats {
  readonly atomics: number
  readonly fixedMaxMs: number
  readonly perKbMaxMs: number
  readonly maxMs: number
  /** H2 fix design rev2 (D5.2): the median of the last `SAMPLES` atomics (reported). */
  readonly medianMs: number
  /** 036 core C10 (R-1): the median fixed cost (samples under 1 KB) and the median cost per KB. */
  readonly fixedMedianMs: number
  readonly perKbMedianMs: number
  /** 036 core C10 (R-1): the second-largest fixed-cost sample of the last `SAMPLES`. */
  readonly secondMaxFixedMs: number
}

/**
 * 036 core C10 (R2.5, K14): one frame or charged region that missed the budget, numbers only. `classMs` and
 * `classCount` cover every class, so their sum is the frame's work unless the record is `unattributed`.
 */
interface ReplayMissRecord {
  readonly frameWorkMs: number
  readonly classMs: Readonly<Partial<Record<ReplayCostClass, number>>>
  readonly classCount: Readonly<Partial<Record<ReplayCostClass, number>>>
  readonly largestMs: number
  readonly largestCls: ReplayCostClass | undefined
  /** Exactly one non-emission atomic ran in the frame. */
  readonly forcedAlone: boolean
  /** A charged region outside a frame. */
  readonly outside: boolean
  readonly unattributed: boolean
}

interface ReplayBudgetStats {
  readonly budgetMisses: number
  readonly carriedMs: number
  readonly open: boolean
  readonly marks: number
  readonly classes: Readonly<Partial<Record<ReplayCostClass, ReplayClassStats>>>
  /** Longest replay-attributed work of one task. */
  readonly maxTaskMs: number
  /** 036 core C2 (R31.2): `finish` calls whose token was not the current owner; they changed nothing. */
  readonly staleFinish: number
  /** 036 core C10 (R2.5): misses classified when written; these counters never wrap. */
  readonly missK14: number
  readonly missOther: number
  /** The last `SAMPLES` miss records; `missLogDropped` counts the overwritten ones. */
  readonly missLog: readonly ReplayMissRecord[]
  readonly missLogDropped: number
  /**
   * 036 core C10 (R2.5 gate): every miss is a K14 miss, every miss is classified and no record was
   * overwritten. Only then may a gate exempt the misses as K14.
   */
  readonly k14Exempt: boolean
}

export interface ReplayBudget {
  /**
   * A replay or a recovery starts: the account opens and the caller becomes its owner. 036 core C2 (R31.2):
   * the returned token names that owner; a later `open` takes the ownership over.
   */
  open(): number
  /**
   * The owner's last atomic and acknowledgement are done; the account closes once no mark is left. A token
   * that is not the current owner (a replay stopped after recovery opened the account) is stale: it is
   * counted `staleFinish` and changes nothing.
   */
  finish(token: number): void
  /** Open: a replay runs, or a marked deferred callback has not run yet. O(1). */
  isOpen(): boolean
  /** Starts the catch-up work of one frame; returns the time this frame may use (`B - carried`). */
  beginFrame(): number
  /** Ends the frame's own work; counts a miss when the task's replay work exceeded the budget. */
  endFrame(): void
  /**
   * True when the atomic's worst-case cost fits what is left of the frame, with the emission and deferred
   * estimates reserved (036 core C10, R-1). Packing only: the caller always runs one atomic per frame.
   */
  admit(cls: ReplayCostClass, sizeKb: number): boolean
  /**
   * Task 733 / 036 (step D, 4.3): what remains of the budget for charged deferred work now. Inside a frame,
   * the frame's allowance less its work; after it, also less what was charged since. Before the replay's
   * first frame, the budget less what was charged. O(1).
   */
  remainingMs(): number
  /** Times one atomic (inside a frame), records its class cost and returns its result. */
  atomic<T>(cls: ReplayCostClass, sizeKb: number, fn: () => T): T
  /** A replay write scheduled a deferred callback: one mark. O(1). */
  expect(): void
  /** The scheduler dropped a marked callback: the mark is released. */
  release(): void
  /**
   * Runs a deferred callback; when the account is open it is timed (outermost region only) and charged
   * to `cls` (default `deferred`). Inside a frame it is frame work; outside one it is one region, a miss
   * when over the budget (D9.3). One field read when the account is closed.
   */
  charged<T>(fn: () => T, marked?: boolean, cls?: ReplayCostClass): T
  /** An input's endpoint renders and pre-touch took `ms`; a miss when over the budget (4.2). */
  noteInput(ms: number): void
  stats(): ReplayBudgetStats
}

/** Samples per class the median estimate reads (D5.2). */
const SAMPLES = 16

interface MutableClass {
  atomics: number
  fixedMaxMs: number
  perKbMaxMs: number
  maxMs: number
  medianMs: number
  /** The last `SAMPLES` atomic times, a ring written at `atomics % SAMPLES`. */
  readonly ring: Float64Array
  /** Scratch for the median: sorted copy of the ring's filled part. */
  readonly sorted: Float64Array
  // 036 core C10 (R-1): fixed-cost samples (under 1 KB) and per-KB rates, each a ring of `SAMPLES`.
  fixedCount: number
  readonly fixedRing: Float64Array
  rateCount: number
  readonly rateRing: Float64Array
  fixedMedianMs: number
  perKbMedianMs: number
  secondMaxFixedMs: number
}

/** The classes a miss record covers, in a fixed order (their index is the accumulator slot). */
const CLASSES: readonly ReplayCostClass[] = [
  'leaf',
  'list-run',
  'table',
  'code',
  'count-change',
  'endpoint-render',
  'whole-post',
  'deferred',
  'emission',
  'outline',
]
const CLASS_INDEX = new Map(CLASSES.map((cls, index) => [cls, index]))
/** The atomics a K14 exemption may name: one unit render that cannot be split. */
const K14_ATOMIC = new Set<ReplayCostClass>([
  'leaf',
  'list-run',
  'table',
  'code',
  'endpoint-render',
])
/** K14 covers a miss up to G1's 50 ms only. */
const K14_MAX_MS = 50
/** The class sums must equal the frame's work within this (R2.5). */
const ATTRIBUTION_SLACK_MS = 0.5

/** The second-largest of the first `n` entries of `ring`. O(n), no allocation. */
function secondLargest(ring: Float64Array, n: number): number {
  let first = 0
  let second = 0
  for (let i = 0; i < n; i++) {
    const v = ring[i]
    if (v > first) {
      second = first
      first = v
    } else if (v > second) second = v
  }
  return second
}

/** The upper median of the first `n` entries of `ring`, sorted in `out` by insertion (n <= 16). */
function medianOf(ring: Float64Array, n: number, out: Float64Array): number {
  for (let i = 0; i < n; i++) {
    const v = ring[i]
    let j = i - 1
    while (j >= 0 && out[j] > v) {
      out[j + 1] = out[j]
      j--
    }
    out[j + 1] = v
  }
  return out[n >> 1]
}

/** The reported class stats, without the sample buffers. */
function statsOf(
  classes: Partial<Record<ReplayCostClass, MutableClass>>,
): Partial<Record<ReplayCostClass, ReplayClassStats>> {
  const out: Partial<Record<ReplayCostClass, ReplayClassStats>> = {}
  for (const key of Object.keys(classes) as ReplayCostClass[]) {
    const entry = classes[key]
    if (!entry) continue
    const {
      atomics,
      fixedMaxMs,
      perKbMaxMs,
      maxMs,
      medianMs,
      fixedMedianMs,
      perKbMedianMs,
      secondMaxFixedMs,
    } = entry
    out[key] = {
      atomics,
      fixedMaxMs,
      perKbMaxMs,
      maxMs,
      medianMs,
      fixedMedianMs,
      perKbMedianMs,
      secondMaxFixedMs,
    }
  }
  return out
}

export function createReplayBudget(deps: {
  now(): number
  budgetMs?: number
}): ReplayBudget {
  const budget = deps.budgetMs ?? REPLAY_BUDGET_MS
  const classes: Partial<Record<ReplayCostClass, MutableClass>> = {}
  let open = false
  // 036 core C2 (R31.2): the token of the current owner; 0 when none.
  let owner = 0
  let tokens = 0
  let staleFinish = 0
  let marks = 0
  let depth = 0
  let carried = 0
  let misses = 0
  let maxTask = 0
  // Inside a frame: when it started and the replay work of the task so far.
  let inFrame = false
  let frameAllowance = 0
  let taskWork = 0
  // A frame began since the account opened (`remainingMs` before the first frame).
  let framed = false

  const classOf = (cls: ReplayCostClass): MutableClass => {
    let entry = classes[cls]
    if (!entry) {
      entry = {
        atomics: 0,
        fixedMaxMs: 0,
        perKbMaxMs: 0,
        maxMs: 0,
        medianMs: 0,
        ring: new Float64Array(SAMPLES),
        sorted: new Float64Array(SAMPLES),
        fixedCount: 0,
        fixedRing: new Float64Array(SAMPLES),
        rateCount: 0,
        rateRing: new Float64Array(SAMPLES),
        fixedMedianMs: 0,
        perKbMedianMs: 0,
        secondMaxFixedMs: 0,
      }
      classes[cls] = entry
    }
    return entry
  }
  const record = (cls: ReplayCostClass, sizeKb: number, ms: number): void => {
    const entry = classOf(cls)
    entry.ring[entry.atomics % SAMPLES] = ms
    entry.atomics++
    entry.medianMs = medianOf(
      entry.ring,
      Math.min(entry.atomics, SAMPLES),
      entry.sorted,
    )
    entry.maxMs = Math.max(entry.maxMs, ms)
    // Below 1 KB the size term is negligible: the sample is fixed cost. Above it, what exceeds the known
    // fixed cost is cost per KB.
    if (sizeKb < 1) {
      entry.fixedMaxMs = Math.max(entry.fixedMaxMs, ms)
      // 036 core C10 (R-1): the fixed-cost median and the second-largest fixed sample (one outlier ignored).
      entry.fixedRing[entry.fixedCount % SAMPLES] = ms
      entry.fixedCount++
      const n = Math.min(entry.fixedCount, SAMPLES)
      entry.fixedMedianMs = medianOf(entry.fixedRing, n, entry.sorted)
      entry.secondMaxFixedMs = secondLargest(entry.fixedRing, n)
    } else {
      entry.perKbMaxMs = Math.max(
        entry.perKbMaxMs,
        (ms - entry.fixedMaxMs) / sizeKb,
      )
      entry.rateRing[entry.rateCount % SAMPLES] = Math.max(
        0,
        (ms - entry.fixedMedianMs) / sizeKb,
      )
      entry.rateCount++
      entry.perKbMedianMs = medianOf(
        entry.rateRing,
        Math.min(entry.rateCount, SAMPLES),
        entry.sorted,
      )
    }
  }
  /**
   * 036 core C10 (R-1, C10 review item 3): the worst-case cost of one more atomic. Twice the median model,
   * or the second-largest fixed sample plus the size term (two slow small leaves count, one outlier does
   * not), and never less than half the frame: the first slow small leaf of a run cannot be predicted from
   * earlier samples, so an atomic is packed only while half the frame is still free. O(1).
   */
  const worstCost = (cls: ReplayCostClass, sizeKb: number): number => {
    const entry = classes[cls]
    const size = (entry?.perKbMedianMs ?? 0) * sizeKb
    const model = 2 * ((entry?.fixedMedianMs ?? 0) + size)
    const slow = (entry?.secondMaxFixedMs ?? 0) + size
    return Math.max(model, slow, frameAllowance / 2)
  }

  /**
   * 036 core C10 (R-1, measured x4 misses of 3.2 and 9.1 ms emission against a 0.5 ms median): the reserve
   * of the frame's emission is its median or its second-largest sample, whichever is larger, so two slow
   * emissions count and one outlier does not. Charged deferred work keeps its median: its second-largest
   * sample (3.2-3.9 ms against a 0.1-0.4 ms median at x4) halved the packing and lengthened catch-up
   * (A/B: 47-60 against 28-36 frames). O(1).
   */
  const reserve = (cls: ReplayCostClass): number => {
    const entry = classes[cls]
    return entry ? Math.max(entry.fixedMedianMs, entry.secondMaxFixedMs) : 0
  }

  // ---- 036 core C10 (R2.5, C10 review item 4): per-frame attribution of a miss ----
  const frameMs = new Float64Array(CLASSES.length)
  const frameCount = new Int32Array(CLASSES.length)
  let frameLargest = 0
  let frameLargestCls: ReplayCostClass | undefined
  let missK14 = 0
  let missOther = 0
  let missDropped = 0
  const missLog: ReplayMissRecord[] = []
  const resetFrameClasses = (): void => {
    frameMs.fill(0)
    frameCount.fill(0)
    frameLargest = 0
    frameLargestCls = undefined
  }
  const noteClass = (cls: ReplayCostClass, ms: number): void => {
    const index = CLASS_INDEX.get(cls)
    if (index === undefined) return
    frameMs[index] += ms
    frameCount[index]++
    if (ms > frameLargest) {
      frameLargest = ms
      frameLargestCls = cls
    }
  }
  // The tallies of the frame being recorded (one object, reused).
  const tally = { sum: 0, atomics: 0, other: 0, eligible: 0 }
  /** Copies the frame's class sums into the record's maps and tallies them. */
  const tallyFrame = (
    classMs: Partial<Record<ReplayCostClass, number>>,
    classCount: Partial<Record<ReplayCostClass, number>>,
  ): void => {
    tally.sum = 0
    tally.atomics = 0
    tally.other = 0
    tally.eligible = 0
    for (let i = 0; i < CLASSES.length; i++) {
      if (frameCount[i] === 0) continue
      const cls = CLASSES[i]
      classMs[cls] = frameMs[i]
      classCount[cls] = frameCount[i]
      tally.sum += frameMs[i]
      if (cls === 'emission') continue
      tally.atomics += frameCount[i]
      if (K14_ATOMIC.has(cls)) tally.eligible += frameCount[i]
      else tally.other += frameCount[i]
    }
  }
  /**
   * K14: exactly one eligible atomic over the budget with only its measured emission beside it, or one
   * outline region outside a frame; never over G1's 50 ms, never unattributed.
   */
  const isK14 = (record: ReplayMissRecord): boolean => {
    if (record.unattributed || record.frameWorkMs > K14_MAX_MS) return false
    if (record.outside)
      return tally.atomics === 1 && (record.classCount.outline ?? 0) === 1
    if (emissionSpike(record)) return true
    return (
      record.forcedAlone &&
      tally.eligible === 1 &&
      tally.other === 0 &&
      record.largestMs > budget &&
      record.largestCls !== undefined &&
      K14_ATOMIC.has(record.largestCls)
    )
  }
  /**
   * Orchestrator Q-277 (provisional): one attributed emission spike: the frame's single emission over its
   * reserve took it past the budget, its other work fit the budget, and the frame stayed under 50 ms.
   */
  const emissionSpike = (record: ReplayMissRecord): boolean => {
    const emission = record.classMs.emission ?? 0
    return (
      (record.classCount.emission ?? 0) === 1 &&
      tally.other === 0 &&
      record.frameWorkMs - emission <= budget &&
      emission > reserve('emission')
    )
  }
  /** One miss: its record (allocated only on a miss) and its classification. */
  const recordMiss = (workMs: number, outside: boolean): void => {
    const classMs: Partial<Record<ReplayCostClass, number>> = {}
    const classCount: Partial<Record<ReplayCostClass, number>> = {}
    tallyFrame(classMs, classCount)
    const record: ReplayMissRecord = {
      frameWorkMs: workMs,
      classMs,
      classCount,
      largestMs: frameLargest,
      largestCls: frameLargestCls,
      forcedAlone: !outside && tally.atomics === 1,
      outside,
      unattributed: Math.abs(tally.sum - workMs) > ATTRIBUTION_SLACK_MS,
    }
    if (isK14(record)) missK14++
    else missOther++
    if (missLog.length === SAMPLES) {
      missLog.shift()
      missDropped++
    }
    missLog.push(record)
  }
  /** Charged work outside a frame: it belongs to the task it ran in and reduces the next catch-up. */
  const chargeOutside = (ms: number, cls: ReplayCostClass): void => {
    carried += ms
    maxTask = Math.max(maxTask, ms)
    if (ms <= budget) return
    misses++
    resetFrameClasses()
    noteClass(cls, ms)
    recordMiss(ms, true)
    resetFrameClasses()
  }
  const closeIfDone = (): void => {
    if (!open && marks === 0) carried = 0
  }

  return {
    open() {
      open = true
      framed = false
      tokens++
      owner = tokens
      return owner
    },
    finish(token) {
      if (token !== owner) {
        staleFinish++
        return
      }
      owner = 0
      open = false
      closeIfDone()
    },
    isOpen: () => open || marks > 0,
    beginFrame() {
      inFrame = true
      framed = true
      taskWork = 0
      resetFrameClasses()
      // A carried charge only reduces this frame's catch-up; it never shortens a task that already ran.
      frameAllowance = Math.max(0, budget - carried)
      carried = 0
      return frameAllowance
    },
    endFrame() {
      if (!inFrame) return
      inFrame = false
      maxTask = Math.max(maxTask, taskWork)
      if (taskWork > budget) {
        misses++
        recordMiss(taskWork, false)
      }
    },
    admit(cls, sizeKb) {
      // S4 repair (fix 6): the frame's emission is reserved by its own estimate; R-1 also reserves the
      // charged deferred work and uses the worst-case cost of the atomic.
      return (
        taskWork +
          worstCost(cls, sizeKb) +
          reserve('emission') +
          (classes.deferred?.fixedMedianMs ?? 0) <=
        frameAllowance
      )
    },
    remainingMs() {
      if (!framed) return Math.max(0, budget - carried)
      if (inFrame) return Math.max(0, frameAllowance - taskWork)
      return Math.max(0, frameAllowance - taskWork - carried)
    },
    atomic(cls, sizeKb, fn) {
      const started = deps.now()
      depth++
      try {
        return fn()
      } finally {
        depth--
        const ms = deps.now() - started
        record(cls, sizeKb, ms)
        if (inFrame) {
          taskWork += ms
          noteClass(cls, ms)
        } else chargeOutside(ms, cls)
      }
    },
    expect() {
      marks++
    },
    release() {
      if (marks > 0) marks--
      closeIfDone()
    },
    charged(fn, marked, cls = 'deferred') {
      if (marked && marks > 0) marks--
      // Closed account, or a region nested in an atomic or another charged region: no timing.
      if ((!open && !marked) || depth > 0) {
        try {
          return fn()
        } finally {
          closeIfDone()
        }
      }
      const started = deps.now()
      depth++
      try {
        return fn()
      } finally {
        depth--
        const ms = deps.now() - started
        record(cls, 0, ms)
        if (inFrame) {
          taskWork += ms
          noteClass(cls, ms)
        } else chargeOutside(ms, cls)
        closeIfDone()
      }
    },
    noteInput(ms) {
      maxTask = Math.max(maxTask, ms)
      if (ms <= budget) return
      misses++
      // An input's endpoint renders: never a K14 miss. The frame's own accumulators stay untouched.
      missOther++
      if (missLog.length === SAMPLES) {
        missLog.shift()
        missDropped++
      }
      missLog.push({
        frameWorkMs: ms,
        classMs: { 'endpoint-render': ms },
        classCount: { 'endpoint-render': 1 },
        largestMs: ms,
        largestCls: 'endpoint-render',
        forcedAlone: false,
        outside: true,
        unattributed: false,
      })
    },
    stats: () => ({
      budgetMisses: misses,
      carriedMs: carried,
      open: open || marks > 0,
      marks,
      classes: statsOf(classes),
      maxTaskMs: maxTask,
      staleFinish,
      missK14,
      missOther,
      missLog: [...missLog],
      missLogDropped: missDropped,
      k14Exempt:
        missOther === 0 && missK14 + missOther === misses && missDropped === 0,
    }),
  }
}
