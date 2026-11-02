// Task 643 — the VMDE full-Preview renderer. Full Preview renders the exact source text itself
// instead of letting Vditor's Preview.render read it back out of an edit view: one `Md2HTML` pass for
// a small document, chunk-by-chunk streaming for a large one, and heavy blocks (diagrams, math,
// code) rendered when they are on or near the screen. Split's preview pane keeps Vditor's own path.
//
// Vditor consumes this through the `__vmdeRenderFullPreview` hook that `patchPreviewFullRoute`
// (esbuild-shared.mjs) inserts at the top of `Preview.render`.
import { abcRender } from 'vditor/src/ts/markdown/abcRender'
import { chartRender } from 'vditor/src/ts/markdown/chartRender'
import { codeRender } from 'vditor/src/ts/markdown/codeRender'
import { flowchartRender } from 'vditor/src/ts/markdown/flowchartRender'
import { graphvizRender } from 'vditor/src/ts/markdown/graphvizRender'
import { highlightRender } from 'vditor/src/ts/markdown/highlightRender'
import { renderImageCaptions } from 'vditor/src/ts/markdown/imageCaptionRender'
import { markmapRender } from 'vditor/src/ts/markdown/markmapRender'
import { mathRender } from 'vditor/src/ts/markdown/mathRender'
import { mediaRender } from 'vditor/src/ts/markdown/mediaRender'
import { mermaidRender } from 'vditor/src/ts/markdown/mermaidRender'
import { mindmapRender } from 'vditor/src/ts/markdown/mindmapRender'
import { plantumlRender } from 'vditor/src/ts/markdown/plantumlRender'
import { SMILESRender } from 'vditor/src/ts/markdown/SMILESRender'
import { wavedromRender } from 'vditor/src/ts/markdown/wavedromRender'
import {
  PREVIEW_BLOCK_RELEASED_EVENT,
  PREVIEW_PENDING_ATTR,
} from '../diagram-kit/diagram-dom'
import { createViewportGate } from '../nav/viewport-gate'
import { markRawHeadingsForPreview } from '../nav/preview-raw-headings'
import {
  planPreviewChunks,
  shouldStreamPreview,
  type PreviewPlan,
} from '../util/preview-chunk'
import { pauseCoalescedObservers } from '../util/observe-coalesce'
import {
  recordAfterPaint,
  recordOpenMetrics,
  type OpenMetrics,
} from '../util/open-metrics'
import { reportError } from '../util/webview-log'
import { buildDefMap, externalDefsFor } from '../util/stream-chunk'
import { maskCommentsForPreview } from './html-comment'
import { morphPreviewInto, setPreviewMorphBaseline } from './preview-morph'
import { maskSvgDataImagesForPreview } from './svg-data-image-adapter'

export { PREVIEW_BLOCK_RELEASED_EVENT }

/** A heavy block this far (px) below or above the viewport is held back until it scrolls near. */
export const PREVIEW_RENDER_MARGIN_PX = 800

interface PreviewLute {
  Md2HTML(markdown: string): string
  SetSoftBreak2HardBreak(enabled: boolean): void
}

/** The parts of Vditor's inner instance the renderer reads. */
interface PreviewVditor {
  lute: PreviewLute
  currentMode: string
  options: {
    cdn: string
    theme: string
    customRenders?: Array<{ render(root: unknown, vditor: unknown): void }>
    preview: {
      hljs: any
      math: any
      delay?: number
      markdown: { imageCaption: boolean }
      render: { media: { enable: boolean } }
    }
  }
  preview: {
    element: HTMLElement
    previewElement: HTMLElement
    render(vditor: unknown, value?: string, immediate?: boolean): void
  }
  outline: { element?: HTMLElement; render(vditor: unknown): string }
  [mode: string]: any
}

interface PreviewWindow {
  __vmdeReflowPreview?: boolean
  __vmdePreviewSnapshot?: () => string
  __vmdeCapturePreviewSource?: (markdown: string) => number
  __vmdePreviewRendered?: (
    vditor: unknown,
    element: HTMLElement,
    renderId?: number,
  ) => void
  __vmdeFullPreviewOwnsOutline?: (vditor: unknown) => boolean
  __vmdeRenderFullPreview?: (
    vditor: unknown,
    value?: string,
    immediate?: boolean,
  ) => boolean
}
const win = (): PreviewWindow => window as unknown as PreviewWindow

/** Same order as the Vditor Preview patch chain (Tasks 83, 367, 660): comments are masked before
 *  raw headings are marked, so an escaped comment is never touched. Lives here, not in `util`,
 *  because `util` may not import `editing` or `nav`. */
export function maskPreviewSource(markdown: string): string {
  return maskSvgDataImagesForPreview(
    markRawHeadingsForPreview(maskCommentsForPreview(markdown)),
  )
}

// Task 83: the editor Lute keeps its fidelity-preserving soft-break default; only the synchronous
// Preview render flips it, then restores it.
function renderHtml(lute: PreviewLute, markdown: string): string {
  lute.SetSoftBreak2HardBreak(!win().__vmdeReflowPreview)
  try {
    return lute.Md2HTML(markdown)
  } finally {
    lute.SetSoftBreak2HardBreak(true)
  }
}

const REF_ID = /^footnotes-ref-(\d+)(?::\d+)?$/

// A chunk numbers footnotes locally and lists them in its own `.footnotes-defs-div`. Drop that list
// (the plan's trailing section replaces it) and renumber each reference to its global number, with
// the occurrence suffix Lute gives repeated references over the whole document.
function globalizeFootnotes(
  html: string,
  order: readonly string[],
  plan: PreviewPlan,
  seen: Map<string, number>,
): string {
  if (!html.includes('footnotes-')) return html
  const holder = document.createElement('div')
  holder.innerHTML = html
  for (const defs of holder.querySelectorAll('.footnotes-defs-div'))
    defs.remove()
  for (const sup of holder.querySelectorAll<HTMLElement>('sup.footnotes-ref')) {
    const local = Number(REF_ID.exec(sup.id)?.[1])
    const label = order[local - 1]
    const number = label ? plan.footnoteNumbers.get(label) : undefined
    if (number === undefined) continue
    const occurrence = (seen.get(label) ?? 0) + 1
    seen.set(label, occurrence)
    sup.id =
      occurrence === 1
        ? `footnotes-ref-${number}`
        : `footnotes-ref-${number}:${occurrence}`
    const link = sup.querySelector('a')
    if (link) {
      link.setAttribute('href', `#footnotes-def-${number}`)
      link.textContent = String(number)
    }
  }
  return holder.innerHTML
}

interface UnitRenderer {
  /** Chunk count, plus one when the document has a footnote list. */
  count: number
  /** HTML of unit `index`; call in order, footnote numbering depends on it. */
  render(index: number): string
}

// `whole` renders the document with a single Md2HTML call (a document under the streaming
// threshold); otherwise it is cut into chunks.
function createUnitRenderer(
  lute: PreviewLute,
  markdown: string,
  whole = false,
): UnitRenderer {
  const plan = whole
    ? planPreviewChunks(
        markdown,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      )
    : planPreviewChunks(markdown)
  const defMap = buildDefMap(markdown)
  const seen = new Map<string, number>()
  return {
    count: plan.chunks.length + (plan.footnoteSection ? 1 : 0),
    render(index) {
      const chunk = plan.chunks[index]
      if (!chunk) {
        const holder = document.createElement('div')
        holder.innerHTML = renderHtml(lute, plan.footnoteSection ?? '')
        return holder.querySelector('.footnotes-defs-div')?.outerHTML ?? ''
      }
      const { text } = externalDefsFor(chunk.source, defMap)
      const html = renderHtml(
        lute,
        text ? `${chunk.source}\n\n${text}` : chunk.source,
      )
      return globalizeFootnotes(html, chunk.footnoteOrder, plan, seen)
    },
  }
}

/** Render `markdown` (already masked by `maskPreviewSource`) chunk by chunk into HTML fragments,
 *  the footnote list last when the document has footnotes. Joined, the fragments equal one-pass
 *  `Md2HTML` of `markdown`. */
export function renderPreviewUnits(
  lute: PreviewLute,
  markdown: string,
): string[] {
  const units = createUnitRenderer(lute, markdown)
  return Array.from({ length: units.count }, (_, index) => units.render(index))
}

/** A query root for one block: `querySelectorAll` also returns the block itself when it matches.
 *  Every Vditor renderer reads its root only through `querySelectorAll`, and a top-level block such
 *  as `div.language-mermaid` is itself the element they look for. */
function queryRootOf(blocks: readonly Element[]): HTMLElement {
  return {
    querySelectorAll(selector: string) {
      const found: Element[] = []
      for (const block of blocks) {
        if (block.matches(selector)) found.push(block)
        found.push(...Array.from(block.querySelectorAll(selector)))
      }
      return found
    },
    // codeRender asks `element.classList.contains("vditor-preview")` to cap the code blocks it
    // decorates; Vditor's own Preview root (`.vditor-reset`) never carries that class, so false.
    classList: { contains: () => false },
  } as unknown as HTMLElement
}

export function blockQueryRoot(block: Element): HTMLElement {
  return queryRootOf([block])
}

// Blocks that need a renderer beyond Lute's HTML: fenced code, diagrams, math.
const HEAVY = 'pre > code, .language-math, [class*="language-"]'
const isHeavy = (element: Element): boolean =>
  element.matches(HEAVY) || element.querySelector(HEAVY) !== null

// The renderers Vditor's afterRender runs per block, in its order; custom renders and math follow.
function renderHeavyBlock(vditor: PreviewVditor, block: HTMLElement): void {
  const root = blockQueryRoot(block)
  const { cdn, theme, preview } = vditor.options
  highlightRender(preview.hljs, root, cdn)
  mermaidRender(root, cdn, theme)
  markmapRender(root, cdn)
  SMILESRender(root, cdn, theme)
  flowchartRender(root, cdn)
  graphvizRender(root, cdn)
  wavedromRender(root, cdn)
  chartRender(root, cdn, theme)
  mindmapRender(root, cdn, theme)
  plantumlRender(root, cdn)
  abcRender(root, cdn)
  for (const custom of vditor.options.customRenders ?? [])
    custom.render(root, vditor)
  mathRender(root, { cdn, math: preview.math })
}

// Cheap per-node passes: code copy buttons, image captions, media.
function renderCheapPasses(vditor: PreviewVditor, nodes: readonly Element[]) {
  if (nodes.length === 0) return
  const root = queryRootOf(nodes)
  const { preview } = vditor.options
  renderImageCaptions(root, 'preview', preview.markdown.imageCaption)
  codeRender(root, preview.hljs)
  if (preview.render.media.enable) mediaRender(root)
}

interface Run {
  generation: number
  gate: ReturnType<typeof createViewportGate>
}
const runs = new WeakMap<HTMLElement, Run>()
// While a failed stream asks Vditor to render the whole text itself, the route must step aside.
let bypassRoute = false

function beginRun(pane: HTMLElement): Run {
  const previous = runs.get(pane)
  previous?.gate.dispose()
  const run = {
    generation: (previous?.generation ?? 0) + 1,
    gate: createViewportGate(PREVIEW_RENDER_MARGIN_PX),
  }
  runs.set(pane, run)
  return run
}

// Gate the heavy blocks among `nodes`: those near the screen render now, the rest wait.
function gateHeavyBlocks(
  vditor: PreviewVditor,
  run: Run,
  nodes: readonly Element[],
): void {
  const heavy = nodes.filter(
    (node): node is HTMLElement => node instanceof HTMLElement && isHeavy(node),
  )
  if (heavy.length === 0) return
  const release = (block: HTMLElement) => {
    const wasPending = block.hasAttribute(PREVIEW_PENDING_ATTR)
    block.removeAttribute(PREVIEW_PENDING_ATTR)
    renderHeavyBlock(vditor, block)
    if (wasPending)
      document.dispatchEvent(
        new CustomEvent(PREVIEW_BLOCK_RELEASED_EVENT, {
          detail: { block },
        }),
      )
  }
  // Mark first so a sweep that runs on the insertion mutation already sees them as pending.
  for (const block of heavy) block.setAttribute(PREVIEW_PENDING_ATTR, 'true')
  const visible = run.gate.partition(heavy, (block) => {
    if (runs.get(vditor.preview.previewElement) === run) release(block)
  })
  for (const block of visible) release(block)
}

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now()
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()))

const recordMetrics = (fields: OpenMetrics): void => recordOpenMetrics(fields)

// Whole-document work once every unit is in: ToC blocks, the outline, and the reuse commit.
function finish(
  vditor: PreviewVditor,
  pane: HTMLElement,
  renderId: number | undefined,
): void {
  // The outline is a whole-document Lute pass (hundreds of ms for a heading-heavy document), so it is
  // rendered now only when something shows it: an open outline panel, or an embedded [ToC] block.
  // Opening the panel later renders it (Vditor's own toggle does).
  const tocBlocks = pane.querySelectorAll<HTMLElement>(
    '[data-type="toc-block"]',
  )
  const outlineShown =
    !vditor.outline.element || vditor.outline.element.style.display === 'block'
  if (tocBlocks.length > 0 || outlineShown) {
    let toc = vditor.outline.render(vditor)
    if (toc === '') toc = '[ToC]'
    for (const item of tocBlocks) {
      item.innerHTML = toc
      mathRender(item, {
        cdn: vditor.options.cdn,
        math: vditor.options.preview.math,
      })
    }
  }
  win().__vmdePreviewRendered?.(vditor, pane, renderId)
}

// A mid-stream failure leaves a partial pane: let Vditor render the whole text once instead.
function fallbackToVditor(vditor: PreviewVditor): void {
  bypassRoute = true
  try {
    vditor.preview.render(vditor, undefined, true)
  } finally {
    bypassRoute = false
  }
}

export interface FullPreviewRun {
  done: Promise<void>
}

const EMPTY = /^[\s﻿\xA0]*$/

/** Render `markdown` (masked by the caller) into the Preview pane. Returns null, with the pane
 *  untouched, when the first render step fails so the caller can let Vditor render instead. */
export function renderFullPreview(
  vditor: PreviewVditor,
  markdown: string,
  renderId?: number,
): FullPreviewRun | null {
  const pane = vditor.preview.previewElement
  const started = now()
  const run = beginRun(pane)

  if (EMPTY.test(markdown)) {
    pane.innerHTML = ''
    setPreviewMorphBaseline(pane, [])
    finish(vditor, pane, renderId)
    return { done: Promise.resolve() }
  }

  let units: UnitRenderer
  let firstHtml: string
  try {
    units = createUnitRenderer(
      vditor.lute,
      markdown,
      !shouldStreamPreview(markdown.length),
    )
    const planned = now()
    firstHtml = units.render(0)
    recordMetrics({
      renderStartMs: started,
      planMs: planned - started,
      firstUnitMs: now() - planned,
    })
  } catch (error) {
    reportError(error, 'full-preview-first-unit')
    return null
  }

  const streamed = shouldStreamPreview(markdown.length)
  // Content already on screen is kept until the new units are ready, then morphed in once.
  const replacing = streamed && pane.children.length > 0

  if (!streamed) {
    try {
      let html = firstHtml
      for (let index = 1; index < units.count; index++)
        html += units.render(index)
      morphAndProcess(vditor, pane, run, html)
      recordMetrics({
        previewChunks: units.count,
        previewMaxChunkMs: now() - started,
      })
      recordAfterPaint('contentVisibleMs')
      finish(vditor, pane, renderId)
      recordAfterPaint('completeMs')
      return { done: Promise.resolve() }
    } catch (error) {
      reportError(error, 'full-preview-one-pass')
      return null
    }
  }

  const done = streamUnits({
    vditor,
    pane,
    run,
    units,
    firstHtml,
    started,
    renderId,
    replacing,
  }).catch((error: unknown) => {
    reportError(error, 'full-preview-stream')
    if (runs.get(pane) === run) fallbackToVditor(vditor)
  })
  return { done }
}

interface StreamJob {
  vditor: PreviewVditor
  pane: HTMLElement
  run: Run
  units: UnitRenderer
  firstHtml: string
  started: number
  renderId: number | undefined
  /** The pane already shows content: keep it until every unit is ready, then morph once. */
  replacing: boolean
}

// The morph goes through the window hook Vditor's own Preview path uses (installPreviewMorph sets it
// to morphPreviewInto), so both paths share one seam; unit tests without the hook morph directly.
function morphInto(pane: HTMLElement, html: string): void {
  const hook = (
    window as unknown as {
      __vmdeMorphPreview?: (el: HTMLElement, html: string) => void
    }
  ).__vmdeMorphPreview
  if (hook) hook(pane, html)
  else morphPreviewInto(pane, html)
}

// Morph freshly rendered HTML into the pane and run the per-node passes on what is new.
function morphAndProcess(
  vditor: PreviewVditor,
  pane: HTMLElement,
  run: Run,
  html: string,
): void {
  const before = new Set(Array.from(pane.children))
  morphInto(pane, html)
  const children = Array.from(pane.children)
  const added = children.filter((child) => !before.has(child))
  renderCheapPasses(vditor, added)
  // A block the morph kept and that was still held back belongs to this run's gate now: the previous
  // run's gate was disposed, and nothing else would ever release it.
  gateHeavyBlocks(
    vditor,
    run,
    children.filter(
      (child) => !before.has(child) || child.hasAttribute(PREVIEW_PENDING_ATTR),
    ),
  )
}

async function streamUnits(job: StreamJob): Promise<void> {
  // The decorating observers rescan the whole pane per batch; hold them until the stream ends (see
  // pauseCoalescedObservers) so a large document is not quadratic. Released on every exit path.
  const resumeObservers = pauseCoalescedObservers()
  try {
    await streamUnitsPaused(job)
  } finally {
    resumeObservers()
  }
}

async function streamUnitsPaused(job: StreamJob): Promise<void> {
  const { vditor, pane, run, units, firstHtml, replacing } = job
  const raws: string[] = []
  const htmlParts: string[] = []
  let maxChunkMs = 0
  let lastYield = job.started
  // Append one unit to the live pane. Raw strings are taken before the passes change the nodes:
  // the morph diffs raw-vs-raw.
  const appendUnit = (html: string): void => {
    const holder = document.createElement('div')
    holder.innerHTML = html
    const added = Array.from(holder.children)
    for (const child of added) raws.push(child.outerHTML)
    pane.append(...Array.from(holder.childNodes))
    renderCheapPasses(vditor, added)
    gateHeavyBlocks(vditor, run, added)
  }
  if (!replacing) pane.innerHTML = ''
  for (let index = 0; index < units.count; index++) {
    const chunkStarted = now()
    const html = index === 0 ? firstHtml : units.render(index)
    if (replacing) htmlParts.push(html)
    else appendUnit(html)
    if (index === 0 && !replacing) recordAfterPaint('contentVisibleMs')
    maxChunkMs = Math.max(maxChunkMs, now() - chunkStarted)
    if (index < units.count - 1 && now() - lastYield > 12) {
      await nextFrame()
      lastYield = now()
      if (runs.get(pane) !== run) return
    }
  }
  if (runs.get(pane) !== run) return
  completeStream(job, raws, htmlParts, maxChunkMs)
}

// Everything that waits for the last unit: the single morph of a replacement, the morph baseline of
// a fresh stream, the metrics and the whole-document work.
function completeStream(
  job: StreamJob,
  raws: string[],
  htmlParts: string[],
  maxChunkMs: number,
): void {
  const { vditor, pane, run, units } = job
  if (job.replacing) {
    morphAndProcess(vditor, pane, run, htmlParts.join(''))
    recordAfterPaint('contentVisibleMs')
  } else {
    setPreviewMorphBaseline(pane, raws)
  }
  recordMetrics({ previewChunks: units.count, previewMaxChunkMs: maxChunkMs })
  finish(vditor, pane, job.renderId)
  recordAfterPaint('completeMs')
}

// Full Preview hides the active edit pane; Split keeps its source pane visible beside the preview.
function showsFullPreview(vditor: PreviewVditor): boolean {
  if (vditor.currentMode === 'sv')
    return vditor.sv?.element?.style.display === 'none'
  return (
    vditor[vditor.currentMode]?.element?.parentElement?.style.display === 'none'
  )
}

// Turning Preview off ends the current run: a stream would otherwise keep rendering into the hidden
// pane, and the observers it holds back (pauseCoalescedObservers) would stay paused for the edit
// modes. A new run supersedes it and is never started.
function watchPreviewHidden(
  owner: PreviewVditor,
  onHide: () => void,
): MutationObserver | undefined {
  const element = owner.preview?.element
  if (typeof MutationObserver === 'undefined' || !(element instanceof Node))
    return undefined
  const watcher = new MutationObserver(() => {
    if (element.style.display === 'none') onHide()
  })
  watcher.observe(element, { attributes: true, attributeFilter: ['style'] })
  return watcher
}

/** Install `window.__vmdeRenderFullPreview` for `owner` (Vditor's inner instance). Returns a
 *  disposer. The hook returns true when it rendered, false to let Vditor's own render run. */
export function installFullPreviewRoute(owner: PreviewVditor): () => void {
  let debounce: ReturnType<typeof setTimeout> | undefined
  // false means Vditor's own render must run (this one could not).
  const renderNow = (): boolean => {
    const source = win().__vmdePreviewSnapshot?.()
    if (typeof source !== 'string') return false
    const renderId = win().__vmdeCapturePreviewSource?.(source)
    return (
      renderFullPreview(owner, maskPreviewSource(source), renderId) !== null
    )
  }
  // An immediate render (the toolbar click, a host refresh) starts in a zero-delay task, as the
  // pre-Task-643 route did: the click task ends first, so the shell paints before the whole-document
  // passes run (Task 691). A non-immediate render (a config or theme change re-rendering the visible
  // Preview) keeps Vditor's debounce so a burst renders once, newest wins. Preview off, a newer
  // render or dispose clears the pending start; a render that cannot run falls back to Vditor.
  const hook = (
    vditor: unknown,
    value?: string,
    immediate?: boolean,
  ): boolean => {
    if (bypassRoute || value || vditor !== owner) return false
    if (!showsFullPreview(owner)) return false
    if (typeof win().__vmdePreviewSnapshot !== 'function') return false
    clearTimeout(debounce)
    debounce = setTimeout(
      () => {
        debounce = undefined
        if (showsFullPreview(owner) && !renderNow()) fallbackToVditor(owner)
      },
      immediate ? 0 : (owner.options.preview.delay ?? 0),
    )
    return true
  }
  win().__vmdeRenderFullPreview = hook
  const hideWatcher = watchPreviewHidden(owner, () => {
    clearTimeout(debounce)
    beginRun(owner.preview.previewElement)
  })
  // Consumed by the patched Preview toolbar handler (patchPreviewToolbarEntry): while full Preview is
  // up, this renderer owns the outline, so Vditor's delayed outline render is skipped.
  const ownsOutline = (vditor: unknown) =>
    vditor === owner && showsFullPreview(owner)
  win().__vmdeFullPreviewOwnsOutline = ownsOutline
  return () => {
    clearTimeout(debounce)
    hideWatcher?.disconnect()
    if (win().__vmdeRenderFullPreview === hook)
      delete win().__vmdeRenderFullPreview
    if (win().__vmdeFullPreviewOwnsOutline === ownsOutline)
      delete win().__vmdeFullPreviewOwnsOutline
  }
}
