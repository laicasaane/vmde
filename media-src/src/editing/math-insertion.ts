import { activeModeElement } from '../util/source-map'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { isCompositionActive } from '../util/caret-gesture'
import { findScroller } from '../chrome/toolbar-scroll-guard'
import { invalidateCaret, requestCaret } from './caret'
import { mathRender } from 'vditor/src/ts/markdown/mathRender'
import { processCodeRender } from 'vditor/src/ts/util/processCode'
import {
  cancelPendingUndoSnapshot,
  captureRewrapSourceRange,
  checkpointEditorUndo,
  replaceSvMarkdownRange,
} from './rewrap-command'
import { sourceLeafSelection } from './html-subscript-command'
import {
  consumeToolbarSelectionOrigin,
  peekConsumedToolbarSelectionOrigin,
  type ToolbarSelectionOrigin,
} from './escape-toolbar'

const EVENT = 'vmde-insert-github-inline-math'
const FENCED_EVENT = 'vmde-insert-github-fenced-math'
const MARKER_BASE = '\uE310VMDE_MATH_'
const LEAF_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,td,th,li'
const FORBIDDEN_SELECTOR =
  'code,pre,[data-render],[data-type*="code"],[data-type*="math"],[data-type*="html"],.vditor-ir__marker--pre'

function processRebuiltCodePreview(
  preview: HTMLElement,
  inner: InnerVditor,
): void {
  // `innerVditor` intentionally exposes only the internal members VMDE consumes, while its runtime
  // value is Vditor's complete IVditor instance. processCodeRender needs that vendor-only shape.
  processCodeRender(preview, inner as Parameters<typeof processCodeRender>[1])
}

export interface GithubInlineMathPlan {
  markdown: string
  anchor: number
  focus: number
}

export interface GithubFencedMathPlan {
  markdown: string
  caret: number
}

interface FenceContext {
  opening: string
  continuation: string
}

function lineBreakFor(source: string): string {
  return /\r\n|\n|\r/u.exec(source)?.[0] ?? '\n'
}

function lineStartAt(source: string, offset: number): number {
  const index = Math.max(
    source.lastIndexOf('\n', offset - 1),
    source.lastIndexOf('\r', offset - 1),
  )
  return index + 1
}

function lineEndAt(source: string, offset: number): number {
  const nextLf = source.indexOf('\n', offset)
  const nextCr = source.indexOf('\r', offset)
  if (nextLf < 0) return nextCr < 0 ? source.length : nextCr
  return nextCr < 0 ? nextLf : Math.min(nextLf, nextCr)
}

function fenceContext(line: string): FenceContext {
  const match = /^([ \t]*(?:>[ \t]?)*)(?:([-+*]|\d+[.)])([ \t]+))?/u.exec(line)
  const quote = match?.[1] ?? ''
  const marker = match?.[2] ?? ''
  const gap = match?.[3] ?? ''
  return {
    opening: `${quote}${marker}${gap}`,
    continuation: `${quote}${marker ? ' '.repeat(marker.length + gap.length) : ''}`,
  }
}

function longestBacktickRun(source: string): number {
  return Math.max(
    0,
    ...Array.from(source.matchAll(/`+/gu), (match) => match[0].length),
  )
}

function unprefixFenceBody(line: string, context: FenceContext): string | null {
  if (line.startsWith(context.continuation))
    return line.slice(context.continuation.length)
  if (line.startsWith(context.opening))
    return line.slice(context.opening.length)
  // A quoted/container selection may not escape its container while becoming a fence.
  if (context.opening !== '') return null
  return line
}

/** Plan a source-faithful GitHub ```math block, including list/quote continuation prefixes. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: preserves exact source line endings, container prefixes, and caret placement in one atomic planner.
export function planGithubFencedMath(
  markdown: string,
  start: number,
  end: number,
): GithubFencedMathPlan | null {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > markdown.length
  )
    return null
  const lineBreak = lineBreakFor(markdown)
  const lineStart = lineStartAt(markdown, start)
  const lineEnd = lineEndAt(markdown, end)
  const currentLine = markdown.slice(lineStart, lineEnd)
  const context = fenceContext(currentLine)

  if (start === end) {
    const beforeLine = markdown.slice(lineStart, start)
    const afterLine = markdown.slice(end, lineEnd)
    const beforeContent = beforeLine.startsWith(context.opening)
      ? beforeLine.slice(context.opening.length)
      : beforeLine
    const afterContent = afterLine.startsWith(context.opening)
      ? afterLine.slice(context.opening.length)
      : afterLine
    const before = markdown.slice(0, lineStart)
    const head = beforeContent
      ? `${context.opening}${beforeContent}${lineBreak}`
      : ''
    const prefix = beforeContent ? context.continuation : context.opening
    const fence = '```'
    const block = `${prefix}${fence}math${lineBreak}${context.continuation}${lineBreak}${context.continuation}${fence}`
    const tail = afterContent
      ? `${lineBreak}${context.continuation}${afterContent}`
      : ''
    const result = `${before}${head}${block}${tail}${markdown.slice(lineEnd)}`
    return {
      markdown: result,
      caret:
        before.length +
        head.length +
        prefix.length +
        fence.length +
        4 +
        lineBreak.length +
        context.continuation.length,
    }
  }

  const selectedEnd =
    end > start && (markdown[end - 1] === '\n' || markdown[end - 1] === '\r')
      ? Math.max(
          lineStart,
          end -
            (markdown[end - 1] === '\n' && markdown[end - 2] === '\r' ? 2 : 1),
        )
      : lineEnd
  const selected = markdown.slice(lineStart, selectedEnd)
  const body = selected
    .split(/\r\n|\n|\r/gu)
    .map((line) => unprefixFenceBody(line, context))
  if (body.some((line) => line === null)) return null
  const sourceBody = (body as string[]).join(lineBreak)
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(sourceBody) + 1))
  const renderedBody = (body as string[])
    .map((line) => `${context.continuation}${line}`)
    .join(lineBreak)
  const before = markdown.slice(0, lineStart)
  const replacement = `${context.opening}${fence}math${lineBreak}${renderedBody}${lineBreak}${context.continuation}${fence}`
  return {
    markdown: `${before}${replacement}${markdown.slice(selectedEnd)}`,
    caret:
      before.length +
      context.opening.length +
      fence.length +
      4 +
      lineBreak.length +
      context.continuation.length,
  }
}

/** Build the exact four-delimiter source edit; callers map the offsets through Lute. */
export function planGithubInlineMath(
  markdown: string,
  start: number,
  end: number,
): GithubInlineMathPlan | null {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > markdown.length
  )
    return null
  const selected = markdown.slice(start, end)
  if (
    selected.includes('\n') ||
    selected.includes('\r') ||
    selected.includes('`')
  )
    return null
  for (let index = 0; index < selected.length; index++) {
    if (selected[index] !== '$') continue
    let slashes = 0
    for (
      let previous = index - 1;
      previous >= 0 && selected[previous] === '\\';
      previous--
    )
      slashes++
    if (slashes % 2 === 0) return null
  }
  const before = markdown.slice(0, start)
  const after = markdown.slice(end)
  // Backticks/dollars immediately touching the selection are an existing delimiter context.
  if (/[`$]$/u.test(before) || /^[`$]/u.test(after)) return null
  const prefix = '$`'
  return {
    markdown: `${before}${prefix}${selected}\`$${after}`,
    anchor: start + prefix.length,
    focus: start + prefix.length + selected.length,
  }
}

interface MathInsertionDeps {
  setApplying: (applying: boolean) => void
  invalidate: () => void
  scheduleSync: () => void
  snapshotMarkdown?: () => string
  onError: (error: unknown) => void
}

let configured: MathInsertionDeps | undefined

export function configureGithubInlineMathInsertion(
  deps: MathInsertionDeps,
): void {
  configured = deps
}

function previewOpen(): boolean {
  return (
    innerVditor()?.toolbar?.elements?.preview?.children[0]?.classList.contains(
      'vditor-menu--current',
    ) === true
  )
}

interface RetainedRange {
  editor: HTMLElement
  range: Range
  backward: boolean
}

interface TextPoint {
  node: Text
  offset: number
}

interface MathSourceBookmark {
  root: HTMLElement
  text: string
  start: number
  end: number
  backward: boolean
}

interface UndoSavepoint {
  mode: string
  slot: Record<string, unknown>
  undoStack: unknown[] | undefined
  redoStack: unknown[] | undefined
  lastText: unknown
  hasUndo: unknown
}

function saveUndo(inner: ReturnType<typeof innerVditor>): UndoSavepoint | null {
  const mode = inner?.currentMode
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
  inner: ReturnType<typeof innerVditor>,
  savepoint: UndoSavepoint | null,
): void {
  if (
    !inner ||
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

function restoreRange(range: Range, backward: boolean): boolean {
  const selection = document.getSelection()
  if (
    !selection ||
    !range.startContainer.isConnected ||
    !range.endContainer.isConnected
  )
    return false
  try {
    if (selection.setBaseAndExtent) {
      selection.setBaseAndExtent(
        backward ? range.endContainer : range.startContainer,
        backward ? range.endOffset : range.startOffset,
        backward ? range.startContainer : range.endContainer,
        backward ? range.startOffset : range.endOffset,
      )
    } else {
      selection.removeAllRanges()
      selection.addRange(range)
    }
    return true
  } catch {
    return false
  }
}

function admittedVisualLeaf(
  editor: HTMLElement,
  range: Range,
): HTMLElement | null {
  const leafAt = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
      LEAF_SELECTOR,
    ) ?? null
  const leaf = leafAt(range.startContainer)
  if (!leaf || leaf !== leafAt(range.endContainer) || !editor.contains(leaf))
    return null
  for (
    let ancestor: Element | null = leaf;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    if (ancestor === editor) break
    if (ancestor.matches(FORBIDDEN_SELECTOR)) return null
  }
  for (const forbidden of Array.from(
    leaf.querySelectorAll(FORBIDDEN_SELECTOR),
  )) {
    if (range.intersectsNode(forbidden)) return null
  }
  return leaf
}

function escapedAt(source: string, offset: number): boolean {
  let slashes = 0
  for (
    let previous = offset - 1;
    previous >= 0 && source[previous] === '\\';
    previous--
  )
    slashes++
  return slashes % 2 === 1
}

/** Refuse a source range inside a closed or ambiguous inline code/math delimiter run. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: scans delimiter runs and escapes without changing UTF-16 source offsets.
function sourceRangeIsProtected(
  source: string,
  start: number,
  end: number,
): boolean {
  for (let index = 0; index < source.length; index++) {
    const delimiter = source[index]
    if ((delimiter !== '`' && delimiter !== '$') || escapedAt(source, index))
      continue
    let length = 1
    while (source[index + length] === delimiter) length++
    let close = -1
    for (let candidate = index + length; candidate < source.length; ) {
      if (source[candidate] !== delimiter || escapedAt(source, candidate)) {
        candidate++
        continue
      }
      let candidateLength = 1
      while (source[candidate + candidateLength] === delimiter)
        candidateLength++
      if (candidateLength === length) {
        close = candidate
        break
      }
      candidate += candidateLength
    }
    const protectedEnd = close < 0 ? source.length : close + length
    if (
      start === end
        ? start >= index && start <= protectedEnd
        : start < protectedEnd && end > index
    )
      return true
    if (close < 0) return false
    index = protectedEnd - 1
  }
  return false
}

function uniqueMarker(markdown: string, side: string): string {
  for (let index = 0; ; index++) {
    const marker = `${MARKER_BASE}${side}_${index}\uE311`
    if (!markdown.includes(marker)) return marker
  }
}

function markerPoints(
  root: HTMLElement,
  markers: readonly string[],
): Map<string, TextPoint> | null {
  const points = new Map<string, TextPoint>()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    const node = next as Text
    if (
      node.parentElement?.closest(
        '[data-render], .vditor-ir__preview, .vditor-wysiwyg__preview',
      )
    )
      continue
    for (const marker of markers) {
      const first = node.data.indexOf(marker)
      if (first < 0) continue
      if (first !== node.data.lastIndexOf(marker) || points.has(marker))
        return null
      points.set(marker, { node, offset: first })
    }
  }
  return points.size === markers.length ? points : null
}

function removeMarkers(
  root: HTMLElement,
  startMarker: string,
  endMarker: string,
): { start: TextPoint; end: TextPoint } | null {
  const points = markerPoints(root, [startMarker, endMarker])
  const start = points?.get(startMarker)
  const end = points?.get(endMarker)
  if (!start || !end) return null
  const endpoint = (point: TextPoint): TextPoint => ({
    node: point.node,
    offset:
      point.offset -
      [
        { point: start, marker: startMarker },
        { point: end, marker: endMarker },
      ]
        .filter(
          (candidate) =>
            candidate.point.node === point.node &&
            candidate.point.offset < point.offset,
        )
        .reduce((total, candidate) => total + candidate.marker.length, 0),
  })
  const restoredStart = endpoint(start)
  const restoredEnd = endpoint(end)
  const removals = [
    { point: start, marker: startMarker },
    { point: end, marker: endMarker },
  ].sort((left, right) =>
    left.point.node === right.point.node
      ? right.point.offset - left.point.offset
      : 0,
  )
  for (const { point, marker } of removals)
    point.node.deleteData(point.offset, marker.length)
  if (
    !restoredStart.node.isConnected ||
    !restoredEnd.node.isConnected ||
    restoredStart.offset > restoredStart.node.data.length ||
    restoredEnd.offset > restoredEnd.node.data.length
  )
    return null
  return { start: restoredStart, end: restoredEnd }
}

function setSelection(
  root: HTMLElement,
  start: TextPoint,
  end: TextPoint,
  backward: boolean,
) {
  const selection = document.getSelection()
  if (!selection) return false
  root.focus({ preventScroll: true })
  if (selection.setBaseAndExtent)
    selection.setBaseAndExtent(
      backward ? end.node : start.node,
      backward ? end.offset : start.offset,
      backward ? start.node : end.node,
      backward ? start.offset : end.offset,
    )
  else {
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  return true
}

function sourceText(root: HTMLElement): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let text = ''
  for (let next = walker.nextNode(); next; next = walker.nextNode())
    text += (next as Text).data
  return text
}

function sourceOffset(root: HTMLElement, point: TextPoint): number | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let offset = 0
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    const node = next as Text
    if (node === point.node) {
      if (point.offset < 0 || point.offset > node.data.length) return null
      return offset + point.offset
    }
    offset += node.data.length
  }
  return null
}

function sourcePoint(root: HTMLElement, offset: number): TextPoint | null {
  if (offset < 0) return null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = offset
  let last: Text | null = null
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    const node = next as Text
    if (!node.data.length) continue
    if (remaining <= node.data.length) return { node, offset: remaining }
    remaining -= node.data.length
    last = node
  }
  return remaining === 0 && last
    ? { node: last, offset: last.data.length }
    : null
}

function sourceRoot(
  editor: HTMLElement,
  start: TextPoint,
  end: TextPoint,
  expression: string,
): HTMLElement | null {
  const expected = `\`${expression}\``
  for (
    let candidate = start.node.parentElement;
    candidate && editor.contains(candidate);
    candidate = candidate.parentElement
  ) {
    if (
      !candidate.contains(end.node) ||
      candidate.closest(
        '[data-render], .vditor-ir__preview, .vditor-wysiwyg__preview',
      ) ||
      candidate.querySelector(
        '[data-render], .vditor-ir__preview, .vditor-wysiwyg__preview',
      ) ||
      (sourceText(candidate) !== expected &&
        !(
          candidate.matches('code[data-type="math-inline"]') &&
          candidate.closest(
            '.vditor-wysiwyg__block[data-type="math-inline"]',
          ) &&
          candidate.nextElementSibling?.matches('.vditor-wysiwyg__preview') &&
          sourceText(candidate) === `\u200B${expected}`
        ))
    )
      continue
    return candidate
  }
  return null
}

function revealWysiwygMathSource(source: HTMLElement): boolean {
  if (!source.matches('code[data-type="math-inline"]')) return true
  if (
    !source.closest('.vditor-wysiwyg__block[data-type="math-inline"]') ||
    !source.nextElementSibling?.matches('.vditor-wysiwyg__preview')
  )
    return false
  source.style.display = 'inline-block'
  return true
}

function captureMathSourceBookmark(
  editor: HTMLElement,
  start: TextPoint,
  end: TextPoint,
  expression: string,
  backward: boolean,
): MathSourceBookmark | null {
  const root = sourceRoot(editor, start, end, expression)
  if (!root) return null
  const sourceStart = sourceOffset(root, start)
  const sourceEnd = sourceOffset(root, end)
  const text = sourceText(root)
  if (
    sourceStart === null ||
    sourceEnd === null ||
    sourceStart > sourceEnd ||
    text.slice(sourceStart, sourceEnd) !== expression
  )
    return null
  return { root, text, start: sourceStart, end: sourceEnd, backward }
}

function resolveMathSourceBookmark(
  editor: HTMLElement,
  bookmark: MathSourceBookmark,
): { start: TextPoint; end: TextPoint } | null {
  if (
    !bookmark.root.isConnected ||
    !editor.contains(bookmark.root) ||
    sourceText(bookmark.root) !== bookmark.text
  )
    return null
  const start = sourcePoint(bookmark.root, bookmark.start)
  const end = sourcePoint(bookmark.root, bookmark.end)
  if (!start || !end) return null
  const text = sourceText(bookmark.root)
  return text.slice(bookmark.start, bookmark.end) ||
    bookmark.start === bookmark.end
    ? { start, end }
    : null
}

function requestDirectionalSelection(
  start: TextPoint,
  end: TextPoint,
  backward: boolean,
): boolean {
  return requestCaret({
    anchor: backward
      ? { node: end.node, offset: end.offset }
      : { node: start.node, offset: start.offset },
    focus: backward
      ? { node: start.node, offset: start.offset }
      : { node: end.node, offset: end.offset },
  })
}

function refreshMathPreview(source: HTMLElement): boolean {
  const preview = source.nextElementSibling
  if (
    !(preview instanceof HTMLElement) ||
    !preview.matches('.vditor-ir__preview, .vditor-wysiwyg__preview')
  )
    return false
  const sourceCode = source.textContent
  if (sourceCode === null) return false
  const expression = sourceCode.startsWith('\u200B')
    ? sourceCode.slice(1)
    : sourceCode
  const math = document.createElement('span')
  math.className = 'language-math'
  math.textContent = expression
  preview.replaceChildren(math)
  preview.removeAttribute('data-render')
  const options = innerVditor()?.options as
    | {
        cdn?: string
        preview?: {
          math?: NonNullable<Parameters<typeof mathRender>[1]>['math']
        }
      }
    | undefined
  mathRender(preview, {
    cdn: options?.cdn,
    math: options?.preview?.math,
  })
  preview.setAttribute('data-render', '1')
  return true
}

function restoredOrigin(origin: ToolbarSelectionOrigin): RetainedRange | null {
  if (!restoreRange(origin.range, origin.backward)) return null
  return {
    editor: origin.editor,
    range: origin.range,
    backward: origin.backward,
  }
}

function currentRetainedRange(): RetainedRange | null {
  const editor = activeModeElement(window.vditor)
  const selection = document.getSelection()
  if (
    !editor ||
    !selection?.rangeCount ||
    !selection.anchorNode ||
    !selection.focusNode
  )
    return null
  const range = selection.getRangeAt(0)
  if (
    !editor.contains(range.startContainer) ||
    !editor.contains(range.endContainer)
  )
    return null
  return {
    editor,
    range: range.cloneRange(),
    backward:
      selection.anchorNode === range.endContainer &&
      selection.anchorOffset === range.endOffset,
  }
}

/** Install the one retained-selection action used by Math's GitHub inline submenu child. */
export function installGithubInlineMathInsertion(): () => void {
  const actionButton = document.querySelector<HTMLButtonElement>(
    '[data-type="math-inline-github"]',
  )
  const previewButton = document.querySelector<HTMLButtonElement>(
    '[data-type="preview"]',
  )
  const buttons = document.querySelectorAll(
    '[data-type="more"], [data-type="math"], [data-type="math-inline-github"]',
  )
  let retained: RetainedRange | null = null
  const updatePreviewAvailability = () => {
    const disabled = previewOpen()
    actionButton?.toggleAttribute('disabled', disabled)
    actionButton?.setAttribute('aria-disabled', String(disabled))
  }
  const clear = () => {
    retained = null
  }
  const rememberPointer = () => {
    // A pointer selection is newer than an Escape→Tab snapshot; its activation must never format
    // the stale keyboard origin.
    const fresh = currentRetainedRange()
    if (!fresh) return
    consumeToolbarSelectionOrigin()
    retained = fresh
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one transaction keeps origin, rollback, and marker cleanup atomic.
  const run = () => {
    const deps = configured
    const origin = peekConsumedToolbarSelectionOrigin()
    const consumed = consumeToolbarSelectionOrigin()
    const target = consumed
      ? origin
        ? restoredOrigin(origin)
        : null
      : retained
    if (!deps || previewOpen() || isCompositionActive() || !target) return
    if (!restoreRange(target.range, target.backward)) return
    const snapshot = deps.snapshotMarkdown?.() ?? window.vditor.getValue()
    if (window.vditor.getValue() !== snapshot) return
    const mapped = captureRewrapSourceRange(window, target.range, {
      authoritativeMarkdown: snapshot,
    })
    const plan =
      mapped &&
      planGithubInlineMath(snapshot, mapped.startOffset, mapped.endOffset)
    const inner = innerVditor()
    const editor = activeModeElement(window.vditor)
    const mode = inner?.currentMode
    const sourceLeaf =
      mapped && mode === 'sv' ? sourceLeafSelection(snapshot, mapped) : null
    if (
      !plan ||
      !inner ||
      !editor ||
      isCompositionActive() ||
      previewOpen() ||
      (mode === 'sv'
        ? !sourceLeaf ||
          mapped.startOffset < sourceLeaf.startOffset ||
          mapped.endOffset > sourceLeaf.endOffset ||
          sourceRangeIsProtected(snapshot, mapped.startOffset, mapped.endOffset)
        : !admittedVisualLeaf(editor, target.range))
    )
      return
    const scrollTop = findScroller(editor).scrollTop
    const restoreScroll = () => {
      const fresh = activeModeElement(window.vditor)
      if (!fresh) return
      const scroller = findScroller(fresh)
      scroller.scrollTop = Math.min(
        scrollTop,
        Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      )
    }
    const rollbackStart = uniqueMarker(snapshot, 'ROLLBACK_START')
    const rollbackEnd = uniqueMarker(
      `${snapshot}${rollbackStart}`,
      'ROLLBACK_END',
    )
    const rollbackMarked =
      snapshot.slice(0, mapped.startOffset) +
      rollbackStart +
      snapshot.slice(mapped.startOffset, mapped.endOffset) +
      rollbackEnd +
      snapshot.slice(mapped.endOffset)
    const startMarker = uniqueMarker(plan.markdown, 'START')
    const endMarker = uniqueMarker(`${plan.markdown}${startMarker}`, 'END')
    const marked =
      plan.markdown.slice(0, plan.anchor) +
      startMarker +
      plan.markdown.slice(plan.anchor, plan.focus) +
      endMarker +
      plan.markdown.slice(plan.focus)
    if (
      marked.split(startMarker).length !== 2 ||
      marked.split(endMarker).length !== 2
    )
      return
    deps.setApplying(true)
    let rollback: (() => boolean) | null = null
    let rollbackAttempted = false
    try {
      checkpointEditorUndo(inner)
      const undoSavepoint = saveUndo(inner)
      // The document mutation is only recoverable when its current-mode Vditor slot is stable.
      // Capture after the pre-edit checkpoint so a failure restores the user's actual undo state.
      if (!undoSavepoint) return
      rollback = () => {
        try {
          window.vditor.setValue(rollbackMarked)
          const restored = activeModeElement(window.vditor)
          const restoredPoints = restored
            ? removeMarkers(restored, rollbackStart, rollbackEnd)
            : null
          if (
            restored &&
            restoredPoints &&
            window.vditor.getValue() === snapshot
          )
            return setSelection(
              restored,
              restoredPoints.start,
              restoredPoints.end,
              target.backward,
            )

          window.vditor.setValue(snapshot)
          return restoreRange(target.range, target.backward)
        } finally {
          // Rollback must retire the attempted edit's delayed snapshot even if DOM restoration
          // throws, then put the captured current-mode history and viewport back together.
          cancelPendingUndoSnapshot(inner)
          restoreUndo(inner, undoSavepoint)
          restoreScroll()
        }
      }
      const rollbackOrThrow = () => {
        rollbackAttempted = true
        const restore = rollback
        if (!restore?.())
          throw new Error(
            'GitHub inline Math rollback could not restore the original selection',
          )
      }
      let applied: boolean
      if (inner.currentMode === 'sv')
        applied = replaceSvMarkdownRange(editor, snapshot, {
          markdown: marked,
          caretOffset: plan.focus,
        })
      else {
        window.vditor.setValue(marked)
        applied = true
      }
      const fresh = activeModeElement(window.vditor)
      const points = fresh ? removeMarkers(fresh, startMarker, endMarker) : null
      if (
        !applied ||
        !fresh ||
        !points ||
        window.vditor.getValue() !== plan.markdown ||
        !setSelection(fresh, points.start, points.end, target.backward)
      ) {
        rollbackOrThrow()
        return
      }
      const bookmark =
        mode === 'sv'
          ? plan.anchor === plan.focus
            ? null
            : sourceText(fresh) === plan.markdown
              ? {
                  root: fresh,
                  text: plan.markdown,
                  start: plan.anchor,
                  end: plan.focus,
                  backward: target.backward,
                }
              : null
          : mode === 'wysiwyg'
            ? captureMathSourceBookmark(
                fresh,
                points.start,
                points.end,
                plan.markdown.slice(plan.anchor, plan.focus),
                target.backward,
              )
            : plan.anchor === plan.focus
              ? null
              : captureMathSourceBookmark(
                  fresh,
                  points.start,
                  points.end,
                  plan.markdown.slice(plan.anchor, plan.focus),
                  target.backward,
                )
      if ((plan.anchor !== plan.focus || mode === 'wysiwyg') && !bookmark) {
        rollbackOrThrow()
        return
      }
      if (
        bookmark &&
        mode === 'wysiwyg' &&
        !revealWysiwygMathSource(bookmark.root)
      ) {
        rollbackOrThrow()
        return
      }
      if (bookmark && mode !== 'sv' && !refreshMathPreview(bookmark.root)) {
        rollbackOrThrow()
        return
      }
      checkpointEditorUndo(inner)
      if (bookmark) {
        const resolved = resolveMathSourceBookmark(fresh, bookmark)
        if (
          !resolved ||
          !requestDirectionalSelection(
            resolved.start,
            resolved.end,
            bookmark.backward,
          )
        ) {
          rollbackOrThrow()
          return
        }
      }
      if (plan.anchor === plan.focus) {
        invalidateCaret()
        if (!setSelection(fresh, points.start, points.end, false)) {
          rollbackOrThrow()
          return
        }
      }
    } catch (error) {
      try {
        if (rollback && !rollbackAttempted) rollback()
        else if (!rollback) window.vditor.setValue(snapshot)
      } finally {
        deps.onError(error)
      }
      return
    } finally {
      deps.setApplying(false)
    }
    restoreScroll()
    deps.invalidate()
    deps.scheduleSync()
  }
  for (const button of buttons)
    button.addEventListener('pointerdown', rememberPointer, true)
  const onPreviewClick = () => queueMicrotask(updatePreviewAvailability)
  previewButton?.addEventListener('click', onPreviewClick)
  updatePreviewAvailability()
  document.addEventListener('input', clear, true)
  document.addEventListener(EVENT, run)
  return () => {
    for (const button of buttons)
      button.removeEventListener('pointerdown', rememberPointer, true)
    previewButton?.removeEventListener('click', onPreviewClick)
    document.removeEventListener('input', clear, true)
    document.removeEventListener(EVENT, run)
  }
}

/** Install Math block's retained-selection action without adding a competing toolbar command. */
export function installGithubFencedMathInsertion(): () => void {
  const actionButton = document.querySelector<HTMLButtonElement>(
    '[data-type="math-block"]',
  )
  const previewButton = document.querySelector<HTMLButtonElement>(
    '[data-type="preview"]',
  )
  const buttons = document.querySelectorAll(
    '[data-type="more"], [data-type="math"], [data-type="math-block"]',
  )
  let retained: RetainedRange | null = null
  const updatePreviewAvailability = () => {
    const disabled = previewOpen()
    actionButton?.toggleAttribute('disabled', disabled)
    actionButton?.setAttribute('aria-disabled', String(disabled))
  }
  const clear = () => {
    retained = null
  }
  const rememberPointer = () => {
    const fresh = currentRetainedRange()
    if (!fresh) return
    consumeToolbarSelectionOrigin()
    retained = fresh
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one transaction keeps retained selection, undo checkpoints, marker cleanup, and rollback together.
  const run = () => {
    const deps = configured
    const origin = peekConsumedToolbarSelectionOrigin()
    const consumed = consumeToolbarSelectionOrigin()
    const target = consumed
      ? origin
        ? restoredOrigin(origin)
        : null
      : retained
    if (!deps || previewOpen() || isCompositionActive() || !target) return
    if (!restoreRange(target.range, target.backward)) return
    const snapshot = deps.snapshotMarkdown?.() ?? window.vditor.getValue()
    if (window.vditor.getValue() !== snapshot) return
    const mapped = captureRewrapSourceRange(window, target.range, {
      authoritativeMarkdown: snapshot,
    })
    const plan =
      mapped &&
      !sourceRangeIsProtected(snapshot, mapped.startOffset, mapped.endOffset)
        ? planGithubFencedMath(snapshot, mapped.startOffset, mapped.endOffset)
        : null
    const inner = innerVditor()
    const editor = activeModeElement(window.vditor)
    if (!plan || !inner || !editor || previewOpen() || isCompositionActive())
      return
    const scrollTop = findScroller(editor).scrollTop
    const startMarker = uniqueMarker(plan.markdown, 'FENCE_START')
    const endMarker = uniqueMarker(
      `${plan.markdown}${startMarker}`,
      'FENCE_END',
    )
    const marked =
      plan.markdown.slice(0, plan.caret) +
      startMarker +
      endMarker +
      plan.markdown.slice(plan.caret)
    if (
      marked.split(startMarker).length !== 2 ||
      marked.split(endMarker).length !== 2
    )
      return
    deps.setApplying(true)
    try {
      checkpointEditorUndo(inner)
      let applied = false
      if (inner.currentMode === 'sv')
        applied = replaceSvMarkdownRange(editor, snapshot, {
          markdown: marked,
          caretOffset: plan.caret,
        })
      else {
        window.vditor.setValue(marked)
        applied = true
      }
      const fresh = activeModeElement(window.vditor)
      const points = fresh ? removeMarkers(fresh, startMarker, endMarker) : null
      if (
        !applied ||
        !fresh ||
        !points ||
        window.vditor.getValue() !== plan.markdown ||
        !setSelection(fresh, points.start, points.end, false)
      ) {
        window.vditor.setValue(snapshot)
        cancelPendingUndoSnapshot(inner)
        return
      }
      checkpointEditorUndo(inner)
      const restored = activeModeElement(window.vditor)
      if (restored) {
        // setValue rebuilds the fenced source but bypasses IR/WYSIWYG input's code-preview pass.
        // Run Vditor's own dispatcher first so the new PRE > CODE fence creates its preview.
        for (const preview of restored.querySelectorAll<HTMLElement>(
          ".vditor-ir__preview[data-render='2'], .vditor-wysiwyg__preview[data-render='2']",
        ))
          processRebuiltCodePreview(preview, inner)
        // Then cover an already-built math node before restoring the body caret.
        const options = inner.options as
          | {
              cdn?: string
              preview?: {
                math?: NonNullable<Parameters<typeof mathRender>[1]>['math']
              }
            }
          | undefined
        mathRender(restored, {
          cdn: options?.cdn,
          math: options?.preview?.math,
        })
        const scroller = findScroller(restored)
        scroller.scrollTop = Math.min(
          scrollTop,
          Math.max(0, scroller.scrollHeight - scroller.clientHeight),
        )
      }
      deps.invalidate()
      deps.scheduleSync()
    } catch (error) {
      try {
        window.vditor.setValue(snapshot)
        cancelPendingUndoSnapshot(inner)
      } finally {
        deps.onError(error)
      }
    } finally {
      deps.setApplying(false)
    }
  }
  for (const button of buttons)
    button.addEventListener('pointerdown', rememberPointer, true)
  const onPreviewClick = () => queueMicrotask(updatePreviewAvailability)
  previewButton?.addEventListener('click', onPreviewClick)
  updatePreviewAvailability()
  document.addEventListener('input', clear, true)
  document.addEventListener(FENCED_EVENT, run)
  return () => {
    for (const button of buttons)
      button.removeEventListener('pointerdown', rememberPointer, true)
    previewButton?.removeEventListener('click', onPreviewClick)
    document.removeEventListener('input', clear, true)
    document.removeEventListener(FENCED_EVENT, run)
  }
}
