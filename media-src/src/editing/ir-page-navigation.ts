import { invalidateCaret, requestCaret } from './caret'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { guardComposition, isCompositionActive } from '../util/caret-gesture'

// Task 612 — PageUp/PageDown stall repair for the IR editor.
//
// Chromium's native page move steps line by line from a goal x and stops early when the next caret
// position has no usable line box. Next to a collapsed inline-code node (Task 369 takes its markers
// out of flow) that left the caret where it was — zero travel — in the plain editor and in real
// VS Code. Changing the marker CSS cannot fix it without bringing back the line-break opportunity
// Task 369 removed (measured: a word joiner or `white-space` change does not remove it), so the
// move is repaired here instead: the native move still runs, and only a press that visibly stalled
// is redone from the position it started at.
//
// Contract (VS Code text editor): a page key moves the caret about one viewport of visual lines,
// scrolls by the same amount, keeps the goal x across consecutive presses, and Shift+PageUp/PageDown
// extends from a fixed anchor. The landing is left to the Task 286 marker normalizer (editor-caret.ts).

// Blink's native page step: 87.5% of the visible height. The repair uses the same distance so a
// repaired press and a native press travel alike.
const PAGE_FRACTION = 0.875
// A press that moved less than this share of the distance it should have is a stall. Measured native
// travel next to markers is 0.74 and above (the strong-marker PageDown), stalls are 0 to 0.46.
const STALL_RATIO = 0.75
// Keys must have been pressed this recently for the settled caret to count as their result.
const KEY_WINDOW_MS = 400

type Direction = 'up' | 'down'

export interface PageGeometry {
  /** Caret top in scroller content coordinates before the key. */
  caretY: number
  lineHeight: number
  clientHeight: number
  scrollHeight: number
  scrollTop: number
  /** Content-coordinate top of the first line and top of the last line. */
  firstLineY: number
  lastLineY: number
}

export interface PagePlan {
  /** Scroll offset that brings the landing line into view for the hit test. */
  scrollTop: number
  /** Content-coordinate y to hit-test for the landing line (see planPagePress). */
  targetY: number
  /** Distance the press can travel before the document edge. */
  expectedTravel: number
  /** The repair has nothing to do: the caret is within two lines of the document edge. */
  atEdge: boolean
}

/** Pure geometry of one page press. */
export function planPagePress(
  direction: Direction,
  geometry: PageGeometry,
): PagePlan {
  const sign = direction === 'up' ? -1 : 1
  const step = Math.max(
    geometry.lineHeight,
    geometry.clientHeight * PAGE_FRACTION,
  )
  const room =
    direction === 'up'
      ? geometry.caretY - geometry.firstLineY
      : geometry.lastLineY - geometry.caretY
  const expectedTravel = Math.max(0, Math.min(step, room))
  const targetY = Math.min(
    geometry.lastLineY,
    Math.max(geometry.firstLineY, geometry.caretY + sign * step),
  )
  // The offset used only to hit-test: the least scrolling that puts the aimed line in view with one
  // line of margin. The final offset is set from the line that was actually hit (alignScrollTop).
  const maxScroll = Math.max(0, geometry.scrollHeight - geometry.clientHeight)
  const margin = geometry.lineHeight
  let scrollTop = geometry.scrollTop
  if (targetY - margin < scrollTop) scrollTop = targetY - margin
  else if (
    targetY + geometry.lineHeight + margin >
    scrollTop + geometry.clientHeight
  )
    scrollTop = targetY + geometry.lineHeight + margin - geometry.clientHeight
  scrollTop = Math.min(maxScroll, Math.max(0, scrollTop))
  // Where to hit-test. Native paging lands on the last line that does not overshoot the page step
  // (no overshoot, no short fall past a line's gap): aim at the step distance itself going down, and
  // one line further in going up, so a point in the gap between lines picks the nearer line that
  // stays within the step. Measured: matches the native move in the same document.
  const hitY = direction === 'up' ? targetY + geometry.lineHeight : targetY
  return {
    scrollTop,
    targetY: hitY,
    expectedTravel,
    atEdge: room < geometry.lineHeight * 2,
  }
}

/**
 * The scroll offset after a page key. Measured on the native move (plain text, caret at every row of
 * the view, both directions): the landing line is aligned with the top of the view, limited to the
 * scrollable range. A repaired press scrolls the same way.
 */
export function alignScrollTop(
  lineTop: number,
  clientHeight: number,
  scrollHeight: number,
): number {
  return Math.min(
    Math.max(0, scrollHeight - clientHeight),
    Math.max(0, lineTop),
  )
}

/** Whether the native press moved clearly less than it should have (and was not stopped by an edge). */
export function isStalledPress(
  plan: Pick<PagePlan, 'expectedTravel' | 'atEdge'>,
  moved: number,
): boolean {
  return !plan.atEdge && moved < plan.expectedTravel * STALL_RATIO
}

const isMarker = (node: Node): boolean =>
  node instanceof HTMLElement && node.classList.contains('vditor-ir__marker')

// Whether a sibling run holds nothing the caret could sit next to but markers and empty text.
function onlyMarkers(
  sibling: Node | null,
  step: 'nextSibling' | 'previousSibling',
) {
  for (let node = sibling; node; node = node[step]) {
    if (isMarker(node) || (node.textContent ?? '') === '') continue
    return false
  }
  return true
}

/**
 * A page landing at the very start or end of an inline node's text sits between the node's content
 * and its hidden marker. Typing there would put the character inside the formatting (`**bold7P**`),
 * while End and Home leave the caret outside it (Task 286). Move such a landing to the outer edge of
 * the outermost inline IR node it touches; the position looks the same and the Task 648 reveal
 * still expands the neighbouring node.
 */
export function landingOutsideInlineNode(
  node: Node,
  offset: number,
): { node: Node; offset: number } | null {
  if (node.nodeType !== Node.TEXT_NODE) return null
  const length = (node as Text).data.length
  const atEnd = offset === length
  if (!atEnd && offset !== 0) return null
  const step = atEnd ? 'nextSibling' : 'previousSibling'
  let current: Node = node
  let edge: { node: Node; offset: number } | null = null
  while (current.parentNode && onlyMarkers(current[step], step)) {
    const parent: Node = current.parentNode
    if (!(parent instanceof HTMLElement) || parent.hasAttribute('data-block'))
      break
    if (
      parent.classList.contains('vditor-ir__node') &&
      parent.parentNode &&
      !parent.hasAttribute('data-block')
    ) {
      const index = Array.from(parent.parentNode.childNodes).indexOf(parent)
      edge = { node: parent.parentNode, offset: index + (atEnd ? 1 : 0) }
    }
    current = parent
  }
  return edge
}

/**
 * Whether a caret hit test result can be written. A hit on the editor root itself has no text
 * position (Task 608 re-lands those only for a key that left the caret there), so the native result
 * is kept instead.
 */
export function isUsableHit(surface: HTMLElement, range: Range): boolean {
  return (
    range.startContainer !== surface && surface.contains(range.startContainer)
  )
}

interface PageRuntime {
  document: Document
  getVditor(): InnerVditor | null
  requestFrame(callback: FrameRequestCallback): number
  cancelFrame(handle: number): void
  compositionActive(): boolean
  now(): number
  isTrustedKey(event: KeyboardEvent): boolean
}

const defaultRuntime = (): PageRuntime => ({
  document,
  getVditor: innerVditor,
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  compositionActive: isCompositionActive,
  now: () => performance.now(),
  isTrustedKey: (event) => event.isTrusted,
})

interface PressStart {
  direction: Direction
  shift: boolean
  at: number
  anchor: { node: Node; offset: number }
  focus: { node: Node; offset: number }
  geometry: PageGeometry
  goalX: number
}

// The first usable client rect of a node: an element's own box, a text node's first line.
function nodeRect(node: Node, doc: Document, last: boolean): DOMRect | null {
  if (node.nodeType === Node.ELEMENT_NODE)
    return (node as Element).getBoundingClientRect()
  const range = doc.createRange()
  range.selectNodeContents(node)
  const rects = range.getClientRects()
  return (last ? rects[rects.length - 1] : rects[0]) ?? null
}

/**
 * The viewport rect of a collapsed position: its own client rect, else (an element position, which
 * is what the Task 286 ejection writes) the child it sits before or after, else its container. The
 * container is the last resort because on a wrapped paragraph it is the paragraph's first row.
 */
export function caretClientRect(
  node: Node,
  offset: number,
  doc: Document,
): DOMRect | null {
  try {
    const probe = doc.createRange()
    probe.setStart(node, offset)
    probe.collapse(true)
    const rect = probe.getClientRects()[0]
    if (rect && (rect.width > 0 || rect.height > 0)) return rect
    const after = node.childNodes[offset]
    const before = node.childNodes[offset - 1]
    const neighbour =
      (after && nodeRect(after, doc, false)) ||
      (before && nodeRect(before, doc, true)) ||
      null
    if (neighbour && (neighbour.width > 0 || neighbour.height > 0))
      return neighbour
    const element =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement
    return element ? element.getBoundingClientRect() : null
  } catch {
    return null
  }
}

function lineHeightOf(surface: HTMLElement): number {
  const style = getComputedStyle(surface)
  const lineHeight = Number.parseFloat(style.lineHeight)
  return Number.isFinite(lineHeight)
    ? lineHeight
    : Number.parseFloat(style.fontSize) * 1.2
}

function pageGeometry(
  surface: HTMLElement,
  caretTop: number,
): PageGeometry | null {
  const lineHeight = lineHeightOf(surface)
  const first = surface.firstElementChild as HTMLElement | null
  const last = surface.lastElementChild as HTMLElement | null
  if (!first || !last || !(lineHeight > 0)) return null
  const surfaceTop = surface.getBoundingClientRect().top
  const toContent = (viewportTop: number) =>
    viewportTop - surfaceTop + surface.scrollTop
  return {
    caretY: toContent(caretTop),
    lineHeight,
    clientHeight: surface.clientHeight,
    scrollHeight: surface.scrollHeight,
    scrollTop: surface.scrollTop,
    firstLineY: toContent(first.getBoundingClientRect().top),
    lastLineY: toContent(last.getBoundingClientRect().bottom) - lineHeight,
  }
}

/**
 * Redo a stalled PageUp/PageDown in IR. Wired once from boot; it reads the active editor lazily.
 * Returns the cleanup function.
 */
export function installIrPageNavigation(
  overrides: Partial<PageRuntime> = {},
): () => void {
  const runtime = { ...defaultRuntime(), ...overrides }
  let pending: PressStart | null = null
  let frame = 0
  let goalX: number | null = null

  const surfaceOf = (): HTMLElement | null => {
    const vditor = runtime.getVditor()
    return vditor?.currentMode === 'ir' ? (vditor.ir?.element ?? null) : null
  }

  const resetGoal = () => {
    goalX = null
  }

  // The caret position at the goal x on the content-coordinate line y, or null.
  const hitAt = (
    surface: HTMLElement,
    contentY: number,
    x: number,
  ): Range | null => {
    const surfaceRect = surface.getBoundingClientRect()
    const viewportY = surfaceRect.top + contentY - surface.scrollTop
    const y = Math.min(
      surfaceRect.top + surface.clientHeight - 2,
      Math.max(surfaceRect.top + 2, viewportY),
    )
    const range = runtime.document.caretRangeFromPoint?.(x, y) ?? null
    return range && isUsableHit(surface, range) ? range : null
  }

  const contentTopOf = (surface: HTMLElement, range: Range): number | null => {
    const rect = caretClientRect(
      range.startContainer,
      range.startOffset,
      runtime.document,
    )
    return rect
      ? rect.top - surface.getBoundingClientRect().top + surface.scrollTop
      : null
  }

  const landAt = (
    surface: HTMLElement,
    contentY: number,
    x: number,
  ): { range: Range; top: number } | null => {
    const range = hitAt(surface, contentY, x)
    const top = range ? contentTopOf(surface, range) : null
    return range && top !== null ? { range, top } : null
  }

  // The landing of a repaired press. A hit point in the gap between two lines picks the lower one,
  // which can overshoot the page step by most of a line; the native move never overshoots, so an
  // overshoot is retried one line back toward the start.
  const landingFor = (
    surface: HTMLElement,
    start: PressStart,
    plan: PagePlan,
  ): { range: Range; top: number } | null => {
    const sign = start.direction === 'up' ? -1 : 1
    const first = landAt(surface, plan.targetY, start.goalX)
    if (!first) return null
    const excess =
      Math.abs(first.top - start.geometry.caretY) - plan.expectedTravel
    if (excess <= 1) return first
    // Step back one line toward the start from the line that was hit: one line height up from the
    // overshooting line going down, two going up (the line toward the start begins a line gap below
    // it, so this lands inside its body for any block spacing seen in the editor).
    const back =
      sign > 0 ? -start.geometry.lineHeight : 2 * start.geometry.lineHeight
    const retry = landAt(surface, first.top + back, start.goalX)
    const travel = retry ? (retry.top - start.geometry.caretY) * sign : 0
    return retry && travel > 0 && travel <= plan.expectedTravel + 1
      ? retry
      : first
  }

  const settle = () => {
    frame = 0
    const start = pending
    pending = null
    const surface = surfaceOf()
    const selection = runtime.document.getSelection()
    if (
      !start ||
      !surface ||
      !selection?.rangeCount ||
      runtime.compositionActive() ||
      runtime.now() - start.at > KEY_WINDOW_MS ||
      !start.focus.node.isConnected ||
      !start.anchor.node.isConnected
    )
      return
    const now = caretClientRect(
      selection.focusNode as Node,
      selection.focusOffset,
      runtime.document,
    )
    if (!now) return
    const current = pageGeometry(surface, now.top)
    if (!current) return
    const plan = planPagePress(start.direction, start.geometry)
    const moved = Math.abs(current.caretY - start.geometry.caretY)
    if (!isStalledPress(plan, moved)) return

    // Scroll first: the hit test below is in the scrolled viewport.
    surface.scrollTop = plan.scrollTop
    const landing = landingFor(surface, start, plan)
    if (!landing) return
    const { range } = landing
    surface.scrollTop = alignScrollTop(
      landing.top,
      surface.clientHeight,
      surface.scrollHeight,
    )
    const focus = landingOutsideInlineNode(
      range.startContainer,
      range.startOffset,
    ) ?? { node: range.startContainer, offset: range.startOffset }
    requestCaret(start.shift ? { anchor: start.anchor, focus } : focus)
    // One-shot repair of a native movement, not a caret intent to keep re-asserting (as the Task 286
    // normalizer does for its own write).
    invalidateCaret()
  }

  // The editor and selection a page key acts on, or null when the press is not ours to repair.
  const pressContext = (event: KeyboardEvent) => {
    if (
      !runtime.isTrustedKey(event) ||
      event.defaultPrevented ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      guardComposition(event) ||
      runtime.compositionActive()
    )
      return null
    const surface = surfaceOf()
    const selection = runtime.document.getSelection()
    if (
      !surface ||
      !selection?.rangeCount ||
      !selection.anchorNode ||
      !selection.focusNode ||
      !(event.target instanceof Node) ||
      !surface.contains(event.target) ||
      !surface.contains(selection.focusNode)
    )
      return null
    return {
      surface,
      anchorNode: selection.anchorNode,
      anchorOffset: selection.anchorOffset,
      focusNode: selection.focusNode,
      focusOffset: selection.focusOffset,
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'PageUp' && event.key !== 'PageDown') {
      resetGoal()
      return
    }
    pending = null
    const context = pressContext(event)
    if (!context) return
    const rect = caretClientRect(
      context.focusNode,
      context.focusOffset,
      runtime.document,
    )
    const geometry = rect ? pageGeometry(context.surface, rect.top) : null
    if (!rect || !geometry) return
    goalX ??= rect.left
    pending = {
      direction: event.key === 'PageUp' ? 'up' : 'down',
      shift: event.shiftKey,
      at: runtime.now(),
      anchor: { node: context.anchorNode, offset: context.anchorOffset },
      focus: { node: context.focusNode, offset: context.focusOffset },
      geometry,
      goalX,
    }
    if (frame) runtime.cancelFrame(frame)
    // Two frames: the native move and its scroll land in the first, the settled selection in the next.
    frame = runtime.requestFrame(() => {
      frame = runtime.requestFrame(settle)
    })
  }

  runtime.document.addEventListener('keydown', onKeyDown, true)
  runtime.document.addEventListener('pointerdown', resetGoal, true)
  runtime.document.addEventListener('beforeinput', resetGoal, true)
  return () => {
    runtime.document.removeEventListener('keydown', onKeyDown, true)
    runtime.document.removeEventListener('pointerdown', resetGoal, true)
    runtime.document.removeEventListener('beforeinput', resetGoal, true)
    if (frame) runtime.cancelFrame(frame)
  }
}
