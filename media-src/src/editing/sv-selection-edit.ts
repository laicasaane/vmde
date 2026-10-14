// Task 619 — pure decision and text model for VMDE-owned SV (split view source pane) selection edits.
//
// Why: every SV source line ends with a newline span (`<br>` plus a hidden `\n`). Chromium's native
// delete of a non-collapsed selection that starts at a line start widens the range back over the
// previous line's hidden `\n`, so the previous line joins the current one. VMDE therefore performs
// those edits itself (DOM-exact) instead of leaving them to the browser. This module holds only the
// source-offset logic; the DOM wiring that consumes it lives elsewhere. No DOM, no Vditor.
// Task 629 adds two predicates for the same module: Enter over a selection (Vditor's Enter branch
// leaves the selected text behind) and Backspace over a selection that starts at column 1 (Vditor's
// Backspace branch deletes column 0 too).

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

/**
 * True when VMDE owns the SV Backspace over [start, end) because the range starts at column 1: the
 * range is valid and non-collapsed, the character in front of it (column 0) is the first of a source
 * line that is not the first, and that character is not itself a line break. Vditor's SV Backspace
 * branch (sv/processKeydown.ts) widens such a selection back to column 0, so it deletes one character
 * too many; the owned edit removes exactly [start, end). A collapsed caret, a start at column 0 or at
 * column 2 and later, and line 1 stay with Vditor and the browser.
 */
export function ownsSvColumnOneBackspace(
  text: string,
  start: number,
  end: number,
): boolean {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false
  if (start < 2 || start >= end || end > text.length) return false
  return text[start - 2] === '\n' && text[start - 1] !== '\n'
}

/**
 * True when VMDE deletes the SV selection [start, end) before Vditor's plain Enter branch runs: any
 * valid non-collapsed range, wherever it starts. Vditor's Enter inserts the line break without
 * deleting a selection, so the selected text would stay behind as leftover text; after the owned
 * delete the caret is collapsed at the selection start and Vditor's own Enter handles the rest
 * (list and blockquote continuation, its single re-spin and Undo snapshot).
 */
export function ownsSvEnterOverSelection(
  text: string,
  start: number,
  end: number,
): boolean {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false
  return start >= 0 && start < end && end <= text.length
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
