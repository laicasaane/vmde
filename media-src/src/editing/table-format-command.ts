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
import { mapRenderedTableSelectionToSource } from './table-operations'
import { formatTableAtSelection } from './table-format'
import {
  restoreTableUndoForRollback,
  snapshotTableUndoForRollback,
} from './table-actions'

interface TableFormatCommandDeps {
  /** Task 630: acquire exact authority inside the command; `null` declines with no write. */
  acquireExactAuthority(): Promise<{ exact: string; rendered: string } | null>
  setApplying(value: boolean): void
  /** `rollback` restores the Undo stacks when the host refuses the guarded edit. */
  postExact(markdown: string, opts: { rollback: { restore(): void } }): void
  onError(error: unknown): void
}

let deps: TableFormatCommandDeps | undefined

interface RetainedSvSelection {
  outer: NonNullable<Window['vditor']>
  inner: InnerVditor
  editor: HTMLElement
  renderedMarkdown: string
  /** Offsets into the editor text (`renderedMarkdown`); mapped onto the acquired exact text at run time. */
  startOffset: number
  endOffset: number
}

const lineEndings = (text: string): string => text.replace(/\r\n|\r/gu, '\n')
let commandPending = false

let retainedSvSelection: RetainedSvSelection | null = null
let disposeRetainedSvSelection: (() => void) | undefined

export function configureTableFormatCommand(
  next: TableFormatCommandDeps,
): void {
  deps = next
  disposeRetainedSvSelection?.()
  disposeRetainedSvSelection = installRetainedSvSelection()
}

function textOffsetAt(
  editor: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let textOffset = 0
  for (
    let text = walker.nextNode() as Text | null;
    text;
    text = walker.nextNode() as Text | null
  ) {
    if (text === node)
      return textOffset + Math.max(0, Math.min(offset, text.data.length))
    textOffset += text.data.length
  }
  return null
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
  const renderedStart = textOffsetAt(
    editor,
    range.startContainer,
    range.startOffset,
  )
  const renderedEnd = textOffsetAt(editor, range.endContainer, range.endOffset)
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
  retainedSvSelection = {
    outer,
    inner,
    editor,
    renderedMarkdown,
    startOffset: renderedStart,
    endOffset: renderedEnd,
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

/** Runs the shipped Lute table formatter over one SV source table, on the acquired exact text, through one exact-history edit. */
export async function runTableFormatCommand(win: Window): Promise<boolean> {
  if (commandPending) return false
  commandPending = true
  try {
    return await runAcquired(win)
  } catch (error) {
    deps?.onError(error)
    return false
  } finally {
    commandPending = false
  }
}

function liveSvEditor(
  win: Window,
  retained: RetainedSvSelection,
): { inner: InnerVditor; editor: HTMLElement } | null {
  const inner = innerVditor()
  const editor = win.vditor ? activeModeElement(win.vditor) : null
  if (
    !inner ||
    !editor ||
    isCompositionActive() ||
    editor.getAttribute('contenteditable') === 'false' ||
    editor.parentElement?.closest('[contenteditable="false"]') ||
    win.vditor !== retained.outer ||
    inner !== retained.inner ||
    editor !== retained.editor ||
    inner.currentMode !== 'sv' ||
    editor.textContent !== retained.renderedMarkdown
  )
    return null
  return { inner, editor }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keeps retained-snapshot guards and atomic rollback in one source transaction.
async function runAcquired(win: Window): Promise<boolean> {
  if (!deps || isCompositionActive() || !win.vditor) return false
  const retained = retainedSvSelection
  retainedSvSelection = null
  if (!retained || !liveSvEditor(win, retained)) return false
  const pair = await deps.acquireExactAuthority()
  // The acquisition may settle typing; the retained identity and editor text must still hold, and
  // the acquired exact text must be the editor text up to line endings (the proof).
  const live = pair ? liveSvEditor(win, retained) : null
  const beforeRendered = retained.renderedMarkdown
  if (
    !deps ||
    !pair ||
    !live ||
    lineEndings(pair.exact) !== beforeRendered ||
    lineEndings(pair.rendered) !== beforeRendered
  )
    return false
  const { inner, editor } = live
  const beforeExact = pair.exact
  const startOffset = mapCaretOffsetByLine(
    beforeRendered,
    beforeExact,
    retained.startOffset,
  )
  const endOffset = mapCaretOffsetByLine(
    beforeRendered,
    beforeExact,
    retained.endOffset,
  )
  if (startOffset === null || endOffset === null) return false
  const tableMapped = mapRenderedTableSelectionToSource(
    beforeRendered,
    beforeExact,
    retained.startOffset,
    retained.endOffset,
  )
  const result = formatTableAtSelection(
    beforeExact,
    tableMapped?.startOffset ?? startOffset,
    tableMapped?.endOffset ?? endOffset,
    { format: (table) => inner.lute?.FormatStr?.('', table) ?? '' },
  )
  if (!result) return false
  const afterRendered = lineEndings(result.markdown)
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
      throw new Error('SV table formatter could not restore its retained caret')
    const scroller = findScroller(editor)
    scroller.scrollTop = Math.min(
      scrollTop,
      Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    )
  } catch {
    try {
      replaceSourceRange(editor, afterRendered, beforeRendered)
      restoreTableUndoForRollback(inner, undoSnapshot)
      restoreSvSelection(editor, retained.startOffset, retained.endOffset)
    } catch {
      // The exact speculative edit is never posted when rollback itself fails.
    }
    return false
  } finally {
    deps.setApplying(false)
  }
  // Task 630: a host refusal rolls the editor back to the host text; the Undo stacks are restored here.
  deps.postExact(result.markdown, {
    rollback: {
      restore: () => restoreTableUndoForRollback(inner, undoSnapshot),
    },
  })
  return true
}
