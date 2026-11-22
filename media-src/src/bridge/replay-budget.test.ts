import { describe, expect, it } from 'vitest'
import { createReplayBudget, REPLAY_BUDGET_MS } from './replay-budget'

// Task 733 / 036 (fix design 4.2, step B): per-atomic and per-frame accounting of the replay, with a fake
// clock that each piece of work advances by hand.

const clock = () => {
  const state = { t: 0 }
  return {
    state,
    now: () => state.t,
    /** Work that takes `ms`. */
    spend: (ms: number) => () => {
      state.t += ms
    },
  }
}

describe('036 B replay budget', () => {
  it('keeps the running maximum fixed cost and cost per KB per class, and admits by twice the median', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    expect(budget.beginFrame()).toBe(REPLAY_BUDGET_MS)
    budget.atomic('leaf', 0.2, c.spend(2))
    budget.atomic('leaf', 4, c.spend(6))
    budget.atomic('table', 0.5, c.spend(3))
    const stats = budget.stats()
    expect(stats.classes.leaf).toMatchObject({
      atomics: 2,
      fixedMaxMs: 2,
      perKbMaxMs: 1,
      maxMs: 6,
      medianMs: 6,
    })
    expect(stats.classes.table?.fixedMaxMs).toBe(3)
    // H2 fix design rev2 (D5.2, D9.1): 11 ms used; twice the leaf median (6 ms) does not fit, twice the
    // table median (3 ms) does not either; a fresh frame admits a table atomic.
    expect(budget.admit('leaf', 3)).toBe(false)
    expect(budget.admit('table', 0.5)).toBe(false)
    budget.endFrame()
    budget.beginFrame()
    expect(budget.admit('table', 0.5)).toBe(true)
    budget.endFrame()
    expect(budget.stats().budgetMisses).toBe(0)
  })

  it('counts one budget-miss for a task whose replay work exceeds the budget', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    budget.beginFrame()
    budget.atomic('leaf', 0, c.spend(10))
    budget.atomic('leaf', 0, c.spend(10))
    budget.endFrame()
    budget.beginFrame()
    budget.atomic('leaf', 0, c.spend(5))
    budget.endFrame()
    expect(budget.stats().budgetMisses).toBe(1)
    expect(budget.stats().maxTaskMs).toBe(20)
  })

  it('a carried deferred charge reduces the next frame and the account stays open until marks run', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    const token = budget.open()
    budget.beginFrame()
    budget.atomic('leaf', 0, () => {
      c.state.t += 2
      budget.expect()
    })
    budget.endFrame()
    budget.finish(token)
    // The replay is done but a marked refold has not run: still open.
    expect(budget.isOpen()).toBe(true)
    budget.charged(c.spend(6), true)
    expect(budget.stats().classes.deferred?.maxMs).toBe(6)
    expect(budget.isOpen()).toBe(false)
  })

  it('carries a charge into the next frame without shortening a finished task', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    budget.expect()
    budget.charged(c.spend(9), true)
    expect(budget.stats().carriedMs).toBe(9)
    expect(budget.beginFrame()).toBe(REPLAY_BUDGET_MS - 9)
    budget.endFrame()
    // A charge over the budget leaves no catch-up for the next frame.
    budget.charged(c.spend(20))
    expect(budget.stats().budgetMisses).toBe(1)
    expect(budget.beginFrame()).toBe(0)
  })

  it('times nested charged regions once, by the outermost one, and never inside an atomic', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    budget.charged(() => {
      c.state.t += 3
      budget.charged(c.spend(4))
    })
    expect(budget.stats().classes.deferred).toMatchObject({
      atomics: 1,
      maxMs: 7,
    })
    budget.beginFrame()
    budget.atomic('leaf', 0, () => budget.charged(c.spend(2)))
    expect(budget.stats().classes.deferred?.atomics).toBe(1)
    budget.endFrame()
  })

  it('a closed account runs a charged callback untimed', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    let ran = false
    budget.charged(() => {
      ran = true
    })
    expect(ran).toBe(true)
    expect(budget.stats().classes.deferred).toBeUndefined()
  })

  it('a dropped mark is released and closes the account', () => {
    const budget = createReplayBudget({ now: () => 0 })
    const token = budget.open()
    budget.expect()
    budget.finish(token)
    expect(budget.isOpen()).toBe(true)
    budget.release()
    expect(budget.isOpen()).toBe(false)
  })

  it('counts an input whose endpoint renders exceed the budget', () => {
    const budget = createReplayBudget({ now: () => 0 })
    budget.noteInput(10)
    budget.noteInput(16)
    expect(budget.stats().budgetMisses).toBe(1)
  })

  // Task 733 / 036 (step D, 4.3): the proof lane's share is what remains of the budget.
  it('reports what remains of the budget before, inside and after a frame', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    expect(budget.remainingMs()).toBe(REPLAY_BUDGET_MS)
    budget.charged(c.spend(2))
    expect(budget.remainingMs()).toBe(REPLAY_BUDGET_MS - 2)
    budget.beginFrame()
    budget.atomic('leaf', 0, c.spend(5))
    expect(budget.remainingMs()).toBe(REPLAY_BUDGET_MS - 2 - 5)
    budget.endFrame()
    budget.charged(c.spend(3))
    expect(budget.remainingMs()).toBe(REPLAY_BUDGET_MS - 2 - 5 - 3)
    budget.beginFrame()
    budget.atomic('leaf', 0, c.spend(20))
    expect(budget.remainingMs()).toBe(0)
  })
})

// H2 fix design rev2 (D5.2, D9.1-D9.3): elapsed time only packs frames and counts misses; it never
// refuses a group. The estimate is the median of the class's last 16 samples, admitted with headroom.
describe('036 H2 S4 replay budget', () => {
  it('D5.2: packs by the median of the last 16 samples; one slow sample neither stops packing nor refuses', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    budget.beginFrame()
    for (const ms of [2, 2, 40, 2, 2]) budget.atomic('leaf', 0, c.spend(ms))
    budget.endFrame()
    expect(budget.stats().budgetMisses).toBe(1)
    const leaf = budget.stats().classes.leaf
    expect(leaf?.medianMs).toBe(2)
    // The running maximum is still reported.
    expect(leaf?.fixedMaxMs).toBe(40)
    budget.beginFrame()
    expect(budget.admit('leaf', 0)).toBe(true)
    budget.endFrame()
    // No elapsed-time refusal exists any more.
    expect('unbounded' in budget).toBe(false)
  })

  it('D5.2: the median follows the last 16 samples only', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    for (let n = 0; n < 16; n++) budget.atomic('table', 0, c.spend(9))
    expect(budget.stats().classes.table?.medianMs).toBe(9)
    for (let n = 0; n < 16; n++) budget.atomic('table', 0, c.spend(1))
    expect(budget.stats().classes.table?.medianMs).toBe(1)
  })

  it('D9.1: admits while the work so far plus twice the estimate fits the allowance', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    expect(budget.beginFrame()).toBe(15)
    budget.atomic('leaf', 0, c.spend(4))
    budget.atomic('leaf', 0, c.spend(3))
    // Median 4 (of 3 and 4, the upper one); 7 + 2 * 4 = 15 fits.
    expect(budget.admit('leaf', 0)).toBe(true)
    budget.atomic('leaf', 0, c.spend(4))
    // 11 + 2 * 4 = 19 does not fit (11 + 4 would).
    expect(budget.admit('leaf', 0)).toBe(false)
    budget.endFrame()
  })

  it('D9.2: emission charged inside a frame is frame work and counts toward the miss', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    budget.beginFrame()
    budget.atomic('leaf', 0, c.spend(12))
    budget.charged(c.spend(4), false, 'emission')
    budget.endFrame()
    expect(budget.stats().budgetMisses).toBe(1)
    expect(budget.stats().maxTaskMs).toBe(16)
    expect(budget.stats().classes.emission?.maxMs).toBe(4)
  })

  it('D9.3: an outermost charged region of 16 ms outside a frame is one miss; a nested one is not counted again', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    budget.charged(() => {
      c.state.t += 10
      budget.charged(c.spend(6))
    })
    expect(budget.stats().budgetMisses).toBe(1)
    budget.charged(c.spend(14))
    expect(budget.stats().budgetMisses).toBe(1)
  })
})

// S4 repair round 1 (fix 6): admission reserves the emission class's estimate as headroom.
describe('036 S4r1 replay budget', () => {
  it('admits while the work plus twice the estimate plus the emission estimate fits', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    budget.beginFrame()
    budget.charged(c.spend(4), false, 'emission')
    budget.endFrame()
    budget.beginFrame()
    budget.atomic('leaf', 0, c.spend(3))
    // 3 + 2 * 3 = 9 fits 15; with the 4 ms emission reserve it is 13, still fits.
    expect(budget.admit('leaf', 0)).toBe(true)
    budget.atomic('leaf', 0, c.spend(3))
    // 6 + 6 + 4 = 16 does not fit (6 + 6 = 12 would).
    expect(budget.admit('leaf', 0)).toBe(false)
    budget.endFrame()
  })

  // 036 core C2 (R31.2): the account has one owner; a stale `finish` is counted and changes nothing.
  it('closes only for the current owner token; a stale finish is counted and changes nothing', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    const replay = budget.open()
    const recovery = budget.open()
    expect(recovery).not.toBe(replay)
    budget.finish(replay)
    expect(budget.isOpen()).toBe(true)
    expect(budget.stats().staleFinish).toBe(1)
    budget.finish(recovery)
    expect(budget.isOpen()).toBe(false)
    // A second finish of the same owner is stale too: the account has no owner now.
    budget.finish(recovery)
    expect(budget.stats().staleFinish).toBe(2)
    expect(budget.isOpen()).toBe(false)
  })

  it('a stale finish leaves the carried charge and the marks of the open account', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    const old = budget.open()
    const owner = budget.open()
    budget.expect()
    budget.finish(old)
    budget.finish(owner)
    // The owner finished, but a marked callback has not run: still open.
    expect(budget.isOpen()).toBe(true)
    budget.release()
    expect(budget.isOpen()).toBe(false)
  })

  // 036 core C3 (L1 rule 5): a marked callback never waits for closure; it runs charged and releases.
  it('a marked callback run charged after finish closes the account with no further frame', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    const token = budget.open()
    budget.expect()
    budget.finish(token)
    expect(budget.isOpen()).toBe(true)
    budget.charged(c.spend(2), true)
    expect(budget.isOpen()).toBe(false)
    expect(budget.stats().marks).toBe(0)
  })

  it('a cancelled marked callback releases its mark and the account closes', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    const token = budget.open()
    budget.expect()
    budget.finish(token)
    budget.release()
    expect(budget.isOpen()).toBe(false)
    expect(budget.stats().carriedMs).toBe(0)
  })
})

// ---- 036 core C10 (R-1 R2.4 with C10 review item 3; K14 R2.5 with item 4) ----
describe('036 core C10 R-1 admission', () => {
  /** A budget warmed with `samples` of `[ms, sizeKb]`, each in a frame of its own. */
  const warmed = (samples: Array<[number, number]>) => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    for (const [ms, kb] of samples) {
      budget.beginFrame()
      budget.atomic('leaf', kb, c.spend(ms))
      budget.endFrame()
    }
    return { c, budget }
  }
  /**
   * One fake-clock frame: atomics of `costs` (ms, KB) packed while `admit` holds; the first always runs.
   * Returns the work of each frame until every atomic ran.
   */
  const frames = (
    budget: ReturnType<typeof createReplayBudget>,
    c: ReturnType<typeof clock>,
    costs: Array<[number, number]>,
  ) => {
    const out: number[] = []
    let next = 0
    while (next < costs.length) {
      budget.beginFrame()
      const start = c.state.t
      let ran = 0
      while (next < costs.length) {
        const [ms, kb] = costs[next]
        if (ran > 0 && !budget.admit('leaf', kb)) break
        budget.atomic('leaf', kb, c.spend(ms))
        next++
        ran++
      }
      budget.endFrame()
      out.push(c.state.t - start)
    }
    return out
  }
  const fifteenOnes: Array<[number, number]> = Array.from(
    { length: 15 },
    () => [1, 0.2],
  )

  it('admit-outlier-keeps-packing: fifteen 2 ms and one 40 ms; a small leaf is admitted, a frame packs at least 3', () => {
    const { c, budget } = warmed([
      ...Array.from({ length: 15 }, (): [number, number] => [2, 0.2]),
      [40, 0.2],
    ])
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(2))
    expect(budget.admit('leaf', 0.2)).toBe(true)
    budget.endFrame()
    const work = frames(budget, c, [
      [2, 0.2],
      [2, 0.2],
      [2, 0.2],
      [2, 0.2],
    ])
    expect(work[0]).toBeGreaterThanOrEqual(6)
  })

  it('admit-small-slow-leaf, zero prior slow samples: after 8 ms a 9 ms leaf is not admitted (no 17 ms frame)', () => {
    const { c, budget } = warmed([...fifteenOnes, [1, 0.2]])
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(8))
    expect(budget.admit('leaf', 0.2)).toBe(false)
    budget.endFrame()
    const work = frames(budget, c, [
      [8, 0.2],
      [9, 0.2],
    ])
    expect(Math.max(...work)).toBeLessThanOrEqual(REPLAY_BUDGET_MS)
  })

  it('admit-small-slow-leaf, one prior slow sample: fifteen 1 ms and one 9 ms; after 8 ms another 9 ms leaf is refused', () => {
    const { c, budget } = warmed([...fifteenOnes, [9, 0.2]])
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(8))
    expect(budget.admit('leaf', 0.2)).toBe(false)
    budget.endFrame()
    const work = frames(budget, c, [
      [8, 0.2],
      [9, 0.2],
    ])
    expect(work).toEqual([8, 9])
    expect(budget.stats().budgetMisses).toBe(0)
  })

  it('admit-small-slow-leaf, twice warmed: fourteen 1 ms and two 9 ms; after 8 ms a 0.2 KB leaf is refused', () => {
    const { c, budget } = warmed([...fifteenOnes.slice(1), [9, 0.2], [9, 0.2]])
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(8))
    expect(budget.admit('leaf', 0.2)).toBe(false)
    budget.endFrame()
    expect(
      Math.max(
        ...frames(budget, c, [
          [8, 0.2],
          [9, 0.2],
        ]),
      ),
    ).toBeLessThanOrEqual(REPLAY_BUDGET_MS)
  })

  it('admit-warmed-4kb: fixed median 1, per-KB median 2; after 8 ms a 4 KB leaf is refused and runs first next frame', () => {
    const { c, budget } = warmed([...fifteenOnes, [1, 0.2], [9, 4], [9, 4]])
    expect(budget.stats().classes.leaf).toMatchObject({
      fixedMedianMs: 1,
      perKbMedianMs: 2,
    })
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(8))
    expect(budget.admit('leaf', 4)).toBe(false)
    budget.endFrame()
    expect(
      frames(budget, c, [
        [8, 0.2],
        [9, 4],
      ]),
    ).toEqual([8, 9])
  })

  it('admit-reserves-deferred: an admission that fits without the deferred reserve is refused', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(1))
    budget.endFrame()
    // Without the reserve: 4 + max(2, 7.5) = 11.5 fits 15; with a 6 ms deferred median it does not.
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(4))
    expect(budget.admit('leaf', 0.2)).toBe(true)
    budget.charged(c.spend(6), false)
    budget.endFrame()
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(4))
    expect(budget.admit('leaf', 0.2)).toBe(false)
    budget.endFrame()
  })
})

describe('036 core C10 R-1 emission reserve', () => {
  it('admit-reserves-slow-emission: two 3 ms emissions among 0.5 ms ones are reserved; a third leaf after 6 ms is refused', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    for (let n = 0; n < 16; n++) {
      budget.beginFrame()
      budget.atomic('leaf', 0.2, c.spend(1))
      budget.charged(c.spend(n < 2 ? 3 : 0.5), false, 'emission')
      budget.endFrame()
    }
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(3))
    budget.atomic('leaf', 0.2, c.spend(3))
    // Median reserve: 6 + 7.5 + 0.5 = 14 fits; the second-largest emission (3 ms) does not: 16.5.
    expect(budget.admit('leaf', 0.2)).toBe(false)
    budget.endFrame()
  })

  it('a single slow emission does not count: one 9 ms among 0.5 ms ones', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    for (let n = 0; n < 16; n++) {
      budget.beginFrame()
      budget.atomic('leaf', 0.2, c.spend(1))
      budget.charged(c.spend(n === 0 ? 9 : 0.5), false, 'emission')
      budget.endFrame()
    }
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(3))
    budget.atomic('leaf', 0.2, c.spend(3))
    expect(budget.admit('leaf', 0.2)).toBe(true)
    budget.endFrame()
  })
})

describe('036 core C10 K14 miss attribution', () => {
  it('miss-attribution: a forced 18 ms leaf with its 1 ms emission is K14; class sums equal the frame work', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(18))
    budget.charged(c.spend(1), false, 'emission')
    budget.endFrame()
    const stats = budget.stats()
    expect(stats).toMatchObject({
      budgetMisses: 1,
      missK14: 1,
      missOther: 0,
      missLogDropped: 0,
      k14Exempt: true,
    })
    const record = stats.missLog[0]
    expect(record.forcedAlone).toBe(true)
    expect(record.unattributed).toBe(false)
    const sum = Object.values(record.classMs).reduce((a, b) => a + b, 0)
    expect(Math.abs(sum - record.frameWorkMs)).toBeLessThanOrEqual(0.5)
  })

  it('a forced 18 ms leaf plus 1 ms of deferred work is not K14', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(18))
    budget.charged(c.spend(1), false)
    budget.endFrame()
    expect(budget.stats()).toMatchObject({
      missK14: 0,
      missOther: 1,
      k14Exempt: false,
    })
  })

  it('a 14 ms atomic plus 2 ms of emission is a packing miss, not K14', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(14))
    budget.charged(c.spend(2), false, 'emission')
    budget.endFrame()
    expect(budget.stats()).toMatchObject({ missK14: 0, missOther: 1 })
  })

  it('two atomics over the budget are not K14; one outline region outside a frame is', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(10))
    budget.atomic('leaf', 0.2, c.spend(8))
    budget.endFrame()
    budget.charged(c.spend(20), false, 'outline')
    const stats = budget.stats()
    expect(stats).toMatchObject({ missK14: 1, missOther: 1, budgetMisses: 2 })
    expect(stats.missLog[1].outside).toBe(true)
  })

  it('Q-277: one emission spike past its reserve, the rest within the budget, is K14; a slow leaf is not', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    for (let n = 0; n < 15; n++) {
      budget.beginFrame()
      budget.atomic('leaf', 0.2, c.spend(1))
      budget.charged(c.spend(0.5), false, 'emission')
      budget.endFrame()
    }
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(6))
    budget.atomic('leaf', 0.2, c.spend(6))
    budget.charged(c.spend(4), false, 'emission')
    budget.endFrame()
    expect(budget.stats()).toMatchObject({ missK14: 1, missOther: 0 })
    // The leaves alone over the budget: a packing miss, not an emission spike.
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(9))
    budget.atomic('leaf', 0.2, c.spend(7))
    budget.charged(c.spend(4), false, 'emission')
    budget.endFrame()
    expect(budget.stats()).toMatchObject({ missK14: 1, missOther: 1 })
  })

  it('a K14 atomic over 50 ms is not exempt', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    budget.beginFrame()
    budget.atomic('leaf', 0.2, c.spend(51))
    budget.endFrame()
    expect(budget.stats()).toMatchObject({ missK14: 0, missOther: 1 })
  })

  it('17 misses overwrite one record: missLogDropped 1, and the exemption is refused', () => {
    const c = clock()
    const budget = createReplayBudget({ now: c.now })
    budget.open()
    for (let n = 0; n < 17; n++) {
      budget.beginFrame()
      budget.atomic('leaf', 0.2, c.spend(18))
      budget.endFrame()
    }
    expect(budget.stats()).toMatchObject({
      missK14: 17,
      missOther: 0,
      missLogDropped: 1,
      k14Exempt: false,
    })
    expect(budget.stats().missLog).toHaveLength(16)
  })
})
