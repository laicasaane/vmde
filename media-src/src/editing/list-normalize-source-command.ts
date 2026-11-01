import { findScroller } from '../chrome/toolbar-scroll-guard'
import { activeModeElement } from '../util/source-map'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { isCompositionActive } from '../util/caret-gesture'
import { requestCaret } from './caret'
import {
  checkpointEditorUndo,
  recordRewrapDocumentHistory,
} from './rewrap-command'
import {
  planSvRegionEdit,
  proveSvOffsets,
  spliceSvRenderedSpan,
  svRenderedBounds,
} from './sv-source-proof'
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

/** The run of non-blank lines around `[start, end]`, from the first line's start to the last
 * line's end (without its line break). */
function blockAround(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } {
  const lines: Array<{ start: number; end: number; blank: boolean }> = []
  for (const match of text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/gu)) {
    if (match[0] === '' && match.index >= text.length) break
    lines.push({
      start: match.index,
      end: match.index + match[1].length,
      blank: match[1].trim() === '',
    })
  }
  let first = lines.findIndex((line) => start <= line.end)
  let last = lines.findIndex((line) => end <= line.end)
  if (first < 0) first = lines.length - 1
  if (last < 0) last = lines.length - 1
  while (first > 0 && !lines[first - 1].blank) first--
  while (last < lines.length - 1 && !lines[last + 1].blank) last++
  return { start: lines[first].start, end: lines[last].end }
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
  // The acquisition may settle typing; the retained identity and the editor text must still hold.
  // The editor text is Vditor's (it keeps an appended newline and shows Lute's padded tables), so it
  // is never compared with the exact text as a whole: the retained offsets and the changed region
  // are each proven against the acquired exact text instead.
  const live = pair ? liveSvEditor(win, selection) : null
  if (!deps || !pair || !live) return 0
  const { inner, editor } = live
  const beforeRendered = selection.renderedMarkdown
  const proven = proveSvOffsets(
    pair.exact,
    beforeRendered,
    selection.startOffset,
    selection.endOffset,
  )
  if (proven.status !== 'proven') return 0
  const result = normalizeOrderedListsSource(
    pair.exact,
    proven.start,
    scope,
    proven.end,
  )
  if (!result) return 0
  // The changed bytes, widened to the list block (the run of non-blank lines around them): a
  // renumbered list is usually shown renumbered by Lute, so the block is compared as a whole.
  let prefix = 0
  const shortest = Math.min(pair.exact.length, result.markdown.length)
  while (prefix < shortest && pair.exact[prefix] === result.markdown[prefix])
    prefix++
  let suffix = 0
  while (
    suffix < shortest - prefix &&
    pair.exact[pair.exact.length - 1 - suffix] ===
      result.markdown[result.markdown.length - 1 - suffix]
  )
    suffix++
  const span = blockAround(
    pair.exact,
    prefix,
    Math.max(prefix, pair.exact.length - suffix),
  )
  const bounds = svRenderedBounds(pair.exact, beforeRendered, span)
  if (!bounds) return 0
  // The region the edit replaces must be the same text in the editor: verbatim up to line ends, or
  // equal once Lute formats both (the editor may show the list renumbered).
  const format = (markdown: string): string =>
    inner.lute?.FormatStr?.('', markdown) ?? ''
  const exactRegion = lineEndings(pair.exact.slice(span.start, span.end))
  const renderedRegion = beforeRendered.slice(bounds.start, bounds.end)
  if (
    exactRegion !== renderedRegion &&
    (!format(exactRegion) || format(exactRegion) !== format(renderedRegion))
  )
    return 0
  const plan = planSvRegionEdit(
    pair.exact,
    {
      markdown: result.markdown,
      anchor: span.start,
      focus: span.start,
    },
    span,
    bounds,
  )
  if (!plan) return 0
  // Each caret keeps its own proof: inside the region it maps through the replacement, before it
  // the editor offset is unchanged and after it the offset moves by the region's size change.
  const newEnd = span.end + (result.markdown.length - pair.exact.length)
  const delta = plan.replacement.length - (bounds.end - bounds.start)
  const caretAt = (offset: number, retained: number): number | null => {
    if (offset < span.start) return retained
    if (offset > newEnd) return retained + delta
    return (
      planSvRegionEdit(
        pair.exact,
        { markdown: result.markdown, anchor: offset, focus: offset },
        span,
        bounds,
      )?.anchor ?? null
    )
  }
  const anchor = caretAt(result.startOffset, selection.startOffset)
  const focus = caretAt(result.endOffset, selection.endOffset)
  if (anchor === null || focus === null) return 0
  const edit = { replacement: plan.replacement, anchor, focus }
  const afterRendered =
    beforeRendered.slice(0, bounds.start) +
    edit.replacement +
    beforeRendered.slice(bounds.end)
  const scrollTop = findScroller(editor).scrollTop
  const undoSnapshot = snapshotTableUndoForRollback(inner)
  deps.setApplying(true)
  try {
    checkpointEditorUndo(inner)
    if (!spliceSvRenderedSpan(editor, beforeRendered, bounds, edit.replacement))
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
    if (!restoreSelection(editor, edit.anchor, edit.focus, selection.backward))
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
