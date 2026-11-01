// Block-level morph for Vditor's preview pane (task 187 item 1).
//
// Vditor's preview.render replaces the WHOLE pane via `previewElement.innerHTML = html`
// on every debounced edit settle — every rendered diagram is torn down and rebuilt
// (leaflet re-initialises its map, STL re-boots three.js, echarts re-instantiates; the
// render cache only makes the rebuild cheaper, not invisible). In sv split mode that
// happens on every typing pause. This morph splices ONLY the changed region instead.
//
// The diff is RAW-vs-RAW: the live DOM is post-processed (code swapped for svg,
// data-processed marks, re-themed colours), so comparing it against the fresh Lute
// HTML would mismatch on every diagram block even when the SOURCE is unchanged. We
// cache the raw block strings of the previous render per pane (WeakMap) and run a
// prefix/suffix two-pointer against the new ones: blocks in the common prefix/suffix
// keep their live DOM untouched (engine instances survive; afterRender's adapters
// skip them via their data-processed guards), and only the middle region is removed
// and re-inserted from the new HTML — including its interleaved whitespace text
// nodes, so the result matches what a plain innerHTML set would have produced.
//
// Fail-safe: if the pane's element children no longer match the cached raws (external
// mutation — reRender* theme flips, setValue, streaming), if the new HTML has nodes
// before its first element, or if anything throws, fall back to a plain innerHTML set
// and re-baseline.

const rawCache = new WeakMap<HTMLElement, string[]>()

// One top-level unit = an element plus its trailing non-element siblings (Lute emits
// '\n' text nodes between blocks; they ride with the PRECEDING block).
interface Unit {
  raw: string
  nodes: Node[]
}

function unitsOf(fragment: DocumentFragment): Unit[] | null {
  const units: Unit[] = []
  let current: Unit | null = null
  for (const node of Array.from(fragment.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      current = { raw: (node as Element).outerHTML, nodes: [node] }
      units.push(current)
    } else if (current) {
      current.nodes.push(node)
    } else {
      // Nodes BEFORE the first element — no unit to attach them to; signal fallback.
      return null
    }
  }
  return units
}

function fullSet(el: HTMLElement, html: string, raws: string[]): void {
  el.innerHTML = html
  rawCache.set(el, raws)
}

/** Morph `html` into `el`, keeping the DOM of blocks whose RAW html is unchanged
 *  since the previous morph. Exported for unit tests; installed as the
 *  window.__vmdeMorphPreview hook consumed by the vditor preview patch. */
export function morphPreviewInto(el: HTMLElement, html: string): void {
  try {
    const tpl = document.createElement('template')
    tpl.innerHTML = html
    const units = unitsOf(tpl.content)
    if (!units) {
      fullSet(el, html, [])
      return
    }
    const newRaws = units.map((u) => u.raw)
    const oldRaws = rawCache.get(el)
    const oldEls = Array.from(el.children) as HTMLElement[]
    // No baseline, or the pane was mutated outside the morph (theme reRender*,
    // setValue, streaming) → the cache can't be trusted; full set + re-baseline.
    if (!oldRaws || oldRaws.length !== oldEls.length) {
      fullSet(el, html, newRaws)
      return
    }
    // Two-pointer: common prefix, then common suffix over the remainder.
    const oLen = oldRaws.length
    const nLen = newRaws.length
    let p = 0
    while (p < oLen && p < nLen && oldRaws[p] === newRaws[p]) p++
    let s = 0
    while (
      s < oLen - p &&
      s < nLen - p &&
      oldRaws[oLen - 1 - s] === newRaws[nLen - 1 - s]
    )
      s++
    rawCache.set(el, newRaws)
    if (p === oLen && p === nLen) return // nothing changed
    // Remove the old middle region: from the first changed element through every
    // sibling (incl. its trailing text nodes) up to the first kept suffix element.
    const stopAt: Node | null = s > 0 ? oldEls[oLen - s] : null
    let cursor: Node | null = oldEls[p] ?? null
    // p === oLen (pure insertion): removal is empty, but the kept prefix's trailing
    // text nodes already sit before `stopAt`, which is exactly where we insert.
    while (cursor && cursor !== stopAt) {
      const next: Node | null = cursor.nextSibling
      el.removeChild(cursor)
      cursor = next
    }
    const fresh = units.slice(p, nLen - s).flatMap((u) => u.nodes)
    for (const node of fresh) el.insertBefore(node, stopAt)
  } catch {
    // Never leave the preview broken — behave exactly like the unpatched Vditor.
    el.innerHTML = html
    rawCache.delete(el)
  }
}

/** Task 643: record the raw top-level element strings of a pane that was built outside the morph (a
 *  streamed Preview), so the next morph keeps its unchanged blocks instead of rebuilding the pane.
 *  A baseline whose length disagrees with the pane's element children is ignored by `morphPreviewInto`. */
export function setPreviewMorphBaseline(el: HTMLElement, raws: string[]): void {
  rawCache.set(el, raws)
}

declare global {
  interface Window {
    __vmdeMorphPreview?: (el: HTMLElement, html: string) => void
  }
}

/** Install the hook the patched vditor preview.render consumes. Idempotent; safe to
 *  call any time before the first preview render (finish-init does). */
export function installPreviewMorph(): void {
  window.__vmdeMorphPreview = morphPreviewInto
}
