// @vitest-environment jsdom

// Task 643 step 3 (RED): the full-Preview renderer driver and its route hook. Vditor's renderers
// are mocked (they need a browser and the CDN); Lute is the real vendored build so the HTML is real.
import fs from 'node:fs'
import vm from 'node:vm'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest'

const renderers = vi.hoisted(() => ({
  abcRender: vi.fn(),
  chartRender: vi.fn(),
  codeRender: vi.fn(),
  flowchartRender: vi.fn(),
  graphvizRender: vi.fn(),
  highlightRender: vi.fn(),
  renderImageCaptions: vi.fn(),
  mathRender: vi.fn(),
  mediaRender: vi.fn(),
  mermaidRender: vi.fn(),
  SMILESRender: vi.fn(),
  markmapRender: vi.fn(),
  mindmapRender: vi.fn(),
  plantumlRender: vi.fn(),
  wavedromRender: vi.fn(),
}))
vi.mock('vditor/src/ts/markdown/abcRender', () => ({
  abcRender: renderers.abcRender,
}))
vi.mock('vditor/src/ts/markdown/chartRender', () => ({
  chartRender: renderers.chartRender,
}))
vi.mock('vditor/src/ts/markdown/codeRender', () => ({
  codeRender: renderers.codeRender,
}))
vi.mock('vditor/src/ts/markdown/flowchartRender', () => ({
  flowchartRender: renderers.flowchartRender,
}))
vi.mock('vditor/src/ts/markdown/graphvizRender', () => ({
  graphvizRender: renderers.graphvizRender,
}))
vi.mock('vditor/src/ts/markdown/highlightRender', () => ({
  highlightRender: renderers.highlightRender,
}))
vi.mock('vditor/src/ts/markdown/imageCaptionRender', () => ({
  renderImageCaptions: renderers.renderImageCaptions,
}))
vi.mock('vditor/src/ts/markdown/mathRender', () => ({
  mathRender: renderers.mathRender,
}))
vi.mock('vditor/src/ts/markdown/mediaRender', () => ({
  mediaRender: renderers.mediaRender,
}))
vi.mock('vditor/src/ts/markdown/mermaidRender', () => ({
  mermaidRender: renderers.mermaidRender,
}))
vi.mock('vditor/src/ts/markdown/SMILESRender', () => ({
  SMILESRender: renderers.SMILESRender,
}))
vi.mock('vditor/src/ts/markdown/markmapRender', () => ({
  markmapRender: renderers.markmapRender,
}))
vi.mock('vditor/src/ts/markdown/mindmapRender', () => ({
  mindmapRender: renderers.mindmapRender,
}))
vi.mock('vditor/src/ts/markdown/plantumlRender', () => ({
  plantumlRender: renderers.plantumlRender,
}))
vi.mock('vditor/src/ts/markdown/wavedromRender', () => ({
  wavedromRender: renderers.wavedromRender,
}))

import { deferWhilePaused } from '../util/observe-coalesce'
import {
  PREVIEW_BLOCK_RELEASED_EVENT,
  PREVIEW_RENDER_MARGIN_PX,
  blockQueryRoot,
  installFullPreviewRoute,
  renderFullPreview,
} from './preview-render'

interface RealLute {
  Md2HTML(markdown: string): string
  SetSoftBreak2HardBreak(enabled: boolean): void
}

let lute: RealLute
beforeAll(() => {
  const sandbox: Record<string, unknown> = {
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(
    fs.readFileSync(
      `${process.cwd()}/media-src/vendor/lute/lute.min.js`,
      'utf8',
    ),
    sandbox,
    { filename: 'lute.min.js' },
  )
  lute = (sandbox as { Lute: { New(): RealLute } }).Lute.New()
})

// A controllable IntersectionObserver, as in diagram-retheme.test.ts: `intersect` simulates a scroll-in.
class ControlledIntersectionObserver {
  static instances: ControlledIntersectionObserver[] = []
  readonly observed = new Set<Element>()
  readonly observe = vi.fn((target: Element) => this.observed.add(target))
  readonly unobserve = vi.fn((target: Element) => this.observed.delete(target))
  readonly disconnect = vi.fn(() => this.observed.clear())
  constructor(
    readonly callback: (entries: IntersectionObserverEntry[]) => void,
    readonly options?: IntersectionObserverInit,
  ) {
    ControlledIntersectionObserver.instances.push(this)
  }
  intersect(target: Element): void {
    if (!this.observed.has(target)) return
    this.callback([
      { isIntersecting: true, target } as IntersectionObserverEntry,
    ])
  }
}

// Manual animation frames so a streaming test decides when each yield resumes.
let frames: Array<() => void> = []
const flushFrame = async (): Promise<void> => {
  const batch = frames
  frames = []
  for (const callback of batch) callback()
  await Promise.resolve()
  await Promise.resolve()
}

interface TestVditor {
  lute: RealLute
  currentMode: 'ir' | 'wysiwyg' | 'sv'
  options: {
    cdn: string
    theme: string
    customRenders: Array<{ render(root: unknown, vditor: unknown): void }>
    preview: {
      hljs: { style: string }
      math: { inlineDigit: boolean }
      delay?: number
      markdown: { imageCaption: boolean }
      render: { media: { enable: boolean } }
    }
  }
  preview: {
    element: HTMLElement
    previewElement: HTMLElement
    render: Mock<(vditor: unknown, value?: string, immediate?: boolean) => void>
  }
  outline: {
    element?: HTMLElement
    render: Mock<(vditor: unknown) => string>
  }
  ir: { element: HTMLElement }
  sv: { element: HTMLElement }
  wysiwyg: { element: HTMLElement }
}

function makeVditor(): TestVditor {
  document.body.innerHTML = ''
  const mount = (className: string) => {
    const wrapper = document.createElement('div')
    const element = document.createElement('div')
    element.className = className
    wrapper.append(element)
    document.body.append(wrapper)
    return element
  }
  const previewWrapper = document.createElement('div')
  previewWrapper.style.display = 'block'
  const previewElement = document.createElement('div')
  previewElement.className = 'vditor-reset'
  previewWrapper.append(previewElement)
  document.body.append(previewWrapper)
  const ir = mount('vditor-ir')
  const wysiwyg = mount('vditor-wysiwyg')
  const sv = mount('vditor-sv')
  // Full Preview: the active edit pane's wrapper is hidden.
  ir.parentElement!.style.display = 'none'
  return {
    lute,
    currentMode: 'ir',
    options: {
      cdn: '/cdn',
      theme: 'dark',
      customRenders: [],
      preview: {
        hljs: { style: 'github' },
        math: { inlineDigit: true },
        markdown: { imageCaption: false },
        render: { media: { enable: false } },
      },
    },
    preview: {
      element: previewWrapper,
      previewElement,
      render: vi.fn(),
    },
    outline: { render: vi.fn(() => '') },
    ir: { element: ir },
    wysiwyg: { element: wysiwyg },
    sv: { element: sv },
  }
}

const filler = (label: string, chars: number): string => {
  const lines: string[] = []
  for (let i = 0; lines.join('\n\n').length < chars; i++)
    lines.push(`${label} paragraph ${i} with some plain words to fill space.`)
  return lines.join('\n\n')
}

const NEAR = 'near-diagram'
const FAR = 'far-diagram'
const diagramDoc = [
  'intro paragraph',
  '',
  '```mermaid',
  `graph LR; ${NEAR}-->B`,
  '```',
  '',
  filler('between', 400),
  '',
  '```mermaid',
  `graph LR; ${FAR}-->B`,
  '```',
  '',
].join('\n')

let nowValue = 0
let spyNow: ReturnType<typeof vi.spyOn> | undefined

beforeEach(() => {
  for (const mock of Object.values(renderers)) mock.mockReset()
  ControlledIntersectionObserver.instances = []
  vi.stubGlobal('IntersectionObserver', ControlledIntersectionObserver)
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    frames.push(callback)
    return frames.length
  })
  // A block whose text names NEAR sits on screen; every other block is far below the margin.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element) {
      const near = this.textContent?.includes(NEAR) ?? false
      const top = near ? 100 : 100 + PREVIEW_RENDER_MARGIN_PX + 5_000
      return {
        top,
        bottom: top + 50,
        left: 0,
        right: 100,
        width: 100,
        height: 50,
        x: 0,
        y: top,
        toJSON: () => undefined,
      } as DOMRect
    },
  )
  delete (window as any).__vmdeOpenMetrics
  delete (window as any).__vmdePreviewRendered
  delete (window as any).__vmdeCapturePreviewSource
  delete (window as any).__vmdePreviewSnapshot
  delete (window as any).__vmdeRenderFullPreview
})

afterEach(() => {
  spyNow?.mockRestore()
  spyNow = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

afterAll(() => {
  document.body.innerHTML = ''
})

// Every performance.now() call advances 20 ms, so each chunk exceeds the 12 ms yield threshold.
const slowClock = () => {
  nowValue = 0
  spyNow = vi.spyOn(performance, 'now').mockImplementation(() => {
    nowValue += 20
    return nowValue
  })
}

describe('constants', () => {
  it('exposes the release event name and the 800 px margin', () => {
    expect(PREVIEW_BLOCK_RELEASED_EVENT).toBe('vmde-preview-block-released')
    expect(PREVIEW_RENDER_MARGIN_PX).toBe(800)
  })
})

describe('blockQueryRoot', () => {
  it('returns the block itself when it matches, plus matching descendants', () => {
    const block = document.createElement('div')
    block.className = 'language-mermaid'
    block.innerHTML = '<span class="language-math">x</span>'
    const root = blockQueryRoot(block)
    expect(Array.from(root.querySelectorAll('.language-mermaid'))).toEqual([
      block,
    ])
    expect(Array.from(root.querySelectorAll('[class*="language-"]'))).toEqual([
      block,
      block.firstElementChild,
    ])
  })

  it('returns nothing for a selector that neither the block nor its descendants match', () => {
    const block = document.createElement('p')
    block.textContent = 'plain'
    expect(
      Array.from(blockQueryRoot(block).querySelectorAll('pre > code')),
    ).toEqual([])
  })
})

describe('renderFullPreview, one pass', () => {
  it('renders the document into the preview element and reports completion once with the render id', async () => {
    const vditor = makeVditor()
    const rendered = vi.fn()
    ;(window as any).__vmdePreviewRendered = rendered
    const run = renderFullPreview(vditor, '# Title\n\nbody text\n', 7)
    expect(run).not.toBeNull()
    await run?.done
    expect(vditor.preview.previewElement.querySelector('h1')?.textContent).toBe(
      'Title',
    )
    expect(rendered).toHaveBeenCalledTimes(1)
    expect(rendered).toHaveBeenCalledWith(
      vditor,
      vditor.preview.previewElement,
      7,
    )
    expect(vditor.outline.render).toHaveBeenCalledTimes(1)
  })

  it('keeps the live DOM of unchanged blocks across a second render (morph path)', async () => {
    const vditor = makeVditor()
    await renderFullPreview(vditor, 'first\n\nsecond\n\nthird\n', 1)?.done
    const first = vditor.preview.previewElement.children[0]
    first.setAttribute('data-live', '1')
    await renderFullPreview(vditor, 'first\n\nsecond\n\nthird edited\n', 2)
      ?.done
    expect(vditor.preview.previewElement.children[0]).toBe(first)
    expect(vditor.preview.previewElement.children[2].textContent).toBe(
      'third edited',
    )
  })

  it('returns null and leaves the pane untouched when Lute throws', () => {
    const vditor = makeVditor()
    vditor.preview.previewElement.innerHTML = '<p>old</p>'
    const broken = {
      ...lute,
      Md2HTML() {
        throw new Error('lute failed')
      },
      SetSoftBreak2HardBreak: () => undefined,
    }
    expect(renderFullPreview({ ...vditor, lute: broken }, 'text', 3)).toBeNull()
    expect(vditor.preview.previewElement.innerHTML).toBe('<p>old</p>')
  })

  it('runs the cheap passes on new nodes only, never on the whole pane', async () => {
    const vditor = makeVditor()
    vditor.options.preview.markdown.imageCaption = true
    vditor.options.preview.render.media.enable = true
    await renderFullPreview(vditor, 'a\n\n![x](y.png)\n', 1)?.done
    expect(renderers.renderImageCaptions).toHaveBeenCalled()
    expect(renderers.codeRender).toHaveBeenCalled()
    expect(renderers.mediaRender).toHaveBeenCalled()
    for (const [root] of renderers.codeRender.mock.calls)
      expect(root).not.toBe(vditor.preview.previewElement)
    // Vditor's codeRender also reads `element.classList.contains(...)`, so the root must offer it.
    for (const [root] of renderers.codeRender.mock.calls)
      expect((root as HTMLElement).classList.contains('vditor-preview')).toBe(
        false,
      )
    expect(renderers.renderImageCaptions.mock.calls[0][1]).toBe('preview')
  })
})

describe('renderFullPreview, heavy blocks', () => {
  it('renders a near block at once and holds a far block pending until it scrolls near', async () => {
    const vditor = makeVditor()
    const seen: Element[][] = []
    renderers.mermaidRender.mockImplementation((root: any) => {
      seen.push(Array.from(root.querySelectorAll('.language-mermaid')))
    })
    await renderFullPreview(vditor, diagramDoc, 1)?.done
    const [near, far] = Array.from(
      vditor.preview.previewElement.querySelectorAll<HTMLElement>(
        '.language-mermaid',
      ),
    )
    expect(near.hasAttribute('data-vmde-preview-pending')).toBe(false)
    expect(far.hasAttribute('data-vmde-preview-pending')).toBe(true)
    const rendered = seen.flat()
    expect(rendered).toContain(near)
    expect(rendered).not.toContain(far)

    const released = vi.fn()
    document.addEventListener(PREVIEW_BLOCK_RELEASED_EVENT, released)
    const observer = ControlledIntersectionObserver.instances.at(-1)!
    seen.length = 0
    observer.intersect(far)
    document.removeEventListener(PREVIEW_BLOCK_RELEASED_EVENT, released)

    expect(far.hasAttribute('data-vmde-preview-pending')).toBe(false)
    expect(seen.flat()).toEqual([far])
    expect(released).toHaveBeenCalledTimes(1)
    expect((released.mock.calls[0][0] as CustomEvent).detail.block).toBe(far)
  })

  it('runs the native renderers in afterRender order, custom renders and math last', async () => {
    const vditor = makeVditor()
    const order: string[] = []
    const record = (name: string) => () => {
      order.push(name)
    }
    renderers.highlightRender.mockImplementation(record('highlight'))
    renderers.mermaidRender.mockImplementation(record('mermaid'))
    renderers.markmapRender.mockImplementation(record('markmap'))
    renderers.SMILESRender.mockImplementation(record('smiles'))
    renderers.flowchartRender.mockImplementation(record('flowchart'))
    renderers.graphvizRender.mockImplementation(record('graphviz'))
    renderers.wavedromRender.mockImplementation(record('wavedrom'))
    renderers.chartRender.mockImplementation(record('chart'))
    renderers.mindmapRender.mockImplementation(record('mindmap'))
    renderers.plantumlRender.mockImplementation(record('plantuml'))
    renderers.abcRender.mockImplementation(record('abc'))
    renderers.mathRender.mockImplementation(record('math'))
    vditor.options.customRenders = [{ render: record('custom') }]
    await renderFullPreview(
      vditor,
      `\`\`\`mermaid\ngraph LR; ${NEAR}-->B\n\`\`\`\n`,
      1,
    )?.done
    expect(order).toEqual([
      'highlight',
      'mermaid',
      'markmap',
      'smiles',
      'flowchart',
      'graphviz',
      'wavedrom',
      'chart',
      'mindmap',
      'plantuml',
      'abc',
      'custom',
      'math',
    ])
    expect(renderers.mermaidRender.mock.calls[0].slice(1)).toEqual([
      '/cdn',
      'dark',
    ])
  })

  it('does not render a pending block when a newer render replaced it', async () => {
    const vditor = makeVditor()
    await renderFullPreview(vditor, diagramDoc, 1)?.done
    const far =
      vditor.preview.previewElement.querySelectorAll<HTMLElement>(
        '.language-mermaid',
      )[1]
    const observer = ControlledIntersectionObserver.instances.at(-1)!
    renderers.mermaidRender.mockClear()
    await renderFullPreview(vditor, 'plain replacement\n', 2)?.done
    observer.intersect(far)
    expect(renderers.mermaidRender).not.toHaveBeenCalled()
  })
})

describe('renderFullPreview, streaming', () => {
  const big = () => `${filler('stream', 60_000)}\n`

  it('appends chunk by chunk and yields a frame between them', async () => {
    slowClock()
    const vditor = makeVditor()
    const pane = vditor.preview.previewElement
    const done = vi.fn()
    ;(window as any).__vmdePreviewRendered = done
    const run = renderFullPreview(vditor, big(), 1)
    expect(run).not.toBeNull()
    const afterFirst = pane.children.length
    expect(afterFirst).toBeGreaterThan(0)
    expect(done).not.toHaveBeenCalled()
    await flushFrame()
    expect(pane.children.length).toBeGreaterThan(afterFirst)
    let guard = 0
    while (done.mock.calls.length === 0 && guard++ < 20) await flushFrame()
    await run?.done
    expect(done).toHaveBeenCalledTimes(1)
    expect(done).toHaveBeenCalledWith(vditor, pane, 1)
    expect(vditor.outline.render).toHaveBeenCalledTimes(1)
  })

  it('assembles the same HTML as one pass', async () => {
    const vditor = makeVditor()
    const markdown = big()
    const run = renderFullPreview(vditor, markdown, 1)
    let guard = 0
    while (guard++ < 30) {
      await flushFrame()
    }
    await run?.done
    lute.SetSoftBreak2HardBreak(true)
    const reference = document.createElement('div')
    reference.innerHTML = lute.Md2HTML(markdown)
    expect(vditor.preview.previewElement.innerHTML).toBe(reference.innerHTML)
  })

  it('stops an older stream when a newer render starts, and completes only the newer one', async () => {
    slowClock()
    const vditor = makeVditor()
    const pane = vditor.preview.previewElement
    const done = vi.fn()
    ;(window as any).__vmdePreviewRendered = done
    const older = renderFullPreview(vditor, big(), 1)
    await renderFullPreview(vditor, 'newer text\n', 2)?.done
    const snapshot = pane.innerHTML
    for (let i = 0; i < 10; i++) await flushFrame()
    await older?.done
    expect(pane.innerHTML).toBe(snapshot)
    expect(pane.textContent).toContain('newer text')
    expect(done).toHaveBeenCalledTimes(1)
    expect(done).toHaveBeenCalledWith(vditor, pane, 2)
  })

  it('falls back to one Vditor render of the whole text when a chunk throws', async () => {
    slowClock()
    const vditor = makeVditor()
    let calls = 0
    const flaky = {
      ...lute,
      Md2HTML(markdown: string) {
        calls++
        if (calls === 2) throw new Error('second chunk failed')
        return lute.Md2HTML(markdown)
      },
      SetSoftBreak2HardBreak: () => undefined,
    }
    const restore = installFullPreviewRoute(vditor)
    let routed: unknown = 'unset'
    vditor.preview.render.mockImplementation(() => {
      routed = (window as any).__vmdeRenderFullPreview(vditor, undefined, true)
    })
    const run = renderFullPreview({ ...vditor, lute: flaky }, big(), 1)
    for (let i = 0; i < 10; i++) await flushFrame()
    await run?.done
    restore()
    expect(vditor.preview.render).toHaveBeenCalledTimes(1)
    expect(vditor.preview.render).toHaveBeenCalledWith(
      expect.objectContaining({ preview: vditor.preview }),
      undefined,
      true,
    )
    // While the fallback render runs, the route must step aside so Vditor's own render proceeds.
    expect(routed).toBe(false)
  })

  it('records chunk metrics on the open-metrics object', async () => {
    slowClock()
    const vditor = makeVditor()
    const run = renderFullPreview(vditor, big(), 1)
    for (let i = 0; i < 10; i++) await flushFrame()
    await run?.done
    // The visible and complete times are taken two frames after the work (painted, not just in the DOM).
    for (let i = 0; i < 4; i++) await flushFrame()
    const metrics = (window as any).__vmdeOpenMetrics
    expect(metrics.previewChunks).toBeGreaterThan(2)
    expect(typeof metrics.previewMaxChunkMs).toBe('number')
    expect(typeof metrics.contentVisibleMs).toBe('number')
    expect(metrics.completeMs).toBeGreaterThanOrEqual(metrics.contentVisibleMs)
  })

  it('keeps unchanged leading blocks when a streamed Preview is re-rendered with a small edit', async () => {
    const vditor = makeVditor()
    const pane = vditor.preview.previewElement
    const markdown = big()
    const first = renderFullPreview(vditor, markdown, 1)
    for (let i = 0; i < 30; i++) await flushFrame()
    await first?.done
    const head = pane.children[0]
    const edited = `${markdown.slice(0, -10)}tail edit\n`
    const second = renderFullPreview(vditor, edited, 2)
    for (let i = 0; i < 30; i++) await flushFrame()
    await second?.done
    expect(pane.children[0]).toBe(head)
    expect(pane.textContent).toContain('tail edit')
  })
})

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('installFullPreviewRoute', () => {
  it('handles full Preview from the exact source snapshot and passes the capture token through', async () => {
    const vditor = makeVditor()
    ;(window as any).__vmdePreviewSnapshot = () => '# From snapshot\n'
    ;(window as any).__vmdeCapturePreviewSource = vi.fn(() => 9)
    const rendered = vi.fn()
    ;(window as any).__vmdePreviewRendered = rendered
    const dispose = installFullPreviewRoute(vditor)
    const handled = (window as any).__vmdeRenderFullPreview(
      vditor,
      undefined,
      true,
    )
    expect(handled).toBe(true)
    await nextTask()
    expect(vditor.preview.previewElement.querySelector('h1')?.textContent).toBe(
      'From snapshot',
    )
    expect(rendered).toHaveBeenCalledWith(
      vditor,
      vditor.preview.previewElement,
      9,
    )
    dispose()
    expect((window as any).__vmdeRenderFullPreview).toBeUndefined()
  })

  it('masks block comments the way the Vditor Preview chain does', async () => {
    const vditor = makeVditor()
    ;(window as any).__vmdePreviewSnapshot = () =>
      'before\n\n<!-- hidden -->\n\nafter\n'
    installFullPreviewRoute(vditor)
    ;(window as any).__vmdeRenderFullPreview(vditor, undefined, true)
    await nextTask()
    expect(
      vditor.preview.previewElement.querySelector('.vmde-comment'),
    ).not.toBeNull()
  })

  it('renders an empty document as an empty pane and still reports completion', async () => {
    const vditor = makeVditor()
    vditor.preview.previewElement.innerHTML = '<p>stale</p>'
    ;(window as any).__vmdePreviewSnapshot = () => '  \n'
    const rendered = vi.fn()
    ;(window as any).__vmdePreviewRendered = rendered
    installFullPreviewRoute(vditor)
    expect(
      (window as any).__vmdeRenderFullPreview(vditor, undefined, true),
    ).toBe(true)
    await nextTask()
    expect(vditor.preview.previewElement.innerHTML).toBe('')
    expect(rendered).toHaveBeenCalledTimes(1)
  })

  it('declines an explicit value, which Vditor renders itself', () => {
    const vditor = makeVditor()
    installFullPreviewRoute(vditor)
    expect(
      (window as any).__vmdeRenderFullPreview(vditor, '<p>x</p>', false),
    ).toBe(false)
  })

  it('declines Split view, where the source pane is shown beside the preview', () => {
    const vditor = makeVditor()
    vditor.currentMode = 'sv'
    vditor.sv.element.style.display = 'block'
    ;(window as any).__vmdePreviewSnapshot = () => 'text\n'
    installFullPreviewRoute(vditor)
    expect(
      (window as any).__vmdeRenderFullPreview(vditor, undefined, false),
    ).toBe(false)
    expect(vditor.preview.previewElement.innerHTML).toBe('')
  })

  it('handles full Preview in Split mode once the source pane is hidden', () => {
    const vditor = makeVditor()
    vditor.currentMode = 'sv'
    vditor.sv.element.style.display = 'none'
    ;(window as any).__vmdePreviewSnapshot = () => 'text\n'
    installFullPreviewRoute(vditor)
    expect(
      (window as any).__vmdeRenderFullPreview(vditor, undefined, false),
    ).toBe(true)
  })

  // Task 691: the toolbar click must not run the render in its own task, or the first paint waits
  // for the whole-document passes. The render starts in a zero-delay task, after the first paint.
  describe('immediate renders start after the first paint (task 691)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('returns at once without rendering, then renders in the next task', () => {
      const vditor = makeVditor()
      ;(window as any).__vmdePreviewSnapshot = () => '# Later\n'
      const rendered = vi.fn()
      ;(window as any).__vmdePreviewRendered = rendered
      installFullPreviewRoute(vditor)
      const hook = (window as any).__vmdeRenderFullPreview
      expect(hook(vditor, undefined, true)).toBe(true)
      expect(vditor.preview.previewElement.textContent).toBe('')
      expect(rendered).not.toHaveBeenCalled()
      vi.advanceTimersByTime(0)
      expect(
        vditor.preview.previewElement.querySelector('h1')?.textContent,
      ).toBe('Later')
      expect(rendered).toHaveBeenCalledTimes(1)
    })

    it('is cancelled by Preview off before it starts', async () => {
      const vditor = makeVditor()
      ;(window as any).__vmdePreviewSnapshot = () => 'never\n'
      const rendered = vi.fn()
      ;(window as any).__vmdePreviewRendered = rendered
      installFullPreviewRoute(vditor)
      ;(window as any).__vmdeRenderFullPreview(vditor, undefined, true)
      vditor.preview.element.style.display = 'none'
      await Promise.resolve()
      vi.advanceTimersByTime(1000)
      expect(rendered).not.toHaveBeenCalled()
      expect(vditor.preview.previewElement.textContent).toBe('')
    })

    it('renders once when a newer immediate render replaces it', () => {
      const vditor = makeVditor()
      let source = 'first\n'
      ;(window as any).__vmdePreviewSnapshot = () => source
      const rendered = vi.fn()
      ;(window as any).__vmdePreviewRendered = rendered
      installFullPreviewRoute(vditor)
      const hook = (window as any).__vmdeRenderFullPreview
      hook(vditor, undefined, true)
      source = 'second\n'
      hook(vditor, undefined, true)
      vi.advanceTimersByTime(1000)
      expect(rendered).toHaveBeenCalledTimes(1)
      expect(vditor.preview.previewElement.textContent).toContain('second')
    })

    it('is dropped when the route is disposed', () => {
      const vditor = makeVditor()
      ;(window as any).__vmdePreviewSnapshot = () => 'late\n'
      const rendered = vi.fn()
      ;(window as any).__vmdePreviewRendered = rendered
      const dispose = installFullPreviewRoute(vditor)
      ;(window as any).__vmdeRenderFullPreview(vditor, undefined, true)
      dispose()
      vi.advanceTimersByTime(1000)
      expect(rendered).not.toHaveBeenCalled()
    })

    it('lets Vditor render when the one-pass render fails', () => {
      const vditor = makeVditor()
      vditor.lute = {
        ...lute,
        Md2HTML() {
          throw new Error('boom')
        },
        SetSoftBreak2HardBreak: () => undefined,
      }
      ;(window as any).__vmdePreviewSnapshot = () => 'text\n'
      installFullPreviewRoute(vditor)
      expect(
        (window as any).__vmdeRenderFullPreview(vditor, undefined, true),
      ).toBe(true)
      expect(vditor.preview.render).not.toHaveBeenCalled()
      vi.advanceTimersByTime(0)
      expect(vditor.preview.render).toHaveBeenCalledWith(
        vditor,
        undefined,
        true,
      )
    })
  })

  describe('delayed (non-immediate) renders', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('are debounced by the Preview delay, newest source wins, and render once', () => {
      const vditor = makeVditor()
      vditor.options.preview.delay = 500
      let source = 'first\n'
      const snapshot = vi.fn(() => source)
      ;(window as any).__vmdePreviewSnapshot = snapshot
      const rendered = vi.fn()
      ;(window as any).__vmdePreviewRendered = rendered
      installFullPreviewRoute(vditor)
      const hook = (window as any).__vmdeRenderFullPreview
      expect(hook(vditor, undefined, false)).toBe(true)
      source = 'second\n'
      expect(hook(vditor, undefined, false)).toBe(true)
      vi.advanceTimersByTime(499)
      expect(vditor.preview.previewElement.textContent).toBe('')
      vi.advanceTimersByTime(1)
      expect(vditor.preview.previewElement.textContent).toContain('second')
      expect(rendered).toHaveBeenCalledTimes(1)
    })

    it('are cancelled by an immediate render', () => {
      const vditor = makeVditor()
      vditor.options.preview.delay = 500
      ;(window as any).__vmdePreviewSnapshot = () => 'now\n'
      const rendered = vi.fn()
      ;(window as any).__vmdePreviewRendered = rendered
      installFullPreviewRoute(vditor)
      const hook = (window as any).__vmdeRenderFullPreview
      hook(vditor, undefined, false)
      hook(vditor, undefined, true)
      vi.advanceTimersByTime(1000)
      expect(rendered).toHaveBeenCalledTimes(1)
    })

    it('are dropped when the route is disposed', () => {
      const vditor = makeVditor()
      vditor.options.preview.delay = 500
      ;(window as any).__vmdePreviewSnapshot = () => 'late\n'
      const rendered = vi.fn()
      ;(window as any).__vmdePreviewRendered = rendered
      const dispose = installFullPreviewRoute(vditor)
      ;(window as any).__vmdeRenderFullPreview(vditor, undefined, false)
      dispose()
      vi.advanceTimersByTime(1000)
      expect(rendered).not.toHaveBeenCalled()
    })
  })

  describe('the outline (task 643)', () => {
    it('is not rendered when its panel is closed and the document has no [ToC] block', async () => {
      const vditor = makeVditor()
      const panel = document.createElement('div')
      panel.style.display = 'none'
      vditor.outline.element = panel
      await renderFullPreview(vditor, '# Heading\n\ntext\n', 1)?.done
      expect(vditor.outline.render).not.toHaveBeenCalled()
    })

    it('is rendered when its panel is open', async () => {
      const vditor = makeVditor()
      const panel = document.createElement('div')
      panel.style.display = 'block'
      vditor.outline.element = panel
      await renderFullPreview(vditor, '# Heading\n\ntext\n', 1)?.done
      expect(vditor.outline.render).toHaveBeenCalledTimes(1)
    })

    it('is rendered for an embedded [ToC] block even when the panel is closed', async () => {
      const vditor = makeVditor()
      const panel = document.createElement('div')
      panel.style.display = 'none'
      vditor.outline.element = panel
      await renderFullPreview(
        vditor,
        '<div data-type="toc-block"></div>\n\n# Heading\n',
        1,
      )?.done
      expect(vditor.outline.render).toHaveBeenCalledTimes(1)
    })
  })

  // Review R1 (finding 5): a morph keeps unchanged blocks, including heavy ones still held back; the
  // new run's gate must watch them, or they never render once scrolled near.
  describe('a re-render after a morph (task 643)', () => {
    it('re-gates heavy blocks that survived still pending', async () => {
      const vditor = makeVditor()
      await renderFullPreview(vditor, diagramDoc, 1)?.done
      const far =
        vditor.preview.previewElement.querySelectorAll<HTMLElement>(
          '.language-mermaid',
        )[1]
      expect(far.hasAttribute('data-vmde-preview-pending')).toBe(true)

      await renderFullPreview(vditor, `${diagramDoc}\ntail edit\n`, 2)?.done
      const kept =
        vditor.preview.previewElement.querySelectorAll<HTMLElement>(
          '.language-mermaid',
        )[1]
      expect(kept).toBe(far)
      renderers.mermaidRender.mockClear()
      const observer = ControlledIntersectionObserver.instances.at(-1)!
      observer.intersect(far)
      expect(far.hasAttribute('data-vmde-preview-pending')).toBe(false)
      expect(renderers.mermaidRender).toHaveBeenCalled()
    })
  })

  // Review R1 (finding 6): turning Preview off must end a running stream and release the paused
  // observers; otherwise the hidden pane keeps rendering and edit-mode decoration stays held back.
  describe('turning Preview off (task 643)', () => {
    it('stops a running stream and releases the observers', async () => {
      slowClock()
      const vditor = makeVditor()
      const pane = vditor.preview.previewElement
      const dispose = installFullPreviewRoute(vditor)
      const run = renderFullPreview(vditor, `${filler('stream', 60_000)}\n`, 1)
      const afterFirst = pane.children.length
      expect(deferWhilePaused(() => undefined)).toBe(true)

      vditor.preview.element.style.display = 'none'
      await Promise.resolve()
      for (let i = 0; i < 6; i++) await flushFrame()
      await run?.done

      expect(pane.children.length).toBeLessThanOrEqual(afterFirst + 2)
      expect(deferWhilePaused(() => undefined)).toBe(false)
      dispose()
    })
  })
})
