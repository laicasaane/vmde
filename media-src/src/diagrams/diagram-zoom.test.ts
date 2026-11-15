// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeDiagramZoom, zoomBy } from './diagram-zoom'
import { controllerForDiagram } from './diagram-viewport-controller'
import {
  type Factor,
  costClock,
  countBudget,
  fakeLanes,
  irFixture,
} from '../testing/budget-harness'
import type { UnitFeed, UnitsChange } from '../util/unit-changes'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'

describe('zoomBy — pure zoom math', () => {
  it('zooms in/out by the given factor, clamped to [MIN_K, MAX_K]', () => {
    const st = { k: 1, tx: 0, ty: 0 }
    expect(
      zoomBy({ style: {} } as unknown as SVGElement, st, 1.12, 50, 50),
    ).toBe(true)
    expect(st.k).toBeCloseTo(1.12)
    zoomBy({ style: {} } as unknown as SVGElement, st, 1 / 1.12, 50, 50)
    expect(st.k).toBeCloseTo(1)
  })

  it('no-ops (returns false, leaves state alone) once the MAX_K clamp is hit', () => {
    const st = { k: 12, tx: 0, ty: 0 } // MAX_K
    const changed = zoomBy(
      { style: {} } as unknown as SVGElement,
      st,
      1.12,
      0,
      0,
    )
    expect(changed).toBe(false)
    expect(st.k).toBe(12)
  })

  it('no-ops once the MIN_K clamp is hit', () => {
    const st = { k: 0.4, tx: 0, ty: 0 } // MIN_K
    const changed = zoomBy(
      { style: {} } as unknown as SVGElement,
      st,
      1 / 1.12,
      0,
      0,
    )
    expect(changed).toBe(false)
    expect(st.k).toBe(0.4)
  })
})

// A rendered static-SVG diagram (mermaid/d2/flowchart/graphviz/abc/smiles) inside a preview pane.
function buildDiagram(): {
  app: HTMLElement
  wrapper: HTMLElement
  svg: SVGElement
} {
  const app = document.createElement('div')
  app.innerHTML =
    '<div class="vditor-ir__preview"><div class="language-mermaid"><svg><rect /></svg></div></div>'
  document.body.appendChild(app)
  return {
    app,
    wrapper: app.querySelector('.language-mermaid') as HTMLElement,
    svg: app.querySelector('svg') as unknown as SVGElement,
  }
}

function keydown(
  target: HTMLElement,
  key: string,
  opts: KeyboardEventInit = {},
) {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...opts,
    }),
  )
}

// observeDiagramZoom's decorate pass runs on a scheduled requestAnimationFrame, not synchronously —
// flush it before asserting on the wrapper's bound handlers/attributes.
function flushRaf(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()))
}

describe('observeDiagramZoom — keyboard +/-/0 parity (task 459)', () => {
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

  it('does not rescan an unrelated static diagram after a local block mutation', async () => {
    const app = document.createElement('div')
    app.innerHTML = `<pre class="vditor-reset">
      <div id="first" data-block="0"><div class="vditor-ir__preview"><div class="language-mermaid"><svg></svg></div></div></div>
      <div id="second" data-block="0"><div class="vditor-ir__preview"><div class="language-mermaid"><svg></svg></div></div></div>
    </pre>`
    document.body.replaceChildren(app)
    const dispose = observeDiagramZoom(app)
    await flushRaf()
    const second = app.querySelector<HTMLElement>('#second .language-mermaid')!
    second.removeAttribute('data-vmde-zoom')

    app.querySelector('#first')?.appendChild(document.createElement('span'))
    await flushRaf()

    expect(second.hasAttribute('data-vmde-zoom')).toBe(false)
    dispose()
  })

  it('makes the wrapper script/click-focusable but NOT a Tab stop (tabindex="-1")', async () => {
    const { app, wrapper } = buildDiagram()
    const dispose = observeDiagramZoom(app)
    await flushRaf()
    expect(wrapper.getAttribute('tabindex')).toBe('-1')
    dispose()
  })

  it('admits plain drag only while Pan is pressed and Reset preserves the tool', async () => {
    const { app, wrapper, svg } = buildDiagram()
    const dispose = observeDiagramZoom(app)
    await flushRaf()
    const controller = controllerForDiagram(wrapper)!
    ;(
      wrapper as HTMLElement & { setPointerCapture(): void }
    ).setPointerCapture = () => {
      /* jsdom pointer-capture stub */
    }
    ;(
      wrapper as HTMLElement & { releasePointerCapture(): void }
    ).releasePointerCapture = () => {
      /* jsdom pointer-capture stub */
    }
    const dispatch = (type: string, x: number, y: number) =>
      wrapper.dispatchEvent(
        new PointerEvent(type, {
          button: 0,
          pointerId: 7,
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      )
    dispatch('pointerdown', 10, 10)
    dispatch('pointermove', 40, 30)
    expect(svg.style.transform).toContain('translate(0.00px, 0.00px)')
    controller.setPanEnabled(true)
    dispatch('pointerdown', 10, 10)
    dispatch('pointermove', 40, 30)
    dispatch('pointerup', 40, 30)
    expect(svg.style.transform).toContain('translate(30.00px, 20.00px)')
    controller.reset()
    expect(svg.style.transform).toContain('translate(0.00px, 0.00px)')
    expect(controller.isPanEnabled()).toBe(true)
    dispose()
  })

  it('"+"/"=" zoom in, "-" zooms out, "0" resets — same steps as the wheel handler', async () => {
    const { app, wrapper, svg } = buildDiagram()
    const dispose = observeDiagramZoom(app)
    await flushRaf()

    keydown(wrapper, '+')
    const scaleAfterPlus = svg.style.transform
    expect(scaleAfterPlus).toContain('scale(1.1200)')

    keydown(wrapper, '-')
    keydown(wrapper, '-') // net one step below 1 (started from 1.12)
    expect(svg.style.transform).not.toContain('scale(1.1200)')

    keydown(wrapper, '0')
    expect(svg.style.transform).toContain('scale(1.0000)')

    dispose()
  })

  it('ignores the key when a modifier is held (reserves Ctrl+wheel-family chords)', async () => {
    const { app, wrapper, svg } = buildDiagram()
    const dispose = observeDiagramZoom(app)
    await flushRaf()
    keydown(wrapper, '+', { ctrlKey: true })
    expect(svg.style.transform).toContain('scale(1.0000)') // unchanged
    dispose()
  })

  it('preventDefaults and stops the key from reaching an ancestor listener (no stray text insert)', async () => {
    const { app, wrapper } = buildDiagram()
    const dispose = observeDiagramZoom(app)
    await flushRaf()
    let reachedAncestor = false
    app.addEventListener('keydown', () => {
      reachedAncestor = true
    })
    const evt = new KeyboardEvent('keydown', {
      key: '+',
      bubbles: true,
      cancelable: true,
    })
    wrapper.dispatchEvent(evt)
    expect(evt.defaultPrevented).toBe(true)
    expect(reachedAncestor).toBe(false)
    dispose()
  })
})

// Task 733 (012-13, D-13 test B-10): the zoom decorator on the unit feed. A change outside any
// diagram queries nothing under the root in the frame that follows; a diagram spun inside the
// change's scope is still decorated; the open pass (`decorateAll`) runs as the frame job
// `diagram-decorate` in slices of at most 4 + 2 ms on the cost clock. Each case imports the modules
// again, so the feed slot, the module observer and a scheduler take this case's fake frames.
describe.each([1, 4, 16] as const)(
  'diagram zoom frame budget at factor %i (D-13 B-10)',
  { timeout: 60_000 },
  (factor: Factor) => {
    const tail =
      '\n```mermaid\ngraph TD\nA-->B\n```\n\n```echarts\n{"series":[]}\n```\n'
    const paint = (root: HTMLElement) => {
      for (const target of root.querySelectorAll(
        '.vditor-ir__preview > .language-mermaid',
      ))
        target.innerHTML = '<svg><rect width="8" height="8"></rect></svg>'
    }

    async function openZoom() {
      vi.resetModules()
      const { root } = irFixture(tableHeavyMarkdown(factor) + tail, paint)
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
      const listeners = new Set<(change: UnitsChange) => void>()
      const feed: UnitFeed = {
        root,
        isLive: () => true,
        liveUnitOf: () => undefined,
        liveUnits: () => undefined,
        onUnitsChanged: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        confirmNow: () => true,
        confirmedLines: () => undefined,
      }
      const changes = await import('../util/unit-changes')
      changes.provideUnitFeed(window, feed)
      const zoom = await import('./diagram-zoom')
      const dispose = zoom.observeDiagramZoom(app)
      /** Frames until one queues no frame: their summed root queries and the slowest frame. */
      const frames = () => {
        let rootQueries = 0
        let slowest = 0
        for (let index = 0, more = true; more && index < 400; index++) {
          more = false
          const request = lanes.requestAnimationFrame
          lanes.requestAnimationFrame = (callback) => {
            more = true
            return request(callback)
          }
          const start = clock.now()
          const { counts } = countBudget(root, () => lanes.runFrame())
          lanes.requestAnimationFrame = request
          rootQueries += counts.rootQueries
          slowest = Math.max(slowest, clock.now() - start)
        }
        return { rootQueries, slowest }
      }
      const opened = frames()
      await new Promise((resolve) => setTimeout(resolve, 0))
      frames()
      const close = () => {
        dispose()
        changes.provideUnitFeed(window, undefined)
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
      }
      const emit = (change: UnitsChange & { scopes?: HTMLElement[] }) => {
        for (const listener of [...listeners]) listener(change)
      }
      return { root, opened, frames, emit, close }
    }

    it('decorates the open document in frame slices of at most 4 + 2 ms', async () => {
      const zoom = await openZoom()
      try {
        expect(zoom.opened.slowest).toBeLessThanOrEqual(6)
        expect(
          zoom.root.querySelector<HTMLElement>(
            '.vditor-ir__preview > .language-mermaid',
          )?.dataset.vmdeZoom,
        ).toBe('1')
      } finally {
        zoom.close()
      }
    })

    // Two keys in one frame: the paragraph is spun twice, so the block the first records named has
    // left the document by the frame (binding rule 4: the change's scopes replace it, no root pass).
    it('queries nothing under the root after a paragraph spun twice in one frame', async () => {
      const zoom = await openZoom()
      try {
        let next = zoom.root.querySelector<HTMLElement>(':scope > p')!
        for (const key of ['a', 'b']) {
          const old = next
          next = old.cloneNode(true) as HTMLElement
          next.textContent = `spun ${factor} ${key}`
          old.replaceWith(next)
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        zoom.emit({
          cause: 'mutation',
          whole: false,
          changed: [
            { el: next, members: [next], kind: 'paragraph', top: next },
          ],
          structural: [next],
          scopes: [next],
        })

        expect(zoom.frames().rootQueries).toBe(0)
      } finally {
        zoom.close()
      }
    })

    it('decorates a diagram spun inside the change scope', async () => {
      const zoom = await openZoom()
      try {
        const block = document.createElement('div')
        block.setAttribute('data-block', '0')
        block.setAttribute('data-type', 'code-block')
        block.className = 'vditor-ir__node'
        block.innerHTML =
          '<pre class="vditor-ir__marker--pre vditor-ir__marker"><code class="language-mermaid">graph LR\n</code></pre><pre class="vditor-ir__preview" data-render="2"><div class="language-mermaid"><svg><circle r="3"></circle></svg></div></pre>'
        zoom.root.querySelector(':scope > p')!.after(block)
        await new Promise((resolve) => setTimeout(resolve, 0))
        zoom.emit({
          cause: 'mutation',
          whole: false,
          changed: [{ el: block, members: [block], kind: 'fence', top: block }],
          structural: [block],
          scopes: [block],
        })
        zoom.frames()

        expect(
          block.querySelector<HTMLElement>(
            '.vditor-ir__preview > .language-mermaid',
          )?.dataset.vmdeZoom,
        ).toBe('1')
        block.remove()
      } finally {
        zoom.close()
      }
    })
  },
)
