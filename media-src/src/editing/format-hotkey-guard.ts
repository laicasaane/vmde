// Task 505 — a gap the "one owner per key" design didn't anticipate: setting `hotkey: ''` on a
// Vditor toolbar item (toolbar.ts) disables Vditor's OWN keydown handler, but it does nothing
// about the BROWSER's built-in contenteditable editing commands. Chromium natively intercepts
// Ctrl/Cmd+B, +I, +U inside a `contenteditable` element (`.vditor-ir` is one) and runs
// `execCommand('bold'|'italic'|'underline')` unless the keydown is prevented — previously Vditor's
// own handler called `event.preventDefault()` on a match, which incidentally suppressed this too.
// Removing that handler (hotkey: '') removes that suppression as a side effect.
//
// Measured without this module (real VS Code, real keypress): a single Ctrl+B on a selection
// produced `Hello ****world.` instead of `Hello **world**.` — the browser's native bold command
// ran INSIDE the same keydown, ahead of / alongside the VS Code command's async postMessage round
// trip, corrupting the DOM before `vmde.format.bold` ever got a chance to act.
//
// `preventDefault()` here is not a second ACTOR: task 492 proved (see toolbar-hotkey-dedupe.ts's
// original header) that VS Code's registered-keybinding command dispatch is a separate, IPC-driven
// mechanism that fires regardless of whether the page's own script called `preventDefault()`, and
// Task 580 P2 measured that a capture `preventDefault()` still forwards the key. It blocks only
// the browser's native default; the VS Code command remains the sole thing that formats.
//
// Task 580 (policy 7) splits the module into two parts, both on one window-capture keydown
// listener that never stops propagation and reads no keybinding:
//   1. the native editing guard (`nativeEditingDefaultToBlock`; B/I/U on any editing surface, A
//      only on the active one, see GUARD_NATIVE_SELECT_ALL);
//   2. the command selection snapshot, taken for any modifier chord rather than a matched key.
// Checkpoint 3 (CP3-1) removed the last key-identity coupling: the default-key match that marked
// a formatting keydown "bridged" for undo-boundaries.ts and called preventDefault on it.
import { isMac } from '../util/platform'
import { writeSelectionKeepingIntent } from './caret'
import { guardComposition } from '../util/caret-gesture'
import {
  type HistoryKind,
  isDeletionKey,
  matchUndoRedo,
  type UndoRedoMatcher,
} from './undo-redo-keys'
import { activeModeElement } from '../util/source-map'
import { hasClosestBlock } from 'vditor/src/ts/util/hasClosest'

const BLOCK_SCOPED_ACTIONS: ReadonlySet<string> = new Set([
  'bold',
  'italic',
  'strike',
  'inline-code',
  'list',
  'ordered-list',
  'check',
])

// Task 600 B2: a root IR range has no containing block, so Vditor's inline format creates a
// top-level block and its list toggle can erase the first paragraph. Refuse those actions only
// when the live range starts inside this IR editor but outside every block.
export function refusesBlocklessInlineFormat(
  toolbarName: string,
  win: Window & typeof globalThis = window,
): boolean {
  if (!BLOCK_SCOPED_ACTIONS.has(toolbarName)) return false
  const outer = (
    win as unknown as { vditor?: { vditor?: { currentMode?: string } } }
  ).vditor
  if (outer?.vditor?.currentMode !== 'ir') return false
  const editor = activeModeElement(outer as any)
  const selection = win.getSelection?.()
  if (!editor || !selection?.rangeCount) return false
  const start = selection.getRangeAt(0).startContainer
  return editor.contains(start) && !hasClosestBlock(start)
}

function activeSurface(win: Window & typeof globalThis): HTMLElement | null {
  const outer = (win as unknown as { vditor?: unknown }).vditor
  return outer ? activeModeElement(outer as any) : null
}

function activeMode(win: Window & typeof globalThis): string | undefined {
  return (win as unknown as { vditor?: { vditor?: { currentMode?: string } } })
    .vditor?.vditor?.currentMode
}

type GuardKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'keyCode' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'target'
>

// Chromium's contenteditable key bindings (Task 580 P3, Linux) — B/I/U run formatBold/Italic/
// Underline, A runs select-all. Chromium matches its editing bindings on the Windows virtual key
// code, so `keyCode` also covers layouts whose `key` is not Latin (a Cyrillic layout reports `и`
// for the B key).
const NATIVE_FORMAT_KEY_CODES: Readonly<Record<string, number>> = {
  b: 66,
  i: 73,
  u: 85,
}
const SELECT_ALL_KEY_CODE = 65

// Task 580 CP2-6 turned the select-all half on together with `vmde.selectAll`: Ctrl/Cmd+A on the
// editing surface now selects only through that command (the IR staged ladder), whatever key the
// user binds it to (resume handoff §4.3).
const GUARD_NATIVE_SELECT_ALL = true

export interface NativeEditingGuardOptions {
  /** Also block native select-all on the active editing surface. */
  selectAll?: boolean
}

function nativeKeyIs(event: GuardKeyEvent, key: string, code: number) {
  return event.key.toLowerCase() === key || event.keyCode === code
}

/** Whether a trusted keydown would run a browser-native editing command that VMDE must block
 * (Task 580 policy 7). Independent of the user's keybindings: a remapped or unbound VMDE command
 * leaves these keys to the browser, and the browser would otherwise rewrite the editor DOM.
 * Shift is excluded on purpose: Linux Ctrl+Shift+U starts IME Unicode entry (P3 measured it
 * inserting composition text). This guard neither blocks nor fixes that path. */
export function nativeEditingDefaultToBlock(
  event: GuardKeyEvent,
  mac: boolean,
  surface: Element | null,
  { selectAll = GUARD_NATIVE_SELECT_ALL }: NativeEditingGuardOptions = {},
): boolean {
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey
  if (!primary || event.altKey || event.shiftKey) return false
  for (const [key, code] of Object.entries(NATIVE_FORMAT_KEY_CODES))
    if (nativeKeyIs(event, key, code)) return true
  // Select-all only on the active editing surface: VMDE's inputs (Find, link popover) keep their
  // own native select-all. VS Code's forwarded `editor.action.selectAll` still reaches the
  // webview through `execCommand('selectAll')`, which this keydown guard does not block.
  return (
    selectAll &&
    nativeKeyIs(event, 'a', SELECT_ALL_KEY_CODE) &&
    !!surface &&
    event.target instanceof Node &&
    surface.contains(event.target)
  )
}

// ---------------------------------------------------------------------------------------------
// Command selection snapshot (Task 580 policy 7, Part 1 handoff §2.5, P6 evidence).
//
// Task 534 saw a promoted formatting key act on a collapsed caret after VS Code's command round
// trip. The snapshot keeps the selection the user had when the chord went down, so the command
// that the chord triggers acts on it. It is not tied to a key: any trusted Ctrl/Meta/Alt keydown
// takes it, so a remapped binding gets the same protection as a default one.
//
// P6 measured that Vditor's `recordFirstPosition → addCaret` splits the caret's text node between
// keydown and message arrival; a stored node/offset pair then points past the end of its node.
// The snapshot therefore keeps a live Range (the DOM moves its boundary points through splits,
// insertions and removals) and records each endpoint structurally: the element that holds it and
// its text offset inside that element. A text-node split keeps both; a re-render that replaces
// the element does not, and the snapshot is then dropped in favor of the live selection.

interface SnapshotEndpoint {
  element: Element
  textOffset: number
}

interface CommandSelectionSnapshot {
  range: Range
  backward: boolean
  start: SnapshotEndpoint
  end: SnapshotEndpoint
  surface: HTMLElement
  mode: string | undefined
  at: number
}

const COMMAND_SELECTION_TTL_MS = 2000
let snapshot: CommandSelectionSnapshot | undefined

function textOffsetIn(element: Element, node: Node, offset: number): number {
  const prefix = element.ownerDocument.createRange()
  prefix.setStart(element, 0)
  prefix.setEnd(node, offset)
  return prefix.toString().length
}

function endpointOf(node: Node, offset: number): SnapshotEndpoint | null {
  const element = node instanceof Element ? node : node.parentElement
  return element
    ? { element, textOffset: textOffsetIn(element, node, offset) }
    : null
}

function endpointHolds(
  endpoint: SnapshotEndpoint,
  surface: Element,
  node: Node,
  offset: number,
): boolean {
  return (
    surface.contains(endpoint.element) &&
    endpoint.element.contains(node) &&
    textOffsetIn(endpoint.element, node, offset) === endpoint.textOffset
  )
}

function isTextlessRange(range: Range): boolean {
  if (range.collapsed || range.toString() !== '') return false
  return !range.cloneContents().querySelector('*')
}

function clearCommandSelectionSnapshot(): void {
  snapshot = undefined
}

function takeCommandSelectionSnapshot(win: Window & typeof globalThis): void {
  snapshot = undefined
  const surface = activeSurface(win)
  const selection = win.getSelection?.()
  if (!surface || !selection?.rangeCount) return
  const range = selection.getRangeAt(0)
  if (
    !surface.contains(range.startContainer) ||
    !surface.contains(range.endContainer)
  )
    return
  const start = endpointOf(range.startContainer, range.startOffset)
  const end = endpointOf(range.endContainer, range.endOffset)
  if (!start || !end) return
  const captured = range.cloneRange()
  // Task 580 CP4-1: Vditor's first keydown after load (`recordFirstPosition` → `addCaret`) inserts
  // and removes a marker at the caret, which splits the caret's text node and leaves a Range from
  // the end of one half to the start of the other. It holds no text and no element, so it is still
  // the user's caret; keep it as one. Otherwise the keyup refresh below would store a non-collapsed
  // selection, and a caret command (Activate Link at Caret) would find no caret to act on.
  const caret = isTextlessRange(captured)
  if (caret) captured.collapse(true)
  snapshot = {
    range: captured,
    backward:
      !captured.collapsed &&
      selection.anchorNode === range.endContainer &&
      selection.anchorOffset === range.endOffset,
    start,
    end: caret ? start : end,
    surface,
    mode: activeMode(win),
    at: Date.now(),
  }
}

function validSnapshot(
  win: Window & typeof globalThis,
): CommandSelectionSnapshot | null {
  const pending = snapshot
  snapshot = undefined
  if (!pending || Date.now() - pending.at > COMMAND_SELECTION_TTL_MS)
    return null
  // A mode switch (or editor re-init) changes the active surface; the snapshot then belongs to a
  // surface that is no longer edited.
  if (
    activeSurface(win) !== pending.surface ||
    activeMode(win) !== pending.mode
  )
    return null
  const { range, surface } = pending
  const holds =
    endpointHolds(
      pending.start,
      surface,
      range.startContainer,
      range.startOffset,
    ) &&
    endpointHolds(pending.end, surface, range.endContainer, range.endOffset)
  return holds ? pending : null
}

/** Consume the pending snapshot without restoring it: for a command that acts on the live
 * selection (Undo, Redo). Each chord's snapshot belongs to the command that chord ran (Task 580
 * CP4-1); left pending, it would be restored by a later command that has no chord of its own
 * (Command Palette) within the TTL, after Undo or a programmatic caret move had changed the caret. */
export function discardCommandSelection(): void {
  clearCommandSelectionSnapshot()
}

export interface RestoreCommandSelectionOptions {
  /** Focus the editing surface before writing the selection (the formatting-command path). When
   * false, a selection is written only if focus is already on the surface or on no element, so a
   * command never pulls focus out of another VMDE widget. */
  focusEditor?: boolean
}

/** Restore the selection a command's originating chord saw, preserving its direction. A one-shot
 * write consumed synchronously by the command that follows (Task 534's exception to ADR-0007), not
 * a persistent caret intent. Returns false, leaving the live selection untouched, when there is no
 * valid snapshot: a Command Palette route has no originating key in the webview, so the command
 * acts on the selection that is live when its message arrives. */
export function restoreCommandSelection(
  win: Window & typeof globalThis = window,
  { focusEditor = true }: RestoreCommandSelectionOptions = {},
): boolean {
  const pending = validSnapshot(win)
  const selection = win.getSelection?.()
  if (!pending || !selection) return false
  const { range, surface, backward } = pending
  if (focusEditor) surface.focus({ preventScroll: true })
  else {
    const active = win.document.activeElement
    if (active && active !== win.document.body && !surface.contains(active))
      return false
  }
  // `setBaseAndExtent` keeps the anchor/focus order; `addRange` of the ordered Range turned a
  // backward selection forward (P6, native route).
  // Transparent (doubtful, so it keeps today's behaviour): puts back the selection the chord saw
  // and leaves any live caret intent armed.
  writeSelectionKeepingIntent(
    backward
      ? {
          anchorNode: range.endContainer,
          anchorOffset: range.endOffset,
          focusNode: range.startContainer,
          focusOffset: range.startOffset,
        }
      : {
          anchorNode: range.startContainer,
          anchorOffset: range.startOffset,
          focusNode: range.endContainer,
          focusOffset: range.endOffset,
        },
  )
  return true
}

function hasCommandModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey || event.altKey
}

// Task 580 CP3-1b: a chord VMDE does not bind (Ctrl+Home, Ctrl+Shift+Left, macOS Option+Left)
// moves the selection natively during its keydown, and no command message follows to consume the
// snapshot. Left alone, the pre-move snapshot would make a command that arrives later without its
// own keydown (menu, VS Code toolbar, another extension's executeCommand) act at the old caret.
// A pending snapshot is therefore re-taken from the live selection on the next keyup. A bound
// chord's message normally arrives while the key is still down (P6: the selection at arrival
// equals the keydown snapshot), so it still restores the keydown selection, which macOS
// Option+Up Move Block needs because the native default has already moved the caret. A
// selectionchange rule could not tell those two apart: both moves happen before the keyup.
function refreshPendingSnapshot(win: Window & typeof globalThis): void {
  if (snapshot) takeCommandSelectionSnapshot(win)
}

// Wire the listeners. `win` is the global object the webview runs in. Everything is capture phase on the window
// so it runs before the browser's native contenteditable handling and before Vditor's bubble-phase
// `recordFirstPosition`. Nothing here stops propagation: VS Code must still receive the key.
/**
 * Task 733 / 036 D-18: what the IR-owned Undo/Redo keys need, injected from boot/main.ts (this module may
 * not import the bridge). Getters, not values: the boot listener outlives each editor instance.
 */
export interface OwnedHistoryOptions {
  /** The current chord matcher (swapped whole on a setting change). */
  matcher(): UndoRedoMatcher
  /** The edit view is fully built (not deferred, not streaming). */
  viewReady(): boolean
  /** The unit engine owns this editor's history now (`__vmdeUnitHistory.ownsHistoryNow`). */
  ownsHistoryNow(inner: unknown): boolean
  /** A VMDE text field (Find, Replace, link popover) has focus. */
  focusedField(): unknown
  cancelAutoWrap(): void
  /** One Undo or Redo through the wrapped history store (bridge/message-router.ts `runHistoryMove`). */
  run(kind: HistoryKind): void
  /**
   * 036 core C3 (L1): a trusted user input arrived (keydown, pointerdown, beforeinput); the replay's next
   * frame yields to it (`ModelSession.noteInput`). Called first, before an owned key runs.
   */
  noteInput?(): void
}

// Elements inside the editor whose keys keep native handling (fields, overlays, menus, Find).
const NOT_OWNED_TARGETS =
  'input, textarea, select, [role="dialog"], [role="menu"], .vditor-panel, .vditor-hint, .vmde-find-replace'

/** E2e counters of the owned path (counts only). */
function countOwned(win: Window, name: string): void {
  const slot = win as unknown as {
    __vmdeE2EReadiness?: unknown
    __vmdeOwnedHistory?: Record<string, number>
  }
  if (!slot.__vmdeE2EReadiness) return
  slot.__vmdeOwnedHistory ??= {}
  slot.__vmdeOwnedHistory[name] = (slot.__vmdeOwnedHistory[name] ?? 0) + 1
}

/**
 * Task 733 / 036 D-18 (design rev 4.1 R41.2): the history kind of an owned keydown, or undefined. Owned
 * only for a trusted, non-composing chord of the current matcher, in IR, on the focused, writable, fully
 * built editing root whose own editing host is the target's, outside fields and overlays, while the unit
 * engine owns the history now. O(1) apart from two `closest` walks; no allocation.
 */
function ownedHistoryKind(
  event: KeyboardEvent,
  win: Window & typeof globalThis,
  owned: OwnedHistoryOptions,
): HistoryKind | undefined {
  if (!event.isTrusted || guardComposition(event)) return undefined
  const matcher = owned.matcher()
  if (!matcher.inEditor) return undefined
  const kind = matchUndoRedo(matcher, event)
  if (!kind) return undefined
  const inner = ownableIrEditor(win, owned)
  if (!inner || !targetIsOwnable(event, win, inner.root, owned))
    return undefined
  return owned.ownsHistoryNow(inner.vditor) ? kind : undefined
}

/** The IR editor and its root when ownership can apply: IR, connected, writable, not composing, built. */
function ownableIrEditor(
  win: Window & typeof globalThis,
  owned: OwnedHistoryOptions,
): { vditor: unknown; root: HTMLElement } | undefined {
  const vditor = (
    win as unknown as {
      vditor?: {
        vditor?: {
          currentMode?: string
          ir?: { element?: HTMLElement; composingLock?: boolean }
        }
      }
    }
  ).vditor?.vditor
  const root = vditor?.ir?.element
  if (vditor?.currentMode !== 'ir' || !root?.isConnected) return undefined
  if (root.getAttribute('contenteditable') !== 'true') return undefined
  if (vditor.ir?.composingLock || !owned.viewReady()) return undefined
  return { vditor, root }
}

/** Focus is in the root, the root is the target's own editing host, and no field or overlay holds it. */
function targetIsOwnable(
  event: KeyboardEvent,
  win: Window & typeof globalThis,
  root: HTMLElement,
  owned: OwnedHistoryOptions,
): boolean {
  const active = win.document.activeElement
  if (!active || !root.contains(active)) return false
  const target = event.target instanceof Node ? event.target : null
  const element =
    target instanceof Element ? target : (target?.parentElement ?? null)
  if (!element || !root.contains(element)) return false
  if (element.closest('[contenteditable]') !== root) return false
  return !element.closest(NOT_OWNED_TARGETS) && !owned.focusedField()
}

export function setupFormatHotkeyGuard(
  win: Window & typeof globalThis,
  owned?: OwnedHistoryOptions,
): () => void {
  const onMac = isMac(win.navigator)
  // D-18: the physical key of an owned Backspace/Delete chord whose keyup is suppressed (Vditor's IR
  // keyup handler would otherwise act on the restored DOM), kept until that key comes up.
  let suppressKeyupCode: string | null = null
  const runOwned = (event: KeyboardEvent): boolean => {
    const kind = owned ? ownedHistoryKind(event, win, owned) : undefined
    if (!kind || !owned) return false
    // Consumed once: no later listener runs and VS Code does not forward the key (probe: zero
    // commands). The document-level auto-wrap cancel (boot/main.ts) no longer sees it, so it is
    // called here, then one move through the wrapped store (Task 601 drains pending typing there).
    event.preventDefault()
    event.stopImmediatePropagation()
    owned.cancelAutoWrap()
    if (isDeletionKey(event)) suppressKeyupCode = event.code
    owned.run(kind)
    countOwned(win, kind === 'undo' ? 'ownedUndo' : 'ownedRedo')
    return true
  }
  const onKeydown = (event: KeyboardEvent): void => {
    // 036 core C3 (L1): the key that starts a replay is noted before the move, so its first frame yields.
    if (event.isTrusted) owned?.noteInput?.()
    if (runOwned(event)) return
    if (guardComposition(event)) return
    if (event.isTrusted) {
      if (nativeEditingDefaultToBlock(event, onMac, activeSurface(win)))
        event.preventDefault()
      if (hasCommandModifier(event)) takeCommandSelectionSnapshot(win)
      else clearCommandSelectionSnapshot()
    }
  }
  const onKeyup = (event: KeyboardEvent): void => {
    // D-18: the release of an owned Backspace/Delete chord, even after its modifier came up first.
    if (suppressKeyupCode !== null && event.code === suppressKeyupCode) {
      suppressKeyupCode = null
      event.preventDefault()
      event.stopImmediatePropagation()
      countOwned(win, 'keyupSuppressed')
      return
    }
    if (event.isTrusted && !guardComposition(event)) refreshPendingSnapshot(win)
  }
  const clearKeyupTracking = (): void => {
    suppressKeyupCode = null
  }
  // Each of these means the user moved the selection or edited the text after the chord, so the
  // chord's snapshot no longer describes what a later command should act on. Only user text
  // input counts: VMDE's own synthetic `input` events are part of a command, not a new edit.
  const invalidateOnTrustedInput = (event: Event): void => {
    if (event.isTrusted) clearCommandSelectionSnapshot()
  }
  // 036 core C3 (L1): a pointer press and a trusted `beforeinput` are inputs the replay yields to too.
  const onPointerdown = (event: Event): void => {
    if (event.isTrusted) owned?.noteInput?.()
    clearCommandSelectionSnapshot()
  }
  const onBeforeinput = (event: Event): void => {
    if (event.isTrusted) owned?.noteInput?.()
    invalidateOnTrustedInput(event)
  }
  const listeners = [
    ['keydown', onKeydown],
    ['keyup', onKeyup],
    ['blur', clearKeyupTracking],
    ['pointerdown', onPointerdown],
    ['compositionstart', clearCommandSelectionSnapshot],
    ['beforeinput', onBeforeinput],
    ['input', invalidateOnTrustedInput],
  ] as const
  for (const [type, listener] of listeners)
    win.addEventListener(type, listener as EventListener, true)
  return () => {
    for (const [type, listener] of listeners)
      win.removeEventListener(type, listener as EventListener, true)
    clearCommandSelectionSnapshot()
    clearKeyupTracking()
  }
}
