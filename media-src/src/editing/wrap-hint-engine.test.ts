// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import {
  applyWrapHintsSetting,
  installWrapHints,
  setWrapHintsMinLastPiece,
} from './wrap-hint-engine'

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
