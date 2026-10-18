import type Vditor from 'vditor'
import { hasClosestBlock } from 'vditor/src/ts/util/hasClosest'
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

// The slice of diff-match-patch that Vditor's undo engine owns (`undo.dmp`).
interface PatchEngine {
  diff_main(before: string, after: string, checkLines?: boolean): unknown
  patch_make(before: string, after: string, diffs: unknown): unknown[]
  patch_apply(patches: unknown[], text: string): [string, boolean[]]
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
    // Task 611: Vditor's snapshot (private `addCaret`) and its diff-match-patch engine (`dmp`), read
    // by `checkpointOrCoalesceUndo` so a caret-only checkpoint compares and rewrites exactly the
    // way the engine records and replays an entry.
    addCaret?: (inner: UndoInner, setFocus?: boolean) => string
    dmp?: PatchEngine
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

/** What `checkpointOrCoalesceUndo` did: pushed a new history entry, rewrote the top entry in place
 * (the live state differs from it only in the caret), or found nothing to record. */
export type UndoCheckpointResult = 'pushed' | 'coalesced' | 'unchanged'

/** Task 611 — checkpoint the live editor, but never as a caret-only entry. Vditor's
 * `addToUndoStack` pushes on any difference, so a caret move after a settled edit adds an entry
 * that one Ctrl+Z "undoes" without changing the text. When the live snapshot differs from the
 * last checkpoint only in the caret, the top entry is rewritten in place instead, so its state
 * is the live snapshot with the current caret and Undo of it still returns the previous state
 * (`previous = patch_apply(top, lastText)`; `top := patch_make(live, previous)`; `lastText :=
 * live`). The base entry follows the same rule (its previous state is empty, as in
 * `recordFirstPosition`).
 *
 * `sourceUnchanged` is for a caller that proved the source is the one the last checkpoint holds
 * (Turn Into over its own checkpoint). Every other difference is then view state, such as syntax
 * highlighting that finished after the checkpoint, and is coalesced too.
 *
 * The array is rewritten in place because Turn Into and Rewrap find their entry by identity. Any
 * text difference, an empty history, a live snapshot without a caret marker (the selection left
 * the editor) or a rewrite that does not replay exactly falls back to `addToUndoStack`, as
 * before. The Redo stack, `hasUndo` and the host are not touched. */
export function checkpointOrCoalesceUndo(
  inner: unknown,
  options: { sourceUnchanged?: boolean } = {},
): UndoCheckpointResult {
  const view = inner as UndoInner
  const coalesced = coalesceCaretOnlyDifference(view, options.sourceUnchanged)
  if (coalesced) return coalesced
  view.undo?.addToUndoStack?.(view)
  return 'pushed'
}

function coalesceCaretOnlyDifference(
  inner: UndoInner,
  sourceUnchanged = false,
): 'coalesced' | 'unchanged' | null {
  const undo = inner.undo
  const state = undo?.[inner.currentMode]
  const top = state?.undoStack?.at(-1)
  if (
    !undo?.addCaret ||
    !undo.dmp ||
    !state ||
    !Array.isArray(top) ||
    typeof state.lastText !== 'string'
  )
    return null
  const lastText = state.lastText
  // The engine's own snapshot, not `innerHTML`: it normalizes math, echarts and plantuml previews.
  const live = undo.addCaret(inner, true)
  if (live === lastText) return 'unchanged'
  if (!live.includes('<wbr>')) return null
  if (!sourceUnchanged && withoutCaret(live) !== withoutCaret(lastText))
    return null
  const dmp = undo.dmp
  const [previous, applied] = dmp.patch_apply(top, lastText)
  if (!applied.every(Boolean)) return null
  const rewritten = dmp.patch_make(
    live,
    previous,
    dmp.diff_main(live, previous, true),
  )
  if (rewritten.length === 0) return null
  const [replayed, replayApplied] = dmp.patch_apply(rewritten, live)
  if (replayed !== previous || !replayApplied.every(Boolean)) return null
  top.splice(0, top.length, ...rewritten)
  state.lastText = live
  return 'coalesced'
}

// Task 601 — the caret marker and IR's caret-dependent expansion class are not source. Comparing
// the live editor HTML with the last checkpoint's HTML without them tells a pending callback that
// would only move the caret from one that holds an edit. Any other difference counts as an edit,
// so this can only miss a no-op (and then drain it, as natural expiry would), never skip an edit.
// Task 639: a table's width classes (automatic `vmde-table-auto-N`, manual `vmde-table-width-N` and
// `vmde-table-resized`) are view state the layout adds to the live DOM, not source, so a
// class-only difference is not an edit either.
const TABLE_WIDTH_CLASS = /^vmde-table-(?:auto-\d+|width-\d+|resized)$/

function withoutTableWidthClasses(html: string): string {
  return html.replace(
    / class="([^"]*)"/g,
    (attribute: string, value: string) => {
      const kept = value
        .split(/\s+/)
        .filter((name) => name && !TABLE_WIDTH_CLASS.test(name))
      if (kept.length === value.split(/\s+/).filter(Boolean).length)
        return attribute
      return kept.length > 0 ? ` class="${kept.join(' ')}"` : ''
    },
  )
}

function withoutCaret(html: string): string {
  return withoutTableWidthClasses(
    html
      .replace(/<wbr>|<span class="vditor-wbr"><\/span>/g, '')
      .replace(/ vditor-ir__node--expand/g, ''),
  )
}

// Task 608 — a blockless IR range starts inside the editor but outside every block (the bare
// editable root), in an editor that has a top-level block; the empty editor has none and keeps
// Vditor's paths. This is the same predicate as the build-time Headings, Link and Code/Table
// patches. Vditor's snapshot (`addCaret`) writes a caret marker at the live range and restores the
// caret from it, which puts a root range at the nearest text. A toolbar click took that snapshot
// before its action ran, so the later Headings (h2) click saw a range inside a block and rewrote it.
function blocklessRange(inner: UndoInner): Range | null {
  const root = inner.ir?.element
  const selection = getSelection()
  if (inner.currentMode !== 'ir' || !root || !selection?.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (
    !root.contains(range.startContainer) ||
    hasClosestBlock(range.startContainer)
  )
    return null
  return root.querySelector(':scope > [data-block]') ? range : null
}

/** Run a snapshot, then put a blockless range back where the snapshot's caret round trip moved it. */
function keepBlocklessRange(inner: UndoInner, snapshot: () => void): void {
  const saved = blocklessRange(inner)?.cloneRange()
  snapshot()
  if (!saved?.startContainer.isConnected) return
  const selection = getSelection()
  const live = selection?.rangeCount ? selection.getRangeAt(0) : null
  if (
    live &&
    live.startContainer === saved.startContainer &&
    live.startOffset === saved.startOffset &&
    live.endContainer === saved.endContainer &&
    live.endOffset === saved.endOffset
  )
    return
  selection?.removeAllRanges()
  selection?.addRange(saved)
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

// Task 631 (collapse toggle) and Task 653 (Outline, then every other toolbar control that edits
// nothing) only show or hide chrome, post a host message, open a menu or a dialog, or switch a view.
// A boundary at any of them would add a history entry that differs from the last one in decoration
// and the caret marker alone. `emoji` and `math` only open a panel: the insertion is the click on
// one of the panel's own buttons, which keeps its boundary. `headings` is not listed (its trigger
// removes the heading when it is the current one), nor are `code`, `table` and `line` (they insert
// on their own click). Controls that insert or format text (the insert-anchor and insert-picture
// rows, every formatting button and menu choice) keep theirs. The `.vditor-panel`
// form covers the controls that sit in a submenu or in More after the toolbar overflow moves them.
const VIEW_ONLY_CONTROLS: readonly string[] = [
  'collapse-toolbar',
  'outline',
  'navigate-back',
  'wiki-pages',
  'edit-in-vscode',
  'more',
  'settings',
  'info',
  'about',
  'both',
  'emoji',
  'math',
  // Preview and edit-mode only change the view; a synthetic input for either would publish
  // Vditor's canonicalized Markdown as a document edit during a source-inert mode transition.
  'preview',
  'edit-mode',
]
const VIEW_ONLY_SELECTOR = [
  ...VIEW_ONLY_CONTROLS.flatMap((type) => [
    `.vditor-toolbar [data-type="${type}"]`,
    `.vditor-panel [data-type="${type}"]`,
  ]),
  // The mode choices in the edit-mode panel.
  '.vditor-toolbar [data-mode]',
  '.vditor-panel [data-mode]',
].join(', ')

function isViewToggle(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(VIEW_ONLY_SELECTOR)
}

function isToolbarAction(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const action = target.closest<HTMLElement>(
    '.vditor-toolbar button, .vditor-panel button',
  )
  return Boolean(
    action &&
      !isViewToggle(action) &&
      action.dataset.type !== 'undo' &&
      action.dataset.type !== 'redo',
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
  /** Task 628 (R2): whether the boundary's state (the live Markdown) renders like the text the host
   * already holds. Such a boundary records its entry but publishes nothing: a host write of a
   * byte-different, equivalent text is later undone by the host's no-op restore, which the native
   * Undo history cannot follow. */
  equivalentToHost?: (markdown: string) => boolean
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
    keepBlocklessRange(current, () => {
      seedUndoBaseline(current)
      if (forceBefore || dirty) checkpointUndoBoundary(current, true)
    })
    const mode = current.currentMode
    const stackLength = current.undo?.[current.currentMode]?.undoStack?.length
    setTimeout(() => {
      const settled = inner()
      const settledLength =
        settled.undo?.[settled.currentMode]?.undoStack?.length
      cancelPendingAfterRender(settled)
      // Task 628 (R1): schedule the edit before recording the entry. The entry's flush
      // (finish-init's onEntryRecorded) posts only an edit that is already scheduled; scheduling
      // after it left the boundary's state in the same debounced post as the next key, so the
      // host never held a state native Undo could reach for this entry.
      const markdown = vditor.getValue()
      if (!options.equivalentToHost?.(markdown))
        settled.options?.input?.(markdown)
      const recordable =
        settled.currentMode !== mode
          ? settledLength === 0
          : stackLength === undefined || settledLength === stackLength
      // Task 608: a click that left a blockless range with the source unchanged (a refused
      // Headings or Link, for example) has nothing to record, and the snapshot would move the
      // range into a block before the panel's second click.
      if (recordable && !(blocklessRange(settled) && sourceNeutral(settled)))
        keepBlocklessRange(settled, () =>
          checkpointUndoBoundary(settled, false),
        )
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
    // Task 631, Task 653: Enter on a view-only control (collapse toggle, Outline, Preview, the mode
    // controls and the rest) is not an edit.
    if (isViewToggle(event.target)) return
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
