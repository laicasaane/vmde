// Task 459 — keyboard reach into the callout popover's controls (WYSIWYG only: `calloutWysiwygToolbar`
// in callouts.ts appends a type `<select>` + title `<input>` to Vditor's floating block popover when
// the caret is inside a `[!TYPE]` blockquote; IR/Preview have no such popover, see callouts.ts's
// header comment).
//
// Why a dedicated chord instead of Tab: `tab: '\t'` (vditor-init.ts) makes Vditor `preventDefault()`
// every Tab inside the editable surface — measured dead for reaching in-document targets (task 457).
// The popover is a SIBLING of the contenteditable `<pre>` (`wysiwyg/index.ts`'s constructor builds
// `.vditor-panel` divs next to it, not inside it), so Tab can never reach it either way. This
// originally shipped as its OWN chord (Ctrl/Cmd+Alt+Enter) to avoid colliding with
// link-click-fix.ts's Ctrl/Cmd+Enter — the user REJECTED that on 2026-07-31: a third modifier plus
// `Ctrl+Alt` collides with AltGr on a Polish keyboard layout (AltGr+key produces ąćęłńóśżź), and the
// decided model (Obsidian's) is ONE chord dispatched by whatever is under the caret. This now
// registers against the shared dispatcher (util/caret-gesture.ts) instead of owning a listener.
// Task 580 CP2-8: that dispatcher's trigger is the unbound `vmde.activateLinkAtCaret` command;
// Ctrl/Cmd+Enter no longer acts in the webview.
//
// Once focus is inside the popover, native Tab/Shift+Tab between its controls (select/input/the
// existing ∧∨🗑 buttons) works for FREE — verified: Vditor's Tab handling (`hotkeyEvent`) is bound
// via `addEventListener('keydown', …)` directly on `this.element` (the contenteditable), so it only
// ever sees events whose propagation path includes that node. The popover's controls are siblings,
// outside that subtree, so their keydowns never reach it at all — no roving-tabindex needed here,
// unlike the toolbar (456) or outline (458), which live in a real ordered set Arrow keys must drive.
//
// Escape (while focus is inside the popover) returns focus AND the caret to the editor, via the same
// snapshot/restore pair task 456 already proved is required: focusing a `<select>`/`<button>` isn't
// text-selectable, so it collapses the live Range — re-focusing the editor alone leaves it with
// Chrome's own default caret (start of document) instead of where the user actually was.
import { guardComposition, registerCaretGesture } from '../util/caret-gesture'
import { activeModeElement } from '../util/source-map'
import { innerVditor } from '../util/inner-vditor'
import { restoreEditorCaretIfLost } from './editor-caret'

const TYPE_SELECT = '.vmde-callout__type'

function isBareEscape(e: KeyboardEvent): boolean {
  return (
    !guardComposition(e) &&
    e.key === 'Escape' &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey
  )
}

// The popover only carries our type/title controls when it's currently showing a CALLOUT blockquote
// (calloutWysiwygToolbar appends them); an ordinary blockquote's popover has only ∧∨🗑. Gate on the
// select's presence rather than trusting the caret snapshot below — the popover could in principle be
// stale relative to a caret that has since moved (defensive; cheap to check).
function calloutPopoverSelect(): HTMLSelectElement | null {
  const popover = innerVditor()?.wysiwyg?.popover
  return popover?.querySelector<HTMLSelectElement>(TYPE_SELECT) ?? null
}

// The `match` half of this module's caret-gesture registration (util/caret-gesture.ts calls this
// with the caret's collapsed-selection node — see that module's `CaretGestureMatch` type). Pure
// node-in/element-out, mirroring links/caret-link.ts's `linkLikeAt` shape.
function calloutBlockquoteAt(node: Node | null): HTMLElement | null {
  if (!node) return null
  const host = node.nodeType === 1 ? (node as Element) : node.parentElement
  const bq = host?.closest('blockquote')
  return (
    bq?.closest('.vditor-ir, .vditor-wysiwyg') ? bq : null
  ) as HTMLElement | null
}

// The `handle` half — focuses the popover's type select if the matched blockquote's popover
// currently carries one (calloutPopoverSelect's own comment explains why that's re-checked here
// rather than trusted from the match). Returns false (not "no", but "not actionable here" — see
// caret-gesture.ts's fall-through contract) when the popover isn't currently showing our controls,
// so dispatch can still fall through to another registration for the same caret position.
function focusCalloutPopover(): boolean {
  if (window.__vmdeOpenContextualCalloutControls?.()) return true
  const select = calloutPopoverSelect()
  if (!select) return false
  select.focus({ preventScroll: true })
  return true
}

function returnFocusToEditor(): void {
  const editor = activeModeElement(window.vditor)
  if (!editor) return
  // Order matters (task 456): restore the Range while focus is still on the popover control (so
  // editor-caret.ts's "already has a real caret" guard doesn't wrongly bail on nothing), THEN focus.
  restoreEditorCaretIfLost()
  editor.focus({ preventScroll: true })
}

// Escape-to-dismiss is a widget-local dialog key (Task 580 keeps it): its own capture-phase
// document listener, not routed through the shared caret-gesture dispatcher, which only the
// `vmde.activateLinkAtCaret` command triggers (see caret-gesture.ts).
function onKeydown(e: KeyboardEvent): void {
  if (!isBareEscape(e)) return
  const select = calloutPopoverSelect()
  const active = document.activeElement
  if (!select || !active || !select.parentElement?.contains(active)) return
  // stopImmediatePropagation: escape-toolbar.ts's global Escape/Tab arm listener is also a
  // document-capture listener — without this it would ALSO see this Escape and arm its one-shot
  // "next Tab leaves to the toolbar" flag, a harmless but confusing side effect of a keypress this
  // module already fully handles.
  e.preventDefault()
  e.stopImmediatePropagation()
  returnFocusToEditor()
}

let bound: ((e: KeyboardEvent) => void) | null = null
let unregisterGesture: (() => void) | null = null

/** Install the Escape (return focus + caret to the editor) listener, and register this module's
 *  Activate Link at Caret handler (focus the callout popover's controls) with the shared
 *  caret-gesture dispatcher (util/caret-gesture.ts — task 459's unification with link-click-fix.ts).
 *  Idempotent across re-inits: both the Escape listener and the gesture registration are torn down
 *  and re-installed, not stacked — `installCalloutPopoverKeys` runs once per Vditor re-init
 *  (finish-init.ts), so without this a re-init would leave N duplicate registrations answering the
 *  same chord. Returns a single disposer covering both. */
export function installCalloutPopoverKeys(): () => void {
  if (bound) document.removeEventListener('keydown', bound, true)
  bound = onKeydown
  document.addEventListener('keydown', bound, true)

  unregisterGesture?.()
  unregisterGesture = registerCaretGesture(
    calloutBlockquoteAt,
    focusCalloutPopover,
  )

  return () => {
    if (bound) document.removeEventListener('keydown', bound, true)
    bound = null
    unregisterGesture?.()
    unregisterGesture = null
  }
}
