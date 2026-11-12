import type Vditor from 'vditor'
import { hasClosestBlock } from 'vditor/src/ts/util/hasClosest'
import type { EditorAction } from '../../../src/shared/protocol'
import { guardComposition, isCompositionActive } from '../util/caret-gesture'
import { explicitEditPending } from '../links/link-url'
import { isMac } from '../util/platform'
import { logToHost, reportError } from '../util/webview-log'
import { invalidateCaret, writeSelection } from './caret'
import { historyStoreOf } from './history-store'

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
  // Presence only: the Undo state is read through the history store.
  undo?: object
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
  return historyStoreOf(inner)?.seedBaseline(event) ?? false
}

/** Task 688 — `seedUndoBaseline` for a caller that holds Vditor's inner editor under another type
 * (a router, a panel). Call it after the action is validated and before its first checkpoint: an
 * action that is the first thing done after open runs on an empty history, and a history base read
 * after the change makes the host pair the changed text with its unchanged text, so Redo applies
 * nothing. Does nothing once the active mode has history; returns whether it seeded. */
export function seedHistoryOf(inner: unknown): boolean {
  return inner ? seedUndoBaseline(inner as UndoInner) : false
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
  return historyStoreOf(inner)?.isEmpty() ?? true
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

/** Task 699: retire the after-render record of every mode, not only the current one. A record
 * armed in another mode (the open-time IR record still pending after a switch to WYSIWYG) keeps its
 * timer, and its body calls `addToUndoStack`, which records into the CURRENT mode's history. It then
 * adds a same-text entry (caret-only difference) after an exact action, and the next Undo pops that
 * entry without changing the text. A record of a mode that is not current carries no edit the
 * current history needs, so retiring it loses nothing. Three property reads; `clearTimeout` runs
 * only for an armed record. Consumed by `cancelPendingAfterRender` and `cancelPendingUndoSnapshot`
 * (rewrap-command.ts). */
export function retireAfterRenderRecords(inner: UndoInner): void {
  const timer = pendingTimer(inner)
  if (timer !== undefined) clearTimeout(timer)
  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    const owner = inner[mode]
    const record = owner?.vmdeAfterRender
    if (!owner || !record) continue
    if (record.timer !== undefined) clearTimeout(record.timer)
    owner.vmdeAfterRender = undefined
  }
}

/** Cancel the active mode's scheduled after-render callback. Task 601: its record is retired too,
 * so a cancelled callback can never be drained before a later history transition. Task 699: the
 * records of the other modes are retired with it. */
export function cancelPendingAfterRender(inner: UndoInner): void {
  retireAfterRenderRecords(inner)
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

/** Whether the boundary's own checkpoint is still due after the click's work settled: a new mode
 * records only into an empty history, and the same mode records only when nothing was recorded
 * meanwhile (its revision is unchanged). A mode without history before the click always records. */
function boundaryRecordable(
  settled: UndoInner,
  mode: UndoMode,
  hadHistory: boolean,
  revisionBefore: number | undefined,
): boolean {
  const store = historyStoreOf(settled)
  if (settled.currentMode !== mode)
    return store?.slot() !== undefined && store.isEmpty()
  return !hadHistory || store?.revision() === revisionBefore
}

export function checkpointUndoBoundary(
  inner: UndoInner,
  cancelPending: boolean,
): void {
  if (cancelPending) cancelPendingAfterRender(inner)
  historyStoreOf(inner)?.checkpoint()
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
  // The caret-only rewrite itself (`amendTopCaret`) lives in the history store.
  return historyStoreOf(inner)?.checkpointOrCoalesce(options) ?? 'pushed'
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
  // Deliberate (Task 683): the snapshot's caret restore arms a caret intent that cannot name a root
  // position (it resolves to the nearest text), so an intent left armed would move this range into
  // a block on the next frame. Putting the blockless range back retires that intent.
  writeSelection(saved)
}

// Task 601 — the caret marker, IR's caret-dependent expansion class (Task 639: a table's width
// classes; Task 640: wrap hints) are not source. The history store compares the live editor HTML
// with the last checkpoint's HTML without them, which tells a pending callback that would only
// move the caret from one that holds an edit. Any other difference counts as an edit, so this can
// only miss a no-op (and then drain it, as natural expiry would), never skip an edit.
function sourceNeutral(inner: UndoInner): boolean {
  return historyStoreOf(inner)?.isSourceNeutral() ?? false
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
// controls, on the toolbar row or as rows of More, every formatting button and menu choice) keep
// theirs. The `.vditor-panel`
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
  flushHistoryInput?: () => boolean | 'deferred'
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

/** Whether the boundary must hand its state to `input`. Normally unless the state renders like the
 * host text. Task 699: a toolbar Link click changed the source under a fresh explicit-edit mark is
 * published regardless (needs the pre-click source, so false for every other action). */
function mustPublishBoundary(
  win: Window,
  options: UndoBoundaryOptions,
  explicitBefore: string | undefined,
  sameMode: boolean,
  markdown: string,
): boolean {
  if (
    explicitBefore !== undefined &&
    sameMode &&
    markdown !== explicitBefore &&
    explicitEditPending(win)
  )
    return true
  return !options.equivalentToHost?.(markdown)
}

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
  const boundary = (forceBefore = false, explicitBefore?: string) => {
    const current = inner()
    // Task 598: seed first, so the after-action checkpoint below is a second entry, not the baseline.
    keepBlocklessRange(current, () => {
      seedUndoBaseline(current)
      if (forceBefore || dirty) {
        checkpointUndoBoundary(current, true)
        // Task 719: the engine's `addCaret` armed a caret intent at the pre-action caret. For a
        // paste Vditor then moves the caret through its own writer, which does not retire the
        // intent, so the first frame (or `writeSelectionKeepingIntent`) wrote the stale position
        // back before the post-action checkpoint re-armed the real one. Retire it here, as
        // `prepareHistory` does after a drained checkpoint (Task 597).
        invalidateCaret()
      }
    })
    const mode = current.currentMode
    // The revision replaces the stack-length compare: it also sees a push that trimmed the oldest
    // entry and an in-place amend.
    const store = historyStoreOf(current)
    const hadHistory = store?.slot() !== undefined
    const revisionBefore = store?.revision()
    setTimeout(() => {
      const settled = inner()
      cancelPendingAfterRender(settled)
      // Task 628 (R1): schedule the edit before recording the entry. The entry's flush
      // (finish-init's onEntryRecorded) posts only an edit that is already scheduled; scheduling
      // after it left the boundary's state in the same debounced post as the next key, so the
      // host never held a state native Undo could reach for this entry.
      const markdown = vditor.getValue()
      // Task 699: the toolbar Link turns a selected URL into `[url](url)`, which can render like the
      // host's bare URL and be skipped as a semantic no-op, while Vditor's own timer is cancelled
      // above: nothing would ever publish it. `explicitBefore` exists only for a Link click, so the
      // bypass needs a fresh explicit mark AND a real source change (a Link that did nothing stays
      // suppressed). The mark is only peeked: the flush that follows reads it for `explicitBlock`.
      if (
        mustPublishBoundary(
          win,
          options,
          explicitBefore,
          settled.currentMode === mode,
          markdown,
        )
      )
        settled.options?.input?.(markdown)
      const recordable = boundaryRecordable(
        settled,
        mode,
        hadHistory,
        revisionBefore,
      )
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
      historyStoreOf(current)?.holdPendingTimer(pendingTimer(current))
  }
  const onClick = (event: MouseEvent) => {
    if (!isToolbarAction(event.target)) return
    // Task 699: only the Link button needs its pre-command source (this capture listener runs
    // before Vditor's handler), so no other click serializes here.
    const link =
      event.target instanceof Element &&
      event.target.closest<HTMLElement>('[data-type="link"]')
    boundary(false, link ? vditor.getValue() : undefined)
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
