// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mountDiagramControls,
  observeDiagramControls,
} from './diagram-controls'
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
import {
  provideUnitFeed,
  type LiveUnit,
  type UnitFeed,
} from '../util/unit-changes'

function controller() {
  let pan = false
  return {
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    reset: vi.fn(),
    setPanEnabled: vi.fn((enabled: boolean) => {
      pan = enabled
    }),
    isPanEnabled: vi.fn(() => pan),
  }
}

describe('diagram controls', () => {
  // Task 733 (012-13): the open pass runs in frame slices on the shared scheduler
  // (`diagram-decorate`, a 4 ms frame budget on the real clock). The cases here wait one real
  // frame and then read the decorations, so on a slow clock the pass could still be running (or
  // resume after a case's own mutation). The clock is held still in these cases, so the open pass
  // finishes in its first frame; the cases check decoration, not slicing (the budget tests do).
  let heldClock: { mockRestore(): void } | undefined
  beforeEach(() => {
    heldClock = vi.spyOn(performance, 'now').mockReturnValue(0)
  })
  afterEach(() => heldClock?.mockRestore())

  it('mounts one semantic four-button bar in fixed order', () => {
    const wrapper = document.createElement('div')
    const c = controller()
    const bar = mountDiagramControls(wrapper, c)
    const buttons = Array.from(bar.querySelectorAll('button'))

    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Pan diagram',
      'Zoom out',
      'Zoom in',
      'Reset view',
    ])
    expect(buttons.every((button) => button.type === 'button')).toBe(true)
    expect(bar.getAttribute('data-render')).toBe('1')
    expect(bar.querySelectorAll('[aria-hidden="true"]').length).toBe(4)
    expect(mountDiagramControls(wrapper, c)).toBe(bar)
  })

  it('dispatches actions, keeps reset last, and preserves Pan across reset', () => {
    const wrapper = document.createElement('div')
    const c = controller()
    const fullscreen = { isActive: vi.fn(() => false), toggle: vi.fn() }
    const bar = mountDiagramControls(wrapper, c, fullscreen)
    const buttons = Array.from(bar.querySelectorAll('button'))
    buttons[0].click()
    buttons[1].click()
    buttons[2].click()
    buttons[3].click()
    buttons[4].click()

    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Pan diagram',
      'Zoom out',
      'Zoom in',
      'Fullscreen diagram',
      'Reset view',
    ])
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
    expect(c.zoomOut).toHaveBeenCalledOnce()
    expect(c.zoomIn).toHaveBeenCalledOnce()
    expect(fullscreen.toggle).toHaveBeenCalledOnce()
    expect(c.reset).toHaveBeenCalledOnce()
    expect(c.isPanEnabled()).toBe(true)
  })

  it('decorates rebuilt zoomable renderers idempotently and skips inert engines', async () => {
    const app = document.createElement('div')
    app.innerHTML = `<div class="vditor-preview">
      <div class="language-markmap"><svg></svg></div>
      <div class="language-plantuml"><svg></svg></div>
    </div>`
    document.body.replaceChildren(app)
    ;(
      app.querySelector('.language-markmap svg') as SVGSVGElement & {
        __vmdeMm?: unknown
      }
    ).__vmdeMm = {}
    const dispose = observeDiagramControls(app)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(app.querySelectorAll('.vmde-diagram-controls')).toHaveLength(1)
    const original = app.querySelector<HTMLElement>('.vmde-diagram-controls')!
    const inertClone = original.cloneNode(true) as HTMLElement
    original.replaceWith(inertClone)
    app
      .querySelector('.language-markmap')!
      .appendChild(document.createElement('canvas'))
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(app.querySelectorAll('.vmde-diagram-controls')).toHaveLength(1)
    expect(app.querySelector('.vmde-diagram-controls')).not.toBe(inertClone)
    dispose()
  })

  it('does not rescan an unrelated diagram block after a local content mutation', async () => {
    const app = document.createElement('div')
    app.innerHTML = `<pre class="vditor-reset">
      <div id="first" data-block="0"><div class="vditor-ir__preview"><div class="language-markmap"><svg></svg></div></div></div>
      <div id="second" data-block="0"><div class="vditor-ir__preview"><div class="language-markmap"><svg></svg></div></div></div>
    </pre>`
    document.body.replaceChildren(app)
    for (const svg of app.querySelectorAll<
      SVGSVGElement & { __vmdeMm?: unknown }
    >('.language-markmap svg'))
      svg.__vmdeMm = {}
    const dispose = observeDiagramControls(app)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const second = app.querySelector<HTMLElement>('#second')!
    second.querySelector('.vmde-diagram-controls')?.remove()

    app.querySelector('#first')?.appendChild(document.createElement('span'))
    await new Promise((resolve) => requestAnimationFrame(resolve))

    expect(second.querySelector('.vmde-diagram-controls')).toBeNull()
    dispose()
  })
})

// Task 733 (012-13, D-13 test B-10): the viewport controls on the unit feed. The frame after a
// change outside any diagram queries nothing under the root; a diagram spun inside the change's
// scope gets its bar; the open `decorateAll` runs as the frame job `diagram-decorate` in slices of
// at most 4 + 2 ms on the cost clock. Modules are imported again per case (fresh registries).
describe.each([1, 4, 16] as const)(
  'diagram controls frame budget at factor %i (D-13 B-10)',
  { timeout: 60_000 },
  (factor: Factor) => {
    const fences = [
      '',
      '```markmap',
      '# Root',
      '## Branch',
      '```',
      '',
      '```echarts',
      '{"series":[]}',
      '```',
      '',
    ].join('\n')
    // A markmap picture carries its live instance on the svg; that instance is what gives the
    // wrapper a viewport controller (no zoom observer is needed for markmap).
    const markmapPicture = (target: Element) => {
      target.innerHTML = '<svg><g></g></svg>'
      ;(
        target.querySelector('svg') as SVGSVGElement & { __vmdeMm?: unknown }
      ).__vmdeMm = {}
    }
    const rendered = (fixtureRoot: HTMLElement) => {
      for (const target of fixtureRoot.querySelectorAll(
        '.vditor-ir__preview > .language-markmap',
      ))
        markmapPicture(target)
    }
    let root: HTMLElement
    let lanes: ReturnType<typeof fakeLanes>
    let clock: ReturnType<typeof costClock>
    let notify: (change: UnitsChange & { scopes?: HTMLElement[] }) => void
    let stop: () => void
    let openSlowest: number

    /** Every frame until none is queued: summed root queries, slowest frame on the cost clock. */
    function settleFrames(): { rootQueries: number; slowest: number } {
      const result = { rootQueries: 0, slowest: 0 }
      let queued = true
      const request = lanes.requestAnimationFrame
      lanes.requestAnimationFrame = (callback) => {
        queued = true
        return request(callback)
      }
      try {
        for (let frame = 0; queued && frame < 400; frame++) {
          queued = false
          const before = clock.now()
          result.rootQueries += countBudget(root, () =>
            lanes.runFrame(),
          ).counts.rootQueries
          result.slowest = Math.max(result.slowest, clock.now() - before)
        }
      } finally {
        lanes.requestAnimationFrame = request
      }
      return result
    }

    beforeEach(async () => {
      vi.resetModules()
      root = irFixture(tableHeavyMarkdown(factor) + fences, rendered).root
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
      const listeners = new Set<(change: UnitsChange) => void>()
      notify = (change) => {
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
      const controls = await import('./diagram-controls')
      const dispose = controls.observeDiagramControls(app)
      stop = () => {
        dispose()
        changes.provideUnitFeed(window, undefined)
      }
      openSlowest = settleFrames().slowest
      await new Promise((resolve) => setTimeout(resolve, 0))
      settleFrames()
    }, 60_000)
    afterEach(() => {
      stop()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }, 60_000)

    it('mounts the open bars in frame slices of at most 4 + 2 ms', () => {
      expect(openSlowest).toBeLessThanOrEqual(6)
      expect(root.querySelector('.vmde-diagram-controls')).not.toBeNull()
    })

    it('queries nothing under the root after a paragraph spun twice in one frame', async () => {
      let paragraph = root.querySelector<HTMLElement>(
        ':scope > p',
      ) as HTMLElement
      for (const text of ['first key', 'second key']) {
        const spun = paragraph.cloneNode(true) as HTMLElement
        spun.textContent = text
        paragraph.replaceWith(spun)
        paragraph = spun
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      notify({
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

      expect(settleFrames().rootQueries).toBe(0)
    })

    it('mounts the bar of a diagram spun inside the change scope', async () => {
      const block = document.createElement('div')
      block.className = 'vditor-ir__node'
      block.dataset.block = '0'
      block.dataset.type = 'code-block'
      block.innerHTML =
        '<pre class="vditor-ir__marker--pre vditor-ir__marker"><code class="language-markmap"># New\n</code></pre><pre class="vditor-ir__preview" data-render="2"><div class="language-markmap"></div></pre>'
      markmapPicture(
        block.querySelector('.vditor-ir__preview > .language-markmap')!,
      )
      root.querySelector(':scope > p')?.after(block)
      await new Promise((resolve) => setTimeout(resolve, 0))
      notify({
        cause: 'mutation',
        whole: false,
        changed: [{ el: block, members: [block], kind: 'fence', top: block }],
        structural: [block],
        scopes: [block],
      })
      settleFrames()
      const bar = block.querySelector(
        '.vditor-ir__preview .vmde-diagram-controls',
      )
      block.remove()

      expect(bar).not.toBeNull()
    })
  },
)

// ---- Task 733 / 013-T4: B-10 on the WYSIWYG fixture (D-13 design section 5.2; technical task 013) ----
//
// `observeDiagramControls` over a live feed of Lute's WYSIWYG root (a mermaid and an echarts block appended). B-10: after a change outside the diagrams and
// after a spun paragraph, the frame queries nothing on the root (`rootQueries` 0).
describe('013 B-10 observeDiagramControls on the WYSIWYG fixture', () => {
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
    stop = observeDiagramControls(app)
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

// Task 733 (022, part 1): with a live unit feed the diagram-controls helper still records its passes,
// so the end-to-end spec reads `__vmdeMutationImpactStats.helpers['diagram-controls']`. The observer
// callback records 'local' or 'skipped' with the record count; the feed callback records 'full'
// for a whole change, else 'local' with the scopes queued. Frames never run here: each case reads
// the counters right after the callback, before any decoration can mutate the document.
describe('the feed path records helper statistics (022)', () => {
  type StatsWindow = Window & {
    __vmdeMutationImpactStats?: {
      helpers: Record<string, Record<string, number> | undefined>
    }
  }
  const win = window as StatsWindow
  const listeners = new Set<(change: UnitsChange) => void>()
  let stopHelper: (() => void) | undefined
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    ;(win as unknown as Record<string, unknown>).__vmdeE2EReadiness = true
  })
  afterEach(() => {
    stopHelper?.()
    stopHelper = undefined
    provideUnitFeed(window, undefined)
    listeners.clear()
    delete (win as unknown as Record<string, unknown>).__vmdeE2EReadiness
    delete win.__vmdeMutationImpactStats
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })
  const helperStats = () =>
    win.__vmdeMutationImpactStats?.helpers['diagram-controls']
  const flushRecords = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
  }
  const emitChange = (partial: Partial<UnitsChange>): void => {
    const change = {
      cause: 'mutation',
      whole: false,
      changed: [],
      structural: [],
      ...partial,
    } as UnitsChange
    for (const listener of Array.from(listeners)) listener(change)
  }
  async function mountOnFeed(): Promise<HTMLElement> {
    const markdown = 'Intro text.\n\n```mermaid\ngraph TD\nA-->B\n```\n'
    const html = irFixture(markdown).root.innerHTML
    const app = document.createElement('div')
    app.id = 'app'
    const container = document.createElement('div')
    container.className = 'vditor-ir'
    const root = document.createElement('pre')
    root.className = 'vditor-reset'
    root.setAttribute('contenteditable', 'true')
    root.innerHTML = html
    container.append(root)
    app.append(container)
    document.body.replaceChildren(app)
    vi.stubGlobal('vditor', {
      getCurrentMode: () => 'ir',
      vditor: { currentMode: 'ir', ir: { element: root } },
    })
    const feed: UnitFeed = {
      root,
      isLive: () => true,
      liveUnitOf: () => undefined,
      liveUnits: () => [],
      onUnitsChanged: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      confirmNow: () => true,
      confirmedLines: () => undefined,
    }
    provideUnitFeed(window, feed)
    stopHelper = observeDiagramControls(app)
    await flushRecords()
    delete win.__vmdeMutationImpactStats
    return root
  }

  it('a record batch inside the feed root records one pass with its records', async () => {
    const root = await mountOnFeed()
    const paragraph = root.querySelector(':scope > p') as HTMLElement
    paragraph.append(document.createTextNode('x'))
    await flushRecords()
    const stats = helperStats()
    expect(stats, "helpers['diagram-controls']").toBeDefined()
    expect(stats?.callbacks).toBe(1)
    expect(stats?.records).toBe(1)
    expect((stats?.skipped ?? 0) + (stats?.local ?? 0)).toBe(1)
    expect(stats?.full).toBe(0)
  })

  it('a feed change with one diagram scope records one local pass of one block', async () => {
    const root = await mountOnFeed()
    const diagram = root.querySelector(
      ':scope > [data-type="code-block"]',
    ) as HTMLElement
    expect(diagram).not.toBeNull()
    emitChange({ scopes: [diagram] })
    const stats = helperStats()
    expect(stats, "helpers['diagram-controls']").toBeDefined()
    expect(stats?.local).toBe(1)
    expect(stats?.blocks).toBe(1)
    expect(stats?.full).toBe(0)
  })

  it('a whole change records one full pass', async () => {
    await mountOnFeed()
    emitChange({ whole: true })
    const stats = helperStats()
    expect(stats, "helpers['diagram-controls']").toBeDefined()
    expect(stats?.full).toBe(1)
  })
})
