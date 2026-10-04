import type Vditor from 'vditor'
import type { EditorAction } from '../../../src/shared/protocol'
import { guardComposition } from '../util/caret-gesture'
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
  ir?: { processTimeoutId?: number }
  wysiwyg?: { afterRenderTimeoutId?: number }
  sv?: { processTimeoutId?: number }
  undo?: {
    addToUndoStack?: (inner: UndoInner) => void
    ir?: { undoStack?: unknown[] }
    wysiwyg?: { undoStack?: unknown[] }
    sv?: { undoStack?: unknown[] }
  }
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

// The installed editor's boundary, or undefined before init and after dispose.
let editorActionBoundary: (() => void) | undefined

/** Take the boundary an editor action's old key took (see EDITOR_ACTION_UNDO_BOUNDARIES). Returns
 * whether a boundary was taken. `boundaryActions` is injectable for tests. */
export function takeEditorActionUndoBoundary(
  action: EditorAction,
  boundaryActions: ReadonlySet<EditorAction> = EDITOR_ACTION_UNDO_BOUNDARIES,
): boolean {
  if (!boundaryActions.has(action) || !editorActionBoundary) return false
  editorActionBoundary()
  return true
}

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
    if (event.key === 'Enter' || isUndoBoundaryCommand(event, onMac)) boundary()
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
  editorActionBoundary = actionBoundary

  win.addEventListener('paste', onPaste, true)
  win.addEventListener('keydown', onKeydown, true)
  win.addEventListener('click', onClick, true)
  win.addEventListener('input', onInput, true)
  return () => {
    if (editorActionBoundary === actionBoundary)
      editorActionBoundary = undefined
    if (dirtyTimer) clearTimeout(dirtyTimer)
    win.removeEventListener('paste', onPaste, true)
    win.removeEventListener('keydown', onKeydown, true)
    win.removeEventListener('click', onClick, true)
    win.removeEventListener('input', onInput, true)
  }
}
