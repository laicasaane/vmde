// Inline zoom/pan for the STATIC-SVG diagram renderers (d2, mermaid, flowchart, graphviz, abc,
// smiles). markmap + the ECharts mindmap already pan/zoom via their own engines (gated by
// diagram-zoom-gate.ts) and are intentionally excluded here.
//
// Interaction (chosen with the user): wheel = zoom toward the cursor, left-drag = pan, double-click =
// reset, and a ⛶ button (top-right) opens a fullscreen view. Wheel is preventDefault'd over a diagram
// so it zooms rather than scrolls the page — the diagram is an interactive surface. (A richer
// fullscreen *preview* — overlay chrome, controls — is task 157; here ⛶ just requests native
// fullscreen on the container, which the same transform handlers keep working inside.)
//
// The transform lives on the <svg> (transformOrigin 0 0; `translate(tx,ty) scale(k)`); SVG is
// resolution-independent so scaling never blurs. State is per-svg in a WeakMap. Idempotent + driven by
// a MutationObserver on #app, so it covers async D2 renders, per-keystroke Vditor rebuilds, and IR/
// WYSIWYG/Preview switches. Scoped to RENDERED diagrams inside a preview pane — never editable source.

import { clamp } from '../../../src/shared/clamp'
// 185/2a: derived from the engine registry — every engine whose zoom mode is 'static'.
import { engineLangs } from '../diagram-kit/engine-registry'
import {
  controllerForDiagram,
  createDiagramViewportController,
  registerDiagramViewportController,
} from './diagram-viewport-controller'
import {
  classifyAndRecordEditorSurfaceMutations,
  forEachChangeScope,
  forEachRecordScope,
  liveFeedOf,
  onLiveChange,
} from '../util/mutation-impact'
import {
  type BackgroundJob,
  backgroundSchedulerOf,
  type SliceBudget,
} from '../util/background-budget'
const STATIC_SVG_DIAGRAM = engineLangs((e) => e.zoom === 'static')
  .map((lang) => `.language-${lang}`)
  .join(',')
const PREVIEW_PANES =
  '.vditor-ir__preview, .vditor-wysiwyg__preview, .vditor-preview'

const MIN_K = 0.4
const MAX_K = 12
interface ZoomState {
  k: number
  tx: number
  ty: number
}
// Keyed by the WRAPPER, not the <svg>: the wrapper persists across a re-render (reRenderD2 swaps
// wrapper.innerHTML on a theme switch), the <svg> does not — so zoom/pan state must outlive the svg.
const stateOf = new WeakMap<HTMLElement, ZoomState>()

function apply(svg: SVGElement, st: ZoomState): void {
  svg.style.transform = `translate(${st.tx.toFixed(2)}px, ${st.ty.toFixed(2)}px) scale(${st.k.toFixed(4)})`
}

function reset(svg: SVGElement, st: ZoomState): void {
  st.k = 1
  st.tx = 0
  st.ty = 0
  apply(svg, st)
}

// Zoom `st` by `factor`, keeping the point (px, py) — wrapper-relative — fixed on screen. Shared by
// the Ctrl+wheel handler (px/py = cursor position) and the keyboard +/-/0 handler (task 459, px/py =
// wrapper centre — there's no cursor position for a keypress). Returns false (no-op) at the MIN_K/
// MAX_K clamp so callers can skip re-applying the transform. Exported for the unit test (pure math).
export function zoomBy(
  svg: SVGElement,
  st: ZoomState,
  factor: number,
  px: number,
  py: number,
): boolean {
  const newK = clamp(st.k * factor, MIN_K, MAX_K)
  if (newK === st.k) return false
  const ratio = newK / st.k
  st.tx = px - (px - st.tx) * ratio
  st.ty = py - (py - st.ty) * ratio
  st.k = newK
  apply(svg, st)
  return true
}

// A diagram is a rendered static-SVG block inside a preview pane (not the editable source).
function decorate(wrapper: HTMLElement): void {
  const svg = wrapper.querySelector('svg')
  if (!svg) return // D2/async renderers attach the <svg> later — the observer will retry then.

  // The wrapper clips the zoomed/panned svg; the svg transforms from its top-left. Re-apply on EVERY
  // pass: a re-render (reRenderD2 on a theme switch) replaces the svg, and we must re-style + re-apply
  // the saved transform to the new one. State is per-wrapper so zoom/pan survives the re-render.
  svg.style.transformOrigin = '0 0'
  const existing = stateOf.get(wrapper)
  const st: ZoomState = existing ?? { k: 1, tx: 0, ty: 0 }
  if (!existing) stateOf.set(wrapper, st)
  apply(svg, st)
  const controller =
    controllerForDiagram(wrapper) ??
    registerDiagramViewportController(
      wrapper,
      createDiagramViewportController(wrapper, {
        zoomIn: () => {
          const current = wrapper.querySelector('svg')
          if (!current) return
          const rect = wrapper.getBoundingClientRect()
          zoomBy(current, st, 1.12, rect.width / 2, rect.height / 2)
        },
        zoomOut: () => {
          const current = wrapper.querySelector('svg')
          if (!current) return
          const rect = wrapper.getBoundingClientRect()
          zoomBy(current, st, 1 / 1.12, rect.width / 2, rect.height / 2)
        },
        reset: () => {
          const current = wrapper.querySelector('svg')
          if (current) reset(current, st)
        },
      }),
    )

  if (wrapper.dataset.vmdeZoom === '1') return // handlers already bound — don't duplicate
  wrapper.dataset.vmdeZoom = '1'
  wrapper.style.position ||= 'relative'
  wrapper.style.overflow = 'hidden'
  // Task 459: script/click-focusable but NOT a Tab stop (tabindex="-1", not "0") — Tab never reaches
  // the editable surface's inner content anyway (`tab: '\t'`, task 456/457), and giving it a real tab
  // stop would be actively worse if that ever changes (457's decision 3). Reached via Ctrl/Cmd+
  // mousedown below — the SAME "I intend to interact with this diagram" gesture that already gates
  // wheel-zoom/drag-pan, so the keyboard entry point costs no new mental model.
  wrapper.tabIndex = -1

  // Handlers resolve the CURRENT svg via wrapper.querySelector (NOT a closure) — a re-render swaps the
  // svg out, and a stale closure would transform the detached old node (the reported "pan stops working
  // after a D2 theme reload"). The wrapper + its `st` persist, so the gestures keep working.
  // Ctrl/Cmd + wheel = zoom toward the cursor; a PLAIN wheel is left alone so the page scrolls (no
  // hijack — "przy dojechaniu do diagramu zaczyna zmieniać rozmiar"). Same model as markmap/mindmap.
  wrapper.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return // plain wheel → page scrolls (don't hijack)
      const cur = wrapper.querySelector('svg')
      if (!cur) return
      e.preventDefault()
      const rect = wrapper.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
      zoomBy(cur, st, factor, px, py) // keep the point under the cursor fixed
    },
    { passive: false },
  )

  // Ctrl/Cmd + left-drag remains the default. The shared Pan toggle additionally admits a plain
  // left-drag without changing wheel behavior.
  let dragging = false
  let panned = false
  let sx = 0
  let sy = 0
  wrapper.addEventListener('pointerdown', (e: PointerEvent) => {
    if (
      e.button !== 0 ||
      (!e.ctrlKey && !e.metaKey && !controller.isPanEnabled())
    )
      return
    e.preventDefault() // stop the drag from starting a text selection on the SVG labels
    // Task 459: Ctrl/Cmd+mousedown also FOCUSES the wrapper, regardless of whether the gesture turns
    // into a pan — it's the same "interact with this diagram" signal, and keyboard +/-/0 zoom (the
    // keydown handler below) needs a focus target to act on. preventDefault above already suppressed
    // the browser's own implicit focus-on-mousedown for a non-form element, so this call is required,
    // not redundant.
    // The legacy modified gesture remains the keyboard-zoom entry point. Pan-tool plain drag keeps
    // the editor's existing focus/caret; selecting a mouse tool must not steal editing focus.
    if (e.ctrlKey || e.metaKey) wrapper.focus({ preventScroll: true })
    dragging = true
    panned = false
    sx = e.clientX - st.tx
    sy = e.clientY - st.ty
    const cur = wrapper.querySelector('svg')
    if (cur) cur.style.cursor = 'grabbing'
    wrapper.setAttribute('data-vmde-panning', '1')
    wrapper.setPointerCapture(e.pointerId)
  })
  wrapper.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return
    const cur = wrapper.querySelector('svg')
    if (!cur) return
    panned = true
    st.tx = e.clientX - sx
    st.ty = e.clientY - sy
    apply(cur, st)
  })
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return
    dragging = false
    const cur = wrapper.querySelector('svg')
    if (cur) cur.style.cursor = ''
    wrapper.removeAttribute('data-vmde-panning')
    try {
      wrapper.releasePointerCapture(e.pointerId)
    } catch {
      /* pointer already released */
    }
  }
  wrapper.addEventListener('pointerup', endDrag)
  wrapper.addEventListener('pointercancel', endDrag)

  // Double-click = reset to the fit-width view.
  wrapper.addEventListener('dblclick', (e) => {
    e.preventDefault()
    controller.reset()
  })

  // Task 459: `+`/`-`/`0` keyboard parity with the Ctrl+wheel/dblclick gestures above, once the
  // wrapper is focused (Ctrl+mousedown, above). No modifier required on the KEY itself — unlike
  // wheel/drag, a keypress never competes with an unrelated page gesture (scrolling, text selection),
  // so there's nothing to gate; getting FOCUS in the first place is what's gated (behind Ctrl), and
  // that already happened. `=` is accepted alongside `+` (the unshifted key on a US layout — the
  // browser reports `e.key === '='` for a plain press, `'+'` only with Shift).
  //
  // Listened on the wrapper itself (not document) to match this file's existing per-wrapper event
  // style; `stopPropagation` (not stopImmediatePropagation — no sibling listener on this same element
  // needs blocking) keeps the key from reaching Vditor's own `hotkeyEvent` listener bound higher up on
  // the contenteditable ancestor, which would otherwise insert the character as text (the wrapper
  // sits INSIDE the editable surface even though it's non-editable content itself).
  wrapper.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
    const cur = wrapper.querySelector('svg')
    if (!cur) return
    if (e.key === '0') {
      e.preventDefault()
      e.stopPropagation()
      controller.reset()
      return
    }
    if (e.key !== '+' && e.key !== '-' && e.key !== '=') return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === '-') controller.zoomOut()
    else controller.zoomIn()
  })

  // A Ctrl/Cmd gesture (zoom/pan) must NOT open the block for editing — only a PLAIN click does.
  // Vditor IR/WYSIWYG expands the block on a 'click' on its mode element (ir/index.ts:113); after a
  // Ctrl-drag pan that click was bubbling up and expanding the source. Swallow it in the CAPTURE phase
  // on the wrapper (before it reaches Vditor's bubble handler) when the gesture was Ctrl/panned; a
  // plain click passes through so click-to-edit still works.
  wrapper.addEventListener(
    'click',
    (e) => {
      if ((e.target as Element | null)?.closest('.vmde-diagram-controls'))
        return
      if (panned || e.ctrlKey || e.metaKey || controller.isPanEnabled()) {
        e.stopPropagation()
        e.preventDefault()
        panned = false
      }
    },
    true,
  )
}

function decorateAll(root: ParentNode): void {
  for (const pane of root.querySelectorAll<HTMLElement>(PREVIEW_PANES)) {
    if (pane.matches(STATIC_SVG_DIAGRAM)) decorate(pane)
    for (const d of pane.querySelectorAll<HTMLElement>(STATIC_SVG_DIAGRAM))
      decorate(d)
  }
  // A diagram block can itself be the pane (rare) — also handle top-level matches under root.
  for (const d of root.querySelectorAll<HTMLElement>(STATIC_SVG_DIAGRAM)) {
    if (d.closest(PREVIEW_PANES)) decorate(d)
  }
}

/** The full decorate pass as a frame job: one static diagram per unit, with its own cursor. */
function createDecoratePass(
  app: HTMLElement,
  disposed: () => boolean,
): BackgroundJob & { restart(): void } {
  let found: NodeListOf<HTMLElement> | undefined
  let at = 0
  return {
    name: 'diagram-decorate',
    lane: 'frame',
    restart() {
      found = undefined
    },
    step(budget) {
      if (disposed() || !app.isConnected) {
        found = undefined
        return false
      }
      if (!found) {
        if (budget.spent()) return true
        found = app.querySelectorAll<HTMLElement>(STATIC_SVG_DIAGRAM)
        at = 0
      }
      if (!decorateFrom(found, budget)) return true
      found = undefined
      return false
    },
  }

  /** Decorates from the cursor; false when the slice ran out first. */
  function decorateFrom(
    list: NodeListOf<HTMLElement>,
    budget: SliceBudget,
  ): boolean {
    for (; at < list.length; at++) {
      if (budget.spent()) return false
      const diagram = list[at]
      if (diagram.isConnected && diagram.closest(PREVIEW_PANES))
        decorate(diagram)
    }
    return true
  }
}

let observer: MutationObserver | null = null
let disposeCurrent: (() => void) | null = null

/** Wire inline zoom/pan + the ⛶ button on every rendered static-SVG diagram. Idempotent; observes
 *  #app so it survives async renders, per-keystroke rebuilds, and mode switches. Returns a disposer.
 *  Task 733 (012-13, D-13 M1/M2): the full pass (open, a record outside the feed root the classifier
 *  cannot scope, a pending block that left the document without a live feed) runs as the frame job
 *  `diagram-decorate`, one diagram per unit. While the unit feed is live, records inside its root are
 *  left to the feed (binding rule 6); the change scopes and the render subtrees the feed never
 *  reports (`forEachRecordScope`) are decorated in the next frame. */
export function observeDiagramZoom(app: HTMLElement | null): () => void {
  // No editor root mounted yet — nothing to observe; hand back a no-op
  // disposer so callers can always call the returned teardown unconditionally.
  if (!app)
    return () => {
      /* no-op disposer */
    }
  disposeCurrent?.()
  const scheduler = backgroundSchedulerOf(window)
  let disposed = false
  const fullPass = createDecoratePass(app, () => disposed)
  const postFull = (): void => {
    fullPass.restart()
    scheduler.post(fullPass)
  }
  let frame = 0
  const pendingBlocks = new Set<HTMLElement>()
  const run = () => {
    frame = 0
    const live = liveFeedOf(app) !== undefined
    for (const block of pendingBlocks) {
      if (block.isConnected) decorateAll(block)
      else if (!live) {
        postFull()
        break
      }
    }
    pendingBlocks.clear()
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(run)
  }
  const add = (block: Element) => {
    if (block instanceof HTMLElement) pendingBlocks.add(block)
  }
  const onRecords = (records: MutationRecord[]) => {
    if (liveFeedOf(app)) {
      const before = pendingBlocks.size
      forEachRecordScope(app, records, add)
      if (pendingBlocks.size > before) schedule()
      return
    }
    const classified = classifyAndRecordEditorSurfaceMutations(
      'diagram-zoom',
      records,
    )
    if (!classified) return
    const { impact, pass } = classified
    if (pass === 'skipped') return
    if (impact.full) {
      postFull()
      return
    }
    for (const block of impact.blocks) add(block)
    schedule()
  }
  observer?.disconnect()
  observer = new MutationObserver(onRecords)
  observer.observe(app, { childList: true, subtree: true })
  const offFeed = onLiveChange(app, (change) => {
    if (change.whole) {
      postFull()
      return
    }
    const before = pendingBlocks.size
    forEachChangeScope(change, add)
    if (pendingBlocks.size > before) schedule()
  })
  postFull()
  const dispose = () => {
    if (disposed) return
    disposed = true
    observer?.disconnect()
    observer = null
    offFeed()
    scheduler.cancel(fullPass)
    if (frame) cancelAnimationFrame(frame)
    if (disposeCurrent === dispose) disposeCurrent = null
  }
  disposeCurrent = dispose
  return dispose
}
