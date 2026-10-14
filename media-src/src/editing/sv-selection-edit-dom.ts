// Task 619 — DOM wiring for VMDE-owned SV (split view source pane) selection edits.
//
// Why: every SV source line ends with a newline span (`<br>` plus a hidden `\n`). Chromium's native
// delete of a non-collapsed selection that starts at a line start widens the range back over the
// previous line's hidden `\n`, so the previous line joins the current one (Delete, Backspace, cut,
// and Vditor's own SV Backspace branch, which joins the same way). `ownsSvSelectionEdit` decides which
// selections VMDE edits itself; this module performs that edit DOM-exactly (`Range.deleteContents()`
// removes exactly the selected characters) and then hands the result to Vditor's own SV input path.
//
// Routes (all gated by `ownsSvSelectionEdit`; anything else stays native):
//   - document `beforeinput`: deleteContentBackward / deleteContentForward / deleteByCut / insertText
//     (type-over) over an owned selection;
//   - document `keydown` Backspace: Vditor's SV keydown branch (sv/processKeydown.ts) runs before any
//     `beforeinput` and joins blocks by hand, so an owned selection is taken here first. Task 629 adds
//     the selections that start at column 1 (`ownsSvColumnOneBackspace`): the same Vditor branch widens
//     them back to column 0 and deletes one character too many;
//   - document `keydown` plain Enter (Task 629): Vditor's Enter branch inserts the line break without
//     deleting a non-collapsed selection, so the selected text would stay behind. The selection is
//     deleted here first (`ownsSvEnterOverSelection`) and the key is left to Vditor, which then runs on
//     a collapsed caret at the selection start (list continuation, its one re-spin and Undo snapshot);
//   - `window.__vmdeSvOwnedDelete`: the synchronous owned delete that the patched SV cut handler
//     (`patchCutDeleteSync`, esbuild-shared.mjs) calls instead of `execCommand("delete")`.
// Not owned (except by the Enter route, which takes any non-collapsed selection): collapsed carets
// (Task 614's line cut), whole-document and first-line selections,
// mid-line starts, IME composition and paste (`insertFromPaste` stays native).
//
// Listeners sit on `document` in the capture phase: the Task 598 undo seed listens on `window` capture,
// so it still records the pre-edit baseline first, and Vditor's own listeners (on the editor element)
// run after ours.
import { isCompositionActive } from '../util/caret-gesture'
import { innerVditor } from '../util/inner-vditor'
import {
  applySvSelectionEdit,
  ownsSvColumnOneBackspace,
  ownsSvEnterOverSelection,
  ownsSvSelectionEdit,
} from './sv-selection-edit'

/**
 * Native input types whose effect on a non-collapsed selection is "remove exactly it": the word and
 * line deletes (Ctrl/Alt/Cmd + Backspace/Delete) delete the selection and nothing more when there is one.
 */
const DELETE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'deleteContentBackward',
  'deleteContentForward',
  'deleteByCut',
  'deleteWordBackward',
  'deleteWordForward',
  'deleteSoftLineBackward',
  'deleteSoftLineForward',
  'deleteHardLineBackward',
  'deleteHardLineForward',
])

interface OwnedEdit {
  /** Text that replaces the selection ('' for a delete). */
  insert: string
  /**
   * The `input` event type Vditor's SV input path receives afterwards. Null sends none: the Enter
   * route only deletes, and Vditor's own Enter branch re-spins and takes the Undo snapshot.
   */
  inputType: string | null
  /** Which selections the edit takes; defaults to `ownsSvSelectionEdit` (starts at a line start). */
  owns?: (text: string, start: number, end: number) => boolean
}

/** The Backspace keydown takes the line-start selections and, since Task 629, those starting at column 1. */
const ownsBackspace = (text: string, start: number, end: number) =>
  ownsSvSelectionEdit(text, start, end) ||
  ownsSvColumnOneBackspace(text, start, end)

/** The live SV editable element, or null when another mode is active. */
function svEditor(): HTMLElement | null {
  const inner = innerVditor()
  if (inner?.currentMode !== 'sv') return null
  return inner.sv?.element ?? null
}

/** Offset of a DOM point in the editor's `textContent`; the hidden `\n` of a newline span counts. */
function textOffset(editor: HTMLElement, node: Node, offset: number): number {
  const prefix = editor.ownerDocument.createRange()
  prefix.selectNodeContents(editor)
  prefix.setEnd(node, offset)
  return prefix.toString().length
}

/** The `div[data-block]` that holds `node`, or null (the editor itself, or a node outside it). */
function blockOf(editor: HTMLElement, node: Node): HTMLElement | null {
  const element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const block = element?.closest<HTMLElement>('[data-block]') ?? null
  return block && editor.contains(block) && block !== editor ? block : null
}

/** The live selection when `edit` owns it, with what must be read before the DOM changes. */
interface OwnedSelection {
  editor: HTMLElement
  selection: Selection
  range: Range
  text: string
  start: number
  end: number
  startBlock: HTMLElement | null
  endBlock: HTMLElement | null
}

/** Reads the live selection and returns it when `edit` owns it; changes nothing. */
function readOwnedSelection(
  win: Window & typeof globalThis,
  edit: OwnedEdit,
): OwnedSelection | null {
  const editor = svEditor()
  const selection = win.getSelection()
  if (!editor || !selection || selection.rangeCount === 0) return null
  if (composing()) return null
  const range = selection.getRangeAt(0)
  if (range.collapsed || !editor.contains(range.commonAncestorContainer))
    return null

  const text = editor.textContent ?? ''
  const start = textOffset(editor, range.startContainer, range.startOffset)
  const end = textOffset(editor, range.endContainer, range.endOffset)
  if (!(edit.owns ?? ownsSvSelectionEdit)(text, start, end)) return null

  // Read before deleteContents(): it collapses `range` to the common ancestor (the editor, for a
  // selection across blocks), which names neither block.
  const startBlock = blockOf(editor, range.startContainer)
  const endBlock = blockOf(editor, range.endContainer)
  // The Enter route needs a data-block around the caret: Vditor's Enter branch finds its block from it.
  if (edit.inputType === null && !startBlock) return null
  return { editor, selection, range, text, start, end, startBlock, endBlock }
}

/**
 * deleteContents() never merges the partially selected blocks. Everything after the range start in the
 * start block was selected, so appending the end block's remainder restores the source order.
 */
function mergeBlocks(
  startBlock: HTMLElement | null,
  endBlock: HTMLElement | null,
) {
  if (!startBlock || !endBlock || endBlock === startBlock) return
  if (!endBlock.isConnected) return
  while (endBlock.firstChild) startBlock.appendChild(endBlock.firstChild)
  endBlock.remove()
}

/**
 * Performs the owned edit when the live selection is one: deletes the exact range (and inserts
 * `insert`), merges the blocks the range spanned, puts the caret at the edit, and dispatches an
 * `input` event so Vditor's SV input path re-spins the block and takes its one Undo snapshot (no event
 * when `inputType` is null: the Enter route leaves the re-spin to Vditor's Enter branch).
 * Returns false, with the DOM untouched, when the selection is not owned. Never throws: once the DOM
 * has changed it returns true even if a later step failed, so the caller still cancels the native
 * edit (running it as well would delete twice), and the `input` event is sent either way.
 */
function applyOwnedEdit(win: Window & typeof globalThis, edit: OwnedEdit) {
  let mutated = false
  try {
    const owned = readOwnedSelection(win, edit)
    if (!owned) return false
    const { editor, selection, range, text, start, end } = owned
    // `caret` is a live range at the start, so it still marks the edit position after the DOM changes.
    const caret = range.cloneRange()
    caret.collapse(true)
    // Revokes a host-owned seed before the DOM changes: the synthetic `input` below is untrusted, so
    // the edit-sync authority would otherwise not count this as user input (same hook as the cut path).
    ;(
      win as unknown as { __vmdeMarkCutInput?: () => void }
    ).__vmdeMarkCutInput?.()

    mutated = true
    range.deleteContents()
    try {
      mergeBlocks(owned.startBlock, owned.endBlock)
      if (edit.insert) insertAtRange(caret, edit.insert)
      selection.removeAllRanges()
      selection.addRange(caret)
    } finally {
      // Vditor re-spins from the DOM as it is, so it must hear about the change even when a step
      // above failed. The Enter route sends none: Vditor's Enter branch re-spins right after.
      if (edit.inputType !== null)
        editor.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: edit.inputType,
            data: edit.insert || null,
          }),
        )
    }
    // Without a re-spin there is no Vditor caret to correct.
    if (edit.inputType === null) return true
    const model = applySvSelectionEdit(text, start, end, edit.insert)
    restoreCaret(win, editor, model.text, model.caret)
    return true
  } catch {
    return mutated
  }
}

/**
 * Vditor's re-spin puts its caret marker back by its own rules, which can land one line early (measured
 * at the start of a list item: the end of the previous line). When the re-spun text is exactly the text
 * model of this edit, the source offsets are comparable, so put the caret at the model's offset; any
 * other text means Lute reformatted the source and its own caret is the better guess. A point is found
 * only in a visible text node: the hidden `\n` of a newline span is not a place a caret can sit.
 */
function restoreCaret(
  win: Window & typeof globalThis,
  editor: HTMLElement,
  expectedText: string,
  offset: number,
) {
  if ((editor.textContent ?? '') !== expectedText) return
  const selection = win.getSelection()
  if (!selection) return
  const walker = editor.ownerDocument.createTreeWalker(
    editor,
    NodeFilter.SHOW_TEXT,
  )
  let before = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node.textContent ?? '').length
    const hidden = node.parentElement?.closest('[data-type="newline"]')
    if (!hidden && before <= offset && offset <= before + length) {
      const range = editor.ownerDocument.createRange()
      range.setStart(node, offset - before)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      return
    }
    before += length
  }
}

function insertAtRange(range: Range, insert: string) {
  const container = range.startContainer
  if (container.nodeType === Node.TEXT_NODE) {
    const offset = range.startOffset
    ;(container as Text).insertData(offset, insert)
    range.setStart(container, offset + insert.length)
    range.collapse(true)
    return
  }
  const node = container.ownerDocument.createTextNode(insert)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
}

/** Vditor's SV composition lock: an IME composition owns the edit, so VMDE stays out. */
function composing(): boolean {
  const sv = innerVditor()?.sv as { composingLock?: boolean } | undefined
  return sv?.composingLock === true || isCompositionActive()
}

/**
 * True while Vditor's hint list (emoji or extension entries) is open. Vditor's keydown handler gives
 * Enter to the open list (`hint.select`, util/editorCommonEvent.ts) before its SV Enter branch, so VMDE
 * must not delete the selection then: the key fills the hint and the selection has to survive.
 */
function hintShown(): boolean {
  const hint = (innerVditor() as { hint?: { element?: HTMLElement } } | null)
    ?.hint?.element
  return (
    !!hint &&
    hint.style.display !== 'none' &&
    hint.querySelector('button') !== null
  )
}

/** True when the event comes from the SV editable (not from a Find field or popover that keeps a selection). */
function targetInEditor(event: Event): boolean {
  const editor = svEditor()
  return (
    !!editor && event.target instanceof Node && editor.contains(event.target)
  )
}

function onBeforeInput(win: Window & typeof globalThis, event: Event) {
  const input = event as InputEvent
  if (input.isComposing || !targetInEditor(event)) return
  let edit: OwnedEdit | null = null
  if (DELETE_INPUT_TYPES.has(input.inputType)) {
    // 'deleteContent' (not the native type): for deleteContentBackward Vditor's SV input path skips
    // the re-spin when the caret is left at a line start (sv/inputEvent.ts, `startSpace`), and this
    // edit always leaves it there.
    edit = {
      insert: '',
      inputType:
        input.inputType === 'deleteByCut' ? 'deleteByCut' : 'deleteContent',
    }
  } else if (
    input.inputType === 'insertText' &&
    typeof input.data === 'string' &&
    input.data !== ''
  ) {
    edit = { insert: input.data, inputType: 'insertText' }
  }
  if (!edit) return
  if (applyOwnedEdit(win, edit)) event.preventDefault()
}

function onKeydown(win: Window & typeof globalThis, event: Event) {
  const key = event as KeyboardEvent
  if (
    (key.key !== 'Backspace' && key.key !== 'Enter') ||
    key.isComposing ||
    key.ctrlKey ||
    key.metaKey ||
    key.altKey ||
    key.shiftKey ||
    !targetInEditor(event)
  )
    return
  if (key.key === 'Enter') {
    // Delete only: no preventDefault and no stopPropagation, so Vditor's Enter branch runs next on the
    // collapsed caret this leaves at the selection start.
    if (!hintShown())
      applyOwnedEdit(win, {
        insert: '',
        inputType: null,
        owns: ownsSvEnterOverSelection,
      })
    return
  }
  // Vditor's SV Backspace branch (sv/processKeydown.ts) is what joins the lines for a block-start
  // selection, and it runs on keydown, before `beforeinput`. Taking only owned selections here leaves
  // every other Backspace to Vditor; stopPropagation keeps Vditor's listener (on the editor, a later
  // target in the same dispatch) from also running, while other document capture listeners still do.
  if (
    applyOwnedEdit(win, {
      insert: '',
      inputType: 'deleteContent',
      owns: ownsBackspace,
    })
  ) {
    key.preventDefault()
    key.stopPropagation()
  }
}

/**
 * Installs the owned SV selection edit. Returns a disposer. Must be called once per page (the
 * listeners are on `document`, so a Vditor re-init or a mode switch needs no re-install).
 */
export function installSvSelectionEdit(win: Window & typeof globalThis) {
  // Both handlers are safe to call bare: applyOwnedEdit never throws, and before it changes the DOM a
  // failure only means "not owned", which leaves the event to the browser.
  const beforeInput = (event: Event) => onBeforeInput(win, event)
  const keydown = (event: Event) => onKeydown(win, event)
  win.document.addEventListener('beforeinput', beforeInput, true)
  win.document.addEventListener('keydown', keydown, true)
  const store = win as unknown as Record<string, unknown>
  // The patched SV cut handler (patchCutDeleteSync, esbuild-shared.mjs) calls this instead of
  // execCommand("delete") for a real selection; true means the selection was deleted.
  const ownedDelete = () =>
    applyOwnedEdit(win, { insert: '', inputType: 'deleteByCut' })
  store.__vmdeSvOwnedDelete = ownedDelete
  return () => {
    win.document.removeEventListener('beforeinput', beforeInput, true)
    win.document.removeEventListener('keydown', keydown, true)
    // A re-init installs the new instance before it disposes the old one (Disposables.set), so
    // clear the hook only if it is still this instance's; otherwise the new hook would be lost.
    if (store.__vmdeSvOwnedDelete === ownedDelete)
      store.__vmdeSvOwnedDelete = undefined
  }
}
