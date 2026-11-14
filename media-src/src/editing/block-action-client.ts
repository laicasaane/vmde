import { writeSelection } from './caret'
import {
  type HistoryEntryToken,
  type HistoryMode,
  historyStoreOf,
} from './history-store'
import {
  planBlockAction,
  type BlockActionIntent,
} from '../../../src/shared/block-move'
import type { HostMessage } from '../../../src/shared/protocol'
import { findScroller } from '../chrome/toolbar-scroll-guard'
import { countBlockActionDecline } from '../util/block-action-declines'
import { isCompositionActive } from '../util/caret-gesture'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { activeModeElement } from '../util/source-map'
import {
  checkpointEditorUndo,
  recordRewrapDocumentHistory,
} from './rewrap-command'
import {
  restoreTableUndoForRollback,
  snapshotTableUndoForRollback,
} from './table-actions'
import {
  currentBlockProjection,
  resolveBlockHandleUnits,
  type BlockActionBasis,
} from '../nav/block-handle'
import type { BlockHandleUnit } from '../nav/source-block-index'

interface BlockActionDeps {
  settleInput(): void
  /** Exact bytes while the webview owns them; `null` otherwise (Task 607). */
  snapshotExactMarkdown(): string | null
  /** Task 607: settle typing and always pull the host's bytes (`publish`), never a rebased pair.
   * Resolves `null` when no proof of the live rendering exists; the request then declines. */
  acquireExactAuthority(opts: {
    publish: true
    lazyRendering?: boolean
  }): Promise<{ exact: string; rendered: string } | null>
  setApplying(value: boolean): void
  /** Adopt host-confirmed special-block bytes before a later save serializes the DOM. */
  reown?(markdown: string): void
  /** Task 733 / 010 (Q-31): apply `after` by units and post it as a delta; 'fallback' changed nothing. */
  applyExactText?(
    after: string,
    opts?: { rollback?: { restore(): void } },
  ): 'applied' | 'fallback'
  /** Task 733 / 010 (Q-79 OQ-1): the confirmed model units while the model owns the text. */
  modelUnits?(): { exact: string; units: BlockHandleUnit[] } | undefined
  /** The confirmed model text (after a drain, nothing dirty), or undefined: a cheap owner check (010-R F12). */
  modelText?(): string | undefined
  onError(error: unknown): void
}

interface PendingAction {
  requestId: string
  action: BlockActionIntent
  before: string
  after: string
  renderedBefore: string
  preserveExact: boolean
  outer: NonNullable<Window['vditor']>
  inner: InnerVditor
  editor: HTMLElement
  mode: 'ir' | 'wysiwyg'
  caretOffset: number
  scrollTop: number
  nativeState?: HistoryEntryToken
  renderedAfter?: string
  undoSnapshot?: ReturnType<typeof snapshotTableUndoForRollback>
  /** Planned on the confirmed model units: the apply route, with no whole-document read. */
  modelRoute: boolean
  timeout: number
  resolve(value: boolean): void
}

let deps: BlockActionDeps | undefined
const pending = new Map<string, PendingAction>()
// One request at a time, from the first await for the host's bytes until the host answers.
let acquiring = false

function cancel(record: PendingAction): void {
  pending.delete(record.requestId)
  window.clearTimeout(record.timeout)
  vscode.postMessage({
    command: 'cancel-block-action',
    requestId: record.requestId,
  })
  record.resolve(false)
}

function currentOwner(record: PendingAction): boolean {
  return Boolean(
    deps &&
      !isCompositionActive() &&
      window.vditor === record.outer &&
      innerVditor() === record.inner &&
      record.inner.currentMode === record.mode &&
      activeModeElement(record.outer) === record.editor &&
      record.editor.isConnected &&
      record.editor.getAttribute('contenteditable') !== 'false' &&
      deps.snapshotExactMarkdown() === record.before &&
      // On the model route the confirmed model text is the rendering's source: it is undefined while a
      // unit is dirty after a drain, so unpublished typing declines the action (010-R F1).
      (record.modelRoute
        ? (deps.modelText ? deps.modelText() : deps.modelUnits?.()?.exact) ===
          record.before
        : record.outer.getValue() === record.renderedBefore),
  )
}

/** Puts the caret at the start of the model unit that holds `offset` (no whole-document read). */
function restoreModelBlock(record: PendingAction, offset: number): boolean {
  const unit = deps
    ?.modelUnits?.()
    ?.units.find((block) => offset >= block.start && offset <= block.end)
  if (!unit) return false
  const walker = document.createTreeWalker(unit.element, NodeFilter.SHOW_TEXT)
  const text = walker.nextNode() as Text | null
  if (!text) return true
  const range = document.createRange()
  range.setStart(text, 0)
  range.collapse(true)
  // Deliberate: the action places the caret at the changed block, as the host reply does.
  writeSelection(range)
  record.editor.focus({ preventScroll: true })
  const scroller = findScroller(record.editor)
  scroller.scrollTop = Math.min(
    record.scrollTop,
    Math.max(0, scroller.scrollHeight - scroller.clientHeight),
  )
  return true
}

function restoreLogicalBlock(
  record: PendingAction,
  markdown: string,
  offset: number,
): void {
  const editor = activeModeElement(record.outer)
  if (!editor) return
  const units = resolveBlockHandleUnits(
    editor,
    markdown,
    record.outer.getValue(),
    // The exact post keeps the YAML separator that Lute drops from this restored DOM.
    currentBlockProjection(),
  )
  const unit = units?.find(
    (block) => offset >= block.start && offset <= block.end,
  )
  if (!unit) return
  const walker = document.createTreeWalker(unit.element, NodeFilter.SHOW_TEXT)
  const text = walker.nextNode() as Text | null
  if (!text) return
  const range = document.createRange()
  range.setStart(text, 0)
  range.collapse(true)
  // Deliberate: the host's block-action reply places the caret at the changed block.
  writeSelection(range)
  editor.focus({ preventScroll: true })
  const scroller = findScroller(editor)
  scroller.scrollTop = Math.min(
    record.scrollTop,
    Math.max(0, scroller.scrollHeight - scroller.clientHeight),
  )
}

export function cancelPendingBlockActions(): void {
  for (const record of pending.values()) cancel(record)
}

export function configureBlockActionClient(next: BlockActionDeps): () => void {
  cancelPendingBlockActions()
  deps = next
  return () => {
    cancelPendingBlockActions()
    deps = undefined
  }
}

/** Task 607: the keyboard move's authority, pulled before it resolves the block units. */
export function acquireBlockActionAuthority(): Promise<{
  exact: string
  rendered: string
} | null> {
  return deps?.acquireExactAuthority({ publish: true }) ?? Promise.resolve(null)
}

interface BlockActionContext {
  outer: NonNullable<Window['vditor']>
  inner: InnerVditor
  editor: HTMLElement
  mode: 'ir' | 'wysiwyg'
}

function liveBlockActionContext(): BlockActionContext | null {
  const outer = window.vditor
  const inner = innerVditor()
  const editor = outer ? activeModeElement(outer) : null
  const mode = inner?.currentMode
  if (
    !outer ||
    !inner ||
    !editor ||
    (mode !== 'ir' && mode !== 'wysiwyg') ||
    editor.getAttribute('contenteditable') === 'false'
  )
    return null
  return { outer, inner, editor, mode }
}

/**
 * Request a host-bound edit; no DOM mutation yet. Task 607: the exact bytes are the host's, pulled
 * after pending typing is published, never a rebased pair, and the block units are recomputed on
 * them. The editor must be the same one after the wait, or the request declines. `basis` is the
 * exact text the action's offsets came from: when the host's bytes differ, the offsets are never
 * reused; the action is re-derived by `basis.rederive` on the host's bytes, or declines.
 */
export async function requestBlockAction(
  action: BlockActionIntent,
  basis: BlockActionBasis,
): Promise<boolean> {
  if (!deps || acquiring || pending.size || isCompositionActive()) {
    countBlockActionDecline('busy')
    return false
  }
  const asked = liveBlockActionContext()
  if (!asked) {
    countBlockActionDecline('no-context')
    return false
  }
  deps.settleInput()
  acquiring = true
  let pair: { exact: string; rendered: string } | null
  try {
    // While the model owns the text the plan needs no rendering (Q-79 OQ-1).
    pair = await deps.acquireExactAuthority(
      deps.modelText?.() === undefined
        ? { publish: true }
        : { publish: true, lazyRendering: true },
    )
  } finally {
    acquiring = false
  }
  const live = liveBlockActionContext()
  if (!pair) {
    countBlockActionDecline('no-pair')
    return false
  }
  if (
    !deps ||
    !live ||
    pending.size ||
    isCompositionActive() ||
    live.outer !== asked.outer ||
    live.inner !== asked.inner ||
    live.editor !== asked.editor ||
    live.mode !== asked.mode
  ) {
    countBlockActionDecline('context-changed')
    return false
  }
  let intent = action
  if (pair.exact !== basis.exact) {
    const next = basis.rederive?.(pair)
    if (!next) {
      countBlockActionDecline('basis-mismatch')
      return false
    }
    intent = next
  }
  return planAndRequest(intent, live, pair.exact)
}

function planAndRequest(
  action: BlockActionIntent,
  context: BlockActionContext,
  before: string,
): Promise<boolean> {
  const { outer, inner, editor, mode } = context
  // Q-79 OQ-1: while the model owns the text its confirmed units are the units of `before`.
  const model = mode === 'ir' ? deps?.modelUnits?.() : undefined
  const modelRoute = model?.exact === before
  const renderedBefore = modelRoute ? before : outer.getValue()
  const units = modelRoute
    ? model?.units
    : resolveBlockHandleUnits(
        editor,
        before,
        renderedBefore,
        currentBlockProjection(),
      )
  if (
    !units?.some((unit) => unit.start === action.sourceStart) ||
    (action.kind === 'move' &&
      !units.some((unit) => unit.start === action.targetStart))
  ) {
    countBlockActionDecline('plan-units')
    return Promise.resolve(false)
  }
  const plan = planBlockAction(before, action)
  if (plan.status !== 'ok') {
    countBlockActionDecline('plan-rejected')
    return Promise.resolve(false)
  }
  return new Promise<boolean>((resolve) => {
    const requestId = crypto.randomUUID()
    const record: PendingAction = {
      requestId,
      action,
      before,
      after: plan.markdown,
      renderedBefore,
      preserveExact:
        before !== renderedBefore &&
        units.some(
          (unit) => unit.kind === 'front-matter' || unit.kind === 'math',
        ),
      outer,
      inner,
      editor,
      mode,
      caretOffset: plan.caretOffset,
      scrollTop: findScroller(editor).scrollTop,
      modelRoute,
      timeout: window.setTimeout(() => {
        const active = pending.get(requestId)
        if (active) {
          countBlockActionDecline('timeout')
          cancel(active)
        }
      }, 30_000),
      resolve,
    }
    pending.set(requestId, record)
    vscode.postMessage({
      command: 'request-block-action',
      requestId,
      before,
      action,
    })
  })
}

/** Host has re-planned against its current version; only that exact editor may rebuild. */
export function prepareBlockAction(
  message: Extract<HostMessage, { command: 'prepare-block-action' }>,
): void {
  const record = pending.get(message.requestId)
  if (!record) return
  if (
    !currentOwner(record) ||
    message.before !== record.before ||
    message.after !== record.after ||
    message.caretOffset !== record.caretOffset
  ) {
    countBlockActionDecline(
      currentOwner(record) ? 'prepare-mismatch' : 'prepare-owner',
    )
    cancel(record)
    return
  }
  const undoSnapshot = snapshotTableUndoForRollback(record.inner)
  if (record.modelRoute && settledOnModelRoute(record, undoSnapshot)) return
  deps!.setApplying(true)
  try {
    checkpointEditorUndo(record.inner)
    record.outer.setValue(record.after)
    checkpointEditorUndo(record.inner)
    record.nativeState = historyStoreOf(record.inner)?.top(
      record.mode as HistoryMode,
    )
    if (!record.nativeState)
      throw new Error('block action undo checkpoint missing')
    record.renderedAfter = record.outer.getValue()
    if (
      !resolveBlockHandleUnits(
        record.editor,
        record.after,
        record.renderedAfter,
        currentBlockProjection(),
      )
    )
      throw new Error('block action render no longer matches exact source')
    record.undoSnapshot = undoSnapshot
    restoreLogicalBlock(record, record.after, record.caretOffset)
  } catch (error) {
    try {
      record.outer.setValue(record.before)
      restoreTableUndoForRollback(record.inner, undoSnapshot)
      restoreLogicalBlock(record, record.before, record.action.sourceStart)
    } catch {
      // Never publish a partial local rebuild after a failed rollback.
    }
    countBlockActionDecline('prepare-proof')
    deps?.onError(error)
    cancel(record)
    return
  } finally {
    deps?.setApplying(false)
  }
  vscode.postMessage({
    command: 'apply-block-action',
    requestId: message.requestId,
    uri: message.uri,
    version: message.version,
    before: message.before,
    after: message.after,
  })
}

/** The model route: applied by units, or declined; false sends the record down today's route. */
function settledOnModelRoute(
  record: PendingAction,
  undoSnapshot: ReturnType<typeof snapshotTableUndoForRollback>,
): boolean {
  if (applyByUnits(record, undoSnapshot)) return true
  if (reproveForFallback(record)) return false
  countBlockActionDecline('prepare-model')
  cancel(record)
  return true
}

/**
 * Shared rules 3.7: a fallback of the apply by units runs today's route, but only on a rendering proven
 * to be `before` (Q-82): `setValue(after)` must not replace typing the planned bytes lack (010-R F1,
 * N2). True: the record now takes today's route.
 */
function reproveForFallback(record: PendingAction): boolean {
  const renderedBefore = record.outer.getValue()
  if (
    !resolveBlockHandleUnits(
      record.editor,
      record.before,
      renderedBefore,
      currentBlockProjection(),
    )
  )
    return false
  record.renderedBefore = renderedBefore
  record.modelRoute = false
  return true
}

/**
 * Task 733 / 010 (Q-31): applies `after` by units and posts it as a delta; the host binding is
 * cancelled, so no `apply-block-action` and no outcome follow. False: nothing changed, the caller
 * runs the existing route.
 */
function applyByUnits(
  record: PendingAction,
  undoSnapshot: ReturnType<typeof snapshotTableUndoForRollback>,
): boolean {
  const apply = deps?.applyExactText
  if (!apply) return false
  // Not inside `setApplying`: that window suppresses posts, and this route posts the delta itself.
  // No setValue runs here, so no rebuild's records need hiding. The checkpoint before closes the
  // history interval, so the one after holds the move alone (an Undo restores the order, DR1); a
  // fallback leaves it empty, and today's route takes its own.
  checkpointEditorUndo(record.inner)
  const outcome = apply(record.after, {
    rollback: {
      restore: () => restoreTableUndoForRollback(record.inner, undoSnapshot),
    },
  })
  if (outcome !== 'applied') return false
  checkpointEditorUndo(record.inner)
  // Without confirmed model units (a new table committed opaque) the caret comes from the plan.
  if (!restoreModelBlock(record, record.caretOffset))
    restoreLogicalBlock(record, record.after, record.caretOffset)
  pending.delete(record.requestId)
  window.clearTimeout(record.timeout)
  vscode.postMessage({
    command: 'cancel-block-action',
    requestId: record.requestId,
  })
  record.resolve(true)
  return true
}

/** Commit exact undo metadata only after the host confirms its one guarded model edit. */
export function finishBlockAction(
  message: Extract<HostMessage, { command: 'block-action-outcome' }>,
): void {
  const record = pending.get(message.requestId)
  if (!record) return
  pending.delete(message.requestId)
  window.clearTimeout(record.timeout)
  if (
    message.status === 'applied' &&
    record.nativeState &&
    record.renderedAfter
  ) {
    recordRewrapDocumentHistory({
      owner: record.inner,
      mode: record.mode,
      nativeState: record.nativeState,
      beforeRendered: record.renderedBefore,
      beforeExact: record.before,
      afterRendered: record.renderedAfter,
      afterExact: record.after,
    })
    // The host applies this protocol directly, without postExact. YAML/math can render with
    // different bytes, so adopt the confirmed source just as outline moves do. Ordinary
    // round-trip blocks retain their existing path and incur no additional serialization.
    if (
      record.preserveExact &&
      message.content === record.after &&
      window.vditor === record.outer &&
      innerVditor() === record.inner &&
      record.inner.currentMode === record.mode &&
      activeModeElement(record.outer) === record.editor &&
      record.outer.getValue() === record.renderedAfter
    )
      deps?.reown?.(record.after)
    restoreLogicalBlock(record, record.after, record.caretOffset)
    record.resolve(true)
    return
  }
  if (message.content && window.vditor === record.outer) {
    deps?.setApplying(true)
    try {
      record.outer.setValue(message.content)
      if (record.undoSnapshot)
        restoreTableUndoForRollback(record.inner, record.undoSnapshot)
    } finally {
      deps?.setApplying(false)
    }
  }
  countBlockActionDecline(`host-${message.status}`)
  record.resolve(false)
}
