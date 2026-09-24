import {
  planBlockAction,
  type BlockActionIntent,
} from '../../../src/shared/block-move'
import type { HostMessage } from '../../../src/shared/protocol'
import { findScroller } from '../chrome/toolbar-scroll-guard'
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
} from '../nav/block-handle'

interface BlockActionDeps {
  settleInput(): void
  snapshotExactMarkdown(): string
  setApplying(value: boolean): void
  onError(error: unknown): void
}

interface PendingAction {
  requestId: string
  action: BlockActionIntent
  before: string
  after: string
  renderedBefore: string
  outer: NonNullable<Window['vditor']>
  inner: InnerVditor
  editor: HTMLElement
  mode: 'ir' | 'wysiwyg'
  caretOffset: number
  scrollTop: number
  nativeState?: unknown
  renderedAfter?: string
  undoSnapshot?: ReturnType<typeof snapshotTableUndoForRollback>
  timeout: number
  resolve(value: boolean): void
}

let deps: BlockActionDeps | undefined
const pending = new Map<string, PendingAction>()

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
      record.outer.getValue() === record.renderedBefore,
  )
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
  const selection = getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
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

/** Request a host-bound edit after flushing pending local typing; no DOM mutation yet. */
export function requestBlockAction(
  action: BlockActionIntent,
): Promise<boolean> {
  if (!deps || pending.size || isCompositionActive())
    return Promise.resolve(false)
  deps.settleInput()
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
    return Promise.resolve(false)
  const before = deps.snapshotExactMarkdown()
  const renderedBefore = outer.getValue()
  const units = resolveBlockHandleUnits(
    editor,
    before,
    renderedBefore,
    currentBlockProjection(),
  )
  if (
    !units?.some((unit) => unit.start === action.sourceStart) ||
    (action.kind === 'move' &&
      !units.some((unit) => unit.start === action.targetStart))
  )
    return Promise.resolve(false)
  const plan = planBlockAction(before, action)
  if (plan.status !== 'ok') return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const requestId = crypto.randomUUID()
    const record: PendingAction = {
      requestId,
      action,
      before,
      after: plan.markdown,
      renderedBefore,
      outer,
      inner,
      editor,
      mode,
      caretOffset: plan.caretOffset,
      scrollTop: findScroller(editor).scrollTop,
      timeout: window.setTimeout(() => {
        const active = pending.get(requestId)
        if (active) cancel(active)
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
    cancel(record)
    return
  }
  const undoSnapshot = snapshotTableUndoForRollback(record.inner)
  deps!.setApplying(true)
  try {
    checkpointEditorUndo(record.inner)
    record.outer.setValue(record.after)
    checkpointEditorUndo(record.inner)
    record.nativeState = (record.inner.undo as any)?.[
      record.mode
    ]?.undoStack?.at(-1)
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
  record.resolve(false)
}
