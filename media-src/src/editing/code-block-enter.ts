// Task 627 — Enter with the caret in a code block's RENDERED PREVIEW stays a newline in the code.
//
// Where the caret goes: Control+End (and a few other native moves) land on the last caret position
// of the editable root, which for a document ending in a fenced code block is inside the block's
// rendered preview (`pre.vditor-ir__preview` / `pre.vditor-wysiwyg__preview`), not in the editable
// code. Vditor's code-block Enter rule is keyed to the EDITABLE code (`.vditor-ir__marker--pre` in
// IR, the block's own `pre` in WYSIWYG), so with the caret in the preview it does not run: the key
// is not prevented, the native paragraph insert is dropped by Vditor's re-spin, and the caret falls
// to the end of the first heading (measured, tasks/627 S2b-a).
//
// The fix: before Vditor's own keydown handler (bound on the editor element, bubble phase) reads the
// selection, move a collapsed caret from the preview to the end of that block's code text, then let
// the event continue untouched, so Vditor's own rule inserts the newline. This listener is capture
// phase on the document, which runs first. It never prevents or stops the event.
//
// Why a direct one-shot selection write and not requestCaret (ADR-0007): requestCaret leaves an
// intent armed and re-asserts it every frame. Here Vditor moves the caret to the new code line right
// after this event, and an armed intent would drag it back to the old line end. The write is
// consumed by Vditor's handler within the same dispatch, so nothing needs to stay armed.
import { guardComposition } from '../util/caret-gesture'

// Rendered preview of a code block, per mode. The block wrapper is part of the selector so a preview
// of another renderer (math, diagrams, which use the same `__preview` class) never matches.
const IR_PREVIEW =
  '.vditor-ir__node[data-type="code-block"] > .vditor-ir__preview'
const WYSIWYG_PREVIEW =
  '.vditor-wysiwyg__block[data-type="code-block"] > .vditor-wysiwyg__preview'
const PREVIEW_SELECTOR = `${IR_PREVIEW}, ${WYSIWYG_PREVIEW}`

// Editable code of the block that owns the preview.
const IR_CODE = ':scope > pre.vditor-ir__marker--pre > code'
const WYSIWYG_CODE = ':scope > pre:not(.vditor-wysiwyg__preview) > code'

/** The code block (IR node or WYSIWYG block) whose rendered preview contains `node`, or null. */
export function codeBlockOfPreview(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null)
  const preview = element?.closest(PREVIEW_SELECTOR)
  return (preview?.parentElement as HTMLElement | null | undefined) ?? null
}

/** The editable `<code>` of a code block, or null when the block has none. */
export function editableCodeOf(block: HTMLElement): HTMLElement | null {
  return block.querySelector<HTMLElement>(
    block.classList.contains('vditor-ir__node') ? IR_CODE : WYSIWYG_CODE,
  )
}

/**
 * Where the caret belongs to append a line: right after the last non-newline character of the
 * code text. Vditor keeps a trailing `\n` in the editable code; ending the caret after it would put
 * the new line one blank line too low. An empty code (only newlines or no text) puts the caret at
 * its first position.
 */
export function codeEndPosition(code: HTMLElement): {
  node: Node
  offset: number
} {
  const walker = code.ownerDocument.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  let first: Text | null = null
  let last: Text | null = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text
    first ??= text
    if (text.data.replace(/\n+$/, '') !== '') last = text
  }
  if (last) return { node: last, offset: last.data.replace(/\n+$/, '').length }
  return first ? { node: first, offset: 0 } : { node: code, offset: 0 }
}

const isPlainEnter = (event: KeyboardEvent): boolean =>
  event.key === 'Enter' &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.altKey &&
  !event.shiftKey

/**
 * Install the capture-phase relocation. `getEditor` returns the active IR/WYSIWYG editable (null in
 * SV, where this does nothing). Returns the disposer.
 */
export function setupCodeBlockPreviewEnter(
  getEditor: () => HTMLElement | null | undefined,
): () => void {
  const onKeydown = (event: KeyboardEvent) => {
    if (guardComposition(event) || !isPlainEnter(event)) return
    const editor = getEditor()
    if (!editor) return
    const selection = window.getSelection()
    if (!selection?.rangeCount || !selection.isCollapsed) return
    const anchor = selection.getRangeAt(0).startContainer
    if (!editor.contains(anchor)) return
    const block = codeBlockOfPreview(anchor)
    const code = block && editableCodeOf(block)
    if (!code) return
    const { node, offset } = codeEndPosition(code)
    selection.collapse(node, offset)
  }
  document.addEventListener('keydown', onKeydown, true)
  return () => document.removeEventListener('keydown', onKeydown, true)
}
