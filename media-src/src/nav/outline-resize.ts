// Drag-resize handle for the Vditor outline panel (tasks 07/08), plus keyboard resizing as a
// WAI-ARIA APG "movable separator" (task 458 — the handle was mousedown-only, so it was
// unreachable and inoperable without a mouse).
//
// Inserts a thin draggable handle as a SIBLING of .vditor-outline (not a child
// — Vditor uses `this.element.lastElementChild` as the outline render target,
// so appending a child inside it hijacks the render). The handle is positioned
// absolute relative to the outline's parent (the vditor content wrapper).
//
// Min 100px, max 50% viewport. Calls `onResize(width)` on mouseup (drag, only when the gesture
// changed the size) or immediately (keyboard) so the caller can persist the value — same callback,
// and either way the persisted value is the content width held by `--me-outline-width` (task 656),
// never a border-box `offsetWidth` measurement.

export const MIN_WIDTH = 100
const MAX_WIDTH_RATIO = 0.5
const KEY_STEP = 10
// The panel's content width when `--me-outline-width` is unset. Must equal the fallback of the
// `var(--me-outline-width, 200px)` expression that build.mjs patches into Vditor's `.vditor-outline`
// rule (patchVditorIndexCss); it is mirrored here so no width logic has to measure the DOM.
const DEFAULT_OUTLINE_WIDTH = 200

/** Clamp a candidate outline width to [MIN_WIDTH, 50% of the viewport] — shared by the drag path
 *  (mousemove) and the keyboard path (Arrow/Home/End on the separator), so the two can never
 *  disagree on the bounds. Pure — unit-tested without DOM.
 *
 *  Deliberately NOT the shared `clamp()` (task 499): on a viewport under 200px wide, `maxW`
 *  (50% of viewport) drops below `MIN_WIDTH`, i.e. `lo > hi`. This expression's `Math.min` runs
 *  last and wins that tie, returning `maxW` — the shared helper's `Math.max`-wins tie-break
 *  would return `MIN_WIDTH` instead, letting the panel claim more than half a very narrow
 *  webview. Reachable on every mousemove while dragging, so the difference isn't academic. */
export function clampOutlineWidth(
  width: number,
  viewportWidth: number,
): number {
  const maxW = Math.floor(viewportWidth * MAX_WIDTH_RATIO)
  return Math.min(maxW, Math.max(MIN_WIDTH, width))
}

/** The content width the panel actually SHOWS for a stored `--me-outline-width` value: the same
 *  [MIN_WIDTH, 50% of the viewport] clamp the CSS applies (`min(max(var, 100px), 50vw)`), so a
 *  stored width from a larger window never becomes the basis of a drag or keyboard step. Falls back
 *  to the 200px CSS default when the var is unset or not a number. Pure — unit-tested without DOM. */
export function shownOutlineWidth(
  rawVar: string,
  viewportWidth: number,
): number {
  const parsed = parseFloat(rawVar)
  return clampOutlineWidth(
    Number.isFinite(parsed) ? parsed : DEFAULT_OUTLINE_WIDTH,
    viewportWidth,
  )
}

/** The width a finished drag should persist (task 656): the last content width the gesture wrote,
 *  and only when it differs from the width the gesture started from. A press with no movement, or
 *  a move that returns to the start, persists nothing, so repeated gestures never change the stored
 *  value and an oversized stored width is not overwritten by a click. Pure — unit-tested without
 *  DOM. */
export function widthToPersist(
  startWidth: number,
  writtenWidth: number | undefined,
): number | undefined {
  if (writtenWidth === undefined) return undefined
  if (!Number.isFinite(writtenWidth) || writtenWidth <= 0) return undefined
  return writtenWidth === startWidth ? undefined : writtenWidth
}

/**
 * Width delta ONE keyboard Left/Right press should apply, given which side the outline sits on.
 * Mirrors the drag path's own sign convention below (`onMove`'s `delta`): the mental model is the
 * separator LINE moving left/right on screen (WAI-ARIA APG movable-separator pattern), not
 * "increase/decrease the number" — moving the line LEFT grows a RIGHT-side outline (the drag delta
 * is `startX - clientX`) and grows a LEFT-side outline when moving RIGHT (`clientX - startX`).
 * `key` must already be narrowed to one of these two. Pure — unit-tested without DOM.
 */
export function keyboardWidthDelta(
  key: 'ArrowLeft' | 'ArrowRight',
  position: 'left' | 'right',
  step: number = KEY_STEP,
): number {
  const moveRight = key === 'ArrowRight' ? 1 : -1 // synthetic "clientX moved by" sign
  return position === 'right' ? -moveRight * step : moveRight * step
}

export function setupOutlineResize(
  outlineEl: HTMLElement,
  position: 'left' | 'right',
  onResize: (width: number) => void,
): void {
  const parent = outlineEl.parentElement
  if (!parent || parent.querySelector('.outline-resize-handle')) return

  const handle = document.createElement('div')
  handle.className = 'outline-resize-handle'
  handle.dataset.side = position === 'right' ? 'left' : 'right'
  // Task 458 — a movable separator: focusable, and Arrow/Home/End resize it (below). The visible
  // focus ring is QUEUED, not applied yet — same main.css/ADR-0003-category-3/task-464 collision
  // task 456 already logged for the toolbar's ring; see tasks/458-a11y-outline-keyboard.md.
  handle.tabIndex = 0
  handle.setAttribute('role', 'separator')
  handle.setAttribute('aria-orientation', 'vertical')
  handle.setAttribute('aria-label', 'Resize outline panel')

  if (position === 'right') {
    parent.insertBefore(handle, outlineEl)
  } else {
    outlineEl.insertAdjacentElement('afterend', handle)
  }

  // The outline element ALWAYS exists — Vditor's `Outline.toggle()` only flips its inline
  // `display` (block/none). So the handle must track the outline's visibility: with the
  // outline OFF (display:none) it goes out of flow and the handle becomes the last in-flow
  // child at the editor's right edge, where its straddle margins poke a few px past the
  // viewport (a phantom horizontal scrollbar) — and a resize grip for a hidden panel is wrong
  // anyway. Mirror the outline's display, live (the toolbar toggle flips the inline style).
  const syncHandleVisibility = () => {
    handle.style.display =
      getComputedStyle(outlineEl).display === 'none' ? 'none' : ''
  }
  syncHandleVisibility()
  new MutationObserver(syncHandleVisibility).observe(outlineEl, {
    attributes: true,
    attributeFilter: ['style', 'class'],
  })

  // aria-valuenow/min/max on a movable separator (WAI-ARIA APG) — max is viewport-relative
  // (MAX_WIDTH_RATIO), so it's recomputed on every sync rather than set once.
  const syncSeparatorValue = (width: number) => {
    handle.setAttribute('aria-valuenow', String(width))
    handle.setAttribute('aria-valuemin', String(MIN_WIDTH))
    handle.setAttribute(
      'aria-valuemax',
      String(Math.floor(window.innerWidth * MAX_WIDTH_RATIO)),
    )
  }
  // The basis of every drag and keyboard step, and of the initial aria-valuenow: the content width
  // the var holds (clamped like the CSS, or the 200px default), never `outlineEl.offsetWidth`.
  // `.vditor-outline` is content-box with a 1px border on the resize-handle side, so offsetWidth
  // reads 1px MORE than the `width` the var sets; using it as a basis or as the stored value made
  // the width grow by 1px per gesture (task 656). It also reads 0 while the panel is closed.
  const currentWidth = (): number => {
    return shownOutlineWidth(
      document.body.style.getPropertyValue('--me-outline-width'),
      window.innerWidth,
    )
  }

  syncSeparatorValue(currentWidth())

  let dragging = false
  let startX = 0
  let startW = 0
  let rafId = 0
  let pendingW = 0
  // Last width applyWidth wrote during the current gesture; undefined until the pointer moves.
  let writtenW: number | undefined

  handle.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault()
    dragging = true
    startX = e.clientX
    startW = currentWidth()
    writtenW = undefined
    document.body.classList.add('outline-resizing')
  })

  // Shared by the drag path (below) and the keyboard path (further down): write the width to the
  // CSS var the panel is sized from, and keep the separator's aria-valuenow in sync with it.
  const writeWidth = (width: number) => {
    document.body.style.setProperty('--me-outline-width', `${width}px`)
    syncSeparatorValue(width)
  }

  const applyWidth = () => {
    writeWidth(pendingW)
    writtenW = pendingW
    rafId = 0
  }

  const onMove = (e: MouseEvent) => {
    if (!dragging) return
    const delta = position === 'right' ? startX - e.clientX : e.clientX - startX
    pendingW = clampOutlineWidth(startW + delta, window.innerWidth)
    if (!rafId) rafId = requestAnimationFrame(applyWidth)
  }

  const onUp = () => {
    if (!dragging) return
    dragging = false
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
      applyWidth()
    }
    document.body.classList.remove('outline-resizing')
    const finalW = widthToPersist(startW, writtenW)
    if (finalW !== undefined) onResize(finalW)
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)

  // Keyboard resizing — discrete steps, so unlike the drag path there's no rAF batch: apply,
  // reflect in the CSS var, and persist (onResize) on every keypress.
  const setWidthAndPersist = (width: number) => {
    const clamped = clampOutlineWidth(width, window.innerWidth)
    writeWidth(clamped)
    onResize(clamped)
  }

  handle.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const delta = keyboardWidthDelta(e.key, position)
      setWidthAndPersist(currentWidth() + delta)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setWidthAndPersist(MIN_WIDTH)
    } else if (e.key === 'End') {
      e.preventDefault()
      setWidthAndPersist(Math.floor(window.innerWidth * MAX_WIDTH_RATIO))
    }
  })
}
