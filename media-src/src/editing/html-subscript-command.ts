import { findScroller } from '../chrome/toolbar-scroll-guard'
import { isCompositionActive } from '../util/caret-gesture'
import { innerVditor } from '../util/inner-vditor'
import { activeModeElement } from '../util/source-map'
import {
  consumeToolbarSelectionOrigin,
  peekConsumedToolbarSelectionOrigin,
  type ToolbarSelectionOrigin,
} from './escape-toolbar'
import {
  planHtmlSubscript,
  type Splice,
  type SubscriptPlan,
} from './html-subscript-action'
import { invalidateCaret } from './caret'
import {
  captureRewrapSourceRange,
  checkpointEditorUndo,
  replaceSvMarkdownRange,
  type SourceSelection,
} from './rewrap-command'

export interface HtmlSubscriptCommandDeps {
  setApplying(applying: boolean): void
  invalidate(): void
  scheduleSync(): void
  snapshotMarkdown?(): string
  onError(error: unknown): void
}

interface TextPoint {
  node: Text
  offset: number
}

interface CommandTarget {
  outer: NonNullable<Window['vditor']>
  inner: NonNullable<ReturnType<typeof innerVditor>>
  editor: HTMLElement
  mode: string
  range: Range
  anchorNode: Node
  anchorNodeOffset: number
  focusNode: Node
  focusNodeOffset: number
  snapshot: string
  selection: SourceSelection
  leaf: SourceSelection
  anchor: number
  focus: number
}

interface MarkerPoint {
  marker: string
  node: Text
  offset: number
  order: number
}

interface RetainedLiveRange {
  editor: HTMLElement
  anchorNode: Node
  anchorOffset: number
  focusNode: Node
  focusOffset: number
}

function tableCanonicalMarkdown(
  target: CommandTarget,
  markdown: string,
): string | null {
  if (target.mode === 'sv') return null
  const leaf = (
    target.range.startContainer instanceof Element
      ? target.range.startContainer
      : target.range.startContainer.parentElement
  )?.closest('td,th')
  if (!leaf) return null
  const lute = target.inner.lute as
    | {
        Md2VditorIRDOM?(source: string): string
        Md2VditorDOM?(source: string): string
        VditorIRDOM2Md?(html: string): string
        VditorDOM2Md?(html: string): string
      }
    | undefined
  const render = (
    target.mode === 'ir' ? lute?.Md2VditorIRDOM : lute?.Md2VditorDOM
  )?.bind(lute)
  const serialize = (
    target.mode === 'ir' ? lute?.VditorIRDOM2Md : lute?.VditorDOM2Md
  )?.bind(lute)
  return render && serialize ? serialize(render(markdown)) : null
}

const LEAF_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,td,th,li'
const FORBIDDEN_SELECTOR =
  'code,pre,[data-render],[data-type*="code"],[data-type*="math"],[data-type*="html-block"],.vditor-ir__marker--pre'
const MARKER_BASE = '\uE420VMDE_SUBSCRIPT_'

function samePoint(
  node: Node | null,
  offset: number,
  point: TextPoint,
): boolean {
  return node === point.node && offset === point.offset
}

function rangeDirection(
  selection: Selection,
  range: Range,
): 'forward' | 'backward' {
  return selection.anchorNode === range.startContainer &&
    selection.anchorOffset === range.startOffset
    ? 'forward'
    : 'backward'
}

function findLeaf(editor: HTMLElement, range: Range): HTMLElement | null {
  const elementAt = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
      LEAF_SELECTOR,
    ) ?? null
  const start = elementAt(range.startContainer)
  const end = elementAt(range.endContainer)
  if (!start || start !== end || !editor.contains(start)) return null
  if (
    start.tagName === 'LI' &&
    start.querySelector(':scope > p,:scope > ul,:scope > ol,:scope > table')
  )
    return null
  const isHtmlInline = (element: Element) =>
    element.closest('[data-type="html-inline"]') !== null
  const forbidden = (element: Element) =>
    element.matches(FORBIDDEN_SELECTOR) && !isHtmlInline(element)
  for (
    let ancestor: Element | null = start;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    if (ancestor === editor) break
    if (forbidden(ancestor)) return null
  }
  for (const descendant of Array.from(
    start.querySelectorAll(FORBIDDEN_SELECTOR),
  )) {
    if (forbidden(descendant) && range.intersectsNode(descendant)) return null
  }
  return start
}

interface SourceLine {
  start: number
  end: number
  endWithBreak: number
  text: string
}

function sourceLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  for (const match of markdown.matchAll(/\r\n|\n|\r/gu)) {
    lines.push({
      start,
      end: match.index,
      endWithBreak: match.index + match[0].length,
      text: markdown.slice(start, match.index),
    })
    start = match.index + match[0].length
  }
  lines.push({
    start,
    end: markdown.length,
    endWithBreak: markdown.length,
    text: markdown.slice(start),
  })
  return lines
}

function sourceLineAt(lines: readonly SourceLine[], offset: number): number {
  return lines.findIndex(
    (line, index) =>
      offset < line.endWithBreak ||
      (index === lines.length - 1 && offset <= line.endWithBreak),
  )
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: walks source block state without serializing hot selection changes
function sourceLineIsProtected(
  lines: readonly SourceLine[],
  index: number,
): boolean {
  let fence: string | null = null
  let math = false
  let html: string | null = null
  const htmlOpen =
    /^\s*<(address|article|aside|blockquote|body|caption|center|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|li|link|main|menu|nav|ol|p|pre|script|section|style|summary|table|tbody|td|th|thead|tr|ul)(?:\s|>|$)/iu
  for (let current = 0; current <= index; current++) {
    const text = lines[current]?.text ?? ''
    const fenceMarker = /^ {0,3}(`{3,}|~{3,})/u.exec(text)?.[1]
    const opened = htmlOpen.exec(text)?.[1]
    const inProtected = Boolean(
      fence ||
        math ||
        html ||
        fenceMarker ||
        opened ||
        /^\s*\$\$\s*$/u.test(text),
    )
    if (current === index) return inProtected
    if (fenceMarker) {
      if (!fence) fence = fenceMarker[0]
      else if (fenceMarker[0] === fence) fence = null
      continue
    }
    if (/^\s*\$\$\s*$/u.test(text)) {
      math = !math
      continue
    }
    if (!html && opened) html = opened.toLowerCase()
    if (html && new RegExp(`</${html}\\s*>`, 'iu').test(text)) html = null
  }
  return false
}

function ordinarySourceLine(text: string): boolean {
  return (
    Boolean(text.trim()) &&
    !/^(?: {4}|\t| {0,3}(?:#{1,6}(?:\s|$)|[-+*]|\d+[.)]\s|>|\|))/u.test(text)
  )
}

/** Conservatively expand an SV selection only through the one prose paragraph that owns it. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: guards every source line before bounded paragraph expansion
export function sourceLeafSelection(
  markdown: string,
  selection: SourceSelection,
): SourceSelection | null {
  const lines = sourceLines(markdown)
  const first = sourceLineAt(lines, selection.startOffset)
  const lastOffset = Math.max(selection.startOffset, selection.endOffset - 1)
  const last = sourceLineAt(lines, lastOffset)
  if (first < 0 || last < first) return null
  for (let index = first; index <= last; index++) {
    if (sourceLineIsProtected(lines, index)) return null
  }
  if (
    first !== last &&
    lines.slice(first, last + 1).some((line) => !ordinarySourceLine(line.text))
  )
    return null
  if (!ordinarySourceLine(lines[first]?.text ?? '')) {
    // Heading and list text are valid only as one visible source line; do not guess a continuation.
    if (first !== last || !lines[first]?.text.trim()) return null
    return {
      markdown,
      startOffset: lines[first].start,
      endOffset: lines[first].end,
      caretOffset: selection.caretOffset,
    }
  }
  let start = first
  let end = last
  while (start > 0 && ordinarySourceLine(lines[start - 1]?.text ?? '')) start--
  while (
    end + 1 < lines.length &&
    ordinarySourceLine(lines[end + 1]?.text ?? '')
  )
    end++
  return {
    markdown,
    startOffset: lines[start].start,
    endOffset: lines[end].end,
    caretOffset: selection.caretOffset,
  }
}

function captureTarget(deps: HtmlSubscriptCommandDeps): CommandTarget | null {
  const outer = window.vditor
  const inner = innerVditor()
  const editor = outer ? activeModeElement(outer) : null
  const selection = document.getSelection()
  if (
    !outer ||
    !inner ||
    !editor ||
    !selection?.rangeCount ||
    !selection.anchorNode ||
    !selection.focusNode ||
    !editor.contains(selection.anchorNode) ||
    !editor.contains(selection.focusNode)
  )
    return null
  const range = selection.getRangeAt(0).cloneRange()
  const snapshot = deps.snapshotMarkdown?.() ?? outer.getValue()
  const mapped = captureRewrapSourceRange(window, range, {
    authoritativeMarkdown: snapshot,
  })
  if (!mapped) return null
  const mode = inner.currentMode
  if (mode !== 'ir' && mode !== 'wysiwyg' && mode !== 'sv') return null
  let leaf: SourceSelection | null
  if (mode === 'sv') {
    leaf = sourceLeafSelection(snapshot, mapped)
  } else {
    const element = findLeaf(editor, range)
    if (!element) return null
    const leafRange = document.createRange()
    leafRange.selectNodeContents(element)
    leaf = captureRewrapSourceRange(window, leafRange, {
      authoritativeMarkdown: snapshot,
    })
  }
  if (
    !leaf ||
    mapped.startOffset < leaf.startOffset ||
    mapped.endOffset > leaf.endOffset
  )
    return null
  const direction = rangeDirection(selection, range)
  const anchor = direction === 'forward' ? mapped.startOffset : mapped.endOffset
  const focus = direction === 'forward' ? mapped.endOffset : mapped.startOffset
  return {
    outer,
    inner,
    editor,
    mode,
    range,
    anchorNode: selection.anchorNode,
    anchorNodeOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusNodeOffset: selection.focusOffset,
    snapshot,
    selection: mapped,
    leaf,
    anchor,
    focus,
  }
}

function restoreTargetRange(target: CommandTarget): boolean {
  if (
    !target.editor.isConnected ||
    !target.editor.contains(target.range.startContainer) ||
    !target.editor.contains(target.range.endContainer)
  )
    return false
  const selection = document.getSelection()
  if (!selection) return false
  const forward = target.anchor <= target.focus
  if (selection.setBaseAndExtent) {
    selection.setBaseAndExtent(
      forward ? target.range.startContainer : target.range.endContainer,
      forward ? target.range.startOffset : target.range.endOffset,
      forward ? target.range.endContainer : target.range.startContainer,
      forward ? target.range.endOffset : target.range.startOffset,
    )
  } else {
    selection.removeAllRanges()
    selection.addRange(target.range)
  }
  return true
}

function equivalentTarget(
  retained: CommandTarget,
  fresh: CommandTarget | null,
): fresh is CommandTarget {
  return Boolean(
    fresh &&
      fresh.outer === retained.outer &&
      fresh.inner === retained.inner &&
      fresh.editor === retained.editor &&
      fresh.mode === retained.mode &&
      fresh.snapshot === retained.snapshot &&
      fresh.selection.startOffset === retained.selection.startOffset &&
      fresh.selection.endOffset === retained.selection.endOffset &&
      fresh.leaf.startOffset === retained.leaf.startOffset &&
      fresh.leaf.endOffset === retained.leaf.endOffset &&
      fresh.anchor === retained.anchor &&
      fresh.focus === retained.focus,
  )
}

function applySplices(
  source: string,
  splices: readonly Splice[],
): string | null {
  let result = source
  for (const splice of [...splices].sort((a, b) => b.start - a.start)) {
    if (
      !Number.isInteger(splice.start) ||
      !Number.isInteger(splice.end) ||
      splice.start < 0 ||
      splice.end < splice.start ||
      splice.end > result.length
    )
      return null
    result =
      result.slice(0, splice.start) + splice.text + result.slice(splice.end)
  }
  return result
}

function uniqueMarker(markdown: string, suffix: string): string {
  let index = 0
  for (;;) {
    const marker = `${MARKER_BASE}${suffix}_${index}\uE42F`
    if (!markdown.includes(marker)) return marker
    index++
  }
}

function placeMarkers(
  markdown: string,
  anchor: number,
  focus: number,
): { markdown: string; anchorMarker: string; focusMarker: string } {
  const anchorMarker = uniqueMarker(markdown, 'ANCHOR')
  const focusMarker = uniqueMarker(markdown + anchorMarker, 'FOCUS')
  const insertions = [
    { offset: anchor, marker: anchorMarker },
    { offset: focus, marker: focusMarker },
  ].sort((a, b) => b.offset - a.offset)
  let marked = markdown
  for (const insertion of insertions)
    marked =
      marked.slice(0, insertion.offset) +
      insertion.marker +
      marked.slice(insertion.offset)
  return { markdown: marked, anchorMarker, focusMarker }
}

function findMarkerPoints(
  root: HTMLElement,
  markers: readonly string[],
): MarkerPoint[] | null {
  const points: MarkerPoint[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let order = 0
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    const node = next as Text
    for (const marker of markers) {
      const offset = node.data.indexOf(marker)
      if (offset >= 0) points.push({ marker, node, offset, order })
    }
    order++
  }
  return points.length === markers.length ? points : null
}

/** Remove render-only markers before checkpointing, retaining concrete Text points so a backward
 * selection survives Vditor's render instead of collapsing to its focus endpoint. */
function removeMarkers(
  root: HTMLElement,
  anchorMarker: string,
  focusMarker: string,
): { anchor: TextPoint; focus: TextPoint } | null {
  const points = findMarkerPoints(root, [anchorMarker, focusMarker])
  if (!points) return null
  const pointFor = (marker: string): TextPoint | null => {
    const point = points.find((candidate) => candidate.marker === marker)
    if (!point) return null
    const before = points.filter(
      (candidate) =>
        candidate.node === point.node && candidate.offset < point.offset,
    )
    return {
      node: point.node,
      offset:
        point.offset -
        before.reduce((sum, item) => sum + item.marker.length, 0),
    }
  }
  const anchor = pointFor(anchorMarker)
  const focus = pointFor(focusMarker)
  if (!anchor || !focus) return null
  for (const point of [...points].sort(
    (a, b) => b.order - a.order || b.offset - a.offset,
  ))
    point.node.deleteData(point.offset, point.marker.length)
  return { anchor, focus }
}

function setDirectionalSelection(
  root: HTMLElement,
  anchor: TextPoint,
  focus: TextPoint,
): boolean {
  const selection = root.ownerDocument.getSelection()
  if (!selection) return false
  root.focus({ preventScroll: true })
  if (selection.setBaseAndExtent) {
    selection.setBaseAndExtent(
      anchor.node,
      anchor.offset,
      focus.node,
      focus.offset,
    )
    return (
      samePoint(selection.anchorNode, selection.anchorOffset, anchor) &&
      samePoint(selection.focusNode, selection.focusOffset, focus)
    )
  }
  const range = root.ownerDocument.createRange()
  range.setStart(anchor.node, anchor.offset)
  range.setEnd(focus.node, focus.offset)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

function previewOpen(): boolean {
  const preview = innerVditor()?.toolbar?.elements?.preview?.children[0]
  return preview?.classList.contains('vditor-menu--current') === true
}

function stateFor(target: CommandTarget | null): SubscriptPlan | null {
  if (!target) return null
  const source = target.snapshot.slice(
    target.leaf.startOffset,
    target.leaf.endOffset,
  )
  return planHtmlSubscript(
    source,
    target.anchor - target.leaf.startOffset,
    target.focus - target.leaf.startOffset,
  )
}

/** Vditor's visual HTML markers add editor-only zero-width placeholders around inline tokens. */
function visualSourceText(text: string): string {
  return text.replaceAll('\u200b', '')
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: maps raw SV source leaves and visual marker placeholders without serializing selection changes
function quickPlan(
  editor: HTMLElement,
  range: Range,
  backward: boolean,
): SubscriptPlan | null {
  if (
    !editor.contains(range.startContainer) ||
    !editor.contains(range.endContainer)
  )
    return null
  const inner = innerVditor()
  if (inner?.currentMode === 'sv') {
    const source = editor.textContent ?? ''
    const before = range.cloneRange()
    before.selectNodeContents(editor)
    before.setEnd(range.startContainer, range.startOffset)
    const start = before.toString().length
    const end = start + range.toString().length
    const selection = sourceLeafSelection(source, {
      markdown: source,
      startOffset: start,
      endOffset: end,
      caretOffset: backward ? start : end,
    })
    if (!selection) return null
    return planHtmlSubscript(
      selection.markdown.slice(selection.startOffset, selection.endOffset),
      (backward ? end : start) - selection.startOffset,
      (backward ? start : end) - selection.startOffset,
    )
  }
  const leaf = findLeaf(editor, range)
  if (!leaf) return null
  const before = range.cloneRange()
  before.selectNodeContents(leaf)
  before.setEnd(range.startContainer, range.startOffset)
  const start = visualSourceText(before.toString()).length
  const end = start + visualSourceText(range.toString()).length
  return planHtmlSubscript(
    visualSourceText(leaf.textContent ?? ''),
    backward ? end : start,
    backward ? start : end,
  )
}

function restoreToolbarSelectionOrigin(
  origin: ToolbarSelectionOrigin,
): boolean {
  const selection = document.getSelection()
  if (!selection) return false
  try {
    selection.setBaseAndExtent(
      origin.backward ? origin.range.endContainer : origin.range.startContainer,
      origin.backward ? origin.range.endOffset : origin.range.startOffset,
      origin.backward ? origin.range.startContainer : origin.range.endContainer,
      origin.backward ? origin.range.startOffset : origin.range.endOffset,
    )
    return true
  } catch {
    return false
  }
}

function rollback(target: CommandTarget, scrollTop: number): void {
  target.outer.setValue(target.snapshot)
  const editor = activeModeElement(target.outer)
  if (editor) findScroller(editor).scrollTop = scrollTop
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: retains the transactional rollback and exact-selection guards together
function runHtmlSubscriptCommand(
  deps: HtmlSubscriptCommandDeps,
  retained: CommandTarget | null,
): boolean {
  try {
    if (!retained || previewOpen() || isCompositionActive()) return false
    if (retained.outer.getValue() !== retained.snapshot) return false
    if (!restoreTargetRange(retained)) return false
    const target = captureTarget(deps)
    if (!equivalentTarget(retained, target) || isCompositionActive())
      return false
    const plan = stateFor(target)
    if (!plan?.splices || !plan.selection || previewOpen()) return false
    const source = target.snapshot.slice(
      target.leaf.startOffset,
      target.leaf.endOffset,
    )
    const resultLeaf = applySplices(source, plan.splices)
    if (resultLeaf === null) return false
    const result =
      target.snapshot.slice(0, target.leaf.startOffset) +
      resultLeaf +
      target.snapshot.slice(target.leaf.endOffset)
    // Resolve the selected table identity before setValue replaces the live Range endpoints.
    // The detached unmarked render is the only accepted canonical form for a table transaction.
    const canonical = tableCanonicalMarkdown(target, result)
    const anchor = target.leaf.startOffset + plan.selection.anchor
    const focus = target.leaf.startOffset + plan.selection.focus
    const marked = placeMarkers(result, anchor, focus)
    const scroller = findScroller(target.editor)
    const scrollTop = scroller.scrollTop
    deps.setApplying(true)
    try {
      checkpointEditorUndo(target.inner)
      let applied: boolean
      if (target.mode === 'sv')
        applied = replaceSvMarkdownRange(target.editor, target.snapshot, {
          markdown: marked.markdown,
          caretOffset: focus,
        })
      else {
        target.outer.setValue(marked.markdown)
        applied = true
      }
      const fresh = activeModeElement(target.outer)
      const endpoints = fresh
        ? removeMarkers(fresh, marked.anchorMarker, marked.focusMarker)
        : null
      const expected = canonical ?? result
      if (
        !applied ||
        !fresh ||
        !endpoints ||
        (target.mode === 'sv' && fresh.textContent !== result) ||
        target.outer.getValue() !== expected
      ) {
        rollback(target, scrollTop)
        return false
      }
      if (!setDirectionalSelection(fresh, endpoints.anchor, endpoints.focus)) {
        rollback(target, scrollTop)
        return false
      }
      // The patched undo bridge captures/restores both directional endpoints, so this checkpoint
      // keeps native history without reducing the action's range to Vditor's start caret.
      checkpointEditorUndo(target.inner)
      if (anchor === focus) {
        // Vditor's collapsed undo bridge cannot name the transient empty Text node left between
        // newly inserted inline markers. Its structural fallback therefore lands before the pair;
        // retire that finished checkpoint intent and restore the exact source caret for native input.
        invalidateCaret()
        if (
          !setDirectionalSelection(fresh, endpoints.anchor, endpoints.focus)
        ) {
          rollback(target, scrollTop)
          return false
        }
      }
      const nextScroller = findScroller(fresh)
      nextScroller.scrollTop = Math.min(
        scrollTop,
        Math.max(0, nextScroller.scrollHeight - nextScroller.clientHeight),
      )
    } finally {
      deps.setApplying(false)
    }
    deps.invalidate()
    deps.scheduleSync()
    return true
  } catch (error) {
    deps.onError(error)
    return false
  }
}

let configuredDeps: HtmlSubscriptCommandDeps | undefined

export function configureHtmlSubscriptCommand(
  deps: HtmlSubscriptCommandDeps,
): void {
  configuredDeps = deps
}

/** Install one retained-selection toolbar handler. The live toolbar reference avoids the transient
 * prerender clone, while the button itself remains valid when overflow reparents its wrapper. */
export function installHtmlSubscriptControls(): () => void {
  const button = innerVditor()?.toolbar?.elements?.subscript?.children[0] as
    | HTMLButtonElement
    | undefined
  let pending: CommandTarget | null = null
  let pendingCaptured = false
  let retainedRange: RetainedLiveRange | null = null
  let frame = 0
  const menuOwnsFocus = () => {
    const active = document.activeElement
    if (!active) return false
    const toolbar = button?.closest('.vditor-toolbar')
    return Boolean(toolbar?.contains(active))
  }
  const restoreRetainedRange = () => {
    if (!retainedRange?.editor.isConnected) return false
    const selection = document.getSelection()
    if (!selection) return false
    try {
      selection.setBaseAndExtent(
        retainedRange.anchorNode,
        retainedRange.anchorOffset,
        retainedRange.focusNode,
        retainedRange.focusOffset,
      )
      return true
    } catch {
      return false
    }
  }
  const captureRetainedTarget = () => {
    if (!restoreRetainedRange()) return null
    return captureTarget(configuredDeps ?? noDeps)
  }
  const captureConsumedOriginTarget = () => {
    const origin = peekConsumedToolbarSelectionOrigin()
    const consumed = consumeToolbarSelectionOrigin()
    if (!consumed) return { consumed: false, target: null }
    if (!origin || !restoreToolbarSelectionOrigin(origin))
      return { consumed: true, target: null }
    return {
      consumed: true,
      target: captureTarget(configuredDeps ?? noDeps),
    }
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: reconciles live, pointer-retained, and keyboard-origin state in one frame
  const update = () => {
    frame = 0
    const selection = document.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const editor = window.vditor ? activeModeElement(window.vditor) : null
    // Deliberately DOM-only: selectionchange is hot. Exact serializer mapping belongs to activation,
    // after the retained Range is restored, so cursor motion cannot serialize the whole document.
    const backward = Boolean(
      selection &&
        range &&
        selection.anchorNode === range.endContainer &&
        selection.anchorOffset === range.endOffset,
    )
    const plan = editor && range ? quickPlan(editor, range, backward) : null
    const liveEnabled = Boolean(
      !previewOpen() &&
        !isCompositionActive() &&
        editor &&
        range &&
        plan?.splices &&
        plan.selection,
    )
    const pendingPlan =
      pendingCaptured &&
      pending &&
      menuOwnsFocus() &&
      !previewOpen() &&
      !isCompositionActive()
        ? stateFor(pending)
        : null
    const origin = menuOwnsFocus() ? peekConsumedToolbarSelectionOrigin() : null
    const originPlan = origin
      ? quickPlan(origin.editor, origin.range, origin.backward)
      : null
    const pendingEnabled = Boolean(
      pendingCaptured && pendingPlan?.splices && pendingPlan.selection,
    )
    const originEnabled = Boolean(originPlan?.splices && originPlan.selection)
    const enabled = liveEnabled || pendingEnabled || originEnabled
    const displayedPlan = plan ?? pendingPlan ?? originPlan
    if (button) {
      button.disabled = !enabled
      button.setAttribute('aria-disabled', String(!enabled))
      button.setAttribute(
        'aria-pressed',
        displayedPlan?.state === 'mixed'
          ? 'mixed'
          : String(displayedPlan?.state === 'active'),
      )
      button.classList.toggle(
        'vditor-menu--current',
        displayedPlan?.state === 'active',
      )
    }
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update)
  }
  const onPointerDown = () => {
    const outer = window.vditor
    const editor = outer ? activeModeElement(outer) : null
    const selection = document.getSelection()
    const liveEditorSelection = Boolean(
      editor &&
        selection?.anchorNode &&
        selection.focusNode &&
        editor.contains(selection.anchorNode) &&
        editor.contains(selection.focusNode),
    )
    // A pointer activation happens before the toolbar claims focus. Prefer the browser's current
    // editor Range so a delayed selectionchange cannot format the prior retained range.
    pending = liveEditorSelection
      ? captureTarget(configuredDeps ?? noDeps)
      : captureRetainedTarget()
    pendingCaptured = true
  }
  const onPointerCancel = () => {
    pending = null
    pendingCaptured = false
    schedule()
  }
  const onToggle = () => {
    if (configuredDeps) {
      const origin = pendingCaptured ? null : captureConsumedOriginTarget()
      runHtmlSubscriptCommand(
        configuredDeps,
        pendingCaptured
          ? pending
          : origin?.consumed
            ? origin.target
            : captureRetainedTarget(),
      )
    }
    pending = null
    pendingCaptured = false
    schedule()
  }
  const onInput = () => {
    // A DOM input event means the raw endpoint snapshot no longer identifies the document that
    // supplied it. This includes browser-generated and test/extension-mediated edits: command
    // activation must take a new editor selection rather than formatting stale text.
    retainedRange = null
    pending = null
    pendingCaptured = false
    schedule()
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: preserves selection ownership across editor and toolbar focus sentinels
  const onSelectionChange = () => {
    const outer = window.vditor
    const editor = outer ? activeModeElement(outer) : null
    const selection = document.getSelection()
    const belongsToEditor = Boolean(
      editor &&
        selection?.anchorNode &&
        selection.focusNode &&
        editor.contains(selection.anchorNode) &&
        editor.contains(selection.focusNode),
    )
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const backward = Boolean(
      selection &&
        range &&
        selection.anchorNode === range.endContainer &&
        selection.anchorOffset === range.endOffset,
    )
    const supported = Boolean(
      editor && range && quickPlan(editor, range, backward),
    )
    const editorRootSentinel = Boolean(
      editor &&
        range?.collapsed &&
        range.startContainer === editor &&
        range.endContainer === editor,
    )
    if (belongsToEditor && !editorRootSentinel) {
      if (editor && selection?.anchorNode && selection.focusNode && supported)
        retainedRange = {
          editor,
          anchorNode: selection.anchorNode,
          anchorOffset: selection.anchorOffset,
          focusNode: selection.focusNode,
          focusOffset: selection.focusOffset,
        }
      else {
        retainedRange = null
        pending = null
        pendingCaptured = false
      }
    } else if (menuOwnsFocus()) {
      // Opening More and keyboarding to this control can replace the editor range with a toolbar
      // focus sentinel. Keep only the previous raw editor endpoints; activation maps them exactly.
    } else {
      retainedRange = null
    }
    schedule()
  }
  button?.addEventListener('pointerdown', onPointerDown, true)
  button?.addEventListener('pointercancel', onPointerCancel, true)
  document.addEventListener('vmde-toggle-subscript', onToggle)
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('input', onInput, true)
  schedule()
  return () => {
    if (frame) cancelAnimationFrame(frame)
    button?.removeEventListener('pointerdown', onPointerDown, true)
    button?.removeEventListener('pointercancel', onPointerCancel, true)
    document.removeEventListener('vmde-toggle-subscript', onToggle)
    document.removeEventListener('selectionchange', onSelectionChange)
    document.removeEventListener('input', onInput, true)
  }
}

const noDeps: HtmlSubscriptCommandDeps = {
  setApplying: () => undefined,
  invalidate: () => undefined,
  scheduleSync: () => undefined,
  onError: () => undefined,
}
