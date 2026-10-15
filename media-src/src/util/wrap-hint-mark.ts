/**
 * Task 640 S2b — the one definition of a wrap hint and the one proof that a DOM write is ours.
 *
 * A wrap hint is an empty `<span class="vmde-wrap-hint" data-render="1"></span>` whose CSS adds a
 * zero-width break opportunity (`main.css`). It is view state, never source: the editor's observers,
 * its Undo comparison and snapshots, its incremental IR cache and the WYSIWYG Lute calls must all
 * treat it as absent (S1 probes 2 and 3). This module is the shared vocabulary for that:
 *
 *  - `createWrapHintSpan` and `expectOwnText` register what the hint engine wrote;
 *  - `isOwnHintRecord` / `withoutOwnHintRecords` let a MutationObserver consumer drop the records of
 *    those writes while every record of a real edit still passes;
 *  - `stripWrapHints` removes hint spans from an HTML string (Undo snapshots, IR block strings, and
 *    the HTML a WYSIWYG Lute call is about to read).
 *
 * The proof is a pair of weak registries, not a flag, so a real edit that touches a node the engine
 * created is not mistaken for a hint write: a span counts only if the engine created it, and a Text
 * node counts only while its data is still what the engine left (`expectOwnText`), including when
 * it is removed by the engine's own merge. A user edit of that text changes its data first.
 */

export const WRAP_HINT_CLASS = 'vmde-wrap-hint'

// Spans the engine created (their insert is ours) and spans the engine removed (their removal is
// ours). Kept apart on purpose: a hint removed by anyone else (a Preview morph, an Undo restore)
// is a content change the engine must learn of, so it is not covered by the creation registry.
const createdSpans = new WeakSet<Node>()
const removedSpans = new WeakSet<Node>()
const ownTexts = new WeakMap<Node, string>()

/** A new hint span, registered as ours. */
export function createWrapHintSpan(doc: Document): HTMLSpanElement {
  const span = doc.createElement('span')
  // Attribute order is part of the contract: `stripWrapHints` also matches the serialized form.
  span.className = WRAP_HINT_CLASS
  span.setAttribute('data-render', '1')
  createdSpans.add(span)
  return span
}

/**
 * Record the data the engine left in a Text node. Call it for every Text node a write can split,
 * merge or remove, before the write (so a removed node is covered) and again after it (so a
 * survivor with a new length is covered).
 */
function expectOwnText(node: Text): void {
  ownTexts.set(node, node.data)
}

function isOwnText(node: Node): boolean {
  return (
    node.nodeType === Node.TEXT_NODE &&
    ownTexts.get(node) === (node as Text).data
  )
}

/**
 * Is this record only a hint write: the truncation of a Text node the engine split or merged, or
 * the insert/remove of nodes the engine created? Anything else, including an attribute write or a
 * Text node whose data changed after the engine's write, is not.
 */
export function isOwnHintRecord(record: MutationRecord): boolean {
  if (record.type === 'characterData') return isOwnText(record.target)
  if (record.type !== 'childList') return false
  const { addedNodes, removedNodes } = record
  if (addedNodes.length + removedNodes.length === 0) return false
  // Plain index loops: this runs for every record of every observer after each hint write.
  for (let i = 0; i < addedNodes.length; i += 1) {
    const node = addedNodes[i]
    if (!(createdSpans.has(node) || isOwnText(node))) return false
  }
  for (let i = 0; i < removedNodes.length; i += 1) {
    const node = removedNodes[i]
    if (!(removedSpans.has(node) || isOwnText(node))) return false
  }
  return true
}

/** The records of a batch that are not hint writes (the same array when none is). */
export function withoutOwnHintRecords(
  records: MutationRecord[],
): MutationRecord[] {
  return records.some(isOwnHintRecord)
    ? records.filter((record) => !isOwnHintRecord(record))
    : records
}

/** Register every direct Text child of `element` (see `expectOwnText`). */
export function expectOwnTexts(element: Element): void {
  for (const child of Array.from(element.childNodes))
    if (child.nodeType === Node.TEXT_NODE) expectOwnText(child as Text)
}

function isHintSpan(node: Node): node is HTMLElement {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    (node as Element).classList.contains(WRAP_HINT_CLASS)
  )
}

/**
 * Remove every hint span that is a direct child of `element` and merge the Text nodes they
 * separated. `Node.normalize` keeps live Selection ranges on the merged text, so a caret inside
 * stays where it was. Returns whether anything was removed.
 */
export function clearWrapHints(element: Element): boolean {
  const spans = Array.from(element.childNodes).filter(isHintSpan)
  if (spans.length === 0) return false
  expectOwnTexts(element)
  for (const span of spans) {
    removedSpans.add(span)
    span.remove()
  }
  element.normalize()
  expectOwnTexts(element)
  return true
}

/** Insert a hint before `node` (a boundary between two Text nodes, no split needed). */
export function insertWrapHintBefore(node: Node): void {
  const parent = node.parentNode
  if (!parent) throw new Error('insertWrapHintBefore: the node is detached')
  parent.insertBefore(createWrapHintSpan(node.ownerDocument as Document), node)
}

/**
 * Insert a hint inside `text` at `offset` (strictly inside the data) with `splitText` and
 * `insertBefore` only: they keep a live Selection range on its characters, which a replaced Text
 * node would not. Returns the tail Text node.
 */
export function insertWrapHint(text: Text, offset: number): Text {
  const parent = text.parentNode
  if (!parent) throw new Error('insertWrapHint: the text node is detached')
  expectOwnText(text)
  const tail = text.splitText(offset)
  parent.insertBefore(createWrapHintSpan(text.ownerDocument), tail)
  expectOwnText(text)
  expectOwnText(tail)
  return tail
}

// The serialized form of a hint (`createWrapHintSpan`): `outerHTML`, `innerHTML` and Vditor's
// snapshots all print it this way.
const HINT_HTML = /<span class="vmde-wrap-hint"[^>]*><\/span>/g

/** `html` without hint spans. Returns the same string when it has none (the common case). */
export function stripWrapHints(html: string): string {
  return html.indexOf(WRAP_HINT_CLASS) === -1
    ? html
    : html.replace(HINT_HTML, '')
}

let filterInstalled: (() => void) | undefined

/**
 * Make every MutationObserver created after this call blind to hint writes: its callback receives
 * the batch without the engine's own records and is not called at all when nothing else is left
 * (`takeRecords` is filtered the same way). The editor has some 60 observers, many of which walk
 * the document in their callback; on a document with many long words each hint write batch woke
 * all of them (Task 640 S2b perf profile: the Task 219 table handles, the HTML-subscript pairing
 * and the link-like semantics alone cost more than the engine). The filter is installed by
 * `boot/preload.ts`, the first import of every real entry point, so it precedes every observer.
 * Idempotent; returns the uninstall (tests).
 */
export function installWrapHintRecordFilter(): () => void {
  if (filterInstalled) return filterInstalled
  const Native = window.MutationObserver
  class HintBlindMutationObserver extends Native {
    constructor(callback: MutationCallback) {
      super(function (this: MutationObserver, records, observer) {
        const real = withoutOwnHintRecords(records)
        if (real.length > 0) callback.call(this, real, observer)
      })
    }
    takeRecords(): MutationRecord[] {
      return withoutOwnHintRecords(super.takeRecords())
    }
  }
  window.MutationObserver = HintBlindMutationObserver
  const uninstall = (): void => {
    if (window.MutationObserver === HintBlindMutationObserver)
      window.MutationObserver = Native
    filterInstalled = undefined
  }
  filterInstalled = uninstall
  return uninstall
}
