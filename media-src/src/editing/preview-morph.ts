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
// Task 733 / 015: element counts per Source unit of a Split pane (see `morphPreviewUnits`).
const unitCounts = new WeakMap<HTMLElement, number[]>()

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
  // Task 733 / 015: a raw-diff morph rewrites the pane outside the unit baseline.
  unitCounts.delete(el)
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

// Task 733 / 015-I3 (task 015 section 6.2 D-6): the Split pane morph by Source units. The pane holds one
// group of top-level elements per Source unit; the baseline keeps each group's element count, so a
// changed unit replaces only its own elements, with no raw-HTML diff of the pane. A pane whose element
// count no longer matches its baseline (an outside write) answers false and the caller falls back.

/** Records the element count of each unit of a pane built outside `morphPreviewUnits` (a whole render). */
export function setPreviewUnitBaseline(
  pane: HTMLElement,
  elementCounts: readonly number[],
): void {
  unitCounts.set(pane, [...elementCounts])
}

/** The number of units a pane's baseline holds; undefined without a baseline. */
export function previewUnitCount(pane: HTMLElement): number | undefined {
  return unitCounts.get(pane)?.length
}

/**
 * Task 733 / 019 (C5, Q-157): the top-level elements of `html`, parsed in `pane`'s document, each followed
 * by the whitespace Text node `Md2HTML` writes after it (the `\n` between blocks), so a unit render gives
 * the same pane DOM as a whole render. `elements` counts the elements only (the baseline unit).
 */
export function previewNodesOf(
  pane: HTMLElement,
  html: string,
): { nodes: Node[]; elements: number } {
  const template = pane.ownerDocument.createElement('template')
  template.innerHTML = html
  const nodes: Node[] = []
  let elements = 0
  let afterElement = false
  for (const node of Array.from(template.content.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      nodes.push(node)
      elements++
      afterElement = true
    } else if (afterElement && isSeparator(node)) {
      nodes.push(node)
      afterElement = false
    } else afterElement = false
  }
  return { nodes, elements }
}

/** Removes `count` elements from `start`, each with the separator after it (019 C5). */
function removeElements(
  children: HTMLCollection,
  start: number,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const element = children[start]
    if (!element) return
    const next = element.nextSibling
    if (isSeparator(next)) next?.remove()
    element.remove()
  }
}

/** A whitespace-only Text node: the separator a whole render writes between top-level blocks. */
function isSeparator(node: Node | null): boolean {
  return (
    node !== null &&
    node.nodeType === Node.TEXT_NODE &&
    (node.textContent ?? '').trim() === ''
  )
}

/**
 * Replaces the elements of units `from` to `from + removed - 1` by the elements of `htmls` (one entry per
 * new unit). Elements of other units stay the same nodes. False when the pane left its baseline
 * (nothing written); the caller renders the pane whole then.
 */
export function morphPreviewUnits(
  pane: HTMLElement,
  from: number,
  removed: number,
  htmls: readonly string[],
): boolean {
  const counts = unitCounts.get(pane)
  if (!counts || from < 0 || from + removed > counts.length) return false
  let total = 0
  let start = 0
  for (let i = 0; i < counts.length; i++) {
    if (i === from) start = total
    total += counts[i]
  }
  if (from === counts.length) start = total
  const children = pane.children
  if (total !== children.length) return false
  let removedElements = 0
  for (let i = from; i < from + removed; i++) removedElements += counts[i]
  const stopAt = children[start + removedElements] ?? null
  removeElements(children, start, removedElements)
  const fresh: number[] = []
  for (const html of htmls) {
    const { nodes, elements } = previewNodesOf(pane, html)
    for (const node of nodes) pane.insertBefore(node, stopAt)
    fresh.push(elements)
  }
  counts.splice(from, removed, ...fresh)
  // The raw cache of `morphPreviewInto` no longer describes the pane: its next morph sets it whole.
  rawCache.delete(pane)
  return true
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
