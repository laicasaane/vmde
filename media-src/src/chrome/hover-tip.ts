/**
 * Task 732 — the pointer hover box for content tooltips (outline entries, links, images). Its CSS
 * (`.vmde-hover-tip` in vscode-chrome.css) shares every rule of the More and Math row box
 * (toolbar-row-hover.ts), so it carries the toolbar tooltip look (VS Code hover-widget colours, `vmde.editor.tooltipFontSize`); the native
 * `title` tooltip is painted by Chromium in a system font that CSS cannot style.
 *
 * The box opens under the hovered element's line box, centred like the toolbar's `__s` tooltip,
 * flips above when it does not fit below, and stays inside the viewport. Pointer only: keyboard,
 * focus and caret are never read or written, and nothing is written to the hovered element.
 */

import { ROW_HOVER_GAP_PX } from './toolbar-row-hover'

/** Class of a content hover box; its look lives in vscode-chrome.css. */
const HOVER_TIP_CLASS = 'vmde-hover-tip'

/** Task 732 D2: the toolbar tooltip shows as soon as the pointer is on its control (Vditor's CSS
 *  `:hover::after`, with a 0.15 s fade), and the Owner's 50 ms ceiling allows no longer wait, so the
 *  content box shows at once too. */
const HOVER_TIP_DELAY_MS = 0

interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

interface Size {
  width: number
  height: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** Where the box goes for `anchor`: centred below it, above when below does not fit, clamped. */
export function placeHoverTip(
  anchor: Box,
  box: Size,
  viewport: Size,
): { left: number; top: number } {
  const below = anchor.bottom + ROW_HOVER_GAP_PX
  const above = anchor.top - ROW_HOVER_GAP_PX - box.height
  const top =
    below + box.height <= viewport.height || above < 0 ? below : above
  return {
    left: clamp(
      (anchor.left + anchor.right - box.width) / 2,
      0,
      viewport.width - box.width,
    ),
    top: clamp(top, 0, viewport.height - box.height),
  }
}

/**
 * The line box of `element` under the pointer: a link that wraps has one client rect per line, and
 * the tooltip belongs under the line the pointer is on. Falls back to the whole bounding box.
 */
export function anchorRect(element: Element, x: number, y: number): Box {
  for (const rect of Array.from(element.getClientRects())) {
    if (
      x >= rect.left &&
      x <= rect.right &&
      y >= rect.top &&
      y <= rect.bottom
    )
      return rect
  }
  return element.getBoundingClientRect()
}

/** A tooltip for the element under the pointer: the element it describes and its text. */
export interface HoverTipTarget {
  element: Element
  text: string
}

export interface HoverTip {
  /** Show `text` for `element` (after `delay`, when set); the same target again changes nothing. */
  show(element: Element, text: string, x: number, y: number): void
  hide(): void
  /** The text shown now, or null while hidden or waiting for the delay. */
  shownText(): string | null
  dispose(): void
}

/** One hover box appended to `doc.body`. */
export function createHoverTip(doc: Document, delay = HOVER_TIP_DELAY_MS): HoverTip {
  const box = doc.createElement('div')
  box.className = HOVER_TIP_CLASS
  box.setAttribute('role', 'tooltip')
  box.hidden = true
  doc.body.append(box)

  let current: { element: Element; text: string } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let x = 0
  let y = 0

  const view = doc.defaultView

  function place(): void {
    if (!current?.element.isConnected) {
      hide()
      return
    }
    box.textContent = current.text
    // Measure at the origin so a previous clamp cannot narrow the box.
    box.style.left = '0px'
    box.style.top = '0px'
    box.hidden = false
    const placed = placeHoverTip(
      anchorRect(current.element, x, y),
      box.getBoundingClientRect(),
      {
        width: view?.innerWidth ?? 0,
        height: view?.innerHeight ?? 0,
      },
    )
    box.style.left = `${placed.left}px`
    box.style.top = `${placed.top}px`
  }

  function hide(): void {
    clearTimeout(timer)
    timer = undefined
    current = null
    box.hidden = true
  }

  return {
    show(element, text, pointerX, pointerY) {
      if (current?.element === element && current.text === text) return
      hide()
      current = { element, text }
      x = pointerX
      y = pointerY
      if (delay > 0) timer = setTimeout(place, delay)
      else place()
    },
    hide,
    shownText: () => (box.hidden ? null : box.textContent),
    dispose() {
      hide()
      box.remove()
    },
  }
}

/**
 * Show a hover box for whatever `resolve` names under the pointer, anywhere in `doc`. A key press,
 * pointer press, edit, scroll, window blur or leaving the document hides it. `resolve` runs only
 * when the pointer's target changes. `onTarget` sees every change of the described element (null
 * when none), so a caller can suppress a native `title` while its element is hovered.
 */
export function installHoverTips(
  doc: Document,
  resolve: (target: Element) => HoverTipTarget | null,
  onTarget?: (element: Element | null) => void,
): () => void {
  const tip = createHoverTip(doc)
  let lastTarget: EventTarget | null = null
  let lastElement: Element | null = null

  const setElement = (element: Element | null) => {
    if (element === lastElement) return
    lastElement = element
    onTarget?.(element)
  }
  const clear = () => {
    lastTarget = null
    tip.hide()
    setElement(null)
  }
  const onHover = (event: Event) => {
    const target = event.target
    // pointermove repeats the same target on every frame; recompute only when it changes.
    if (target === lastTarget) return
    lastTarget = target
    const found = target instanceof Element ? resolve(target) : null
    if (!found) {
      tip.hide()
      setElement(null)
      return
    }
    setElement(found.element)
    const pointer = event as MouseEvent
    tip.show(found.element, found.text, pointer.clientX, pointer.clientY)
  }
  const onPointerOut = (event: Event) => {
    if (!(event as MouseEvent).relatedTarget) clear()
  }

  // Capture on the document: content handlers (block handle, table resize, link popover) may stop
  // propagation of their own pointer events.
  const passive = { capture: true, passive: true } as const
  const hoverEvents = ['pointerover', 'pointermove'] as const
  const clearEvents = ['keydown', 'pointerdown', 'input', 'scroll'] as const
  for (const type of hoverEvents) doc.addEventListener(type, onHover, passive)
  for (const type of clearEvents) doc.addEventListener(type, clear, passive)
  doc.addEventListener('pointerout', onPointerOut, passive)
  doc.defaultView?.addEventListener('blur', clear)
  return () => {
    for (const type of hoverEvents)
      doc.removeEventListener(type, onHover, passive)
    for (const type of clearEvents)
      doc.removeEventListener(type, clear, passive)
    doc.removeEventListener('pointerout', onPointerOut, passive)
    doc.defaultView?.removeEventListener('blur', clear)
    clear()
    tip.dispose()
  }
}
