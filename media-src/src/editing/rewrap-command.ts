import {
  rewrapMarkdownDocument,
  rewrapMarkdownRange,
  type RewrapResult,
} from './rewrap-markdown'
import { requestCaret } from './caret'
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
  syncExact: (
    markdown: string,
    undoMarkdown: string,
    undoRenderedMarkdown: string,
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
      return history.beforeExact
    }
    if (
      history.side === 'before' &&
      native.undoStack?.at(-1) === history.nativeState &&
      markdown === history.afterRendered
    ) {
      history.side = 'after'
      return history.afterExact
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

export function captureRewrapSourceSelection(
  win: Window,
  options: CaptureRewrapSourceSelectionOptions = {},
): SourceSelection | null {
  const restored = restoreEditorCaretIfLost()
  const selection = win.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = restored ? trackedEditorRange() : selection.getRangeAt(0)
  if (!range) return null
  return captureRewrapSourceRange(win, range, options)
}

function cancelPendingUndoSnapshot(inner: InnerVditor): void {
  const mode = inner.currentMode
  const timeout =
    mode === 'wysiwyg'
      ? inner.wysiwyg?.afterRenderTimeoutId
      : mode === 'ir'
        ? inner.ir?.processTimeoutId
        : inner.sv?.processTimeoutId
  if (timeout !== undefined) window.clearTimeout(timeout)
}

let restoreDelayedUndoSnapshots: (() => void) | undefined

function suppressDelayedUndoSnapshots(inner: InnerVditor): void {
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

function captureSelectionForMarkdown(
  win: Window,
  authoritativeMarkdown: string | undefined,
): SourceSelection | null {
  return authoritativeMarkdown === undefined
    ? captureRewrapSourceSelection(win)
    : captureRewrapSourceSelection(win, { authoritativeMarkdown })
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
    let commandSelection: SourceSelection
    let renderedBeforeMarkdown: string
    if (scope === 'document' && authoritativeMarkdown !== undefined) {
      const mapped =
        capturedSelection ??
        captureRewrapSourceSelection(win, { requireExactMarkdown: false })
      if (!mapped) return false
      const authoritativeCaret = mapCaretOffsetByLine(
        mapped.markdown,
        authoritativeMarkdown,
        mapped.caretOffset,
      )
      if (authoritativeCaret === null) return false
      commandSelection = {
        markdown: authoritativeMarkdown,
        startOffset: 0,
        endOffset: authoritativeMarkdown.length,
        caretOffset: authoritativeCaret,
      }
      renderedBeforeMarkdown = vditor.getValue()
    } else {
      const selection = captureSelectionForMarkdown(win, authoritativeMarkdown)
      if (!selection) return false
      commandSelection = selection
      renderedBeforeMarkdown = selection.markdown
    }
    return applyRewrapTransaction(
      commandSelection,
      deps.column ?? 80,
      {
        checkpointUndo: () => checkpointEditorUndo(inner),
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
          if (scope === 'document') {
            suppressDelayedUndoSnapshots(inner)
            deps.syncExact(
              markdown,
              commandSelection.markdown,
              renderedBeforeMarkdown,
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

export interface HeadingLevelShiftShortcut {
  direction: HeadingLevelShiftDirection
  section: boolean
}

export function headingLevelShiftShortcut(
  event: Pick<
    KeyboardEvent,
    'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'
  >,
): HeadingLevelShiftShortcut | null {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return null
  if (event.key === '[' || event.key === '{')
    return { direction: -1, section: event.altKey }
  if (event.key === ']' || event.key === '}')
    return { direction: 1, section: event.altKey }
  return null
}

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
    const selection = captureRewrapSourceSelection(win)
    if (!vditor || !inner || !editor || !selection) return false
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
    deps.invalidate()
    deps.scheduleSync()
    return true
  } catch (error) {
    deps.onError(error)
    return false
  }
}

export function setupHeadingLevelShiftKeybind(
  win: Window,
  run: (direction: HeadingLevelShiftDirection, section: boolean) => void,
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (guardComposition(event)) return
    const shortcut = headingLevelShiftShortcut(event)
    if (!shortcut) return
    event.preventDefault()
    event.stopPropagation()
    run(shortcut.direction, shortcut.section)
  }
  win.addEventListener('keydown', onKeyDown, true)
  return () => win.removeEventListener('keydown', onKeyDown, true)
}

export function rewrapShortcut(
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey'>,
): boolean {
  return (
    event.key.toLowerCase() === 'q' &&
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  )
}

export function setupRewrapKeybind(win: Window, run: () => void): void {
  win.addEventListener(
    'keydown',
    (event) => {
      if (guardComposition(event)) return
      if (!rewrapShortcut(event)) return
      event.preventDefault()
      event.stopPropagation()
      run()
    },
    true,
  )
}
