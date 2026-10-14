import type { VsCodeApi } from '../../../src/shared/protocol'
import { t } from '../util/lang'
import '../util/vscode-api'
import { chevronDownIcon, chevronUpIcon } from './toolbar-icons'

/** Webview-state key holding the collapsed flag (a new editor opens expanded). */
export const COLLAPSE_STATE_KEY = 'vmdeToolbarCollapsed'
export const COLLAPSED_CLASS = 'vmde-toolbar--collapsed'

const TOGGLE_SELECTOR = '[data-type="collapse-toolbar"]'

type StateApi = Pick<VsCodeApi, 'getState' | 'setState'>

function readState(api: StateApi): Record<string, unknown> {
  const value = api.getState<unknown>()
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function readCollapsed(api: StateApi): boolean {
  return readState(api)[COLLAPSE_STATE_KEY] === true
}

/**
 * Bind the toolbar's collapse toggle: apply the stored state, toggle on click, persist by merging
 * into the existing webview state. Presentation only; the document is never touched. Returns a
 * disposer; with no toggle (toolbar off) it does nothing.
 */
export function installToolbarCollapse(
  toolbar: HTMLElement,
  api: StateApi = vscode,
): () => void {
  const button = toolbar.querySelector<HTMLElement>(TOGGLE_SELECTOR)
  if (!button)
    return () => {
      /* no-op disposer: no toggle on this toolbar */
    }

  const render = (collapsed: boolean) => {
    toolbar.classList.toggle(COLLAPSED_CLASS, collapsed)
    button.setAttribute('aria-expanded', String(!collapsed))
    button.setAttribute(
      'aria-label',
      t(collapsed ? 'expandToolbar' : 'collapseToolbar'),
    )
    button.innerHTML = collapsed ? chevronDownIcon : chevronUpIcon
  }

  // Keep the editor's focus and selection: a mouse press on the toggle must not move focus.
  const onMouseDown = (event: MouseEvent) => event.preventDefault()
  const onClick = () => {
    const collapsed = !toolbar.classList.contains(COLLAPSED_CLASS)
    render(collapsed)
    api.setState({ ...readState(api), [COLLAPSE_STATE_KEY]: collapsed })
  }

  render(readCollapsed(api))
  button.addEventListener('mousedown', onMouseDown)
  button.addEventListener('click', onClick)
  return () => {
    button.removeEventListener('mousedown', onMouseDown)
    button.removeEventListener('click', onClick)
  }
}
