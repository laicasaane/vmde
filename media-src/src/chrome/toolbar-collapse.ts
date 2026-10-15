import type { VsCodeApi } from '../../../src/shared/protocol'
import { t } from '../util/lang'
import '../util/vscode-api'
import { chevronDownIcon, chevronUpIcon } from './toolbar-icons'
import { closeSubmenuPanels } from './toolbar-submenu-aria'

export const COLLAPSED_CLASS = 'vmde-toolbar--collapsed'

const TOGGLE_SELECTOR = '[data-type="collapse-toolbar"]'
const OPEN_PANEL_SELECTOR =
  '.vditor-hint[style*="block"], .vditor-panel[style*="block"]'

/** Close every open toolbar panel: the named submenus, then any other open hint or panel (the
 *  emoji and headings panels match the click-outside dismiss selector in toolbar-dismiss.ts). */
function closeOpenPanels(toolbar: HTMLElement): void {
  closeSubmenuPanels(toolbar)
  for (const panel of toolbar.querySelectorAll<HTMLElement>(
    OPEN_PANEL_SELECTOR,
  ))
    panel.style.display = 'none'
}

type MessageApi = Pick<VsCodeApi, 'postMessage'>

// Task 631 follow-up F2 (Owner, 2026-10-15): one user-level value, owned by the host (extension
// global state) and shared by every editor and file. `shared` mirrors it in this webview: the host
// sets it with the init payload (before the toolbar exists) and with each `toolbar-collapsed`
// message; a local toggle updates it and posts the new value. No per-editor webview state, so no
// editor can open in a state that differs from the shared value.
let shared = false
let applyToActive: ((collapsed: boolean) => void) | undefined

export function sharedToolbarCollapsed(): boolean {
  return shared
}

/** The host's value (init payload or state message). Anything but `true` means expanded. */
export function receiveToolbarCollapsed(collapsed: unknown): void {
  shared = collapsed === true
  applyToActive?.(shared)
}

function renderCollapse(
  toolbar: HTMLElement,
  button: HTMLElement,
  collapsed: boolean,
): void {
  toolbar.classList.toggle(COLLAPSED_CLASS, collapsed)
  button.setAttribute('aria-expanded', String(!collapsed))
  button.setAttribute(
    'aria-label',
    t(collapsed ? 'expandToolbar' : 'collapseToolbar'),
  )
  button.innerHTML = collapsed ? chevronDownIcon : chevronUpIcon
}

/**
 * Show a static copy of the toolbar (the instant-paint overlay's clone, taken before the live
 * toolbar is bound) in the shared state, so the overlay never paints the expanded toolbar for an
 * editor that is remembered as collapsed. No behaviour is bound to the copy.
 */
export function renderToolbarCopy(toolbar: HTMLElement): void {
  const button = toolbar.querySelector<HTMLElement>(TOGGLE_SELECTOR)
  if (button) renderCollapse(toolbar, button, shared)
}

/**
 * Bind the toolbar's collapse toggle: apply the shared state, toggle on click and post the new
 * value to the host, follow the host's state messages. Presentation only; the document is never
 * touched. Returns a disposer; with no toggle (toolbar off) it does nothing.
 */
export function installToolbarCollapse(
  toolbar: HTMLElement,
  api: MessageApi = vscode,
): () => void {
  const button = toolbar.querySelector<HTMLElement>(TOGGLE_SELECTOR)
  if (!button)
    return () => {
      /* no-op disposer: no toggle on this toolbar */
    }

  const render = (collapsed: boolean) =>
    renderCollapse(toolbar, button, collapsed)

  // Panels first: a hidden trigger must not leave its menu floating over the editor. The Find
  // widget follows the new toolbar bottom through its own toolbar size observer.
  const setCollapsed = (collapsed: boolean) => {
    if (collapsed === toolbar.classList.contains(COLLAPSED_CLASS)) return
    if (collapsed) closeOpenPanels(toolbar)
    render(collapsed)
  }

  // Keep the editor's focus and selection: a mouse press on the toggle must not move focus.
  const onMouseDown = (event: MouseEvent) => event.preventDefault()
  const onClick = () => {
    const collapsed = !toolbar.classList.contains(COLLAPSED_CLASS)
    shared = collapsed
    setCollapsed(collapsed)
    api.postMessage({ command: 'save-toolbar-collapsed', collapsed })
  }
  // A host state message arrives while focus may sit in the editor (kept) or on a toolbar item the
  // collapse is about to hide (moved to the toggle, the only stop left).
  const onHostState = (collapsed: boolean) => {
    const focused = document.activeElement
    if (
      collapsed &&
      focused instanceof HTMLElement &&
      focused !== button &&
      toolbar.contains(focused)
    )
      button.focus({ preventScroll: true })
    setCollapsed(collapsed)
  }

  render(shared)
  applyToActive = onHostState
  button.addEventListener('mousedown', onMouseDown)
  button.addEventListener('click', onClick)
  return () => {
    button.removeEventListener('mousedown', onMouseDown)
    button.removeEventListener('click', onClick)
    if (applyToActive === onHostState) applyToActive = undefined
  }
}
