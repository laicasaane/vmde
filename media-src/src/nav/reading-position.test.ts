// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlockAnchor } from './block-anchor'
import {
  installReadingPosition,
  shouldRestoreReadingPosition,
} from './reading-position'

const saved = {
  anchor: { hash: 'abc', index: 3, headingPath: ['Guide'] },
  scrollOffset: 12,
}

describe('reading-position restore precedence', () => {
  it('restores a saved position when enabled and no higher-priority intent exists', () => {
    expect(
      shouldRestoreReadingPosition({
        enabled: true,
        state: saved,
        prepaintIntent: 0,
        explicitReveal: false,
      }),
    ).toBe(true)
  })

  it('lets prepaint user intent win over memory', () => {
    expect(
      shouldRestoreReadingPosition({
        enabled: true,
        state: saved,
        prepaintIntent: 140,
        explicitReveal: false,
      }),
    ).toBe(false)
  })

  it('lets an explicit source reveal win over memory', () => {
    expect(
      shouldRestoreReadingPosition({
        enabled: true,
        state: saved,
        prepaintIntent: 0,
        explicitReveal: true,
      }),
    ).toBe(false)
  })

  it('does not persist or restore when the setting is disabled', () => {
    expect(
      shouldRestoreReadingPosition({
        enabled: false,
        state: saved,
        prepaintIntent: 0,
        explicitReveal: false,
      }),
    ).toBe(false)
  })
})

// Task 643: a Preview-first open has no edit view, so the reading position is saved from, and
// restored onto, the top-level blocks of the Preview pane. A streamed Preview fills in over several
// frames, so the restore waits for the exact block (or the end of the render) instead of landing on
// a block that merely shares the saved index.
describe('reading position in Preview (task 643)', () => {
  let frames: Array<() => void> = []
  const runFrame = () => {
    const batch = frames
    frames = []
    for (const callback of batch) callback()
  }
  let scrollTop = 0

  function paragraph(text: string, top: number): HTMLElement {
    const el = document.createElement('p')
    el.textContent = text
    el.dataset.top = String(top)
    return el
  }

  function mount(texts: readonly string[]) {
    document.body.innerHTML =
      '<div id="app"><div class="edit"><div class="vditor-ir"></div></div><div class="preview"><div class="pane"></div></div></div>'
    const ir = document.querySelector<HTMLElement>('.vditor-ir')!
    const wrapper = document.querySelector<HTMLElement>('.preview')!
    const pane = document.querySelector<HTMLElement>('.pane')!
    ir.parentElement!.style.display = 'none'
    wrapper.style.display = 'block'
    for (const [index, text] of texts.entries())
      pane.append(paragraph(text, index * 100))
    const vditor = {
      vditor: {
        currentMode: 'ir',
        ir: { element: ir },
        preview: { element: wrapper, previewElement: pane },
      },
    }
    return { vditor, pane }
  }

  // The state a saved Preview position holds for block `index` of `texts`, built on a reference DOM.
  function anchorFor(texts: readonly string[], index: number) {
    const reference = texts.map((text, i) => paragraph(text, i * 100))
    return createBlockAnchor(reference[index], reference)
  }

  const setMetrics = (value: object) => {
    ;(window as any).__vmdeOpenMetrics = value
  }

  const api = () => ({ getState: () => undefined, setState: vi.fn() })

  beforeEach(() => {
    frames = []
    scrollTop = 0
    delete (window as any).__vmdeOpenMetrics
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      frames.push(callback)
      return frames.length
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const top = Number(this.dataset.top ?? 0) - scrollTop
        return {
          top,
          bottom: top + 50,
          left: 0,
          right: 10,
          width: 10,
          height: 50,
        } as DOMRect
      },
    )
    Object.defineProperty(document.documentElement, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('saves the position of the Preview block at the top of the view', () => {
    const { vditor } = mount(['alpha', 'beta', 'gamma', 'delta'])
    scrollTop = 160 // blocks 0 and 1 are scrolled past; block 2 (top 200) is the first still visible
    const persist = vi.fn()
    const controller = installReadingPosition(
      vditor as never,
      undefined,
      persist,
      true,
      api() as never,
    )
    const state = controller.save()
    expect(state?.anchor.index).toBe(2)
    expect(state?.scrollOffset).toBe(40)
    expect(persist).toHaveBeenCalledWith(state)
    controller.dispose()
  })

  it('restores onto the exact Preview block, writing the saved offset', () => {
    const texts = ['alpha', 'beta', 'gamma', 'delta']
    const { vditor } = mount(texts)
    setMetrics({ completeMs: 1 })
    installReadingPosition(
      vditor as never,
      { anchor: anchorFor(texts, 2), scrollOffset: 20 },
      vi.fn(),
      true,
      api() as never,
    )
    runFrame()
    expect(scrollTop).toBe(180) // block 2 sits at 200; offset 20 puts it 20 px below the view top
  })

  it('waits for the exact block while the Preview streams in, instead of landing on the same index', () => {
    const texts = ['alpha', 'beta', 'gamma', 'delta']
    // only two blocks have streamed so far
    const { vditor, pane } = mount(texts.slice(0, 2))
    setMetrics({})
    const controller = installReadingPosition(
      vditor as never,
      { anchor: anchorFor(texts, 3), scrollOffset: 0 },
      vi.fn(),
      true,
      api() as never,
    )
    runFrame()
    expect(scrollTop).toBe(0) // index 3 does not exist yet and no fallback may be taken
    pane.append(paragraph('gamma', 200), paragraph('delta', 300))
    runFrame()
    expect(scrollTop).toBe(300)
    controller.dispose()
  })

  it('falls back to the saved index once the render has completed without the exact block', () => {
    const texts = ['alpha', 'beta', 'gamma', 'delta']
    const { vditor } = mount(['alpha', 'beta', 'changed one', 'changed two'])
    setMetrics({})
    installReadingPosition(
      vditor as never,
      { anchor: anchorFor(texts, 3), scrollOffset: 0 },
      vi.fn(),
      true,
      api() as never,
    )
    runFrame()
    expect(scrollTop).toBe(0)
    setMetrics({ completeMs: 42 })
    runFrame()
    expect(scrollTop).toBe(300) // the block now at index 3
  })

  it('does not overwrite the saved position while a Preview restore is still pending', () => {
    const texts = ['alpha', 'beta', 'gamma', 'delta']
    const { vditor } = mount(texts.slice(0, 1))
    setMetrics({})
    const persist = vi.fn()
    const controller = installReadingPosition(
      vditor as never,
      { anchor: anchorFor(texts, 3), scrollOffset: 0 },
      persist,
      true,
      api() as never,
    )
    runFrame()
    expect(controller.save()).toBeUndefined()
    expect(persist).not.toHaveBeenCalled()
    controller.dispose()
  })
})
