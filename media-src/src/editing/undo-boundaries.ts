import type Vditor from 'vditor'
import type { EditorAction } from '../../../src/shared/protocol'
import { guardComposition, isCompositionActive } from '../util/caret-gesture'
import { isMac } from '../util/platform'
import { logToHost, reportError } from '../util/webview-log'
import { invalidateCaret } from './caret'

type UndoMode = 'ir' | 'wysiwyg' | 'sv'

// Task 293 checkpointed the keydown of Vditor's default toolbar hotkeys (⌘B, ⌘I, ⌘D, ⌘H, ⌘L, ⌘E,
// ⌘K, ⌘M, ⌘U) so each model command started its own undo step. Task 580 moved every one of those
// commands off the webview keydown: a command now arrives as a host message, and its toolbar click
// (isToolbarAction below) or its editor action (EDITOR_ACTION_UNDO_BOUNDARIES) takes the boundary,
// whatever key the user binds. CP3-1 removed the last letters with the formatting defaults: Bold
// and Italic keep one Undo step per press through their toolbar click (P5 CP1-3b1), as they did
// when their default keydown was marked "bridged" and skipped here.
//
// What remains is macOS Cocoa's own editing on Ctrl (not Cmd): Ctrl+D deletes forward, Ctrl+H
// deletes backward and Ctrl+K deletes to the end of the paragraph, natively and with no VMDE
// command. Their keydown keeps the boundary it had, so that native edit stays its own Undo step.
const COCOA_CTRL_EDIT_KEYS: ReadonlySet<string> = new Set(['d', 'h', 'k'])

// Task 601: a mode's scheduled after-render callback, named by the build-time patch
// `patchAfterRenderRecord` (media-src/esbuild-shared.mjs). `run` is the original callback body; it
// runs once, at natural expiry or when drained before a history transition.
interface PendingAfterRender {
  options?: { enableAddUndoStack?: boolean; enableInput?: boolean }
  timer?: number
  run: () => void
}

interface UndoModeState {
  undoStack?: unknown[]
  lastText?: string
}

interface UndoInner {
  currentMode: UndoMode
  options?: {
    undoDelay?: number
    input?: (markdown: string) => void
  }
  toolbar?: { elements?: Record<string, HTMLElement | undefined> }
  ir?: {
    processTimeoutId?: number
    element?: HTMLElement
    vmdeAfterRender?: PendingAfterRender
  }
  wysiwyg?: {
    afterRenderTimeoutId?: number
    element?: HTMLElement
    vmdeAfterRender?: PendingAfterRender
  }
  sv?: {
    processTimeoutId?: number
    element?: HTMLElement
    vmdeAfterRender?: PendingAfterRender
  }
  undo?: {
    addToUndoStack?: (inner: UndoInner) => void
    // Task 598: added by the build-time patch `patchUndoSeedBaseline` (media-src/esbuild-shared.mjs).
    vmdeSeedBaseline?: (inner: UndoInner, event?: Event) => boolean
    vmdeHeldTimer?: number
    ir?: UndoModeState
    wysiwyg?: UndoModeState
    sv?: UndoModeState
  }
}

// Task 598 — Vditor only schedules each mode's first undo snapshot, and an edit made before that
// timer runs replaces it, so the first snapshot already holds the edit and the first edit can never
// be undone. The patched `vmdeSeedBaseline` takes the snapshot instead, at the user's first action
// and before it changes anything; it does nothing once the active mode has any history. The
// callers below are the first actions VMDE can see: keydown, beforeinput, cut, drop, every undo
// boundary (toolbar actions, paste, Enter, syntax promotion) and every editor action. Vditor's own
// keydown path calls it from `recordFirstPosition`. Never during IME composition: seeding there
// could disturb the composition, so an IME first edit stays a known residual (ruling Q2).
// `event` is the action's event, when there is one: the patched `recordFirstPosition` skips its own
// marker capture for a keydown this listener already seeded.
export function seedUndoBaseline(inner: UndoInner, event?: Event): boolean {
  if (isCompositionActive()) return false
  return inner.undo?.vmdeSeedBaseline?.(inner, event) ?? false
}

// A bare modifier press changes nothing, so it takes no seed.
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Control',
  'Meta',
  'Alt',
  'AltGraph',
  'Shift',
])

function activeHistoryEmpty(inner: UndoInner): boolean {
  return (inner.undo?.[inner.currentMode]?.undoStack?.length ?? 0) === 0
}

function inActiveEditor(inner: UndoInner, target: EventTarget | null): boolean {
  const root = inner[inner.currentMode]?.element
  return !!root && target instanceof Node && root.contains(target)
}

export function isSyntaxPromotionText(text: string): boolean {
  return /^(?:#{1,6}|[-+*>]|\d{1,9}[.)]) $/.test(
    text.replace(/[\u200b\u00a0]/g, ''),
  )
}

function pendingTimer(inner: UndoInner): number | undefined {
  if (inner.currentMode === 'wysiwyg')
    return inner.wysiwyg?.afterRenderTimeoutId
  if (inner.currentMode === 'sv') return inner.sv?.processTimeoutId
  return inner.ir?.processTimeoutId
}

/** Cancel the active mode's scheduled after-render callback. Task 601: its record is retired too,
 * so a cancelled callback can never be drained before a later history transition. */
export function cancelPendingAfterRender(inner: UndoInner): void {
  const timer = pendingTimer(inner)
  if (timer !== undefined) clearTimeout(timer)
  const owner = inner[inner.currentMode]
  if (owner) owner.vmdeAfterRender = undefined
}

/** Task 603 item 3 — an external update's `setValue` arms the active mode's delayed after-render
 * record with `enableAddUndoStack` on (it publishes nothing: `enableInput` is off). Left alone, the
 * record adds a second history entry `undoDelay` later that differs from the update's base only in
 * the caret, which the user's next Undo then "undoes". This turns off just that flag, in the record's
 * own options object (the patched callback reads it when the timer fires, `patchAfterRenderRecord`
 * in media-src/esbuild-shared.mjs). The record, its timer and its callback stay armed, so the
 * counter, cache, devtools and render work still run, and an edit's own `processAfterRender` /
 * `afterRenderEvent` call still replaces the record with a fresh one that records its checkpoint.
 * `inner` is Vditor's inner instance, typed `unknown` as `preparePendingHistory`'s is: the router
 * holds it through its own narrower view. Returns whether a record was disarmed. */
export function disarmAfterRenderUndoEntry(inner: unknown): boolean {
  const view = inner as UndoInner | null
  if (!view) return false
  const options = view[view.currentMode]?.vmdeAfterRender?.options
  if (!options) return false
  options.enableAddUndoStack = false
  return true
}

export function checkpointUndoBoundary(
  inner: UndoInner,
  cancelPending: boolean,
): void {
  if (cancelPending) cancelPendingAfterRender(inner)
  inner.undo?.addToUndoStack?.(inner)
}

// Task 601 — the caret marker and IR's caret-dependent expansion class are not source. Comparing
// the live editor HTML with the last checkpoint's HTML without them tells a pending callback that
// would only move the caret from one that holds an edit. Any other difference counts as an edit,
// so this can only miss a no-op (and then drain it, as natural expiry would), never skip an edit.
function withoutCaret(html: string): string {
  return html
    .replace(/<wbr>|<span class="vditor-wbr"><\/span>/g, '')
    .replace(/ vditor-ir__node--expand/g, '')
}

function sourceNeutral(inner: UndoInner): boolean {
  const root = inner[inner.currentMode]?.element
  const lastText = inner.undo?.[inner.currentMode]?.lastText
  if (!root || typeof lastText !== 'string') return false
  return withoutCaret(root.innerHTML) === withoutCaret(lastText)
}

// Task 601 — run the active mode's pending edit checkpoint now, once, through the original callback.
// Only a callback armed by an edit qualifies: it both publishes (`enableInput`) and records
// (`enableAddUndoStack`). Renders from setValue, a mode switch or streaming publish nothing, and the
// history engine's own render records nothing, so neither is drained. A callback whose edit left
// the source as the last checkpoint has it is left alone: draining it would only add a caret entry
// and clear Redo.
function drainPendingCheckpoint(inner: UndoInner): boolean {
  const owner = inner[inner.currentMode]
  const record = owner?.vmdeAfterRender
  if (!owner || !record) return false
  if (!record.options?.enableAddUndoStack || !record.options.enableInput)
    return false
  if (sourceNeutral(inner)) return false
  owner.vmdeAfterRender = undefined
  if (record.timer !== undefined) clearTimeout(record.timer)
  record.run()
  return true
}

function editableBlockText(target: EventTarget | null): string | null {
  if (!(target instanceof Node)) return null
  const selection = getSelection()
  const node = selection?.rangeCount ? selection.anchorNode : target
  const element =
    node instanceof Element ? node : (node as Node | null)?.parentElement
  const block = element?.closest<HTMLElement>('[data-block]')
  return block?.textContent ?? null
}

/** Whether a keydown takes a boundary before it runs: a macOS Cocoa Ctrl editing key. */
export function isUndoBoundaryCommand(
  event: Pick<
    KeyboardEvent,
    'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
  >,
  mac: boolean,
): boolean {
  if (!mac || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
    return false
  return COCOA_CTRL_EDIT_KEYS.has(event.key.toLowerCase())
}

// Plain Enter and Shift+Enter split a block or a line, so they start their own Undo step. Task 580
// CP4-1: Enter with Ctrl, Meta or Alt edits nothing (the former Ctrl/Cmd+Enter link activation is
// an unbound command now, Ctrl/Cmd+Alt+Enter is the Replace All command and WYSIWYG's Alt+Enter
// only moves focus into a popover). Its boundary posted input(getValue()), which rewrote the host's exact bytes with Vditor's rendered
// serialization although the document had not changed.
function isEditingEnter(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>,
): boolean {
  return (
    event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey
  )
}

function isFindWidgetEvent(event: Event): boolean {
  return (
    event.target instanceof Element &&
    !!event.target.closest('.vmde-find-replace')
  )
}

function isToolbarAction(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const action = target.closest<HTMLElement>(
    '.vditor-toolbar button, .vditor-panel button',
  )
  // Preview and edit-mode controls only change the view. A synthetic input for
  // either would publish Vditor's canonicalized Markdown (including extra terminal
  // newlines) as a document edit during a source-inert mode transition.
  return Boolean(
    action &&
      action.dataset.type !== 'undo' &&
      action.dataset.type !== 'redo' &&
      action.dataset.type !== 'preview' &&
      action.dataset.type !== 'edit-mode' &&
      !action.hasAttribute('data-mode'),
  )
}

// Task 580 CP2-2 — the editor actions that take an undo boundary before they run, through the
// dispatcher's `takeUndoBoundary` hook (bridge/editor-actions.ts, wired in boot/main.ts). Boundary
// migration was incremental: each Checkpoint 2 conversion added its action here in the same step
// that removed its key from the keydown boundary list, matching the P5 baseline step counts, so a
// key never lost its boundary and no action got a second one.
//
// CP2-9: the eight table actions whose old chord matched isUndoBoundaryCommand (Shift+L/C/R/G,
// `=`, `-`, Shift+`+`/`=`, Shift+`_`/`-`). Insert Row Above (Shift+F) and the four moves (Shift+[ /
// ], Shift+PageUp/PageDown) never took one; the moves checkpoint inside their own transaction.
// CP2-10 removed those keys from isUndoBoundaryCommand, so their synthetic chords no longer need
// marking. The heading, edit-mode and task chord actions (vditor-chord-actions.ts) take none:
// their former Alt and Shift+J chords never took one.
const EDITOR_ACTION_UNDO_BOUNDARIES: ReadonlySet<EditorAction> =
  new Set<EditorAction>([
    'table-align-left',
    'table-align-center',
    'table-align-right',
    'table-insert-row-below',
    'table-insert-column-left',
    'table-insert-column-right',
    'table-delete-row',
    'table-delete-column',
  ])

// The installed editor's boundary and first-action seed, or undefined before init and after
// dispose.
let editorActionBoundary: (() => void) | undefined
let editorActionSeed: (() => void) | undefined

/** Take the boundary an editor action's old key took (see EDITOR_ACTION_UNDO_BOUNDARIES). Returns
 * whether a boundary was taken. `boundaryActions` is injectable for tests. Every action first
 * seeds an empty history (Task 598): a Command Palette or menu route has no webview key to do it,
 * and the dispatcher calls this hook just before the action runs. */
export function takeEditorActionUndoBoundary(
  action: EditorAction,
  boundaryActions: ReadonlySet<EditorAction> = EDITOR_ACTION_UNDO_BOUNDARIES,
): boolean {
  editorActionSeed?.()
  if (!boundaryActions.has(action) || !editorActionBoundary) return false
  editorActionBoundary()
  return true
}

const SEED_EVENTS = ['beforeinput', 'cut', 'drop'] as const

interface UndoBoundaryOptions {
  /** Post outstanding edit-sync work to the host now; true when something was pending. */
  flushHistoryInput?: () => boolean
  /** Run the editor's deferred IR prose/fence re-spin now (edit-activity.ts); true when it ran. */
  flushRespin?: (inner: UndoInner) => boolean
}

// The installed editor's history preparation, or undefined before init and after dispose.
let historyPreparation: ((inner: unknown) => boolean) | undefined

/** Task 601 — settle the pending edit before an Undo/Redo engine call (undo-keybind.ts wrapper and
 * the toolbar Undo/Redo capture). Returns false when the history call must not run (IME
 * composition); true otherwise, including for another editor instance and before install. */
export function preparePendingHistory(inner: unknown): boolean {
  return historyPreparation?.(inner) ?? true
}

const HISTORY_BUTTONS = ['undo', 'redo'] as const

export function installUndoBoundaries(
  vditor: Vditor,
  win: Window & typeof globalThis = window,
  options: UndoBoundaryOptions = {},
): () => void {
  const inner = () => (vditor as unknown as { vditor: UndoInner }).vditor
  const onMac = isMac(win.navigator)
  let dirty = false
  let dirtyTimer: ReturnType<typeof setTimeout> | undefined
  const markDirty = () => {
    dirty = true
    if (dirtyTimer) clearTimeout(dirtyTimer)
    const delay = Number(inner().options?.undoDelay ?? 800)
    dirtyTimer = setTimeout(() => {
      dirty = false
      dirtyTimer = undefined
    }, delay + 50)
  }
  const boundary = (forceBefore = false) => {
    const current = inner()
    // Task 598: seed first, so the after-action checkpoint below is a second entry, not the baseline.
    seedUndoBaseline(current)
    if (forceBefore || dirty) checkpointUndoBoundary(current, true)
    const mode = current.currentMode
    const stackLength = current.undo?.[current.currentMode]?.undoStack?.length
    setTimeout(() => {
      const settled = inner()
      const settledLength =
        settled.undo?.[settled.currentMode]?.undoStack?.length
      cancelPendingAfterRender(settled)
      if (
        settled.currentMode !== mode
          ? settledLength === 0
          : stackLength === undefined || settledLength === stackLength
      )
        checkpointUndoBoundary(settled, false)
      settled.options?.input?.(vditor.getValue())
      dirty = false
      if (dirtyTimer) clearTimeout(dirtyTimer)
      dirtyTimer = undefined
    }, 0)
  }
  // Find edits its own inputs, outside the document. This window-capture listener runs before
  // Find consumes Enter; checkpointing it would call input(getValue()) and rewrite exact host
  // bytes with Vditor's serialization. Replace transactions own their explicit checkpoints.
  const onPaste = (event: Event) => {
    if (!isFindWidgetEvent(event)) boundary()
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (guardComposition(event) || isFindWidgetEvent(event)) return
    // Task 598: a key may edit natively or run a command whose message arrives later; seed before
    // either. The seed never stops, prevents or replays the key.
    if (!MODIFIER_KEYS.has(event.key)) seedUndoBaseline(inner(), event)
    if (isEditingEnter(event) || isUndoBoundaryCommand(event, onMac)) boundary()
  }
  // Task 598: seed-only listeners for first edits that have no VMDE boundary. `beforeinput` covers
  // native insertion, replacement, deletion, spellcheck and default drop/cut edits with no keydown.
  // Vditor's cut listener deletes through execCommand("delete"), which emits no beforeinput, and
  // its internal-text drop listener schedules its render before the browser moves the text, so a
  // seed taken only at beforeinput would cancel that edit's render timer: both seed at capture.
  const onSeedEvent = (event: Event) => {
    if (isFindWidgetEvent(event)) return
    if ((event as InputEvent).isComposing) return
    const current = inner()
    if (inActiveEditor(current, event.target)) seedUndoBaseline(current, event)
  }
  // Task 598: an IME first edit takes no seed, and Vditor's compositionend handler (IR, WYSIWYG)
  // schedules the timer that publishes it. A later seed in the same window (an arrow key, a toolbar
  // no-op, a command) cancelled that timer, and the edit never reached the host (measured). While
  // the history is still empty, hold that timer: the patched seed refuses while it is pending, and
  // the timer takes the first snapshot itself. Bubble phase on the window, so Vditor's own
  // compositionend listener on the editor has already scheduled the timer.
  const onCompositionEnd = (event: Event) => {
    const current = inner()
    if (!current.undo || !inActiveEditor(current, event.target)) return
    if (activeHistoryEmpty(current))
      current.undo.vmdeHeldTimer = pendingTimer(current)
  }
  const onClick = (event: MouseEvent) => {
    if (isToolbarAction(event.target)) boundary()
  }
  const onInput = (event: Event) => {
    if (isFindWidgetEvent(event)) return
    const input = event as InputEvent
    if (input.isComposing) return
    const current = inner()
    if (
      current.currentMode === 'ir' &&
      input.inputType === 'insertText' &&
      input.data === ' '
    ) {
      const text = editableBlockText(event.target)
      if (text !== null && isSyntaxPromotionText(text)) {
        boundary(true)
        return
      }
    }
    markDirty()
  }

  // Task 601 — Undo/Redo pressed while the latest edit's checkpoint is still pending used to pop
  // the previous entry: the webview lost two edits while the host's native undo reverted one, and
  // the pending edit could never be redone. Before each history transition, in this order:
  //   1. IR prose typing defers its spin to edit-activity's settle; run that spin now, so Vditor's
  //      input path arms the edit's checkpoint callback;
  //   2. run that callback now (drainPendingCheckpoint), so the edit gets its own entry;
  //   3. post any outstanding edit to the host, so it holds the edit before the transition.
  // Each step does nothing when nothing is pending, so a settled history keeps its Redo. During IME
  // composition the history call is refused outright (the handoff's rule): Vditor's callback cannot
  // record a half-composed word, the host flush must not publish one, and an engine call would
  // rewrite the DOM under the composition. Refused, not queued: nothing replays after compositionend.
  const prepareHistory = (target: unknown): boolean => {
    const current = inner()
    if (target !== current) return true
    if (isCompositionActive()) {
      logToHost('[undo-boundaries] Undo/Redo refused during IME composition')
      return false
    }
    try {
      if (current.currentMode === 'ir') options.flushRespin?.(current)
      // The drained checkpoint re-places the caret through the caret authority, which keeps
      // re-asserting it; the history restore that follows owns the caret instead (Task 597).
      if (drainPendingCheckpoint(current)) invalidateCaret()
    } catch (error) {
      // A failing callback must not also cancel the Undo the user asked for.
      reportError(error, 'undo-boundaries: pending checkpoint')
    }
    options.flushHistoryInput?.()
    return true
  }
  // Vditor's toolbar Undo/Redo check their disabled class before calling the engine, and a pending
  // first checkpoint leaves Undo disabled. Prepare in capture, before that check; the engine
  // wrapper prepares again, which finds nothing left to do.
  const onHistoryClick = (event: MouseEvent) => {
    const current = inner()
    if (!(event.target instanceof Node)) return
    const target = event.target
    const clicked = HISTORY_BUTTONS.some((name) =>
      current.toolbar?.elements?.[name]?.children[0]?.contains(target),
    )
    // A refused click (IME composition) never reaches Vditor's handler, so no engine call follows.
    if (clicked && !prepareHistory(current)) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }

  const actionBoundary = () => boundary()
  const actionSeed = () => {
    seedUndoBaseline(inner())
  }
  editorActionBoundary = actionBoundary
  editorActionSeed = actionSeed
  historyPreparation = prepareHistory

  win.addEventListener('paste', onPaste, true)
  win.addEventListener('keydown', onKeydown, true)
  win.addEventListener('click', onClick, true)
  win.addEventListener('click', onHistoryClick, true)
  win.addEventListener('input', onInput, true)
  for (const type of SEED_EVENTS) win.addEventListener(type, onSeedEvent, true)
  win.addEventListener('compositionend', onCompositionEnd)
  return () => {
    if (editorActionBoundary === actionBoundary)
      editorActionBoundary = undefined
    if (editorActionSeed === actionSeed) editorActionSeed = undefined
    if (historyPreparation === prepareHistory) historyPreparation = undefined
    for (const type of SEED_EVENTS)
      win.removeEventListener(type, onSeedEvent, true)
    win.removeEventListener('compositionend', onCompositionEnd)
    if (dirtyTimer) clearTimeout(dirtyTimer)
    win.removeEventListener('paste', onPaste, true)
    win.removeEventListener('keydown', onKeydown, true)
    win.removeEventListener('click', onClick, true)
    win.removeEventListener('click', onHistoryClick, true)
    win.removeEventListener('input', onInput, true)
  }
}
