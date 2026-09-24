import { findScroller } from '../chrome/toolbar-scroll-guard'
import { isCompositionActive } from '../util/caret-gesture'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { activeModeElement } from '../util/source-map'
import {
  currentBlockProjection,
  resolveBlockHandleUnits,
} from '../nav/block-handle'
import { requestCaret } from './caret'
import {
  BLOCK_TYPES,
  describeBlockAt,
  fenceParagraphBody,
  planBlockTransform,
  type BlockMetadata,
  type BlockTarget,
  type BlockTransformProposal,
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
let pending:
  | (BlockBookmark & {
      token: number
      proposals: Partial<Record<BlockTarget['type'], BlockTransformProposal>>
    })
  | null = null
let disposeCapture: (() => void) | undefined
let nextToken = 0
let transactionGeneration = 0
let lastCheckpoint: {
  owner: InnerVditor
  mode: BlockBookmark['mode']
  exact: string
  rendered: string
  nativeState: unknown
} | null = null

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

function batchOwnershipIsLive(bookmark: BlockBookmark): boolean {
  if (bookmark.metadata.spans.length < 2) return true
  if (bookmark.mode === 'sv')
    return bookmark.editor.textContent === bookmark.exact
  const units = resolveBlockHandleUnits(
    bookmark.editor,
    bookmark.exact,
    bookmark.rendered,
    currentBlockProjection(),
  )
  return Boolean(
    units &&
      bookmark.metadata.spans.every((span) =>
        units.some(
          (unit) => unit.start === span.start && unit.end === span.end,
        ),
      ),
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
  const bookmark: BlockBookmark = {
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
  return batchOwnershipIsLive(bookmark) ? bookmark : null
}

function installCapture(): () => void {
  const refresh = () => {
    const outer = window.vditor
    const editor = outer ? activeModeElement(outer) : null
    if (!editor || !liveSelectionIn(editor)) return
    // Native palette focus can leave a root-at-zero sentinel; it must not replace a real caret.
    if (focusSentinel(editor)) return
    const next = capture(window)
    if (
      pending &&
      (!next ||
        next.editor !== pending.editor ||
        next.mode !== pending.mode ||
        next.anchor !== pending.anchor ||
        next.focus !== pending.focus)
    )
      pending = null
    retained = next
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
  lastCheckpoint = null
  deps = next
  disposeCapture = installCapture()
  return () => {
    disposeCapture?.()
    disposeCapture = undefined
    deps = undefined
    lastCheckpoint = null
  }
}

function planForBookmark(bookmark: BlockBookmark, target: BlockTarget) {
  const span =
    bookmark.metadata.spans.length > 1
      ? {
          start: Math.min(bookmark.anchor, bookmark.focus),
          end: Math.max(bookmark.anchor, bookmark.focus),
        }
      : bookmark.metadata.span
  return planBlockTransform(
    bookmark.exact,
    span,
    target,
    bookmark.anchor,
    bookmark.focus,
  )
}

function luteProvesOneParagraph(
  bookmark: BlockBookmark,
  body: string,
): boolean {
  const lute = bookmark.inner.lute
  if (!lute?.Md2VditorIRDOM || !lute.Md2VditorDOM) return false
  try {
    for (const html of [lute.Md2VditorIRDOM(body), lute.Md2VditorDOM(body)]) {
      const detached = document.createElement('div')
      detached.innerHTML = html
      if (
        detached.children.length !== 1 ||
        detached.firstElementChild?.tagName !== 'P'
      )
        return false
    }
    return true
  } catch {
    return false
  }
}

function riskyFenceProof(
  bookmark: BlockBookmark,
  target: BlockTarget,
): boolean {
  if (target.type === 'fence') return true
  return bookmark.metadata.spans.every((span) => {
    const block = bookmark.exact.slice(span.start, span.end)
    if (!/^ {0,3}(?:`{3,}|~{3,})/u.test(block)) return true
    const body = fenceParagraphBody(block)
    return body !== null && luteProvesOneParagraph(bookmark, body)
  })
}

function retainPending(bookmark: BlockBookmark): BlockTransformOptions {
  bookmark.metadata = {
    ...bookmark.metadata,
    targets: bookmark.metadata.targets.map((target) =>
      target.status === 'confirm-required' &&
      !riskyFenceProof(bookmark, { type: target.type })
        ? { ...target, status: 'unsupported', losses: [] }
        : target,
    ),
  }
  const token = ++nextToken
  const proposals: Partial<
    Record<BlockTarget['type'], BlockTransformProposal>
  > = {}
  for (const target of bookmark.metadata.targets) {
    if (target.status !== 'confirm-required') continue
    const result = planForBookmark(bookmark, { type: target.type })
    if (result.status === 'confirm-required' && result.proposal)
      proposals[target.type] = result.proposal
  }
  pending = { ...bookmark, token, proposals }
  return { ...bookmark.metadata, token }
}

/** Retain a source-proven bookmark before native QuickPick moves focus. */
export function requestBlockTransformOptions(
  win: Window,
): BlockTransformOptions | null {
  pending = null
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
  return retainPending(active)
}

/** A handle may open the shared palette only for its source-proven DOM unit. */
export function requestBlockTransformOptionsAtSource(
  win: Window,
  sourceStart: number,
  sourceEnd: number,
  verifySource: (
    exact: string,
    rendered: string,
    editor: HTMLElement,
  ) => boolean,
): BlockTransformOptions | null {
  pending = null
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
    (mode !== 'ir' && mode !== 'wysiwyg')
  )
    return null
  const exact = deps.snapshotExactMarkdown()
  const rendered = outer.getValue()
  if (
    !verifySource(exact, rendered, editor) ||
    !Number.isSafeInteger(sourceStart) ||
    !Number.isSafeInteger(sourceEnd) ||
    sourceStart < 0 ||
    sourceEnd > exact.length
  )
    return null
  const metadata = describeBlockAt(exact, sourceStart, sourceStart)
  if (
    !metadata ||
    metadata.span.start !== sourceStart ||
    metadata.span.end > sourceEnd
  )
    return null
  return retainPending({
    outer,
    inner,
    editor,
    mode,
    exact,
    rendered,
    anchor: sourceStart,
    focus: sourceStart,
    metadata,
  })
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
      bookmark.outer.getValue() === bookmark.rendered &&
      batchOwnershipIsLive(bookmark),
  )
}

export function cancelBlockTransformChoice(token: number): void {
  if (pending?.token === token) pending = null
}

function isFenceLanguageEdit(
  bookmark: BlockBookmark,
  allowed: BlockMetadata['targets'][number] | undefined,
  target: BlockTarget,
): boolean {
  return Boolean(
    allowed?.status === 'noop' &&
      bookmark.metadata.currentType === 'fence' &&
      bookmark.metadata.spans.length === 1 &&
      target.type === 'fence' &&
      typeof target.language === 'string',
  )
}

function sameProposal(
  expected: BlockTransformProposal | undefined,
  actual: BlockTransformProposal | undefined,
): boolean {
  return Boolean(
    expected &&
      actual &&
      expected.markdown === actual.markdown &&
      expected.anchor === actual.anchor &&
      expected.focus === actual.focus &&
      JSON.stringify(expected.losses) === JSON.stringify(actual.losses),
  )
}

function isOwnCheckpoint(
  bookmark: BlockBookmark,
  nativeState: unknown,
): boolean {
  return Boolean(
    lastCheckpoint?.owner === bookmark.inner &&
      lastCheckpoint.mode === bookmark.mode &&
      lastCheckpoint.exact === bookmark.exact &&
      lastCheckpoint.rendered === bookmark.rendered &&
      lastCheckpoint.nativeState === nativeState,
  )
}

function prepareChoice(
  win: Window,
  token: number,
  target: BlockTarget,
  confirmed: boolean,
): {
  bookmark: BlockBookmark
  result: { markdown: string; anchor: number; focus: number }
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
  const languageEdit = isFenceLanguageEdit(bookmark, allowed, target)
  if (
    allowed?.status !== 'changed' &&
    allowed?.status !== 'confirm-required' &&
    !languageEdit
  )
    return null
  const result = planForBookmark(bookmark, target)
  if (
    (languageEdit
      ? result.status !== 'changed'
      : result.status !== allowed?.status) ||
    !revalidate(bookmark, win)
  )
    return null
  if (bookmark.mode === 'sv' && bookmark.editor.textContent !== bookmark.exact)
    return null
  if (result.status === 'changed') return { bookmark, result }
  if (!confirmed || !result.proposal || !riskyFenceProof(bookmark, target))
    return null
  if (!sameProposal(bookmark.proposals[target.type], result.proposal))
    return null
  return { bookmark, result: result.proposal }
}

function recordBlockHistory(
  bookmark: BlockBookmark,
  afterExact: string,
  afterRendered: string,
): void {
  const native = (bookmark.inner.undo as any)?.[bookmark.mode]?.undoStack?.at(
    -1,
  )
  if (!native) {
    lastCheckpoint = null
    return
  }
  recordRewrapDocumentHistory({
    owner: bookmark.inner,
    mode: bookmark.mode,
    nativeState: native,
    beforeRendered: bookmark.rendered,
    beforeExact: bookmark.exact,
    afterRendered,
    afterExact,
  })
  lastCheckpoint = {
    owner: bookmark.inner,
    mode: bookmark.mode,
    exact: afterExact,
    rendered: afterRendered,
    nativeState: native,
  }
}

/** Apply only the retained request and one currently allowed source target. */
export function applyBlockTransformChoice(
  win: Window,
  token: number,
  target: BlockTarget,
  confirmed = false,
): boolean {
  const prepared = prepareChoice(win, token, target, confirmed)
  if (!prepared) return false
  const { bookmark, result } = prepared
  const scrollTop = findScroller(bookmark.editor).scrollTop
  const undoSnapshot = snapshotTableUndoForRollback(bookmark.inner)
  const generation = ++transactionGeneration
  deps!.setApplying(true)
  let afterRendered = bookmark.rendered
  try {
    const nativeBefore = (bookmark.inner.undo as any)?.[
      bookmark.mode
    ]?.undoStack?.at(-1)
    // The prior Task 298 transaction already checkpointed these exact bytes. A
    // second pre-checkpoint after only caret movement records a duplicate patch,
    // which makes one Ctrl+Z consume a state without changing the document.
    if (!isOwnCheckpoint(bookmark, nativeBefore))
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
    recordBlockHistory(bookmark, result.markdown, afterRendered)
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
    lastCheckpoint = null
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
