import {
  rewrapMarkdownDocument,
  rewrapMarkdownRange,
  type RewrapResult,
} from './rewrap-markdown'
import { requestCaret } from './caret'
import { checkpointOrCoalesceUndo } from './undo-boundaries'
import { restoreEditorCaretIfLost, trackedEditorRange } from './editor-caret'
import { findScroller } from '../chrome/toolbar-scroll-guard'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { activeModeElement } from '../util/source-map'
import { guardComposition } from '../util/caret-gesture'
import {
  shiftMarkdownHeadingLevels,
  type HeadingLevelShiftInput,
} from '../nav/section-range'
import {
  sameSourceBlockIndexKey,
  type SourceBlockIndexHandle,
  type SourceBlockIndexKey,
} from '../nav/source-block-index'
import { proveSelectionSource } from './selection-source-proof'
import {
  tableSourceSelectionFromDom,
  type DomSelectionInput,
  type SourceSelection,
} from './table-source-selection'

export type { SourceSelection } from './table-source-selection'

interface RewrapTransactionDeps {
  checkpointUndo: () => void
  applyMarkdown: (
    markdownWithCaret: string,
    caretMarker: string,
    result: RewrapResult,
  ) => boolean
  readScroll: () => number
  restoreScroll: (scrollTop: number) => void
  sync: (markdown: string) => void
}

const SOURCE_START_BASE = '\uE100VMDE_REWRAP_START'
const SOURCE_END_BASE = '\uE101VMDE_REWRAP_END'
const RENDER_CARET_BASE = '\uE102VMDE_REWRAP_RENDER_CARET'

interface RewrapCommandDeps {
  column: number | undefined
  setApplying: (applying: boolean) => void
  invalidate: () => void
  scheduleSync: () => void
  /** `hostBefore` (Task 607): the text the host sent for this command, which the exact post names
   * as `before`; absent when the command planned on the webview's own source. */
  syncExact: (
    markdown: string,
    undoMarkdown: string,
    undoRenderedMarkdown: string,
    hostBefore?: string,
  ) => void
  onError: (error: unknown) => void
}

export type RewrapScope = 'selection' | 'document'

interface RewrapDocumentHistory {
  owner: InnerVditor
  mode: string
  nativeState: unknown
  beforeRendered: string
  beforeExact: string
  afterRendered: string
  afterExact: string
  side: 'before' | 'after'
}

const rewrapDocumentHistory: RewrapDocumentHistory[] = []

export function recordRewrapDocumentHistory(
  history: Omit<RewrapDocumentHistory, 'side'>,
): void {
  rewrapDocumentHistory.push({ ...history, side: 'after' })
  if (rewrapDocumentHistory.length > 50) rewrapDocumentHistory.shift()
}

export function hasRewrapDocumentHistoryTransition(
  inner: InnerVditor,
): boolean {
  const mode = inner.currentMode
  const native = (inner.undo as any)?.[mode ?? '']
  if (!mode || !native) return false
  return rewrapDocumentHistory.some(
    (history) =>
      history.owner === inner &&
      history.mode === mode &&
      (history.side === 'after'
        ? native.redoStack?.at(-1) === history.nativeState
        : native.undoStack?.at(-1) === history.nativeState),
  )
}

export function takeRewrapDocumentHistorySync(
  inner: InnerVditor,
  markdown: string,
): string | undefined {
  return takeRewrapDocumentHistoryReplay(inner, markdown)?.exact
}

/** Task 607: the exact bytes a native Undo/Redo replays, and the record's other side, which is
 * what the host holds before the replay (`afterExact` for Undo, `beforeExact` for Redo). */
export function takeRewrapDocumentHistoryReplay(
  inner: InnerVditor,
  markdown: string,
): { exact: string; before: string } | undefined {
  const mode = inner.currentMode
  const native = (inner.undo as any)?.[mode ?? '']
  for (let index = rewrapDocumentHistory.length - 1; index >= 0; index--) {
    const history = rewrapDocumentHistory[index]
    if (history.owner !== inner || history.mode !== mode || !native) continue
    if (
      history.side === 'after' &&
      native.redoStack?.at(-1) === history.nativeState &&
      markdown === history.beforeRendered
    ) {
      history.side = 'before'
      return { exact: history.beforeExact, before: history.afterExact }
    }
    if (
      history.side === 'before' &&
      native.undoStack?.at(-1) === history.nativeState &&
      markdown === history.afterRendered
    ) {
      history.side = 'after'
      return { exact: history.afterExact, before: history.beforeExact }
    }
  }
  return undefined
}

function uniqueMarker(source: string, base: string): string {
  let marker = base
  while (source.includes(marker)) marker += '_'
  return marker
}

interface OffsetLine {
  text: string
  start: number
  endWithBreak: number
}

function offsetLines(markdown: string): OffsetLine[] {
  const lines: OffsetLine[] = []
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/gu
  for (;;) {
    const match = pattern.exec(markdown)
    if (!match || match[0] === '') break
    lines.push({
      text: match[1],
      start: match.index,
      endWithBreak: match.index + match[0].length,
    })
    if (!match[2]) break
  }
  return lines
}

function matchingLine(
  sourceLines: OffsetLine[],
  sourceIndex: number,
  targetLines: OffsetLine[],
): OffsetLine | undefined {
  const text = sourceLines[sourceIndex]?.text
  if (!text) return undefined
  const ordinal = sourceLines
    .slice(0, sourceIndex + 1)
    .filter((line) => line.text === text).length
  return targetLines.filter((line) => line.text === text)[ordinal - 1]
}

export function mapCaretOffsetByLine(
  canonical: string,
  authoritative: string,
  caretOffset: number,
): number | null {
  if (canonical === authoritative) return caretOffset
  if (
    caretOffset === canonical.length &&
    /[\r\n]$/u.test(canonical) &&
    /[\r\n]$/u.test(authoritative)
  ) {
    return authoritative.length
  }
  const sourceLines = offsetLines(canonical)
  const targetLines = offsetLines(authoritative)
  const index = sourceLines.findIndex(
    (line, lineIndex) =>
      caretOffset >= line.start &&
      (caretOffset < line.endWithBreak || lineIndex === sourceLines.length - 1),
  )
  const sourceLine = sourceLines[index]
  if (!sourceLine) return null
  const targetLine = matchingLine(sourceLines, index, targetLines)
  if (targetLine) {
    return (
      targetLine.start +
      Math.min(caretOffset - sourceLine.start, targetLine.text.length)
    )
  }
  let next = index + 1
  while (next < sourceLines.length && !sourceLines[next].text) next++
  const targetNext = matchingLine(sourceLines, next, targetLines)
  if (targetNext) {
    return Math.max(
      0,
      targetNext.start - (sourceLines[next].start - caretOffset),
    )
  }
  let previous = index - 1
  while (previous >= 0 && !sourceLines[previous].text) previous--
  const targetPrevious = matchingLine(sourceLines, previous, targetLines)
  return targetPrevious
    ? Math.min(
        authoritative.length,
        targetPrevious.endWithBreak +
          (caretOffset - sourceLines[previous].endWithBreak),
      )
    : Math.min(caretOffset, authoritative.length)
}

/** Map an insertion point captured over the rendered bytes onto the host-exact bytes. Line mapping
 * alone guesses at a missing line, so the proof is that the text on both sides of the point, up to
 * the line breaks, reads the same in both. */
export function mapOffsetToExact(
  rendered: string,
  exact: string,
  offset: number,
): number | null {
  const mapped = mapCaretOffsetByLine(rendered, exact, offset)
  if (mapped === null || mapped < 0 || mapped > exact.length) return null
  const lineBounds = (text: string, at: number): [number, number] => {
    const start = Math.max(
      text.lastIndexOf('\n', at - 1),
      text.lastIndexOf('\r', at - 1),
    )
    const after = text.slice(at).search(/[\r\n]/u)
    return [start + 1, after < 0 ? text.length : at + after]
  }
  const [renderedStart, renderedEnd] = lineBounds(rendered, offset)
  const [exactStart, exactEnd] = lineBounds(exact, mapped)
  return rendered.slice(renderedStart, offset) ===
    exact.slice(exactStart, mapped) &&
    rendered.slice(offset, renderedEnd) === exact.slice(mapped, exactEnd)
    ? mapped
    : null
}

/** True when two renderings of one document are equal up to line endings and trailing breaks. */
export function sameRenderedText(a: string, b: string): boolean {
  const normalize = (text: string) =>
    text.replace(/\r\n|\r/gu, '\n').replace(/\n[\t ]*(?:\n[\t ]*)*$/u, '')
  return normalize(a) === normalize(b)
}

function removeMarkerNode(node: Text): void {
  node.remove()
}

/**
 * Map a live DOM Range to Markdown offsets by inserting collision-free text markers through the
 * same mode serializer production uses. Removing the marker nodes restores byte-identical HTML;
 * deliberately do not normalize adjacent text nodes because the saved Range may still point into
 * one of them and the editor's next normal spin will normalize its own DOM.
 */
function markerSourceSelectionFromDom(
  input: DomSelectionInput,
): SourceSelection | null {
  const { editor, range, serialize } = input
  if (
    !editor.contains(range.startContainer) ||
    !editor.contains(range.endContainer)
  ) {
    return null
  }
  const source = editor.textContent ?? ''
  const startMarker = uniqueMarker(source, SOURCE_START_BASE)
  const endMarker = uniqueMarker(source + startMarker, SOURCE_END_BASE)
  const collapsed = range.collapsed
  const endNode = document.createTextNode(endMarker)
  const startNode = document.createTextNode(startMarker)
  try {
    if (!collapsed) {
      const endRange = range.cloneRange()
      endRange.collapse(false)
      endRange.insertNode(endNode)
    }
    const startRange = range.cloneRange()
    startRange.collapse(true)
    startRange.insertNode(startNode)
    const marked = serialize(editor.innerHTML)
    const startOffset = marked.indexOf(startMarker)
    if (startOffset < 0) return null
    const markedWithoutStart =
      marked.slice(0, startOffset) +
      marked.slice(startOffset + startMarker.length)
    if (collapsed) {
      return {
        markdown: markedWithoutStart,
        startOffset,
        endOffset: startOffset,
        caretOffset: startOffset,
      }
    }
    const endOffset = markedWithoutStart.indexOf(endMarker)
    if (endOffset < startOffset) return null
    return {
      markdown:
        markedWithoutStart.slice(0, endOffset) +
        markedWithoutStart.slice(endOffset + endMarker.length),
      startOffset,
      endOffset,
      caretOffset: endOffset,
    }
  } finally {
    removeMarkerNode(startNode)
    removeMarkerNode(endNode)
  }
}

export function sourceSelectionFromDom(
  input: DomSelectionInput,
): SourceSelection | null {
  const table = tableSourceSelectionFromDom(input, markerSourceSelectionFromDom)
  return table === undefined ? markerSourceSelectionFromDom(input) : table
}

export function applyRewrapTransaction(
  selection: SourceSelection,
  column: number,
  deps: RewrapTransactionDeps,
  scope: RewrapScope = 'selection',
): boolean {
  const result =
    scope === 'document'
      ? rewrapMarkdownDocument(
          selection.markdown,
          selection.caretOffset,
          column,
        )
      : rewrapMarkdownRange(
          selection.markdown,
          selection.startOffset,
          selection.endOffset,
          selection.caretOffset,
          column,
        )
  if (!result.changed) return false

  const marker = uniqueMarker(result.markdown, RENDER_CARET_BASE)
  const markedMarkdown =
    result.markdown.slice(0, result.caretOffset) +
    marker +
    result.markdown.slice(result.caretOffset)
  const scrollTop = deps.readScroll()
  deps.checkpointUndo()
  const applyResult = deps.applyMarkdown(markedMarkdown, marker, result)
  if (!applyResult) {
    deps.restoreScroll(scrollTop)
    return false
  }
  deps.checkpointUndo()
  deps.restoreScroll(scrollTop)
  deps.sync(result.markdown)
  return true
}

function serializeForMode(inner: InnerVditor, html: string): string {
  if (inner.currentMode === 'ir') {
    return inner.lute?.VditorIRDOM2Md(html) ?? ''
  }
  if (inner.currentMode === 'wysiwyg') {
    return inner.lute?.VditorDOM2Md(html) ?? ''
  }
  const clone = document.createElement('div')
  clone.innerHTML = html
  return clone.textContent ?? ''
}

interface CaptureRewrapSourceSelectionOptions {
  requireExactMarkdown?: boolean
  authoritativeMarkdown?: string
}

/** Map an already retained editor Range through the production serializer. Commands that retain a
 * selection while toolbar focus moves use this instead of reconstructing offsets from DOM text. */
export function captureRewrapSourceRange(
  win: Window,
  range: Range,
  options: CaptureRewrapSourceSelectionOptions = {},
): SourceSelection | null {
  const vditor = win.vditor
  const inner = innerVditor()
  const editor = vditor ? activeModeElement(vditor) : null
  if (!vditor || !inner || !editor) return null
  const authoritative =
    options.authoritativeMarkdown !== undefined
      ? options.authoritativeMarkdown
      : vditor.getValue()
  const mapped = sourceSelectionFromDom({
    editor,
    range,
    serialize: (html) => serializeForMode(inner, html),
    canonicalMarkdown: authoritative,
  })
  if (!mapped || options.requireExactMarkdown === false) return mapped
  return mapped.markdown === authoritative ? mapped : null
}

/** Task 606: the exact/rendered source Rewrap proves a target against (the shape
 * `bindBlockTransformSource` takes), bound once by `boot/finish-init.ts`. */
interface RewrapSource {
  index: SourceBlockIndexHandle
  snapshotPair(): { exact: string | null; rendered: string }
}

let boundSource: RewrapSource | undefined

/** Bind the shared source authority independently of command configuration and editor lifetime. */
export function bindRewrapSource(source: RewrapSource): () => void {
  boundSource = source
  return () => {
    if (boundSource === source) boundSource = undefined
  }
}

/** The index key and the rendering a capture was made under; a document Rewrap re-checks the key
 * at run time, and the history record names the rendering (no extra full serialization). */
const capturedKeys = new WeakMap<
  SourceSelection,
  { key: SourceBlockIndexKey; rendered: string; proven: boolean }
>()

function isProvenMode(inner: InnerVditor): boolean {
  return inner.currentMode === 'ir' || inner.currentMode === 'wysiwyg'
}

/** The bound source while it has a cacheable key; `null` declines (proof-only, no fallback). */
function proofSourceFor(inner: InnerVditor): RewrapSource | null {
  return isProvenMode(inner) && boundSource?.index.currentKey()
    ? boundSource
    : null
}

function liveRange(win: Window): Range | null {
  const restored = restoreEditorCaretIfLost()
  const selection = win.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  return restored ? trackedEditorRange() : selection.getRangeAt(0)
}

/** Task 606: map the live Range through the Task 604 proof, without live markers. A proven
 * non-round-trip selection may span units: the proof only returns when the document's rendered
 * spans pair with the exact source one-to-one, so every unit between the endpoints has an exact
 * span. The legacy marker capture is allowed only for an unprovable endpoint on a round-trip
 * document, and then against the exact snapshot (never `getValue()`). */
function captureProvenSelection(win: Window): SourceSelection | null {
  const vditor = win.vditor
  const inner = innerVditor()
  const editor = vditor ? activeModeElement(vditor) : null
  if (!vditor || !inner || !editor) return null
  const source = proofSourceFor(inner)
  if (!source) return null
  const range = liveRange(win)
  if (!range) return null
  // Exact-history Undo temporarily revokes source authority until the delayed input settles.
  if (hasRewrapDocumentHistoryTransition(inner)) return null
  const proof = proveSelectionSource(source, editor, range)
  if (proof.status === 'proven') {
    const selection: SourceSelection = {
      markdown: proof.exact,
      startOffset: proof.start.exact,
      endOffset: proof.end.exact,
      caretOffset: proof.end.exact,
    }
    capturedKeys.set(selection, {
      key: proof.key,
      rendered: proof.rendered,
      proven: true,
    })
    return selection
  }
  if (proof.status !== 'unprovable' || !proof.roundTrip) return null
  const pair = source.snapshotPair()
  const exact = pair.exact
  if (exact === null) return null
  const legacy = captureRewrapSourceRange(win, range, {
    authoritativeMarkdown: exact,
  })
  // The markers invalidate the index; the key after them is the baseline a run checks.
  const key = legacy ? source.index.currentKey() : null
  if (legacy && key)
    capturedKeys.set(legacy, {
      key,
      rendered: pair.rendered,
      proven: false,
    })
  return legacy
}

function captureLegacySelection(
  win: Window,
  options: CaptureRewrapSourceSelectionOptions,
): SourceSelection | null {
  const range = liveRange(win)
  return range ? captureRewrapSourceRange(win, range, options) : null
}

/** Capture the live selection with the marker mapping. Details, links, anchors, emoji, math and
 * Turn Into read it; Rewrap and heading shift use the proof capture instead. */
export function captureRewrapSourceSelection(
  win: Window,
  options: CaptureRewrapSourceSelectionOptions = {},
): SourceSelection | null {
  return captureLegacySelection(win, options)
}

/** Task 606: the Rewrap capture in IR and WYSIWYG, by the Task 604 proof (a marker capture only for
 * an unprovable endpoint on a round-trip document, against the exact snapshot). */
export function captureProvenRewrapSelection(
  win: Window,
): SourceSelection | null {
  return captureProvenSelection(win)
}

export function cancelPendingUndoSnapshot(inner: InnerVditor): void {
  const mode = inner.currentMode
  const owner =
    mode === 'wysiwyg' ? inner.wysiwyg : mode === 'ir' ? inner.ir : inner.sv
  const timeout =
    mode === 'wysiwyg'
      ? inner.wysiwyg?.afterRenderTimeoutId
      : mode === 'ir'
        ? inner.ir?.processTimeoutId
        : inner.sv?.processTimeoutId
  if (timeout !== undefined) window.clearTimeout(timeout)
  // Task 601: retire the cancelled callback too, so an Undo cannot drain the snapshot this exact
  // transaction just cancelled (and publish Vditor's rendering over its exact bytes).
  if (owner) owner.vmdeAfterRender = undefined
}

let restoreDelayedUndoSnapshots: (() => void) | undefined

export function suppressDelayedUndoSnapshots(inner: InnerVditor): void {
  restoreDelayedUndoSnapshots?.()
  const undo = inner.undo
  const addToUndoStack = undo?.addToUndoStack
  if (!undo || !addToUndoStack) return
  const blocked = () => undefined
  let timer = 0
  const restore = (event?: Event) => {
    if (event instanceof KeyboardEvent && guardComposition(event)) return
    if (undo.addToUndoStack === blocked) undo.addToUndoStack = addToUndoStack
    window.clearTimeout(timer)
    for (const event of ['beforeinput', 'click', 'keydown']) {
      document.removeEventListener(event, restore, true)
    }
    if (restoreDelayedUndoSnapshots === restore) {
      restoreDelayedUndoSnapshots = undefined
    }
  }
  undo.addToUndoStack = blocked
  for (const event of ['beforeinput', 'click', 'keydown']) {
    document.addEventListener(event, restore, { capture: true, once: true })
  }
  timer = window.setTimeout(restore, (inner.options?.undoDelay ?? 800) + 50)
  restoreDelayedUndoSnapshots = restore
}

export function checkpointEditorUndo(inner: InnerVditor): void {
  restoreDelayedUndoSnapshots?.()
  cancelPendingUndoSnapshot(inner)
  inner.undo?.addToUndoStack?.(inner)
}

/** Task 611 — `checkpointEditorUndo` for a pre-checkpoint: a live state that differs from the
 * last checkpoint only in the caret rewrites the top entry in place instead of adding one (see
 * `checkpointOrCoalesceUndo`). A pending text edit is still flushed as its own entry.
 * `sourceUnchanged`: the caller proved the source has not changed since that checkpoint. */
export function checkpointEditorUndoCoalescing(
  inner: InnerVditor,
  sourceUnchanged = false,
): void {
  restoreDelayedUndoSnapshots?.()
  cancelPendingUndoSnapshot(inner)
  checkpointOrCoalesceUndo(inner, { sourceUnchanged })
}

function removeRenderedCaret(
  editor: HTMLElement,
  marker: string,
): number | null {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let textOffset = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    const offset = text.data.indexOf(marker)
    if (offset < 0) {
      textOffset += text.data.length
      continue
    }
    textOffset += offset
    text.data =
      text.data.slice(0, offset) + text.data.slice(offset + marker.length)
    editor.focus({ preventScroll: true })
    requestCaret({ textOffset })
    return textOffset
  }
  return null
}

function textPointAt(
  root: HTMLElement,
  sourceOffset: number,
): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = sourceOffset
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

export function replaceSvMarkdownRange(
  editor: HTMLElement,
  before: string,
  result: Pick<RewrapResult, 'markdown' | 'caretOffset'>,
): boolean {
  if (editor.textContent !== before) return false
  let start = 0
  while (
    start < before.length &&
    start < result.markdown.length &&
    before[start] === result.markdown[start]
  ) {
    start++
  }
  let suffix = 0
  while (
    suffix < before.length - start &&
    suffix < result.markdown.length - start &&
    before[before.length - 1 - suffix] ===
      result.markdown[result.markdown.length - 1 - suffix]
  ) {
    suffix++
  }
  const end = before.length - suffix
  const replacement = result.markdown.slice(
    start,
    result.markdown.length - suffix,
  )
  const startPoint = textPointAt(editor, start)
  const endPoint = textPointAt(editor, end)
  if (!startPoint || !endPoint) return false
  const range = document.createRange()
  range.setStart(startPoint.node, startPoint.offset)
  range.setEnd(endPoint.node, endPoint.offset)
  range.deleteContents()
  range.insertNode(document.createTextNode(replacement))
  editor.normalize()
  if (editor.textContent !== result.markdown) return false
  const caret = textPointAt(editor, result.caretOffset)
  return caret ? requestCaret(caret) : false
}

function applySvDocumentOrSelection(
  vditor: NonNullable<Window['vditor']>,
  inner: InnerVditor,
  editor: HTMLElement,
  selection: SourceSelection,
  documentScope: boolean,
  result: Pick<RewrapResult, 'markdown' | 'caretOffset'>,
): boolean {
  const before = documentScope ? (editor.textContent ?? '') : selection.markdown
  if (replaceSvMarkdownRange(editor, before, result)) return true
  vditor.setValue(selection.markdown)
  cancelPendingUndoSnapshot(inner)
  return false
}

function applyRenderedMarkdown(
  vditor: NonNullable<Window['vditor']>,
  inner: InnerVditor,
  editor: HTMLElement,
  selection: SourceSelection,
  scope: RewrapScope,
  deps: RewrapCommandDeps,
  markedMarkdown: string,
  marker: string,
  result: Pick<RewrapResult, 'markdown' | 'caretOffset'>,
): boolean {
  const documentScope = scope === 'document'
  deps.setApplying(true)
  try {
    if (inner.currentMode === 'sv') {
      return applySvDocumentOrSelection(
        vditor,
        inner,
        editor,
        selection,
        documentScope,
        result,
      )
    }
    vditor.setValue(markedMarkdown)
    const fresh = activeModeElement(vditor)
    const caret = fresh ? removeRenderedCaret(fresh, marker) : null
    if (caret !== null) {
      if (documentScope) {
        window.requestAnimationFrame(() => requestCaret({ textOffset: caret }))
      }
      return true
    }
    vditor.setValue(selection.markdown)
    cancelPendingUndoSnapshot(inner)
    return false
  } finally {
    deps.setApplying(false)
  }
}

interface RewrapTarget {
  selection: SourceSelection
  /** The host-sent text the exact post names as `before`; absent when planned on the source. */
  hostBefore: string | undefined
  /** The rendering the capture proved against; absent in SV, which reads `getValue()`. */
  rendered?: string
}

/** Document scope in every mode keeps the line-based caret mapping onto the host text (Task 606
 * leaves Rewrap Document as it was; the proof extension for it is Task 670). */
function documentTarget(
  win: Window,
  authoritativeMarkdown: string | undefined,
  capturedSelection: SourceSelection | null | undefined,
): RewrapTarget | null {
  const mapped =
    capturedSelection === undefined
      ? captureLegacySelection(win, { requireExactMarkdown: false })
      : capturedSelection
  if (!mapped) return null
  if (authoritativeMarkdown === undefined)
    return { selection: mapped, hostBefore: undefined }
  const caretOffset = mapCaretOffsetByLine(
    mapped.markdown,
    authoritativeMarkdown,
    mapped.caretOffset,
  )
  if (caretOffset === null) return null
  return {
    selection: {
      markdown: authoritativeMarkdown,
      startOffset: 0,
      endOffset: authoritativeMarkdown.length,
      caretOffset,
    },
    hostBefore: authoritativeMarkdown,
  }
}

function rewrapTarget(
  win: Window,
  inner: InnerVditor,
  scope: RewrapScope,
  authoritativeMarkdown: string | undefined,
  capturedSelection: SourceSelection | null | undefined,
): RewrapTarget | null {
  if (scope === 'document')
    return documentTarget(win, authoritativeMarkdown, capturedSelection)
  if (!isProvenMode(inner)) {
    const selection = captureLegacySelection(
      win,
      authoritativeMarkdown === undefined ? {} : { authoritativeMarkdown },
    )
    return selection ? { selection, hostBefore: undefined } : null
  }
  // The auto-wrap rendered snapshot is not an authority: the proof decides.
  const selection = captureProvenSelection(win)
  return selection
    ? {
        selection,
        hostBefore: undefined,
        rendered: capturedKeys.get(selection)?.rendered,
      }
    : null
}

function runRewrapCommandForScope(
  win: Window,
  deps: RewrapCommandDeps,
  scope: RewrapScope,
  authoritativeMarkdown?: string,
  capturedSelection?: SourceSelection | null,
): boolean {
  try {
    const vditor = win.vditor
    const inner = innerVditor()
    const editor = vditor ? activeModeElement(vditor) : null
    if (!vditor || !inner || !editor) return false
    const target = rewrapTarget(
      win,
      inner,
      scope,
      authoritativeMarkdown,
      capturedSelection,
    )
    if (!target) return false
    const commandSelection = target.selection
    // SV keeps the plain sync of a selection Rewrap; IR and WYSIWYG end in an exact post.
    const exactSync = scope === 'document' || isProvenMode(inner)
    let renderedBeforeMarkdown: string | undefined
    return applyRewrapTransaction(
      commandSelection,
      deps.column ?? 80,
      {
        checkpointUndo: () => {
          // The first checkpoint precedes the rebuild: the rendering the history record names.
          if (exactSync && renderedBeforeMarkdown === undefined)
            renderedBeforeMarkdown = target.rendered ?? vditor.getValue()
          checkpointEditorUndo(inner)
        },
        readScroll: () => findScroller(editor).scrollTop,
        restoreScroll: (scrollTop) => {
          const fresh = activeModeElement(vditor)
          if (!fresh) return
          const scroller = findScroller(fresh)
          const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
          scroller.scrollTop = Math.min(scrollTop, max)
        },
        applyMarkdown: (markedMarkdown, marker, result) =>
          applyRenderedMarkdown(
            vditor,
            inner,
            editor,
            commandSelection,
            scope,
            deps,
            markedMarkdown,
            marker,
            result,
          ),
        sync: (markdown) => {
          if (exactSync) {
            suppressDelayedUndoSnapshots(inner)
            deps.syncExact(
              markdown,
              commandSelection.markdown,
              renderedBeforeMarkdown ?? '',
              target.hostBefore,
            )
          } else {
            deps.invalidate()
            deps.scheduleSync()
          }
        },
      },
      scope,
    )
  } catch (error) {
    deps.onError(error)
    return false
  }
}

export function runRewrapCommand(
  win: Window,
  deps: RewrapCommandDeps,
  authoritativeMarkdown?: string,
): boolean {
  return runRewrapCommandForScope(win, deps, 'selection', authoritativeMarkdown)
}

export function runRewrapDocumentCommand(
  win: Window,
  deps: RewrapCommandDeps,
  authoritativeMarkdown?: string,
  capturedSelection?: SourceSelection | null,
): boolean {
  return runRewrapCommandForScope(
    win,
    deps,
    'document',
    authoritativeMarkdown,
    capturedSelection,
  )
}

export type HeadingLevelShiftDirection = -1 | 1

function headingClampInfo(direction: HeadingLevelShiftDirection): void {
  try {
    vscode.postMessage({
      command: 'info',
      content:
        direction < 0
          ? 'Heading level cannot be promoted above H1.'
          : 'Heading level cannot be demoted below H6.',
    })
  } catch {
    /* the standalone browser harness has no host message pipe */
  }
}

export function runHeadingLevelShift(
  win: Window,
  deps: RewrapCommandDeps,
  direction: HeadingLevelShiftDirection,
  section = false,
): boolean {
  try {
    const vditor = win.vditor
    const inner = innerVditor()
    const editor = vditor ? activeModeElement(vditor) : null
    if (!vditor || !inner || !editor) return false
    // Task 606: IR and WYSIWYG prove the target (proof-only, like Rewrap); SV keeps its capture.
    const proven = isProvenMode(inner)
    const selection = proven
      ? captureProvenSelection(win)
      : captureLegacySelection(win, {})
    if (!selection) return false
    const input: HeadingLevelShiftInput = {
      markdown: selection.markdown,
      startOffset: selection.startOffset,
      endOffset: selection.endOffset,
      caretOffset: selection.caretOffset,
      direction,
      section,
    }
    const result = shiftMarkdownHeadingLevels(input)
    if (result.status === 'clamped') {
      headingClampInfo(direction)
      return false
    }
    if (result.status !== 'ok') return false

    const marker = uniqueMarker(result.markdown, RENDER_CARET_BASE)
    const markedMarkdown =
      result.markdown.slice(0, result.caretOffset) +
      marker +
      result.markdown.slice(result.caretOffset)
    const scroller = findScroller(editor)
    const scrollTop = scroller.scrollTop
    const renderedBefore = proven
      ? (capturedKeys.get(selection)?.rendered ?? vditor.getValue())
      : ''
    checkpointEditorUndo(inner)
    const applied = applyRenderedMarkdown(
      vditor,
      inner,
      editor,
      selection,
      'selection',
      deps,
      markedMarkdown,
      marker,
      result,
    )
    if (!applied) {
      scroller.scrollTop = scrollTop
      return false
    }
    checkpointEditorUndo(inner)
    const fresh = activeModeElement(vditor)
    if (fresh) findScroller(fresh).scrollTop = scrollTop
    if (proven) {
      // The exact bytes (not the rendering) are what the host receives; one Undo step restores them.
      suppressDelayedUndoSnapshots(inner)
      deps.syncExact(
        result.markdown,
        selection.markdown,
        renderedBefore,
        undefined,
      )
    } else {
      deps.invalidate()
      deps.scheduleSync()
    }
    return true
  } catch (error) {
    deps.onError(error)
    return false
  }
}
