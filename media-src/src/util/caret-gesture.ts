// Tasks 457/459 — the shared caret-gesture dispatcher behind `vmde.activateLinkAtCaret`.
//
// WHY THIS EXISTS: task 457 (activate the link under the caret) and task 459 (focus the callout
// popover's controls) both wanted one caret-triggered action. They originally shipped as TWO
// independent capture-phase `keydown` listeners on two DIFFERENT chords (459 used
// Ctrl/Cmd+Alt+Enter to avoid colliding with 457) — the user explicitly REJECTED that on
// 2026-07-31: one action, dispatched by whatever is under the caret (Obsidian's model), because a
// third modifier and `Ctrl+Alt` collide with AltGr on a Polish keyboard layout (AltGr+key produces
// ąćęłńóśżź). This module is the single registration API both callers use.
//
// Task 580 CP2-8: the webview no longer listens for Ctrl/Cmd+Enter. The only trigger is the
// unbound, rebindable `vmde.activateLinkAtCaret` command, which posts `activate-link-at-caret`
// (bridge/message-router.ts) and runs `runCaretGestureHandlers`. Ctrl/Cmd+Enter is left to VS Code
// and the browser. It gets no native guard: the CP1 probe P3 found no DOM, Markdown or selection
// effect from it in a bare contenteditable.
//
// Placement: `util/`, not `links/` or `editing/`. Both callers already have an allowed edge to
// `util/` (links->util, editing->util — see test/backend/module-boundaries.test.ts), so this file
// needs ZERO new allowlist entries; putting it in either caller's own module would have required
// one (task 460's standing rule is to move the file rather than widen the allowlist).
//
// Collapsed-selection-only: a dragged/extended selection over a link or callout is the user
// SELECTING text, not targeting an element — the action there must not activate anything, the same
// reasoning as links/caret-link.ts's `linkLikeInSelection`. That semantics is mirrored here (the
// collapsed check) rather than imported: `util/` cannot import `links/` (only the reverse edge is
// allowed), and the check itself is generic — "a gesture targets a caret, not a range" — not
// specific to links.
//
// Registration order is caller-controlled and IS load-bearing, not an implementation detail: a
// link-like element nested inside a callout blockquote (e.g. a wiki chip inside a `[!TIP]`) makes
// BOTH links/link-click-fix.ts's matcher and editing/callout-popover-keys.ts's matcher resolve to
// something non-null for the same caret position — `linkLikeAt` walks up to the nearest link,
// `calloutBlockquoteAt` walks up to the nearest callout blockquote, and a chip inside a callout
// satisfies both. Whichever module calls `registerCaretGesture` FIRST wins in that overlap.
// `fixLinkClick()` runs at module scope from boot/main.ts (imported once, at the top of the boot
// sequence); `installCalloutPopoverKeys()` runs later, per re-init, from finish-init.ts — so links
// register first today, and "activate the more specific/inner target" (the link, not its
// containing callout) is the correct precedence, not an accident of import order.
type CompositionKeyEvent = Pick<KeyboardEvent, 'isComposing' | 'keyCode'>
type CompositionStateListener = (active: boolean) => void

const compositionListeners = new Set<CompositionStateListener>()
let compositionActive = false

export function isCompositionActive(): boolean {
  return compositionActive
}

/** Canonical early-return predicate for VMDE key handlers. Chromium reports modern IME input
 * through `isComposing`; keyCode 229 preserves the same protection for older/dead-key paths. */
export function guardComposition(event: CompositionKeyEvent): boolean {
  return compositionActive || event.isComposing || event.keyCode === 229
}

export function subscribeCompositionState(
  listener: CompositionStateListener,
): () => void {
  compositionListeners.add(listener)
  return () => compositionListeners.delete(listener)
}

function setCompositionActive(doc: Document, next: boolean): void {
  if (compositionActive === next) return
  compositionActive = next
  doc.documentElement.toggleAttribute('data-vmde-composing', next)
  for (const listener of compositionListeners) listener(next)
}

/** Install the single composition lifecycle authority before any capture-phase key handlers. */
export function installCompositionState(doc: Document = document): () => void {
  const onStart = () => setCompositionActive(doc, true)
  const onEnd = () => setCompositionActive(doc, false)
  doc.addEventListener('compositionstart', onStart, true)
  doc.addEventListener('compositionend', onEnd, true)
  return () => {
    doc.removeEventListener('compositionstart', onStart, true)
    doc.removeEventListener('compositionend', onEnd, true)
    setCompositionActive(doc, false)
  }
}

export type CaretGestureMatch = (node: Node | null) => HTMLElement | null
export type CaretGestureHandle = (el: HTMLElement) => boolean

interface Registration {
  match: CaretGestureMatch
  handle: CaretGestureHandle
}

const registrations: Registration[] = []

function collapsedCaretNode(): Node | null {
  const sel = window.getSelection()
  if (!sel?.isCollapsed) return null
  return sel.anchorNode
}

// Try every registered handler, in registration order, against the current collapsed caret
// position. The first one whose `match` resolves an element AND whose `handle` returns true wins;
// a `match` hit whose `handle` declines (e.g. a link-like element with no resolvable href) falls
// through to the next registration rather than stopping dispatch — `handle` returning false is a
// "not actually actionable here" signal, not a "stop looking" one.
function dispatch(): boolean {
  const node = collapsedCaretNode()
  if (!node) return false
  for (const { match, handle } of registrations) {
    const el = match(node)
    if (el && handle(el)) return true
  }
  return false
}

// The `vmde.activateLinkAtCaret` command's trigger (bridge/message-router.ts's
// `activate-link-at-caret` handler). Reports whether a registered handler activated something.
export function runCaretGestureHandlers(): boolean {
  return dispatch()
}

/** Register a caret-gesture handler for `vmde.activateLinkAtCaret`. `match` resolves the
 *  caret's current (collapsed-selection) node to this handler's target element, or null if it
 *  doesn't apply here. `handle` performs the gesture and returns whether it actually did
 *  anything — a false lets dispatch fall through to the next registration. Handlers are tried in
 *  REGISTRATION order (see the module header for why that's load-bearing). Returns a disposer that
 *  removes just this registration. */
export function registerCaretGesture(
  match: CaretGestureMatch,
  handle: CaretGestureHandle,
): () => void {
  const reg: Registration = { match, handle }
  registrations.push(reg)
  return () => {
    const idx = registrations.indexOf(reg)
    if (idx !== -1) registrations.splice(idx, 1)
  }
}
