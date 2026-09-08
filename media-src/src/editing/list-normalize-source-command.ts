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
  snapshotExactMarkdown(): string
  setApplying(value: boolean): void
  postExact(markdown: string): void
  onError(error: unknown): void
}

interface RetainedSvSelection {
  outer: NonNullable<Window['vditor']>
  inner: InnerVditor
  editor: HTMLElement
  exactMarkdown: string
  renderedMarkdown: string
  startOffset: number
  endOffset: number
  backward: boolean
}

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
  const exactMarkdown = deps.snapshotExactMarkdown()
  const startOffset = mapCaretOffsetByLine(
    renderedMarkdown,
    exactMarkdown,
    renderedStart,
  )
  const endOffset = mapCaretOffsetByLine(
    renderedMarkdown,
    exactMarkdown,
    renderedEnd,
  )
  if (startOffset === null || endOffset === null) return false
  retained = {
    outer,
    inner,
    editor,
    exactMarkdown,
    renderedMarkdown,
    startOffset,
    endOffset,
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

/** Runs an explicit list command as one source-range edit; SV auto-renumber remains deliberately absent. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the transaction keeps identity checks, history, rollback, caret and exact sync together.
export function runSourceListCommand(
  win: Window,
  scope: ListNormalizeScope,
): number {
  try {
    if (!deps || isCompositionActive() || !win.vditor) return 0
    const selection = retained
    retained = null
    if (!selection) return 0
    const inner = innerVditor()
    const editor = activeModeElement(win.vditor)
    if (
      !inner ||
      !editor ||
      editor.getAttribute('contenteditable') === 'false' ||
      editor.parentElement?.closest('[contenteditable="false"]') ||
      win.vditor !== selection.outer ||
      inner !== selection.inner ||
      editor !== selection.editor ||
      inner.currentMode !== 'sv' ||
      deps.snapshotExactMarkdown() !== selection.exactMarkdown ||
      editor.textContent !== selection.renderedMarkdown
    )
      return 0
    const result = normalizeOrderedListsSource(
      selection.exactMarkdown,
      selection.startOffset,
      scope,
      selection.endOffset,
    )
    if (!result) return 0
    const afterRendered = result.markdown.replace(/\r\n|\r/gu, '\n')
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
    if (
      renderedStart === null ||
      renderedEnd === null ||
      deps.snapshotExactMarkdown() !== selection.exactMarkdown ||
      inner.currentMode !== 'sv' ||
      activeModeElement(win.vditor) !== editor ||
      editor.textContent !== selection.renderedMarkdown
    )
      return 0
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
          beforeExact: selection.exactMarkdown,
          afterRendered,
          afterExact: result.markdown,
        })
      if (
        !restoreSelection(
          editor,
          renderedStart,
          renderedEnd,
          selection.backward,
        )
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
          mapCaretOffsetByLine(
            selection.exactMarkdown,
            selection.renderedMarkdown,
            selection.startOffset,
          ) ?? selection.startOffset,
          mapCaretOffsetByLine(
            selection.exactMarkdown,
            selection.renderedMarkdown,
            selection.endOffset,
          ) ?? selection.endOffset,
          selection.backward,
        )
      } catch {
        // A failed rollback is still never allowed to publish the speculative exact source.
      }
      return 0
    } finally {
      deps.setApplying(false)
    }
    deps.postExact(result.markdown)
    return result.changedRoots
  } catch (error) {
    deps?.onError(error)
    return 0
  }
}
