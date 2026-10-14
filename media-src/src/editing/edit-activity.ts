// Task 161 step 1 — debounce diagram re-render while the user is typing (+ swap-when-ready, step 3).
//
// Editing a diagram's source in an IR code block re-spins the whole IR DOM on every keystroke
// (SpinVditorIRDOM): the rendered SVG is destroyed and Vditor re-runs the engine via processCodeRender
// (ir/input.ts) — mermaid ~670 ms PER keystroke, d2 a WASM compile, graphviz viz.js, etc. (baseline:
// test/vscode-e2e/d2-edit-perf.spec.ts). That freezes the main thread while you type. This gate defers
// the heavy re-render until the user pauses (~QUIET_MS) and coalesces the burst into ONE render.
//
// Vditor does NOT hide the preview while a block is expanded (the diagram stays visible BELOW the
// source you're editing — confirmed in _ir.less), so a naive defer would flicker the diagram. We keep
// the LAST render on screen via a cached, Lute-invisible overlay (data-render="1" → skipped by both AST
// walkers) and only SWAP it out once the new render is actually ready (swap-when-ready): the old image
// stays put while the engine re-renders into the (still-hidden) source child, then we reveal atomically
// — no flash to raw source ("przeskok przez białe tło z napisami").
//   - Most SVG engines render fine into a display:none child (they don't measure the DOM box).
//   - MEASURING engines (canvas echarts/mindmap/stl measure the CONTAINER; flowchart.js measures its
//     TEXT via getBBox, which is ~0 when hidden → shrunken boxes) render into a VISIBLE child kept
//     under an opaque absolute overlay (".vmde-cover"), revealed when the new render lands.
//
// Two render paths consult this gate:
//   - Vditor-native engines: the processCodeRender loop in ir/input.ts is routed through
//     window.__vmdeDeferIrDiagramRender (esbuild patchIrDeferDiagramRender) — defined here.
//   - our observeCustomDiagrams (d2/wavedrom/nomnoml/geojson/topojson/vega/stl): it calls isTyping()
//     and defers its pass; on settle it calls beginSettleRender()/scheduleReveal() like the native path.

import { engineLangSet } from '../diagram-kit/engine-registry'
import { isCompositionActive } from '../util/caret-gesture'
import { isPrimaryPointerHeld, requestCaret } from './caret'
import { shouldSkipFenceSpin, shouldSkipProseSpin } from './spin-skip-fence'
import { stripPreviewForSpin } from './spin-strip'
import { installTocInvalidation } from './toc-invalidation'

// The quiet window stays 220 ms. A shorter "appear sooner" window was tried and REVERTED: it is < the
// typical inter-keystroke gap (~180 ms), so the settle fires MID-BURST and repeatedly destroys+re-renders
// a slow MAIN-THREAD engine (mermaid ~284 ms) that never catches up → the diagram blinks/resizes while
// you type. 220 ms is deliberately LONGER than a typing cadence so it fires once, after you pause.
// Shortening it is only safe once typing re-renders are cheap or off-thread — not yet the case.
const QUIET_MS = 220
const REVEAL_TIMEOUT_MS = 3000 // force-reveal if a render never produces an svg/canvas (e.g. an error)

let timer = 0
const settleCbs = new Map<string, () => void>()

function fire(): void {
  timer = 0
  const cbs = Array.from(settleCbs.values())
  settleCbs.clear()
  for (const cb of cbs) {
    try {
      cb()
    } catch {
      /* a failed settle render must not wedge the gate */
    }
  }
}

/** True while the user is mid-burst (a keystroke landed within the last QUIET_MS). */
export function isTyping(): boolean {
  return timer !== 0
}

/** (Re)arm the quiet-timer — called on every editor input (capture phase). */
export function markEditActivity(): void {
  // On the FIRST keystroke of a burst (timer still idle), snapshot the diagrams' CURRENT renders — this
  // runs in the input CAPTURE phase, BEFORE Vditor's spin destroys them, so the overlay has a fresh
  // last-good image. Doing it only once per burst (not on every DOM mutation) is what keeps it cheap:
  // an earlier MutationObserver-driven snapshot rasterised every canvas via toDataURL ~20×/s while the
  // diagrams idle-animated, blocking the main thread (~25%) and stuttering scroll after an edit.
  if (!timer) snapshotRenders()
  if (timer) clearTimeout(timer)
  timer = window.setTimeout(fire, QUIET_MS)
}

/** Run cb once the user pauses; latest wins per key, so N keystrokes coalesce into one render. */
export function deferUntilSettle(key: string, cb: () => void): void {
  settleCbs.set(key, cb)
  if (!timer) timer = window.setTimeout(fire, QUIET_MS)
}

// Task 175 — defer the per-keystroke Lute spin + DOM rebuild while typing inside a fenced diagram/code
// BODY (see spin-skip-fence.ts for the why + the escape-hatch predicate). On an inert keystroke we
// early-return from input() (skipping the spin, the `outerHTML` rebuild, AND the task-161 overlay
// re-layout) — measured 0 ms typing-phase blocking across d2/mermaid/graphviz/echarts/flowchart/stl
// (tasks/175). The char is already in the live source text node, so getMarkdown stays byte-correct; ONE
// real spin+render runs on the 220 ms settle to reconcile structure + re-render the diagram. ALWAYS ON
// (no user setting): `window.__vmdeFastDiagramEdit` is unset in production, so `!== false` is ON; the
// global stays as a test-only seam (the task-175 spike toggles it). Consumed by the esbuild
// patchIrFenceSpinSkip at the top of ir/input.ts.
let fenceRespinning = false // the settle re-dispatch must run the REAL spin, not skip again
// Task 601: the editor whose re-spin is pending, so a history transition runs only its own.
let respinOwner: unknown
// Task 615: set while flushPendingEditorRespin forces the re-spin, which then ignores a held pointer.
let flushingRespin = false
const RESPIN_KEY = 'fence-respin'

// ---- Task 615 — the settle re-spin runs on the keystroke's block and keeps the live selection ----
//
// The settle re-spin re-enters Vditor's IR `input()` through a synthetic `input` event. That function
// reads the LIVE selection (`getSelection().getRangeAt(0)`), not the keystroke's: a whole-document
// Range (Select All made inside the 220 ms window) has no closest block, so Vditor re-spins the whole
// editor, puts its `wbr` at the Range start and `setRangeByWbr` collapses the selection to the document
// start (measured in real VS Code, Task 613 follow-up 1). A selection in another block re-spun the wrong
// block. So the re-spin (1) records where the skipped keystroke was, (2) at settle puts a collapsed
// caret there for the dispatch, and (3) restores the user's live selection afterwards through the caret
// authority (its first write is Task 613's `setBaseAndExtent` resync). A collapsed caret in the
// keystroke's own block (the usual typing case) is left alone and dispatches exactly as before.

/** Where the skipped keystroke landed: the Range start of that input, and its spin block. The block
 * is the fallback when the browser replaced the text node itself (measured for a fenced body in the
 * Chromium rewrap harness), where the keystroke still needs its settle re-spin. */
interface RespinTarget {
  node: Node
  offset: number
  block: Element | null
}

/** A position inside the editor where the dispatch can put its collapsed caret, or null when the
 * keystroke's node and block are both gone (a real spin or a document rebuild reconciled them). */
function liveTargetPosition(
  root: HTMLElement,
  target: RespinTarget,
): { node: Node; offset: number } | null {
  if (root.contains(target.node))
    return {
      node: target.node,
      offset: clampOffset(target.node, target.offset),
    }
  return target.block && root.contains(target.block)
    ? { node: target.block, offset: 0 }
    : null
}

type CaretRequest = Parameters<typeof requestCaret>[0]
type SelectionRequest = Extract<CaretRequest, { focus: unknown }>
type EndpointRequest = SelectionRequest['anchor']

/** The top-level block indices Vditor's `input()` replaces for this keystroke, and the root's size
 * before the spin, so an endpoint address can follow the replacement. */
interface SpinRegion {
  start: number
  end: number
  elements: number // root.children.length before the spin
  nodes: number // root.childNodes.length before the spin
}

/** A live selection endpoint with a node reference (kept while the spin leaves the node alone) and a
 * block address (when it replaces the node). */
interface LiveEndpoint {
  node: Node
  offset: number
  inRoot: boolean
  block: {
    blockPath: number[]
    offsetInBlock: number
    affinity?: 'backward'
  } | null
}

interface KeptSelection {
  region: SpinRegion
  // null while focus sits outside the editor: the document selection then belongs to that control.
  ends: { anchor: LiveEndpoint; focus: LiveEndpoint } | null
  refocus: HTMLElement | null
}

// The same closest-block rule as Vditor's hasClosestBlock (`data-block="0"`): the spin region.
function spinBlockOf(node: Node): Element | null {
  const host = node instanceof Element ? node : node.parentElement
  return host?.closest('[data-block="0"]') ?? null
}

function topLevelChild(root: Element, node: Node): Element | null {
  let walk: Node | null = node
  while (walk && walk.parentNode !== root) walk = walk.parentNode
  return walk instanceof Element ? walk : null
}

const isList = (element: Element | null): boolean =>
  element?.tagName === 'UL' || element?.tagName === 'OL'

// Mirrors ir/input.ts: a top-level list also takes its adjacent lists into the spin, and a
// link-reference block re-spins the whole editor.
function spinRegionOf(root: HTMLElement, top: Element): SpinRegion {
  const children = Array.from(root.children)
  const index = children.indexOf(top)
  let start = index
  let end = index
  if (top.getAttribute('data-type') === 'link-ref-defs-block') {
    start = 0
    end = children.length - 1
  } else if (isList(top)) {
    if (isList(top.previousElementSibling)) start -= 1
    if (isList(top.nextElementSibling)) end += 1
  }
  return {
    start,
    end,
    elements: children.length,
    nodes: root.childNodes.length,
  }
}

const maxOffset = (node: Node): number =>
  node instanceof CharacterData ? node.length : node.childNodes.length

const clampOffset = (node: Node, offset: number): number =>
  Math.max(0, Math.min(offset, maxOffset(node)))

// Same capture as the undo snapshot's vmdeCaretBlockOffset (esbuild patchUndoCaretSplitRestore): the
// path of child indices to the nearest editable block plus the characters before the endpoint in it.
const BLOCK_SELECTOR =
  'p, h1, h2, h3, h4, h5, h6, li, blockquote, tr, pre, [data-block]'
function blockAddressOf(
  root: HTMLElement,
  node: Node,
  offset: number,
): LiveEndpoint['block'] {
  const host = node instanceof Element ? node : node.parentElement
  const block = host?.closest(BLOCK_SELECTOR)
  if (!block || block === root || !root.contains(block)) return null
  const blockPath: number[] = []
  for (let walk: Element | null = block; walk && walk !== root; ) {
    const parent: Element | null = walk.parentElement
    if (!parent) return null
    blockPath.unshift(Array.prototype.indexOf.call(parent.children, walk))
    walk = parent
  }
  const before = document.createRange()
  before.selectNodeContents(block)
  before.setEnd(node, offset)
  const marker = host?.closest('.vditor-ir__marker')
  return {
    blockPath,
    offsetInBlock: before.toString().length,
    ...(marker && !marker.classList.contains('vditor-ir__marker--pre')
      ? { affinity: 'backward' as const }
      : {}),
  }
}

function captureEndpoint(
  root: HTMLElement,
  node: Node,
  offset: number,
): LiveEndpoint {
  const inRoot = root.contains(node)
  return {
    node,
    offset,
    inRoot,
    block: inRoot && node !== root ? blockAddressOf(root, node, offset) : null,
  }
}

const clampBetween = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(value, Math.max(low, high)))

// Top-level child index after the spin: blocks before the region keep their index, blocks after it
// shift by the child-count delta, a block inside it stays within the replacement.
function mapBlockIndex(index: number, region: SpinRegion, root: HTMLElement) {
  const delta = root.children.length - region.elements
  if (index < region.start) return index
  if (index > region.end) return index + delta
  return clampBetween(index, region.start, region.end + delta)
}

// The same mapping for a boundary offset on the root (Select All's `(root, 0)` to `(root, N)`).
function mapRootOffset(offset: number, region: SpinRegion, root: HTMLElement) {
  const delta = root.childNodes.length - region.nodes
  if (offset <= region.start) return offset
  if (offset > region.end) return Math.max(0, offset + delta)
  return clampBetween(offset, region.start, region.end + 1 + delta)
}

// After the spin: the endpoint's own node when it survived, else its block address, else null.
function resolveEndpoint(
  root: HTMLElement,
  endpoint: LiveEndpoint,
  region: SpinRegion,
): EndpointRequest | null {
  if (endpoint.node === root)
    return { node: root, offset: mapRootOffset(endpoint.offset, region, root) }
  if (root.contains(endpoint.node))
    return {
      node: endpoint.node,
      offset: clampOffset(endpoint.node, endpoint.offset),
    }
  const block = endpoint.block
  if (!block) return null
  const [first, ...rest] = block.blockPath
  return {
    blockPath: [mapBlockIndex(first, region, root), ...rest],
    offsetInBlock: block.offsetInBlock,
    ...(block.affinity ? { affinity: block.affinity } : {}),
  }
}

function composing(vditor: { ir: { composingLock?: boolean } }): boolean {
  return vditor.ir.composingLock === true || isCompositionActive()
}

// What to keep across the re-spin, or null when the re-spin should dispatch exactly as it always
// did: a collapsed caret in the keystroke's own block (Task 180's typing case), no selection at all,
// or an IME composition at settle.
function captureLiveSelection(
  vditor: { ir: { element: HTMLElement; composingLock?: boolean } },
  target: RespinTarget,
): KeptSelection | null {
  const root = vditor.ir.element
  const selection = window.getSelection()
  if (!selection || composing(vditor)) return null
  if (
    selection.rangeCount > 0 &&
    selection.isCollapsed &&
    selection.anchorNode &&
    target.block &&
    spinBlockOf(selection.anchorNode) === target.block
  )
    return null
  const top = topLevelChild(root, target.block ?? target.node)
  if (!top) return null
  const region = spinRegionOf(root, top)
  // Focus in a control outside the editor (Find, a toolbar input): writing a selection into the
  // editable moves focus there (measured in Chromium), so focus is put back after the re-spin. The
  // control owns the document selection, so there is no editor selection to restore.
  const active = document.activeElement
  if (
    active instanceof HTMLElement &&
    active !== document.body &&
    !root.contains(active)
  )
    return { region, ends: null, refocus: active }
  if (
    selection.rangeCount === 0 ||
    !selection.anchorNode ||
    !selection.focusNode
  )
    return null
  return {
    region,
    refocus: null,
    ends: {
      anchor: captureEndpoint(
        root,
        selection.anchorNode,
        selection.anchorOffset,
      ),
      focus: captureEndpoint(root, selection.focusNode, selection.focusOffset),
    },
  }
}

function restoreLiveSelection(root: HTMLElement, kept: KeptSelection): void {
  try {
    const ends = kept.ends
    if (!ends) return
    if (ends.anchor.inRoot && ends.focus.inRoot) {
      const anchor = resolveEndpoint(root, ends.anchor, kept.region)
      const focus = resolveEndpoint(root, ends.focus, kept.region)
      if (anchor && focus) requestCaret({ anchor, focus })
      return
    }
    // An endpoint outside the editor is not the caret authority's to resolve: write it back as it was.
    window
      .getSelection()
      ?.setBaseAndExtent(
        ends.anchor.node,
        ends.anchor.offset,
        ends.focus.node,
        ends.focus.offset,
      )
  } catch {
    /* a stale endpoint leaves the caret at the re-spun block, as before this task */
  } finally {
    const outside = kept.refocus
    if (outside?.isConnected && document.activeElement !== outside)
      outside.focus({ preventScroll: true })
  }
}

function dispatchRespin(root: HTMLElement): void {
  try {
    root.dispatchEvent(
      new InputEvent('input', {
        inputType: 'insertText',
        data: '',
        bubbles: true,
      }),
    )
  } catch {
    /* settle re-render is best-effort */
  }
}

function placeCaretAtTarget(position: { node: Node; offset: number }): boolean {
  try {
    window.getSelection()?.collapse(position.node, position.offset)
    return true
  } catch {
    return false
  }
}

function settleRespin(
  vditor: { ir: { element: HTMLElement; composingLock?: boolean } },
  target: RespinTarget,
  again: () => void,
): void {
  // A native drag owns the selection until release: no DOM rebuild under it. The flush forces.
  if (isPrimaryPointerHeld() && !flushingRespin) {
    deferUntilSettle(RESPIN_KEY, again)
    return
  }
  const root = vditor.ir.element
  // The keystroke's node and block are gone: a real spin or a document rebuild already reconciled it.
  const position = liveTargetPosition(root, target)
  if (!position) return
  fenceRespinning = true
  try {
    const kept = captureLiveSelection(vditor, target)
    if (!kept || !placeCaretAtTarget(position)) {
      dispatchRespin(root)
      return
    }
    dispatchRespin(root)
    restoreLiveSelection(root, kept)
  } finally {
    fenceRespinning = false
  }
}

function trySkipFenceSpin(
  vditor: {
    ir: { element: HTMLElement; composingLock?: boolean }
    options?: { input?: (text?: string) => void }
  },
  range: Range,
  event?: InputEvent,
): boolean {
  if (fenceRespinning) return false
  const w = window as unknown as Record<string, unknown>
  const fence =
    w.__vmdeFastDiagramEdit !== false && shouldSkipFenceSpin(range, event)
  // Task 180 — prose-side skip, ALWAYS ON (no setting; __vmdeFastProseEdit is a test-only seam). Same settle re-spin.
  const prose =
    w.__vmdeFastProseEdit !== false && shouldSkipProseSpin(range, event)
  if (!fence && !prose) return false
  // the char is already natively in the source text node → nudge the (debounced) host serialize…
  try {
    vditor.options?.input?.()
  } catch {
    /* serialize is best-effort here */
  }
  // …and re-spin+render ONCE on the pause by re-running the real input path (the guard makes that
  // re-entry take the normal spin, not skip again). Latest keystroke wins the key and the target.
  respinOwner = vditor
  const target: RespinTarget = {
    node: range.startContainer,
    offset: range.startOffset,
    block: spinBlockOf(range.startContainer),
  }
  const run = (): void => settleRespin(vditor, target, run)
  deferUntilSettle(RESPIN_KEY, run)
  return true
}

/** Task 601 — run `inner`'s pending re-spin now instead of at the settle, once. An Undo/Redo before
 * the settle would otherwise find the edit with no checkpoint callback armed: the skipped keystroke
 * reaches Vditor's input path (and its checkpoint timer) only through this re-spin. Other settle
 * work (diagram renders, ToC) keeps its own timing. Returns whether a re-spin ran. */
export function flushPendingEditorRespin(inner: unknown): boolean {
  const respin = settleCbs.get(RESPIN_KEY)
  if (!respin || respinOwner !== inner) return false
  settleCbs.delete(RESPIN_KEY)
  flushingRespin = true // Task 615: the flush forces the re-spin even while a pointer is held
  try {
    respin()
  } finally {
    flushingRespin = false
  }
  return true
}

// Heavy Vditor-native engines whose per-keystroke render is the measured stutter — skipped while
// typing (185/2a: derived from the engine registry — native diagrams; math is a formula, not one).
const NATIVE_DEFER = engineLangSet((e) => e.family === 'native' && e.diagram)
// Every diagram language whose rendered output we keep visible (overlay) during a burst — native +
// the custom-observer family (rendered by observeCustomDiagrams).
const CACHED = engineLangSet((e) => e.diagram)
// Engines that MEASURE during render, so they CAN'T render into a display:none child — they render
// VISIBLE under an opaque cover overlay instead. Two flavours, same fix:
//   - canvas/WebGL (echarts/mindmap/stl/geojson/topojson) measure their CONTAINER (0×0 when hidden);
//   - flowchart.js measures TEXT (getComputedTextLength/getBBox on its <text> nodes), which returns
//     ~0 in a display:none subtree → the boxes collapse and the whole diagram shrinks (svg 179→79px
//     wide after an edit — user: "flowcharts po edycji ma małe diagramy"). It rendered correctly at
//     OPEN (preview visible) and only shrank when re-rendered while deferred.
// (The remaining SVG engines — graphviz/plantuml/abc/d2/etc. — compute layout without touching the DOM
// box, so they render fine while hidden and stay in the cheap display:none deferred state.)
const MEASURE_LANGS = engineLangSet((e) => e.measuresHidden)

const STALE_CLASS = 'vmde-deferred' // typing / svg-settle: source children display:none, overlay static
const COVER_CLASS = 'vmde-cover' // canvas-settle: source visible+sized, overlay absolute opaque on top
const OVERLAY_CLASS = 'vmde-stale-overlay'

// Last rendered VISUAL snapshot (svg outerHTML, or an <img> of a canvas) + its on-screen HEIGHT,
// keyed `${lang}#${ordinal}` (ordinal = position among IR code-block nodes of that language; stable
// during a typing burst). The height is reserved on the overlay (restoreOverlay) so the deferred
// preview never collapses below the real render: some engines' cached svg re-lays-out SHORTER inside
// the overlay (abc has no viewBox → it scaled to ~79px while the live render was 124px), which shrank
// the preview mid-typing → content below jumped up, then back down on swap (user-reported for abc).
const renderCache = new Map<string, { html: string; h: number }>()

function irRoot(): HTMLElement | null {
  return document.querySelector('.vditor-ir')
}

// The language always lives on the editable SOURCE code (`.vditor-ir__marker--pre code.language-X`),
// which persists whether the preview is raw or rendered — unlike the preview's firstElementChild,
// which becomes the <svg> once rendered.
function nodeLang(node: Element): string {
  const code = node.querySelector('.vditor-ir__marker--pre code')
  const m =
    code && /(?:^|\s)language-([\w-]+)/.exec((code as HTMLElement).className)
  return m ? m[1] : ''
}

// Per-lang ordinal (document order) of EVERY code-block node, computed in a SINGLE walk so the batch
// callers (deferIrDiagramRender's overlay loop, snapshotRenders) don't re-walk per node — the old
// per-node `ordinalOf` was O(n²) in code-block count and ran on the typing-burst critical path on
// diagram-heavy docs (task 171 item 3). Same semantics as before: count nodes of the SAME lang before
// each one. Keys the renderCache (`${lang}#${ord}`), so the per-lang counter must stay consistent.
function ordinalMap(root: HTMLElement): Map<Element, number> {
  const counts = new Map<string, number>()
  const out = new Map<Element, number>()
  for (const n of Array.from(
    root.querySelectorAll('.vditor-ir__node[data-type="code-block"]'),
  )) {
    const lang = nodeLang(n)
    const i = counts.get(lang) ?? 0
    out.set(n, i)
    counts.set(lang, i + 1)
  }
  return out
}

function previewOf(node: Element): HTMLElement | null {
  return node.querySelector('.vditor-ir__preview')
}

// The diagram render lives INSIDE the `.language-X` wrapper. Scope to that — other svgs in the preview
// are Vditor UI (the copy-code button is `<svg><use #vditor-icon-copy>`), which must NOT be treated as
// the render (snapshotting it showed a "copy" icon instead of the diagram).
const RENDER_SEL = '[class*="language-"] svg, [class*="language-"] canvas'

// A render is "present" once the diagram wrapper holds an svg/canvas OUTSIDE our overlay (i.e. the
// engine finished re-rendering into the source child) — OR a parse-error box landed (a terminal
// render with NO svg/canvas). Without the error-box case the reveal waits the full REVEAL_TIMEOUT_MS
// (3s) before swapping the stale overlay out, so an error panel appears ~3s late (mermaid error box;
// generalised .vmde-diagram-error in task 178). Exported for the unit test.
export function hasFreshRender(preview: Element): boolean {
  for (const el of Array.from(preview.querySelectorAll(RENDER_SEL))) {
    if (!el.closest(`.${OVERLAY_CLASS}`)) return true
  }
  const err = preview.querySelector('.vmde-mermaid-error, .vmde-diagram-error')
  return !!(err && !err.closest(`.${OVERLAY_CLASS}`))
}

// A clean, language-class-free snapshot of the current render (+ its on-screen height) so the overlay
// never re-matches an engine's element selector. Canvas can't be cloned (its bitmap is lost) →
// rasterise via toDataURL. The height is what the overlay reserves so the preview can't shrink below it.
function visualSnapshot(preview: Element): { html: string; h: number } | null {
  for (const el of Array.from(preview.querySelectorAll(RENDER_SEL))) {
    if (el.closest(`.${OVERLAY_CLASS}`)) continue
    // Reserve the height of the whole render REGION (the `.language-X` wrapper), not just the svg —
    // abc's wrapper is taller than its svg (73px svg in a 124px region), so pinning the svg height
    // still let the preview shrink. The wrapper is what occupies the preview vertically.
    const region = (el.closest('[class*="language-"]') ?? el) as HTMLElement
    const h = Math.round(region.getBoundingClientRect().height)
    if (el instanceof HTMLCanvasElement) {
      try {
        return {
          html: `<img class="vmde-stale-img" alt="" src="${el.toDataURL()}">`,
          h,
        }
      } catch {
        return null // tainted canvas — fall through (no overlay; brief flash, rare)
      }
    }
    return { html: (el as SVGElement).outerHTML, h }
  }
  return null
}

// Show the cached last-good render in a deferred preview. Called SYNCHRONOUSLY from the patched
// processCodeRender loop (before paint) → no flicker to raw source. The overlay is appended AFTER the
// source <code> (which stays firstElementChild, so processCodeRender's language switch still works) and
// carries data-render="1" so Lute never serialises it.
function restoreOverlay(node: Element, lang: string, ord: number): void {
  const preview = previewOf(node)
  if (!preview) return
  preview.classList.remove(COVER_CLASS)
  if (preview.querySelector(`.${OVERLAY_CLASS}`)) {
    preview.classList.add(STALE_CLASS)
    return
  }
  const cached = ord >= 0 ? renderCache.get(`${lang}#${ord}`) : undefined
  if (!cached) return // nothing cached yet (first keystroke before any render) → raw shows briefly
  const overlay = document.createElement('div')
  overlay.className = OVERLAY_CLASS
  overlay.setAttribute('data-render', '1')
  // Bridge the engine's per-svg sizing (plantuml min-width / smiles max-width / abc+graphviz
  // max-height) to the overlay so the cached render is sized IDENTICALLY to the live one — else a
  // small plantuml shrinks under the overlay and jumps to 300px on swap. A data-attr, NOT a
  // `.language-X` class: observers key on the class and must not re-process the overlay. CSS in main.css.
  overlay.setAttribute('data-lang', lang)
  // Reserve the live render's height so the preview can't shrink below it while typing — some engines'
  // cached svg re-lays-out shorter inside the overlay (abc), which would bounce the content below.
  if (cached.h > 0) overlay.style.minHeight = `${cached.h}px`
  overlay.innerHTML = cached.html
  preview.classList.add(STALE_CLASS)
  preview.appendChild(overlay)
}

function revealPreview(preview: Element): void {
  for (const o of Array.from(preview.querySelectorAll(`.${OVERLAY_CLASS}`)))
    o.remove()
  preview.classList.remove(STALE_CLASS, COVER_CLASS)
}

// At settle, before the engines re-render: switch the MEASURING-engine previews from the display:none
// "deferred" state into the "cover" state (source child visible + sized so echarts/three can measure
// the container and flowchart.js can measure its text; the opaque overlay still hides it). The
// non-measuring SVG previews stay deferred (they render fine while hidden).
export function beginSettleRender(): void {
  const root = irRoot()
  if (!root) return
  for (const node of Array.from(
    root.querySelectorAll('.vditor-ir__node[data-type="code-block"]'),
  )) {
    const lang = nodeLang(node)
    if (!MEASURE_LANGS.has(lang)) continue
    const preview = previewOf(node)
    if (preview?.classList.contains(STALE_CLASS)) {
      preview.classList.remove(STALE_CLASS)
      preview.classList.add(COVER_CLASS)
    }
  }
}

// Reveal each deferred/cover preview the moment its new render lands (swap-when-ready), with a timeout
// fallback so an erroring render never gets stuck behind a stale overlay. Paused while the user types.
let revealRaf = 0
let revealDeadline = 0
function revealTick(): void {
  revealRaf = 0
  const root = irRoot()
  if (!root) return
  if (isTyping()) {
    // a new burst started — don't swap mid-typing; restoreOverlay handles the visuals, just wait.
    revealDeadline = performance.now() + REVEAL_TIMEOUT_MS
    revealRaf = requestAnimationFrame(revealTick)
    return
  }
  const now = performance.now()
  let remaining = false
  for (const preview of Array.from(
    root.querySelectorAll(`.${STALE_CLASS}, .${COVER_CLASS}`),
  )) {
    if (hasFreshRender(preview) || now > revealDeadline) revealPreview(preview)
    else remaining = true
  }
  if (remaining) revealRaf = requestAnimationFrame(revealTick)
}
export function scheduleReveal(): void {
  revealDeadline = performance.now() + REVEAL_TIMEOUT_MS
  if (!revealRaf) revealRaf = requestAnimationFrame(revealTick)
}

// Decision hook called from the patched ir/input.ts processCodeRender loop. While typing, cached
// diagram langs are skipped (and shown via the cached overlay); the heavy NATIVE engines are
// re-rendered once on settle. Cheap langs (code highlight, math) render immediately as before.
function deferIrDiagramRender(
  vditor: { ir: { element: HTMLElement } },
  processCodeRender: (el: HTMLElement, v: unknown) => void,
): void {
  const root = vditor.ir.element
  const previews = Array.from(
    root.querySelectorAll<HTMLElement>(".vditor-ir__preview[data-render='2']"),
  )
  // ordinals computed ONCE per keystroke (single walk) instead of per-deferred-preview (task 171 item 3)
  const ords = ordinalMap(root)
  let deferredNative = false
  for (const preview of previews) {
    const node = preview.closest('.vditor-ir__node')
    const lang = node ? nodeLang(node) : ''
    if (isTyping() && CACHED.has(lang)) {
      if (node) restoreOverlay(node, lang, ords.get(node) ?? -1)
      if (NATIVE_DEFER.has(lang)) deferredNative = true
      continue // skip the heavy render this keystroke
    }
    processCodeRender(preview, vditor)
  }
  if (deferredNative) {
    deferUntilSettle('ir-native-diagrams', () => {
      beginSettleRender() // canvas previews → cover mode (visible+sized under the overlay)
      vditor.ir.element
        .querySelectorAll<HTMLElement>(".vditor-ir__preview[data-render='2']")
        .forEach((it) => {
          processCodeRender(it, vditor)
        })
      scheduleReveal() // swap each overlay out when its new render lands
    })
  }
}

// Keep renderCache fresh: snapshot a preview once it actually holds a render, but ONLY when the user
// isn't typing AND the preview isn't one of our overlays (so we never cache the stale image we
// injected). Read-only — it can't loop the observer. rAF-coalesced so the open-time render burst
// doesn't pay per-mutation.
function snapshotRenders(): void {
  const root = irRoot()
  if (!root || isTyping()) return
  const ords = ordinalMap(root) // one walk, not one per node (task 171 item 3)
  for (const node of Array.from(
    root.querySelectorAll('.vditor-ir__node[data-type="code-block"]'),
  )) {
    const lang = nodeLang(node)
    if (!CACHED.has(lang)) continue
    const preview = previewOf(node)
    if (
      !preview ||
      preview.classList.contains(STALE_CLASS) ||
      preview.classList.contains(COVER_CLASS)
    )
      continue
    const snap = visualSnapshot(preview)
    if (!snap) continue
    const ord = ords.get(node) ?? -1
    if (ord >= 0) renderCache.set(`${lang}#${ord}`, snap)
  }
}

// Install: arm the gate on every editor input (CAPTURE phase → runs BEFORE Vditor's own input handler,
// so isTyping() is already true when the processCodeRender loop runs in the same tick) and expose the
// native defer hook for the esbuild patch. The render cache is captured on the first keystroke of a
// burst (see markEditActivity) — NOT via a MutationObserver, which rasterised canvases continuously and
// stuttered scrolling while the diagrams idle-animated.
export function installEditActivity(
  app: HTMLElement | null | undefined,
): () => void {
  // No editor root mounted yet — nothing to observe; hand back a no-op
  // disposer so callers can always call the returned teardown unconditionally.
  if (!app)
    return () => {
      /* no-op disposer */
    }
  ;(window as unknown as Record<string, unknown>).__vmdeDeferIrDiagramRender =
    deferIrDiagramRender
  // Task 172: shrink the SpinVditorIRDOM input — empty the rendered preview SVG/canvas before the spin
  // re-parses it (consumed by the esbuild patchIrStripPreviewSpin in ir/input.ts).
  ;(window as unknown as Record<string, unknown>).__vmdeStripPreviewForSpin =
    stripPreviewForSpin
  // Task 175 — defer the spin for inert fenced-body keystrokes (see trySkipFenceSpin / spin-skip-fence).
  ;(window as unknown as Record<string, unknown>).__vmdeTrySkipFenceSpin =
    trySkipFenceSpin
  // Task 536: the IR/WYSIWYG input patches request a ToC refresh here, but the mutation-impact
  // authority arms the settle callback only for heading/ToC/top-level changes. Ordinary prose never
  // adds a timer or calls Lute; repeated structural edits retain task 171's one-per-burst coalescing.
  const tocInvalidation = installTocInvalidation(app, deferUntilSettle)
  ;(window as unknown as Record<string, unknown>).__vmdeDeferRenderToc = (
    vditor: unknown,
    renderToc: (v: unknown) => void,
  ) => tocInvalidation.request(vditor, renderToc)
  ;(window as unknown as Record<string, unknown>).__vmdeTocDidRender = (
    vditor: unknown,
    refreshed?: boolean,
  ) => tocInvalidation.didRender(vditor, refreshed)
  const onInput = () => markEditActivity()
  app.addEventListener('input', onInput, true)
  return () => {
    app.removeEventListener('input', onInput, true)
    if (timer) {
      clearTimeout(timer)
      timer = 0
    }
    if (revealRaf) {
      cancelAnimationFrame(revealRaf)
      revealRaf = 0
    }
    settleCbs.clear()
    tocInvalidation.dispose()
    delete (window as unknown as Record<string, unknown>)
      .__vmdeDeferIrDiagramRender
    delete (window as unknown as Record<string, unknown>).__vmdeDeferRenderToc
    delete (window as unknown as Record<string, unknown>).__vmdeTocDidRender
    delete (window as unknown as Record<string, unknown>)
      .__vmdeStripPreviewForSpin
    delete (window as unknown as Record<string, unknown>).__vmdeTrySkipFenceSpin
  }
}
