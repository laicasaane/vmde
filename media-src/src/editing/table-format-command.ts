import { findScroller } from '../chrome/toolbar-scroll-guard'
import { activeModeElement } from '../util/source-map'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { isCompositionActive } from '../util/caret-gesture'
import {
  checkpointEditorUndo,
  mapCaretOffsetByLine,
  recordRewrapDocumentHistory,
} from './rewrap-command'
import { requestCaret } from './caret'
import { formatTableAtSelection } from './table-format'
import {
  restoreTableUndoForRollback,
  snapshotTableUndoForRollback,
} from './table-actions'

interface TableFormatCommandDeps {
  snapshotExactMarkdown(): string
  setApplying(value: boolean): void
  postExact(markdown: string): void
  onError(error: unknown): void
}

let deps: TableFormatCommandDeps | undefined

interface RetainedSvSelection {
  outer: NonNullable<Window['vditor']>
  inner: InnerVditor
  editor: HTMLElement
  exactMarkdown: string
  renderedMarkdown: string
  startOffset: number
  endOffset: number
}

let retainedSvSelection: RetainedSvSelection | null = null
let disposeRetainedSvSelection: (() => void) | undefined

export function configureTableFormatCommand(
  next: TableFormatCommandDeps,
): void {
  deps = next
  disposeRetainedSvSelection?.()
  disposeRetainedSvSelection = installRetainedSvSelection()
}

function rangeOffset(
  editor: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  try {
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.setEnd(node, offset)
    return range.toString().length
  } catch {
    return null
  }
}

/** Capture the source-owned selection before a host command moves focus out of the webview. */
export function captureTableFormatSvSelection(): boolean {
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
  ) {
    return false
  }
  // Focus crossing can transiently collapse the source selection to the editor root. It is not a
  // user caret, so retaining it would replace the source position that the host command needs.
  if (
    range.collapsed &&
    range.startContainer === editor &&
    range.startOffset === 0
  )
    return false
  const renderedMarkdown = editor.textContent ?? ''
  const renderedStart = rangeOffset(
    editor,
    range.startContainer,
    range.startOffset,
  )
  const renderedEnd = rangeOffset(editor, range.endContainer, range.endOffset)
  const exactMarkdown = deps.snapshotExactMarkdown()
  if (renderedStart === null || renderedEnd === null) return false
  // Once VS Code has moved focus to its command host, Vditor may report the same sentinel as the
  // first text node at offset zero rather than the editor root. Preserve a real retained caret;
  // an intentional user move to document start still replaces it while the editor owns focus.
  if (
    renderedStart === 0 &&
    renderedEnd === 0 &&
    retainedSvSelection?.editor === editor &&
    (retainedSvSelection.startOffset !== 0 ||
      retainedSvSelection.endOffset !== 0)
  )
    return false
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
  retainedSvSelection = {
    outer,
    inner,
    editor,
    exactMarkdown,
    renderedMarkdown,
    startOffset,
    endOffset,
  }
  return true
}

/** Keep the last source-owned selection until the host command crosses the webview focus boundary. */
function installRetainedSvSelection(): () => void {
  const capture = () => captureTableFormatSvSelection()
  const onFocusOut = (event: FocusEvent) => {
    const editor = window.vditor ? activeModeElement(window.vditor) : null
    // VS Code command dispatch takes focus out of the iframe before it posts its message. Capture
    // here as well as on selectionchange so a synthetic or just-created Range cannot miss the
    // browser's deferred selectionchange event and degrade to the editor-start focus artifact.
    if (editor && event.target instanceof Node && editor.contains(event.target))
      capture()
  }
  const onInput = (event: Event) => {
    if (
      retainedSvSelection &&
      event.target instanceof Node &&
      retainedSvSelection.editor.contains(event.target)
    ) {
      retainedSvSelection = null
    }
  }
  const onEditorGesture = (event: Event) => {
    const editor = retainedSvSelection?.editor
    // A real editor gesture authorizes a new source position, including document start. Without
    // one, the start sentinel is focus-loss noise and must not replace the saved command target.
    if (editor && event.target instanceof Node && editor.contains(event.target))
      retainedSvSelection = null
  }
  document.addEventListener('selectionchange', capture)
  document.addEventListener('focusout', onFocusOut, true)
  document.addEventListener('input', onInput, true)
  document.addEventListener('pointerdown', onEditorGesture, true)
  document.addEventListener('keydown', onEditorGesture, true)
  document.addEventListener('beforeinput', onEditorGesture, true)
  return () => {
    document.removeEventListener('selectionchange', capture)
    document.removeEventListener('focusout', onFocusOut, true)
    document.removeEventListener('input', onInput, true)
    document.removeEventListener('pointerdown', onEditorGesture, true)
    document.removeEventListener('keydown', onEditorGesture, true)
    document.removeEventListener('beforeinput', onEditorGesture, true)
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

function restoreSvSelection(
  editor: HTMLElement,
  startOffset: number,
  endOffset: number,
): boolean {
  editor.focus({ preventScroll: true })
  return requestCaret(
    startOffset === endOffset
      ? { textOffset: startOffset }
      : {
          anchor: { textOffset: startOffset },
          focus: { textOffset: endOffset },
        },
  )
}

function replaceSourceRange(
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
  ) {
    suffix++
  }
  const startPoint = textPointAt(editor, start)
  const endPoint = textPointAt(editor, before.length - suffix)
  if (!startPoint || !endPoint) return false
  const range = document.createRange()
  range.setStart(startPoint.node, startPoint.offset)
  range.setEnd(endPoint.node, endPoint.offset)
  range.deleteContents()
  range.insertNode(
    document.createTextNode(after.slice(start, after.length - suffix)),
  )
  editor.normalize()
  return editor.textContent === after
}

/** Runs the shipped Lute table formatter over one SV source table through one exact-history edit. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keeps retained-snapshot guards and atomic rollback in one source transaction.
export function runTableFormatCommand(win: Window): boolean {
  try {
    if (!deps || isCompositionActive() || !win.vditor) return false
    const retained = retainedSvSelection
    retainedSvSelection = null
    if (!retained) return false
    const inner = innerVditor()
    const editor = activeModeElement(win.vditor)
    if (
      !inner ||
      !editor ||
      win.vditor !== retained.outer ||
      inner !== retained.inner ||
      editor !== retained.editor ||
      inner.currentMode !== 'sv' ||
      deps.snapshotExactMarkdown() !== retained.exactMarkdown ||
      editor.textContent !== retained.renderedMarkdown
    )
      return false
    const beforeExact = retained.exactMarkdown
    const beforeRendered = retained.renderedMarkdown
    const result = formatTableAtSelection(
      beforeExact,
      retained.startOffset,
      retained.endOffset,
      { format: (table) => inner.lute?.FormatStr?.('', table) ?? '' },
    )
    if (!result) return false
    const afterRendered = result.markdown.replace(/\r\n|\r/gu, '\n')
    const renderedStart = mapCaretOffsetByLine(
      result.markdown,
      afterRendered,
      result.selectionStart,
    )
    const renderedEnd = mapCaretOffsetByLine(
      result.markdown,
      afterRendered,
      result.selectionEnd,
    )
    if (renderedStart === null || renderedEnd === null) return false
    if (
      deps.snapshotExactMarkdown() !== beforeExact ||
      inner.currentMode !== 'sv' ||
      activeModeElement(win.vditor) !== editor ||
      editor.textContent !== beforeRendered
    ) {
      return false
    }
    const scrollTop = findScroller(editor).scrollTop
    const undoSnapshot = snapshotTableUndoForRollback(inner)
    deps.setApplying(true)
    try {
      checkpointEditorUndo(inner)
      if (!replaceSourceRange(editor, beforeRendered, afterRendered))
        throw new Error(
          'SV table formatter could not replace its retained source',
        )
      checkpointEditorUndo(inner)
      const native = (inner.undo as any)?.sv?.undoStack?.at(-1)
      if (native) {
        recordRewrapDocumentHistory({
          owner: inner,
          mode: 'sv',
          nativeState: native,
          beforeRendered,
          beforeExact,
          afterRendered,
          afterExact: result.markdown,
        })
      }
      if (!restoreSvSelection(editor, renderedStart, renderedEnd))
        throw new Error(
          'SV table formatter could not restore its retained caret',
        )
      const scroller = findScroller(editor)
      scroller.scrollTop = Math.min(
        scrollTop,
        Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      )
    } catch {
      try {
        replaceSourceRange(editor, afterRendered, beforeRendered)
        restoreTableUndoForRollback(inner, undoSnapshot)
        restoreSvSelection(
          editor,
          mapCaretOffsetByLine(
            beforeExact,
            beforeRendered,
            retained.startOffset,
          ) ?? retained.startOffset,
          mapCaretOffsetByLine(
            beforeExact,
            beforeRendered,
            retained.endOffset,
          ) ?? retained.endOffset,
        )
      } catch {
        // The exact speculative edit is never posted when rollback itself fails.
      }
      return false
    } finally {
      deps.setApplying(false)
    }
    deps.postExact(result.markdown)
    return true
  } catch (error) {
    deps?.onError(error)
    return false
  }
}
