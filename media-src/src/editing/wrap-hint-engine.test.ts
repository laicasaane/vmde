// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import {
  type BudgetCounts,
  costClock,
  countBudget,
  type Factor,
  fakeLanes,
  irFixture,
  type LaneDeps,
  wysiwygFixture,
} from '../testing/budget-harness'
import {
  applyWrapHintsSetting,
  installWrapHints,
  setWrapHintsMinLastPiece,
  type WrapHintOptions,
} from './wrap-hint-engine'
import { inlineCodesWithin, proseParentsWithin, runsOf } from './wrap-hint-runs'

afterEach(() => {
  document.body.replaceChildren()
})

describe('installWrapHints without an IntersectionObserver', () => {
  it('is inert: no observer, no write, a callable disposer', () => {
    document.body.innerHTML = `<div class="vditor-reset"><p><code>a${'/b'.repeat(80)}</code></p></div>`
    const surface = document.querySelector('.vditor-reset') as HTMLElement
    const dispose = installWrapHints(() => [surface])
    expect(typeof dispose).toBe('function')
    expect(surface.querySelector('.vmde-wrap-hint')).toBeNull()
    dispose()
  })
})

// Task 640 S2e: the live setting. jsdom has the observers' stubs below, so the engine can be
// installed; the re-plan itself is proven in Chromium (wrap-hints.spec.ts).
describe('setWrapHintsMinLastPiece / applyWrapHintsSetting', () => {
  it('does nothing without an installed engine', () => {
    expect(setWrapHintsMinLastPiece(0)).toBe(false)
    expect(() => applyWrapHintsSetting(0)).not.toThrow()
  })

  it('reports a change once, ignores the same value, and is gone after dispose', () => {
    class FakeObserver {
      observe() {
        // Nothing to observe in the fake.
      }
      unobserve() {
        // Nothing to release in the fake.
      }
      disconnect() {
        // Nothing to release in the fake.
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    vi.stubGlobal('MutationObserver', FakeObserver)
    vi.stubGlobal('ResizeObserver', FakeObserver)
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    document.body.innerHTML = '<div class="vditor-reset"></div>'
    const surface = document.querySelector('.vditor-reset') as HTMLElement
    const dispose = installWrapHints(() => [surface], { minLastPiece: 3 })
    expect(setWrapHintsMinLastPiece(3)).toBe(false)
    expect(setWrapHintsMinLastPiece(0)).toBe(true)
    expect(setWrapHintsMinLastPiece(0)).toBe(false)
    // An invalid value in the payload resolves to the default 3, which is a change from 0.
    expect(setWrapHintsMinLastPiece(3)).toBe(true)
    dispose()
    expect(setWrapHintsMinLastPiece(5)).toBe(false)
    vi.unstubAllGlobals()
  })
})

// Task 733 012-3 (cause C3): an edit in one table cell plans only that cell's runs, and a block's
// runs are planned under the frame budget, so a long table continues in the next frame instead of
// taking every run in one slice. jsdom has no layout: each run's line box resolves to null, which
// still counts the run (`stats.codes`) and costs one `getComputedStyle` of its cell.
describe('wrap hints in a long table', () => {
  const ROWS = 2000
  /** The engine's `FRAME_BUDGET_MS`. */
  const BUDGET_MS = 4

  type Stats = { codes: number }
  // The engine counts its work only under the e2e readiness flag; any truthy value turns it on.
  const testWindow = window as unknown as {
    __vmdeE2EReadiness?: unknown
    __vmdeWrapHintStats?: Stats
  }

  let frames: FrameRequestCallback[] = []
  let observed: Element[] = []
  let notify: IntersectionObserverCallback | undefined
  let dispose: (() => void) | undefined

  afterEach(() => {
    // A failed assertion must not leave the engine installed for the next test.
    dispose?.()
    dispose = undefined
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete testWindow.__vmdeE2EReadiness
    delete testWindow.__vmdeWrapHintStats
    frames = []
    observed = []
    notify = undefined
  })

  /**
   * jsdom's `getComputedStyle` costs about a millisecond per cell, which puts 2,000 cells over the
   * test timeout under a full-suite load. A cell gets a canned style instead (no padding; its
   * `clientWidth` is 0, so its line box still resolves to null); `onCellStyle` runs per such read.
   */
  function stubCellStyle(onCellStyle: () => void = () => undefined): void {
    const realStyle = window.getComputedStyle.bind(window)
    const cellStyle = { paddingLeft: '0px', paddingRight: '0px' }
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element, pseudo) => {
        if (!(element instanceof HTMLTableCellElement))
          return realStyle(element, pseudo)
        onCellStyle()
        return cellStyle as CSSStyleDeclaration
      },
    )
  }

  /** Install the engine on a surface with one 2,000-row table (inline code in every first cell). */
  function installOnTable(): HTMLElement {
    class FakeIntersections {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback
      }
      observe(target: Element) {
        observed.push(target)
      }
      unobserve() {
        // Nothing to release in the fake.
      }
      disconnect() {
        // Nothing to release in the fake.
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersections)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    testWindow.__vmdeE2EReadiness = {}
    const rows = Array.from(
      { length: ROWS },
      (_, i) => `<tr><td><code>c${i}</code></td><td>r${i}</td></tr>`,
    ).join('')
    document.body.innerHTML = `<div class="vditor-reset"><p>before</p><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>${rows}</tbody></table></div>`
    const surface = document.querySelector('.vditor-reset') as HTMLElement
    dispose = installWrapHints(() => [surface])
    // Every top-level block is near the viewport.
    notify?.(
      observed.map(
        (target) =>
          ({ target, isIntersecting: true }) as IntersectionObserverEntry,
      ),
      {} as IntersectionObserver,
    )
    return surface
  }

  /** Run queued frames until none is left; returns the `stats.codes` growth of each frame. */
  function flushFrames(): number[] {
    const growth: number[] = []
    for (let guard = 0; frames.length > 0 && guard < 20_000; guard += 1) {
      const before = testWindow.__vmdeWrapHintStats?.codes ?? 0
      frames.shift()?.(0)
      growth.push((testWindow.__vmdeWrapHintStats?.codes ?? 0) - before)
    }
    expect(frames).toHaveLength(0)
    return growth
  }

  const stats = (): Stats => testWindow.__vmdeWrapHintStats as Stats

  it.each([
    [
      'a text change',
      (cell: Element) => {
        const text = cell.querySelector('code')?.firstChild as Text
        text.data += 'x'
      },
    ],
    [
      'a replaced cell content',
      (cell: Element) => {
        const code = document.createElement('code')
        code.textContent = 'replaced'
        cell.replaceChildren(code)
      },
    ],
  ])('plans only the edited cell after %s', async (_name, edit) => {
    stubCellStyle()
    const surface = installOnTable()
    flushFrames()
    expect(stats().codes).toBeGreaterThanOrEqual(ROWS)
    stats().codes = 0
    const cell = surface.querySelectorAll('tbody tr')[ROWS / 2].children[0]
    edit(cell)
    // The engine's MutationObserver delivers in a microtask.
    await Promise.resolve()
    flushFrames()
    // The edited cell holds one inline-code run and no prose run.
    expect(stats().codes).toBeGreaterThan(0)
    expect(stats().codes).toBeLessThanOrEqual(1)
  })

  it('keeps each read slice within the frame budget plus one run', () => {
    // Each run reads its cell's style once per slice: let that read cost 1 ms of engine time.
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    stubCellStyle(() => {
      clock += 1
    })
    installOnTable()
    const growth = flushFrames()
    expect(stats().codes).toBeGreaterThanOrEqual(ROWS)
    // Budget 4 ms at 1 ms per run: a slice stops after the run that crosses the budget.
    expect(Math.max(...growth)).toBeLessThanOrEqual(BUDGET_MS + 1)
  })
})

// ---- B-12 (Task 733 / 012-20, D-13 design sections 1.1 and 5.2) ----
//
// The first entry of table A of `irFixture(tableHeavyMarkdown(f))` into the observer margin. The
// engine runs as the frame job `wrap-hints` of the background scheduler, injected as
// `options.scheduler`; the module is loaded by a computed specifier so this file typechecks before
// the module exists. Frames and time come from the harness lanes and cost clock: the engine's
// `requestAnimationFrame` and `performance.now` are stubbed onto them, and the scheduler is built on
// the same lanes, so either implementation is driven by `lanes.runFrame()`. Each frame runs inside
// `countBudget`, which charges walked nodes (0.001 ms), layout reads (1 ms) and root queries on the
// clock; the test charges queries on other receivers at the same query rate. jsdom
// has no layout: every run's line box resolves to null after its cell's width read, so the hints
// of the sliced plan are the ones of an unsliced plan (unchanged) and the runs planned are counted.
describe.each([1, 4, 16] as const)(
  'B-12 wrap hints on the first entry into table A at factor %i',
  (factor) => {
    interface SchedulerModule {
      createBackgroundScheduler(deps: LaneDeps): {
        stats(name: 'wrap-hints'): {
          readonly slices: number
          readonly overruns: number
          readonly maxSliceMs: number
        }
      }
    }
    const SCHEDULER_MODULE: string = '../util/background-budget'
    let schedulerModule: SchedulerModule | undefined
    beforeAll(async () => {
      schedulerModule = (await import(
        /* @vite-ignore */ SCHEDULER_MODULE
      ).catch(() => undefined)) as SchedulerModule | undefined
    })

    // An f16 case runs about 530 counted frames and builds the f16 fixture: it needs more than the
    // default 5 s of wall time, which the cost clock does not measure (Q-120).
    const caseTimeout = factor === 16 ? 30_000 : undefined
    /** The shared frame slice of the design plus the overrun bound of one unit of work. */
    const SLICE_BOUND_MS = 4 + 2
    /**
     * Node work of one slice: the nodes a slice queries (`querySelectorAll` receivers' descendants,
     * which the cost clock does not charge) plus the nodes it walks, each at the node charge
     * (0.001 ms), fit the slice bound. A slice collects runs by a row cursor, so this holds at every
     * factor; one query over the whole table does not.
     */
    const NODES_PER_SLICE = SLICE_BOUND_MS / 0.001
    /**
     * The section 5.1 query rate (0.05 ms per 1,000 elements under the receiver), charged here on
     * every receiver other than the root, which the harness already charges at this rate.
     */
    const QUERY_MS_PER_ELEMENT = 0.05 / 1000
    /** Prose runs the engine plans: those that can hold a long word or already carry a hint. */
    const LONG_WORD = /[^\s\u200B]{8}/u

    const testWindow = window as unknown as {
      __vmdeE2EReadiness?: unknown
      __vmdeWrapHintStats?: { codes: number }
    }
    let dispose: (() => void) | undefined
    afterEach(() => {
      dispose?.()
      dispose = undefined
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      delete testWindow.__vmdeE2EReadiness
      delete testWindow.__vmdeWrapHintStats
    })

    interface Frame {
      ms: number
      counts: BudgetCounts
      runs: number
    }

    function enterTableA(): {
      frames: Frame[]
      table: HTMLElement
      before: string
      scheduler:
        | ReturnType<SchedulerModule['createBackgroundScheduler']>
        | undefined
    } {
      const { root } = irFixture(tableHeavyMarkdown(factor as Factor))
      if (!root.isConnected) document.body.append(root.parentElement ?? root)
      const table = root.querySelector(':scope > table') as HTMLElement
      const before = table.innerHTML
      const clock = costClock()
      const lanes = fakeLanes(clock)
      vi.spyOn(performance, 'now').mockImplementation(() => clock.now())
      // Queries on a table, row or cell cost time too: each charges the clock at the query rate
      // before it runs, so the engine's deadline checks see it. The harness counts the query and
      // runs this wrapper quietly, so the descendant count below is not counted itself.
      for (const name of ['querySelectorAll', 'querySelector'] as const) {
        const original = Element.prototype[name]
        vi.spyOn(Element.prototype, name).mockImplementation(function (
          this: Element,
          selectors: string,
        ) {
          if (this !== root)
            clock.advance(
              this.getElementsByTagName('*').length * QUERY_MS_PER_ELEMENT,
            )
          return original.call(this, selectors) as never
        })
      }
      vi.stubGlobal('requestAnimationFrame', lanes.requestAnimationFrame)
      vi.stubGlobal('cancelAnimationFrame', lanes.cancelAnimationFrame)
      // jsdom's getComputedStyle costs real milliseconds per cell: a cell gets a canned style.
      const realStyle = window.getComputedStyle.bind(window)
      const cellStyle = { paddingLeft: '0px', paddingRight: '0px' }
      vi.spyOn(window, 'getComputedStyle').mockImplementation(
        (element, pseudo) =>
          element instanceof HTMLTableCellElement
            ? (cellStyle as CSSStyleDeclaration)
            : realStyle(element, pseudo),
      )
      let notify: IntersectionObserverCallback | undefined
      class FakeIntersections {
        constructor(callback: IntersectionObserverCallback) {
          notify = callback
        }
        observe() {
          // The test reports the intersections itself.
        }
        unobserve() {
          // Nothing to release in the fake.
        }
        disconnect() {
          // Nothing to release in the fake.
        }
      }
      vi.stubGlobal('IntersectionObserver', FakeIntersections)
      testWindow.__vmdeE2EReadiness = {}
      const scheduler = schedulerModule?.createBackgroundScheduler(lanes)
      const options: Record<string, unknown> = { scheduler }
      dispose = installWrapHints(() => [root], options as WrapHintOptions)
      // Only table A comes near: its first entry into the margin.
      notify?.(
        [
          {
            target: table,
            isIntersecting: true,
          } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      )
      const frames: Frame[] = []
      let idle = 0
      for (let guard = 0; guard < 50_000 && idle < 10; guard++) {
        const start = clock.now()
        const runs = testWindow.__vmdeWrapHintStats?.codes ?? 0
        const { counts } = countBudget(root, () => lanes.runFrame())
        const frame = {
          ms: clock.now() - start,
          counts,
          runs: (testWindow.__vmdeWrapHintStats?.codes ?? 0) - runs,
        }
        frames.push(frame)
        // The fake lanes do not tell whether a frame is queued: ten frames in a row without any
        // cost (the engine waits two frames per schedule) mean nothing is left.
        idle = frame.ms === 0 && frame.runs === 0 ? idle + 1 : 0
      }
      expect(idle, 'the engine went idle').toBe(10)
      return { frames: frames.slice(0, -10), table, before, scheduler }
    }

    /** The runs an unsliced plan of table A takes: inline code first, then the prose runs. */
    const unslicedRuns = (table: HTMLElement): number =>
      inlineCodesWithin(table).flatMap(runsOf).length +
      proseParentsWithin(table)
        .flatMap(runsOf)
        .filter((run) => run.hints.length > 0 || LONG_WORD.test(run.text))
        .length

    it(
      'plans every run of the table once, in slices of at most 4 + 2 ms',
      () => {
        const { frames, table, before } = enterTableA()
        const over = frames.flatMap((frame, index) =>
          frame.ms > SLICE_BOUND_MS + 1e-9
            ? [`frame ${index}: ${frame.ms.toFixed(3)} ms`]
            : [],
        )
        expect(over).toEqual([])
        expect(frames.reduce((sum, frame) => sum + frame.runs, 0)).toBe(
          unslicedRuns(table),
        )
        expect(table.innerHTML).toBe(before)
      },
      caseTimeout,
    )

    it(
      'collects the runs by a row cursor: the nodes of each slice do not grow with the table',
      () => {
        const { frames } = enterTableA()
        const over = frames.flatMap((frame, index) => {
          const nodes = frame.counts.queriedNodes + frame.counts.nodesWalked
          return nodes > NODES_PER_SLICE
            ? [`frame ${index}: ${nodes} nodes`]
            : []
        })
        expect(over).toEqual([])
      },
      caseTimeout,
    )

    it(
      'reads layout at most once per millisecond of the slice',
      () => {
        const { frames } = enterTableA()
        const most = Math.max(
          ...frames.map((frame) => frame.counts.layoutReads),
        )
        expect(most).toBeLessThanOrEqual(SLICE_BOUND_MS)
      },
      caseTimeout,
    )

    it(
      'runs as the frame job wrap-hints of the shared scheduler',
      () => {
        expect(schedulerModule, 'util/background-budget').toBeDefined()
        const { scheduler } = enterTableA()
        const stats = scheduler?.stats('wrap-hints')
        expect(stats?.slices).toBeGreaterThan(0)
        expect(stats?.overruns).toBe(0)
        expect(stats?.maxSliceMs).toBeLessThanOrEqual(SLICE_BOUND_MS)
      },
      caseTimeout,
    )
  },
)

// ---- Task 733 / 013-T4: B-12 on the WYSIWYG fixture (D-13 design section 5.2; technical task 013) ----
//
// The first frame that plans table A of Lute's WYSIWYG DOM collects its runs under the slice budget by a
// row cursor (N9): the nodes that frame walks do not grow with the table, and each frame stays within
// 4 + 2 ms on an engine clock that charges 1 ms per cell style read.
describe('013 B-12 wrap hints on the WYSIWYG fixture', () => {
  const BUDGET = 4
  let wysiwygFrames: FrameRequestCallback[] = []
  let observedTops: Element[] = []
  let notifyTops: IntersectionObserverCallback | undefined
  let stop: (() => void) | undefined
  const statsWindow = window as unknown as {
    __vmdeE2EReadiness?: unknown
    __vmdeWrapHintStats?: { codes: number }
  }
  afterEach(() => {
    stop?.()
    stop = undefined
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete statsWindow.__vmdeE2EReadiness
    delete statsWindow.__vmdeWrapHintStats
    wysiwygFrames = []
    observedTops = []
    notifyTops = undefined
    document.body.replaceChildren()
  })

  function installOnWysiwyg(factor: Factor, clock: { t: number }): HTMLElement {
    class FakeIntersections {
      constructor(callback: IntersectionObserverCallback) {
        notifyTops = callback
      }
      observe(target: Element) {
        observedTops.push(target)
      }
      unobserve() {
        // Nothing to release in the fake.
      }
      disconnect() {
        // Nothing to release in the fake.
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersections)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      wysiwygFrames.push(cb)
      return wysiwygFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    vi.spyOn(performance, 'now').mockImplementation(() => clock.t)
    const realStyle = window.getComputedStyle.bind(window)
    const cellStyle = { paddingLeft: '0px', paddingRight: '0px' }
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      if (!(el instanceof HTMLTableCellElement)) return realStyle(el, pseudo)
      clock.t += 1
      return cellStyle as CSSStyleDeclaration
    })
    statsWindow.__vmdeE2EReadiness = {}
    const holder = document.createElement('div')
    holder.className = 'vditor-wysiwyg'
    const root = document.createElement('pre')
    root.className = 'vditor-reset'
    root.innerHTML = wysiwygFixture(tableHeavyMarkdown(factor)).root.innerHTML
    holder.append(root)
    document.body.append(holder)
    stop = installWrapHints(() => [root])
    notifyTops?.(
      observedTops.map(
        (target) =>
          ({ target, isIntersecting: true }) as IntersectionObserverEntry,
      ),
      {} as IntersectionObserver,
    )
    return root
  }

  /** The nodes walked by the first frame that plans a run, and the engine-clock ms of every frame. */
  function runAll(
    root: HTMLElement,
    clock: { t: number },
  ): { firstWalk: number; slices: number[] } {
    const slices: number[] = []
    let firstWalk = -1
    for (let guard = 0; wysiwygFrames.length > 0 && guard < 50_000; guard++) {
      const before = statsWindow.__vmdeWrapHintStats?.codes ?? 0
      const started = clock.t
      const frame = wysiwygFrames.shift() as FrameRequestCallback
      const { counts } = countBudget(root, () => frame(0))
      const grew = (statsWindow.__vmdeWrapHintStats?.codes ?? 0) - before
      if (firstWalk < 0 && grew > 0) firstWalk = counts.nodesWalked
      slices.push(clock.t - started)
    }
    expect(wysiwygFrames).toHaveLength(0)
    return { firstWalk, slices }
  }

  const walks = new Map<Factor, number>()
  describe.each([1, 4, 16] as const)('at factor %i', (factor) => {
    it('plans within the budget per frame and walks the same nodes in its first frame as at factor 1', () => {
      const clock = { t: 0 }
      const root = installOnWysiwyg(factor, clock)
      const { firstWalk, slices } = runAll(root, clock)
      expect(statsWindow.__vmdeWrapHintStats?.codes ?? 0).toBeGreaterThan(0)
      expect(Math.max(...slices), 'slice ms').toBeLessThanOrEqual(BUDGET + 2)
      walks.set(factor, firstWalk)
      const base = walks.get(1)
      if (factor !== 1 && base !== undefined)
        expect(
          firstWalk,
          'nodes walked by the first planning frame',
        ).toBeLessThanOrEqual(base * 2)
    }, 120_000)
  })
})
