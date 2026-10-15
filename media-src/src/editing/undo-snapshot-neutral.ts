// Task 610 — Vditor's Undo snapshot marker is source-neutral.
//
// Vditor's `Undo.addCaret` (vditor/src/ts/undo/index.ts) writes a `span.vditor-wbr` marker at the
// caret on the LIVE editable root (which splits the caret's Text node), clones the root, and
// removes the marker again; the two Text halves stay adjacent. Callers: the delayed
// `addToUndoStack` (timer, `setValue`, VMDE's checkpoints) and `recordFirstPosition` (first
// keydown, which may be a non-editing key). The shared source index (nav/source-block-index.ts)
// treats every non-attribute mutation as a source change, so each snapshot discarded the warmed
// entry and the next source-backed request rebuilt it (roughly 1-1.6 s on the large fixture).
//
// The Owner rule (2026-10-08): the Vditor integration marks its own marker mutations
// source-neutral; the index stays generic. This module wraps the Undo instance's `addCaret` (both
// callers; it leaves the diff, the stack push and the history-coupling callbacks outside the
// scope) in the index's `sourceNeutral` scope, and supplies `isUndoSnapshotMarkerMutation` as the
// proof of the marking. It lives in `editing/` because the boundary test forbids `nav -> editing`.
//
// The index is created after the Undo instance is wrapped, so registration is late and
// reversible: `bindUndoSnapshotNeutral` adds an index to the instance's set and returns the
// unbind that boot/finish-init.ts calls from the block-handle disposer.
import type { SourceBlockIndexHandle } from '../nav/source-block-index'
import { stripWrapHints } from '../util/wrap-hint-mark'

type NeutralScope = Pick<SourceBlockIndexHandle, 'sourceNeutral'>

const registrations = new WeakMap<object, Set<NeutralScope>>()

const TEXT_NODE = 3

function isDetachedMarker(node: Node): boolean {
  return (
    node instanceof HTMLElement &&
    node.localName === 'span' &&
    node.classList.contains('vditor-wbr') &&
    !node.firstChild &&
    !node.isConnected
  )
}

interface RecordFacts {
  addedText: Set<Node>
  truncated: Set<Node>
}

// Fold one record into `facts`; false when the record is not marker/split shaped.
function readRecord(record: MutationRecord, facts: RecordFacts): boolean {
  if (record.type === 'attributes') return false
  if (record.type === 'characterData') {
    if (record.target.nodeType !== TEXT_NODE) return false
    facts.truncated.add(record.target)
    return true
  }
  if (!Array.from(record.removedNodes).every(isDetachedMarker)) return false
  for (const node of Array.from(record.addedNodes)) {
    if (node.nodeType === TEXT_NODE) facts.addedText.add(node)
    else if (!isDetachedMarker(node)) return false
  }
  return true
}

/** The proof that a scope's records are only Undo's marker insert/remove and its Text split.
 * Anything else (another element, a removed Text node, a text edit that is not half of a split, a
 * Comment edit, any attribute write, a marker left connected) is not proven and invalidates. A
 * split is an added Text node whose previous sibling is the Text node whose data was truncated
 * (its `characterData` record), so both halves must be present and adjacent. */
export function isUndoSnapshotMarkerMutation(
  records: MutationRecord[],
): boolean {
  const facts: RecordFacts = { addedText: new Set(), truncated: new Set() }
  if (!records.every((record) => readRecord(record, facts))) return false
  const { addedText, truncated } = facts
  return (
    Array.from(addedText).every(
      (node) =>
        node.isConnected &&
        node.previousSibling?.nodeType === TEXT_NODE &&
        truncated.has(node.previousSibling),
    ) &&
    Array.from(truncated).every(
      (node) => node.nextSibling && addedText.has(node.nextSibling),
    )
  )
}

/** Mark `win.vditor.vditor.undo.addCaret` as a source-neutral scope of `index`, and keep wrap hints
 * out of its snapshot text (Task 640). The wrapper is installed once per Undo object; further
 * calls only register another index. A missing `addCaret`
 * (Vditor drift) throws instead of silently restoring the rebuilds; a missing Undo object (a
 * partial host) is a no-op, like `installVditorHistoryCoupling`. Returns the unbind. */
export function bindUndoSnapshotNeutral(
  win: any,
  index: NeutralScope,
): () => void {
  const undo = win?.vditor?.vditor?.undo
  if (!undo) return () => undefined
  let scopes = registrations.get(undo)
  if (!scopes) {
    const original = undo.addCaret
    if (typeof original !== 'function')
      throw new Error(
        'bindUndoSnapshotNeutral: the Vditor Undo instance has no addCaret (version drift?)',
      )
    const registered = new Set<NeutralScope>()
    scopes = registered
    registrations.set(undo, registered)
    undo.addCaret = function (this: unknown, ...args: unknown[]) {
      // One nested scope per registered index; the outermost owns the records of all of them.
      const run = () => original.apply(this, args)
      const text = Array.from(registered).reduceRight<() => unknown>(
        (inner, scope) => () =>
          scope.sourceNeutral(inner, isUndoSnapshotMarkerMutation),
        run,
      )()
      // Task 640: a wrap hint is view state, so a snapshot never carries one. A hint written
      // between two snapshots is then no difference, and an Undo restores source without hints.
      return typeof text === 'string' ? stripWrapHints(text) : text
    }
  }
  scopes.add(index)
  return () => {
    scopes.delete(index)
  }
}
