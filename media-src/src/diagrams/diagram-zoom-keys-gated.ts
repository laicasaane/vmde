// Task 459 — keyboard `+`/`-`/`0` zoom for the "gated" diagram families (markmap, ECharts mindmap,
// Leaflet geojson/topojson maps — `zoom: 'gated'` in engine-registry.ts), reached once
// diagram-zoom-gate.ts's Ctrl+mousedown handler has focused the wrapper (same file, same gesture as
// the mouse zoom/pan these engines already gate on Ctrl).
//
// Unlike the STATIC-SVG family (diagram-zoom.ts), these engines own a REAL interactive zoom engine
// each (d3-zoom, ECharts `roam`, Leaflet). Calling their own API/pipeline — never a parallel CSS
// transform of our own — is the "respect, don't bypass" reading of the gate's contract: a second
// zoom authority here would desync from the engine's own state on the next real Ctrl+wheel/drag.
// Per engine:
//   - markmap: `svg.__vmdeMm` is the retained Markmap instance (esbuild-shared.mjs's
//     patchMarkmapStatic, also used by markmap-fit.ts). `.rescale(factor)` scales pinned at the
//     viewport centre — verified in markmap-view's source, `factor` is RELATIVE (multiplies the
//     current transform), matching this file's wheel-step convention directly. `.fit()` is markmap's
//     own "fit to container" — the natural reset, same role as diagram-zoom.ts's `reset()`.
//   - geojson/topojson (Leaflet): `wrapper.__vmdeMap`/`__vmdeMapInitialView` are stashed by
//     geojson-topojson.ts (OUR code, not vendored) right after the initial fitBounds. `zoomIn()`/
//     `zoomOut()` are Leaflet's own public API; reset restores the stashed initial view.
//   - ECharts mindmap: NO instance is retained anywhere (confirmed: diagram-retheme.ts's mindmap
//     re-theme has to RECONSTRUCT from `data-code` for the same reason — see its own comment).
//     Adding a stash would need a NEW esbuild patch on vendored mindmapRender.ts, and the only zoom
//     entry point ECharts exposes for a `tree` series' roam (`dispatchAction({type:'treeRoam'})`) is
//     an internal, undocumented action type — not something to build on unverified. Instead this
//     dispatches a SYNTHETIC `wheel` event with `ctrlKey: true` at the chart's own `<canvas>`: that is
//     the exact gesture the gate exists to gate, going through the SAME pipeline a real Ctrl+wheel
//     would (ECharts' own RoamController does the zoom math, not us) — verified working in the real
//     VS Code e2e (diagram-render-sweep.spec.ts's diagram-zoom-keys case, task 511). If mindmap
//     ever needs a real reset button, an instance stash is the honest way to add one; not attempted
//     here.
import { gatedDiagram } from './diagram-zoom-gate'
import { guardComposition } from '../util/caret-gesture'
import { controllerForDiagram } from './diagram-viewport-controller'

function onKeydown(e: KeyboardEvent): void {
  if (guardComposition(e)) return
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
  const key = e.key
  if (key !== '+' && key !== '-' && key !== '0' && key !== '=') return
  const wrapper = gatedDiagram(document.activeElement)
  if (!(wrapper instanceof HTMLElement)) return
  const controller = controllerForDiagram(wrapper)
  if (!controller) return
  e.preventDefault()
  e.stopImmediatePropagation()
  if (key === '0') controller.reset()
  else if (key === '-') controller.zoomOut()
  else controller.zoomIn()
}

let bound: ((e: KeyboardEvent) => void) | null = null

/** Install the `+`/`-`/`0` keydown handler for gated diagrams (markmap/mindmap/geojson/topojson),
 *  once diagram-zoom-gate.ts's Ctrl+mousedown has focused one. Idempotent; returns a disposer. */
export function installGatedDiagramZoomKeys(
  doc: Document = document,
): () => void {
  if (bound) doc.removeEventListener('keydown', bound, true)
  bound = onKeydown
  // CAPTURE phase, same convention as every other keydown interceptor in this codebase
  // (diagram-zoom-gate.ts, escape-toolbar.ts, list-backspace.ts, callout-nav.ts):
  // the focused wrapper is a DESCENDANT of the contenteditable editor element, and Vditor's own
  // `hotkeyEvent` listener is bound there in the BUBBLE phase — capture on `document` is what runs
  // BEFORE that, so `stopImmediatePropagation` below can actually keep `+`/`-`/`0` from also being
  // typed as a character once it reaches Vditor's handler.
  doc.addEventListener('keydown', bound, true)
  return () => {
    if (bound) doc.removeEventListener('keydown', bound, true)
    bound = null
  }
}
