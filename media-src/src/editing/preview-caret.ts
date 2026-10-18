// Task 652 — give the editor's caret and selection back after Preview is turned off.
//
// Vditor's Preview handler hides the focused edit pane on "on" and shows it again on "off", and
// never touches the selection or focus (Preview.ts, node_modules/vditor). Hiding a focused pane
// makes the browser drop focus, and the webview's focus-restore path can then collapse the selection
// to its start (Task 651 saw "collapsed and moved"; whether `focusout` actually fires there is
// unmeasured until the real-VS-Code `[preview-caret-probe]` lines are read). So the selection is captured when Preview is
// turned on and written back, through the caret authority, when it is turned off.
//
// Capture: a capture-phase `click` on the button, which fires BEFORE Vditor's own target listener,
// so the real selection is still intact (the toolbar cancels `mousedown`, toolbar-scroll-guard.ts,
// so a real click does not move it). Restore: a bubble `click` registered after Vditor's listener
// (like Task 651's memory listener), by which time the edit pane is visible again.
//
// The restore MUST go through caret.ts: a still-live older intent would otherwise overwrite a
// directly written range on the next animation frame (the Task 649 finding), so turning Preview on
// retires the live intent and turning it off makes the snapshot the live intent.
import { invalidateCaret, requestCaret } from './caret'
import { activeModeElement } from '../util/source-map'

const CURRENT_CLASS = 'vditor-menu--current'
const DISABLED_CLASS = 'vditor-menu--disabled'

type Intent = Parameters<typeof requestCaret>[0]
type PointIntent = { node: Node; offset: number } | { textOffset: number }

export interface PreviewCaretDeps {
  getVditor(): unknown
  document: Document
  requestCaret(intent: Intent): boolean
  invalidateCaret(): void
}

interface Endpoint {
  node: Node
  offset: number
  textOffset: number
}

interface PreviewCaretSnapshot {
  editor: HTMLElement
  mode: string
  anchor: Endpoint
  focus: Endpoint
  /** `editor.contains(document.activeElement)` at capture. */
  hadFocus: boolean
}

function currentMode(vditor: unknown): string | undefined {
  return (vditor as { vditor?: { currentMode?: string } } | null)?.vditor
    ?.currentMode
}

// Same text space as caret-preserve.ts / caret.ts `{ textOffset }`: characters from the editor start.
function textOffsetOf(
  doc: Document,
  editor: HTMLElement,
  node: Node,
  offset: number,
): number {
  const range = doc.createRange()
  range.selectNodeContents(editor)
  range.setEnd(node, offset)
  return range.toString().length
}

function nodeLength(node: Node): number {
  return node.nodeType === Node.TEXT_NODE
    ? (node as Text).data.length
    : node.childNodes.length
}

function capture(deps: PreviewCaretDeps): PreviewCaretSnapshot | null {
  const vditor = deps.getVditor()
  const editor = activeModeElement(vditor)
  const mode = currentMode(vditor)
  const sel = deps.document.getSelection()
  if (!editor || !mode || !sel || sel.rangeCount === 0) return null
  const { anchorNode, anchorOffset, focusNode, focusOffset } = sel
  if (!anchorNode || !focusNode) return null
  if (!editor.contains(anchorNode) || !editor.contains(focusNode)) return null
  return {
    editor,
    mode,
    anchor: {
      node: anchorNode,
      offset: anchorOffset,
      textOffset: textOffsetOf(deps.document, editor, anchorNode, anchorOffset),
    },
    focus: {
      node: focusNode,
      offset: focusOffset,
      textOffset: textOffsetOf(deps.document, editor, focusNode, focusOffset),
    },
    hadFocus: editor.contains(deps.document.activeElement),
  }
}

// Exact nodes only while BOTH endpoints are still in the editor and their offsets fit; otherwise the
// document was rebuilt while Preview was open, so both endpoints use clamped character offsets
// (Owner decision Q1) and the two never mix coordinate spaces.
function exactlyResolvable(editor: HTMLElement, point: Endpoint): boolean {
  const { node, offset } = point
  return node.isConnected && editor.contains(node) && offset <= nodeLength(node)
}

function resolve(
  editor: HTMLElement,
  snap: PreviewCaretSnapshot,
): { anchor: PointIntent; focus: PointIntent } {
  if (
    exactlyResolvable(editor, snap.anchor) &&
    exactlyResolvable(editor, snap.focus)
  )
    return {
      anchor: { node: snap.anchor.node, offset: snap.anchor.offset },
      focus: { node: snap.focus.node, offset: snap.focus.offset },
    }
  return {
    anchor: { textOffset: snap.anchor.textOffset },
    focus: { textOffset: snap.focus.textOffset },
  }
}

function restore(
  snap: PreviewCaretSnapshot,
  deps: PreviewCaretDeps,
  button: HTMLElement,
): void {
  const vditor = deps.getVditor()
  const editor = activeModeElement(vditor)
  // A re-init or an edit-mode switch while Preview was up: the snapshot belongs to another editor.
  if (editor !== snap.editor || currentMode(vditor) !== snap.mode) return

  const doc = deps.document
  const previous = doc.activeElement
  const { anchor, focus } = resolve(editor, snap)
  const collapsed =
    snap.anchor.node === snap.focus.node &&
    snap.anchor.offset === snap.focus.offset

  // Focus returns only from a neutral place: nothing focused, the Preview button, or the editor
  // itself. A control the user focused during Preview (the Find input) keeps it.
  const neutral =
    previous === doc.body ||
    previous === button ||
    (previous !== null && editor.contains(previous))
  if (snap.hadFocus && neutral) editor.focus({ preventScroll: true })
  deps.requestCaret(collapsed ? anchor : { anchor, focus })

  // Writing a selection can move focus into the editable; a keyboard user who activated the button
  // keeps focus there (focus returns to the editor only if it was there at capture).
  if (
    !snap.hadFocus &&
    previous instanceof HTMLElement &&
    previous !== doc.body &&
    previous !== doc.activeElement
  )
    previous.focus({ preventScroll: true })
}

/**
 * Install the capture and restore listeners on the Preview button. Per-install state, so a
 * re-init (Disposables) drops a pending snapshot. Returns a disposer.
 */
export function installPreviewCaretRestore(
  button: HTMLElement,
  overrides: Partial<PreviewCaretDeps> = {},
): () => void {
  const deps: PreviewCaretDeps = {
    getVditor: () => (window as unknown as { vditor?: unknown }).vditor,
    document,
    requestCaret,
    invalidateCaret,
    ...overrides,
  }
  let snapshot: PreviewCaretSnapshot | null = null
  let wasOn = button.classList.contains(CURRENT_CLASS)

  const onCapture = () => {
    // Turning Preview off (or a disabled button, which Vditor ignores) captures nothing: the
    // snapshot taken when it went on is the one to restore.
    if (
      button.classList.contains(DISABLED_CLASS) ||
      button.classList.contains(CURRENT_CLASS)
    )
      return
    snapshot = capture(deps)
  }
  const onClick = () => {
    const on = button.classList.contains(CURRENT_CLASS)
    if (on === wasOn) {
      // The class did not change (a non-disabled click that Vditor treated as a no-op): a snapshot
      // the capture listener just took must not leak into a later toggle.
      if (!on) snapshot = null
      return
    }
    wasOn = on
    if (on) {
      // No older intent may write into the hidden editor while Preview shows.
      deps.invalidateCaret()
      return
    }
    const snap = snapshot
    snapshot = null
    if (snap) restore(snap, deps, button)
  }
  button.addEventListener('click', onCapture, true)
  button.addEventListener('click', onClick)
  return () => {
    button.removeEventListener('click', onCapture, true)
    button.removeEventListener('click', onClick)
  }
}
