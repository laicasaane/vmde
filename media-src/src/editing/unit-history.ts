import {
  disableToolbar,
  enableToolbar,
  hidePanel,
} from 'vditor/src/ts/toolbar/setToolbar'
import type { HistoryModelPort } from '../util/unit-changes'
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
  reportUnitEntry,
  type UnitHistoryDelegate,
} from './history-store'
import {
  hasRewrapDocumentHistoryTransition,
  moveRewrapDocumentHistory,
} from './rewrap-command'

// Task 733 (task 004): the unit history engine for IR. An entry holds the capture of the units that
// changed between two checkpoints (bridge/unit-capture.ts), the caret before and after, and the
// number of native steps the host walked for it. Undo restores the capture's `before` side and posts
// one `history-delta`; no whole-editor snapshot or diff is taken. Vditor's `Undo` class stays bundled:
// the build patch `patchUndoUnitEngine` hands each method to this hook while it claims the editor,
// and the old engine runs otherwise (WYSIWYG, Source, `IR_HISTORY_ENGINE === 'vditor'`).

export interface UnitHistoryDeps {
  port(): HistoryModelPort | undefined
  publishHistory(
    kind: 'undo' | 'redo',
    steps: number,
  ): 'delta' | 'nothing' | 'fallback'
  lastPostedSequence(): number
  epoch(): number | undefined
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
   * The engine holds the history, the model is live and trusted, and the base exists (Vditor's initial
   * record ran). The end-to-end specs wait for it where they waited for Vditor's initial snapshot.
   */
  settled(vditor: unknown): boolean
  /** The depth of the stacks in the form Vditor's slots have (the base counts as one Undo entry); a read for the end-to-end specs. */
  depth(vditor: unknown): { undo: number; redo: number }
}

declare global {
  interface Window {
    __vmdeUnitHistory?: UnitHistoryHook
  }
}

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
  /** Native host steps this entry spans; 0 when only whole-text posts lay in it. */
  steps: number
  epoch: number | undefined
  readonly token: HistoryEntryToken
}

interface Open {
  epoch: number | undefined
  sequence: number
  caret: CaretIntent | undefined
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
}

type Vditor = {
  currentMode: string
  ir: {
    element: HTMLElement
    composingLock?: boolean
    processTimeoutId?: number
    vmdeAfterRender?: unknown
  }
  undo: Record<string, any>
  toolbar?: { elements: Record<string, HTMLElement>; element?: HTMLElement }
  hint?: unknown
}

const token = <T>(): T => Object.freeze({}) as unknown as T

/** The old engine's IR slot holds an entry above its base, or a Redo entry. */
const oldHolds = (vditor: Vditor): boolean => {
  const slot = vditor.undo?.ir as
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

const emptyOpen = (): Open => ({
  epoch: undefined,
  sequence: 0,
  caret: undefined,
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
  const root = vditor.ir?.element
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
  const root = vditor.ir?.element
  if (!root || !selection || selection.rangeCount === 0) return undefined
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection
  if (!anchorNode || !focusNode) return undefined
  const anchor = pointOf(root, anchorNode, anchorOffset)
  if (!anchor) return undefined
  if (selection.isCollapsed) return anchor
  const focus = pointOf(root, focusNode, focusOffset)
  return focus ? { anchor, focus } : anchor
}

export function installUnitHistory(
  win: Window,
  deps: UnitHistoryDeps,
): () => void {
  const states = new WeakMap<object, State>()
  let refused = 0

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

  const holds = (vditor: Vditor): boolean =>
    vditor.currentMode === 'ir' &&
    IR_HISTORY_ENGINE === 'unit' &&
    deps.port()?.claimable() === true

  /**
   * Another engine held the history in between (a mode switch, a rebuild without a model): what this
   * one kept describes a DOM that is gone. Vditor's IR slot is reset when it takes over again.
   */
  const handOver = (vditor: Vditor, state: State, value: boolean): void => {
    drop(state)
    if (!value && state.claimed && vditor.undo?.ir) {
      vditor.undo.ir = {
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
    if (took && (vditor.undo?.ir?.undoStack?.length ?? 0) > 0) {
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
    if (state.claimed === undefined) {
      state.claimed = value
    } else if (state.claimed !== value) {
      // The old engine keeps a history it recorded while the model could not capture (an IR re-entry,
      // a deferred build): the unit engine takes over once that history holds nothing to undo.
      if (value && oldHolds(vditor)) return false
      handOver(vditor, state, value)
    }
    return value
  }

  const report = (
    vditor: Vditor,
    state: State,
    entry: HistoryEntryToken,
    wasEmpty: boolean,
  ): void => {
    reportUnitEntry(vditor, { mode: 'ir', wasEmpty, entry, slot: state.slot })
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
    const entry: Entry = {
      capture,
      caretBefore: state.open.caret,
      caretAfter: caretNow(vditor),
      steps: 0,
      epoch: undefined,
      token: token<HistoryEntryToken>(),
    }
    state.undo.push(entry)
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
    state.open = { epoch, sequence, caret: entry.caretAfter }
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
      // A checkpoint with no change (before an action, after a caret move): the next entry starts at
      // the caret it found, so its Undo puts the caret where the action began.
      const caret = caretNow(vditor)
      if (caret && !sameIntent(caret, state.open.caret))
        state.open = { ...state.open, caret }
      return
    }
    resetIcon(vditor)
  }

  const refuse = (vditor: Vditor, state: State): void => {
    refused += 1
    state.undo.length = 0
    state.redo.length = 0
    state.moved = false
    state.revision += 1
    resetIcon(vditor)
    logToHost(`[unit-history] restore refused (${refused} so far)`)
  }

  /** After a restore: the caret, the host's history delta and the engine's own bookkeeping. */
  const finishMove = (
    vditor: Vditor,
    state: State,
    entry: Entry,
    kind: 'undo' | 'redo',
  ): void => {
    const caret = kind === 'undo' ? entry.caretBefore : entry.caretAfter
    // One placement, as Vditor's marker restore made: the restored DOM is complete when this runs.
    // An intent left armed would rewrite every later selection that is not a user gesture (a
    // selection set by a command or a test) for up to five seconds; it stays armed only when the
    // placement found no position yet.
    if (caret && requestCaret(caret as Parameters<typeof requestCaret>[0]))
      invalidateCaret()
    // An exact action's record (`recordRewrapDocumentHistory`) moves with the history, as the
    // replay after Vditor's own Undo moved it; left behind, it would decline every source proof.
    if (hasRewrapDocumentHistoryTransition(vditor as never))
      moveRewrapDocumentHistory(vditor as never)
    // A history delta always carries steps >= 1 (the host refuses 0): an entry that only whole-text
    // posts covered, or one from another epoch, asks the host to walk one step.
    const steps = entry.epoch === deps.epoch() ? Math.max(1, entry.steps) : 1
    deps.publishHistory(kind, steps)
    state.open = {
      epoch: deps.epoch(),
      sequence: deps.lastPostedSequence(),
      caret,
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
    const root = vditor.ir?.element
    return (
      !!root &&
      root.getAttribute('contenteditable') !== 'false' &&
      !vditor.ir.composingLock
    )
  }

  // One Undo or Redo; the stacks are re-read after the record that can push a pending change.
  const move = (raw: unknown, kind: 'undo' | 'redo'): void => {
    const vditor = raw as Vditor
    const port = deps.port()
    if (!port || !canMove(vditor)) return
    record(vditor)
    const state = stateOf(vditor)
    const entry = (kind === 'undo' ? state.undo : state.redo).pop()
    if (!entry) return
    const side = kind === 'undo' ? 'before' : 'after'
    if (!port.restore(entry.capture, side)) {
      refuse(vditor, state)
      return
    }
    ;(kind === 'undo' ? state.redo : state.undo).push(entry)
    finishMove(vditor, state, entry, kind)
  }

  /** Stops the pending first-edit record; false while a held IME timer owns the first edit. */
  const releaseFirstEditTimer = (vditor: Vditor): boolean => {
    const timer = vditor.ir?.processTimeoutId
    if (timer === undefined) {
      if (vditor.ir) vditor.ir.vmdeAfterRender = undefined
      return true
    }
    // A held IME timer belongs to the composition that owns the first edit: leave it to run.
    if (timer === vditor.undo?.vmdeHeldTimer) return false
    clearTimeout(timer)
    vditor.ir.vmdeAfterRender = undefined
    return true
  }

  /**
   * Vditor's first-position capture (`addCaret`, from its seed and its first-position keydown) put a
   * caret marker at the caret and removed it, which splits the caret's text node there. Chromium's
   * typing rebalances whitespace inside the text node it types into, so in one unsplit node the
   * `\n` of a soft break right after the caret becomes a space and the two source lines join. The
   * same split is kept here; the DOM's HTML does not change. A Range with an element endpoint is
   * written again afterwards, as the seed does (Chromium keeps reporting it while its own selection
   * shrank).
   */
  const splitAtCaret = (vditor: Vditor): void => {
    const root = vditor.ir?.element
    const selection = root?.ownerDocument.getSelection()
    if (!root || !selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    if (!root.contains(range.startContainer) || root.querySelector('wbr'))
      return
    const elementEndpoint =
      selection.anchorNode?.nodeType !== Node.TEXT_NODE ||
      selection.focusNode?.nodeType !== Node.TEXT_NODE
    const marker = root.ownerDocument.createElement('span')
    marker.className = 'vditor-wbr'
    range.insertNode(marker)
    marker.remove()
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
      if (vditor.ir?.composingLock) return
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
        state.open = { ...state.open, caret: state.base.caret }
      }
      splitAtCaret(vditor)
    },
    clear(raw) {
      const vditor = raw as Vditor
      drop(stateOf(vditor))
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
        mode: 'ir' as const,
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
        slot: HistorySlotToken
        undo: Entry[]
        redo: Entry[]
        base: State['base']
        open: Open
        moved: boolean
      }
      const vditor = inner as Vditor
      const state = stateOf(vditor)
      if (vditor.currentMode !== 'ir' || state.slot !== saved.slot) return false
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
        state.open = { ...state.open, caret }
        return 'coalesced'
      }
      top.caretAfter = caret
      state.open = { ...state.open, caret }
      state.revision += 1
      return 'coalesced'
    },
    isSourceNeutral: () => !(deps.port()?.pending() ?? true),
  }

  win.__vmdeUnitHistory = hook
  provideUnitHistoryDelegate(delegate)
  return () => {
    if (win.__vmdeUnitHistory === hook) delete win.__vmdeUnitHistory
    provideUnitHistoryDelegate(undefined)
  }
}
