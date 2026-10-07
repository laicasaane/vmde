// @vitest-environment jsdom
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isTyping,
  markEditActivity,
  deferUntilSettle,
  beginSettleRender,
  scheduleReveal,
  installEditActivity,
  hasFreshRender,
  flushPendingEditorRespin,
} from './edit-activity'
import { tocImpactRequiresRefresh } from './toc-invalidation'
import type { EditorMutationImpact } from '../util/mutation-impact'

// The gate's quiet window is 220 ms (private const in edit-activity.ts); tests advance well under it
// (100 ms = "still typing") and well over it (300 ms = "settled") so they don't depend on the exact value.
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.runOnlyPendingTimers() // flush any pending settle so module state doesn't leak between tests
  vi.useRealTimers()
  ;(globalThis as { vscode?: unknown }).vscode = undefined
  vi.restoreAllMocks()
})

test('isTyping is false before any input', () => {
  expect(isTyping()).toBe(false)
})

test('markEditActivity makes isTyping true, then false after the quiet window', () => {
  markEditActivity()
  expect(isTyping()).toBe(true)
  vi.advanceTimersByTime(100)
  expect(isTyping()).toBe(true) // still within the quiet window
  vi.advanceTimersByTime(200)
  expect(isTyping()).toBe(false) // settled
})

test('rapid keystrokes coalesce — the timer resets on each input', () => {
  markEditActivity()
  vi.advanceTimersByTime(100)
  markEditActivity() // resets the quiet window
  vi.advanceTimersByTime(100)
  expect(isTyping()).toBe(true) // 100 < the window since the last reset
  vi.advanceTimersByTime(200)
  expect(isTyping()).toBe(false) // settled well past the window
})

test('deferUntilSettle runs the callback once, after the user pauses', () => {
  let calls = 0
  deferUntilSettle('k', () => calls++)
  expect(calls).toBe(0) // not immediate
  vi.advanceTimersByTime(100)
  expect(calls).toBe(0)
  vi.advanceTimersByTime(200)
  expect(calls).toBe(1) // fired on settle
})

test('deferUntilSettle is keyed — latest callback wins, N keystrokes collapse to one render', () => {
  let a = 0
  let b = 0
  deferUntilSettle('render', () => a++)
  deferUntilSettle('render', () => b++) // supersedes the first under the same key
  vi.advanceTimersByTime(300)
  expect(a).toBe(0)
  expect(b).toBe(1)
})

test('distinct keys both fire on settle', () => {
  let a = 0
  let b = 0
  deferUntilSettle('native', () => a++)
  deferUntilSettle('custom', () => b++)
  vi.advanceTimersByTime(300)
  expect(a).toBe(1)
  expect(b).toBe(1)
})

test('a throwing settle callback does not wedge the gate', () => {
  deferUntilSettle('boom', () => {
    throw new Error('render failed')
  })
  expect(() => vi.advanceTimersByTime(300)).not.toThrow()
  // gate recovered: a fresh defer still fires
  let ok = 0
  deferUntilSettle('again', () => ok++)
  vi.advanceTimersByTime(300)
  expect(ok).toBe(1)
})

test('installEditActivity arms the gate on input and exposes the native defer hook', () => {
  const app = document.createElement('div')
  document.body.appendChild(app)
  const child = document.createElement('div')
  app.appendChild(child)
  const dispose = installEditActivity(app)
  expect(
    typeof (window as unknown as Record<string, unknown>)
      .__vmdeDeferIrDiagramRender,
  ).toBe('function')

  expect(isTyping()).toBe(false)
  child.dispatchEvent(new Event('input', { bubbles: true }))
  expect(isTyping()).toBe(true) // capture-phase listener armed the gate

  dispose()
  expect(
    (window as unknown as Record<string, unknown>).__vmdeDeferIrDiagramRender,
  ).toBeUndefined()
  app.remove()
})

type RenderTocHook = (
  vditor: unknown,
  renderToc: (vditor: unknown) => void,
) => void

function installedRenderTocHook(): RenderTocHook {
  const hook = (window as unknown as Record<string, unknown>)
    .__vmdeDeferRenderToc
  if (typeof hook !== 'function')
    throw new Error('renderToc hook not installed')
  return hook as RenderTocHook
}

async function deliverMutationRecords(): Promise<void> {
  await Promise.resolve()
}

test('ordinary non-heading block replacement schedules no ToC refresh', async () => {
  const app = document.createElement('div')
  app.innerHTML =
    '<div class="vditor-reset"><p data-block="0">alpha</p><h2 data-block="0">Heading</h2></div>'
  document.body.appendChild(app)
  const dispose = installEditActivity(app)
  const renderToc = vi.fn()
  const vditor = {}

  app.querySelector('p')!.outerHTML = '<p data-block="0">alphax</p>'
  installedRenderTocHook()(vditor, renderToc)
  await deliverMutationRecords()
  vi.advanceTimersByTime(300)

  expect(renderToc).not.toHaveBeenCalled()
  dispose()
  app.remove()
})

test('ordinary content plus Vditor panel chrome replacement schedules no ToC refresh', async () => {
  const app = document.createElement('div')
  app.innerHTML =
    '<div class="vditor-reset"><p data-block="0">alpha</p><h2 data-block="0">Heading</h2></div>' +
    '<div class="vditor-panel"></div>'
  document.body.appendChild(app)
  const dispose = installEditActivity(app)
  const renderToc = vi.fn()

  app.querySelector('p')!.outerHTML = '<p data-block="0">alphax</p>'
  app.querySelector('.vditor-panel')!.innerHTML = '<button>remove</button>'
  installedRenderTocHook()({}, renderToc)
  await deliverMutationRecords()
  vi.advanceTimersByTime(300)

  expect(renderToc).not.toHaveBeenCalled()
  dispose()
  app.remove()
})

test('open-time ambiguous mutations before the first request do not poison the first ordinary edit', async () => {
  const app = document.createElement('div')
  app.innerHTML =
    '<div class="vditor-reset"><p data-block="0">alpha</p><h2 data-block="0">Heading</h2></div>'
  document.body.appendChild(app)
  const dispose = installEditActivity(app)
  const renderToc = vi.fn()

  app.appendChild(document.createElement('aside'))
  await deliverMutationRecords()
  installedRenderTocHook()({}, renderToc)
  vi.advanceTimersByTime(300)

  expect(renderToc).not.toHaveBeenCalled()
  dispose()
  app.remove()
})

test('heading replacement and repeated requests coalesce to one ToC refresh', async () => {
  const app = document.createElement('div')
  app.innerHTML =
    '<div class="vditor-reset"><p data-block="0">alpha</p><h2 data-block="0">Heading</h2></div>'
  document.body.appendChild(app)
  const dispose = installEditActivity(app)
  const renderToc = vi.fn()
  const vditor = {}

  app.querySelector('h2')!.outerHTML = '<h2 data-block="0">Heading x</h2>'
  installedRenderTocHook()(vditor, renderToc)
  app.querySelector('h2')!.outerHTML = '<h3 data-block="0">Heading xy</h3>'
  installedRenderTocHook()(vditor, renderToc)
  await deliverMutationRecords()
  vi.advanceTimersByTime(300)

  expect(renderToc).toHaveBeenCalledTimes(1)
  expect(renderToc).toHaveBeenCalledWith(vditor)
  dispose()
  app.remove()
})

test('top-level insertion before a heading schedules one ToC refresh', async () => {
  const app = document.createElement('div')
  app.innerHTML =
    '<div class="vditor-reset"><p data-block="0">alpha</p><h2 data-block="0">Heading</h2></div>'
  document.body.appendChild(app)
  const dispose = installEditActivity(app)
  const renderToc = vi.fn()
  const vditor = {}
  const root = app.querySelector<HTMLElement>('.vditor-reset')!

  root
    .querySelector('h2')!
    .insertAdjacentHTML('beforebegin', '<p data-block="0">inserted</p>')
  installedRenderTocHook()(vditor, renderToc)
  await deliverMutationRecords()
  vi.advanceTimersByTime(300)

  dispose()
  app.remove()
  expect(renderToc).toHaveBeenCalledTimes(1)
})

test('heading structure schedules no ToC work without an outline or embedded ToC consumer', async () => {
  const app = document.createElement('div')
  app.innerHTML =
    '<div class="vditor-reset"><p data-block="0">alpha</p><h2 data-block="0">Heading</h2></div>'
  document.body.appendChild(app)
  const root = app.querySelector<HTMLElement>('.vditor-reset')!
  const dispose = installEditActivity(app)
  const renderToc = vi.fn()
  const vditor = {
    currentMode: 'ir',
    options: { outline: { enable: false } },
    ir: { element: root },
  }

  root.querySelector('h2')!.outerHTML = '<h2 data-block="0">Heading x</h2>'
  installedRenderTocHook()(vditor, renderToc)
  await deliverMutationRecords()
  vi.advanceTimersByTime(300)

  expect(renderToc).not.toHaveBeenCalled()
  dispose()
  app.remove()
})

test('failed ToC refresh stays invalid and retries on the next request', async () => {
  const app = document.createElement('div')
  app.innerHTML =
    '<div class="vditor-reset"><h2 data-block="0">Heading</h2></div>'
  document.body.appendChild(app)
  const dispose = installEditActivity(app)
  const renderToc = vi
    .fn<(vditor: unknown) => void>()
    .mockImplementationOnce(() => {
      throw new Error('render failed')
    })
  const vditor = {}
  const postMessage = vi.fn()
  ;(globalThis as { vscode?: unknown }).vscode = { postMessage }

  app.querySelector('h2')!.outerHTML = '<h2 data-block="0">Heading x</h2>'
  installedRenderTocHook()(vditor, renderToc)
  await deliverMutationRecords()
  vi.advanceTimersByTime(300)
  expect(renderToc).toHaveBeenCalledTimes(1)
  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      command: 'log',
      text: expect.stringContaining('[toc-invalidation: renderToc]'),
    }),
  )

  installedRenderTocHook()(vditor, renderToc)
  vi.advanceTimersByTime(300)
  expect(renderToc).toHaveBeenCalledTimes(2)

  dispose()
  app.remove()
})

test('ToC invalidation matrix distinguishes nested structure from heading ownership', () => {
  const block = (html: string): HTMLElement => {
    const template = document.createElement('template')
    template.innerHTML = html
    return template.content.firstElementChild as HTMLElement
  }
  const impact = (
    changed: HTMLElement,
    overrides: Partial<EditorMutationImpact> = {},
  ): EditorMutationImpact => ({
    full: false,
    blocks: new Set([changed]),
    structural: false,
    modeRebuild: false,
    topLevelChanged: false,
    ...overrides,
  })

  expect(tocImpactRequiresRefresh(impact(block('<p>text</p>')))).toBe(false)
  expect(
    tocImpactRequiresRefresh(
      impact(block('<ul><li>text</li></ul>'), { structural: true }),
    ),
  ).toBe(false)
  expect(
    tocImpactRequiresRefresh(impact(block('<table><tbody></tbody></table>'))),
  ).toBe(false)
  expect(tocImpactRequiresRefresh(impact(block('<h2>Heading</h2>')))).toBe(true)
  expect(
    tocImpactRequiresRefresh(
      impact(block('<div data-type="toc-block"></div>')),
    ),
  ).toBe(true)
  expect(
    tocImpactRequiresRefresh(
      impact(block('<p>text</p>'), { topLevelChanged: true }),
    ),
  ).toBe(true)
  expect(
    tocImpactRequiresRefresh(
      impact(block('<p>text</p>'), { full: true, modeRebuild: true }),
    ),
  ).toBe(true)
})

test('heading invalidation waits for compositionend before arming settle', async () => {
  const app = document.createElement('div')
  app.innerHTML =
    '<div class="vditor-reset"><h2 data-block="0">Heading</h2></div>'
  document.body.appendChild(app)
  const dispose = installEditActivity(app)
  const renderToc = vi.fn()

  document.dispatchEvent(new CompositionEvent('compositionstart'))
  app.querySelector('h2')!.outerHTML = '<h2 data-block="0">見出し</h2>'
  installedRenderTocHook()({}, renderToc)
  await deliverMutationRecords()
  vi.advanceTimersByTime(300)
  expect(renderToc).not.toHaveBeenCalled()

  document.dispatchEvent(new CompositionEvent('compositionend'))
  vi.advanceTimersByTime(300)
  expect(renderToc).toHaveBeenCalledTimes(1)

  dispose()
  app.remove()
})

test('a direct Vditor ToC render commits mode mutations without a duplicate settle refresh', async () => {
  const app = document.createElement('div')
  app.innerHTML =
    '<div class="vditor-reset"><p data-block="0">alpha</p><h2 data-block="0">Heading</h2></div>'
  document.body.appendChild(app)
  const dispose = installEditActivity(app)
  const renderToc = vi.fn()
  const vditor = {}
  installedRenderTocHook()(vditor, renderToc)

  app.innerHTML =
    '<div class="vditor-reset"><p data-block="0">alpha</p><h2 data-block="0">Heading</h2></div>'
  const didRender = (window as unknown as Record<string, unknown>)
    .__vmdeTocDidRender
  expect(typeof didRender).toBe('function')
  ;(didRender as (vditor: unknown) => void)(vditor)
  await deliverMutationRecords()
  vi.advanceTimersByTime(300)

  expect(renderToc).not.toHaveBeenCalled()
  dispose()
  app.remove()
})

test('render-owned embedded ToC writes after commit do not schedule a second refresh', async () => {
  const app = document.createElement('div')
  app.innerHTML =
    '<div class="vditor-reset"><h2 data-block="0">Heading</h2>' +
    '<div data-block="0" data-type="toc-block"></div></div>'
  document.body.appendChild(app)
  const dispose = installEditActivity(app)
  const vditor = {}
  const didRender = (window as unknown as Record<string, unknown>)
    .__vmdeTocDidRender as (vditor: unknown) => void
  const renderToc = vi.fn(() => {
    didRender(vditor)
    queueMicrotask(() => {
      app.querySelector<HTMLElement>('[data-type="toc-block"]')!.innerHTML =
        '<div class="vditor-toc">rendered</div>'
    })
  })

  app.querySelector('h2')!.outerHTML = '<h2 data-block="0">Heading x</h2>'
  installedRenderTocHook()(vditor, renderToc)
  await deliverMutationRecords()
  vi.advanceTimersByTime(300)
  await deliverMutationRecords()
  vi.advanceTimersByTime(300)

  expect(renderToc).toHaveBeenCalledTimes(1)
  dispose()
  app.remove()
})

test('post-refresh heading caret mutations cannot refresh the same request revision twice', async () => {
  const app = document.createElement('div')
  app.innerHTML =
    '<div class="vditor-reset"><h2 data-block="0">Heading</h2></div>'
  document.body.appendChild(app)
  const dispose = installEditActivity(app)
  const vditor = {}
  const didRender = (window as unknown as Record<string, unknown>)
    .__vmdeTocDidRender as (vditor: unknown) => void
  const renderToc = vi.fn(() => {
    didRender(vditor)
    queueMicrotask(() => {
      const text = app.querySelector('h2')!.firstChild as Text
      text.replaceData(0, text.length, text.data)
    })
  })

  app.querySelector('h2')!.outerHTML = '<h2 data-block="0">Heading x</h2>'
  installedRenderTocHook()(vditor, renderToc)
  await deliverMutationRecords()
  vi.advanceTimersByTime(300)
  await deliverMutationRecords()
  vi.advanceTimersByTime(300)

  dispose()
  app.remove()
  expect(renderToc).toHaveBeenCalledTimes(1)
})

test('beginSettleRender / scheduleReveal are no-ops when there is no IR editor', () => {
  expect(() => beginSettleRender()).not.toThrow()
  expect(() => scheduleReveal()).not.toThrow()
})

// Regression: a flowchart shrank after an edit (svg 179→79px wide) because flowchart.js measures its
// text and re-rendered into the STILL-display:none deferred child (getBBox ~0 → collapsed boxes).
// flowchart must therefore render in COVER mode (visible+sized under the opaque overlay) like the
// canvas engines — NOT stay in the display:none "deferred" state. A non-measuring SVG engine
// (graphviz computes layout without the DOM box) must STAY deferred (cheaper, renders fine hidden).
test('beginSettleRender switches a deferred flowchart to cover mode, leaves graphviz deferred', () => {
  const ir = document.createElement('div')
  ir.className = 'vditor-ir'
  const block = (lang: string) =>
    '<div class="vditor-ir__node" data-type="code-block">' +
    `<pre class="vditor-ir__marker--pre"><code class="language-${lang}">src</code></pre>` +
    // both previews start in the display:none "deferred" state (mid-typing overlay shown)
    '<div class="vditor-ir__preview vmde-deferred" data-render="2"></div>' +
    '</div>'
  ir.innerHTML = block('flowchart') + block('graphviz')
  document.body.appendChild(ir)

  beginSettleRender()

  const previews = ir.querySelectorAll('.vditor-ir__preview')
  const flowchart = previews[0]
  const graphviz = previews[1]
  // flowchart measures text → must become visible+sized (cover) so the new render isn't shrunken
  expect(flowchart.classList.contains('vmde-cover')).toBe(true)
  expect(flowchart.classList.contains('vmde-deferred')).toBe(false)
  // graphviz doesn't measure the DOM box → stays in the cheap display:none deferred state
  expect(graphviz.classList.contains('vmde-cover')).toBe(false)
  expect(graphviz.classList.contains('vmde-deferred')).toBe(true)

  ir.remove()
})

test('hasFreshRender: a rendered svg outside the overlay counts as fresh', () => {
  const p = document.createElement('div')
  p.innerHTML = '<div class="language-mermaid"><svg></svg></div>'
  expect(hasFreshRender(p)).toBe(true)
})

test('hasFreshRender: a parse-error box is a terminal render → fresh (no 3s reveal wait)', () => {
  const mermaid = document.createElement('div')
  mermaid.innerHTML =
    '<div class="language-mermaid"><div class="vmde-mermaid-error"><pre>err</pre></div></div>'
  expect(hasFreshRender(mermaid)).toBe(true)
  // forward-compat with task 178's generalised class
  const generalised = document.createElement('div')
  generalised.innerHTML = '<div class="vmde-diagram-error"><pre>err</pre></div>'
  expect(hasFreshRender(generalised)).toBe(true)
})

test('hasFreshRender: a stale overlay alone is NOT fresh (cached svg / cached error box inside it)', () => {
  const cachedSvg = document.createElement('div')
  cachedSvg.innerHTML =
    '<div class="vmde-stale-overlay" data-render="1"><svg></svg></div>'
  expect(hasFreshRender(cachedSvg)).toBe(false)

  const cachedError = document.createElement('div')
  cachedError.innerHTML =
    '<div class="vmde-stale-overlay" data-render="1"><div class="vmde-mermaid-error"></div></div>'
  expect(hasFreshRender(cachedError)).toBe(false)
})

// Task 178 item 4: the error box must NOT strobe while typing — a half-typed diagram is "invalid" on
// every keystroke. The box is produced by the engine, which runs inside processCodeRender; this proves
// the deferIrDiagramRender gate SKIPS processCodeRender for a cached diagram lang while isTyping() (so
// the engine — and any error box — can't run mid-keystroke) and runs it exactly once on settle.
function buildIrWithGraphviz(): HTMLElement {
  const ir = document.createElement('div')
  ir.className = 'vditor-ir'
  // a graphviz code-block dual-node: editable source + an already-rendered preview (data-render="2")
  ir.innerHTML =
    '<div class="vditor-ir__node" data-type="code-block">' +
    '<pre class="vditor-ir__marker--pre"><code class="language-graphviz">digraph{a-&gt;b}</code></pre>' +
    '<div class="vditor-ir__preview" data-render="2"><div class="language-graphviz"><svg></svg></div></div>' +
    '</div>'
  document.body.appendChild(ir)
  return ir
}

test('deferIrDiagramRender: a cached diagram lang is NOT rendered while typing (no error-box flash), rendered once on settle', () => {
  const ir = buildIrWithGraphviz()
  const dispose = installEditActivity(ir)
  const defer = (window as unknown as Record<string, unknown>)
    .__vmdeDeferIrDiagramRender as (v: unknown, p: unknown) => void
  const vditor = { ir: { element: ir } }
  const rendered: Element[] = []
  const processCodeRender = (el: Element) => rendered.push(el)

  // mid-typing burst → isTyping() true
  markEditActivity()
  expect(isTyping()).toBe(true)
  defer(vditor, processCodeRender)
  // graphviz is a cached/deferred lang → processCodeRender is skipped → the engine never runs, so an
  // error box cannot be produced this keystroke (the cached overlay holds instead).
  expect(rendered.length).toBe(0)

  // user pauses → the quiet timer fires → the deferred render runs once (now the box could appear)
  vi.advanceTimersByTime(300)
  expect(rendered.length).toBeGreaterThan(0)

  dispose()
  ir.remove()
})

test('deferIrDiagramRender: when NOT typing, a diagram renders immediately (gate only defers mid-burst)', () => {
  const ir = buildIrWithGraphviz()
  const dispose = installEditActivity(ir)
  const defer = (window as unknown as Record<string, unknown>)
    .__vmdeDeferIrDiagramRender as (v: unknown, p: unknown) => void
  const rendered: Element[] = []
  const processCodeRender = (el: Element) => rendered.push(el)

  // no markEditActivity() → isTyping() false → the render is NOT deferred
  expect(isTyping()).toBe(false)
  defer({ ir: { element: ir } }, processCodeRender)
  expect(rendered.length).toBeGreaterThan(0)

  dispose()
  ir.remove()
})

// Task 601 — an Undo/Redo before the prose settle runs that editor's deferred re-spin at once,
// through the real input path, exactly once; other settle work keeps its own timer.
test('flushPendingEditorRespin runs only the owning editor’s pending re-spin, once', () => {
  const app = document.createElement('div')
  const element = document.createElement('div')
  element.innerHTML = '<p data-block="0">Alpha delta.</p>'
  app.append(element)
  document.body.append(app)
  const dispose = installEditActivity(app)
  try {
    const input = vi.fn()
    const vditor = { ir: { element }, options: { input } }
    const replays: { data: string | null; trusted: boolean }[] = []
    let replaySkipped: boolean | undefined
    const trySkip = (window as any).__vmdeTrySkipFenceSpin
    element.addEventListener('input', (event) => {
      const inputEvent = event as InputEvent
      replays.push({ data: inputEvent.data, trusted: inputEvent.isTrusted })
      // The replay re-enters the real input path, which must take the real spin this time.
      replaySkipped = trySkip(vditor, range, inputEvent)
    })
    const text = element.querySelector('p')!.firstChild as Text
    const range = document.createRange()
    range.setStart(text, text.length)
    range.collapse(true)
    const typed = new InputEvent('input', {
      inputType: 'insertText',
      data: 'W',
    })
    expect(trySkip(vditor, range, typed)).toBe(true)
    expect(input).toHaveBeenCalledTimes(1)
    let diagrams = 0
    deferUntilSettle('ir-native-diagrams', () => diagrams++)

    expect(flushPendingEditorRespin({ other: true })).toBe(false)
    expect(replays).toEqual([])
    expect(flushPendingEditorRespin(vditor)).toBe(true)
    expect(replays).toEqual([{ data: '', trusted: false }])
    expect(replaySkipped).toBe(false)
    expect(diagrams).toBe(0)
    expect(flushPendingEditorRespin(vditor)).toBe(false)

    vi.advanceTimersByTime(300)
    expect(replays).toHaveLength(1)
    expect(diagrams).toBe(1)
  } finally {
    dispose()
    app.remove()
  }
})
