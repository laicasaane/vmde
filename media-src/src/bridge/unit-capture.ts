import { historySourceProjection } from '../editing/undo-block-restore'
import {
  windowChangeEndpoint,
  windowSourceText,
} from '../editing/undo-restore-caret'
import { flattenSourceHtml } from '../editing/wysiwyg-code-highlight'
import { processCodeRender } from 'vditor/src/ts/util/processCode'
import type {
  HistoryCapture,
  HistoryModelPort,
  RestoredCaret,
  UnitMode,
} from '../util/unit-changes'
import { isHintSpan } from '../util/wrap-hint-mark'
import { reportError } from '../util/webview-log'
import type { TextModel, Unit } from './text-model'
import { isViewOnlyChild } from './unit-dom'
import { type ModeLute, spinLuteOf } from './unit-lute'

// Task 733 (task 004): the history capture of the model session. Between two checkpoints it keeps,
// per changed unit, the HTML the unit had before its first change (read from the model's pre-touch
// and idle proofs, never from a clone of the root) and reads the HTML it has now at `capture()`.
// `restore()` puts one side back with ordinary DOM writes, so the model observes them and the next
// sync computes the text change. HTML kept here comes only from the live DOM and never leaves the
// webview (SR-2); restore verifies every window against the projection of the opposite side first,
// so a DOM changed by anything else is refused, not overwritten.

type U = Unit<HTMLElement>

/** One changed region. `a` is the root index (blocks: first element; cell, item: the table or list). */
interface Window {
  readonly kind: 'cell' | 'item' | 'blocks'
  readonly a: number
  /** item: item index; cell: row index. */
  readonly b: number
  /** cell: column index. */
  readonly c: number
  readonly beforeCount: number
  readonly afterCount: number
  /** Normalized HTML; undefined: the model never proved it, so this side cannot be restored. */
  readonly before: string | undefined
  /** The bytes the units of `before` had, one per restored top-level element: an Undo hands them back to the model. */
  readonly forms?: Forms
  readonly after: string
  /** Task 733 / 034: a table window for an `align` change, which the source projection does not see. */
  readonly alignment?: true
  /**
   * Task 733 / 036 (F8): a root window's sides by part (`before`: one per unit entry; `after`: one per
   * element), kept by reference from the strings the sides are joined from, for the sliced restore.
   */
  readonly beforeParts?: readonly string[]
  readonly afterParts?: readonly string[]
}

interface Step {
  readonly windows: readonly Window[]
}

interface Capture {
  readonly generation: number
  readonly steps: readonly Step[]
}

/**
 * Task 733 / 036 (F8): sliced-restore counters for the end-to-end harness (`__vmdeE2EReadiness` only; a
 * product page creates no global). Kinds and counts only.
 */
interface SlicedRestoreStats {
  sliced: number
  whole: number
  slices: number
  /**
   * 036 S5.2 (S5 design rev 2 section 3): why a sliced restore failed, by kind. `parts`: a window has no
   * parts; `anchor`: the window's elements are not the captured ones; `foreign`: a model batch outside a
   * slice; `aborted`: the session stopped the restore; `generation`: the capture is stale (or no root).
   */
  failed: Record<SlicedFailure, number>
}
type SlicedFailure = 'parts' | 'anchor' | 'foreign' | 'aborted' | 'generation'
const slicedFailed = (kind: SlicedFailure): void => {
  const stats = slicedRestoreStats()
  if (stats) stats.failed[kind]++
}
function slicedRestoreStats(): SlicedRestoreStats | undefined {
  const slot = globalThis as unknown as {
    __vmdeE2EReadiness?: unknown
    __vmdeSlicedRestore?: SlicedRestoreStats
  }
  if (!slot.__vmdeE2EReadiness) return undefined
  slot.__vmdeSlicedRestore ??= {
    sliced: 0,
    whole: 0,
    slices: 0,
    failed: { parts: 0, anchor: 0, foreign: 0, aborted: 0, generation: 0 },
  }
  return slot.__vmdeSlicedRestore
}

/** Task 733 / 036 (F8): the most HTML one chunk of a sliced restore parses and writes. */
const SLICE_CHUNK_CHARS = 16 * 1024

/** Task 733 / 036 (F8): one write of a sliced restore. */
type SliceChunk =
  | { readonly kind: 'blocks' | 'rows' | 'table-end'; readonly html: string }
  | { readonly kind: 'shell'; readonly html: string; readonly full: string }

/** The bytes that carried a unit, with its kind (the model finds the canon of the restored element itself). */
interface Form {
  readonly kind: U['kind']
  readonly bytes: string
}

/** One entry per restored top-level element; a list holds one form per item; undefined: no form. */
type Forms = ReadonlyArray<Form | readonly Form[] | undefined>

/** What `before` needs of one top-level unit, copied at the first structure notice of an interval. */
interface SnapUnit {
  readonly unit: U
  readonly kind: U['kind']
  /** The unit's members; for a multi-member unit, the root children they span (see `topsOf`). */
  readonly members: HTMLElement[]
  /** List item: its list. */
  readonly list: HTMLElement | undefined
  /** A string when known, undefined when dirty and unproven, null when clean (read the members later). */
  readonly was: string | undefined | null
  /** Enough to read the unit's canon and bytes later from the text at the notice (no copy now). */
  readonly canon: string | undefined
  readonly start: number
  readonly end: number
  readonly forms: ReadonlyArray<{ canon: string; bytes: string }>
  /**
   * `was` is a later state than the model's proof (a capture remembered it, and no sync has caught the
   * model up since): the model's text does not hold the bytes of `was`.
   */
  readonly ahead: boolean
  /**
   * 036 core C4 (restore fix): the unit's form before the interval's first change, read before any sync
   * (its leaf form, or its table's first-notice bytes); null when that form was stale (no usable bytes).
   */
  readonly earlier?: Form | null
}

/** A table whose rows or columns changed, as it was when the change was first seen. */
interface TableSnap {
  readonly block: HTMLElement
  /** The table's bytes when the change was first seen (a structure change; not for a pre-key snapshot). */
  bytes?: string
  /**
   * Task 733 / 034: the snapshot of a table command's keydown, whose cells record their `align`. A
   * trusted key records nothing (review A1: no added work on typed keys).
   */
  aligned?: boolean
  readonly rows: Array<{
    readonly tr: HTMLElement
    readonly section: string
    readonly cells: Array<{
      unit: U
      el: HTMLElement
      was: string | undefined | null
      /** Task 733 / 034: the cell's `align` (null when absent); recorded only in an `aligned` snapshot. */
      align?: string | null
    }>
  }>
}

export interface UnitCaptureDeps {
  model(): TextModel<HTMLElement> | undefined
  root(): HTMLElement | undefined
  /** Hand every queued observer record to the model and to `onBatch`. */
  drain(): void
  /** The model is live in IR, trusted and not awaiting. */
  ready(): boolean
  /** The unit engine may hold the history (false while the model is off for a permanent reason). */
  claimable(): boolean
  /** The inner Vditor editor, for the render steps of a restored block; undefined without one. */
  vditor(): unknown
  /** Task 733 / 013: the mode the model serves; absent means 'ir'. Selects the spin of a restored ECharts block. */
  mode?(): UnitMode
  /** Task 733 / 036 (F8): a sliced restore stops before its next slice when true (host update, abandon). */
  sliceAborted?(): boolean
  /** Task 733 / 036 (F8): the frame a slice runs in (the session's animation frames); absent: the window's. */
  requestFrame?(callback: () => void): void
}

export interface UnitCapture {
  readonly port: HistoryModelPort
  /** Called by the observer for each batch, before the session merges it. */
  onBatch(changed: ReadonlySet<U>, structure: ReadonlySet<'root' | U>): void
  /** Watches the keys that start a change (see `preTables`) and the clicks below the last block; returns the uninstall. */
  watch(root: HTMLElement): () => void
  /** The model is rebuilt over the same DOM: keep what is pending as one step of the next capture. */
  hold(): void
  /** The DOM or the text behind the pending state is gone: no capture made so far can be restored. */
  invalidate(): void
}

const openTag = (el: Element, align?: string | null): string => {
  const shell = el.cloneNode(false) as Element
  // Task 733 / 034: a cell of an `aligned` table snapshot gets the `align` it had at the snapshot.
  if (align === null) shell.removeAttribute('align')
  else if (align !== undefined) shell.setAttribute('align', align)
  const html = shell.outerHTML
  return html.slice(0, html.length - `</${shell.localName}>`.length)
}

// Task 733 / 020 (Q-172): `flattenSourceHtml` strips the wrap hints and, in a WYSIWYG code source, the
// hljs token spans (view state); it returns other HTML unchanged.
const normalized = (el: HTMLElement, kind: 'cell' | 'outer'): string =>
  flattenSourceHtml(kind === 'cell' ? el.innerHTML : el.outerHTML)

const parse = (html: string): Node[] => {
  const template = document.createElement('template')
  template.innerHTML = html
  return Array.from(template.content.childNodes)
}

const keyOf = (nodes: ArrayLike<Node>): string => {
  let key = ''
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    // Text joins its neighbours with no separator and a wrap-hint span or a caret marker adds
    // nothing, so a Text node split by a hint written after the capture keys the same as the
    // unsplit node its HTML parses back to (Task 733 / 012-2); an empty Text node (Vditor's
    // `fixTable` leaves one after its `range.insertNode(br)` on Enter in a cell) adds nothing
    // either. Every other element keeps its place, even when its projection is empty: a block whose
    // source projects to nothing still counts, or a wrap around it would read as no change.
    if (node.nodeType === Node.TEXT_NODE) {
      key += (node as Text).data
      continue
    }
    // A caret marker: Vditor's `<wbr>` or the unit engine's `span.vditor-wbr`.
    if (
      isHintSpan(node) ||
      (node as Element).localName === 'wbr' ||
      (node as Element).classList?.contains('vditor-wbr')
    )
      continue
    key += `\u0007${historySourceProjection(node)}\u0007`
  }
  return key
}

/**
 * A top-level paragraph with no text (Vditor's empty `<p>`, a caret placeholder) has no Markdown
 * bytes. Vditor appends one when a click lands below the last block; that one must not become an
 * Undo step of its own. Any other empty paragraph (an Enter, a Backspace) stays a step.
 */
const isEmptyParagraph = (node: Node): boolean => {
  if (!(node instanceof HTMLElement) || node.localName !== 'p') return false
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child as Text).data.replace(/[\n\u200b]/g, '') !== '') return false
    } else if (
      !(child instanceof HTMLElement) ||
      (child.localName !== 'br' && child.localName !== 'wbr')
    ) {
      return false
    }
  }
  return true
}

/**
 * The source key of a window side for the no-change test. `atEnd`: the window ends at the last root
 * child and a paragraph a click appended below the last block is or was there, so the empty
 * paragraphs at its end are that one.
 */
const changeKeyOf = (html: string, atEnd: boolean): string => {
  const nodes = parse(html)
  let end = nodes.length
  while (atEnd && end > 0 && isEmptyParagraph(nodes[end - 1])) end -= 1
  return keyOf(end === nodes.length ? nodes : nodes.slice(0, end))
}

const TABLE_ROWS = ':scope > thead > tr, :scope > tbody > tr'

/**
 * Task 733 / 029 (F-5): the rows of `table` in `TABLE_ROWS` order without a query, or undefined when the
 * table's element children are not only `caption`, `colgroup`, one `thead` and `tbody`s after it (then
 * `table.rows` and `TABLE_ROWS` differ: a `tfoot`, a direct `tr`, a second `thead`, or a `tbody` before
 * the `thead`, since `rows` lists `thead` rows first while `TABLE_ROWS` returns tree order). The check
 * walks the table's children only, so the cell window of a long table costs no whole-table query.
 */
function plainRows(
  table: Element,
): HTMLCollectionOf<HTMLTableRowElement> | undefined {
  if (table.localName !== 'table') return undefined
  let head = false
  let body = false
  for (let el = table.firstElementChild; el; el = el.nextElementSibling) {
    const name = el.localName
    if (name === 'thead') {
      if (head || body) return undefined
      head = true
    } else if (name === 'tbody') body = true
    else if (name !== 'caption' && name !== 'colgroup') return undefined
  }
  return (table as HTMLTableElement).rows
}

/** The index of `tr` in the `TABLE_ROWS` order of `table`: `rowIndex` for a plain table, else the query. */
function rowIndexOf(table: Element, tr: Element): number {
  const section = tr.parentElement
  if (
    plainRows(table) &&
    section?.parentElement === table &&
    (section.localName === 'thead' || section.localName === 'tbody')
  )
    return (tr as HTMLTableRowElement).rowIndex
  return Array.from(table.querySelectorAll(TABLE_ROWS)).indexOf(tr)
}

// Task 733 / 013: a restored fragment holds the DOM of one mode, so the previews of both modes match.
const PREVIEW_PENDING =
  ".vditor-ir__preview[data-render='1'], .vditor-wysiwyg__preview[data-render='1']"
const PREVIEW_FRESH =
  ".vditor-ir__preview[data-render='2'], .vditor-wysiwyg__preview[data-render='2']"

/**
 * Puts a pending preview of a restored fragment back to the state the renderers start from (Vditor's
 * `addCaret` does this on its snapshot clone, and patch 5 adds the diagram engines): a rendered
 * ECharts, PlantUML or mind map block is a container of a dead instance, a math preview shows its
 * rendered form, and a diagram that had not rendered yet keeps no cache-reserve attributes. The source
 * is copied from the editable marker before the preview, which is part of the same restored window.
 */
function resetPreview(item: HTMLElement): void {
  const first = item.firstElementChild as HTMLElement | null
  if (!first) return
  const source = item.previousElementSibling?.firstElementChild
  if (
    first.matches('.language-echarts, .language-plantuml, .language-mindmap')
  ) {
    first.removeAttribute('_echarts_instance_')
    first.removeAttribute('data-processed')
    if (source) first.innerHTML = source.innerHTML
    item.setAttribute('data-render', '2')
  } else if (first.classList.contains('language-math')) {
    item.setAttribute('data-render', '2')
    first.textContent = first.getAttribute('data-math')
    first.removeAttribute('data-math')
  } else if (
    source &&
    first.matches('.language-mermaid, .language-abc, .language-flowchart') &&
    !item.querySelector('svg, .vmde-diagram-error') &&
    !first.hasAttribute('data-vmde-hoist-deferred')
  ) {
    first.removeAttribute('data-processed')
    first.removeAttribute('data-vmde-cache-reserve')
    first.removeAttribute('data-vmde-cache-hit')
    first.removeAttribute('data-vmde-render-key')
    first.textContent = source.textContent
    item.setAttribute('data-render', '2')
  }
}

/** Parses restore HTML in an inert template and resets its pending previews; nothing runs or loads. */
function parseRestored(html: string): Node[] {
  const nodes = parse(html)
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue
    if (node.matches(PREVIEW_PENDING)) resetPreview(node)
    for (const item of Array.from(node.querySelectorAll(PREVIEW_PENDING))) {
      resetPreview(item as HTMLElement)
    }
  }
  return nodes
}

/**
 * Re-spins an ECharts block with the live wrapped Lute (one block, no document call) and returns the
 * live element that now stands where `block` stood. The old element is detached by the replacement,
 * so the render step that follows must run on the returned one (Vditor's `renderDiff` queries the
 * live root in its second pass).
 */
function respinBlock(
  block: HTMLElement,
  lute: { SpinVditorIRDOM(html: string): string },
): HTMLElement {
  const template = document.createElement('template')
  template.innerHTML = lute.SpinVditorIRDOM(block.outerHTML)
  const next = template.content.firstElementChild as HTMLElement | null
  block.replaceWith(template.content)
  return next ?? block
}

/** Re-spins the ECharts blocks inside `el` (or `el` itself) and returns the live element for `el`. */
function respinEcharts(
  el: HTMLElement,
  lute: { SpinVditorIRDOM(html: string): string },
): HTMLElement {
  const blocks = new Set<HTMLElement>()
  for (const preview of Array.from(
    el.querySelectorAll('.vditor-ir__preview, .vditor-wysiwyg__preview'),
  )) {
    const block = preview.parentElement
    if (block?.querySelector('.language-echarts')) blocks.add(block)
  }
  let current = el
  for (const block of blocks) {
    const next = respinBlock(block, lute)
    if (block === el) current = next
  }
  return current
}

/** The render steps of Vditor's `renderDiff` for the inserted elements only: no second Lute document call. */
function renderRestored(
  vditor: unknown,
  inserted: readonly HTMLElement[],
  mode: UnitMode,
): void {
  const inner = vditor as { lute?: ModeLute } | undefined
  if (!inner) return
  const lute = inner.lute ? spinLuteOf(inner.lute, mode) : undefined
  try {
    const live = inserted.map((el) => (lute ? respinEcharts(el, lute) : el))
    for (const el of live) {
      const fresh = Array.from(el.querySelectorAll(PREVIEW_FRESH))
      if (el.matches(PREVIEW_FRESH)) fresh.push(el)
      for (const preview of fresh) {
        processCodeRender(preview as HTMLElement, inner as never)
      }
    }
  } catch (error) {
    reportError(error, 'unit-history restore render')
  }
}

/** Index of `el` among the non-view-only children of `root`. */
function rootIndexOf(el: Element): number {
  let index = 0
  for (
    let sibling = el.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  ) {
    if (!isViewOnlyChild(sibling as HTMLElement)) index += 1
  }
  return index
}

/** The number of non-view-only root children; a walk, no allocation. */
function countRootChildren(root: HTMLElement): number {
  let last = root.lastElementChild
  while (last && isViewOnlyChild(last as HTMLElement))
    last = last.previousElementSibling
  return last ? rootIndexOf(last) + 1 : 0
}

/** The top-level child of `root` that holds `el`. */
function topOf(root: HTMLElement, el: HTMLElement): HTMLElement | undefined {
  let current: HTMLElement | null = el
  while (current && current.parentElement !== root) {
    current = current.parentElement
  }
  return current ?? undefined
}

/**
 * The top-level elements a multi-member unit spans, in order. A source enclosure (an HTML `<details>`
 * pair around blocks) lists the items of a list inside it as members, so a member is not always a
 * child of the root; the root window and restore work on root children.
 */
function topsOf(
  root: HTMLElement,
  members: readonly HTMLElement[],
): HTMLElement[] {
  const tops: HTMLElement[] = []
  for (const member of members) {
    const top = formerTopOf(root, member)
    if (tops.at(-1) !== top) tops.push(top)
  }
  return tops
}

/**
 * `topOf` that also works for an element a structure change has just removed: the removed root child
 * is the top of its own detached subtree.
 */
function formerTopOf(root: HTMLElement, el: HTMLElement): HTMLElement {
  let current = el
  while (current.parentElement && current.parentElement !== root) {
    current = current.parentElement
  }
  return current
}

/**
 * The HTML a multi-member unit had at its last proof, as root children: `pieces` holds one normalized
 * HTML per member (the model's `html`, joined by NUL). A member inside a top-level list stands for an
 * item of that list; the list is rebuilt from its open tag and its items, and only when every item of
 * the list is a member. Undefined when the members cannot be described.
 */
function topsThen(
  root: HTMLElement,
  members: readonly HTMLElement[],
  html: string | undefined,
): string | undefined {
  const pieces = html?.split('\u0000')
  if (!pieces || pieces.length !== members.length) return undefined
  let out = ''
  let list: HTMLElement | undefined
  let items = ''
  let count = 0
  const closeList = (): boolean => {
    if (!list) return true
    if (count !== list.children.length) return false
    out += `${openTag(list)}${items}</${list.localName}>`
    list = undefined
    items = ''
    count = 0
    return true
  }
  for (let i = 0; i < members.length; i += 1) {
    const member = members[i]
    const top = formerTopOf(root, member)
    if (top === member) {
      if (!closeList()) return undefined
      out += pieces[i]
      continue
    }
    if (member.parentElement !== top) return undefined
    if (list !== top && !closeList()) return undefined
    list = top
    items += pieces[i]
    count += 1
  }
  return closeList() ? out : undefined
}

/** The non-view-only children of `root` from `index`, `count` of them (all when `count` is omitted). */
function elementsFrom(
  root: HTMLElement,
  index: number,
  count?: number,
): HTMLElement[] {
  const out: HTMLElement[] = []
  let seen = 0
  for (const child of Array.from(root.children) as HTMLElement[]) {
    if (isViewOnlyChild(child)) continue
    if (seen >= index && (count === undefined || out.length < count)) {
      out.push(child)
    }
    seen += 1
    if (count !== undefined && out.length === count) break
  }
  return out
}

/**
 * Task 733 / 021 (D-3a, D-3c): a footnote definition lives in its footnotes block as an item lives in
 * its list, so the capture treats both kinds as items of a top-level container.
 */
const isItemKind = (kind: U['kind']): boolean =>
  kind === 'list-item' || kind === 'footnote'
const isFootnotesBlock = (el: Element): boolean =>
  el.getAttribute('data-type') === 'footnotes-block'

/** True when every child node of `list` is an `li` element (no text, no other element). */
function onlyItems(list: HTMLElement): boolean {
  if (list.childNodes.length !== list.children.length) return false
  for (let k = 0; k < list.children.length; k += 1)
    if (list.children[k].localName !== 'li') return false
  return true
}

/**
 * The one bullet list `html` restores in place of the bullet list `list`, with the same shell and only
 * items in both; undefined for any other shape. A bullet list only: the model renumbers ordered items
 * it sees by identity, while a restore must give back the numbers the document had (`1.` on every
 * item), which the whole-list path keeps.
 */
function restoredList(
  list: HTMLElement,
  html: string,
): HTMLElement | undefined {
  if (list.localName !== 'ul' || !onlyItems(list)) return undefined
  const nodes = parseRestored(html)
  const next = nodes.length === 1 ? nodes[0] : undefined
  return next instanceof HTMLElement &&
    next.localName === 'ul' &&
    openTag(next) === openTag(list) &&
    onlyItems(next)
    ? next
    : undefined
}

/** The items equal (same normalized HTML) at both ends of two item runs: the run between differs. */
function sameEnds(
  live: HTMLCollection,
  restored: HTMLCollection,
): { start: number; liveEnd: number; restoredEnd: number } {
  const sameAt = (a: number, b: number): boolean =>
    normalized(live[a] as HTMLElement, 'outer') ===
    normalized(restored[b] as HTMLElement, 'outer')
  let start = 0
  while (start < live.length && start < restored.length && sameAt(start, start))
    start += 1
  let liveEnd = live.length
  let restoredEnd = restored.length
  while (
    liveEnd > start &&
    restoredEnd > start &&
    sameAt(liveEnd - 1, restoredEnd - 1)
  ) {
    liveEnd -= 1
    restoredEnd -= 1
  }
  return { start, liveEnd, restoredEnd }
}

export function createUnitCapture(deps: UnitCaptureDeps): UnitCapture {
  let generation = 0
  /** The HTML each element had at the previous capture (the "then" of the next change). */
  let known = new WeakMap<HTMLElement, string>()
  /** Leaf units dirtied since the last capture, with the HTML they had before (undefined: unproven). */
  const leaves = new Map<U, string | undefined>()
  /** The top-level units as they were when a root or list structure change was first seen. */
  let rootSnap: SnapUnit[] | undefined
  /** The model text when `rootSnap` was taken (a string reference; a sync replaces the model's, not this). */
  let rootText = ''
  /** The canon and bytes of each dirtied leaf unit, read before any sync. */
  const leafForms = new Map<U, Form>()
  /**
   * 036 core C4 (restore fix R1.1): each table changed in this interval, its exact bytes at its first cell
   * or structure notice, read before any sync; null when its bytes were stale then (no usable bytes).
   */
  const tableBase = new Map<U, Form | null>()
  /**
   * 036 core C4 (restore fix, review change): a table with a cell checkpointed or noticed before a sync,
   * with the model text (a reference) of that moment; until a sync replaces the text, its bytes are stale
   * on every snapshot route.
   */
  const staleTables = new Map<U, string>()
  /** The bytes of the elements a restore replaced, read before the write: the forms a Redo hands back. */
  const afterForms = new WeakMap<Window, Forms>()
  /** Lists whose items changed in place: the list element stays, so element identity cannot show it. */
  const changedLists = new Set<HTMLElement>()
  // Task 733 / 012-11: items a list restore left in place (`restoreListInPlace`); their bytes stand.
  const keptInPlace = new WeakSet<HTMLElement>()
  /** Tables whose rows or columns changed, as they were when the change was first seen. */
  const tableSnaps = new Map<U, TableSnap>()
  /**
   * Tables with a key about to change one of their cells, snapshotted cell by cell before the key. A
   * block spin replaces the whole table on every key after the browser typed into the old cell, and the
   * observer sees that cell only after it left the document, so the old element can no longer tell
   * what the cell held. Used to read `before`; it makes no window by itself.
   */
  const preTables = new Map<U, TableSnap>()
  /**
   * Task 733 / 034: the table a table command's keydown snapshotted with its cells' `align`. Vditor's
   * alignment writes attributes only, which marks no unit changed, so this alone can make a step.
   */
  let alignedTable: { unit: U; snap: TableSnap } | undefined
  /** Steps held across a rebuild of the model over the same DOM. */
  let held: Step[] = []
  /** A restore is writing: its own mutations are not a change to capture. */
  let restoring = false
  /**
   * The empty paragraphs Vditor's click handler appended below the last block (seen by `watch`). Kept
   * while connected and empty; usually none or one.
   */
  let clickParagraphs: HTMLElement[] = []
  /**
   * The model text at the last capture when the model had changes it had not synced (a rewrite closed by
   * a checkpoint before any delta): until the text changes, the HTML that capture remembered is ahead
   * of the text, and the text holds no bytes for it.
   */
  let behindText: string | undefined
  /**
   * A detached list that a rewrite replaced by a block whose items do not pair with the list's (a block
   * move puts another kind of block at its position): the HTML that block held at the capture. Its
   * items have no successors, so the list stands for this HTML as a whole.
   */
  let successors = new WeakMap<HTMLElement, string>()

  /** The table unit of the top-level element at block index `a`, or undefined. */
  function tableUnitAt(
    root: HTMLElement,
    model: TextModel<HTMLElement>,
    a: number,
  ): U | undefined {
    const top = elementsFrom(root, a, 1)[0]
    if (!top) return undefined
    const tableEl =
      top.localName === 'table' ? top : top.querySelector<HTMLElement>('table')
    const table = tableEl ? model.unitOf(tableEl) : undefined
    return table?.kind === 'table' ? table : undefined
  }

  /** 036 core C4 (restore fix, review change): the tables of a step's cell windows, marked stale. */
  function markStaleTables(
    root: HTMLElement | null,
    model: TextModel<HTMLElement>,
    text: string,
    stepWindows: readonly Window[],
  ): void {
    if (!root) return
    for (const window of stepWindows) {
      if (window.kind !== 'cell') continue
      const table = tableUnitAt(root, model, window.a)
      if (table) staleTables.set(table, text)
    }
  }

  /** The table's form from the model text now; null while a stale mark holds (no sync since). */
  const tableFormNow = (
    model: TextModel<HTMLElement>,
    table: U,
    bytes: () => string,
  ): Form | null => {
    const marked = staleTables.get(table)
    if (marked === model.text) return null
    if (marked !== undefined) staleTables.delete(table)
    return { kind: 'table', bytes: bytes() }
  }

  /**
   * 036 core C4 (restore fix R1.1 and review change): at a cell's first notice, its table's bytes before
   * any sync; a stale cell form marks the table stale until a sync replaces the model text.
   */
  const seedTableBase = (
    model: TextModel<HTMLElement>,
    cell: U,
    stale: boolean,
  ): void => {
    const tableEl = cell.el?.closest('table') as HTMLElement | null
    const owner = tableEl ? model.unitOf(tableEl) : undefined
    if (owner?.kind !== 'table') return
    if (stale) staleTables.set(owner, model.text)
    if (tableBase.has(owner)) return
    tableBase.set(
      owner,
      tableFormNow(model, owner, () =>
        bytesOf(
          owner.proof === 'proven' ? owner.canon : undefined,
          owner.forms,
          model.text,
          owner.start,
          owner.end,
        ),
      ),
    )
  }

  /** 036 core C4 (restore fix): the form read before any sync for a unit of the root snapshot. */
  const earlierOf = (unit: U): Form | null | undefined => {
    if (leaves.has(unit)) return leafForms.get(unit) ?? null
    if (tableBase.has(unit)) return tableBase.get(unit) ?? null
    return undefined
  }

  const hasPending = (): boolean =>
    leaves.size > 0 ||
    rootSnap !== undefined ||
    tableSnaps.size > 0 ||
    (alignedTable !== undefined && alignChanged(alignedTable.snap))

  const clearPending = (): void => {
    leaves.clear()
    leafForms.clear()
    tableBase.clear()
    rootSnap = undefined
    changedLists.clear()
    tableSnaps.clear()
    preTables.clear()
    alignedTable = undefined
  }

  /**
   * The HTML of a multi-member unit before its change, as root children: what the previous capture
   * remembered of each top-level element, else the model's last proof.
   */
  function multiThen(unit: U): string | undefined {
    const root = deps.root()
    if (!root) return undefined
    const tops = topsOf(root, unit.members)
    let remembered = ''
    for (const top of tops) {
      const html = known.get(top)
      if (html === undefined) return topsThen(root, unit.members, unit.html)
      remembered += html
    }
    return tops.length > 0 ? remembered : undefined
  }

  /**
   * The HTML of a unit before this interval: a string when known, undefined when the unit is dirty and
   * the model never proved it, null when the unit is clean (reading its elements later gives the same).
   */
  function snapThen(unit: U): string | undefined | null {
    if (leaves.has(unit)) return leaves.get(unit)
    if (unit.members.length > 1 && unit.kind !== 'row') {
      return unit.html === undefined ? null : multiThen(unit)
    }
    const el = unit.el
    const remembered = el ? known.get(el) : undefined
    if (remembered !== undefined) return remembered
    return unit.html?.replaceAll('\u0000', '') ?? null
  }

  /**
   * Everything `before` needs of the top-level units, copied now. A sync replaces `model.units` and
   * rebinds surviving units to the live elements in place, so a reference kept until `capture()` would
   * describe the state after the change.
   */
  function snapRoot(model: TextModel<HTMLElement>): SnapUnit[] {
    const behind = behindText !== undefined && model.text === behindText
    rootText = model.text
    const root = deps.root()
    const lists = listsOf(model.units)
    const snapshot = model.units.map((unit, at) => {
      const was = unit.kind === 'table' ? null : snapThen(unit)
      return {
        unit,
        kind: unit.kind,
        members:
          unit.members.length > 1 && unit.kind !== 'row' && root
            ? topsOf(root, unit.members)
            : unit.members.slice(),
        list: lists[at],
        was,
        canon: unit.proof === 'proven' ? unit.canon : undefined,
        start: unit.start,
        end: unit.end,
        forms: unit.forms,
        ahead:
          behind &&
          typeof was === 'string' &&
          was !== unit.html?.replaceAll('\u0000', ''),
        earlier: earlierOf(unit),
      }
    })
    snapTablesWithEditedCells(snapshot)
    return snapshot
  }

  /**
   * A cell typed into before its table is replaced as a whole (a block spin replaces the table on every
   * key) was changed in place in the old element: reading the old table later would show the edit.
   * Such a table is snapshotted cell by cell, with each cell's HTML from before the edit.
   */
  function snapTablesWithEditedCells(snapshot: readonly SnapUnit[]): void {
    for (const unit of leaves.keys()) {
      if (unit.kind !== 'cell') continue
      const table = unit.el?.closest('table')
      const owner = table
        ? snapshot.find((su) => su.kind === 'table' && su.members[0] === table)
        : undefined
      if (owner && !tableSnaps.has(owner.unit)) {
        tableSnaps.set(owner.unit, snapTable(owner.unit))
      }
    }
  }

  /**
   * The list of each item unit. A removed item has no parent: it sat in the list of the item before
   * it, or, for the first item of a list, of the item after it.
   */
  function listsOf(units: readonly U[]): Array<HTMLElement | undefined> {
    const lists: Array<HTMLElement | undefined> = units.map((unit) =>
      isItemKind(unit.kind) ? (unit.el?.parentElement ?? undefined) : undefined,
    )
    carryLists(units, lists, 1)
    carryLists(units, lists, -1)
    return lists
  }

  /**
   * Gives each removed item the container of its nearest item in `step` direction; the carry holds
   * only between items of the same kind (a list's items, a footnotes block's definitions).
   */
  function carryLists(
    units: readonly U[],
    lists: Array<HTMLElement | undefined>,
    step: 1 | -1,
  ): void {
    let carried: HTMLElement | undefined
    const first = step === 1 ? 0 : units.length - 1
    for (let at = first; at >= 0 && at < units.length; at += step) {
      if (!continuesRun(units, at, step)) carried = undefined
      if (lists[at]) carried = lists[at]
      else if (isItemKind(units[at].kind)) lists[at] = carried
    }
  }

  /** The unit at `at` is an item of the same kind as the one before it in `step` direction. */
  function continuesRun(
    units: readonly U[],
    at: number,
    step: 1 | -1,
  ): boolean {
    const kind = units[at].kind
    return isItemKind(kind) && units[at - step]?.kind === kind
  }

  function snapTable(
    unit: U,
    typed?: { el: HTMLElement; html: string },
    aligned = false,
  ): TableSnap {
    const rows: TableSnap['rows'] = []
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one pass over rows that records their section and each cell's HTML
    unit.children.forEach((row, rowIndex) => {
      const tr = row.children[0]?.el?.parentElement
      if (!tr) return
      const cells: TableSnap['rows'][number]['cells'] = []
      for (const cell of row.children) {
        if (cell.el) {
          const was = snapThen(cell)
          // The cell about to be typed into: its HTML now is its HTML before the key.
          cells.push({
            unit: cell,
            el: cell.el,
            was: was === null && typed?.el === cell.el ? typed.html : was,
            align: aligned ? cell.el.getAttribute('align') : undefined,
          })
        }
      }
      rows.push({
        tr,
        section:
          tr.parentElement?.localName ?? (rowIndex === 0 ? 'thead' : 'tbody'),
        cells,
      })
    })
    return aligned
      ? { block: unit.members[0], rows, aligned }
      : { block: unit.members[0], rows }
  }

  /** Task 733 / 034: a cell of an `aligned` snapshot whose `align` changed since. O(table), table commands only. */
  function alignChanged(snap: TableSnap): boolean {
    if (!snap.aligned) return false
    for (const row of snap.rows)
      for (const cell of row.cells)
        if (cell.el.getAttribute('align') !== cell.align) return true
    return false
  }

  /** The table's outer HTML as the snapshot recorded it, or undefined when a cell was never proven. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: groups rows into sections and gives up on an unproven cell
  function composeTable(snap: TableSnap): string | undefined {
    const { block } = snap
    let html = ''
    let section: string | undefined
    for (const row of snap.rows) {
      if (row.section !== section) {
        if (section) html += `</${section}>`
        const live = block.querySelector(`:scope > ${row.section}`)
        html += live ? openTag(live) : `<${row.section}>`
        section = row.section
      }
      html += openTag(row.tr)
      for (const cell of row.cells) {
        // A clean unit that was edited later in the interval has its earlier HTML in `leaves`.
        const then =
          cell.was !== null
            ? cell.was
            : leaves.has(cell.unit)
              ? leaves.get(cell.unit)
              : normalized(cell.el, 'cell')
        if (then === undefined) return undefined
        html += `${openTag(cell.el, snap.aligned ? cell.align : undefined)}${then}</${cell.el.localName}>`
      }
      html += '</tr>'
    }
    if (section) html += `</${section}>`
    return `${openTag(block)}${html}</${block.localName}>`
  }

  /** The bytes of a unit: the exact-action form of its canon when it has one, else its slice of the text. */
  function bytesOf(
    canon: string | undefined,
    forms: ReadonlyArray<{ canon: string; bytes: string }>,
    text: string,
    start: number,
    end: number,
  ): string {
    return (
      (canon === undefined
        ? undefined
        : forms.find((f) => f.canon === canon)?.bytes) ?? text.slice(start, end)
    )
  }

  /** One entry per old top-level element: the element and the snapshot units that described it. */
  interface Entry {
    readonly el: HTMLElement
    readonly items: SnapUnit[]
  }

  /** The bytes of the units an entry stood for; a multi-member block has none. */
  function entryForms(entry: Entry): Form | readonly Form[] | undefined {
    const first = entry.items[0]
    // 036 core C4 (restore fix): the form before the interval's first change when one was read.
    const formOf = (su: SnapUnit): Form =>
      su.earlier ?? {
        kind: su.kind,
        bytes: bytesOf(su.canon, su.forms, rootText, su.start, su.end),
      }
    // The model's text holds no bytes for a state it never synced: the model reads them from the DOM.
    if (
      entry.items.some((su) => su.ahead || su.earlier === null) ||
      successors.has(entry.el)
    )
      return undefined
    if (isItemKind(first.kind)) return entry.items.map(formOf)
    return first.members.length === 1 ? formOf(first) : undefined
  }

  function entriesOf(snap: readonly SnapUnit[]): Entry[] | undefined {
    const entries: Entry[] = []
    for (const su of snap) {
      const el = isItemKind(su.kind) ? su.list : su.members[0]
      if (!el) return undefined
      const last = entries.at(-1)
      if (isItemKind(su.kind) && last?.el === el) last.items.push(su)
      else entries.push({ el, items: [su] })
    }
    return entries
  }

  function thenOfSnap(su: SnapUnit): string | undefined {
    if (su.kind === 'table') {
      const table = tableSnaps.get(su.unit) ?? preTables.get(su.unit)
      // A table that was not changed in place was replaced as a whole: its old element is intact.
      return table
        ? composeTable(table)
        : su.members.map((m) => normalized(m, 'outer')).join('')
    }
    if (su.was !== null) return su.was
    // A clean unit that was edited later in the interval has its earlier HTML in `leaves`.
    if (leaves.has(su.unit)) return leaves.get(su.unit)
    return su.members.map((m) => normalized(m, 'outer')).join('')
  }

  /** A list as it was: its shell and the HTML of each item that lived in it. */
  function thenOfEntry(entry: Entry): string | undefined {
    if (!isItemKind(entry.items[0].kind)) return thenOfSnap(entry.items[0])
    const succeeded = successors.get(entry.el)
    if (succeeded !== undefined) return succeeded
    let html = openTag(entry.el)
    for (const item of entry.items) {
      const then = thenOfSnap(item)
      if (then === undefined) return undefined
      html += then
    }
    return `${html}</${entry.el.localName}>`
  }

  /**
   * A rewrite replaced `old` (now detached) by `live` at the same root position. Until the model syncs, its units still
   * name `old` (an exact post is unanswered, so no delta synced the rewrite): the next interval's
   * `before` of that unit is what `live` holds at this capture. A list maps its items the same way when
   * the item count is the same.
   */
  function succeed(old: HTMLElement, live: HTMLElement): void {
    // An element still in the document keeps its own HTML (a wrap shifts live blocks by position).
    if (old === live || old.isConnected) return
    const html = normalized(live, 'outer')
    known.set(old, html)
    const isList = (el: HTMLElement): boolean =>
      el.localName === 'ul' || el.localName === 'ol'
    if (!isList(old)) return
    if (
      old.localName !== live.localName ||
      old.children.length !== live.children.length
    ) {
      successors.set(old, html)
      return
    }
    successors.delete(old)
    for (let i = 0; i < old.children.length; i += 1) {
      known.set(
        old.children[i] as HTMLElement,
        normalized(live.children[i] as HTMLElement, 'outer'),
      )
    }
  }

  /** Live top-level elements (a multi-member unit holds several). */
  function liveTop(root: HTMLElement): HTMLElement[] {
    return elementsFrom(root, 0)
  }

  /** The window between the old and the live top-level elements, by element identity. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: prefix scan, suffix scan and widening over multi-member units, one pass each
  function rootWindow(
    root: HTMLElement,
    old: readonly SnapUnit[],
  ): Window | 'none' | undefined {
    const entries = entriesOf(old)
    if (!entries) return undefined
    // Flatten to elements: a multi-member unit contributes every member.
    const flat: Array<{ el: HTMLElement; entry: Entry }> = []
    for (const entry of entries) {
      if (isItemKind(entry.items[0].kind)) {
        flat.push({ el: entry.el, entry })
      } else {
        for (const member of entry.items[0].members)
          flat.push({ el: member, entry })
      }
    }
    const live = liveTop(root)
    // A list with a structure notice is part of the window even when its element is the same one.
    // Task 733 / 021: a footnotes block sends no item-scoped notice; its definitions are compared.
    const same = (i: number, j: number): boolean =>
      flat[i].el === live[j] &&
      !changedLists.has(flat[i].el) &&
      sameFootnotes(flat[i].entry)
    let start = 0
    while (start < flat.length && start < live.length && same(start, start)) {
      start += 1
    }
    let oldEnd = flat.length
    let liveEnd = live.length
    while (oldEnd > start && liveEnd > start && same(oldEnd - 1, liveEnd - 1)) {
      oldEnd -= 1
      liveEnd -= 1
    }
    // An action that rebuilds the whole root (Turn Into, Find and Replace, a block move) replaces every
    // element, so identity alone makes the whole document one window. Blocks whose source did not change
    // are left out: restoring them would hand them to the model again, which writes Lute's bytes for any
    // block it cannot prove, and the window would cost the size of the document.
    const unchanged = (i: number, j: number): boolean => {
      const entry = flat[i].entry
      const first = entry.items[0]
      if (!isItemKind(first.kind) && first.members.length !== 1) return false
      const was = thenOfEntry(entry)
      if (was === undefined) return false
      const el = live[j]
      return (
        was === normalized(el, 'outer') || keyOf(parse(was)) === keyOf([el])
      )
    }
    while (start < oldEnd && start < liveEnd && unchanged(start, start)) {
      start += 1
    }
    while (
      oldEnd > start &&
      liveEnd > start &&
      unchanged(oldEnd - 1, liveEnd - 1)
    ) {
      oldEnd -= 1
      liveEnd -= 1
    }
    if (start === oldEnd && start === liveEnd) return 'none'
    // A unit is restored whole: widen over members of a multi-member block that straddle the edge.
    while (start > 0 && flat[start - 1].entry === flat[start]?.entry) start -= 1
    while (
      oldEnd < flat.length &&
      flat[oldEnd - 1]?.entry === flat[oldEnd].entry
    ) {
      oldEnd += 1
      liveEnd += 1
    }
    const seen = new Set<Entry>()
    const forms: Array<Form | readonly Form[] | undefined> = []
    let before: string | undefined = ''
    const beforeParts: string[] = []
    for (let i = start; i < oldEnd && before !== undefined; i += 1) {
      const { entry } = flat[i]
      if (seen.has(entry)) continue
      seen.add(entry)
      const part = thenOfEntry(entry)
      before = part === undefined ? undefined : before + part
      if (part !== undefined) beforeParts.push(part)
    }
    for (let i = start; i < oldEnd; i += 1) {
      forms.push(entryForms(flat[i].entry))
    }
    const afterParts = live
      .slice(start, liveEnd)
      .map((el) => normalized(el, 'outer'))
    const after = afterParts.join('')
    if (oldEnd - start === liveEnd - start) {
      for (let i = start; i < oldEnd; i += 1) succeed(flat[i].el, live[i])
    }
    return {
      kind: 'blocks',
      a: start,
      b: 0,
      c: 0,
      beforeCount: oldEnd - start,
      afterCount: liveEnd - start,
      before,
      after,
      forms,
      ...(before === undefined ? {} : { beforeParts, afterParts }),
    }
  }

  /** Windows for the leaf units that no blocks window already covers. */
  function leafWindow(
    root: HTMLElement,
    unit: U,
    covered: (index: number) => boolean,
  ): Window | undefined {
    const el = unit.el
    if (!el?.isConnected) return undefined
    const top = topOf(root, el)
    if (!top) return undefined
    const index = rootIndexOf(top)
    if (covered(index)) return undefined
    const then = leaves.get(unit)
    const own = leafForms.get(unit)
    const forms = own ? [own] : []
    if (unit.kind === 'cell') {
      const table = el.closest('table') as HTMLElement
      const tr = el.parentElement as HTMLElement
      return {
        kind: 'cell',
        a: index,
        b: rowIndexOf(table, tr),
        c: Array.prototype.indexOf.call(tr.children, el),
        beforeCount: 1,
        afterCount: 1,
        before: then,
        after: normalized(el, 'cell'),
        forms,
      }
    }
    if (isItemKind(unit.kind)) {
      return {
        kind: 'item',
        a: index,
        b: Array.prototype.indexOf.call(top.children, el),
        c: 0,
        beforeCount: 1,
        afterCount: 1,
        before: then,
        after: normalized(el, 'outer'),
        forms,
      }
    }
    return blockWindow(root, unit, top, index, then, forms)
  }

  /**
   * The window of a changed top-level block unit. A multi-member unit can list the items of a list as
   * members: the window holds root children, so the list stands for its items on both sides.
   */
  function blockWindow(
    root: HTMLElement,
    unit: U,
    top: HTMLElement,
    index: number,
    then: string | undefined,
    forms: Forms,
  ): Window {
    const multi = unit.members.length > 1
    const tops = multi ? topsOf(root, unit.members) : [top]
    const beforeCount =
      multi && then !== undefined
        ? parse(then).filter((node) => node.nodeType === Node.ELEMENT_NODE)
            .length
        : tops.length
    return {
      kind: 'blocks',
      a: index,
      b: 0,
      c: 0,
      beforeCount,
      afterCount: tops.length,
      before: then,
      after: tops.map((m) => normalized(m, 'outer')).join(''),
      forms,
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one branch per window kind (blocks, lists inside blocks, cell, item)
  function remember(root: HTMLElement, window: Window): void {
    const nodes =
      window.kind === 'blocks'
        ? elementsFrom(root, window.a, window.afterCount)
        : []
    for (const el of nodes) {
      known.set(el, normalized(el, 'outer'))
      if (el.localName === 'ul' || el.localName === 'ol') {
        for (const li of Array.from(el.children) as HTMLElement[]) {
          known.set(li, normalized(li, 'outer'))
        }
      }
    }
    if (window.kind === 'cell' || window.kind === 'item') {
      const top = elementsFrom(root, window.a, 1)[0]
      const target =
        window.kind === 'item'
          ? (top?.children[window.b] as HTMLElement | undefined)
          : top
            ? ((plainRows(top) ?? top.querySelectorAll(TABLE_ROWS))[window.b]
                ?.children[window.c] as HTMLElement | undefined)
            : undefined
      if (target) {
        known.set(
          target,
          normalized(target, window.kind === 'cell' ? 'cell' : 'outer'),
        )
      }
    }
  }

  /** Build the step for everything pending and clear it; undefined when nothing yields a window. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one stage per pending source (root units, tables, leaves) that builds the windows of a step
  function buildStep(): Step | undefined {
    const root = deps.root()
    if (!root) {
      clearPending()
      return undefined
    }
    const windows: Window[] = []
    const covered = (index: number): boolean =>
      windows.some(
        (w) =>
          w.kind === 'blocks' && index >= w.a && index < w.a + w.afterCount,
      )
    if (rootSnap) {
      const result = rootWindow(root, rootSnap)
      if (result === undefined) {
        // The old top level cannot be described: keep a window that no restore can verify.
        windows.push({
          kind: 'blocks',
          a: 0,
          b: 0,
          c: 0,
          beforeCount: 0,
          afterCount: 0,
          before: undefined,
          after: '',
        })
      } else if (result !== 'none') {
        windows.push(result)
      }
    }
    // Task 733 / 034: Vditor's alignment writes `align` on the column's cells only. A cell window holds the
    // cell's inner HTML, so both sides were equal and the alignment made no step; the next Undo then
    // failed its verification on the aligned table. A changed `align` gives the table its window.
    // The keydown snapshot is the earliest state; it keeps the bytes a structure notice read since.
    if (alignedTable && alignChanged(alignedTable.snap)) {
      const { unit, snap } = alignedTable
      snap.bytes ??= tableSnaps.get(unit)?.bytes
      tableSnaps.set(unit, snap)
    }
    for (const snap of tableSnaps.values()) {
      const table = snap.block
      if (!table?.isConnected) continue
      const index = rootIndexOf(table)
      if (covered(index)) continue
      const alignment = snap === alignedTable?.snap && alignChanged(snap)
      windows.push({
        ...(alignment ? { alignment } : {}),
        kind: 'blocks',
        a: index,
        b: 0,
        c: 0,
        beforeCount: 1,
        afterCount: 1,
        before: composeTable(snap),
        after: normalized(table, 'outer'),
        forms:
          snap.bytes === undefined
            ? undefined
            : [{ kind: 'table', bytes: snap.bytes }],
      })
    }
    for (const unit of leaves.keys()) {
      const window = leafWindow(root, unit, covered)
      if (window) windows.push(window)
    }
    clearPending()
    if (windows.length === 0) return undefined
    windows.sort((x, y) => x.a - y.a || x.b - y.b || x.c - y.c)
    for (const window of windows) remember(root, window)
    const model = deps.model()
    behindText = model?.hasDirty() ? model.text : undefined
    // 036 core C4 (restore fix, review change): a cell checkpointed before a sync leaves its table's
    // bytes in the model stale until the next sync, for every later snapshot route.
    if (behindText !== undefined && model)
      markStaleTables(root, model, behindText, windows)
    // A window whose two sides have the same source (view-only classes, caret markers, rendered
    // previews, an empty paragraph a click appended below the last block) is no change: it makes no
    // entry, and its Undo would be a visible no-op step.
    const clicked = clickParagraphAtEnd(root)
    let rootCount: number | undefined
    const changed = windows.filter((window) => {
      if (window.before === undefined || window.alignment) return true
      let atEnd = false
      if (clicked && window.kind === 'blocks') {
        rootCount ??= countRootChildren(root)
        atEnd = window.a + window.afterCount === rootCount
      }
      return (
        changeKeyOf(window.before, atEnd) !== changeKeyOf(window.after, atEnd)
      )
    })
    return changed.length > 0 ? { windows: changed } : undefined
  }

  /**
   * Whether a paragraph a click appended below the last block is the last root child now (still
   * empty) or was removed since the previous capture. Drops the marks that no longer apply.
   */
  function clickParagraphAtEnd(root: HTMLElement): boolean {
    if (clickParagraphs.length === 0) return false
    let last = root.lastElementChild
    while (last && isViewOnlyChild(last as HTMLElement))
      last = last.previousElementSibling
    let found = false
    for (const p of clickParagraphs) {
      if (!p.isConnected || (p === last && isEmptyParagraph(p))) found = true
    }
    clickParagraphs = clickParagraphs.filter(
      (p) => p.isConnected && isEmptyParagraph(p),
    )
    return found
  }

  /** Root index of a window in the coordinates of the state before the step's windows. */
  function beforeIndex(windows: readonly Window[], at: number): number {
    const window = windows[at]
    let shift = 0
    for (let i = 0; i < at; i += 1) {
      const earlier = windows[i]
      if (
        earlier.kind === 'blocks' &&
        earlier.a + earlier.afterCount <= window.a
      ) {
        shift += earlier.afterCount - earlier.beforeCount
      }
    }
    return window.a - shift
  }

  /**
   * Restores one list item. A proven item keeps its `li` and takes the restored attributes and content,
   * so the model sees an in-place change of its unit (the list is not re-serialized, and the unit can
   * take the bytes it had). An unproven unit cannot be synced in place (the model would fall back), so
   * its element is replaced.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: in-place or replace, with the attribute copy in both directions
  function replaceItem(li: HTMLElement, html: string): HTMLElement[] {
    const nodes = parseRestored(html)
    const next = nodes.length === 1 ? nodes[0] : undefined
    if (
      next instanceof HTMLElement &&
      next.localName === li.localName &&
      deps.model()?.unitOf(li)?.proof === 'proven'
    ) {
      for (const name of li.getAttributeNames()) {
        if (!next.hasAttribute(name)) li.removeAttribute(name)
      }
      for (const name of next.getAttributeNames()) {
        li.setAttribute(name, next.getAttribute(name) ?? '')
      }
      li.replaceChildren(...Array.from(next.childNodes))
      return [li]
    }
    const fragment = document.createDocumentFragment()
    for (const node of nodes) fragment.appendChild(node)
    const inserted = Array.from(fragment.children) as HTMLElement[]
    li.replaceWith(fragment)
    return inserted
  }

  /**
   * Task 733 / 012-11: a window that is one bullet list restored as one list of the same shell keeps the list
   * element and every item whose HTML is the same at both ends of the item run; only the items between
   * are replaced. The model then sees the changed items by element identity and serializes those items
   * alone, not the whole list. Returns the list, or undefined when the shape does not fit (the caller
   * replaces the whole element).
   */
  function restoreListInPlace(
    list: HTMLElement,
    html: string,
  ): HTMLElement[] | undefined {
    const next = restoredList(list, html)
    if (!next) return undefined
    const live = list.children
    const restored = next.children
    const { start, liveEnd, restoredEnd } = sameEnds(live, restored)
    for (let k = 0; k < live.length; k += 1)
      if (k < start || k >= liveEnd) keptInPlace.add(live[k] as HTMLElement)
    const reference = live[liveEnd] ?? null
    const added = Array.from(restored).slice(start, restoredEnd)
    for (let k = liveEnd - 1; k >= start; k -= 1) live[k].remove()
    for (const item of added) list.insertBefore(item, reference)
    return [list]
  }

  /** The nodes a window occupies now, or undefined when its anchor is gone. */
  function current(
    root: HTMLElement,
    window: Window,
    index: number,
    count: number,
  ):
    | { nodes: HTMLElement[]; replace(html: string): HTMLElement[] }
    | undefined {
    if (window.kind === 'blocks') {
      const nodes = elementsFrom(root, index, count)
      if (nodes.length !== count) return undefined
      return {
        nodes,
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one replace per window kind
        replace(html) {
          const inPlace =
            nodes.length === 1 ? restoreListInPlace(nodes[0], html) : undefined
          if (inPlace) return inPlace
          const fragment = document.createDocumentFragment()
          for (const node of parseRestored(html)) fragment.appendChild(node)
          const inserted = Array.from(fragment.children) as HTMLElement[]
          const after =
            nodes.length > 0 ? nodes[nodes.length - 1].nextSibling : null
          const reference =
            nodes.length > 0 ? after : (elementsFrom(root, index, 1)[0] ?? null)
          for (const node of nodes) node.remove()
          root.insertBefore(fragment, reference)
          return inserted
        },
      }
    }
    const top = elementsFrom(root, index, 1)[0]
    if (!top) return undefined
    if (window.kind === 'item') {
      const li = top.children[window.b] as HTMLElement | undefined
      if (!li) return undefined
      return {
        nodes: [li],
        replace: (html) => replaceItem(li, html),
      }
    }
    const row = (plainRows(top) ?? top.querySelectorAll(TABLE_ROWS))[window.b]
    const cell = row?.children[window.c] as HTMLElement | undefined
    if (!cell) return undefined
    return {
      nodes: [cell],
      replace(html) {
        cell.replaceChildren(...parseRestored(html))
        return [cell]
      },
    }
  }

  const keyOfCurrent = (window: Window, nodes: HTMLElement[]): string =>
    window.kind === 'cell' ? keyOf(nodes[0].childNodes) : keyOf(nodes)

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verify every window first, then write them in reverse order: two passes over the same plan
  function restoreStep(
    root: HTMLElement,
    step: Step,
    side: 'before' | 'after',
    inserted: HTMLElement[],
    forms?: Array<[Forms | undefined, HTMLElement[] | undefined]>,
    caret?: RestoredCaret,
  ): boolean {
    const { windows } = step
    const toBefore = side === 'before'
    // Task 733 / 034: the window that holds the caret endpoint: the first for Undo, the last for Redo.
    const caretAt = caret ? (toBefore ? 0 : windows.length - 1) : -1
    let caretText: string | undefined
    const plan: Array<{
      window: Window
      index: number
      count: number
      html: string
    }> = []
    for (let i = 0; i < windows.length; i += 1) {
      const window = windows[i]
      const html = toBefore ? window.before : window.after
      const from = toBefore ? window.after : window.before
      if (html === undefined || from === undefined) return false
      // Restoring `before` finds the DOM in the `after` state and the other way round.
      const index = toBefore ? window.a : beforeIndex(windows, i)
      const count = toBefore ? window.afterCount : window.beforeCount
      const found = current(root, window, index, count)
      if (!found) return false
      if (keyOfCurrent(window, found.nodes) !== keyOf(parse(from))) return false
      // Read before the write: a cell or a list restored in place keeps its element.
      if (i === caretAt) caretText = windowSourceText(found.nodes)
      // A Redo needs the bytes of what this restore is about to replace.
      if (toBefore && !afterForms.has(window)) {
        afterForms.set(window, currentForms(found.nodes))
      }
      plan.push({ window, index, count, html })
    }
    // The caller holds `restoring`: these writes reach the model at the drain after the last step.
    for (let i = plan.length - 1; i >= 0; i -= 1) {
      const { window, index, count, html } = plan[i]
      const written = current(root, window, index, count)?.replace(html)
      if (written) inserted.push(...written)
      if (caret && written && caretText !== undefined && i === caretAt) {
        caret.endpoint =
          windowChangeEndpoint(caretText, written, !toBefore) ?? caret.endpoint
      }
      forms?.push([toBefore ? window.forms : afterForms.get(window), written])
    }
    return true
  }

  /** The bytes the model holds for the elements now in the DOM; units that are not synced give none. */
  function currentForms(nodes: readonly HTMLElement[]): Forms {
    const model = deps.model()
    const formOf = (el: HTMLElement): Form | undefined => {
      const unit = model?.unitOf(el)
      if (!model || !unit || unit.dirty || unit.kind === 'row') return undefined
      if (unit.members.length !== 1) return undefined
      return { kind: unit.kind, bytes: model.text.slice(unit.start, unit.end) }
    }
    return nodes.map((node) => {
      if (
        node.localName !== 'ul' &&
        node.localName !== 'ol' &&
        !isFootnotesBlock(node)
      )
        return formOf(node)
      const items: Form[] = []
      for (const li of Array.from(node.children) as HTMLElement[]) {
        const form = formOf(li)
        if (!form) return undefined
        items.push(form)
      }
      return items
    })
  }

  /**
   * Task 733 / 021 (D-3a): one form hand-over. A throw (a Lute failure) is reported and the form is
   * skipped, so the restore finishes; the next sync serializes the element again and either syncs or
   * falls back with `sync-error`.
   */
  function rememberForm(
    model: TextModel<HTMLElement>,
    el: HTMLElement,
    kind: U['kind'],
    bytes: string,
  ): void {
    try {
      model.rememberElement(el, kind, bytes)
    } catch (error) {
      reportError(error, 'unit-history restore form')
    }
  }

  /**
   * Task 733 / 021: a footnotes entry is unchanged only when its block holds the same definitions, by
   * count and identity; any other entry passes.
   */
  function sameFootnotes(entry: Entry): boolean {
    const first = entry.items[0]
    if (first.kind !== 'footnote') return true
    const children = entry.el.children
    if (children.length !== entry.items.length) return false
    for (let k = 0; k < children.length; k += 1)
      if (children[k] !== entry.items[k].members[0]) return false
    return true
  }

  /**
   * Hands the model the bytes the restored units had, so that Undo and Redo write the original bytes
   * and not Lute's canon (a task item, for one, serializes with two spaces). The model finds the canon
   * of each restored element itself: a unit that already holds the element (a cell, an item restored in
   * place) takes the form at once, and a new element finds its bytes by canon when its unit is created.
   */
  function applyForms(
    forms: Forms | undefined,
    written: readonly HTMLElement[] | undefined,
  ): void {
    const model = deps.model()
    if (!model || !forms || !written) return
    forms.forEach((form, at) => {
      const el = written[at]
      if (!el || !form) return
      if (Array.isArray(form)) {
        const items = Array.from(el.children) as HTMLElement[]
        form.forEach((item, j) => {
          // An item a list restore kept in place (012-11) holds its bytes already: no item serialize.
          if (items[j] && !keptInPlace.has(items[j]))
            rememberForm(model, items[j], item.kind, item.bytes)
        })
      } else {
        const single = form as Form
        rememberForm(model, el, single.kind, single.bytes)
      }
    })
  }

  /** The restored elements are what the next change starts from. */
  function rememberAll(root: HTMLElement, steps: readonly Step[]): void {
    for (const step of steps) {
      for (const window of step.windows) remember(root, window)
    }
  }

  /**
   * Writes the steps in order. A step that no longer matches the DOM puts back the steps already
   * written, so a refused restore leaves the DOM as it found it (the port contract).
   */
  function restoreSteps(
    root: HTMLElement,
    order: readonly Step[],
    side: 'before' | 'after',
    caret?: RestoredCaret,
  ): boolean {
    const written: Step[] = []
    const inserted: HTMLElement[] = []
    const forms: Array<[Forms | undefined, HTMLElement[] | undefined]> = []
    restoring = true
    try {
      for (const step of order) {
        if (!restoreStep(root, step, side, inserted, forms, caret)) {
          if (caret) caret.endpoint = undefined
          putBack(root, written, side)
          return false
        }
        written.push(step)
      }
      // The bytes are handed over only when every step has been written.
      for (const [formSet, nodes] of forms) applyForms(formSet, nodes)
      renderRestored(deps.vditor(), inserted, deps.mode?.() ?? 'ir')
      deps.drain()
      return true
    } finally {
      restoring = false
    }
  }

  /** Writes the opposite side of the steps already written, newest first, and renders what it restores. */
  function putBack(
    root: HTMLElement,
    written: Step[],
    side: 'before' | 'after',
  ): void {
    const opposite = side === 'before' ? 'after' : 'before'
    const back: HTMLElement[] = []
    for (const done of written.reverse())
      restoreStep(root, done, opposite, back)
    renderRestored(deps.vditor(), back, deps.mode?.() ?? 'ir')
    deps.drain()
  }

  // Task 733 / 036 (F8): a slice is writing; a model batch arrived outside one.
  let slicing = false
  let sliceForeign = false

  /**
   * Task 733 / 036 (F8): the chunks of one side of a root window: top-level parts of at most
   * `SLICE_CHUNK_CHARS`; a larger table is its shell plus row chunks; any other larger leaf is one chunk.
   */
  function sliceChunks(parts: readonly string[]): SliceChunk[] {
    const chunks: SliceChunk[] = []
    let run = ''
    const flush = () => {
      if (run) chunks.push({ kind: 'blocks', html: run })
      run = ''
    }
    for (const part of parts) {
      if (part.length > SLICE_CHUNK_CHARS && part.startsWith('<table')) {
        const open = part.indexOf('<tbody>')
        const close = part.lastIndexOf('</tbody>')
        if (open >= 0 && close > open) {
          flush()
          const bodyStart = open + '<tbody>'.length
          chunks.push({
            kind: 'shell',
            html: part.slice(0, bodyStart) + part.slice(close),
            full: part,
          })
          splitRows(part.slice(bodyStart, close), chunks)
          chunks.push({ kind: 'table-end', html: '' })
          continue
        }
      }
      if (run.length + part.length > SLICE_CHUNK_CHARS) flush()
      run += part
    }
    flush()
    return chunks
  }

  /** Rows of a table body by their `<tr` boundaries (Lute writes no nested table in a cell). */
  function splitRows(body: string, chunks: SliceChunk[]): void {
    let from = 0
    let at = 0
    while (from < body.length) {
      let end = body.indexOf('</tr>', at)
      if (end < 0) end = body.length
      else end += '</tr>'.length
      if (end - from > SLICE_CHUNK_CHARS || end >= body.length) {
        const cut = end - from > SLICE_CHUNK_CHARS && at > from ? at : end
        chunks.push({ kind: 'rows', html: body.slice(from, cut) })
        from = cut
      }
      at = end
    }
  }

  /** Parses table rows in a table context (a bare `<tr>` is dropped by the HTML parser elsewhere). */
  function parseRows(html: string): HTMLElement[] {
    const template = document.createElement('template')
    template.innerHTML = `<table><tbody>${html}</tbody></table>`
    const body = template.content.querySelector('tbody')
    return body ? (Array.from(body.children) as HTMLElement[]) : []
  }

  /** Task 733 / 036 (F8): the window's elements are there, and its first and last still read as captured. */
  function sliceAnchored(
    old: HTMLElement[],
    count: number,
    check: readonly string[] | undefined,
  ): boolean {
    if (old.length !== count) return false
    if (!check || count === 0) return true
    return (
      normalized(old[0], 'outer') === check[0] &&
      normalized(old[count - 1], 'outer') === check[count - 1]
    )
  }

  /**
   * Task 733 / 036 (F8): the writer of one sliced window. New chunks go before the first old element still
   * there (or the window's original next sibling); old elements are removed in step with the chunks.
   * Restored elements are remembered from their parts, with no serialization.
   */
  function sliceWriter(
    root: HTMLElement,
    old: HTMLElement[],
    chunks: SliceChunk[],
    tail: Node | null,
  ) {
    let removed = 0
    let next = 0
    let table: { el: HTMLElement; body: HTMLElement; full: string } | undefined
    const share = Math.ceil(old.length / Math.max(1, chunks.length))
    const insert = (html: string): HTMLElement[] => {
      const fragment = document.createDocumentFragment()
      for (const node of parseRestored(html)) fragment.appendChild(node)
      const inserted = Array.from(fragment.children) as HTMLElement[]
      root.insertBefore(fragment, removed < old.length ? old[removed] : tail)
      return inserted
    }
    const shell = (chunk: SliceChunk & { kind: 'shell' }): void => {
      const el = insert(chunk.html)[0]
      const body = el?.querySelector('tbody')
      table =
        el && body
          ? { el, body: body as HTMLElement, full: chunk.full }
          : undefined
    }
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one branch per chunk kind (rows, table end, shell, blocks)
    const write = (chunk: SliceChunk): HTMLElement[] => {
      if (chunk.kind === 'rows') {
        for (const row of parseRows(chunk.html)) table?.body.appendChild(row)
        return []
      }
      if (chunk.kind === 'table-end') {
        if (table) known.set(table.el, table.full)
        table = undefined
        return []
      }
      if (chunk.kind === 'shell') {
        shell(chunk)
        return []
      }
      const inserted = insert(chunk.html)
      if (inserted.length === 1) known.set(inserted[0], chunk.html)
      else for (const el of inserted) known.set(el, normalized(el, 'outer'))
      return inserted
    }
    return {
      done: () => next >= chunks.length && removed >= old.length,
      /** One unit of work: some old elements out, one chunk in. */
      step(inserted: HTMLElement[]): void {
        for (let k = 0; k < share && removed < old.length; k += 1) {
          old[removed].remove()
          removed += 1
        }
        if (next < chunks.length) inserted.push(...write(chunks[next++]))
      },
    }
  }

  /**
   * Task 733 / 036 (F8): one root window written in chunks, one slice per animation frame within
   * `budgetMs`. A foreign change of the root between slices (a model observer batch outside a slice)
   * fails the restore and nothing more is written. The model takes the host bytes at the answer, so no
   * forms are handed over.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: anchor check, writer setup and the per-frame slice loop are one restore
  function sliceWindow(
    root: HTMLElement,
    window: Window,
    index: number,
    side: 'before' | 'after',
    budgetMs: number,
  ): Promise<boolean> | undefined {
    const toBefore = side === 'before'
    const whole = toBefore ? window.before : window.after
    // A window without parts (a table snapshot) is one part; a large table still splits into rows.
    const parts =
      (toBefore ? window.beforeParts : window.afterParts) ??
      (whole === undefined ? undefined : [whole])
    if (!parts) {
      slicedFailed('parts')
      return undefined
    }
    const count = toBefore ? window.afterCount : window.beforeCount
    const old = elementsFrom(root, index, count)
    if (!sliceAnchored(old, count, toBefore ? window.afterParts : undefined)) {
      slicedFailed('anchor')
      return Promise.resolve(false)
    }
    const tail =
      count > 0
        ? old[count - 1].nextSibling
        : (elementsFrom(root, index, 1)[0] ?? null)
    const writer = sliceWriter(root, old, sliceChunks(parts), tail)
    const view = root.ownerDocument.defaultView ?? globalThis
    const frame = (callback: () => void): void => {
      if (deps.requestFrame) deps.requestFrame(callback)
      else view.requestAnimationFrame(callback)
    }
    // A foreign change reaches the model's own observer as a batch outside a slice (`onBatch`).
    deps.drain()
    sliceForeign = false
    return new Promise<boolean>((resolve) => {
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one frame: the foreign-change gate, the budgeted writes and the hand-over
      const slice = () => {
        // The model's observer delivers any record queued since the last slice now.
        deps.drain()
        if (sliceForeign || deps.sliceAborted?.()) {
          slicedFailed(sliceForeign ? 'foreign' : 'aborted')
          resolve(false)
          return
        }
        const started = performance.now()
        const inserted: HTMLElement[] = []
        const stats = slicedRestoreStats()
        if (stats) stats.slices++
        restoring = true
        slicing = true
        try {
          do writer.step(inserted)
          while (!writer.done() && performance.now() - started < budgetMs / 2)
          renderRestored(deps.vditor(), inserted, deps.mode?.() ?? 'ir')
          // This slice's own records reach the model inside the slice, so they are not foreign.
          deps.drain()
        } finally {
          restoring = false
          slicing = false
        }
        if (writer.done()) resolve(true)
        else frame(slice)
      }
      frame(slice)
    })
  }

  /**
   * Task 733 / 036 (F8): today's step order (reverse for Undo), each root window sliced; a capture with any
   * other window shape takes the whole restore at once.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the shape gate, then each step sliced in order with its generation re-read
  async function restoreSliced(
    raw: HistoryCapture,
    side: 'before' | 'after',
    budgetMs = 8,
  ): Promise<boolean> {
    const capture = raw as unknown as Capture
    const root = deps.root()
    if (!root || capture.generation !== generation) {
      slicedFailed('generation')
      return false
    }
    const order =
      side === 'before' ? [...capture.steps].reverse() : capture.steps
    // Block windows only (a root rewrite, table snapshots); a cell, item or alignment window takes today's
    // restore at once.
    const sliceable = order.every((step) =>
      step.windows.every(
        (w) =>
          w.kind === 'blocks' &&
          !w.alignment &&
          w.before !== undefined &&
          w.after !== undefined,
      ),
    )
    const stats = slicedRestoreStats()
    if (!sliceable) {
      if (stats) stats.whole++
      return port.restore(raw, side)
    }
    if (stats) stats.sliced++
    for (const step of order) {
      // Highest window first, as `restoreStep` writes its plan, so the lower indices stay valid; for Redo
      // a window's index is its index in the `before` state.
      const at = step.windows.map((w, i) =>
        side === 'before' ? w.a : beforeIndex(step.windows, i),
      )
      const ordered = step.windows
        .map((w, i) => ({ w, index: at[i] }))
        .sort((x, y) => y.index - x.index)
      for (const { w, index } of ordered) {
        const done = sliceWindow(root, w, index, side, budgetMs)
        if (!done || !(await done)) return false
        if (capture.generation !== generation) {
          slicedFailed('generation')
          return false
        }
      }
    }
    return true
  }

  const port: HistoryModelPort = {
    restoreSliced,
    ready: () => deps.ready(),
    claimable: () => deps.claimable(),
    pending() {
      deps.drain()
      return hasPending() || held.length > 0
    },
    capture() {
      deps.drain()
      const step = hasPending() ? buildStep() : undefined
      if (!step && held.length === 0) return undefined
      const steps = step ? [...held, step] : held
      held = []
      return { generation, steps } as unknown as HistoryCapture
    },
    restore(raw, side, caret) {
      const capture = raw as unknown as Capture
      const root = deps.root()
      if (!root || capture.generation !== generation) return false
      const order =
        side === 'before' ? [...capture.steps].reverse() : capture.steps
      if (!restoreSteps(root, order, side, caret)) return false
      rememberAll(root, capture.steps)
      // A later step can replace the element an earlier step's endpoint was found in.
      if (caret?.endpoint && !caret.endpoint.node.isConnected)
        caret.endpoint = undefined
      return true
    },
  }

  /** The pre-key snapshot of the table of `cell` (see `preTables`). */
  function snapPreTable(unit: U, cell: HTMLElement, event: Event): void {
    // Task 733 / 034 (review A1): only a table command (an untrusted contained keydown,
    // `dispatchContainedKeydown`) records the cells' `align`, before Vditor writes it.
    const command = event.type === 'keydown' && !event.isTrusted
    const snap = snapTable(
      unit,
      { el: cell, html: normalized(cell, 'cell') },
      command,
    )
    preTables.set(unit, snap)
    if (command) alignedTable = { unit, snap }
  }

  /**
   * Snapshots the table under the caret before the first key of an interval changes one of its cells,
   * and marks the paragraph a click appends below the last block.
   */
  function watch(root: HTMLElement): () => void {
    const target: EventTarget = root.ownerDocument.defaultView ?? window
    const handler = (event: Event): void => {
      const model = deps.model()
      const anchor = root.ownerDocument.getSelection()?.anchorNode
      const el = anchor instanceof Element ? anchor : anchor?.parentElement
      const cell = el?.closest('td, th') as HTMLElement | null | undefined
      const table = cell?.closest('table')
      if (!model || !cell || !table || !root.contains(table)) return
      const unit = model.unitOf(table as HTMLElement)
      if (unit?.kind === 'table' && !preTables.has(unit))
        snapPreTable(unit, cell, event)
    }
    // Vditor's IR click handler (on the root) appends an empty paragraph when a click lands below
    // the last block. The last child before the click (capture phase) and after the root's handlers
    // (bubble phase on the window) tell that paragraph from one an Enter made.
    let lastBeforeClick: Element | null = null
    const beforeClick = (): void => {
      lastBeforeClick = root.lastElementChild
    }
    const afterClick = (): void => {
      const last = root.lastElementChild
      if (
        last !== lastBeforeClick &&
        last instanceof HTMLElement &&
        isEmptyParagraph(last)
      ) {
        clickParagraphs.push(last)
      }
      lastBeforeClick = null
    }
    target.addEventListener('keydown', handler, true)
    target.addEventListener('beforeinput', handler, true)
    target.addEventListener('click', beforeClick, true)
    target.addEventListener('click', afterClick)
    return () => {
      target.removeEventListener('keydown', handler, true)
      target.removeEventListener('beforeinput', handler, true)
      target.removeEventListener('click', beforeClick, true)
      target.removeEventListener('click', afterClick)
    }
  }

  return {
    port,
    watch,
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one branch per scope kind of the batch (root, list run, table) beside the leaf units
    onBatch(changed, structure) {
      // Task 733 / 036 (F8): a batch outside a slice while a sliced restore runs is a foreign change.
      if (!slicing) sliceForeign = true
      if (restoring) return
      const model = deps.model()
      if (!model) return
      for (const unit of changed) {
        if (!leaves.has(unit)) {
          const el = unit.el
          const remembered = el ? known.get(el) : undefined
          leaves.set(
            unit,
            unit.members.length > 1 && unit.kind !== 'row'
              ? multiThen(unit)
              : (remembered ?? unit.html?.replaceAll('\u0000', '')),
          )
          // 036 core C4 (restore fix R1.2): the remembered HTML is ahead of the model's text (an
          // unsynced checkpoint): no form is recorded; the restore reads the bytes from the page.
          const stale =
            remembered !== undefined &&
            behindText !== undefined &&
            model.text === behindText &&
            remembered !== unit.html?.replaceAll('\u0000', '')
          if (unit.kind === 'cell') seedTableBase(model, unit, stale)
          if (!stale && unit.kind !== 'row' && unit.members.length === 1) {
            leafForms.set(unit, {
              kind: unit.kind,
              bytes: bytesOf(
                unit.proof === 'proven' ? unit.canon : undefined,
                unit.forms,
                model.text,
                unit.start,
                unit.end,
              ),
            })
          }
        }
      }
      // Copied before the session merges the batch and before any sync can change the units.
      for (const scope of structure) {
        if (scope === 'root' || scope.kind === 'list-item') {
          rootSnap ??= snapRoot(model)
          if (scope !== 'root') {
            const list = rootSnap.find((su) => su.unit === scope)?.list
            if (list) changedLists.add(list)
          }
        } else if (scope.kind === 'table' && !tableSnaps.has(scope)) {
          const snap = snapTable(scope)
          // 036 core C4 (restore fix R1.1): the table's bytes at its first notice in this interval.
          if (!tableBase.has(scope))
            tableBase.set(
              scope,
              tableFormNow(model, scope, () =>
                model.text.slice(scope.start, scope.end),
              ),
            )
          snap.bytes = tableBase.get(scope)?.bytes
          tableSnaps.set(scope, snap)
        }
      }
    },
    hold() {
      const step = hasPending() ? buildStep() : undefined
      if (step) held.push(step)
    },
    invalidate() {
      generation += 1
      clearPending()
      staleTables.clear()
      held = []
      known = new WeakMap()
      successors = new WeakMap()
      behindText = undefined
      clickParagraphs = []
    },
  }
}
