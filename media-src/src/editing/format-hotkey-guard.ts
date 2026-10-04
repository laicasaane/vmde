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
// Task 580 (policy 7) splits the module into three parts, all on one window-capture keydown
// listener that never stops propagation:
//   1. the native editing guard, independent of any binding (`nativeEditingDefaultToBlock`; its
//      select-all half is off until CP2-6, see GUARD_NATIVE_SELECT_ALL);
//   2. the command selection snapshot, taken for any modifier chord rather than a matched key;
//   3. the transitional FORMAT_HOTKEYS match, which still marks the keydown as bridged for
//      undo-boundaries.ts. Later Checkpoint 2 steps remove it with the last key boundary.
import { isMac } from '../util/platform'
import { FORMAT_HOTKEYS } from '../../../src/shared/format-hotkeys'
import { guardComposition } from '../util/caret-gesture'
import { activeModeElement } from '../util/source-map'
import { hasClosestBlock } from 'vditor/src/ts/util/hasClosest'
import { markToolbarHotkeyKeydownBridged } from './undo-boundaries'

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

// The select-all half of the guard stays off until Task 580 CP2-6 lands `vmde.selectAll`: until
// then Ctrl/Cmd+A keeps the browser's native select-all, so no default changes ahead of its
// command route (resume handoff §4.3). CP2-6 sets this to true in the same step.
const GUARD_NATIVE_SELECT_ALL = false

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
  snapshot = {
    range: range.cloneRange(),
    backward:
      !range.collapsed &&
      selection.anchorNode === range.endContainer &&
      selection.anchorOffset === range.endOffset,
    start,
    end,
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
  if (backward)
    selection.setBaseAndExtent(
      range.endContainer,
      range.endOffset,
      range.startContainer,
      range.startOffset,
    )
  else
    selection.setBaseAndExtent(
      range.startContainer,
      range.startOffset,
      range.endContainer,
      range.endOffset,
    )
  return true
}

// ---------------------------------------------------------------------------------------------
// Transitional FORMAT_HOTKEYS key coupling. FORMAT_HOTKEYS uses VS Code's keybinding notation
// ('ctrl+shift+7', 'cmd+]'); normalize a keydown the same way so the two compare directly.
// Modifier order mirrors the table: primary modifier, then shift, then the key itself —
// FORMAT_HOTKEYS never combines with Alt.
export function normalizeEventKey(
  event: Pick<
    KeyboardEvent,
    'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
  >,
  mac: boolean,
): string | null {
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey
  if (!primary || event.altKey) return null
  const parts = [mac ? 'cmd' : 'ctrl']
  if (event.shiftKey) parts.push('shift')
  parts.push(event.key.toLowerCase())
  return parts.join('+')
}

export function isPromotedFormatHotkey(
  event: Pick<
    KeyboardEvent,
    'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
  >,
  mac: boolean,
): boolean {
  const normalized = normalizeEventKey(event, mac)
  if (!normalized) return false
  return FORMAT_HOTKEYS.some((row) => (mac ? row.mac : row.key) === normalized)
}

function hasCommandModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey || event.altKey
}

// Wire the listeners. `win` is the global object the webview runs in. Everything is capture phase on the window
// so it runs before the browser's native contenteditable handling and before Vditor's bubble-phase
// `recordFirstPosition`. Nothing here stops propagation: VS Code must still receive the key.
export function setupFormatHotkeyGuard(
  win: Window & typeof globalThis,
): () => void {
  const onMac = isMac(win.navigator)
  const onKeydown = (event: KeyboardEvent): void => {
    if (guardComposition(event)) return
    if (event.isTrusted) {
      if (nativeEditingDefaultToBlock(event, onMac, activeSurface(win)))
        event.preventDefault()
      if (hasCommandModifier(event)) takeCommandSelectionSnapshot(win)
      else clearCommandSelectionSnapshot()
    }
    // Transitional: until each formatting key's boundary moves to its command (Task 580 CP2-3+),
    // undo-boundaries.ts must skip the keydown checkpoint of a key whose toolbar click owns it.
    // The preventDefault keeps the Task 505 behavior for the remaining FORMAT_HOTKEYS defaults.
    if (isPromotedFormatHotkey(event, onMac)) {
      markToolbarHotkeyKeydownBridged(event)
      event.preventDefault()
    }
  }
  // Each of these means the user moved the selection or edited the text after the chord, so the
  // chord's snapshot no longer describes what a later command should act on. Only user text
  // input counts: VMDE's own synthetic `input` events are part of a command, not a new edit.
  const invalidateOnTrustedInput = (event: Event): void => {
    if (event.isTrusted) clearCommandSelectionSnapshot()
  }
  const listeners = [
    ['keydown', onKeydown],
    ['pointerdown', clearCommandSelectionSnapshot],
    ['compositionstart', clearCommandSelectionSnapshot],
    ['beforeinput', invalidateOnTrustedInput],
    ['input', invalidateOnTrustedInput],
  ] as const
  for (const [type, listener] of listeners)
    win.addEventListener(type, listener as EventListener, true)
  return () => {
    for (const [type, listener] of listeners)
      win.removeEventListener(type, listener as EventListener, true)
    clearCommandSelectionSnapshot()
  }
}
