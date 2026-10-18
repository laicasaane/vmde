import { findScroller } from '../chrome/toolbar-scroll-guard'
import { activeModeElement } from '../util/source-map'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { isCompositionActive } from '../util/caret-gesture'
import { requestCaret } from './caret'
import {
  checkpointEditorUndo,
  mapCaretOffsetByLine,
  recordRewrapDocumentHistory,
} from './rewrap-command'
import {
  restoreTableUndoForRollback,
  snapshotTableUndoForRollback,
} from './table-actions'
import {
  normalizeOrderedListsSource,
  type ListNormalizeScope,
} from './list-normalize-source'

interface SourceListCommandDeps {
  /** Task 630: acquire exact authority inside the command; `null` declines with no write. */
  acquireExactAuthority(): Promise<{ exact: string; rendered: string } | null>
  setApplying(value: boolean): void
  /** `rollback` restores the Undo stacks when the host refuses the guarded edit. */
  postExact(markdown: string, opts: { rollback: { restore(): void } }): void
  onError(error: unknown): void
}

interface RetainedSvSelection {
  outer: NonNullable<Window['vditor']>
  inner: InnerVditor
  editor: HTMLElement
  renderedMarkdown: string
  /** Offsets into the editor text (`renderedMarkdown`); mapped onto the acquired exact text at run time. */
  startOffset: number
  endOffset: number
  backward: boolean
}

const lineEndings = (text: string): string => text.replace(/\r\n|\r/gu, '\n')
let commandPending = false

let deps: SourceListCommandDeps | undefined
let retained: RetainedSvSelection | null = null
let disposeSelectionCapture: (() => void) | undefined

export function configureSourceListCommand(next: SourceListCommandDeps): void {
  deps = next
  disposeSelectionCapture?.()
  disposeSelectionCapture = installSelectionCapture()
}

function textOffsetAt(
  editor: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let total = 0
  for (
    let text = walker.nextNode() as Text | null;
    text;
    text = walker.nextNode() as Text | null
  ) {
    if (text === node)
      return total + Math.max(0, Math.min(offset, text.data.length))
    total += text.data.length
  }
  return null
}

/** Captures the source-owned selection before a host command shifts focus from the SV iframe. */
export function captureSourceListSvSelection(): boolean {
  const outer = window.vditor
  const inner = innerVditor()
  const editor = outer ? activeModeElement(outer) : null
  const selection = document.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  if (
    !deps ||
    !outer ||
    !inner ||
    !editor ||
    inner.currentMode !== 'sv' ||
    !range ||
    !editor.contains(range.startContainer) ||
    !editor.contains(range.endContainer)
  )
    return false
  if (
    range.collapsed &&
    range.startContainer === editor &&
    range.startOffset === 0
  )
    return false
  const renderedMarkdown = editor.textContent ?? ''
  const renderedStart = textOffsetAt(
    editor,
    range.startContainer,
    range.startOffset,
  )
  const renderedEnd = textOffsetAt(editor, range.endContainer, range.endOffset)
  if (renderedStart === null || renderedEnd === null) return false
  if (
    renderedStart === 0 &&
    renderedEnd === 0 &&
    retained?.editor === editor &&
    (retained.startOffset !== 0 || retained.endOffset !== 0)
  )
    return false
  retained = {
    outer,
    inner,
    editor,
    renderedMarkdown,
    startOffset: renderedStart,
    endOffset: renderedEnd,
    backward:
      !range.collapsed &&
      selection.anchorNode === range.endContainer &&
      selection.anchorOffset === range.endOffset,
  }
  return true
}

function installSelectionCapture(): () => void {
  const capture = () => captureSourceListSvSelection()
  const onFocusOut = (event: FocusEvent) => {
    const editor = window.vditor ? activeModeElement(window.vditor) : null
    if (editor && event.target instanceof Node && editor.contains(event.target))
      capture()
  }
  const clearForInput = (event: Event) => {
    if (
      retained &&
      event.target instanceof Node &&
      retained.editor.contains(event.target)
    )
      retained = null
  }
  const clearForGesture = (event: Event) => {
    if (
      retained?.editor &&
      event.target instanceof Node &&
      retained.editor.contains(event.target)
    )
      retained = null
  }
  document.addEventListener('selectionchange', capture)
  document.addEventListener('focusout', onFocusOut, true)
  document.addEventListener('input', clearForInput, true)
  document.addEventListener('pointerdown', clearForGesture, true)
  document.addEventListener('keydown', clearForGesture, true)
  document.addEventListener('beforeinput', clearForGesture, true)
  return () => {
    document.removeEventListener('selectionchange', capture)
    document.removeEventListener('focusout', onFocusOut, true)
    document.removeEventListener('input', clearForInput, true)
    document.removeEventListener('pointerdown', clearForGesture, true)
    document.removeEventListener('keydown', clearForGesture, true)
    document.removeEventListener('beforeinput', clearForGesture, true)
  }
}

function textPointAt(
  root: HTMLElement,
  offset: number,
): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = offset
  let last: Text | null = null
  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    last = node
    if (remaining <= node.data.length) return { node, offset: remaining }
    remaining -= node.data.length
  }
  return last ? { node: last, offset: last.data.length } : null
}

function replaceSource(
  editor: HTMLElement,
  before: string,
  after: string,
): boolean {
  if (editor.textContent !== before) return false
  let start = 0
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++
  let suffix = 0
  while (
    suffix < before.length - start &&
    suffix < after.length - start &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++
  const from = textPointAt(editor, start)
  const to = textPointAt(editor, before.length - suffix)
  if (!from || !to) return false
  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  range.deleteContents()
  range.insertNode(
    document.createTextNode(after.slice(start, after.length - suffix)),
  )
  editor.normalize()
  return editor.textContent === after
}

function restoreSelection(
  editor: HTMLElement,
  startOffset: number,
  endOffset: number,
  backward = false,
): boolean {
  editor.focus({ preventScroll: true })
  return requestCaret(
    startOffset === endOffset
      ? { textOffset: startOffset }
      : backward
        ? {
            anchor: { textOffset: endOffset },
            focus: { textOffset: startOffset },
          }
        : {
            anchor: { textOffset: startOffset },
            focus: { textOffset: endOffset },
          },
  )
}

/** Runs an explicit list command as one source-range edit on the acquired exact text; SV auto-renumber remains deliberately absent. */
export async function runSourceListCommand(
  win: Window,
  scope: ListNormalizeScope,
): Promise<number> {
  if (commandPending) return 0
  commandPending = true
  try {
    return await runAcquired(win, scope)
  } catch (error) {
    deps?.onError(error)
    return 0
  } finally {
    commandPending = false
  }
}

function liveSvEditor(
  win: Window,
  selection: RetainedSvSelection,
): { inner: InnerVditor; editor: HTMLElement } | null {
  const inner = innerVditor()
  const editor = win.vditor ? activeModeElement(win.vditor) : null
  if (
    !inner ||
    !editor ||
    isCompositionActive() ||
    editor.getAttribute('contenteditable') === 'false' ||
    editor.parentElement?.closest('[contenteditable="false"]') ||
    win.vditor !== selection.outer ||
    inner !== selection.inner ||
    editor !== selection.editor ||
    inner.currentMode !== 'sv' ||
    editor.textContent !== selection.renderedMarkdown
  )
    return null
  return { inner, editor }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the transaction keeps identity checks, history, rollback, caret and exact sync together.
async function runAcquired(
  win: Window,
  scope: ListNormalizeScope,
): Promise<number> {
  if (!deps || isCompositionActive() || !win.vditor) return 0
  const selection = retained
  retained = null
  if (!selection || !liveSvEditor(win, selection)) return 0
  const pair = await deps.acquireExactAuthority()
  // The acquisition may settle typing; the retained identity and the editor text must still hold,
  // and the acquired exact text must be the editor text up to line endings (the proof).
  const live = pair ? liveSvEditor(win, selection) : null
  if (
    !deps ||
    !pair ||
    !live ||
    lineEndings(pair.exact) !== selection.renderedMarkdown ||
    lineEndings(pair.rendered) !== selection.renderedMarkdown
  )
    return 0
  const { inner, editor } = live
  const exactStart = mapCaretOffsetByLine(
    selection.renderedMarkdown,
    pair.exact,
    selection.startOffset,
  )
  const exactEnd = mapCaretOffsetByLine(
    selection.renderedMarkdown,
    pair.exact,
    selection.endOffset,
  )
  if (exactStart === null || exactEnd === null) return 0
  const result = normalizeOrderedListsSource(
    pair.exact,
    exactStart,
    scope,
    exactEnd,
  )
  if (!result) return 0
  const afterRendered = lineEndings(result.markdown)
  const renderedStart = mapCaretOffsetByLine(
    result.markdown,
    afterRendered,
    result.startOffset,
  )
  const renderedEnd = mapCaretOffsetByLine(
    result.markdown,
    afterRendered,
    result.endOffset,
  )
  if (renderedStart === null || renderedEnd === null) return 0
  const scrollTop = findScroller(editor).scrollTop
  const undoSnapshot = snapshotTableUndoForRollback(inner)
  deps.setApplying(true)
  try {
    checkpointEditorUndo(inner)
    if (!replaceSource(editor, selection.renderedMarkdown, afterRendered))
      throw new Error('SV list command could not replace its retained source')
    checkpointEditorUndo(inner)
    const native = (inner.undo as any)?.sv?.undoStack?.at(-1)
    if (native)
      recordRewrapDocumentHistory({
        owner: inner,
        mode: 'sv',
        nativeState: native,
        beforeRendered: selection.renderedMarkdown,
        beforeExact: pair.exact,
        afterRendered,
        afterExact: result.markdown,
      })
    if (
      !restoreSelection(editor, renderedStart, renderedEnd, selection.backward)
    )
      throw new Error(
        'SV list command could not restore its retained selection',
      )
    const scroller = findScroller(editor)
    scroller.scrollTop = Math.min(
      scrollTop,
      Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    )
  } catch {
    try {
      replaceSource(editor, afterRendered, selection.renderedMarkdown)
      restoreTableUndoForRollback(inner, undoSnapshot)
      restoreSelection(
        editor,
        selection.startOffset,
        selection.endOffset,
        selection.backward,
      )
    } catch {
      // A failed rollback is still never allowed to publish the speculative exact source.
    }
    return 0
  } finally {
    deps.setApplying(false)
  }
  // Task 630: a host refusal rolls the editor back to the host text; the Undo stacks are restored here.
  deps.postExact(result.markdown, {
    rollback: {
      restore: () => restoreTableUndoForRollback(inner, undoSnapshot),
    },
  })
  return result.changedRoots
}
