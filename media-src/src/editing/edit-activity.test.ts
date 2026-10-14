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
import {
  hasLiveCaretIntent,
  installCaretInvalidation,
  resetCaretAuthorityForTests,
  setCaretPaintabilityProbeForTests,
} from './caret'
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

// ---- Task 615 — the settle re-spin runs on the keystroke's block and keeps the live selection ----
//
// A fake Vditor `input()` stands in for ir/input.ts: it spins the block holding the LIVE selection's
// Range start (or the whole editor when that Range has no closest block, the Select All case), merges
// adjacent same-marker lists into one list, and re-creates every footnote block at the end. All three
// replace nodes with fresh ones, as the real spin does, and record what they saw.

interface SpinRecord {
  whole: boolean // the live Range had no closest block: the whole editor was re-spun
  text: string // textContent of the re-spun block (editor text when whole)
}

interface RespinFixture {
  root: HTMLElement
  vditor: {
    ir: { element: HTMLElement; composingLock: boolean }
    options: { input: ReturnType<typeof vi.fn> }
  }
  spins: SpinRecord[]
  stealFocus: { value: boolean }
  keystroke(node: Node, offset: number): void
  teardown(): void
}

const BLOCKS =
  '<p data-block="0">Alpha delta</p><p data-block="0">Bravo echo</p><p data-block="0">Charlie foxtrot</p>'

function respinBlockOf(node: Node): Element | null {
  const host = node instanceof Element ? node : node.parentElement
  return host?.closest('[data-block="0"]') ?? null
}

const freshNode = (node: Node): Node => node.cloneNode(true)

const isListElement = (element: Element | null): boolean =>
  element?.tagName === 'UL' || element?.tagName === 'OL'

// Adjacent lists of the same marker become one list; others are only re-created.
function respinList(block: Element): void {
  const sameList = (other: Element | null): boolean =>
    other?.tagName === block.tagName &&
    other?.getAttribute('data-marker') === block.getAttribute('data-marker')
  const group = [block]
  while (sameList(group[0].previousElementSibling))
    group.unshift(group[0].previousElementSibling as Element)
  while (sameList(group[group.length - 1].nextElementSibling))
    group.push(group[group.length - 1].nextElementSibling as Element)
  if (group.length > 1) {
    const merged = freshNode(block) as Element
    merged.replaceChildren(
      ...group.flatMap((list) => Array.from(list.children, freshNode)),
    )
    block.replaceWith(merged)
    for (const list of group) if (list !== block) list.remove()
    return
  }
  for (const list of [
    block.previousElementSibling,
    block,
    block.nextElementSibling,
  ])
    if (list && isListElement(list)) list.replaceWith(freshNode(list))
}

function fakeSpin(root: HTMLElement, spins: SpinRecord[]): void {
  const selection = window.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  const block = range ? respinBlockOf(range.startContainer) : null
  if (!block || block.getAttribute('data-type') === 'link-ref-defs-block') {
    spins.push({ whole: true, text: root.textContent ?? '' })
    root.replaceChildren(...Array.from(root.children, freshNode))
    return
  }
  spins.push({ whole: false, text: block.textContent ?? '' })
  if (isListElement(block)) respinList(block)
  else block.replaceWith(freshNode(block))
  for (const note of Array.from(
    root.querySelectorAll('[data-type="footnotes-block"]'),
  )) {
    if (note.textContent !== block.textContent) {
      note.remove()
      root.append(freshNode(note))
    }
  }
}

function mountRespinEditor(html: string): RespinFixture {
  const app = document.createElement('div')
  const root = document.createElement('div')
  root.className = 'vditor-reset'
  root.tabIndex = 0
  root.innerHTML = html
  app.append(root)
  document.body.append(app)
  const dispose = installEditActivity(app)
  const disposeGestures = installCaretInvalidation()
  setCaretPaintabilityProbeForTests(() => true)
  const spins: SpinRecord[] = []
  const stealFocus = { value: false }
  const vditor = {
    ir: { element: root, composingLock: false },
    options: { input: vi.fn() },
  }
  ;(window as unknown as { vditor: unknown }).vditor = {
    vditor: { currentMode: 'ir', ir: { element: root } },
  }
  root.addEventListener('input', () => {
    fakeSpin(root, spins)
    // Chromium moves focus into the editable when a selection is written there (measured); jsdom
    // resets the selection on focus, so the move comes after the spin has read the live Range.
    if (stealFocus.value) root.focus()
  })
  const trySkip = (window as unknown as Record<string, unknown>)
    .__vmdeTrySkipFenceSpin as (
    v: unknown,
    range: Range,
    event: InputEvent,
  ) => boolean
  return {
    root,
    vditor,
    spins,
    stealFocus,
    keystroke(node, offset) {
      const range = document.createRange()
      range.setStart(node, offset)
      range.collapse(true)
      expect(
        trySkip(
          vditor,
          range,
          new InputEvent('input', { inputType: 'insertText', data: 'x' }),
        ),
      ).toBe(true)
    },
    teardown() {
      disposeGestures()
      resetCaretAuthorityForTests()
      dispose()
      delete (window as unknown as { vditor?: unknown }).vditor
      window.getSelection()?.removeAllRanges()
      app.remove()
    },
  }
}

const textOf = (root: HTMLElement, index: number): Text =>
  root.children[index].firstChild as Text

function select(
  anchor: Node,
  anchorOffset: number,
  focus: Node,
  focusOffset: number,
): void {
  window
    .getSelection()
    ?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset)
}

function liveEnds() {
  const selection = window.getSelection()!
  return {
    anchor: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focus: selection.focusNode,
    focusOffset: selection.focusOffset,
  }
}

let respin: RespinFixture
afterEach(() => respin?.teardown())

// Contract 3 and 4 (whole-document Range): Select All inside the window is kept, and the spin runs on
// the keystroke's block (not the whole editor).
test('Task 615 contract 4: a Select All made inside the settle window survives, and only the keystroke block is re-spun', () => {
  respin = mountRespinEditor(BLOCKS)
  const { root } = respin
  respin.keystroke(textOf(root, 0), 11)
  select(root, 0, root, 3)
  vi.advanceTimersByTime(100)
  expect(respin.spins).toEqual([])
  vi.advanceTimersByTime(200)
  expect(respin.spins).toEqual([{ whole: false, text: 'Alpha delta' }])
  expect(liveEnds()).toEqual({
    anchor: root,
    anchorOffset: 0,
    focus: root,
    focusOffset: 3,
  })
})

// Contract 4 (Shift+arrows, both directions): the endpoint in the keystroke block follows its block
// address into the new text node, the other keeps its node, and the direction is kept.
test.each([
  ['forward (Shift+Right/Down)', true],
  ['backward (Shift+Left/Up)', false],
])(
  'Task 615 contract 4: a %s extension from the keystroke block keeps both ends and the direction',
  (_label, forward) => {
    respin = mountRespinEditor(BLOCKS)
    const { root } = respin
    const bravo = textOf(root, 1)
    respin.keystroke(textOf(root, 0), 11)
    if (forward) select(textOf(root, 0), 2, bravo, 4)
    else select(bravo, 4, textOf(root, 0), 2)
    vi.advanceTimersByTime(300)
    expect(respin.spins).toEqual([{ whole: false, text: 'Alpha delta' }])
    const alpha = textOf(root, 0)
    expect(alpha.data).toBe('Alpha delta')
    const ends = liveEnds()
    if (forward)
      expect(ends).toEqual({
        anchor: alpha,
        anchorOffset: 2,
        focus: bravo,
        focusOffset: 4,
      })
    else
      expect(ends).toEqual({
        anchor: bravo,
        anchorOffset: 4,
        focus: alpha,
        focusOffset: 2,
      })
  },
)

// Contract 4: a selection wholly in other blocks (Shift+arrows made elsewhere) is not touched.
test('Task 615 contract 4: a selection in other blocks is restored and the keystroke block is still re-spun', () => {
  respin = mountRespinEditor(BLOCKS)
  const { root } = respin
  const bravo = textOf(root, 1)
  const charlie = textOf(root, 2)
  respin.keystroke(textOf(root, 0), 11)
  select(charlie, 5, bravo, 1)
  vi.advanceTimersByTime(300)
  expect(respin.spins).toEqual([{ whole: false, text: 'Alpha delta' }])
  expect(liveEnds()).toEqual({
    anchor: charlie,
    anchorOffset: 5,
    focus: bravo,
    focusOffset: 1,
  })
})

// Contract 4 (pointer drag): a drag that starts and ends inside the window is a plain selection by the
// settle; the pointer is released, so the re-spin runs once and restores it.
test('Task 615 contract 4: a selection made by a pointer drag inside the settle window is restored', () => {
  respin = mountRespinEditor(BLOCKS)
  const { root } = respin
  const bravo = textOf(root, 1)
  const charlie = textOf(root, 2)
  respin.keystroke(textOf(root, 0), 11)
  document.dispatchEvent(
    new MouseEvent('pointerdown', { button: 0, bubbles: true }),
  )
  vi.advanceTimersByTime(50)
  select(bravo, 2, charlie, 7)
  document.dispatchEvent(
    new MouseEvent('pointerup', { button: 0, bubbles: true }),
  )
  vi.advanceTimersByTime(300)
  expect(respin.spins).toEqual([{ whole: false, text: 'Alpha delta' }])
  expect(liveEnds()).toEqual({
    anchor: bravo,
    anchorOffset: 2,
    focus: charlie,
    focusOffset: 7,
  })
})

// Contract 3 and Task 180/175: a collapsed caret in the keystroke's own block (prose or fenced body)
// dispatches as before: no selection write at all.
test.each([
  ['prose', BLOCKS, (root: HTMLElement) => textOf(root, 0)],
  [
    'fenced body (Task 175)',
    '<div data-block="0" data-type="code-block"><pre class="vditor-ir__marker--pre"><code>const a = 1</code></pre></div><p data-block="0">Bravo</p>',
    (root: HTMLElement) => root.querySelector('code')!.firstChild as Text,
  ],
])(
  'Task 615 contract 3: a collapsed caret in the keystroke block (%s) takes the unchanged fast path',
  (_label, html, pick) => {
    respin = mountRespinEditor(html)
    const { root } = respin
    const text = pick(root)
    respin.keystroke(text, 3)
    select(text, 3, text, 3)
    const writes = [
      vi.spyOn(Selection.prototype, 'collapse'),
      vi.spyOn(Selection.prototype, 'setBaseAndExtent'),
      vi.spyOn(Selection.prototype, 'addRange'),
      vi.spyOn(Selection.prototype, 'removeAllRanges'),
    ]
    vi.advanceTimersByTime(300)
    expect(respin.spins).toHaveLength(1)
    expect(respin.spins[0].whole).toBe(false)
    for (const write of writes) expect(write).not.toHaveBeenCalled()
    expect(hasLiveCaretIntent()).toBe(false)
  },
)

// Contract 2: the keystroke's node is gone by the settle (a real spin or a document rebuild reconciled
// it), so there is nothing to re-spin and the live selection is not used as a substitute.
test('Task 615 contract 2: a disconnected target skips the re-spin', () => {
  respin = mountRespinEditor(BLOCKS)
  const { root } = respin
  respin.keystroke(textOf(root, 0), 11)
  root.children[0].replaceWith(root.children[0].cloneNode(true))
  select(root, 0, root, 3)
  vi.advanceTimersByTime(300)
  expect(respin.spins).toEqual([])
  expect(liveEnds()).toEqual({
    anchor: root,
    anchorOffset: 0,
    focus: root,
    focusOffset: 3,
  })
})

// Contract 2 refinement (measured: the Chromium rewrap harness, a fenced body): the browser can replace
// the keystroke's text node itself while its block stays. The keystroke still needs its settle re-spin
// (Task 175), on the block: a collapsed caret there dispatches as before, a wider selection is kept.
test('Task 615 contract 2: a replaced text node in a live block still re-spins that block', () => {
  respin = mountRespinEditor(BLOCKS)
  const { root } = respin
  const bravo = textOf(root, 1)
  respin.keystroke(textOf(root, 0), 11)
  const replaced = document.createTextNode('Alpha deltax')
  root.children[0].firstChild!.replaceWith(replaced)
  select(replaced, 12, replaced, 12)
  const writes = [
    vi.spyOn(Selection.prototype, 'collapse'),
    vi.spyOn(Selection.prototype, 'setBaseAndExtent'),
  ]
  vi.advanceTimersByTime(300)
  expect(respin.spins).toEqual([{ whole: false, text: 'Alpha deltax' }])
  for (const write of writes) expect(write).not.toHaveBeenCalled()

  respin.spins.length = 0
  respin.keystroke(textOf(root, 0), 12)
  root.children[0].firstChild!.replaceWith(
    document.createTextNode('Alpha deltaxy'),
  )
  select(bravo, 1, root, 3)
  vi.advanceTimersByTime(300)
  expect(respin.spins).toEqual([{ whole: false, text: 'Alpha deltaxy' }])
  expect(liveEnds()).toEqual({
    anchor: bravo,
    anchorOffset: 1,
    focus: root,
    focusOffset: 3,
  })
})

// Contract 5: a held primary pointer re-defers the re-spin until release; the flush still forces it.
test('Task 615 contract 5: a held primary pointer re-defers the re-spin until release', () => {
  respin = mountRespinEditor(BLOCKS)
  const { root } = respin
  const bravo = textOf(root, 1)
  respin.keystroke(textOf(root, 0), 11)
  document.dispatchEvent(
    new MouseEvent('pointerdown', { button: 0, bubbles: true }),
  )
  select(bravo, 1, bravo, 6)
  vi.advanceTimersByTime(1000)
  expect(respin.spins).toEqual([])
  document.dispatchEvent(
    new MouseEvent('pointerup', { button: 0, bubbles: true }),
  )
  vi.advanceTimersByTime(300)
  expect(respin.spins).toEqual([{ whole: false, text: 'Alpha delta' }])
  expect(liveEnds()).toEqual({
    anchor: bravo,
    anchorOffset: 1,
    focus: bravo,
    focusOffset: 6,
  })
})

test('Task 615 contract 5: flushPendingEditorRespin forces the re-spin while a pointer is held, once', () => {
  respin = mountRespinEditor(BLOCKS)
  const { root } = respin
  respin.keystroke(textOf(root, 0), 11)
  document.dispatchEvent(
    new MouseEvent('pointerdown', { button: 0, bubbles: true }),
  )
  select(root, 0, root, 3)
  expect(flushPendingEditorRespin(respin.vditor)).toBe(true)
  expect(respin.spins).toEqual([{ whole: false, text: 'Alpha delta' }])
  expect(flushPendingEditorRespin(respin.vditor)).toBe(false)
  vi.advanceTimersByTime(1000)
  expect(respin.spins).toHaveLength(1)
})

// Contract 6: focus in a control outside the editor (Find, a toolbar input) is put back after the
// re-spin; writing the target caret moved it into the editor (the fixture models that).
test('Task 615 contract 6: focus outside the editor is restored with preventScroll', () => {
  respin = mountRespinEditor(BLOCKS)
  const { root } = respin
  const field = document.createElement('input')
  document.body.append(field)
  try {
    field.focus()
    window.getSelection()?.collapse(document.body, 0)
    respin.stealFocus.value = true
    const focus = vi.spyOn(field, 'focus')
    respin.keystroke(textOf(root, 0), 11)
    vi.advanceTimersByTime(300)
    expect(respin.spins).toEqual([{ whole: false, text: 'Alpha delta' }])
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(document.activeElement).toBe(field)
  } finally {
    field.remove()
  }
})

// Edge case: typing in block A then block B inside one window re-spins only B (today's latest-wins),
// and the settle dispatches once: one history snapshot, as before.
test('Task 615 edge: typing in two blocks inside one window re-spins only the last one, once', () => {
  respin = mountRespinEditor(BLOCKS)
  const { root } = respin
  respin.keystroke(textOf(root, 0), 11)
  vi.advanceTimersByTime(100)
  respin.keystroke(textOf(root, 1), 10)
  select(root, 0, root, 3)
  vi.advanceTimersByTime(300)
  expect(respin.spins).toEqual([{ whole: false, text: 'Bravo echo' }])
  expect(respin.vditor.options.input).toHaveBeenCalledTimes(2)
  expect(liveEnds()).toEqual({
    anchor: root,
    anchorOffset: 0,
    focus: root,
    focusOffset: 3,
  })
})

// Edge case: the target text node is still connected but shorter than the keystroke offset.
test('Task 615 edge: a target offset past a shortened text node is clamped', () => {
  respin = mountRespinEditor(BLOCKS)
  const { root } = respin
  const alpha = textOf(root, 0)
  respin.keystroke(alpha, 11)
  alpha.data = 'Al'
  select(root, 0, root, 3)
  vi.advanceTimersByTime(300)
  expect(respin.spins).toEqual([{ whole: false, text: 'Al' }])
  expect(liveEnds()).toEqual({
    anchor: root,
    anchorOffset: 0,
    focus: root,
    focusOffset: 3,
  })
})

// Edge case: an IME composition at the settle keeps today's dispatch (no swap, nothing written).
test('Task 615 edge: an IME composition at the settle dispatches without moving the selection', () => {
  respin = mountRespinEditor(BLOCKS)
  const { root } = respin
  respin.keystroke(textOf(root, 0), 11)
  respin.vditor.ir.composingLock = true
  select(root, 0, root, 3)
  const writes = [
    vi.spyOn(Selection.prototype, 'collapse'),
    vi.spyOn(Selection.prototype, 'setBaseAndExtent'),
  ]
  vi.advanceTimersByTime(300)
  expect(respin.spins).toEqual([{ whole: true, text: root.textContent }])
  for (const write of writes) expect(write).not.toHaveBeenCalled()
})

// Contract 7 (list siblings): a top-level list is spun with its adjacent lists, which are re-created.
// Endpoints in those siblings follow their block address into the new nodes.
test('Task 615 contract 7: endpoints in re-rendered adjacent lists fall back to their block address', () => {
  respin = mountRespinEditor(
    '<p data-block="0">Intro</p><ul data-block="0" data-marker="-"><li>one a</li></ul><ul data-block="0" data-marker="*"><li>two b</li></ul><ul data-block="0" data-marker="+"><li>three c</li></ul><p data-block="0">Outro</p>',
  )
  const { root } = respin
  const first = root.children[1].firstChild!.firstChild as Text
  const third = root.children[3].firstChild!.firstChild as Text
  respin.keystroke(root.children[2].firstChild!.firstChild!, 5)
  select(first, 2, third, 3)
  vi.advanceTimersByTime(300)
  expect(respin.spins).toEqual([{ whole: false, text: 'two b' }])
  const ends = liveEnds()
  const newFirst = root.children[1].firstChild!.firstChild as Text
  const newThird = root.children[3].firstChild!.firstChild as Text
  expect(newFirst).not.toBe(first)
  expect(ends).toEqual({
    anchor: newFirst,
    anchorOffset: 2,
    focus: newThird,
    focusOffset: 3,
  })
})

// Contract 7 and the Task 613 shift: lists that merge into one change the root's child count, so a
// Select All end offset follows the new count instead of pointing past it.
test('Task 615 contract 7: a Select All end offset follows the child count when the spin merges lists', () => {
  respin = mountRespinEditor(
    '<p data-block="0">Intro</p><ul data-block="0" data-marker="-"><li>one a</li></ul><ul data-block="0" data-marker="-"><li>two b</li></ul><ul data-block="0" data-marker="-"><li>three c</li></ul><p data-block="0">Outro</p>',
  )
  const { root } = respin
  respin.keystroke(root.children[2].firstChild!.firstChild!, 5)
  select(root, 0, root, 5)
  vi.advanceTimersByTime(300)
  expect(root.children).toHaveLength(3)
  expect(liveEnds()).toEqual({
    anchor: root,
    anchorOffset: 0,
    focus: root,
    focusOffset: 3,
  })
})

// Contract 7 (footnote block): the spin re-creates the footnote block at the end; an endpoint in it
// follows its block address.
test('Task 615 contract 7: an endpoint in a re-created footnote block falls back to its block address', () => {
  respin = mountRespinEditor(
    `${BLOCKS}<div data-block="0" data-type="footnotes-block"><p>[^1]: note text</p></div>`,
  )
  const { root } = respin
  const bravo = textOf(root, 1)
  const note = root.children[3].firstChild!.firstChild as Text
  respin.keystroke(textOf(root, 0), 11)
  select(bravo, 2, note, 6)
  vi.advanceTimersByTime(300)
  const newNote = root.children[3].firstChild!.firstChild as Text
  expect(newNote).not.toBe(note)
  expect(liveEnds()).toEqual({
    anchor: bravo,
    anchorOffset: 2,
    focus: newNote,
    focusOffset: 6,
  })
})

// Contract 7 (link-reference block): a keystroke there re-spins the whole editor, so every endpoint
// falls back to its block address.
test('Task 615 contract 7: a keystroke in a link-reference block re-spins the editor and the selection follows block addresses', () => {
  respin = mountRespinEditor(
    `${BLOCKS}<div data-block="0" data-type="link-ref-defs-block"><p>[a]: https://example.test</p></div>`,
  )
  const { root } = respin
  const alpha = textOf(root, 0)
  const charlie = textOf(root, 2)
  respin.keystroke(root.children[3].firstChild!.firstChild!, 4)
  select(alpha, 3, charlie, 8)
  vi.advanceTimersByTime(300)
  expect(respin.spins).toHaveLength(1)
  expect(liveEnds()).toEqual({
    anchor: textOf(root, 0),
    anchorOffset: 3,
    focus: textOf(root, 2),
    focusOffset: 8,
  })
})
