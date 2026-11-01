// Task 485 — on Windows, Chromium's double-click word selection extends past the word into the
// trailing whitespace run (documented Blink `EditingWindowsBehavior`, not reproduced on Mac/Linux —
// see the task file for corroborating reports, including the user's own control: VS Code's BUILT-IN
// markdown preview — a webview with none of our JS — over-selects the same way, so this is the
// platform's behaviour, not this extension's). VS Code's Windows-hosted webview inherits it, so a
// double-click there selects "word " instead of "word". This trims the selection back to the word
// boundary; on platforms that already stop at the boundary the trim loop runs zero iterations, so
// it's a no-op there.
//
// Bound at `document` level (not `#app`/`previewEl`, unlike this module's neighbours) — the events
// below bubble, so one set of listeners survives `previewEl` being replaced wholesale by a Preview
// re-render and covers all 4 reported surfaces (IR, WYSIWYG, SV, Preview) without a dual binding.
//
// Trimming on `dblclick` alone (the first shipped version) visibly flashed the untrimmed selection
// for a frame before correcting it — reported by the user. `dblclick` only fires after mousedown →
// [native word-select applied] → mouseup → click all round-trip through the browser's input
// pipeline, and Chromium's compositor can paint the over-inclusive selection during that round trip
// before our JS ever runs. `selectionchange` fires as soon as the native selection itself mutates —
// earlier in that pipeline — so arm on the double-click's `mousedown` (`event.detail === 2`; a
// triple-click's line/paragraph selection is intentionally left untouched) and trim on the very next
// `selectionchange`, disarming immediately after so an unrelated later selection change is never
// touched. `mouseup` is a backstop disarm, bounding the armed window to one click gesture even if
// `selectionchange` never fires for it. `dblclick` stays wired as a fallback for whichever browser
// fires it before `selectionchange` — the trim is idempotent, so running it twice is harmless.
import { writeSelection } from './caret'

function trimTrailingWhitespaceSelection(): void {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  const endContainer = range.endContainer
  if (endContainer.nodeType !== Node.TEXT_NODE) return
  const text = endContainer.textContent ?? ''
  // The start/end offsets are only comparable when they're offsets into the SAME node — a word
  // adjacent to an inline marker (bold/link) routinely splits across text nodes, in which case 0 is
  // the only safe floor for how far back this node's own trim may go.
  const sameNode = range.startContainer === endContainer
  const floor = sameNode ? range.startOffset : 0
  let end = range.endOffset
  while (end > floor && /\s/.test(text[end - 1])) end--
  if (end === range.endOffset) return // nothing trailing to trim
  if (sameNode && end <= range.startOffset) return // pure-whitespace dblclick — leave it alone
  // Vditor may have rebuilt the DOM in response to the same dblclick (e.g. expanding a bold word's
  // `**` markers) — re-applying a range into a node it already detached would eject the caret the
  // way task 179/the EOF-caret-jump bug did, so bail rather than risk it.
  if (!endContainer.isConnected) return
  range.setEnd(endContainer, end)
  // Deliberate: the trimmed word selection replaces the native double-click selection.
  writeSelection(range)
}

let armedForSelectionchange = false

function onMousedown(event: MouseEvent): void {
  armedForSelectionchange = event.detail === 2
}

function onSelectionchange(): void {
  if (!armedForSelectionchange) return
  armedForSelectionchange = false
  trimTrailingWhitespaceSelection()
}

function onMouseup(): void {
  armedForSelectionchange = false
}

let installed = false

/** Install the double-click trailing-whitespace-selection trim (see the module header above).
 *  Idempotent; returns a disposer. */
export function installDblclickWordSelectFix(): () => void {
  if (installed) uninstall()
  document.addEventListener('mousedown', onMousedown)
  document.addEventListener('selectionchange', onSelectionchange)
  document.addEventListener('mouseup', onMouseup)
  document.addEventListener('dblclick', trimTrailingWhitespaceSelection)
  installed = true
  return uninstall
}

function uninstall(): void {
  document.removeEventListener('mousedown', onMousedown)
  document.removeEventListener('selectionchange', onSelectionchange)
  document.removeEventListener('mouseup', onMouseup)
  document.removeEventListener('dblclick', trimTrailingWhitespaceSelection)
  armedForSelectionchange = false
  installed = false
}
