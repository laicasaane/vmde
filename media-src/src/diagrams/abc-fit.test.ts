// @vitest-environment jsdom
// Task 733 (012-13, D-13 test B-10, binding rule 2): the abc viewBox fit is bound to the change
// scopes. The frame after a change outside any abc block queries nothing under the root; an abc
// block spun inside the change's scope still gets its viewBox; the open fit gives the fixture's
// abc picture one. Each case imports the modules again, so the feed slot and a scheduler take this
// case's fake frames and cost clock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type Factor,
  costClock,
  countBudget,
  fakeLanes,
  irFixture,
} from '../testing/budget-harness'
import type { UnitsChange } from '../util/unit-changes'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'

const ABC_FENCE =
  '\n```abc\nX:1\nK:C\nCDEF|\n```\n\n```mermaid\ngraph TD\nA-->B\n```\n'
const NOTATION =
  '<svg width="755" height="120"><path d="M0 0L10 10"></path></svg>'

/** The rendered notation abcjs leaves in each collapsed abc preview: an svg without a viewBox. */
function renderAbc(root: HTMLElement): void {
  for (const target of root.querySelectorAll(
    '.vditor-ir__preview > .language-abc',
  ))
    target.innerHTML = NOTATION
}

describe.each([1, 4, 16] as const)(
  'abc fit frame budget at factor %i (D-13 B-10)',
  { timeout: 60_000 },
  (factor: Factor) => {
    let root: HTMLElement
    let clock: ReturnType<typeof costClock>
    let lanes: ReturnType<typeof fakeLanes>
    let publish: (change: UnitsChange & { scopes?: HTMLElement[] }) => void
    let release: () => void
    let opening: { rootQueries: number; slowest: number }

    function frames(): { rootQueries: number; slowest: number } {
      const seen = { rootQueries: 0, slowest: 0 }
      for (let index = 0, more = true; more && index < 200; index++) {
        more = false
        const request = lanes.requestAnimationFrame
        lanes.requestAnimationFrame = (callback) => {
          more = true
          return request(callback)
        }
        const start = clock.now()
        seen.rootQueries += countBudget(root, () =>
          lanes.runFrame(),
        ).counts.rootQueries
        seen.slowest = Math.max(seen.slowest, clock.now() - start)
        lanes.requestAnimationFrame = request
      }
      return seen
    }

    beforeEach(async () => {
      vi.resetModules()
      root = irFixture(tableHeavyMarkdown(factor) + ABC_FENCE, renderAbc).root
      const app = document.createElement('div')
      app.id = 'app'
      app.append(root.parentElement as HTMLElement)
      document.body.replaceChildren(app)
      clock = costClock()
      lanes = fakeLanes(clock)
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
        lanes.requestAnimationFrame(() => callback(clock.now())),
      )
      vi.stubGlobal('cancelAnimationFrame', (handle: number) =>
        lanes.cancelAnimationFrame(handle),
      )
      vi.spyOn(performance, 'now').mockImplementation(() => clock.now())
      // jsdom has no SVG layout: every svg reports a 450 x 80 content box.
      Object.defineProperty(SVGElement.prototype, 'getBBox', {
        configurable: true,
        value: () => ({ x: 0, y: 0, width: 450, height: 80 }),
      })
      const listeners = new Set<(change: UnitsChange) => void>()
      publish = (change) => {
        for (const listener of [...listeners]) listener(change)
      }
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
      const fit = await import('./abc-fit')
      const dispose = fit.observeAbc(app)
      release = () => {
        dispose()
        changes.provideUnitFeed(window, undefined)
      }
      opening = frames()
      await new Promise((resolve) => setTimeout(resolve, 0))
      frames()
    }, 60_000)
    afterEach(() => {
      release()
      Reflect.deleteProperty(SVGElement.prototype, 'getBBox')
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }, 60_000)

    it('fits the open abc picture in frame slices of at most 4 + 2 ms', () => {
      expect(opening.slowest).toBeLessThanOrEqual(6)
      expect(
        root
          .querySelector('.vditor-ir__preview > .language-abc svg')
          ?.getAttribute('viewBox'),
      ).toBe('-2 -2 454 84')
    })

    it('queries nothing under the root after a paragraph spun twice in one frame', async () => {
      let paragraph = root.querySelector<HTMLElement>(
        ':scope > p',
      ) as HTMLElement
      for (const text of ['one', 'two']) {
        const spun = paragraph.cloneNode(true) as HTMLElement
        spun.textContent = text
        paragraph.replaceWith(spun)
        paragraph = spun
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      publish({
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

      expect(frames().rootQueries).toBe(0)
    })

    it('fits an abc block spun inside the change scope', async () => {
      const block = document.createElement('div')
      block.className = 'vditor-ir__node'
      block.setAttribute('data-block', '0')
      block.setAttribute('data-type', 'code-block')
      block.innerHTML = `<pre class="vditor-ir__marker--pre vditor-ir__marker"><code class="language-abc">X:2\n</code></pre><pre class="vditor-ir__preview" data-render="2"><div class="language-abc">${NOTATION}</div></pre>`
      root.querySelector(':scope > p')?.after(block)
      await new Promise((resolve) => setTimeout(resolve, 0))
      publish({
        cause: 'mutation',
        whole: false,
        changed: [{ el: block, members: [block], kind: 'fence', top: block }],
        structural: [block],
        scopes: [block],
      })
      frames()
      const viewBox = block
        .querySelector('.vditor-ir__preview > .language-abc svg')
        ?.getAttribute('viewBox')
      block.remove()

      expect(viewBox).toBe('-2 -2 454 84')
    })
  },
)
