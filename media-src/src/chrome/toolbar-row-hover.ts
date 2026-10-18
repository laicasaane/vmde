/**
 * Hover box for the rows of the More and Math menus. A row's name is its visible label, so its
 * description cannot be the painted `::after` of a top-level button. The native `title` attribute
 * is not an option: Chromium paints it in a small system font that CSS cannot style, which looked
 * nothing like the toolbar-control tooltips. One `div` appended to the body is shown instead, styled
 * by the `.vmde-row-hover` rule in vscode-chrome.css (the same colours and font size as the
 * `::after` tooltip, which follow `vmde.editor.tooltipFontSize`).
 *
 * A row carries its description in `aria-description` (announced) and in `ROW_TIP_ATTRIBUTE`
 * (drives this box). The box is not linked with `aria-describedby`, so a screen reader hears the
 * description once.
 */

/** Attribute holding a menu row's description for the hover box (set by toolbar-tips and overflow). */
export const ROW_TIP_ATTRIBUTE = 'data-vmde-row-tip'

/** VS Code's default hover delay: how long the pointer rests on a row before the box shows. */
export const ROW_HOVER_DELAY_MS = 500

/** Class of the single hover box; its look lives in vscode-chrome.css. */
export const ROW_HOVER_CLASS = 'vmde-row-hover'

/** Space between the menu's edge and the hover box. */
export const ROW_HOVER_GAP_PX = 4

interface Edges {
  left: number
  right: number
  top: number
  height: number
}

interface Size {
  width: number
  height: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * Where the box goes: right of the menu when it fits, else left of it, centred on the row's height,
 * and always inside the viewport (clamped, so on a very narrow viewport it may overlap the menu).
 */
export function placeRowHover(
  row: Edges,
  menu: Pick<Edges, 'left' | 'right'>,
  box: Size,
  viewport: Size,
): { left: number; top: number } {
  const right = menu.right + ROW_HOVER_GAP_PX
  const left =
    right + box.width <= viewport.width
      ? right
      : menu.left - ROW_HOVER_GAP_PX - box.width
  return {
    left: clamp(left, 0, viewport.width - box.width),
    top: clamp(
      row.top + (row.height - box.height) / 2,
      0,
      viewport.height - box.height,
    ),
  }
}

/** A row is shown only while it and every ancestor up to the toolbar still render (the menu is open). */
function isRendered(row: HTMLElement, toolbar: HTMLElement): boolean {
  for (
    let node: HTMLElement | null = row;
    node;
    node = node === toolbar ? null : node.parentElement
  )
    if (getComputedStyle(node).display === 'none') return false
  return true
}

/**
 * Show the description of a hovered or keyboard-focused menu row in the shared hover box. Returns the
 * disposer, which removes every listener and the box.
 */
export function installToolbarRowHover(toolbar: HTMLElement): () => void {
  const box = document.createElement('div')
  box.className = ROW_HOVER_CLASS
  box.setAttribute('role', 'tooltip')
  box.hidden = true
  document.body.append(box)

  /** The row whose box is shown or waiting for the delay. */
  let current: HTMLElement | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  /** True from a pointer press until the next key press: focus that a click causes shows no box. */
  let pointerPress = false

  const rowOf = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element
      ? target.closest<HTMLElement>(`[${ROW_TIP_ATTRIBUTE}]`)
      : null

  const eligible = (row: HTMLElement): boolean =>
    row.isConnected &&
    toolbar.contains(row) &&
    row.hasAttribute(ROW_TIP_ATTRIBUTE) &&
    isRendered(row, toolbar)

  // Vditor closes a menu by writing `display` on its panel (and a control returning to the toolbar
  // loses its attribute), with no event to listen for; this observer runs only while a box is
  // shown or pending, so toolbar mutations cost nothing the rest of the time.
  const watcher = new MutationObserver(() => {
    if (current && !eligible(current)) hide()
  })

  function hide(): void {
    clearTimeout(timer)
    timer = undefined
    current = null
    box.hidden = true
    watcher.disconnect()
  }

  function show(row: HTMLElement): void {
    if (!eligible(row)) {
      hide()
      return
    }
    box.textContent = row.getAttribute(ROW_TIP_ATTRIBUTE)
    // Measure at the origin so a previous clamp cannot narrow the box.
    box.style.left = '0px'
    box.style.top = '0px'
    box.hidden = false
    const menu = row.closest('.vditor-hint, .vditor-panel') ?? row
    const placed = placeRowHover(
      row.getBoundingClientRect(),
      menu.getBoundingClientRect(),
      box.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
    )
    box.style.left = `${placed.left}px`
    box.style.top = `${placed.top}px`
  }

  function begin(row: HTMLElement, delay: number): void {
    hide()
    current = row
    watcher.observe(toolbar, {
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', ROW_TIP_ATTRIBUTE],
      childList: true,
      subtree: true,
    })
    if (delay > 0) timer = setTimeout(() => show(row), delay)
    else show(row)
  }

  const onMouseOver = (event: MouseEvent) => {
    const row = rowOf(event.target)
    if (row && row !== current) begin(row, ROW_HOVER_DELAY_MS)
  }
  const onMouseOut = (event: MouseEvent) => {
    const row = rowOf(event.target)
    if (!row || row !== current) return
    const to = event.relatedTarget
    // Moving between a row's own children (icon, label) is not leaving the row.
    if (to instanceof Node && row.contains(to)) return
    hide()
  }
  const onFocusIn = (event: FocusEvent) => {
    const row = rowOf(event.target)
    if (row && !pointerPress) begin(row, 0)
  }
  const onFocusOut = (event: FocusEvent) => {
    if (current && rowOf(event.target) === current) hide()
  }
  const onPointerPress = () => {
    pointerPress = true
    hide()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    pointerPress = false
    if (event.key === 'Escape') hide()
  }

  toolbar.addEventListener('mouseover', onMouseOver)
  toolbar.addEventListener('mouseout', onMouseOut)
  toolbar.addEventListener('focusin', onFocusIn)
  toolbar.addEventListener('focusout', onFocusOut)
  toolbar.addEventListener('click', hide)
  document.addEventListener('mousedown', onPointerPress, true)
  document.addEventListener('keydown', onKeyDown, true)
  // Any scroll (the page, the editor, the toolbar) moves the row away from where the box was placed.
  window.addEventListener('scroll', hide, { capture: true, passive: true })

  return () => {
    hide()
    toolbar.removeEventListener('mouseover', onMouseOver)
    toolbar.removeEventListener('mouseout', onMouseOut)
    toolbar.removeEventListener('focusin', onFocusIn)
    toolbar.removeEventListener('focusout', onFocusOut)
    toolbar.removeEventListener('click', hide)
    document.removeEventListener('mousedown', onPointerPress, true)
    document.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('scroll', hide, true)
    box.remove()
  }
}
