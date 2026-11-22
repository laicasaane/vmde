import {
  disableToolbar,
  enableToolbar,
  hidePanel,
} from 'vditor/src/ts/toolbar/setToolbar'
import {
  type HistoryModelPort,
  type RestoredCaret,
  SOURCE_UNITS,
  type UnitMode,
  unitModeOf,
} from '../util/unit-changes'
import { logToHost } from '../util/webview-log'
import {
  invalidateCaret,
  requestCaret,
  writeSelectionKeepingIntent,
} from './caret'
import {
  type AmendResult,
  type HistoryEntryToken,
  type HistorySavepoint,
  type HistorySlotToken,
  IR_HISTORY_ENGINE,
  provideUnitHistoryDelegate,
  SOURCE_HISTORY_ENGINE,
  reportUnitEntry,
  type UnitHistoryDelegate,
} from './history-store'
import {
  hasRewrapDocumentHistoryTransition,
  hasTaggedRewrapDocumentHistory,
  moveRewrapDocumentHistory,
} from './rewrap-command'
import { placeRestoredCaret } from './undo-restore-caret'

// Task 733 (task 004): the unit history engine for IR. An entry holds the capture of the units that
// changed between two checkpoints (bridge/unit-capture.ts), the caret before and after, and the
// number of native steps the host walked for it. Undo restores the capture's `before` side and posts
// one `history-delta`; no whole-editor snapshot or diff is taken. Vditor's `Undo` class stays bundled:
// the build patch `patchUndoUnitEngine` hands each method to this hook while it claims the editor,
// and the old engine runs otherwise (WYSIWYG, Source, `IR_HISTORY_ENGINE === 'vditor'`).

export interface UnitHistoryDeps {
  port(): HistoryModelPort | undefined
  /** Task 733 / 036: `exactId` names a replayable Find pair; the host replays it (`history-exact`). */
  publishHistory(
    kind: 'undo' | 'redo',
    steps: number,
    exactId?: string,
  ): 'delta' | 'nothing' | 'fallback'
  /**
   * Task 733 / 036: the evicted-pair recovery, the Task 685 exact post (`postExact` with `history`,
   * `before` and `rollback: false`).
   */
  postExactHistory?(exact: string, before: string, kind: 'undo' | 'redo'): void
  /**
   * Task 733 / 036 (F8): the model session still handles an exact replay (awaiting its answer, slicing, or
   * abandoned until the resync update lands). Absent: busy until the engine is reinstalled.
   */
  exactBusy?(): boolean
  /**
   * Task 733 / 036 (step C, fix design 2.6): the replay's logical text is live, so input and history
   * moves continue during the replay instead of being refused. Absent: false.
   */
  replayLive?(): boolean
  /** Task 733 / 036 (step C, 2.6): before an input's default action: render its endpoints, capture its intent. */
  beforeReplayInput?(event: Event): void
  /** Task 733 / 036 (step C, 2.7): render the group the caret intent lies in. */
  renderReplayCaretGroup?(): void
  lastPostedSequence(): number
  epoch(): number | undefined
  /**
   * Task 733 / 015 (D-7): the mode whose text model is live (`ModelSession.liveMode`). The engine holds
   * Source history only while it is `sv`; absent: Source stays on the old engine.
   */
  liveMode?(): 'ir' | 'wysiwyg' | 'sv' | undefined
}

interface UnitHistoryHook {
  claims(vditor: unknown): boolean
  undo(vditor: unknown): void
  redo(vditor: unknown): void
  record(vditor: unknown): void
  recordFirstPosition(vditor: unknown, event: Event): void
  clear(vditor: unknown): void
  resetIcon(vditor: unknown): void
  seedBaseline(vditor: unknown, event?: Event): boolean
  /** Whether the engine would hold this editor's history; a read without side effects (unlike `claims`). */
  holds(vditor: unknown): boolean
  /**
   * Task 733 / 036 D-18: the engine owns this editor's history now, for an IR-owned Undo/Redo key. A read
   * without side effects: the editor's state exists, its last `claims` answer was true for the current
   * mode, and `holds` still is (a port that lost eligibility after the last claim is not owned).
   */
  ownsHistoryNow(vditor: unknown): boolean
  /**
   * The engine holds the history, the model is live and trusted, and the base exists (Vditor's initial
   * record ran). The end-to-end specs wait for it where they waited for Vditor's initial snapshot.
   */
  settled(vditor: unknown): boolean
  /** The depth of the stacks in the form Vditor's slots have (the base counts as one Undo entry); a read for the end-to-end specs. */
  depth(vditor: unknown): { undo: number; redo: number }
  /**
   * Task 733 / 034 (Q-205 item 1): the Undo and Redo moves that placed the caret at the restored change
   * site (`placeRestoredCaret`); the unit engine's counterpart of the old engine's marker fallback count.
   */
  changeSites(vditor: unknown): number
  /** Task 733 / 036 (T0): the Undo and Redo moves that restored an entry; a read for the end-to-end specs. */
  moves(vditor: unknown): number
  /**
   * Task 733 / 036: the move `kind` would make is a tagged exact replay: the engine claims, nothing is
   * pending, and the entry it pops carries a replayable or evicted Find record (one token compare).
   */
  peekExact(vditor: unknown, kind: 'undo' | 'redo'): boolean
  /** Task 733 / 036 (F8): an exact replay of this editor is not handled yet; editing input is refused. */
  historyBusy(vditor: unknown): boolean
}

declare global {
  interface Window {
    __vmdeUnitHistory?: UnitHistoryHook
  }
}

/** Task 733 / 036: a key that edits text (navigation, modifiers and shortcuts pass through). */
const isEditingKey = (event: KeyboardEvent): boolean =>
  !event.ctrlKey &&
  !event.metaKey &&
  (event.key.length === 1 ||
    event.key === 'Enter' ||
    event.key === 'Backspace' ||
    event.key === 'Delete' ||
    event.key === 'Tab')

/** Vditor's own `stackSize`. */
const MAX_ENTRIES = 50

/** The `__vmdeRequestCaret` intent forms the engine records (editing/caret.ts). */
type Point =
  | { blockPath: number[]; offsetInBlock: number; affinity?: 'backward' }
  | { node: Node; offset: number }
type CaretIntent = Point | { anchor: Point; focus: Point }

interface Entry {
  readonly capture: Parameters<HistoryModelPort['restore']>[0]
  readonly caretBefore: CaretIntent | undefined
  caretAfter: CaretIntent | undefined
  /**
   * Task 733 / 034: the checkpoint before (after) the change found no editor selection (focus in Find, a
   * popover field): `caretBefore` (`caretAfter`) is an older position or none, and the restore supplies
   * the caret from the change itself.
   */
  readonly beforeMissing: boolean
  afterMissing: boolean
  /** Native host steps this entry spans; 0 when only whole-text posts lay in it. */
  steps: number
  epoch: number | undefined
  readonly token: HistoryEntryToken
}

interface Open {
  epoch: number | undefined
  sequence: number
  caret: CaretIntent | undefined
  /** Task 733 / 034: the last checkpoint found no editor selection; `caret` is older or absent. */
  missing: boolean
}

interface State {
  undo: Entry[]
  redo: Entry[]
  base: { token: HistoryEntryToken; caret: CaretIntent | undefined } | undefined
  slot: HistorySlotToken
  revision: number
  open: Open
  /** An Undo or Redo happened since the last record: the next recorded change clears Redo. */
  moved: boolean
  /** The last answer of `claims`, to see an engine hand-over; undefined before the first call. */
  claimed: boolean | undefined
  /** Task 733 / 013: the mode the kept history describes; a claim in another mode starts a new one. */
  claimedMode?: EngineMode
  /** Task 733 / 034: see `UnitHistoryHook.changeSites`. */
  changeSites: number
  /** Task 733 / 036: see `UnitHistoryHook.moves`. */
  moves: number
  /**
   * H2 fix design rev2 (D7.1): both stacks were emptied by a host text that ended an exact replay of
   * this editor; a history key then is a counted refusal until the next entry.
   */
  replayReset?: boolean
}

/** Task 733 / 015: the modes the engine can hold: IR and WYSIWYG units (013) and Source (D-7). */
type EngineMode = UnitMode | 'sv'

/** The per-mode editor state the engine reads (`vditor.ir`, `vditor.wysiwyg`). */
type ModeState = {
  element: HTMLElement
  composingLock?: boolean
  processTimeoutId?: number
  /** WYSIWYG's pending after-render timer (IR names it `processTimeoutId`). */
  afterRenderTimeoutId?: number
  vmdeAfterRender?: unknown
}

type Vditor = {
  currentMode: string
  ir: ModeState
  wysiwyg?: ModeState
  sv?: ModeState
  undo: Record<string, any>
  toolbar?: { elements: Record<string, HTMLElement>; element?: HTMLElement }
  hint?: unknown
}

const token = <T>(): T => Object.freeze({}) as unknown as T

/** The mode the editor shows when the engine can serve it, else undefined. O(1), no allocation. */
const servedModeOf = (vditor: Vditor): EngineMode | undefined =>
  vditor.currentMode === 'sv' ? 'sv' : unitModeOf(vditor.currentMode)

/** Task 733 / 013: the mode the engine serves for the editor ('ir' when it serves none). O(1). */
const modeOf = (vditor: Vditor): EngineMode => servedModeOf(vditor) ?? 'ir'

/** The editor state of the served mode (`vditor.ir`, `vditor.wysiwyg` with WYSIWYG units, `vditor.sv`). */
const stateOfMode = (vditor: Vditor): ModeState | undefined => {
  const mode = modeOf(vditor)
  if (mode === 'sv') return vditor.sv
  return mode === 'wysiwyg' ? vditor.wysiwyg : vditor.ir
}

/** The old engine's IR slot holds an entry above its base, or a Redo entry. */
const oldHolds = (vditor: Vditor): boolean => {
  const slot = vditor.undo?.[modeOf(vditor)] as
    | { undoStack?: unknown[]; redoStack?: unknown[] }
    | undefined
  return (
    (slot?.undoStack?.length ?? 0) > 1 || (slot?.redoStack?.length ?? 0) > 0
  )
}

const samePoint = (a: Point, b: Point): boolean => {
  if ('node' in a || 'node' in b) {
    return (
      'node' in a && 'node' in b && a.node === b.node && a.offset === b.offset
    )
  }
  return (
    a.offsetInBlock === b.offsetInBlock &&
    a.affinity === b.affinity &&
    a.blockPath.length === b.blockPath.length &&
    a.blockPath.every((index, at) => index === b.blockPath[at])
  )
}

/** Structural comparison of two caret intents: no serialization, and a DOM node compares by identity. */
function sameIntent(
  a: CaretIntent | undefined,
  b: CaretIntent | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if ('anchor' in a || 'anchor' in b) {
    return (
      'anchor' in a &&
      'anchor' in b &&
      samePoint(a.anchor, b.anchor) &&
      samePoint(a.focus, b.focus)
    )
  }
  return samePoint(a, b)
}

/**
 * Task 733 / 034 (repair 2): no usable caret: none, or one collapsed on the editable root (`pointOf`
 * keeps the root itself). A checkpoint right after a rebuild finds the latter: Find's keybinding
 * Replace One checkpoints after its `setValue` and asks for its caret one frame later
 * (`replaceFindMatch`, selection-scope.ts), and putting that caret back lands outside every block.
 * O(1), no allocation.
 */
const missingCaret = (caret: CaretIntent | undefined): boolean =>
  caret === undefined || 'node' in ('anchor' in caret ? caret.anchor : caret)

/**
 * Task 733 / 034: the holder a restore fills with the change's caret, only when the step has no usable
 * caret of its own; the only allocation of that path.
 */
const caretRequest = (
  entry: Entry,
  kind: 'undo' | 'redo',
): RestoredCaret | undefined =>
  (kind === 'undo' ? entry.beforeMissing : entry.afterMissing)
    ? { endpoint: undefined }
    : undefined

const emptyOpen = (): Open => ({
  epoch: undefined,
  sequence: 0,
  caret: undefined,
  missing: true,
})

const CARET_BLOCK =
  'p, h1, h2, h3, h4, h5, h6, li, blockquote, tr, pre, [data-block]'

function pointOf(
  root: HTMLElement,
  node: Node,
  offset: number,
): Point | undefined {
  if (!root.contains(node)) return undefined
  if (node === root) return { node, offset }
  const host =
    node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  const block = host?.closest(CARET_BLOCK)
  if (!block || block === root || !root.contains(block)) return undefined
  const blockPath: number[] = []
  for (let walk: Element | null = block; walk && walk !== root; ) {
    const parent: Element | null = walk.parentElement
    if (!parent) return undefined
    blockPath.unshift(Array.prototype.indexOf.call(parent.children, walk))
    walk = parent
  }
  const before = document.createRange()
  before.selectNodeContents(block)
  before.setEnd(node, offset)
  const point: Point = { blockPath, offsetInBlock: before.toString().length }
  const marker = host?.closest('.vditor-ir__marker')
  if (marker && !marker.classList.contains('vditor-ir__marker--pre')) {
    point.affinity = 'backward'
  }
  return point
}

/**
 * The caret a checkpoint puts back through the caret authority, as Vditor's patched `addCaret` did at
 * every `addToUndoStack` (`patchUndoCaretSplitRestore`): a selection keeps both ordered endpoints and a
 * collapsed caret its block position, re-asserted until it can be painted. Commands rely on it: a
 * checkpoint before a `setValue` keeps the caret where it was, and one after keeps a directional
 * selection that a decoration pass detaches. A collapsed caret in an element container was written
 * back once and armed nothing; the unit engine writes no marker, so that caret needs nothing. Nothing
 * is armed while the toolbar holds the focus.
 */
function checkpointCaret(vditor: Vditor): CaretIntent | undefined {
  const root = stateOfMode(vditor)?.element
  const selection = window.getSelection()
  if (!root || !selection || selection.rangeCount === 0) return undefined
  if (vditor.toolbar?.element?.contains(document.activeElement))
    return undefined
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer)) return undefined
  if (
    range.collapsed &&
    range.startContainer.nodeType === Node.ELEMENT_NODE &&
    !(
      range.startOffset <= 1 &&
      (range.startContainer.firstChild as Element | null)?.classList?.contains(
        'vditor-ir__marker',
      )
    )
  )
    return undefined
  return caretNow(vditor)
}

/** The live selection as a caret intent, never a `<wbr>` marker in the DOM. */
function caretNow(vditor: Vditor): CaretIntent | undefined {
  const selection = window.getSelection()
  const root = stateOfMode(vditor)?.element
  if (!root || !selection || selection.rangeCount === 0) return undefined
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection
  if (!anchorNode || !focusNode) return undefined
  const anchor = pointOf(root, anchorNode, anchorOffset)
  if (!anchor) return undefined
  if (selection.isCollapsed) return anchor
  const focus = pointOf(root, focusNode, focusOffset)
  return focus ? { anchor, focus } : anchor
}

/**
 * True when the caret's top-level block holds a caret marker, which already splits the text there.
 * Only that block is searched, never the whole root (a whole-root search ran on every first key).
 */
function caretBlockHasMarker(root: Element, range: Range): boolean {
  const start = range.startContainer
  let block: Node | null =
    start === root ? (root.childNodes[range.startOffset] ?? null) : start
  while (block?.parentNode && block.parentNode !== root)
    block = block.parentNode
  return (
    block instanceof Element &&
    (block.localName === 'wbr' || block.querySelector('wbr') !== null)
  )
}

/**
 * Splits the text at the range start. A text node is split with `splitText`, which inserts no
 * element (an inserted and removed span cost a native insert that grew with the document on the
 * first key). An element endpoint is already a node boundary: the text after it is its own node, so
 * there is nothing to split and the DOM is left unchanged (C7; the marker Vditor's seed inserted and
 * removed there changed no HTML).
 */
function splitAtRangeStart(range: Range): void {
  const start = range.startContainer
  if (start.nodeType === Node.TEXT_NODE)
    (start as Text).splitText(range.startOffset)
}

/**
 * A checkpoint with no change (before an action, after a caret move): the next entry starts at the
 * caret it found, so its Undo puts the caret where the action began. Task 733 / 034: one that found no
 * editor selection (Find's Replace checkpoints while its input has the focus) keeps the older caret but
 * marks it, so the restore supplies the change's own.
 */
function noteCheckpointCaret(vditor: Vditor, open: Open): Open {
  const caret = caretNow(vditor)
  const missing = missingCaret(caret)
  if (!missing && (open.missing || !sameIntent(caret, open.caret)))
    return { ...open, caret, missing: false }
  if (missing && !open.missing) return { ...open, missing: true }
  return open
}

export function installUnitHistory(
  win: Window,
  deps: UnitHistoryDeps,
): () => void {
  const states = new WeakMap<object, State>()
  let refused = 0
  // H2 fix design rev2 (D7.1): history keys refused after a resync reset (a count only, no text).
  let resetRefused = 0

  const stateOf = (vditor: Vditor): State => {
    let state = states.get(vditor)
    if (!state) {
      state = {
        undo: [],
        redo: [],
        base: undefined,
        slot: token<HistorySlotToken>(),
        revision: 0,
        open: emptyOpen(),
        moved: false,
        claimed: undefined,
        changeSites: 0,
        moves: 0,
      }
      states.set(vditor, state)
    }
    return state
  }

  const drop = (state: State): void => {
    state.undo.length = 0
    state.redo.length = 0
    state.base = undefined
    state.slot = token<HistorySlotToken>()
    state.open = emptyOpen()
    state.moved = false
    state.revision += 1
  }

  const resetIcon = (vditor: Vditor): void => {
    const elements = vditor.toolbar?.elements
    if (!elements) return
    const state = stateOf(vditor)
    ;(state.undo.length > 0 ? enableToolbar : disableToolbar)(elements, [
      'undo',
    ])
    ;(state.redo.length > 0 ? enableToolbar : disableToolbar)(elements, [
      'redo',
    ])
  }

  /** Task 733 / 015 (D-7): Source with the unit engine on and the Source model live. */
  const holdsSource = (): boolean =>
    SOURCE_UNITS &&
    SOURCE_HISTORY_ENGINE === 'unit' &&
    deps.liveMode?.() === 'sv'

  const holds = (vditor: Vditor): boolean =>
    (vditor.currentMode === 'sv'
      ? holdsSource()
      : unitModeOf(vditor.currentMode) !== undefined &&
        IR_HISTORY_ENGINE === 'unit') && deps.port()?.claimable() === true

  /**
   * Another engine held the history in between (a mode switch, a rebuild without a model): what this
   * one kept describes a DOM that is gone. Vditor's IR slot is reset when it takes over again.
   */
  const handOver = (vditor: Vditor, state: State, value: boolean): void => {
    drop(state)
    const slotName = modeOf(vditor)
    if (!value && state.claimed && vditor.undo?.[slotName]) {
      vditor.undo[slotName] = {
        hasUndo: false,
        lastText: '',
        redoStack: [],
        undoStack: [],
      }
    }
    const took = value && !state.claimed
    state.claimed = value
    // The old engine had taken its base (Vditor's initial record) before the model was live: the
    // unit engine starts its history here, as that record would have started it.
    if (took && (vditor.undo?.[slotName]?.undoStack?.length ?? 0) > 0) {
      createBase(vditor, state)
      report(
        vditor,
        state,
        (state.base as NonNullable<State['base']>).token,
        true,
      )
    }
  }

  const claims = (raw: unknown): boolean => {
    const vditor = raw as Vditor
    const value = holds(vditor)
    const state = stateOf(vditor)
    const mode = modeOf(vditor)
    if (state.claimed === undefined) {
      state.claimed = value
    } else if (value && state.claimed && state.claimedMode !== mode) {
      // Task 733 / 013: the kept history describes the other mode's tree; this mode starts its own.
      drop(state)
    } else if (state.claimed !== value) {
      // The old engine keeps a history it recorded while the model could not capture (an IR re-entry,
      // a deferred build): the unit engine takes over once that history holds nothing to undo.
      if (value && oldHolds(vditor)) return false
      handOver(vditor, state, value)
    }
    if (value) state.claimedMode = mode
    return value
  }

  const report = (
    vditor: Vditor,
    state: State,
    entry: HistoryEntryToken,
    wasEmpty: boolean,
  ): void => {
    reportUnitEntry(vditor, {
      mode: modeOf(vditor),
      wasEmpty,
      entry,
      slot: state.slot,
    })
  }

  /** The history starts here: the base holds the caret and the publication counters, no state. */
  const createBase = (vditor: Vditor, state: State, withCaret = true): void => {
    // A base created together with its first entry is created after the change: the caret is then
    // unknown, and the entry's Undo leaves the caret where the browser puts it.
    const caret = withCaret ? caretNow(vditor) : undefined
    state.base = { token: token<HistoryEntryToken>(), caret }
    state.open = {
      epoch: deps.epoch(),
      sequence: deps.lastPostedSequence(),
      caret,
      missing: missingCaret(caret),
    }
    state.revision += 1
  }

  const pushEntry = (
    vditor: Vditor,
    state: State,
    capture: Entry['capture'],
    wasEmpty: boolean,
  ): void => {
    if (state.moved) {
      state.redo.length = 0
      state.moved = false
    }
    const caretAfter = caretNow(vditor)
    const entry: Entry = {
      capture,
      caretBefore: state.open.caret,
      caretAfter,
      beforeMissing: state.open.missing || missingCaret(state.open.caret),
      afterMissing: missingCaret(caretAfter),
      steps: 0,
      epoch: undefined,
      token: token<HistoryEntryToken>(),
    }
    state.undo.push(entry)
    state.replayReset = false
    if (state.undo.length > MAX_ENTRIES) state.undo.shift()
    state.revision += 1
    report(vditor, state, entry.token, wasEmpty)
    // The checkpoint flush ran in the listeners above: count the deltas it posted for this entry.
    const sequence = deps.lastPostedSequence()
    const epoch = deps.epoch()
    entry.epoch = epoch
    entry.steps =
      epoch !== undefined && epoch === state.open.epoch
        ? Math.max(0, sequence - state.open.sequence)
        : 0
    state.open = {
      epoch,
      sequence,
      caret: entry.caretAfter,
      missing: entry.afterMissing,
    }
  }

  const record = (raw: unknown): void => {
    const vditor = raw as Vditor
    const port = deps.port()
    if (!port) return
    const state = stateOf(vditor)
    const capture = port.capture()
    const wasEmpty = !state.base
    if (!state.base) createBase(vditor, state, capture === undefined)
    if (capture) {
      pushEntry(vditor, state, capture, wasEmpty)
    } else if (wasEmpty) {
      report(
        vditor,
        state,
        (state.base as NonNullable<State['base']>).token,
        true,
      )
    } else {
      state.open = noteCheckpointCaret(vditor, state.open)
      return
    }
    resetIcon(vditor)
  }

  // Task 733 / 036: the editor whose replayable move is being handled.
  let exactBusyVditor: Vditor | undefined
  // Task 733 / 036 (step C, 2.7): the caret of the replayed step, put back before the first input.
  let replayCaret: CaretIntent | undefined
  const historyBusy = (vditor: Vditor): boolean => {
    if (exactBusyVditor !== vditor) return false
    if (deps.exactBusy?.() ?? true) return true
    exactBusyVditor = undefined
    return false
  }
  /** The entry `kind` pops carries a replayable (not evicted) Find record. */
  const hasTaggedReplayable = (
    vditor: Vditor,
    kind: 'undo' | 'redo',
  ): boolean =>
    hasTaggedRewrapDocumentHistory(vditor as never, kind, 'replayable')
  const peekExact = (vditor: Vditor, kind: 'undo' | 'redo'): boolean =>
    claims(vditor) &&
    deps.port()?.pending() === false &&
    hasTaggedRewrapDocumentHistory(vditor as never, kind)

  const refuse = (vditor: Vditor, state: State): void => {
    refused += 1
    state.undo.length = 0
    state.redo.length = 0
    state.moved = false
    state.revision += 1
    resetIcon(vditor)
    logToHost(`[unit-history] restore refused (${refused} so far)`)
  }

  /**
   * H2 fix design rev2 (D7.1, O1 (b)): a history key that finds both stacks emptied by the resync that
   * ended a replay is refused visibly: counted, logged as a count, the toolbar icons disabled. No key is
   * held or replayed. true when it refused.
   */
  const refuseAfterReset = (vditor: Vditor): boolean => {
    const state = states.get(vditor)
    if (!state?.replayReset || state.undo.length > 0 || state.redo.length > 0)
      return false
    resetRefused += 1
    resetIcon(vditor)
    logToHost(`[unit-history] history-reset-refused (${resetRefused} so far)`)
    return true
  }

  /**
   * Puts the caret back after an Undo or Redo and returns the caret the next entry starts from.
   * Task 733 / 034: a step without a usable caret puts it at the restored change and reveals it, as
   * Vditor's restore of a snapshot without a marker does (Task 597, undo-restore-caret.ts).
   */
  const placeMoveCaret = (
    vditor: Vditor,
    state: State,
    entry: Entry,
    kind: 'undo' | 'redo',
    restored: RestoredCaret | undefined,
  ): CaretIntent | undefined => {
    const endpoint = restored?.endpoint
    const root = endpoint ? stateOfMode(vditor)?.element : undefined
    if (root && endpoint && placeRestoredCaret(root, endpoint)) {
      state.changeSites += 1
      return caretNow(vditor)
    }
    const caret = kind === 'undo' ? entry.caretBefore : entry.caretAfter
    // One placement, as Vditor's marker restore made: the restored DOM is complete when this runs.
    // An intent left armed would rewrite every later selection that is not a user gesture (a
    // selection set by a command or a test) for up to five seconds; it stays armed only when the
    // placement found no position yet. The change-site placement above drops its intent itself once
    // its reveal settles.
    if (caret && requestCaret(caret as Parameters<typeof requestCaret>[0]))
      invalidateCaret()
    return caret
  }

  /** After a restore: the caret, the host's history delta and the engine's own bookkeeping. */
  const finishMove = (
    vditor: Vditor,
    state: State,
    entry: Entry,
    kind: 'undo' | 'redo',
    restored?: RestoredCaret,
  ): void => {
    state.moves += 1
    const caret = placeMoveCaret(vditor, state, entry, kind, restored)
    // An exact action's record (`recordRewrapDocumentHistory`) moves with the history, as the
    // replay after Vditor's own Undo moved it; left behind, it would decline every source proof.
    const moved = hasRewrapDocumentHistoryTransition(vditor as never)
      ? moveRewrapDocumentHistory(vditor as never)
      : undefined
    // A history delta always carries steps >= 1 (the host refuses 0): an entry that only whole-text
    // posts covered, or one from another epoch, asks the host to walk one step.
    const steps = entry.epoch === deps.epoch() ? Math.max(1, entry.steps) : 1
    // Task 733 / 036 (F6): a replayable Find record is replayed by the host from its pair; an evicted one
    // takes the Task 685 exact recovery with its strings; anything else, today's history delta.
    if (moved?.state === 'replayable' && moved.requestId !== undefined) {
      exactBusyVditor = vditor
      deps.publishHistory(kind, steps, moved.requestId)
    } else if (
      moved?.state === 'evicted' &&
      moved.exact !== undefined &&
      moved.before !== undefined &&
      deps.postExactHistory
    )
      deps.postExactHistory(moved.exact, moved.before, kind)
    else deps.publishHistory(kind, steps)
    state.open = {
      epoch: deps.epoch(),
      sequence: deps.lastPostedSequence(),
      caret,
      missing: missingCaret(caret),
    }
    state.moved = true
    state.revision += 1
    resetIcon(vditor)
    if (vditor.hint) hidePanel(vditor as never, ['hint'])
  }

  /** A checkpoint re-asserts the caret it found (see `checkpointCaret`). */
  const rearmCaret = (vditor: Vditor): void => {
    if (!deps.port()) return
    const caret = checkpointCaret(vditor)
    if (caret) requestCaret(caret as Parameters<typeof requestCaret>[0])
  }

  /** Undo and Redo do nothing in a read-only root or during a composition. */
  const canMove = (vditor: Vditor): boolean => {
    const mode = stateOfMode(vditor)
    const root = mode?.element
    return (
      !!root &&
      root.getAttribute('contenteditable') !== 'false' &&
      !mode.composingLock
    )
  }

  // One Undo or Redo; the stacks are re-read after the record that can push a pending change.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the busy gate, the sliced exact path and today's restore are one move
  const move = (raw: unknown, kind: 'undo' | 'redo'): void => {
    const vditor = raw as Vditor
    const port = deps.port()
    if (!port || !canMove(vditor)) return
    // Task 733 / 036 (F8): a second Undo or Redo while an exact replay is handled makes no engine call,
    // unless the replay's logical text is live (step C, 2.6): the move then supersedes or is reserved.
    if (historyBusy(vditor) && !(deps.replayLive?.() ?? false)) {
      refuseAfterReset(vditor)
      return
    }
    record(vditor)
    const state = stateOf(vditor)
    // Read before the pop: the token compare names the entry this move pops.
    const sliced =
      port.restoreSliced !== undefined && hasTaggedReplayable(vditor, kind)
    const entry = (kind === 'undo' ? state.undo : state.redo).pop()
    if (!entry) {
      refuseAfterReset(vditor)
      return
    }
    const side = kind === 'undo' ? 'before' : 'after'
    if (sliced && port.restoreSliced) {
      // Task 733 / 036 (F8): the exact replay is posted once, before the first slice, so the host replays
      // in parallel; the session joins its answer with the final slice. A failed slice abandons it there.
      ;(kind === 'undo' ? state.redo : state.undo).push(entry)
      finishMove(vditor, state, entry, kind, undefined)
      // Step C (2.7): the step's caret is put back again before an input that comes before its group renders.
      const missing = kind === 'undo' ? entry.beforeMissing : entry.afterMissing
      replayCaret = missing
        ? undefined
        : kind === 'undo'
          ? entry.caretBefore
          : entry.caretAfter
      void port.restoreSliced(entry.capture, side)
      return
    }
    const restored = caretRequest(entry, kind)
    if (!port.restore(entry.capture, side, restored)) {
      refuse(vditor, state)
      return
    }
    ;(kind === 'undo' ? state.redo : state.undo).push(entry)
    finishMove(vditor, state, entry, kind, restored)
  }

  /** Stops the pending first-edit record; false while a held IME timer owns the first edit. */
  const releaseFirstEditTimer = (vditor: Vditor): boolean => {
    const mode = stateOfMode(vditor)
    const timer =
      modeOf(vditor) === 'wysiwyg'
        ? mode?.afterRenderTimeoutId
        : mode?.processTimeoutId
    if (timer === undefined) {
      if (mode) mode.vmdeAfterRender = undefined
      return true
    }
    // A held IME timer belongs to the composition that owns the first edit: leave it to run.
    if (timer === vditor.undo?.vmdeHeldTimer) return false
    clearTimeout(timer)
    if (mode) mode.vmdeAfterRender = undefined
    return true
  }

  /**
   * Vditor's first-position capture (`addCaret`, from its seed and its first-position keydown) put a
   * caret marker at the caret and removed it, which splits the caret's text node there. Chromium's
   * typing rebalances whitespace inside the text node it types into, so in one unsplit node the
   * `\n` of a soft break right after the caret becomes a space and the two source lines join. The
   * same split is kept here (`splitAtRangeStart`); the DOM's HTML does not change. A Range with an
   * element endpoint is written again afterwards, as the seed does (Chromium keeps reporting it
   * while its own selection shrank).
   */
  const splitAtCaret = (vditor: Vditor): void => {
    const root = stateOfMode(vditor)?.element
    const selection = root?.ownerDocument.getSelection()
    if (!root || !selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    if (
      !root.contains(range.startContainer) ||
      caretBlockHasMarker(root, range)
    )
      return
    const elementEndpoint =
      selection.anchorNode?.nodeType !== Node.TEXT_NODE ||
      selection.focusNode?.nodeType !== Node.TEXT_NODE
    splitAtRangeStart(range)
    if (elementEndpoint && selection.anchorNode && selection.focusNode) {
      // The same live endpoints, written again: a transparent write that keeps any caret intent.
      writeSelectionKeepingIntent({
        anchorNode: selection.anchorNode,
        anchorOffset: selection.anchorOffset,
        focusNode: selection.focusNode,
        focusOffset: selection.focusOffset,
      })
    }
  }

  const seedBaseline = (raw: unknown): boolean => {
    const vditor = raw as Vditor
    const state = stateOf(vditor)
    if (state.base || state.redo.length > 0) return false
    if (!releaseFirstEditTimer(vditor)) return false
    // The base is the live state: whatever the port holds is part of it.
    deps.port()?.capture()
    createBase(vditor, state)
    splitAtCaret(vditor)
    report(
      vditor,
      state,
      (state.base as NonNullable<State['base']>).token,
      true,
    )
    resetIcon(vditor)
    return true
  }

  const hook: UnitHistoryHook = {
    claims,
    holds: (vditor) => holds(vditor as Vditor),
    ownsHistoryNow: (raw) => {
      const vditor = raw as Vditor
      const state = states.get(vditor)
      return (
        state !== undefined &&
        state.claimed === true &&
        state.claimedMode === modeOf(vditor) &&
        holds(vditor)
      )
    },
    changeSites: (raw) => states.get(raw as object)?.changeSites ?? 0,
    moves: (raw) => states.get(raw as object)?.moves ?? 0,
    peekExact: (raw, kind) => peekExact(raw as Vditor, kind),
    historyBusy: (raw) => historyBusy(raw as Vditor),
    depth: (raw) => {
      const state = states.get(raw as object)
      if (!state) return { undo: 0, redo: 0 }
      return {
        undo: (state.base ? 1 : 0) + state.undo.length,
        redo: state.redo.length,
      }
    },
    settled: (raw) => {
      const vditor = raw as Vditor
      // The base is created by Vditor's initial `addToUndoStack`, the moment the old engine took its
      // first snapshot, so this is the same settle point.
      return (
        holds(vditor) &&
        deps.port()?.ready() === true &&
        states.get(vditor)?.base !== undefined
      )
    },
    undo: (vditor) => move(vditor, 'undo'),
    redo: (vditor) => move(vditor, 'redo'),
    record(raw) {
      record(raw)
      rearmCaret(raw as Vditor)
    },
    recordFirstPosition(raw, event) {
      const vditor = raw as Vditor
      if (stateOfMode(vditor)?.composingLock) return
      const state = stateOf(vditor)
      if (!state.base) {
        seedBaseline(vditor)
        return
      }
      void event
      if (state.undo.length > 0 || state.redo.length > 0) return
      // Vditor's own rule: the base caret moves only while the DOM still equals the base, so the keys
      // of a first edit after the first one leave the caret where that edit started. Read before the
      // split, which leaves a textless Range across the two halves.
      if (deps.port()?.pending() === false) {
        state.base.caret = caretNow(vditor)
        state.open = {
          ...state.open,
          caret: state.base.caret,
          missing: missingCaret(state.base.caret),
        }
      }
      splitAtCaret(vditor)
    },
    clear(raw) {
      const vditor = raw as Vditor
      const state = stateOf(vditor)
      drop(state)
      // D7.1: a reset while an exact replay of this editor is handled is the resync that ended it.
      if (exactBusyVditor === vditor) state.replayReset = true
      // Anything captured so far belongs to the history that was just cleared.
      deps.port()?.capture()
      resetIcon(vditor)
    },
    resetIcon: (raw) => resetIcon(raw as Vditor),
    seedBaseline: (raw) => seedBaseline(raw),
  }

  /** An amend while the port holds a change: refused, or the change becomes an entry of its own. */
  const amendPending = (
    vditor: Vditor,
    state: State,
    options: { sourceUnchanged?: boolean },
  ): AmendResult | undefined => {
    const port = deps.port()
    if (!(port?.pending() ?? true)) return undefined
    // A change since the last record is not a caret-only difference.
    if (!options.sourceUnchanged || !state.base) return 'refused'
    // The caller says the source did not change: the port drops windows without a source change,
    // so a capture left here is a real change and becomes an entry of its own.
    const capture = port?.capture()
    if (!capture) return undefined
    pushEntry(vditor, state, capture, false)
    resetIcon(vditor)
    return 'coalesced'
  }

  const savepoints = new WeakSet<object>()

  const delegate: UnitHistoryDelegate = {
    claims,
    top: (inner) => stateOf(inner as Vditor).undo.at(-1)?.token,
    redoTop: (inner) => stateOf(inner as Vditor).redo.at(-1)?.token,
    base: (inner) => stateOf(inner as Vditor).base?.token,
    slot: (inner) => stateOf(inner as Vditor).slot,
    isEmpty(inner) {
      const state = stateOf(inner as Vditor)
      return !state.base && state.undo.length === 0
    },
    revision: (inner) => stateOf(inner as Vditor).revision,
    savepoint(inner) {
      const state = stateOf(inner as Vditor)
      const saved = Object.freeze({
        mode: modeOf(inner as Vditor),
        slot: state.slot,
        undo: [...state.undo],
        redo: [...state.redo],
        base: state.base,
        open: state.open,
        moved: state.moved,
      })
      savepoints.add(saved)
      return saved as unknown as HistorySavepoint
    },
    restore(inner, savepoint) {
      if (!savepoints.has(savepoint)) return undefined
      const saved = savepoint as unknown as {
        mode: EngineMode
        slot: HistorySlotToken
        undo: Entry[]
        redo: Entry[]
        base: State['base']
        open: Open
        moved: boolean
      }
      const vditor = inner as Vditor
      const state = stateOf(vditor)
      if (servedModeOf(vditor) !== saved.mode || state.slot !== saved.slot)
        return false
      state.undo = [...saved.undo]
      state.redo = [...saved.redo]
      state.base = saved.base
      state.open = saved.open
      state.moved = saved.moved
      state.revision += 1
      resetIcon(vditor)
      return true
    },
    amendTopCaret(inner, options): AmendResult {
      const vditor = inner as Vditor
      const state = stateOf(vditor)
      const pending = amendPending(vditor, state, options)
      if (pending) return pending
      const caret = caretNow(vditor)
      if (sameIntent(caret, state.open.caret)) return 'unchanged'
      const top = state.undo.at(-1)
      if (!top) {
        if (!state.base) return 'refused'
        state.base.caret = caret
        state.open = { ...state.open, caret, missing: missingCaret(caret) }
        return 'coalesced'
      }
      top.caretAfter = caret
      top.afterMissing = missingCaret(caret)
      state.open = { ...state.open, caret, missing: missingCaret(caret) }
      state.revision += 1
      return 'coalesced'
    },
    isSourceNeutral: () => !(deps.port()?.pending() ?? true),
  }

  // Task 733 / 036 (F8): while an exact replay is handled, editing input on its root is refused (Q7 (a)).
  // Step C (fix design 2.6, 2.7) retires the refusal while the replay's logical text is live: the caret
  // intent is put back and the endpoint groups render before the event's default action, which then
  // continues. One field read per event outside that window; nothing is allocated.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the live replay path and today's refusal share the root and key gates
  const guardInput = (event: Event): void => {
    // H2 fix design rev2 (D3.1): Cut and Copy reach the session's clipboard transaction first, before the
    // caret intent is put back or a busy gate returns, and also after the replay ended (its token is
    // taken once). The session keeps everything else for the native handlers.
    if (
      event.type === 'beforecut' ||
      event.type === 'beforecopy' ||
      event.type === 'cut' ||
      event.type === 'copy'
    ) {
      deps.beforeReplayInput?.(event)
      if (event.defaultPrevented || deps.replayLive?.()) return
    }
    const vditor = exactBusyVditor
    if (!vditor) return
    const target = event.target
    const root = stateOfMode(vditor)?.element
    if (!(target instanceof Node) || !root?.contains(target)) return
    // A pointer selection by the user discards the caret intent (2.7).
    if (event.type === 'pointerdown') {
      replayCaret = undefined
      return
    }
    if (deps.replayLive?.()) {
      // H2 fix design rev2 (D3.3): an expanded deletion is proven from the selection as it is, before
      // the caret intent could collapse it.
      if (expandedDeletion(event)) {
        deps.beforeReplayInput?.(event)
        return
      }
      const caret = replayCaret
      if (caret) {
        replayCaret = undefined
        deps.renderReplayCaretGroup?.()
        if (requestCaret(caret as Parameters<typeof requestCaret>[0]))
          invalidateCaret()
      }
      if (event.type !== 'keydown' || isEditingKey(event as KeyboardEvent))
        deps.beforeReplayInput?.(event)
      return
    }
    if (
      event.type === 'copy' ||
      event.type === 'beforecopy' ||
      event.type === 'compositionstart'
    )
      return
    if (event.type === 'keydown' && !isEditingKey(event as KeyboardEvent))
      return
    if (!historyBusy(vditor)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  /** Backspace or Delete, or a delete input, over an expanded selection. */
  const expandedDeletion = (event: Event): boolean =>
    ((event.type === 'keydown' &&
      ((event as KeyboardEvent).key === 'Backspace' ||
        (event as KeyboardEvent).key === 'Delete')) ||
      (event.type === 'beforeinput' &&
        (event as InputEvent).inputType.startsWith('delete'))) &&
    win.getSelection()?.isCollapsed === false
  const guarded = [
    'keydown',
    'beforeinput',
    'paste',
    'beforecut',
    'beforecopy',
    'cut',
    'copy',
    'drop',
    'compositionstart',
    'pointerdown',
  ] as const
  for (const type of guarded) win.addEventListener(type, guardInput, true)

  win.__vmdeUnitHistory = hook
  provideUnitHistoryDelegate(delegate)
  return () => {
    for (const type of guarded) win.removeEventListener(type, guardInput, true)
    if (win.__vmdeUnitHistory === hook) delete win.__vmdeUnitHistory
    provideUnitHistoryDelegate(undefined)
  }
}
