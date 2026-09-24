import { findScroller } from '../chrome/toolbar-scroll-guard'
import { isCompositionActive } from '../util/caret-gesture'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { activeModeElement } from '../util/source-map'
import { requestCaret } from './caret'
import {
  BLOCK_TYPES,
  describeBlockAt,
  planBlockTransform,
  type BlockMetadata,
  type BlockTarget,
} from './block-transform'
import {
  captureRewrapSourceSelection,
  checkpointEditorUndo,
  recordRewrapDocumentHistory,
  replaceSvMarkdownRange,
} from './rewrap-command'
import {
  restoreTableUndoForRollback,
  snapshotTableUndoForRollback,
} from './table-actions'

interface BlockTransformDeps {
  snapshotExactMarkdown(): string
  setApplying(value: boolean): void
  postExact(markdown: string): void
  onError(error: unknown): void
}

interface BlockBookmark {
  outer: NonNullable<Window['vditor']>
  inner: InnerVditor
  editor: HTMLElement
  mode: 'ir' | 'wysiwyg' | 'sv'
  exact: string
  rendered: string
  anchor: number
  focus: number
  metadata: BlockMetadata
}

export interface BlockTransformOptions extends BlockMetadata {
  token: number
}

let deps: BlockTransformDeps | undefined
let retained: BlockBookmark | null = null
let pending: (BlockBookmark & { token: number }) | null = null
let disposeCapture: (() => void) | undefined
let nextToken = 0
let transactionGeneration = 0

function isEditable(editor: HTMLElement): boolean {
  return (
    editor.getAttribute('contenteditable') !== 'false' &&
    !editor.closest('[contenteditable="false"]')
  )
}

function focusSentinel(editor: HTMLElement): boolean {
  const selection = document.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  return Boolean(
    range?.collapsed &&
      range.startContainer === editor &&
      range.startOffset === 0,
  )
}

function liveSelectionIn(editor: HTMLElement): boolean {
  const selection = document.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  return Boolean(
    range &&
      editor.contains(range.startContainer) &&
      editor.contains(range.endContainer),
  )
}

function capture(win: Window): BlockBookmark | null {
  if (!deps || isCompositionActive()) return null
  const outer = win.vditor
  const inner = innerVditor()
  const editor = outer ? activeModeElement(outer) : null
  const mode = inner?.currentMode
  if (
    !outer ||
    !inner ||
    !editor ||
    !isEditable(editor) ||
    (mode !== 'ir' && mode !== 'wysiwyg' && mode !== 'sv') ||
    !liveSelectionIn(editor)
  )
    return null
  const exact = deps.snapshotExactMarkdown()
  const selection = captureRewrapSourceSelection(win, {
    authoritativeMarkdown: exact,
  })
  if (!selection || selection.markdown !== exact) return null
  const dom = win.getSelection()
  const range = dom?.rangeCount ? dom.getRangeAt(0) : null
  const backward = Boolean(
    range &&
      !range.collapsed &&
      dom?.anchorNode === range.endContainer &&
      dom.anchorOffset === range.endOffset,
  )
  const anchor = backward ? selection.endOffset : selection.startOffset
  const focus = backward ? selection.startOffset : selection.endOffset
  const metadata = describeBlockAt(exact, anchor, focus)
  if (!metadata) return null
  return {
    outer,
    inner,
    editor,
    mode,
    exact,
    rendered: outer.getValue(),
    anchor,
    focus,
    metadata,
  }
}

function installCapture(): () => void {
  const refresh = () => {
    const outer = window.vditor
    const editor = outer ? activeModeElement(outer) : null
    if (!editor || !liveSelectionIn(editor)) return
    // Native palette focus can leave a root-at-zero sentinel; it must not replace a real caret.
    if (focusSentinel(editor)) return
    retained = capture(window)
  }
  const clear = () => {
    retained = null
    pending = null
  }
  document.addEventListener('selectionchange', refresh)
  document.addEventListener('focusout', refresh, true)
  document.addEventListener('beforeinput', clear, true)
  document.addEventListener('compositionstart', clear, true)
  return () => {
    document.removeEventListener('selectionchange', refresh)
    document.removeEventListener('focusout', refresh, true)
    document.removeEventListener('beforeinput', clear, true)
    document.removeEventListener('compositionstart', clear, true)
    clear()
  }
}

export function configureBlockTransformCommand(
  next: BlockTransformDeps,
): () => void {
  disposeCapture?.()
  deps = next
  disposeCapture = installCapture()
  return () => {
    disposeCapture?.()
    disposeCapture = undefined
    deps = undefined
  }
}

/** Retain a source-proven bookmark before native QuickPick moves focus. */
export function requestBlockTransformOptions(
  win: Window,
): BlockTransformOptions | null {
  const outer = win.vditor
  const editor = outer ? activeModeElement(outer) : null
  const active =
    editor && liveSelectionIn(editor) && !focusSentinel(editor)
      ? capture(win)
      : retained
  if (
    !active ||
    !deps ||
    active.outer !== outer ||
    active.inner !== innerVditor() ||
    active.editor !== editor ||
    active.mode !== active.inner.currentMode ||
    active.exact !== deps.snapshotExactMarkdown() ||
    active.rendered !== outer?.getValue()
  )
    return null
  const token = ++nextToken
  pending = { ...active, token }
  return { ...active.metadata, token }
}

function marker(markdown: string, name: string): string {
  let index = 0
  for (;;) {
    const value = `\uE440VMDE_BLOCK_${name}_${index}\uE44F`
    if (!markdown.includes(value)) return value
    index++
  }
}

function removeMarker(editor: HTMLElement, value: string): number | null {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let offset = 0
  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    const index = node.data.indexOf(value)
    if (index >= 0) {
      node.deleteData(index, value.length)
      return offset + index
    }
    offset += node.data.length
  }
  return null
}

function caretFromTextOffsets(anchor: number, focus: number): boolean {
  return anchor === focus
    ? requestCaret({ textOffset: focus })
    : requestCaret({
        anchor: { textOffset: anchor },
        focus: { textOffset: focus },
      })
}

function applyVisual(
  bookmark: BlockBookmark,
  after: string,
  anchor: number,
  focus: number,
): { rendered: string; caret: { anchor: number; focus: number } } | null {
  const first = marker(after, 'A')
  const second = anchor === focus ? first : marker(after + first, 'F')
  const marks =
    anchor === focus
      ? [{ offset: anchor, value: first, name: 'anchor' as const }]
      : [
          { offset: anchor, value: first, name: 'anchor' as const },
          { offset: focus, value: second, name: 'focus' as const },
        ]
  let marked = after
  for (const mark of [...marks].sort((a, b) => b.offset - a.offset))
    marked =
      marked.slice(0, mark.offset) + mark.value + marked.slice(mark.offset)
  bookmark.outer.setValue(marked)
  const fresh = activeModeElement(bookmark.outer)
  if (!fresh) return null
  const offsets: { anchor?: number; focus?: number } = {}
  for (const mark of [...marks].sort((a, b) => a.offset - b.offset)) {
    const found = removeMarker(fresh, mark.value)
    if (found === null) return null
    offsets[mark.name] = found
  }
  const mappedAnchor = offsets.anchor
  const mappedFocus = offsets.focus ?? mappedAnchor
  if (
    mappedAnchor === undefined ||
    mappedFocus === undefined ||
    !caretFromTextOffsets(mappedAnchor, mappedFocus)
  )
    return null
  return {
    rendered: bookmark.outer.getValue(),
    caret: { anchor: mappedAnchor, focus: mappedFocus },
  }
}

function revalidate(bookmark: BlockBookmark, win: Window): boolean {
  return Boolean(
    deps &&
      !isCompositionActive() &&
      win.vditor === bookmark.outer &&
      innerVditor() === bookmark.inner &&
      bookmark.inner.currentMode === bookmark.mode &&
      activeModeElement(bookmark.outer) === bookmark.editor &&
      bookmark.editor.isConnected &&
      isEditable(bookmark.editor) &&
      deps.snapshotExactMarkdown() === bookmark.exact &&
      bookmark.outer.getValue() === bookmark.rendered,
  )
}

function prepareChoice(
  win: Window,
  token: number,
  target: BlockTarget,
): {
  bookmark: BlockBookmark
  result: ReturnType<typeof planBlockTransform>
} | null {
  const bookmark = pending
  pending = null
  if (
    !bookmark ||
    bookmark.token !== token ||
    !revalidate(bookmark, win) ||
    !BLOCK_TYPES.includes(target.type)
  )
    return null
  const allowed = bookmark.metadata.targets.find(
    (item) => item.type === target.type,
  )
  if (allowed?.status !== 'changed') return null
  const result = planBlockTransform(
    bookmark.exact,
    bookmark.metadata.span,
    target,
    bookmark.anchor,
    bookmark.focus,
  )
  if (result.status !== 'changed' || !revalidate(bookmark, win)) return null
  if (bookmark.mode === 'sv' && bookmark.editor.textContent !== bookmark.exact)
    return null
  return { bookmark, result }
}

/** Apply only the retained request and one currently allowed source target. */
export function applyBlockTransformChoice(
  win: Window,
  token: number,
  target: BlockTarget,
): boolean {
  const prepared = prepareChoice(win, token, target)
  if (!prepared) return false
  const { bookmark, result } = prepared
  const scrollTop = findScroller(bookmark.editor).scrollTop
  const undoSnapshot = snapshotTableUndoForRollback(bookmark.inner)
  const generation = ++transactionGeneration
  deps!.setApplying(true)
  let afterRendered = bookmark.rendered
  try {
    checkpointEditorUndo(bookmark.inner)
    if (bookmark.mode === 'sv') {
      if (
        !replaceSvMarkdownRange(bookmark.editor, bookmark.exact, {
          markdown: result.markdown,
          caretOffset: result.focus,
        }) ||
        !caretFromTextOffsets(result.anchor, result.focus)
      )
        throw new Error(
          'SV block transform could not restore its source selection',
        )
      afterRendered = bookmark.outer.getValue()
    } else {
      const visual = applyVisual(
        bookmark,
        result.markdown,
        result.anchor,
        result.focus,
      )
      if (!visual)
        throw new Error('Block transform caret marker did not round-trip')
      afterRendered = visual.rendered
      win.requestAnimationFrame(() => {
        if (
          generation !== transactionGeneration ||
          !revalidateAfter(bookmark, result.markdown, afterRendered)
        )
          return
        caretFromTextOffsets(visual.caret.anchor, visual.caret.focus)
      })
    }
    checkpointEditorUndo(bookmark.inner)
    const native = (bookmark.inner.undo as any)?.[bookmark.mode]?.undoStack?.at(
      -1,
    )
    if (native)
      recordRewrapDocumentHistory({
        owner: bookmark.inner,
        mode: bookmark.mode,
        nativeState: native,
        beforeRendered: bookmark.rendered,
        beforeExact: bookmark.exact,
        afterRendered,
        afterExact: result.markdown,
      })
    const fresh = activeModeElement(bookmark.outer)
    if (fresh) {
      const scroller = findScroller(fresh)
      scroller.scrollTop = Math.min(
        scrollTop,
        Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      )
      fresh.focus({ preventScroll: true })
    }
  } catch (error) {
    try {
      bookmark.outer.setValue(bookmark.exact)
      restoreTableUndoForRollback(bookmark.inner, undoSnapshot)
      requestCaret({ textOffset: bookmark.focus })
    } catch {
      // A failed rollback still must not publish a speculative source transform.
    }
    deps?.onError(error)
    return false
  } finally {
    deps?.setApplying(false)
  }
  deps?.postExact(result.markdown)
  return true
}

function revalidateAfter(
  bookmark: BlockBookmark,
  exact: string,
  rendered: string,
): boolean {
  return Boolean(
    deps &&
      bookmark.outer === window.vditor &&
      bookmark.inner === innerVditor() &&
      bookmark.inner.currentMode === bookmark.mode &&
      activeModeElement(bookmark.outer) === bookmark.editor &&
      deps.snapshotExactMarkdown() === exact &&
      bookmark.outer.getValue() === rendered,
  )
}
