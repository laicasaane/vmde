import { hasLiveCaretIntent, invalidateCaret, requestCaret } from './caret'
import { activeModeElement } from '../util/source-map'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import {
  guardComposition,
  isCompositionActive,
  subscribeCompositionState,
} from '../util/caret-gesture'
import { placeCaretInGap } from './gap-nav'
import { isAtomicBlock, isHelper } from './trailing-paragraph'

// Reveal-in-Source (task 16): remember the caret inside the editor. When the
// command runs from VS Code chrome (the toolbar button), focus leaves the
// webview iframe and the live selection collapses to the editor start — so the
// raw selection would read as offset 0. We snapshot the last in-editor caret on
// selectionchange and restore it before measuring, so the button and the command
// palette resolve to the SAME caret. Stored as a cloned Range.
let lastEditorRange: Range | null = null

function trackEditorCaret() {
  const v = window.vditor
  if (!v) return
  const editor = activeModeElement(v)
  if (!editor) return
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const node = sel.anchorNode
  if (!node || !editor.contains(node)) return
  // ignore a caret collapsed to the very start of the editor (the focus-loss
  // artifact we are guarding against) so it can't overwrite a real position
  if (node === editor && sel.anchorOffset === 0 && sel.isCollapsed) return
  lastEditorRange = sel.getRangeAt(0).cloneRange()
}

// Wire the selectionchange snapshot. Called once from main.ts (the caret state is
// a singleton across re-inits — it tracks whatever editor is currently mounted).
export function installEditorCaretTracking(): void {
  document.addEventListener('selectionchange', trackEditorCaret)
}

const EXPAND_CLASS = 'vditor-ir__node--expand'
const MARKER_DWELL_MS = 100

interface MarkerRevealRuntime {
  document: Document
  getVditor(): InnerVditor | null
  requestFrame(callback: FrameRequestCallback): number
  cancelFrame(handle: number): void
  setDwell(callback: () => void, delay: number): number
  clearDwell(handle: number): void
  compositionActive(): boolean
  now(): number
  isTrustedKey(event: KeyboardEvent): boolean
  subscribeComposition(listener: (active: boolean) => void): () => void
}

const defaultMarkerRevealRuntime = (): MarkerRevealRuntime => ({
  document,
  getVditor: innerVditor,
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  setDwell: (callback, delay) => window.setTimeout(callback, delay),
  clearDwell: (handle) => window.clearTimeout(handle),
  compositionActive: isCompositionActive,
  now: () => performance.now(),
  isTrustedKey: (event) => event.isTrusted,
  subscribeComposition: subscribeCompositionState,
})

function selectedRangeInIr(
  runtime: MarkerRevealRuntime,
  vditor: InnerVditor,
): { editor: HTMLElement; range: Range } | null {
  if (vditor.currentMode !== 'ir' || vditor.ir?.composingLock) return null
  const editor = vditor.ir?.element
  const selection = runtime.document.getSelection()
  if (!editor || !selection?.rangeCount) return null
  const range = selection.getRangeAt(0).cloneRange()
  if (
    !range.startContainer.isConnected ||
    !range.endContainer.isConnected ||
    !editor.contains(range.startContainer) ||
    !editor.contains(range.endContainer)
  )
    return null
  return { editor, range }
}

function sameRange(a: Range | null, b: Range): boolean {
  return Boolean(
    a &&
      a.startContainer === b.startContainer &&
      a.startOffset === b.startOffset &&
      a.endContainer === b.endContainer &&
      a.endOffset === b.endOffset,
  )
}

function closestElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement
}

function topIrNode(node: Node): HTMLElement | null {
  let element = closestElement(node)
  let target: HTMLElement | null = null
  while (element && !element.classList.contains('vditor-reset')) {
    if (element.classList.contains('vditor-ir__node'))
      target = element as HTMLElement
    element = element.parentElement
  }
  return target
}

function isInlineIrNode(node: Node | null): node is HTMLElement {
  return Boolean(
    node instanceof HTMLElement &&
      node.classList.contains('vditor-ir__node') &&
      !node.hasAttribute('data-block'),
  )
}

function nextInlineNode(range: Range): HTMLElement | null {
  const start = range.startContainer
  if (
    start.nodeType !== Node.TEXT_NODE ||
    range.startOffset !== (start as Text).data.length
  )
    return null

  let sibling = start.nextSibling
  while (sibling && (sibling.textContent ?? '') === '')
    sibling = sibling.nextSibling
  if (sibling) return isInlineIrNode(sibling) ? sibling : null

  const marker =
    closestElement(start)?.closest<HTMLElement>('.vditor-ir__marker')
  const node = marker?.closest<HTMLElement>('.vditor-ir__node')
  const next = node?.nextSibling ?? null
  return marker && !marker.nextSibling && isInlineIrNode(next) ? next : null
}

function previousInlineNode(range: Range): HTMLElement | null {
  const start = range.startContainer
  if (start.nodeType !== Node.TEXT_NODE || range.startOffset !== 0) return null
  const previous = start.previousSibling
  return isInlineIrNode(previous) ? previous : null
}

function markerTargets(range: Range): Set<HTMLElement> {
  const current = topIrNode(range.startContainer)
  const end = range.collapsed ? current : topIrNode(range.endContainer)
  if (!range.collapsed && (!current || current !== end)) return new Set()

  const targets = new Set<HTMLElement>()
  if (current) targets.add(current)
  const adjacent = nextInlineNode(range) ?? previousInlineNode(range)
  if (adjacent) targets.add(adjacent)
  return targets
}

interface MarkerNormalization {
  previouslyExpanded: ReadonlySet<HTMLElement>
  allowVisibleMarkerEdit: boolean
  // Only the last IR-targeted Arrow keydown applies, and only for one frame.
  arrowStep: boolean
  previousRange: Range | null
}

interface CaretTarget {
  node: Node
  offset: number
}

function placeNormalizedCaret(target: CaretTarget, fallback: Range): Range {
  requestCaret(target)
  const selection = window.getSelection()
  const normalized = selection?.rangeCount
    ? selection.getRangeAt(0).cloneRange()
    : fallback
  // This is a one-shot normalization of a native selection movement, not a caret intent that may
  // override the next programmatic navigation. Keep the ADR-owned writer but retire its retry loop
  // immediately after the synchronous placement succeeds.
  invalidateCaret()
  return normalized
}

// Pick source content rather than syntax or rendered previews: either would put the normalized
// caret back in a marker or outside editable content. Nonempty text, including ZWSP, is content.
function isBlockContent(child: Node): boolean {
  if (child.nodeType === Node.TEXT_NODE) return (child as Text).data.length > 0
  return (
    child instanceof HTMLElement &&
    !child.classList.contains('vditor-ir__marker') &&
    !child.hasAttribute('data-render')
  )
}

// Block markers live inside the block. Find the marker's direct-child slot, then land on the
// block's own content edge (after leading syntax, before trailing syntax), never its parent:
// the parent of a top-level heading is the editor root and cannot safely receive inline formats.
function blockContentEdge(
  node: HTMLElement,
  marker: HTMLElement,
): CaretTarget | null {
  let slot: Node = marker
  while (slot.parentNode && slot.parentNode !== node) slot = slot.parentNode
  const children: Node[] = Array.from(node.childNodes)
  const index = children.indexOf(slot)
  if (index < 0) return null
  const leading = !children.slice(0, index).some(isBlockContent)
  const content = (
    leading ? children.slice(index + 1) : children.slice(0, index).reverse()
  ).find(isBlockContent)
  if (!content) return { node, offset: leading ? index + 1 : index }
  if (content instanceof Text)
    return { node: content, offset: leading ? 0 : content.data.length }
  const at = children.indexOf(content)
  return { node, offset: leading ? at : at + 1 }
}

// Repair block-marker landings locally while retaining Vditor's syntax-editing navigation.
// The content-edge write is reserved for landings that are not one of those editable paths.
function normalizeBlockMarker(
  range: Range,
  node: HTMLElement,
  marker: HTMLElement,
  options: MarkerNormalization,
): Range {
  // Fence info is editable source. Vditor's IR processKeydown code-block-info branch owns
  // Enter/Tab into code and ArrowUp/Left into insertBeforeBlock; relocating it traps ArrowUp.
  if (marker.classList.contains('vditor-ir__marker--info')) return range
  // An Arrow step from inside an already-expanded block walks visible syntax. Normalizing
  // that step would bounce ArrowLeft/ArrowRight back to the content edge forever.
  const previous = options.previousRange?.startContainer
  if (
    options.arrowStep &&
    options.previouslyExpanded.has(node) &&
    previous?.isConnected &&
    node.contains(previous)
  )
    return range
  const target = blockContentEdge(node, marker)
  return target ? placeNormalizedCaret(target, range) : range
}

function normalizeMarkerNavigationCaret(
  range: Range,
  options: MarkerNormalization,
): Range {
  const { previouslyExpanded, allowVisibleMarkerEdit } = options
  if (!range.collapsed) return range
  const start =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement
  const marker = start?.closest<HTMLElement>('.vditor-ir__marker')
  const node = marker?.closest<HTMLElement>('.vditor-ir__node')
  if (
    !marker ||
    marker.classList.contains('vditor-ir__marker--pre') ||
    // An empty expanded Link URL is the insertion target after selected-text Link.
    // Treating it as hidden syntax immediately ejects the freshly placed caret.
    (marker.classList.contains('vditor-ir__marker--link') &&
      marker.textContent === '' &&
      node?.classList.contains(EXPAND_CLASS)) ||
    !node ||
    (allowVisibleMarkerEdit && previouslyExpanded.has(node)) ||
    !node.parentNode
  )
    return range

  if (node.hasAttribute('data-block'))
    return normalizeBlockMarker(range, node, marker, options)

  const markers = Array.from(
    node.querySelectorAll<HTMLElement>(':scope > .vditor-ir__marker'),
  )
  const markerIndex = markers.indexOf(marker)
  const before = markerIndex < 0 || markerIndex < markers.length / 2
  const siblings = Array.from(node.parentNode.childNodes)
  const nodeIndex = siblings.indexOf(node)
  if (nodeIndex < 0) return range

  return placeNormalizedCaret(
    { node: node.parentNode, offset: nodeIndex + (before ? 0 : 1) },
    range,
  )
}

// Task 608 — a trusted navigation keydown that leaves the caret on the bare editable root.
// Lute renders a thematic break (and a TOC) as a block with no text position, so the native move
// out of or around one can park a collapsed caret on the editor itself, where no block marker
// exists for the normalizer above. The key's direction picks the landing; a programmatic root
// range never reaches this (no keydown, no normalization: Tasks 439/446/490, Task 600's seeds).
type NavDirection = 'forward' | 'backward'

const NAV_KEY_DIRECTION: Record<string, NavDirection> = {
  ArrowRight: 'forward',
  ArrowDown: 'forward',
  PageDown: 'forward',
  End: 'forward',
  ArrowLeft: 'backward',
  ArrowUp: 'backward',
  PageUp: 'backward',
  Home: 'backward',
}
// The keydown and the selection change it causes land in one frame; a key that moved nothing
// must not arm the next, unrelated selection change.
const NAV_KEY_WINDOW_MS = 250

// A block with no caret position at all: a rule, or the non-editable TOC.
const isVoidBlock = (el: Element): boolean =>
  el.tagName === 'HR' || el.getAttribute('contenteditable') === 'false'

// The caret position at the near edge of a text block's own content: skips syntax markers and
// rendered previews, so a heading is entered after its `#` rather than before it.
function textBlockEdge(block: HTMLElement, atEnd: boolean): CaretTarget {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (text) =>
      (text as Text).data.length > 0 &&
      !(
        text.parentElement?.closest('.vditor-ir__marker, [data-render]') ?? null
      )
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  })
  let found: Text | null = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    found = n as Text
    if (!atEnd) break
  }
  if (found) return { node: found, offset: atEnd ? found.data.length : 0 }
  return { node: block, offset: atEnd ? block.childNodes.length : 0 }
}

// Walk away from the root landing in the key's direction: skip void blocks, land at the near edge
// of the first text block, stop at a boundary no caret can reach (gap paragraph), and leave
// anything else (a code block, a table: they hold their own caret) to the native move. Backward
// off the start of the document ends at the boundary-0 gap, as ArrowUp does; forward off the end
// is the trailing invariant's boundary.
function rootNavigationLanding(
  editor: HTMLElement,
  offset: number,
  direction: NavDirection,
): boolean {
  const forward = direction === 'forward'
  const nodes = Array.from(editor.childNodes)
  const sequence = (
    forward ? nodes.slice(offset) : nodes.slice(0, offset)
  ).filter((n): n is HTMLElement => n instanceof HTMLElement && !isHelper(n))
  if (!forward) sequence.reverse()
  let crossed: HTMLElement | null = null
  for (const el of sequence) {
    if (!isAtomicBlock(el)) return requestCaret(textBlockEdge(el, !forward))
    // Two atomic blocks side by side offer no caret position between them (needsGap): the gap
    // paragraph is the only stop there.
    if (crossed)
      return forward
        ? placeCaretInGap(crossed, el)
        : placeCaretInGap(el, crossed)
    if (!isVoidBlock(el)) return false
    crossed = el
  }
  if (forward) return false
  // Off the start of the document: the first block decides, a text block takes the caret at its
  // start, anything atomic gets the boundary-0 gap (as ArrowUp opens it).
  const first = nodes.find(
    (n): n is HTMLElement => n instanceof HTMLElement && !isHelper(n),
  )
  if (!first) return false
  return isAtomicBlock(first)
    ? placeCaretInGap(null, first)
    : requestCaret(textBlockEdge(first, false))
}

// Returns the range after the move, or null when the selection was not a bare-root caret on a
// document that has blocks (the empty editor keeps Vditor's own paths) or a caret intent is live.
function normalizeRootNavigation(
  editor: HTMLElement,
  range: Range,
  direction: NavDirection,
): Range | null {
  if (
    !range.collapsed ||
    range.startContainer !== editor ||
    hasLiveCaretIntent() ||
    !Array.from(editor.children).some((child) =>
      child.hasAttribute('data-block'),
    )
  )
    return null
  if (!rootNavigationLanding(editor, range.startOffset, direction)) return null
  const selection = window.getSelection()
  const landed = selection?.rangeCount
    ? selection.getRangeAt(0).cloneRange()
    : null
  // One-shot: a native movement was repaired, not a caret intent to keep re-asserting.
  invalidateCaret()
  return landed
}

/**
 * Reveal IR Markdown markers from the live selection instead of a key whitelist. Selection changes
 * are frame-coalesced so Home/End/Page navigation, pointer drags, and programmatic caret moves all
 * share one path. Previously expanded nodes survive until the caret has dwelled elsewhere for
 * 100 ms, preventing arrow traversal from flashing collapsed render/source states between keys.
 */
export function installIrMarkerReveal(
  overrides: Partial<MarkerRevealRuntime> = {},
): () => void {
  const runtime = { ...defaultMarkerRevealRuntime(), ...overrides }
  let frame = 0
  let dwell = 0
  let generation = 0
  let lastRange: Range | null = null
  let lastCurrent = new Set<HTMLElement>()
  let dwellPrevious = new Set<HTMLElement>()
  let pendingComposition = false
  let allowVisibleMarkerEdit = false
  let arrowStep = false
  let navDirection: NavDirection | null = null
  let navAt = 0

  const clearDwell = () => {
    if (!dwell) return
    runtime.clearDwell(dwell)
    dwell = 0
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one frame reconciles composition, rebuilt ranges, marker ownership, and dwell cleanup
  const apply = () => {
    const stepping = arrowStep
    arrowStep = false
    const navigating =
      navDirection && runtime.now() - navAt <= NAV_KEY_WINDOW_MS
        ? navDirection
        : null
    navDirection = null
    frame = 0
    if (runtime.compositionActive()) {
      pendingComposition = true
      return
    }
    const vditor = runtime.getVditor()
    if (!vditor) return
    const selected = selectedRangeInIr(runtime, vditor)
    if (!selected) {
      // `compositionend` clears VMDE's capture-phase authority before Vditor clears its own
      // bubble-phase lock. One more frame lets that synchronous input/spin finish before we read
      // or write marker classes; disconnected mid-spin ranges otherwise fail closed here.
      if (vditor.currentMode === 'ir' && vditor.ir?.composingLock) schedule()
      return
    }
    const range = navigating
      ? (normalizeRootNavigation(selected.editor, selected.range, navigating) ??
        selected.range)
      : selected.range
    if (
      sameRange(lastRange, range) &&
      [...lastCurrent].every(
        (node) => node.isConnected && node.classList.contains(EXPAND_CLASS),
      )
    ) {
      allowVisibleMarkerEdit = false
      return
    }

    const current = markerTargets(range)
    const managedBefore = new Set(
      [...lastCurrent, ...dwellPrevious].filter((node) => node.isConnected),
    )
    const previouslyExpanded = new Set(
      [...current].filter(
        (node) =>
          managedBefore.has(node) || node.classList.contains(EXPAND_CLASS),
      ),
    )
    for (const node of current) {
      node.classList.add(EXPAND_CLASS)
      node.classList.remove('vditor-ir__node--hidden')
    }
    // Task 532 replaces stock expandMarker here because that helper globally collapses every
    // expanded node and rewrites the Selection. The controller already knows the only nodes it
    // owns, so recurring input reconciles those local identities and leaves the live caret alone.
    dwellPrevious = new Set(
      [...managedBefore].filter((node) => !current.has(node)),
    )
    const normalizedRange = normalizeMarkerNavigationCaret(range, {
      previouslyExpanded,
      allowVisibleMarkerEdit: allowVisibleMarkerEdit || hasLiveCaretIntent(),
      arrowStep: stepping,
      previousRange: lastRange,
    })
    allowVisibleMarkerEdit = false

    lastRange = normalizedRange
    lastCurrent = current
    const appliedGeneration = ++generation
    clearDwell()
    const expiring = new Set(dwellPrevious)
    dwell = runtime.setDwell(() => {
      dwell = 0
      if (appliedGeneration !== generation || runtime.compositionActive())
        return
      for (const node of expiring) {
        if (node.isConnected && !lastCurrent.has(node))
          node.classList.remove(EXPAND_CLASS)
        dwellPrevious.delete(node)
      }
    }, MARKER_DWELL_MS)
  }

  const schedule = () => {
    if (frame) return
    frame = runtime.requestFrame(apply)
  }
  const onSelectionChange = () => schedule()
  const onPointerDown = () => {
    allowVisibleMarkerEdit = true
    arrowStep = false
    navDirection = null
  }
  const onBeforeInput = () => {
    allowVisibleMarkerEdit = true
    arrowStep = false
    navDirection = null
  }
  const onKeyDown = (event: KeyboardEvent) => {
    allowVisibleMarkerEdit = false
    const editor = runtime.getVditor()?.ir?.element
    arrowStep =
      event.key.startsWith('Arrow') &&
      event.target instanceof Node &&
      Boolean(editor?.contains(event.target))
    navDirection =
      !guardComposition(event) &&
      runtime.isTrustedKey(event) &&
      event.target instanceof Node &&
      editor?.contains(event.target)
        ? (NAV_KEY_DIRECTION[event.key] ?? null)
        : null
    navAt = runtime.now()
  }
  const unsubscribeComposition = runtime.subscribeComposition((active) => {
    if (active) {
      pendingComposition = true
      clearDwell()
      return
    }
    if (pendingComposition) {
      pendingComposition = false
      lastRange = null
      schedule()
    }
  })

  runtime.document.addEventListener('selectionchange', onSelectionChange)
  runtime.document.addEventListener('pointerdown', onPointerDown, true)
  runtime.document.addEventListener('beforeinput', onBeforeInput, true)
  runtime.document.addEventListener('keydown', onKeyDown, true)
  return () => {
    runtime.document.removeEventListener('selectionchange', onSelectionChange)
    runtime.document.removeEventListener('pointerdown', onPointerDown, true)
    runtime.document.removeEventListener('beforeinput', onBeforeInput, true)
    runtime.document.removeEventListener('keydown', onKeyDown, true)
    unsubscribeComposition()
    if (frame) runtime.cancelFrame(frame)
    clearDwell()
  }
}

// The last caret seen INSIDE the editor, without touching the live selection. Task 390 needs it
// because WYSIWYG's link button opens a popover and focuses its input, so by the time the debounced
// edit posts, the live selection is in that input and the edited block can no longer be resolved
// from it.
export function trackedEditorRange(): Range | null {
  return lastEditorRange
}

// Restore the remembered caret when the live selection is missing or collapsed
// to the editor start (focus left the iframe). Returns true if a restore ran.
//
// The write goes through caret.ts's requestCaret (ADR-0007 / task 446) instead of a hand-rolled
// removeAllRanges()/addRange() — this module is one of the six the ADR names as a former direct
// writer. The snapshot mechanism above (trackEditorCaret / lastEditorRange / trackedEditorRange)
// stays here unchanged: it only ever READS the selection, so it's outside the ADR's scope (every
// programmatic selection WRITE), and task 390's link path reads trackedEditorRange() directly.
export function restoreEditorCaretIfLost(): boolean {
  const v = window.vditor
  if (!v || !lastEditorRange) return false
  const editor = activeModeElement(v)
  if (!editor) return false
  const sel = window.getSelection()
  const node = sel && sel.rangeCount > 0 ? sel.anchorNode : null
  const live = node && editor.contains(node)
  const collapsedAtStart =
    node === editor && sel!.anchorOffset === 0 && sel!.isCollapsed
  if (live && !collapsedAtStart) return false // a real caret is present; keep it
  return requestCaret({
    node: lastEditorRange.startContainer,
    offset: lastEditorRange.startOffset,
  })
}
