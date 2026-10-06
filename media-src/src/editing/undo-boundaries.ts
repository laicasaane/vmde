import type Vditor from 'vditor'
import type { EditorAction } from '../../../src/shared/protocol'
import { guardComposition, isCompositionActive } from '../util/caret-gesture'
import { isMac } from '../util/platform'

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

interface UndoInner {
  currentMode: UndoMode
  options?: {
    undoDelay?: number
    input?: (markdown: string) => void
  }
  ir?: { processTimeoutId?: number; element?: HTMLElement }
  wysiwyg?: { afterRenderTimeoutId?: number; element?: HTMLElement }
  sv?: { processTimeoutId?: number; element?: HTMLElement }
  undo?: {
    addToUndoStack?: (inner: UndoInner) => void
    // Task 598: added by the build-time patch `patchUndoSeedBaseline` (media-src/esbuild-shared.mjs).
    vmdeSeedBaseline?: (inner: UndoInner, event?: Event) => boolean
    vmdeHeldTimer?: number
    ir?: { undoStack?: unknown[] }
    wysiwyg?: { undoStack?: unknown[] }
    sv?: { undoStack?: unknown[] }
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

export function checkpointUndoBoundary(
  inner: UndoInner,
  cancelPending: boolean,
): void {
  const timer = pendingTimer(inner)
  if (cancelPending && timer !== undefined) clearTimeout(timer)
  inner.undo?.addToUndoStack?.(inner)
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

export function installUndoBoundaries(
  vditor: Vditor,
  win: Window & typeof globalThis = window,
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
      const timer = pendingTimer(settled)
      if (timer !== undefined) clearTimeout(timer)
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

  const actionBoundary = () => boundary()
  const actionSeed = () => {
    seedUndoBaseline(inner())
  }
  editorActionBoundary = actionBoundary
  editorActionSeed = actionSeed

  win.addEventListener('paste', onPaste, true)
  win.addEventListener('keydown', onKeydown, true)
  win.addEventListener('click', onClick, true)
  win.addEventListener('input', onInput, true)
  for (const type of SEED_EVENTS) win.addEventListener(type, onSeedEvent, true)
  win.addEventListener('compositionend', onCompositionEnd)
  return () => {
    if (editorActionBoundary === actionBoundary)
      editorActionBoundary = undefined
    if (editorActionSeed === actionSeed) editorActionSeed = undefined
    for (const type of SEED_EVENTS)
      win.removeEventListener(type, onSeedEvent, true)
    win.removeEventListener('compositionend', onCompositionEnd)
    if (dirtyTimer) clearTimeout(dirtyTimer)
    win.removeEventListener('paste', onPaste, true)
    win.removeEventListener('keydown', onKeydown, true)
    win.removeEventListener('click', onClick, true)
    win.removeEventListener('input', onInput, true)
  }
}
