// Task 720 — block-scoped Undo/Redo restore for the patched Vditor `Undo.renderDiff`.
//
// Upstream `renderDiff` applies the restored snapshot with `element.innerHTML = text`, so every
// Undo and Redo rebuilt the whole editor: every top-level block became a new node, rendered
// previews were reset, and every VMDE decorator (front-matter table, responsive table widths, fold
// gutters, wrap hints) ran a full pass against blocks with no remembered size. Measured in real VS
// Code: 0 of 30 (and 0 of 1,330) blocks kept their identity, and the reactions moved the view.
// esbuild-shared.mjs's patchUndoBlockScopedRestore replaces that assignment with
// `restoreSnapshotBlocks`, which replaces only the contiguous run of top-level nodes that differ.
// Vditor's history stays string-based: the patch still sets `lastText = text`, so the next
// diff-match-patch step does not depend on which nodes were kept.
//
// How a top-level node is judged unchanged (the common prefix and suffix): its block in the
// restored snapshot must be equivalent to its block in the previous snapshot (`lastText`), and the
// live node must be equivalent to that previous block. "Equivalent" means equal as Lute reads it.
// Two snapshots of the same source can differ in view state captured at different times, and the
// live DOM holds view state no snapshot has: rendered previews (a snapshot resets ECharts,
// PlantUML, mindmap, math and pending Mermaid previews to source), the front-matter properties
// table, wrap-hint spans, WYSIWYG code-highlight spans, fold and accessibility attributes, the
// responsive-table width class, the IR expand class and IR code tagging. Measured in real VS Code:
// with an exact comparison, the 112 KB document replaced 211 blocks around one edit, because the
// tables near the view had a width class in one snapshot only. So nodes are compared exactly first
// and otherwise by a projection: tag names, attributes other than view state, checkbox state and
// text, skipping `data-render` subtrees (Lute's serializers skip them too) and caret markers, with
// WYSIWYG highlight spans transparent (every WYSIWYG Lute call flattens them first). A live node
// that differs from the previous snapshot in that projection (an unrecorded change) is replaced from
// the restored snapshot, never kept stale. A restored block that holds the caret marker is always
// replaced (on its own when it is otherwise unchanged), so the marker reaches the live DOM and
// upstream's `setRangeByWbr` branch still runs.
// Anything the comparison cannot align falls back to the upstream whole-root assignment: an empty
// root, a live top level whose node count differs from the previous snapshot, or top-level table
// parts (a `template` parse keeps them, the editor root's own parse would drop them).

const TEXT_NODE = 3
const ELEMENT_NODE = 1
// Vditor's caret markers: `<wbr>` in a snapshot string, `span.vditor-wbr` while addCaret runs.
const MARKER = 'wbr, .vditor-wbr'
// Rendered output, never source: both Lute DOM serializers skip a `data-render` subtree.
const RENDERED =
  '.vditor-ir__preview, .vditor-wysiwyg__preview, [data-render="1"], [data-render="2"]'
// The WYSIWYG code element whose highlight spans wysiwyg-code-highlight.ts flattens before Lute.
const HIGHLIGHTED_CODE_PARENT = 'pre.vditor-wysiwyg__pre'
// View-state attributes VMDE or the webview set on live blocks.
const VIEW_ATTRIBUTE =
  /^(?:style|id|role|tabindex|spellcheck|data-vmde-.*|aria-.*)$/
// The unit history also leaves out `data-vscode-context`, the webview context menu of a block
// (chrome/webview-context.ts writes it quietly after a render, after the window was captured).
const HISTORY_VIEW_ATTRIBUTE = 'data-vscode-context'
// View-state class tokens: VMDE's own (`vmde-*`), Vditor's IR caret expansion, wiki chip
// expansion, and code tagging (code-source.ts, wysiwyg-code-highlight.ts).
const VIEW_CLASS =
  /^(?:vmde-.*|vditor-ir__node--expand|wiki-link-chip--expanded|hljs)$/
// The IR node and WYSIWYG block Lute renders for YAML front matter.
const FRONT_MATTER = '[data-type="yaml-front-matter"]'
// Children an editor root's parse drops but a template parse keeps.
const TABLE_PART = /^(?:TR|TD|TH|TBODY|THEAD|TFOOT|CAPTION|COL|COLGROUP)$/

const isElement = (node: Node): node is Element =>
  node.nodeType === ELEMENT_NODE
const isMarker = (node: Node) => isElement(node) && node.matches(MARKER)
const holdsMarker = (node: Node) =>
  isElement(node) && (node.matches(MARKER) || !!node.querySelector(MARKER))

// An inert parse: template content runs no scripts and loads nothing until it is inserted.
function parseSnapshot(html: string): Node[] {
  const template = document.createElement('template')
  template.innerHTML = html
  return Array.from(template.content.childNodes)
}

// Lute's callout render of a blockquote: the type and title it derives from the `[!TYPE] Title` text
// the blockquote holds. A block re-spin adds them to a blockquote written without them.
const CALLOUT_ATTRIBUTE = /^data-callout(?:-title)?$/

/** Whether an attribute is view state; `history` and `callout` add the unit history's exclusions. */
function viewOnlyAttribute(
  name: string,
  history: boolean,
  callout: boolean,
): boolean {
  return (
    VIEW_ATTRIBUTE.test(name) ||
    (history && name === HISTORY_VIEW_ATTRIBUTE) ||
    (callout && CALLOUT_ATTRIBUTE.test(name))
  )
}

function attributeShape(el: Element, history = false): string {
  const parts: string[] = []
  const callout = history && el.tagName === 'BLOCKQUOTE'
  for (const attr of Array.from(el.attributes)) {
    if (viewOnlyAttribute(attr.name, history, callout)) continue
    if (attr.name === 'class') {
      const kept = attr.value
        .split(/\s+/)
        .filter(
          (token) =>
            token &&
            !VIEW_CLASS.test(token) &&
            !(callout && token === 'vditor-ir__node'),
        )
        .sort()
      if (kept.length) parts.push(`class=${kept.join(' ')}`)
      continue
    }
    parts.push(`${attr.name}=${attr.value}`)
  }
  // A checkbox's state can differ from its attribute after a click.
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'checkbox')
    parts.push(`:checked=${(el as HTMLInputElement).checked}`)
  return parts.sort().join('\u0001')
}

// The semantic wrapper the inline-HTML presentation (editing/html-subscript.ts) puts around an
// authored `<sub>`, `<sup>`, `<ins>` or `<a>` body while the caret is elsewhere. Lute never sees it
// (it is stripped before every Lute call), so the unit history's projection reads through it.
const PRESENTATION_WRAPPER =
  '[data-vmde-html-subscript],[data-vmde-html-superscript],[data-vmde-html-underline],[data-vmde-html-link]'

// The Lute-visible shape of a node, in document order. Adjacent text is concatenated, so a text node
// split by a wrap-hint span or a removed marker projects the same as the unsplit one. `presentation`
// (the unit history only): a presentation wrapper projects as its children, and a blockquote's
// derived callout attributes are left out.
function sourceShape(
  node: Node,
  out: string[],
  highlighted: boolean,
  presentation = false,
): void {
  if (node.nodeType === TEXT_NODE) {
    out.push((node as Text).data)
    return
  }
  if (!isElement(node)) {
    out.push(`\u0002${node.nodeType}`)
    return
  }
  if (node.matches(RENDERED) || node.matches(MARKER)) return
  if (
    (highlighted && node.tagName === 'SPAN') ||
    (presentation && node.matches(PRESENTATION_WRAPPER))
  ) {
    for (const child of Array.from(node.childNodes))
      sourceShape(child, out, highlighted, presentation)
    return
  }
  out.push(
    `\u0003${node.tagName}\u0004${attributeShape(node, presentation)}\u0005`,
  )
  const inner =
    highlighted ||
    (node.tagName === 'CODE' &&
      !!node.parentElement?.matches(HIGHLIGHTED_CODE_PARENT))
  for (const child of Array.from(node.childNodes))
    sourceShape(child, out, inner, presentation)
  out.push('\u0006')
}

function projection(node: Node): string {
  const out: string[] = []
  sourceShape(node, out, false)
  return out.join('')
}

/**
 * Task 733 (task 004): the source projection the unit history capture (bridge/unit-capture.ts)
 * verifies a window with: this restore's projection, which also reads through the inline-HTML
 * presentation wrappers (the decoration is undone and redone by the caret, never by an edit) and
 * leaves out the webview context-menu attribute and the callout attributes Lute derives from a
 * blockquote's text.
 */
export function historySourceProjection(node: Node): string {
  const out: string[] = []
  sourceShape(node, out, false, true)
  return out.join('')
}

// Each node is projected at most once per restore (a previous block is compared twice).
function equivalence() {
  const memo = new Map<Node, string>()
  const shape = (node: Node) => {
    let value = memo.get(node)
    if (value === undefined) {
      value = projection(node)
      memo.set(node, value)
    }
    return value
  }
  return (a: Node, b: Node) =>
    a.isEqualNode(b) || (a.nodeType === b.nodeType && shape(a) === shape(b))
}

// The replaced nodes, re-read from the live root on every query: the changed run `[lead, length -
// trail)` plus single swapped blocks, named by their index from the start (inside the kept lead) or
// from the end (inside the kept trail). A later rewrite of a replaced top-level node (Vditor's
// ECharts re-spin assigns `outerHTML`) or a marker removal inside the run keeps the right
// boundaries because the kept nodes are counted from both ends.
function rangeQuery(
  root: HTMLElement,
  lead: number,
  trail: number,
  swappedFromStart: number[] = [],
  swappedFromEnd: number[] = [],
) {
  return (selector: string): Element[] => {
    const nodes = root.childNodes
    const indices = [
      ...swappedFromStart,
      ...Array.from(
        { length: Math.max(0, nodes.length - trail - lead) },
        (_, k) => lead + k,
      ),
      ...swappedFromEnd.map((fromEnd) => nodes.length - 1 - fromEnd).reverse(),
    ]
    const found: Element[] = []
    for (const index of indices) {
      const node = nodes[index]
      if (!node || !isElement(node)) continue
      if (node.matches(selector)) found.push(node)
      found.push(...Array.from(node.querySelectorAll(selector)))
    }
    return found
  }
}

function fullRestore(root: HTMLElement, restoredHtml: string) {
  root.innerHTML = restoredHtml
  return { full: true, querySelectorAll: rangeQuery(root, 0, 0) }
}

// The counts of equal leading and trailing top-level nodes (equal as Lute reads it in all three
// lists); the trailing run never overlaps the leading one. A top-level marker node of the restored
// snapshot has no counterpart and stays in the changed run.
function equalEnds(live: Node[], previous: Node[], restored: Node[]) {
  const equivalent = equivalence()
  const unchanged = (index: number, fromEnd: boolean) => {
    const next = restored[fromEnd ? restored.length - 1 - index : index]
    const before = previous[fromEnd ? previous.length - 1 - index : index]
    const current = live[fromEnd ? live.length - 1 - index : index]
    return (
      !isMarker(next) && equivalent(before, next) && equivalent(current, before)
    )
  }
  const limit = Math.min(live.length, restored.length)
  let lead = 0
  while (lead < limit && unchanged(lead, false)) lead++
  let trail = 0
  while (trail < limit - lead && unchanged(trail, true)) trail++
  return { lead, trail }
}

// Replace the live nodes `[lead, length - trail)` with the restored nodes between the same ends.
function replaceRun(
  root: HTMLElement,
  live: Node[],
  restored: Node[],
  lead: number,
  trail: number,
): void {
  const firstKeptAfter = trail > 0 ? live[live.length - trail] : null
  if (lead < live.length - trail) {
    const range = document.createRange()
    range.setStartBefore(live[lead])
    if (firstKeptAfter) range.setEndBefore(firstKeptAfter)
    else range.setEndAfter(live[live.length - 1])
    range.deleteContents()
  }
  const inserted = restored.slice(lead, restored.length - trail)
  if (!inserted.length) return
  const fragment = document.createDocumentFragment()
  fragment.append(...inserted)
  root.insertBefore(fragment, firstKeptAfter)
}

// An unchanged block whose restored copy holds the caret marker (the caret sat elsewhere when the
// snapshot was taken; measured in WYSIWYG: the front matter) is swapped on its own, so the marker
// reaches the live DOM for upstream's setRangeByWbr branch while the blocks between it and the
// changed run stay. Runs after replaceRun: the kept nodes named here are still in place.
// An unchanged front matter is not swapped while another block changed: the restore bridge drops a
// marker there in that case and places the caret at the change (undo-restore-caret.ts,
// frontMatterMarkerIsStale), so the swap would only rebuild the properties table.
function swapMarkerBlocks(
  live: Node[],
  restored: Node[],
  lead: number,
  trail: number,
) {
  const changed = lead < live.length - trail || lead < restored.length - trail
  const swappable = (node: Node) =>
    holdsMarker(node) && !(changed && (node as Element).matches(FRONT_MATTER))
  const fromStart: number[] = []
  const fromEnd: number[] = []
  for (let index = 0; index < lead; index++)
    if (swappable(restored[index])) fromStart.push(index)
  for (let back = 0; back < trail; back++)
    if (swappable(restored[restored.length - 1 - back])) fromEnd.push(back)
  for (const index of fromStart)
    live[index].parentNode?.replaceChild(restored[index], live[index])
  for (const back of fromEnd) {
    const current = live[live.length - 1 - back]
    current.parentNode?.replaceChild(
      restored[restored.length - 1 - back],
      current,
    )
  }
  return { fromStart, fromEnd }
}

/**
 * Apply the snapshot `restoredHtml` to the editor `root`, which currently renders the snapshot
 * `previousHtml` (Vditor's `lastText` before the transition). Unchanged top-level nodes keep their
 * identity; only the contiguous changed run is replaced with nodes parsed from `restoredHtml`, plus,
 * on its own, an otherwise unchanged block that holds the restored caret marker. `querySelectorAll`
 * searches the replaced nodes only (the whole root after a full rebuild), for the preview passes
 * that follow in `renderDiff`.
 */
export function restoreSnapshotBlocks(
  root: HTMLElement,
  previousHtml: string,
  restoredHtml: string,
) {
  const live = Array.from(root.childNodes)
  if (live.length === 0 || live.some(isMarker))
    return fullRestore(root, restoredHtml)
  const previous = parseSnapshot(previousHtml).filter((node) => !isMarker(node))
  const restored = parseSnapshot(restoredHtml)
  if (
    previous.length !== live.length ||
    restored.some((node) => isElement(node) && TABLE_PART.test(node.tagName))
  )
    return fullRestore(root, restoredHtml)
  const { lead, trail } = equalEnds(live, previous, restored)
  replaceRun(root, live, restored, lead, trail)
  const swapped = swapMarkerBlocks(live, restored, lead, trail)
  return {
    full: false,
    querySelectorAll: rangeQuery(
      root,
      lead,
      trail,
      swapped.fromStart,
      swapped.fromEnd,
    ),
  }
}
