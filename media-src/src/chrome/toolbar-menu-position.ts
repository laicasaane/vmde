interface RectLike {
  left: number
  top: number
  right: number
  bottom: number
}

interface Size {
  width: number
  height: number
}

const GUTTER = 4
const POSITION_STYLE_NAMES = [
  'position',
  'left',
  'right',
  'top',
  'box-sizing',
  'min-width',
  'max-width',
  'width',
  'max-height',
  'overflow-x',
  'overflow-y',
] as const

type SavedStyle = { value: string; priority: string }
const priorPanelStyles = new WeakMap<
  HTMLElement,
  Map<(typeof POSITION_STYLE_NAMES)[number], SavedStyle>
>()
const styledPanels = new Set<HTMLElement>()

function restorePanelStyles(panel: HTMLElement): void {
  const prior = priorPanelStyles.get(panel)
  if (!prior) return
  for (const [name, { value, priority }] of prior) {
    if (value) panel.style.setProperty(name, value, priority)
    else panel.style.removeProperty(name)
  }
  priorPanelStyles.delete(panel)
  styledPanels.delete(panel)
}

function setPanelStyles(
  panel: HTMLElement,
  styles: Record<string, string>,
): void {
  let prior = priorPanelStyles.get(panel)
  if (!prior) {
    prior = new Map(
      POSITION_STYLE_NAMES.map((name) => [
        name,
        {
          value: panel.style.getPropertyValue(name),
          priority: panel.style.getPropertyPriority(name),
        },
      ]),
    )
    priorPanelStyles.set(panel, prior)
  }
  styledPanels.add(panel)
  for (const [name, value] of Object.entries(styles))
    panel.style.setProperty(name, value, 'important')
}

export function boundedPanelPosition(
  trigger: RectLike,
  panel: Size,
  viewport: Size,
  flyout: boolean,
) {
  const maxWidth = Math.max(0, viewport.width - GUTTER * 2)
  const maxHeight = Math.max(0, viewport.height - GUTTER * 2)
  const width = Math.min(panel.width, maxWidth)
  const height = Math.min(panel.height, maxHeight)
  const preferredLeft = flyout ? trigger.right : trigger.left
  const left = Math.max(
    GUTTER,
    Math.min(
      flyout && preferredLeft + width > viewport.width - GUTTER
        ? trigger.left - width
        : preferredLeft,
      viewport.width - width - GUTTER,
    ),
  )
  const preferredTop = flyout ? trigger.top : trigger.bottom
  return {
    left,
    top: Math.max(
      GUTTER,
      Math.min(preferredTop, viewport.height - height - GUTTER),
    ),
    maxWidth,
    maxHeight,
  }
}

function positionOpenPanel(panel: HTMLElement): void {
  if (getComputedStyle(panel).display === 'none') return
  // Vditor's nested Settings/About rows are not toolbar-item wrappers. Their panel's parent
  // owns the actual trigger, while `closest('.vditor-toolbar__item')` would incorrectly pick
  // the top-level More owner and position every flyout as its main dropdown.
  const directParent = panel.parentElement
  const owner = panel.closest('.vditor-toolbar__item')
  const trigger =
    directParent?.querySelector<HTMLElement>(':scope > [data-type]') ??
    owner?.querySelector<HTMLElement>(':scope > [data-type]')
  if (!trigger) return
  const flyout = Boolean(directParent?.closest('.vditor-hint'))
  // Vditor owns the top-level toolbar dropdown's anchored placement and scrolling. A nested More
  // row also uses `.vditor-hint`, however, so skip only the hint whose direct parent IS the
  // top-level toolbar item; Settings/About/theme/export flyouts need the same viewport bounds as
  // emoji's `.vditor-panel` child.
  if (
    directParent?.classList.contains('vditor-toolbar__item') &&
    directParent.parentElement?.dataset.vmdeToolbarRow !== undefined
  ) {
    restorePanelStyles(panel)
    return
  }
  const position = boundedPanelPosition(
    trigger.getBoundingClientRect(),
    panel.getBoundingClientRect(),
    { width: window.innerWidth, height: window.innerHeight },
    flyout,
  )
  const styles: Record<string, string> = {
    position: 'fixed',
    left: `${position.left}px`,
    right: 'auto',
    top: `${position.top}px`,
    boxSizing: 'border-box',
    minWidth: '0',
    maxWidth: `${position.maxWidth}px`,
    width: `${Math.min(panel.getBoundingClientRect().width, position.maxWidth)}px`,
    maxHeight: `${position.maxHeight}px`,
    overflowX: 'auto',
    overflowY: 'auto',
  }
  // Keep the original inline values so an overflowed owner that returns to its toolbar row resumes
  // Vditor's native anchored placement instead of retaining a stale fixed flyout coordinate.
  setPanelStyles(
    panel,
    Object.fromEntries(
      Object.entries(styles).map(([name, value]) => [
        name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
        value,
      ]),
    ),
  )
}

/**
 * Vditor positions toolbar panels from their owner and only guesses at available space. Reposition
 * open panels against the webview viewport so a nested More flyout remains reachable at zoom and
 * at either edge, without moving it to a portal that would break Vditor's dismissal ownership.
 */
export function installToolbarMenuPosition(toolbar: HTMLElement): () => void {
  const positionOpenPanels = () => {
    for (const panel of toolbar.querySelectorAll<HTMLElement>(
      '.vditor-hint, .vditor-panel',
    )) {
      positionOpenPanel(panel)
    }
  }
  let frame = 0
  const schedule = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      positionOpenPanels()
    })
  }
  // Vditor finishes its own left/right style writes in the same mutation turn. Position on the
  // following frame so the bounded flyout geometry wins instead of being immediately overwritten.
  const observer = new MutationObserver(schedule)
  observer.observe(toolbar, {
    attributes: true,
    attributeFilter: ['style', 'class'],
    subtree: true,
  })
  window.addEventListener('resize', schedule)
  // Vditor opens a panel in its button click handler. A toolbar bubble listener runs after that
  // handler and makes the first interactive paint bounded rather than waiting for an observer turn.
  toolbar.addEventListener('click', positionOpenPanels)
  return () => {
    observer.disconnect()
    if (frame) cancelAnimationFrame(frame)
    window.removeEventListener('resize', schedule)
    toolbar.removeEventListener('click', positionOpenPanels)
    for (const panel of styledPanels) restorePanelStyles(panel)
  }
}
