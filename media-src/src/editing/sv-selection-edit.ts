// Task 619 — pure decision and text model for VMDE-owned SV (split view source pane) selection edits.
//
// Why: every SV source line ends with a newline span (`<br>` plus a hidden `\n`). Chromium's native
// delete of a non-collapsed selection that starts at a line start widens the range back over the
// previous line's hidden `\n`, so the previous line joins the current one. VMDE therefore performs
// those edits itself (DOM-exact) instead of leaving them to the browser. This module holds only the
// source-offset logic; the DOM wiring that consumes it lives elsewhere. No DOM, no Vditor.

/**
 * True when VMDE owns the SV edit of source range [start, end): non-collapsed, starting at the start
 * of a source line other than the first, and not a whole-document selection. Mid-line starts,
 * whole-document selections and the collapsed line cut (Task 614) stay native.
 */
export function ownsSvSelectionEdit(
  text: string,
  start: number,
  end: number,
): boolean {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false
  if (start < 0 || start >= end || end > text.length) return false
  if (start === 0) return false // first line, and any whole-document selection
  return text[start - 1] === '\n'
}

/** Applies the owned edit to the source: replaces [start, end) with `insert`; never touches the `\n` at start - 1. */
export function applySvSelectionEdit(
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; caret: number } {
  return {
    text: text.slice(0, start) + insert + text.slice(end),
    caret: start + insert.length,
  }
}
