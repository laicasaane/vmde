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
import { historyStoreOf } from './history-store'

// The proof moved into the history store with the `addCaret` wrap it feeds; re-exported so the
// marker tests and `boot/finish-init.ts` keep their import path.
export { isUndoSnapshotMarkerMutation } from './history-store'

type NeutralScope = Pick<SourceBlockIndexHandle, 'sourceNeutral'>

/** Mark `win.vditor.vditor.undo.addCaret` as a source-neutral scope of `index`, and keep wrap hints
 * out of its snapshot text (Task 640). The history store installs the wrapper once per Undo
 * object; further calls only register another index. A missing `addCaret` (Vditor drift) throws
 * instead of silently restoring the rebuilds; a missing Undo object (a partial host) is a no-op,
 * like `installVditorHistoryCoupling`. Returns the unbind. */
export function bindUndoSnapshotNeutral(
  win: any,
  index: NeutralScope,
): () => void {
  const store = historyStoreOf(win?.vditor?.vditor)
  if (!store) return () => undefined
  return store.addSnapshotScope(index)
}
