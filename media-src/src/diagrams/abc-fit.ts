// abc (music notation, abcjs) renders an `<svg width="W" height="H">` with NO viewBox. Without a
// viewBox the svg's coordinate system is 1:1 with pixels, so CSS `max-width` shrinks the svg's
// viewport box but the notation stays at its original coordinates and just CLIPS (doesn't scale) —
// it's even clipped at the default column width (intrinsic ~755px > the ~545px column). Give the svg
// a viewBox; then the CSS in main.css (`max-width:100%`, `height:auto`) scales the content
// responsively.
//
// Use the CONTENT bbox (getBBox), NOT the width/height attrs: abcjs pads the svg far wider than the
// actual notation (width attr ~755 but the staff is only ~450 wide), so an attrs-based viewBox would
// scale that trailing whitespace in too → a big empty margin on the right. The content bbox crops to
// the real notation so it fills the column. getBBox is safe here (abc is a static one-shot render
// with no d3 transition — unlike markmap, whose mid-fit bbox blew up). Idempotent: `:not([viewBox])`.

import {
  forEachChangeScope,
  forEachRecordScope,
  liveFeedOf,
  onLiveChange,
} from '../util/mutation-impact'

/** Give every abc svg lacking a viewBox one tight to its rendered content (getBBox). */
function fitAbc(root: ParentNode): void {
  const svgs = root.querySelectorAll<SVGSVGElement>(
    '.language-abc svg:not([viewBox])',
  )
  // Task 416: MEASURE-then-WRITE in two passes. Writing the viewBox/width/height of svg N
  // invalidates layout, so calling getBBox on svg N+1 in the same pass forces a synchronous
  // re-layout per diagram. Reads are batched first; the values are identical (each svg's bbox
  // is independent of its siblings' viewBox attrs), only the reflow count changes. Usually one
  // abc block per document, so this is hygiene rather than a measured win.
  const pad = 2 // a hair of padding so edge strokes aren't clipped by the tight bbox
  const measured: {
    svg: SVGSVGElement
    x: number
    y: number
    w: number
    h: number
  }[] = []
  for (const svg of Array.from(svgs)) {
    let bb: { x: number; y: number; width: number; height: number }
    try {
      bb = (svg as unknown as SVGGraphicsElement).getBBox()
    } catch {
      continue // getBBox throws on a detached/0-size svg
    }
    if (bb.width < 1 || bb.height < 1) continue // not rendered yet
    measured.push({
      svg,
      x: bb.x - pad,
      y: bb.y - pad,
      w: bb.width + pad * 2,
      h: bb.height + pad * 2,
    })
  }
  for (const { svg, x, y, w, h } of measured) {
    svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`)
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    // Pin the intrinsic size to the CONTENT size (abcjs's width attr is ~755, far wider than the
    // staff) so `max-width:100%` caps abc at its NATURAL size — it renders at most this big when the
    // column is wide (not upscaled to fill it) and only shrinks when the column is narrower. Without
    // this the viewBox would scale the content UP to the full column (bigger than before).
    svg.setAttribute('width', String(w))
    svg.setAttribute('height', String(h))
  }
}

/**
 * Keep abc svgs responsive as the editor renders/rebuilds them. rAF-debounced; idempotent (a svg with
 * a viewBox is skipped, and the observer watches childList/subtree — not attributes — so our own
 * viewBox write doesn't re-trigger it). Returns a disposer.
 *
 * Task 733 (012-13, D-13 binding rules 2 and 6): while the unit feed is live, records inside its root
 * are left to the feed. The frame fits the change scopes and the render subtrees the feed never
 * reports (`forEachRecordScope`, which is where abcjs draws), never the whole root. Without a live
 * feed, and for a whole change, the frame fits the whole root as before.
 */
export function observeAbc(appEl: HTMLElement | null | undefined): () => void {
  if (!appEl)
    return () => {
      /* no-op disposer */
    }
  let raf = 0
  let whole = true
  const scopes = new Set<Element>()
  const run = () => {
    raf = 0
    if (whole) fitAbc(appEl)
    else for (const scope of scopes) if (scope.isConnected) fitAbc(scope)
    whole = false
    scopes.clear()
  }
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(run)
  }
  const addScope = (scope: Element) => {
    scopes.add(scope)
  }
  const obs = new MutationObserver((records) => {
    if (!liveFeedOf(appEl)) whole = true
    else forEachRecordScope(appEl, records, addScope)
    if (whole || scopes.size > 0) schedule()
  })
  obs.observe(appEl, { childList: true, subtree: true })
  const offFeed = onLiveChange(appEl, (change) => {
    if (change.whole) whole = true
    else forEachChangeScope(change, addScope)
    if (whole || scopes.size > 0) schedule()
  })
  schedule()
  return () => {
    obs.disconnect()
    offFeed()
    if (raf) cancelAnimationFrame(raf)
  }
}
