// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installEchartsResize } from './echarts-fit'
import {
  type Factor,
  costClock,
  countBudget,
  fakeLanes,
  irFixture,
} from '../testing/budget-harness'
import type { UnitsChange } from '../util/unit-changes'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'

describe('installEchartsResize disposal', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('disconnects its observer fleet, cancels pending work, and permits reinstall', () => {
    const resizeDisconnect = vi.fn()
    const mutationDisconnect = vi.fn()
    let notifyResize: (() => void) | undefined

    class FakeResizeObserver {
      constructor(callback: () => void) {
        notifyResize = callback
      }
      observe = vi.fn()
      disconnect = resizeDisconnect
    }
    class FakeMutationObserver {
      observe = vi.fn()
      disconnect = mutationDisconnect
    }

    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 31),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    const cancelAnimationFrame = vi.fn()
    const body = {} as HTMLElement
    const win = {
      document: {
        body,
        getElementById: vi.fn(() => body),
        querySelectorAll: vi.fn(() => []),
      },
      addEventListener,
      removeEventListener,
      requestAnimationFrame: vi.fn(() => 17),
      cancelAnimationFrame,
      ResizeObserver: FakeResizeObserver,
      MutationObserver: FakeMutationObserver,
    } as unknown as Parameters<typeof installEchartsResize>[0]

    const dispose = installEchartsResize(win)
    notifyResize?.()

    expect(typeof dispose).toBe('function')
    dispose()

    expect(removeEventListener).toHaveBeenCalledWith(
      'resize',
      addEventListener.mock.calls[0][1],
    )
    expect(resizeDisconnect).toHaveBeenCalledOnce()
    expect(mutationDisconnect).toHaveBeenCalledOnce()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(17)

    installEchartsResize(win)
    expect(addEventListener).toHaveBeenCalledTimes(2)
  })
})

// Task 733 (012-13, D-13 test B-10, binding rule 2): the chart container sweep is bound to the
// change scopes. After a change outside any chart, nothing queries the document or the root (the
// observer's leading sweep included, so the receivers are counted over the whole case, not per
// frame only); a chart spun inside the change's scope is still observed for its width.
describe.each([1, 4, 16] as const)(
  'echarts container sweep at factor %i (D-13 B-10)',
  { timeout: 60_000 },
  (factor: Factor) => {
    const chartFence =
      '\n```echarts\n{"series":[]}\n```\n\n```mermaid\ngraph TD\nA-->B\n```\n'

    async function installOnFixture() {
      vi.resetModules()
      const { root } = irFixture(tableHeavyMarkdown(factor) + chartFence)
      const app = document.createElement('div')
      app.id = 'app'
      app.append(root.parentElement as HTMLElement)
      document.body.replaceChildren(app)
      const clock = costClock()
      const lanes = fakeLanes(clock)
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
        lanes.requestAnimationFrame(() => callback(clock.now())),
      )
      vi.stubGlobal('cancelAnimationFrame', (handle: number) =>
        lanes.cancelAnimationFrame(handle),
      )
      vi.spyOn(performance, 'now').mockImplementation(() => clock.now())
      const observed = new Set<Element>()
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe(target: Element) {
            observed.add(target)
          }
          unobserve(target: Element) {
            observed.delete(target)
          }
          disconnect() {
            observed.clear()
          }
        },
      )
      const listeners = new Set<(change: UnitsChange) => void>()
      const changes = await import('../util/unit-changes')
      changes.provideUnitFeed(window, {
        root,
        isLive: () => true,
        liveUnitOf: () => undefined,
        liveUnits: () => undefined,
        onUnitsChanged(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        confirmNow: () => true,
        confirmedLines: () => undefined,
      })
      const fit = await import('./echarts-fit')
      const dispose = fit.installEchartsResize(window)
      const frames = () => {
        for (let index = 0, more = true; more && index < 200; index++) {
          more = false
          const request = lanes.requestAnimationFrame
          lanes.requestAnimationFrame = (callback) => {
            more = true
            return request(callback)
          }
          countBudget(root, () => lanes.runFrame())
          lanes.requestAnimationFrame = request
        }
      }
      frames()
      await new Promise((resolve) => setTimeout(resolve, 0))
      frames()
      // Queries whose receiver is the document, `#app` or the root, from here on.
      let wideQueries = 0
      const wide = (receiver: unknown) =>
        receiver === document || receiver === app || receiver === root
      for (const owner of [Document.prototype, Element.prototype] as const) {
        const original = owner.querySelectorAll
        vi.spyOn(owner, 'querySelectorAll').mockImplementation(function (
          this: ParentNode,
          selectors: string,
        ) {
          if (wide(this)) wideQueries++
          return original.call(this, selectors)
        } as typeof original)
      }
      return {
        root,
        observed,
        frames,
        wideQueries: () => wideQueries,
        emit(change: UnitsChange & { scopes?: HTMLElement[] }) {
          for (const listener of [...listeners]) listener(change)
        },
        close() {
          dispose()
          changes.provideUnitFeed(window, undefined)
          vi.unstubAllGlobals()
          vi.restoreAllMocks()
        },
      }
    }

    it('queries neither the document nor the root after a paragraph spun twice', async () => {
      const fit = await installOnFixture()
      try {
        let paragraph = fit.root.querySelector<HTMLElement>(':scope > p')!
        for (const key of ['x', 'y']) {
          const spun = paragraph.cloneNode(true) as HTMLElement
          spun.textContent = `spun ${key}`
          paragraph.replaceWith(spun)
          paragraph = spun
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        fit.emit({
          cause: 'mutation',
          whole: false,
          changed: [
            {
              el: paragraph,
              members: [paragraph],
              kind: 'paragraph',
              top: paragraph,
            },
          ],
          structural: [paragraph],
          scopes: [paragraph],
        })
        fit.frames()

        expect(fit.wideQueries()).toBe(0)
      } finally {
        fit.close()
      }
    })

    it('observes a chart spun inside the change scope', async () => {
      const fit = await installOnFixture()
      try {
        const block = document.createElement('div')
        block.className = 'vditor-ir__node'
        block.setAttribute('data-block', '0')
        block.setAttribute('data-type', 'code-block')
        block.innerHTML =
          '<pre class="vditor-ir__marker--pre vditor-ir__marker"><code class="language-echarts">{}\n</code></pre><pre class="vditor-ir__preview" data-render="2"><div class="language-echarts"></div></pre>'
        fit.root.querySelector(':scope > p')!.after(block)
        await new Promise((resolve) => setTimeout(resolve, 0))
        fit.emit({
          cause: 'mutation',
          whole: false,
          changed: [{ el: block, members: [block], kind: 'fence', top: block }],
          structural: [block],
          scopes: [block],
        })
        fit.frames()
        const chart = block.querySelector(
          '.vditor-ir__preview > .language-echarts',
        )
        block.remove()

        expect(chart && fit.observed.has(chart)).toBe(true)
      } finally {
        fit.close()
      }
    })
  },
)
