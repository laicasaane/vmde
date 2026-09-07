// Task 456 — DOM wiring for the Escape→Tab "leave the editor" gesture (WCAG 2.1.2 keyboard trap
// fix) plus the toolbar it lands on: role="toolbar" + roving tabindex + ArrowLeft/Right traversal
// (escaping into a toolbar you cannot move around in is not an escape). The pure arm/disarm state
// machine lives in escape-arm.ts (unit-tested there, no DOM); this file only classifies real
// KeyboardEvents, drives the toolbar DOM, and installs the listener.
//
// Capture-phase document listener, same shape as list-backspace.ts: Vditor binds its own Tab
// handling (fixList's list-indent branch, fixTab's insert-a-tab-character branch,
// fixBrowserBehavior.ts) on the editor element in the BUBBLE phase, so intercepting in capture,
// before that runs, is what lets us swallow the consumed Tab without a stray "\t" ever reaching
// the document — and leaves every OTHER Tab (no preceding Escape) to fall through untouched, which
// is what keeps Tab-as-indent working for ordinary editing.
//
// Root-cause note (kept for the next reader — the actual investigation lives in the task 456
// thread, not reproduced here): the real-VS-Code-only "focus never moves" failure was NOT a focus
// bounce. A 4-round instrumented investigation showed the escape gesture's `.focus()` call
// genuinely works — round 4's focusin log landed cleanly on the toolbar button with no bounce. What
// broke was a synchronous `document.activeElement` read taken inside the same call stack as
// `.focus()`, which is stale in the real webview (the harness never reproduced it because a
// same-stack read happens to be fresh there). The REAL bug this surfaced was in
// `returnFocusToEditor()` below: focusing a `<button>` collapses the browser's Selection (buttons
// aren't text-selectable), so simply re-focusing the editor afterward leaves it focused but with NO
// caret Range — typing and Tab do nothing. Fixed by restoring the caret explicitly instead of
// assuming focus alone preserves it (round 9 replaced the shared editor-caret.ts snapshot with this
// module's own capture — see rangeBeforeToolbar below for why the shared one is wrong HERE).
import { type EscapeArmKeyKind, createEscapeArmState } from './escape-arm'
import { requestCaret } from './caret'
import { restoreEditorCaretIfLost } from '../editing/editor-caret'
import { innerVditor } from '../util/inner-vditor'
import { activeModeElement } from '../util/source-map'
import { nextRovingIndex } from '../util/roving-tabindex'
import {
  SUBMENU_TRIGGER_NAMES,
  submenuMenuItems,
  submenuPanel,
} from '../chrome/toolbar-submenu-aria'
import { guardComposition } from '../util/caret-gesture'
import { toolbarRows } from '../chrome/toolbar-layout'

// Bare modifier keydowns routinely PRECEDE the real key of a combo (Shift fires before Tab in a
// Shift+Tab press) — classify() must never let one disarm the machine on its own.
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'])

// Classify one real KeyboardEvent for the pure state machine. Only a COMPLETELY unmodified Escape
// or Tab counts as the gesture:
//  - Ctrl/Alt/Meta+Tab is a VS Code / OS chord (editor-group navigation, app switcher) and must
//    fall through untouched — never consumed as our escape gesture (and, since it classifies as
//    'other' below, it also disarms an armed flag exactly like any other non-Tab key would).
//  - Shift+Tab is a distinct combo; task 456 scope item 3 (Shift+Tab-from-document-start as the
//    reverse gesture) is not implemented here, so it is also just 'other'.
function classify(e: KeyboardEvent): EscapeArmKeyKind {
  if (guardComposition(e) || MODIFIER_KEYS.has(e.key)) return 'ignore'
  const bare = !e.ctrlKey && !e.metaKey && !e.altKey
  if (e.key === 'Escape' && bare) return 'escape'
  if (e.key === 'Tab' && bare && !e.shiftKey) return 'tab'
  return 'other'
}

// The focusable target inside one top-level toolbar item is always `.firstElementChild` — verified
// across every Vditor toolbar item class (MenuItem/Headings/Emoji/Preview/Undo/Upload/…, all bind
// their click handler on `this.element.children[0]`). Dividers (`vditor-toolbar__divider`) and
// spacers (`vditor-toolbar__br`) are direct children of the toolbar too but carry no such target,
// and are excluded by the `.vditor-toolbar__item` check. Walking the toolbar's own DOM children
// (rather than `toolbar.elements`, whose keys include the dividers) also naturally excludes
// level-2 submenu buttons: their panel is appended INSIDE the level-1 item wrapper, so it's never a
// direct child of the toolbar container.
function rovingItems(toolbarEl: HTMLElement): HTMLElement[] {
  const items: HTMLElement[] = []
  const rows = toolbarRows(toolbarEl)
  for (const row of rows.length ? rows : [toolbarEl]) {
    for (const child of Array.from(row.children)) {
      if (
        child instanceof HTMLElement &&
        child.classList.contains('vditor-toolbar__item') &&
        getComputedStyle(child).display !== 'none'
      ) {
        const target = child.firstElementChild
        if (target instanceof HTMLElement) items.push(target)
      }
    }
  }
  return items
}

// Set up (or re-affirm) role="toolbar" + roving tabindex: exactly one item is tabIndex 0 (the one
// Tab lands on / that Tab-out-of-the-toolbar leaves from), the rest -1. Idempotent — preserves
// whichever item currently holds the 0 (e.g. across a repeat call) instead of always resetting to
// the first item, and safe to call before the user has ever reached the toolbar (defaults to the
// first item then).
function initRoving(toolbarEl: HTMLElement): HTMLElement[] {
  const items = rovingItems(toolbarEl)
  if (items.length === 0) return items
  toolbarEl.setAttribute('role', 'toolbar')
  toolbarEl.setAttribute('aria-orientation', 'horizontal')
  const current = items.find((el) => el.tabIndex === 0) ?? items[0]
  for (const el of items) el.tabIndex = el === current ? 0 : -1
  return items
}

const MENU_NAV_KEYS = new Set([
  'ArrowDown',
  'ArrowUp',
  'ArrowRight',
  'ArrowLeft',
  'Home',
  'End',
])

// `more`'s own rows keep this exact shape for refreshToolbarRoving below (F3: clearing the stale
// tabIndex=-1 an overflow move leaves behind). It is the only one of the four panels where that can
// happen — items are only ever moved OUT of the row's roving set into `more`, never into the other
// three, whose own rows are plain native buttons (tabIndex 0 by default) untouched by initRoving.
function overflowMenuItems(toolbarEl: HTMLElement): HTMLElement[] {
  const panel = submenuPanel(toolbarEl, 'more')
  return panel ? submenuMenuItems(panel) : []
}

// Task 492 Phase 5: the same arrow/Home/End navigation now covers `emoji`/`headings`/`edit-mode`'s
// own panels too, not just `more`'s — found by checking which of the four known panels currently
// contains focus. submenuPanel resolves each trigger's own nested panel wherever it currently lives
// (row or inside `more`, F4), so this works regardless of overflow state.
function activeSubmenuItems(
  toolbarEl: HTMLElement,
  activeEl: Element | null,
): HTMLElement[] {
  if (!(activeEl instanceof HTMLElement)) return []
  for (const name of [...SUBMENU_TRIGGER_NAMES].reverse()) {
    const panel = submenuPanel(toolbarEl, name)
    if (panel?.contains(activeEl)) return submenuMenuItems(panel)
  }
  return []
}

// Arrow/Home/End inside the more menu reuse the shared wrap helper rather than re-deriving it, but
// deliberately NOT moveRovingFocus: every menu row stays tabIndex 0 (the pre-existing Settings /
// About rows were plain tabbable buttons before the overflow existed, and roving would take that
// away). Only focus moves here; tabbability is owned by refreshToolbarRoving.
function moveOverflowMenuFocus(items: HTMLElement[], direction: 1 | -1): void {
  if (items.length === 0) return
  const from = items.indexOf(document.activeElement as HTMLElement)
  items[nextRovingIndex(from, direction, items.length)]?.focus({
    preventScroll: true,
  })
}

function focusOverflowMenuEdge(items: HTMLElement[], end: boolean): void {
  items[end ? items.length - 1 : 0]?.focus({ preventScroll: true })
}

/** Re-assert row roving state after toolbar items are moved into or out of the more menu. */
export function refreshToolbarRoving(toolbarEl: HTMLElement): void {
  initRoving(toolbarEl)
  for (const item of overflowMenuItems(toolbarEl)) item.tabIndex = 0
}

// ArrowLeft/Right traversal within the toolbar (ARIA "roving tabindex" toolbar pattern — wraps
// around at either end, matching the WAI-ARIA authoring practice for toolbars).
function moveRoving(toolbarEl: HTMLElement, direction: 1 | -1): void {
  const items = rovingItems(toolbarEl)
  if (items.length === 0) return
  const activeIndex = items.indexOf(document.activeElement as HTMLElement)
  const from = activeIndex >= 0 ? activeIndex : 0
  const next = items[(from + direction + items.length) % items.length]
  for (const el of items) el.tabIndex = el === next ? 0 : -1
  next.focus({ preventScroll: true })
}

// Move focus to whichever toolbar item currently holds tabindex 0 (the roving-tabindex "current"
// item), initializing roving state first if this is the very first arrival.
function focusToolbar(): void {
  const toolbarEl = innerVditor()?.toolbar?.element
  if (!toolbarEl) return
  const items = initRoving(toolbarEl)
  const current = items.find((el) => el.tabIndex === 0) ?? items[0]
  current?.focus({ preventScroll: true })
}

function toolbarHasFocus(): boolean {
  const toolbarEl = innerVditor()?.toolbar?.element
  const active = document.activeElement
  return !!toolbarEl && !!active && toolbarEl.contains(active)
}

// Task 456 bug 2, ROOT CAUSE MEASURED (round 9, real VS Code). For a window of a few hundred ms
// after the Tab keydown, a `.focus()` on the toolbar button simply does not take: the element is
// connected, visible, `document.hasFocus()` is true, the roving state is correct, and focus stays on
// the editor at +0/+1/+2 frames and +200 ms. THE SAME CALL, on THE SAME element, from THE SAME
// function, LANDS at +600 ms (`PRE → BUTTON`, and it sticks). So the blocker is TIME, not the
// element, the caller, or the call stack — which is why every earlier round's one-shot fix (moving
// the call, stopImmediatePropagation, deferring by one frame) failed identically. The mechanism
// inside VS Code's webview host is not visible to page-level JS; what IS measurable is that it
// expires on its own.
//
// So: re-attempt on every animation frame until the focus actually lands, or the budget runs out.
// Checking on the NEXT frame rather than synchronously after focus() is deliberate — a same-stack
// `document.activeElement` read is documented (file header, round 4) to be stale in the real
// webview, and this loop must never declare victory on a stale read.
const FOCUS_RETRY_MS = 1500 // ~3x the measured landing time, still well under "the user gave up"
let retryRaf = 0

function cancelToolbarFocusRetry(): void {
  if (retryRaf) cancelAnimationFrame(retryRaf)
  retryRaf = 0
}

// A real user gesture always wins (the same rule caret.ts's invalidation follows): if the user types
// or clicks while this is still retrying, the gesture cancels it rather than yanking focus away
// from whatever they just did.
function retryFocusToolbarUntilItLands(): void {
  cancelToolbarFocusRetry()
  const deadline = performance.now() + FOCUS_RETRY_MS
  const attempt = () => {
    retryRaf = 0
    if (toolbarHasFocus()) return
    // The user switched away from this webview mid-retry — the gesture is moot, and fighting VS Code
    // for focus in a document they have left is the mistake focus-restore.ts's task 445 addendum
    // documents. (Measured irrelevant to the fix itself: docHasFocus stayed true throughout the dead
    // window; this is about what happens when the user leaves, not about landing the focus.)
    if (!document.hasFocus()) return
    if (performance.now() > deadline) return
    focusToolbar()
    retryRaf = requestAnimationFrame(attempt)
  }
  attempt()
}

// The exact Range the caret held when the gesture took focus away — captured by the gesture itself
// rather than read back from editor-caret.ts's shared snapshot on the way home.
//
// Task 456 round 9, MEASURED once bug 2 stopped hiding this leg: the shared snapshot is not
// trustworthy across this particular round trip. Focusing the toolbar <button> collapses the
// Selection into the editor's FIRST text node (Chrome's default for a contenteditable with no live
// Range), the resulting `selectionchange` is a perfectly ordinary-looking caret as far as
// editor-caret.ts's tracker is concerned — its "ignore the focus-loss artifact" guard only skips
// `node === editor && offset 0`, not "offset 0 of the first text node" — so the good position is
// overwritten by a bogus one BEFORE anything asks for it back. The user then returns from the
// toolbar with a live, working caret parked at the top of the document: typing lands (measured: an
// "x" appeared inside the H1), just nowhere near where they left off. Landing the user at the start
// of the document is the damaging variant of this bug, not the fix for it (same rule as
// focus-restore.ts's own snapshot-before-focus).
let rangeBeforeToolbar: Range | null = null

export interface ToolbarSelectionOrigin {
  range: Range
  backward: boolean
  editor: HTMLElement
}

interface OriginLeaf {
  element: HTMLElement
  text: string
}

interface ToolbarSelectionOriginRecord extends ToolbarSelectionOrigin {
  outer: NonNullable<Window['vditor']>
  inner: NonNullable<ReturnType<typeof innerVditor>>
  mode: string
  startLeaf: OriginLeaf
  endLeaf: OriginLeaf
}

let provisionalToolbarSelectionOrigin: ToolbarSelectionOriginRecord | null =
  null
let consumedToolbarSelectionOrigin: ToolbarSelectionOriginRecord | null = null

function endpointLeaf(editor: HTMLElement, node: Node): HTMLElement | null {
  let element = node instanceof HTMLElement ? node : node.parentElement
  if (!element) return null
  while (element.parentElement && element.parentElement !== editor)
    element = element.parentElement
  return element.parentElement === editor ? element : null
}

function offsetIsValid(node: Node, offset: number): boolean {
  const limit = node instanceof Text ? node.data.length : node.childNodes.length
  return Number.isInteger(offset) && offset >= 0 && offset <= limit
}

function validToolbarSelectionOrigin(
  origin: ToolbarSelectionOriginRecord,
): boolean {
  const outer = window.vditor
  const inner = innerVditor()
  const { editor, range, startLeaf, endLeaf } = origin
  return Boolean(
    outer === origin.outer &&
      inner === origin.inner &&
      inner?.currentMode === origin.mode &&
      activeModeElement(outer) === editor &&
      editor.isConnected &&
      range.startContainer.isConnected &&
      range.endContainer.isConnected &&
      editor.contains(range.startContainer) &&
      editor.contains(range.endContainer) &&
      offsetIsValid(range.startContainer, range.startOffset) &&
      offsetIsValid(range.endContainer, range.endOffset) &&
      startLeaf.element.isConnected &&
      endLeaf.element.isConnected &&
      editor.contains(startLeaf.element) &&
      editor.contains(endLeaf.element) &&
      startLeaf.element.textContent === startLeaf.text &&
      endLeaf.element.textContent === endLeaf.text,
  )
}

function clearToolbarSelectionOrigin(): void {
  provisionalToolbarSelectionOrigin = null
  consumedToolbarSelectionOrigin = null
}

/** Return a clone of the original editor selection after Escape→Tab reaches the toolbar. */
export function peekConsumedToolbarSelectionOrigin(): ToolbarSelectionOrigin | null {
  const origin = consumedToolbarSelectionOrigin
  if (!origin || !validToolbarSelectionOrigin(origin)) return null
  return {
    range: origin.range.cloneRange(),
    backward: origin.backward,
    editor: origin.editor,
  }
}

/** Clear the consumed Escape→Tab session, reporting whether there was one to consume. */
export function consumeToolbarSelectionOrigin(): boolean {
  const consumed = consumedToolbarSelectionOrigin !== null
  consumedToolbarSelectionOrigin = null
  return consumed
}

function captureToolbarSelectionOrigin(
  editor: HTMLElement,
  selection: Selection,
  range: Range,
): void {
  provisionalToolbarSelectionOrigin = null
  const outer = window.vditor
  const inner = innerVditor()
  const startLeaf = endpointLeaf(editor, range.startContainer)
  const endLeaf = endpointLeaf(editor, range.endContainer)
  const mode = inner?.currentMode
  if (
    !outer ||
    !inner ||
    !mode ||
    !selection.anchorNode ||
    !selection.focusNode ||
    !editor.contains(selection.anchorNode) ||
    !editor.contains(selection.focusNode) ||
    !startLeaf ||
    !endLeaf ||
    !offsetIsValid(range.startContainer, range.startOffset) ||
    !offsetIsValid(range.endContainer, range.endOffset)
  )
    return
  provisionalToolbarSelectionOrigin = {
    outer,
    inner,
    editor,
    mode,
    range: range.cloneRange(),
    backward:
      selection.anchorNode === range.endContainer &&
      selection.anchorOffset === range.endOffset,
    startLeaf: { element: startLeaf, text: startLeaf.textContent ?? '' },
    endLeaf: { element: endLeaf, text: endLeaf.textContent ?? '' },
  }
}

function captureEditorRange(captureActionOrigin = true): void {
  rangeBeforeToolbar = null
  if (captureActionOrigin) provisionalToolbarSelectionOrigin = null
  const editor = activeModeElement(window.vditor)
  const sel = window.getSelection()
  if (!editor || !sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  if (
    editor.contains(range.startContainer) &&
    editor.contains(range.endContainer)
  ) {
    rangeBeforeToolbar = range.cloneRange()
    if (captureActionOrigin) captureToolbarSelectionOrigin(editor, sel, range)
  }
}

// Escape while a toolbar item is focused returns focus to the editor (the reciprocal of
// escapeToolbar — arriving in a toolbar you cannot leave again is not an escape).
//
// Focusing the toolbar button in focusToolbar() above collapses the browser's Selection: a
// <button> isn't text-selectable, so moving DOM focus there clears/collapses whatever Range was
// live in the editor. Simply calling editor.focus() here again does NOT bring it back — MEASURED
// (chromium harness): a contenteditable with no live Range gets Chrome's own default caret on
// focus (the first text node, offset 0), which is a REAL live-and-collapsed selection, just the
// wrong one — Vditor's Tab/typing handlers have something to act on, but at the wrong position,
// which reads as "the editor is broken" the moment the user types (task 456 root-cause).
//
// ORDER MATTERS, and this follows focus-restore.ts's proven order, not the naive one: restore the
// Range FIRST, while focus is still on the toolbar button, THEN focus() — a Range already set on an
// element survives that element being focused, whereas an element focused with NO Range gets
// Chrome's default one. The write goes through caret.ts's requestCaret (ADR-0007), and
// restoreEditorCaretIfLost() stays as the fallback for the one case our own capture cannot cover:
// the gesture was never the thing that moved focus (a re-init swapped the editor out underneath it,
// so the captured Range's nodes are gone).
function returnFocusToEditor(): void {
  clearToolbarSelectionOrigin()
  const editor = activeModeElement(window.vditor)
  if (!editor) return
  const saved = rangeBeforeToolbar
  if (
    saved?.startContainer.isConnected &&
    editor.contains(saved.startContainer)
  )
    requestCaret({
      node: saved.startContainer,
      offset: saved.startOffset,
    })
  else restoreEditorCaretIfLost()
  editor.focus({ preventScroll: true })
}

let armState = createEscapeArmState()

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one capture-phase dispatcher must preserve the existing editor, toolbar, and escape semantics
function onKeydown(e: KeyboardEvent): void {
  const kind = classify(e)
  if (kind === 'ignore') return
  // Any real key ends a pending retry — including the Tab that is about to start a fresh one below.
  cancelToolbarFocusRetry()

  const toolbarEl = innerVditor()?.toolbar?.element ?? null
  const activeEl = document.activeElement
  const focusInToolbar =
    !!toolbarEl && !!activeEl && toolbarEl.contains(activeEl)

  if (
    focusInToolbar &&
    (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey
  ) {
    e.preventDefault()
    moveRoving(toolbarEl as HTMLElement, e.key === 'ArrowRight' ? 1 : -1)
    return
  }

  // Cheap key test first, then ONE menu scan shared by the guard and the move. Covers all four
  // submenu panels (`more`, `emoji`, `headings`, `edit-mode`) — activeSubmenuItems only returns
  // rows from whichever one currently has focus, so an empty result IS the "not in a menu" guard.
  if (focusInToolbar && MENU_NAV_KEYS.has(e.key)) {
    const menuItems = activeSubmenuItems(toolbarEl as HTMLElement, activeEl)
    if (menuItems.length > 0) {
      e.preventDefault()
      if (e.key === 'Home' || e.key === 'End')
        focusOverflowMenuEdge(menuItems, e.key === 'End')
      else
        moveOverflowMenuFocus(
          menuItems,
          e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1,
        )
      return
    }
  }

  // Deliberately no preventDefault/stopPropagation here: Vditor's own bubble-phase Escape handling
  // (closing an open hint/sub-menu panel) must still run. This only adds a focus-return side effect.
  if (kind === 'escape' && focusInToolbar) {
    returnFocusToEditor()
    return
  }

  const action = armState.handle(kind)
  if (action === 'armed') {
    // Structural selection's later capture listener also handles this Escape and may widen the
    // caret to a block. Preserve the position that existed when the escape gesture began; the
    // toolbar round trip must return there, not to that transient widened range's start.
    captureEditorRange()
  }
  if (action === 'consumed') {
    // kind === 'tab' and the machine was armed: swallow it here in CAPTURE phase, before Vditor's
    // own bubble-phase Tab handling ever runs, so no "\t" is inserted — then move focus instead.
    //
    // stopImmediatePropagation (not just stopPropagation): the established convention for a
    // capture-phase key interceptor in this codebase (undo-keybind.ts, gap-paragraph.ts, gap-nav.ts,
    // callout-nav.ts, diagram-zoom-gate.ts all do this). Tried specifically as a candidate fix for
    // task 456's real-VS-Code-only focus-landing flake (~1-in-6 pass rate) and measured NOT to
    // change the pass rate — see the task file's investigation log before assuming this line fixes
    // anything. Kept anyway, on convention grounds: leaving plain stopPropagation here would be an
    // inconsistency with every sibling interceptor for no benefit.
    // preventDefault/stopImmediatePropagation MUST stay synchronous — deferring them would let the
    // "\t" reach the document before we ever ran. Only the focus move retries (see above).
    e.preventDefault()
    e.stopImmediatePropagation()
    if (!rangeBeforeToolbar) captureEditorRange(false)
    consumedToolbarSelectionOrigin = provisionalToolbarSelectionOrigin
    provisionalToolbarSelectionOrigin = null
    retryFocusToolbarUntilItLands()
  }
  if (action === 'disarmed') provisionalToolbarSelectionOrigin = null
  // 'armed' (bare Escape in/near the editor): no preventDefault — just the internal flag.
  // 'disarmed' / 'none': let the key behave exactly as if this listener didn't exist — this is what
  // keeps ordinary Tab-to-indent working (a Tab with no preceding Escape classifies 'none' and
  // falls straight through to Vditor's own fixTab, which inserts the tab character).
}

let bound: ((e: KeyboardEvent) => void) | null = null

/**
 * Install the capture-phase Escape/Tab listener + the toolbar's role="toolbar"/roving-tabindex
 * setup. Idempotent across re-inits (removes the prior listener; starts a fresh one-shot arm state
 * so a stale 'armed' flag from before a re-init can't leak into the new session).
 */
export function installEscapeToolbar(): () => void {
  if (bound) document.removeEventListener('keydown', bound, true)
  clearToolbarSelectionOrigin()
  armState = createEscapeArmState()
  bound = onKeydown
  document.addEventListener('keydown', bound, true)
  // A click is a real gesture too: it must end a pending focus retry, or a Tab-then-click would pull
  // focus onto the toolbar after the user had already aimed somewhere else.
  const invalidateForGesture = (event: Event) => {
    cancelToolbarFocusRetry()
    const target = event.target
    const editor = activeModeElement(window.vditor)
    const toolbar = innerVditor()?.toolbar?.element
    if (
      !target ||
      (editor?.contains(target as Node) ?? false) ||
      !(toolbar?.contains(target as Node) ?? false)
    )
      clearToolbarSelectionOrigin()
  }
  const invalidateForInput = () => clearToolbarSelectionOrigin()
  const invalidateForToolbarExit = (event: FocusEvent) => {
    const toolbar = innerVditor()?.toolbar?.element
    if (toolbar && !toolbar.contains(event.relatedTarget as Node | null))
      clearToolbarSelectionOrigin()
  }
  document.addEventListener('pointerdown', invalidateForGesture, true)
  document.addEventListener('input', invalidateForInput, true)
  document.addEventListener('focusout', invalidateForToolbarExit, true)
  const toolbarEl = innerVditor()?.toolbar?.element
  if (toolbarEl) refreshToolbarRoving(toolbarEl)
  return () => {
    if (bound) document.removeEventListener('keydown', bound, true)
    document.removeEventListener('pointerdown', invalidateForGesture, true)
    document.removeEventListener('input', invalidateForInput, true)
    document.removeEventListener('focusout', invalidateForToolbarExit, true)
    cancelToolbarFocusRetry()
    clearToolbarSelectionOrigin()
    bound = null
  }
}
