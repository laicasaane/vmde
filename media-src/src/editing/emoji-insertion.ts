import { findScroller } from '../chrome/toolbar-scroll-guard'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { activeModeElement } from '../util/source-map'
import { requestCaret } from './caret'
import {
  cancelPendingUndoSnapshot,
  captureRewrapSourceRange,
  checkpointEditorUndo,
  replaceSvMarkdownRange,
  suppressDelayedUndoSnapshots,
} from './rewrap-command'

export interface EmojiInsertionPlan {
  markdown: string
  caretOffset: number
}

export interface EmojiInsertionBookmark {
  readonly outer: NonNullable<Window['vditor']>
  readonly inner: InnerVditor
  readonly editor: HTMLElement
  readonly mode: string
  readonly generation: number
  readonly session: object
  readonly markdown: string
  readonly renderedMarkdown: string
  readonly sourceMarkdown: string
  readonly startOffset: number
  readonly endOffset: number
  readonly sourceStartOffset: number
  readonly sourceEndOffset: number
}

export interface EmojiInsertionResult {
  status: 'success'
  nextBookmark: EmojiInsertionBookmark
}

interface EmojiInsertionDeps {
  snapshotMarkdown(): string
  session(): object | null
  writable(): boolean
  setApplying(value: boolean): void
  syncExact(after: string, before: string, beforeRendered: string): void
  onError(error: unknown): void
}

interface UndoSavepoint {
  mode: string
  slot: Record<string, unknown>
  undoStack: unknown[] | undefined
  redoStack: unknown[] | undefined
  lastText: unknown
  hasUndo: unknown
}

interface TextPoint {
  node: Text
  offset: number
}

const CARET_MARKER_BASE = '\uE320VMDE_EMOJI_CARET'
const ROLLBACK_START_BASE = '\uE321VMDE_EMOJI_ROLLBACK_START'
const ROLLBACK_END_BASE = '\uE322VMDE_EMOJI_ROLLBACK_END'

let configured: EmojiInsertionDeps | undefined
let generation = 0

export function configureEmojiInsertion(deps: EmojiInsertionDeps): void {
  configured = deps
  generation++
}

export function planEmojiInsertion(
  before: string,
  startOffset: number,
  endOffset: number,
  sequence: string,
): EmojiInsertionPlan | null {
  if (
    !Number.isInteger(startOffset) ||
    !Number.isInteger(endOffset) ||
    startOffset < 0 ||
    endOffset < startOffset ||
    endOffset > before.length ||
    sequence.length === 0
  )
    return null
  return {
    markdown: before.slice(0, startOffset) + sequence + before.slice(endOffset),
    caretOffset: startOffset + sequence.length,
  }
}

function previewIsOpen(outer: NonNullable<Window['vditor']>): boolean {
  return (
    outer.vditor?.toolbar?.elements?.preview?.children[0]?.classList.contains(
      'vditor-menu--current',
    ) === true
  )
}

function endpointIsEditable(editor: HTMLElement, node: Node): boolean {
  if (!editor.contains(node)) return false
  const element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return (
    !element?.closest(
      '[data-render], [contenteditable="false"], .vditor-ir__preview, .vditor-wysiwyg__preview',
    ) && element !== null
  )
}

function edgeEditableText(editor: HTMLElement, last: boolean): Text | null {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let edge: Text | null = null
  for (
    let next = walker.nextNode() as Text | null;
    next;
    next = walker.nextNode() as Text | null
  )
    if (endpointIsEditable(editor, next)) {
      if (!last) return next
      edge = next
    }
  return edge
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one range normalization preserves collapsed root edges and directional selections without widening interior boundaries.
function normalizeEditorEdgeRange(
  editor: HTMLElement,
  range: Range,
): Range | null {
  if (range.collapsed) {
    if (range.startContainer !== editor) return range
    const atStart = range.startOffset === 0
    const atEnd = range.startOffset === editor.childNodes.length
    // A collapsed root boundary is not serializable as authored text. Vditor can leave this
    // caret after a document recreate, so bind it to the matching editable text edge instead.
    if (!atStart && !atEnd) return range
    const edge = edgeEditableText(editor, atEnd)
    if (!edge) return null
    const normalized = range.cloneRange()
    normalized.setStart(edge, atEnd ? edge.data.length : 0)
    normalized.collapse(true)
    return normalized
  }
  const normalized = range.cloneRange()
  if (range.startContainer === editor && range.startOffset === 0) {
    const first = edgeEditableText(editor, false)
    if (!first) return null
    normalized.setStart(first, 0)
  }
  if (
    range.endContainer === editor &&
    range.endOffset === editor.childNodes.length
  ) {
    const last = edgeEditableText(editor, true)
    if (!last) return null
    normalized.setEnd(last, last.data.length)
  }
  return normalized
}

export function mapEmojiSourceOffsets(
  rendered: string,
  exact: string,
  startOffset: number,
  endOffset: number,
): { startOffset: number; endOffset: number } | null {
  if (rendered === exact) return { startOffset, endOffset }
  if (exact.replaceAll('\r\n', '\n') === rendered) {
    const mapNormalizedOffset = (offset: number) => {
      let exactOffset = 0
      for (let renderedOffset = 0; renderedOffset < offset; renderedOffset++) {
        // Count only newline bytes that actually expand from LF to CRLF. A document can mix
        // endings, so adding every rendered newline shifts selections after ordinary LF lines.
        exactOffset +=
          rendered[renderedOffset] === '\n' &&
          exact[exactOffset] === '\r' &&
          exact[exactOffset + 1] === '\n'
            ? 2
            : 1
      }
      return exactOffset
    }
    return {
      startOffset: mapNormalizedOffset(startOffset),
      endOffset: mapNormalizedOffset(endOffset),
    }
  }
  // Vditor's SV surface owns one terminal caret newline that is absent from host Markdown.
  if (
    rendered.startsWith(exact) &&
    startOffset <= exact.length &&
    endOffset <= exact.length
  )
    return { startOffset, endOffset }
  if (
    exact.startsWith(rendered) &&
    startOffset <= rendered.length &&
    endOffset <= rendered.length
  )
    return { startOffset, endOffset }
  let prefix = 0
  while (
    prefix < rendered.length &&
    prefix < exact.length &&
    rendered[prefix] === exact[prefix]
  )
    prefix++
  if (endOffset <= prefix) return { startOffset, endOffset }
  let suffix = 0
  while (
    suffix < rendered.length - prefix &&
    suffix < exact.length - prefix &&
    rendered[rendered.length - 1 - suffix] === exact[exact.length - 1 - suffix]
  )
    suffix++
  const renderedSuffixStart = rendered.length - suffix
  if (startOffset >= renderedSuffixStart) {
    const shift = exact.length - rendered.length
    return {
      startOffset: startOffset + shift,
      endOffset: endOffset + shift,
    }
  }
  return null
}

export function captureEmojiInsertion(
  range: Range,
): EmojiInsertionBookmark | null {
  const deps = configured
  const outer = window.vditor
  const inner = innerVditor()
  const editor = outer ? activeModeElement(outer) : null
  const mode = inner?.currentMode
  const session = deps?.session()
  const sourceRange = editor ? normalizeEditorEdgeRange(editor, range) : range
  if (
    !deps ||
    !outer ||
    !inner ||
    !editor ||
    !mode ||
    !session ||
    !sourceRange ||
    previewIsOpen(outer) ||
    !deps.writable() ||
    !endpointIsEditable(editor, sourceRange.startContainer) ||
    !endpointIsEditable(editor, sourceRange.endContainer)
  )
    return null
  const markdown = deps.snapshotMarkdown()
  const renderedMarkdown = outer.getValue()
  const mapped = captureRewrapSourceRange(window, sourceRange, {
    authoritativeMarkdown: renderedMarkdown,
  })
  if (!mapped) return null
  const exactOffsets = mapEmojiSourceOffsets(
    renderedMarkdown,
    markdown,
    mapped.startOffset,
    mapped.endOffset,
  )
  if (!exactOffsets) return null
  return {
    outer,
    inner,
    editor,
    mode,
    generation,
    session,
    markdown,
    renderedMarkdown,
    sourceMarkdown: mapped.markdown,
    ...exactOffsets,
    sourceStartOffset: mapped.startOffset,
    sourceEndOffset: mapped.endOffset,
  }
}

function saveUndo(inner: InnerVditor): UndoSavepoint | null {
  const mode = inner.currentMode
  const slot = mode
    ? (inner.undo as Record<string, unknown> | undefined)?.[mode]
    : null
  if (!mode || !slot || typeof slot !== 'object') return null
  const state = slot as Record<string, unknown>
  return {
    mode,
    slot: state,
    undoStack: Array.isArray(state.undoStack)
      ? [...state.undoStack]
      : undefined,
    redoStack: Array.isArray(state.redoStack)
      ? [...state.redoStack]
      : undefined,
    lastText: state.lastText,
    hasUndo: state.hasUndo,
  }
}

function restoreUndo(
  inner: InnerVditor,
  savepoint: UndoSavepoint | null,
): void {
  if (
    !savepoint ||
    inner.currentMode !== savepoint.mode ||
    (inner.undo as Record<string, unknown> | undefined)?.[savepoint.mode] !==
      savepoint.slot
  )
    return
  savepoint.slot.undoStack = savepoint.undoStack
  savepoint.slot.redoStack = savepoint.redoStack
  savepoint.slot.lastText = savepoint.lastText
  savepoint.slot.hasUndo = savepoint.hasUndo
  ;(
    inner.undo as { resetIcon?: (owner: unknown) => void } | undefined
  )?.resetIcon?.(inner)
}

function uniqueMarker(markdown: string, base = CARET_MARKER_BASE): string {
  let marker = base
  while (markdown.includes(marker)) marker += '_'
  return marker
}

function removeRenderedMarker(
  editor: HTMLElement,
  marker: string,
): TextPoint | null {
  const matches: Array<{ node: Text; offset: number; editable: boolean }> = []
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    const node = next as Text
    let offset = node.data.indexOf(marker)
    while (offset >= 0) {
      matches.push({
        node,
        offset,
        editable: endpointIsEditable(editor, node),
      })
      offset = node.data.indexOf(marker, offset + marker.length)
    }
  }
  const editable = matches.filter((match) => match.editable)
  if (editable.length !== 1) return null
  for (const match of [...matches].reverse())
    match.node.deleteData(match.offset, marker.length)
  return { node: editable[0].node, offset: editable[0].offset }
}

function revealSource(point: TextPoint, mode: string): void {
  if (mode === 'wysiwyg') {
    const source = point.node.parentElement?.closest<HTMLElement>(
      'pre.vditor-wysiwyg__pre',
    )
    if (source) source.style.display = 'block'
  } else if (mode === 'ir') {
    point.node.parentElement
      ?.closest<HTMLElement>('.vditor-ir__node')
      ?.classList.add('vditor-ir__node--expand')
  }
}

function setCaret(point: TextPoint): boolean {
  if (!point.node.isConnected || point.offset > point.node.data.length)
    return false
  const selection = document.getSelection()
  if (!selection) return false
  const range = document.createRange()
  range.setStart(point.node, point.offset)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

function rollback(
  bookmark: EmojiInsertionBookmark,
  savepoint: UndoSavepoint | null,
  scrollTop: number,
): void {
  try {
    const startMarker = uniqueMarker(bookmark.markdown, ROLLBACK_START_BASE)
    const endMarker = uniqueMarker(
      `${bookmark.markdown}${startMarker}`,
      ROLLBACK_END_BASE,
    )
    const marked =
      bookmark.markdown.slice(0, bookmark.startOffset) +
      startMarker +
      bookmark.markdown.slice(bookmark.startOffset, bookmark.endOffset) +
      endMarker +
      bookmark.markdown.slice(bookmark.endOffset)
    bookmark.outer.setValue(marked)
    const restored = activeModeElement(bookmark.outer)
    if (restored) {
      const end = removeRenderedMarker(restored, endMarker)
      const start = removeRenderedMarker(restored, startMarker)
      if (start && end) {
        if (start.node === end.node && start.offset <= end.offset)
          end.offset -= startMarker.length
        revealSource(start, bookmark.mode)
        const selection = document.getSelection()
        const range = document.createRange()
        range.setStart(start.node, start.offset)
        range.setEnd(end.node, end.offset)
        selection?.removeAllRanges()
        selection?.addRange(range)
      } else bookmark.outer.setValue(bookmark.markdown)
      const scroller = findScroller(restored)
      scroller.scrollTop = Math.min(
        scrollTop,
        Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      )
    }
  } finally {
    cancelPendingUndoSnapshot(bookmark.inner)
    restoreUndo(bookmark.inner, savepoint)
  }
}

function bookmarkIsCurrent(
  bookmark: EmojiInsertionBookmark,
  deps: EmojiInsertionDeps,
): boolean {
  const checks = {
    generation: generation === bookmark.generation,
    outer: window.vditor === bookmark.outer,
    inner: innerVditor() === bookmark.inner,
    connected: bookmark.editor.isConnected,
    editor: activeModeElement(bookmark.outer) === bookmark.editor,
    mode: bookmark.inner.currentMode === bookmark.mode,
    session: deps.session() === bookmark.session,
    writable: deps.writable(),
    preview: !previewIsOpen(bookmark.outer),
    contenteditable:
      bookmark.editor.getAttribute('contenteditable') !== 'false',
    exact: deps.snapshotMarkdown() === bookmark.markdown,
    rendered: bookmark.outer.getValue() === bookmark.renderedMarkdown,
    source:
      bookmark.mode !== 'sv' ||
      bookmark.editor.textContent === bookmark.sourceMarkdown,
  }
  return (
    checks.generation &&
    checks.outer &&
    checks.inner &&
    checks.connected &&
    checks.editor &&
    checks.mode &&
    checks.session &&
    checks.writable &&
    checks.preview &&
    checks.contenteditable &&
    checks.exact &&
    checks.rendered &&
    checks.source
  )
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one atomic transaction owns guards, rollback, history, exact sync, and the successor bookmark.
export function applyEmojiInsertion(
  bookmark: EmojiInsertionBookmark | null,
  sequence: string,
): EmojiInsertionResult | null {
  const deps = configured
  if (!bookmark || !deps || !bookmarkIsCurrent(bookmark, deps)) return null
  const plan = planEmojiInsertion(
    bookmark.markdown,
    bookmark.startOffset,
    bookmark.endOffset,
    sequence,
  )
  if (!plan) return null
  const sourcePlan =
    bookmark.mode === 'sv'
      ? planEmojiInsertion(
          bookmark.sourceMarkdown,
          bookmark.sourceStartOffset,
          bookmark.sourceEndOffset,
          sequence,
        )
      : plan
  if (!sourcePlan) return null
  const marker = uniqueMarker(`${plan.markdown}${sourcePlan.markdown}`)
  const markedMarkdown =
    sourcePlan.markdown.slice(0, sourcePlan.caretOffset) +
    marker +
    sourcePlan.markdown.slice(sourcePlan.caretOffset)
  const scrollTop = findScroller(bookmark.editor).scrollTop
  let savepoint: UndoSavepoint | null = null
  let transactionComplete = false
  let afterRendered = ''
  let caret: TextPoint | null = null
  deps.setApplying(true)
  try {
    checkpointEditorUndo(bookmark.inner)
    savepoint = saveUndo(bookmark.inner)
    if (!savepoint) return null
    let applied = true
    if (bookmark.mode === 'sv') {
      applied = replaceSvMarkdownRange(
        bookmark.editor,
        bookmark.sourceMarkdown,
        {
          markdown: markedMarkdown,
          caretOffset: sourcePlan.caretOffset,
        },
      )
      if (applied) {
        // SV represents its terminal caret line with structured newline spans. The direct source
        // splice proves the exact range, then this mode-owned render restores that structure so a
        // later exact snapshot cannot mistake authored EOF whitespace for the caret-only suffix.
        bookmark.outer.setValue(markedMarkdown)
      }
    } else bookmark.outer.setValue(markedMarkdown)
    const fresh = activeModeElement(bookmark.outer)
    caret = fresh ? removeRenderedMarker(fresh, marker) : null
    afterRendered = bookmark.outer.getValue()
    if (
      !applied ||
      !fresh ||
      !caret ||
      afterRendered.includes(marker) ||
      !setCaret(caret)
    ) {
      rollback(bookmark, savepoint, scrollTop)
      return null
    }
    revealSource(caret, bookmark.mode)
    fresh.focus({ preventScroll: true })
    setCaret(caret)
    checkpointEditorUndo(bookmark.inner)
    const selection = document.getSelection()
    const postCheckpoint = selection?.rangeCount
      ? selection.getRangeAt(0)
      : null
    if (
      postCheckpoint &&
      postCheckpoint.startContainer instanceof Text &&
      fresh.contains(postCheckpoint.startContainer) &&
      postCheckpoint.collapsed
    )
      caret = {
        node: postCheckpoint.startContainer,
        offset: postCheckpoint.startOffset,
      }
    const scroller = findScroller(fresh)
    scroller.scrollTop = Math.min(
      scrollTop,
      Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    )
    suppressDelayedUndoSnapshots(bookmark.inner)
    transactionComplete = true
  } catch (error) {
    try {
      if (!transactionComplete) rollback(bookmark, savepoint, scrollTop)
    } catch (rollbackError) {
      deps.onError(rollbackError)
    }
    deps.onError(error)
    return null
  } finally {
    deps.setApplying(false)
  }
  if (!transactionComplete || !caret) return null
  generation++
  requestCaret({ node: caret.node, offset: caret.offset })
  try {
    deps.syncExact(plan.markdown, bookmark.markdown, bookmark.renderedMarkdown)
  } catch (error) {
    deps.onError(error)
  }
  return {
    status: 'success',
    nextBookmark: {
      ...bookmark,
      generation,
      markdown: plan.markdown,
      renderedMarkdown: afterRendered,
      sourceMarkdown: sourcePlan.markdown,
      startOffset: plan.caretOffset,
      endOffset: plan.caretOffset,
      sourceStartOffset: sourcePlan.caretOffset,
      sourceEndOffset: sourcePlan.caretOffset,
    },
  }
}

export function invalidateEmojiInsertion(): void {
  generation++
}
