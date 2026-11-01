// Task 664 — marked selection writes.
//
// The caret authority (editing/caret.ts) rewrites any selection that differs from its live intent
// on every animation frame, so a selection written elsewhere is undone while an intent is live.
// These helpers let VMDE code say which kind of write it is making: `writeSelection` is a
// deliberate selection and retires the live intent first, `writeSelectionKeepingIntent` puts a
// selection back transparently and leaves the intent armed. Vditor's own undo and spin writes use
// neither, so the authority still overrides them.
//
// This lives in util/ rather than editing/ so that chrome/, clipboard/, links/ and nav/ can use it
// without a new inter-module edge: the intent state is owned by caret.ts, which registers its
// `invalidateCaret` here at load. A write made before that has run cannot meet a live intent (none
// can exist yet), so the default no-op retirer is correct.

/** A selection given as its two endpoints, so a backward selection (anchor after focus) keeps its
 * direction. A `Range` cannot express that. */
export interface SelectionEnds {
  anchorNode: Node
  anchorOffset: number
  focusNode: Node
  focusOffset: number
}

let retireIntent: () => void = () => {
  /* no caret authority registered yet: no intent can be live */
}

/** Register the function that drops the live caret intent. Called once by editing/caret.ts. */
export function setIntentRetirer(retire: () => void): void {
  retireIntent = retire
}

// The one place a marked write touches the Selection. Returns false (instead of throwing) when an
// endpoint is stale, e.g. an offset past the node's length after a concurrent edit.
function applySelection(target: Range | SelectionEnds): boolean {
  try {
    const selection = window.getSelection()
    if (!selection) return false
    if (target instanceof Range) {
      selection.removeAllRanges()
      selection.addRange(target)
    } else {
      selection.setBaseAndExtent(
        target.anchorNode,
        target.anchorOffset,
        target.focusNode,
        target.focusOffset,
      )
    }
    return true
  } catch {
    return false
  }
}

/**
 * A DELIBERATE selection write by VMDE code: retire the live caret intent, then write. While an
 * intent is live, the authority rewrites every selection that differs from it on the next frame
 * (measured: a foreign addRange is overwritten for up to MAX_TOTAL_TICKS frames), so a deliberate
 * write that left the stale intent armed would be undone. The intent is retired even when the write
 * throws (fails open, like invalidateCaret). Not tied to a held pointer: the write is made once and
 * nothing re-asserts it afterwards.
 */
export function writeSelection(target: Range | SelectionEnds): boolean {
  retireIntent()
  return applySelection(target)
}

/**
 * A TRANSPARENT write: put back a selection that was read earlier in the same synchronous operation
 * (save-and-restore around an internal DOM change). It leaves the live intent armed, so the
 * authority keeps overriding Vditor churn exactly as before the write.
 */
export function writeSelectionKeepingIntent(
  target: Range | SelectionEnds,
): boolean {
  return applySelection(target)
}
