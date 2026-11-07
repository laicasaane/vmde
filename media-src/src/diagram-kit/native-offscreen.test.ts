import { JSDOM } from 'jsdom'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

// Task 705 — renderNativeJobs is driven here with stubbed Vditor renderers (real engines need a live
// DOM + addScript). mermaidRender never sets data-processed, i.e. a render that never finishes.
const { mermaidRenderMock, abcRenderMock } = vi.hoisted(() => ({
  mermaidRenderMock: vi.fn(),
  abcRenderMock: vi.fn(),
}))
vi.mock('vditor/src/ts/markdown/mermaidRender', () => ({
  mermaidRender: mermaidRenderMock,
}))
vi.mock('vditor/src/ts/markdown/abcRender', () => ({
  abcRender: abcRenderMock,
}))
vi.mock('vditor/src/ts/markdown/flowchartRender', () => ({
  flowchartRender: vi.fn(),
}))

// native-offscreen imports engine-registry, which reads the `VDITOR_VERSION` esbuild define at module
// scope — provide it before the dynamic import (same pattern as engine-registry.test.ts).
let hasRenderedOutput: (temp: HTMLElement) => boolean
let adoptRender: (temp: HTMLElement, live: HTMLElement) => void
let renderNativeJobs: typeof import('./native-offscreen').renderNativeJobs
beforeAll(async () => {
  ;(globalThis as Record<string, unknown>).VDITOR_VERSION = 'test'
  ;({ hasRenderedOutput, adoptRender, renderNativeJobs } = await import(
    './native-offscreen'
  ))
})

// Task 360 — the offscreen render→swap must copy a themed error box, not only a finished <svg>.
// `hasRenderedOutput` is the swap guard: a broken native diagram (mermaid/abc/flowchart) renders its
// `.vmde-diagram-error` box offscreen instead of an <svg>, and it must still be swapped into the live
// node (else the block keeps its raw source text with data-processed="true" and never shows an error).
describe('hasRenderedOutput (native-offscreen swap guard)', () => {
  let doc: Document
  beforeEach(() => {
    doc = new JSDOM('<!doctype html><body></body>').window.document
  })
  const temp = (html: string): HTMLElement => {
    const d = doc.createElement('div')
    d.innerHTML = html
    return d
  }

  it('swaps a finished <svg> render', () => {
    expect(hasRenderedOutput(temp('<svg><g></g></svg>'))).toBe(true)
  })

  it('swaps a themed error box (the task-360 fix — broken render, no svg)', () => {
    expect(
      hasRenderedOutput(
        temp(
          '<div class="vmde-diagram-error"><div class="vmde-diagram-error__title">Mermaid</div><pre class="vmde-diagram-error__msg">Parse error</pre></div>',
        ),
      ),
    ).toBe(true)
  })

  it('does NOT swap raw source text (still rendering / never produced output)', () => {
    expect(hasRenderedOutput(temp('flowchart TD\n  A --&lt; B\n'))).toBe(false)
  })

  it('does NOT swap an empty temp', () => {
    expect(hasRenderedOutput(temp(''))).toBe(false)
  })
})

// The offscreen render happens in a sandbox node, so anything the engine wrote on THAT node has to be
// carried to the live one. `data-code` is the abc source: the patched abcRender reads it on a re-render
// (the SVG has clobbered textContent). Losing it made a theme flip re-render an EMPTY score — the abc
// diagram vanished permanently, and it was invisible in the flip e2e because "0 svgs before == 0 svgs
// after" read as a stable render.
describe('adoptRender (sandbox temp → live node)', () => {
  let doc: Document
  beforeEach(() => {
    doc = new JSDOM('<!doctype html><body></body>').window.document
  })
  const el = (html = ''): HTMLElement => {
    const d = doc.createElement('div')
    d.innerHTML = html
    return d
  }

  it('copies the rendered children into the live node', () => {
    const live = el('old source text')
    adoptRender(el('<svg><g id="drawn"></g></svg>'), live)
    expect(live.querySelector('#drawn')).not.toBeNull()
  })

  it('carries data-code across so a later re-render still has the source', () => {
    const temp = el('<svg></svg>')
    temp.setAttribute('data-code', 'X:1\nK:C\nCDEF|')
    const live = el()
    adoptRender(temp, live)
    expect(live.getAttribute('data-code')).toBe('X:1\nK:C\nCDEF|')
  })

  it('leaves data-code untouched when the engine set none (mermaid/flowchart)', () => {
    const live = el()
    adoptRender(el('<svg></svg>'), live)
    expect(live.hasAttribute('data-code')).toBe(false)
  })
})

// Task 705 (F6, F7) — acceptance: "No inventoried path ends with a blank or missing diagram without a
// visible error". The old poll gave up after 1200 frames (~20 s) and adopted nothing; the plan replaces
// it with a 35 s time cap (above the 30 s render timeout) that paints the mermaid timeout error box.
describe('renderNativeJobs — mermaid poll cap and empty source (task 705)', () => {
  let doc: Document
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><body></body>')
    doc = dom.window.document
    const g = globalThis as unknown as Record<string, unknown>
    g.document = doc
    g.window = dom.window
    g.getComputedStyle = (
      dom.window as unknown as Window
    ).getComputedStyle.bind(dom.window)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    g.requestAnimationFrame = (cb: (t: number) => void) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number
    mermaidRenderMock.mockReset()
    abcRenderMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    const g = globalThis as unknown as Record<string, unknown>
    delete g.document
    delete g.window
    delete g.getComputedStyle
    delete g.requestAnimationFrame
  })

  const liveNode = (): HTMLElement => {
    const live = doc.createElement('div')
    live.className = 'language-mermaid'
    doc.body.appendChild(live)
    return live
  }

  it('paints the timeout error box into a mermaid block that never finishes, after the 35 s cap', () => {
    const live = liveNode()
    renderNativeJobs(
      'mermaid',
      [{ live, source: 'flowchart TD\n A-->B' }],
      'cdn',
      'dark',
    )
    vi.advanceTimersByTime(34_000)
    expect(live.querySelector('.vmde-diagram-error')).toBeNull() // cap not reached yet
    vi.advanceTimersByTime(2_000)
    const box = live.querySelector('.vmde-diagram-error')
    expect(box).not.toBeNull()
    expect(box?.textContent).toContain(
      'Mermaid did not finish drawing this diagram within 30 seconds.',
    )
  })

  it("keeps today's behaviour for other languages (no error box when abc never finishes)", () => {
    const live = doc.createElement('div')
    live.className = 'language-abc'
    doc.body.appendChild(live)
    renderNativeJobs('abc', [{ live, source: 'X:1' }], 'cdn', 'dark')
    vi.advanceTimersByTime(40_000)
    expect(live.querySelector('.vmde-diagram-error')).toBeNull()
  })

  it('skips a mermaid job with an empty (whitespace-only) source', () => {
    const live = liveNode()
    renderNativeJobs('mermaid', [{ live, source: '  \n\t ' }], 'cdn', 'dark')
    vi.advanceTimersByTime(40_000)
    expect(mermaidRenderMock).not.toHaveBeenCalled()
    expect(live.querySelector('.vmde-diagram-error')).toBeNull()
  })
})
