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
