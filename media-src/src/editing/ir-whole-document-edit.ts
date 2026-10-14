// Task 617 — VMDE-owned IR edit of a whole-document selection (Select All's document stage).
//
// Why: Chromium's native delete of the root Range `(root, 0)-(root, N)` removes only the content up
// to the last visible position. A document whose last block ends in hidden structure keeps it: a
// closing code fence's `span[data-type="code-block-close-marker"]` stays in an emptied code-block
// `div`, and Vditor's IR input path re-parses that leftover as an empty fence (Delete gave
// `` ```\n ``, type-over `X` gave `` X\n\n```\n ``; measured in the Chromium harness). This module
// performs only the deletion part, DOM-exactly: every block goes and one empty paragraph takes its
// place, with the caret in it.
//   - Delete, Backspace and the word/line deletes end there: an `input` event hands the empty
//     paragraph to Vditor's own IR input path, which re-spins it and takes the one Undo snapshot.
//   - `insertText` (type-over) does NOT cancel the event and sends no `input` of its own: the browser
//     then inserts the typed text at the caret in the empty paragraph, and its native `input` event
//     goes through Vditor's usual path. Whitespace therefore keeps its native handling (a typed space
//     becomes `&nbsp;`); a raw space inserted here made Vditor's IR `input()` return early (its
//     leading/trailing-space rule, ir/input.ts) and record no Undo snapshot.
//
// Owned: IR only; one non-collapsed Range from the editor root at offset 0 to the root at its child
// count (the exact form Select All's document stage produces); a delete input type, or `insertText`
// with data. Not owned (left to the browser and Vditor): any partial selection, a selection inside a
// code block or table cell, a caret, other input types (`insertParagraph`, paste, cut, drop), IME
// composition, WYSIWYG and SV.
//
// The listener sits on `document` in the capture phase like the SV edit (Task 619): the Task 598
// undo seed listens on `window` capture, so it still records the pre-edit baseline first, and
// Vditor's own listeners (on the editor element) run after this one.
import { isCompositionActive } from '../util/caret-gesture'
import { innerVditor } from '../util/inner-vditor'

/** Delete input types that remove exactly a non-collapsed selection (word and line deletes included). */
const DELETE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'deleteContentBackward',
  'deleteContentForward',
  'deleteWordBackward',
  'deleteWordForward',
  'deleteSoftLineBackward',
  'deleteSoftLineForward',
  'deleteHardLineBackward',
  'deleteHardLineForward',
])

/** The live IR editable element, or null when another mode is active. */
function irEditor(): HTMLElement | null {
  const inner = innerVditor()
  if (inner?.currentMode !== 'ir') return null
  return inner.ir?.element ?? null
}

/**
 * True when the live selection is one Range covering every block of `editor`: both endpoints are
 * the editor element itself, from offset 0 to its child count.
 */
export function selectsWholeDocument(
  editor: HTMLElement,
  selection: Selection,
): boolean {
  if (selection.rangeCount !== 1 || editor.childNodes.length === 0) return false
  const range = selection.getRangeAt(0)
  return (
    range.startContainer === editor &&
    range.startOffset === 0 &&
    range.endContainer === editor &&
    range.endOffset === editor.childNodes.length
  )
}

/** Vditor's IR composition lock: an IME composition owns the edit, so VMDE stays out. */
function composing(): boolean {
  const ir = innerVditor()?.ir
  return ir?.composingLock === true || isCompositionActive()
}

/**
 * Replaces every block with one empty paragraph and puts the caret in it. For a delete (`isDelete`)
 * it then sends one `input` event to Vditor's IR input path; for a type-over the caller
 * leaves the insertion to the browser. Returns false, with the DOM untouched, when the live
 * selection is not an owned whole-document selection. Never throws once the DOM has changed: it
 * returns true so the caller still cancels a native delete (running it too would edit twice), and
 * the `input` event of a delete is sent either way.
 */
function replaceWholeDocument(
  win: Window & typeof globalThis,
  isDelete: boolean,
): boolean {
  const editor = irEditor()
  const selection = win.getSelection()
  if (!editor || !selection || composing()) return false
  if (!selectsWholeDocument(editor, selection))
    return false
    // Revokes a host-owned seed before the DOM changes: a synthetic `input` is untrusted, so the
    // edit-sync authority would otherwise not count a delete as user input (same hook as the SV edit).
  ;(
    win as unknown as { __vmdeMarkCutInput?: () => void }
  ).__vmdeMarkCutInput?.()
  try {
    const doc = editor.ownerDocument
    const paragraph = doc.createElement('p')
    paragraph.setAttribute('data-block', '0')
    editor.replaceChildren(paragraph)
    const caret = doc.createRange()
    caret.setStart(paragraph, 0)
    caret.collapse(true)
    selection.removeAllRanges()
    selection.addRange(caret)
  } finally {
    // Vditor re-spins from the DOM as it is, so it must hear about the change even if a step failed.
    if (isDelete)
      editor.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'deleteContent',
        }),
      )
  }
  return true
}

function onBeforeInput(win: Window & typeof globalThis, event: Event) {
  const input = event as InputEvent
  const editor = irEditor()
  // Only the editor itself: a Find field or popover can keep a stale document selection.
  if (
    input.isComposing ||
    !editor ||
    !(event.target instanceof Node) ||
    !editor.contains(event.target)
  )
    return
  if (DELETE_INPUT_TYPES.has(input.inputType)) {
    if (replaceWholeDocument(win, true)) event.preventDefault()
  } else if (
    input.inputType === 'insertText' &&
    typeof input.data === 'string' &&
    input.data !== ''
  ) {
    // The browser inserts the text itself at the caret left in the empty paragraph.
    replaceWholeDocument(win, false)
  }
}

/**
 * Installs the owned whole-document IR edit. Returns a disposer. Must be called once per page (the
 * listener is on `document`, so a Vditor re-init or a mode switch needs no re-install).
 */
export function installIrWholeDocumentEdit(win: Window & typeof globalThis) {
  const beforeInput = (event: Event) => onBeforeInput(win, event)
  win.document.addEventListener('beforeinput', beforeInput, true)
  return () =>
    win.document.removeEventListener('beforeinput', beforeInput, true)
}
