/** A single body-owned floating surface, reusable by selection and link popovers. */
export interface AnchorRect {
  left: number
  right: number
  top: number
  bottom: number
}

interface Size {
  width: number
  height: number
}

function validPanelGeometry(
  target: AnchorRect | null,
  panel: Size,
  bounds: AnchorRect,
): target is AnchorRect {
  if (!target) return false
  const numbers = [
    target.left,
    target.right,
    target.top,
    target.bottom,
    bounds.left,
    bounds.right,
    bounds.top,
    bounds.bottom,
    panel.width,
    panel.height,
  ]
  return (
    numbers.every(Number.isFinite) &&
    target.right > target.left &&
    target.bottom > target.top &&
    bounds.right > bounds.left &&
    bounds.bottom > bounds.top &&
    panel.width > 0 &&
    panel.height > 0 &&
    panel.width <= bounds.right - bounds.left &&
    panel.height <= bounds.bottom - bounds.top
  )
}

/** Intersect the editor scrollport, viewport, and toolbar into a safe panel area. */
export function elementPanelBounds(
  viewport: Size,
  scroller?: AnchorRect | null,
  toolbar?: Pick<AnchorRect, 'bottom'> | null,
): AnchorRect {
  const margin = 8
  return {
    left: Math.max(margin, (scroller?.left ?? 0) + margin),
    right: Math.min(
      viewport.width - margin,
      (scroller?.right ?? viewport.width) - margin,
    ),
    top: Math.max(
      margin,
      (scroller?.top ?? 0) + margin,
      (toolbar?.bottom ?? 0) + margin,
    ),
    bottom: Math.min(
      viewport.height - margin,
      (scroller?.bottom ?? viewport.height) - margin,
    ),
  }
}

function caretSafeEdge(
  panel: Size,
  bounds: AnchorRect,
  activeLine: AnchorRect | null | undefined,
): number | null {
  if (
    !activeLine ||
    ![activeLine.top, activeLine.bottom].every(Number.isFinite)
  )
    return null
  const top = bounds.top
  const bottom = bounds.bottom - panel.height
  const clear = (candidate: number) =>
    candidate + panel.height + 2 <= activeLine.top ||
    candidate >= activeLine.bottom + 2
  const choices =
    activeLine.top + activeLine.bottom < bounds.top + bounds.bottom
      ? [bottom, top]
      : [top, bottom]
  return choices.find(clear) ?? null
}

/** Position an element-owned control beside its rendered owner.
 * If no side fits, use a visible edge clear of the active caret line. */
export function elementPanelPosition(
  target: AnchorRect | null,
  panel: Size,
  bounds: AnchorRect,
  activeLine?: AnchorRect | null,
  prefer: 'below' | 'above' = 'below',
): { left: number; top: number } | null {
  if (!validPanelGeometry(target, panel, bounds)) return null
  const gap = 8
  const left = Math.max(
    bounds.left,
    Math.min(target.left, bounds.right - panel.width),
  )
  const below = target.bottom + gap
  const above = target.top - panel.height - gap
  for (const top of prefer === 'below' ? [below, above] : [above, below]) {
    if (top >= bounds.top && top + panel.height <= bounds.bottom)
      return { left, top }
  }
  const sideTop = Math.max(
    bounds.top,
    Math.min(target.top, bounds.bottom - panel.height),
  )
  if (target.right + gap + panel.width <= bounds.right)
    return { left: target.right + gap, top: sideTop }
  if (target.left - gap - panel.width >= bounds.left)
    return { left: target.left - gap - panel.width, top: sideTop }
  const edge = caretSafeEdge(panel, bounds, activeLine)
  return edge === null ? null : { left, top: edge }
}

export function floatingPosition(
  anchor: AnchorRect,
  overlay: Size,
  viewport: Size,
): { left: number; top: number } {
  const margin = 8
  const gap = 8
  const idealLeft = (anchor.left + anchor.right - overlay.width) / 2
  const left = Math.max(
    margin,
    Math.min(idealLeft, viewport.width - overlay.width - margin),
  )
  const above = anchor.top - overlay.height - gap
  const top =
    above >= margin
      ? above
      : Math.min(anchor.bottom + gap, viewport.height - overlay.height - margin)
  return { left, top }
}

export interface FloatingOverlay {
  element: HTMLDivElement
  show(anchor: AnchorRect): void
  hide(): void
  dispose(): void
}

let active: FloatingOverlay | null = null

export function createFloatingOverlay(className: string): FloatingOverlay {
  const element = document.createElement('div')
  element.className = className
  element.hidden = true
  document.body.append(element)
  const overlay: FloatingOverlay = {
    element,
    show(anchor) {
      if (active && active !== overlay) active.hide()
      active = overlay
      element.hidden = false
      const position = floatingPosition(
        anchor,
        { width: element.offsetWidth, height: element.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      )
      element.style.left = `${position.left}px`
      element.style.top = `${position.top}px`
    },
    hide() {
      element.hidden = true
      if (active === overlay) active = null
    },
    dispose() {
      overlay.hide()
      element.remove()
    },
  }
  return overlay
}
