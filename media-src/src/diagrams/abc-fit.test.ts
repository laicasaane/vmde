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
  wysiwygFixture,
} from '../testing/budget-harness'
import type { UnitsChange } from '../util/unit-changes'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import { observeAbc } from './abc-fit'
import {
  provideUnitFeed,
  type LiveUnit,
  type UnitFeed,
} from '../util/unit-changes'

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

// ---- Task 733 / 013-T4: B-10 on the WYSIWYG fixture (D-13 design section 5.2; technical task 013) ----
//
// `observeAbc` over a live feed of Lute's WYSIWYG root (a mermaid and an echarts block appended). B-10: after a change outside the diagrams and
// after a spun paragraph, the frame queries nothing on the root (`rootQueries` 0).
describe('013 B-10 observeAbc on the WYSIWYG fixture', () => {
  const feedListeners = new Set<(change: UnitsChange) => void>()
  let wysiwygFrames: FrameRequestCallback[] = []
  let stop: (() => void) | undefined
  beforeEach(() => {
    wysiwygFrames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      wysiwygFrames.push(cb)
      return wysiwygFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })
  afterEach(() => {
    stop?.()
    stop = undefined
    provideUnitFeed(window, undefined)
    feedListeners.clear()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })
  const runWysiwygFrames = (): void => {
    for (let round = 0; round < 5 && wysiwygFrames.length > 0; round++)
      for (const frame of wysiwygFrames.splice(0)) frame(0)
  }
  const settleWysiwyg = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    runWysiwygFrames()
  }
  /** The observer callbacks of the edit run; the frames they queue run inside the count. */
  const flushRecords = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
  }
  const emit = (partial: Partial<UnitsChange>): void => {
    const change = {
      cause: 'mutation',
      whole: false,
      changed: [],
      structural: [],
      ...partial,
    } as UnitsChange
    for (const listener of Array.from(feedListeners)) listener(change)
  }
  const unitOf = (
    el: HTMLElement,
    kind: LiveUnit['kind'],
    top = el,
  ): LiveUnit => ({
    el,
    members: [el],
    kind,
    top,
  })
  async function mountWysiwyg(factor: Factor) {
    const app = document.createElement('div')
    // The production mount: observers watch `#app`, so its queries count as root queries.
    app.id = 'app'
    app.className = 'vditor vditor-wysiwyg'
    const root = document.createElement('pre')
    root.className = 'vditor-reset'
    root.setAttribute('contenteditable', 'true')
    root.innerHTML = wysiwygFixture(MARKDOWN(factor)).root.innerHTML
    app.append(root)
    document.body.append(app)
    vi.stubGlobal('vditor', {
      getCurrentMode: () => 'wysiwyg',
      vditor: { currentMode: 'wysiwyg', wysiwyg: { element: root } },
    })
    const feed: UnitFeed = {
      root,
      isLive: () => true,
      liveUnitOf: () => undefined,
      liveUnits: () => [],
      onUnitsChanged: (listener) => {
        feedListeners.add(listener)
        return () => feedListeners.delete(listener)
      },
      confirmNow: () => true,
      confirmedLines: () => undefined,
    }
    provideUnitFeed(window, feed)
    stop = observeAbc(app)
    await settleWysiwyg()
    return { app, root }
  }

  const MARKDOWN = (factor: Factor): string =>
    `${tableHeavyMarkdown(factor)}\n\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\`\n\n\`\`\`echarts\n{}\n\`\`\`\n`

  describe.each([1, 4, 16] as const)('at factor %i', (factor) => {
    it('a paragraph change outside the diagrams queries nothing on the root', async () => {
      const { root } = await mountWysiwyg(factor)
      const paragraph = root.querySelector(':scope > p') as HTMLElement
      ;(paragraph.firstChild as Text).data += 'x'
      await flushRecords()
      const { counts } = countBudget(root, () => {
        emit({ changed: [unitOf(paragraph, 'paragraph')] })
        runWysiwygFrames()
      })
      expect(counts.rootQueries, 'root queries').toBe(0)
    }, 60_000)

    it('a spun paragraph queries nothing on the root', async () => {
      const { root } = await mountWysiwyg(factor)
      const paragraph = root.querySelector(':scope > p') as HTMLElement
      const spun = paragraph.cloneNode(true) as HTMLElement
      paragraph.replaceWith(spun)
      await flushRecords()
      const { counts } = countBudget(root, () => {
        emit({
          changed: [unitOf(spun, 'paragraph')],
          structural: [spun],
          scopes: [spun],
        } as Partial<UnitsChange>)
        runWysiwygFrames()
      })
      expect(counts.rootQueries, 'root queries').toBe(0)
    }, 60_000)
  })
})
