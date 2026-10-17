// Task 650: remember the Outline open state. Vditor's toolbar Outline button is the only way to
// toggle the panel (Enter/Space on the focused button fires the same click). This listener is
// bound on the button's wrapper AFTER Vditor's own handler (which flips
// `vditor.options.outline.enable`), so it runs second and reads the result. Mode switches, Split,
// narrow windows, re-inits and the `defaultOpen` setting never click the button, so they store
// nothing; a click Vditor ignored (disabled button) leaves `enable` unchanged and posts nothing.
import type { VsCodeApi } from '../../../src/shared/protocol'
import '../util/vscode-api'

export interface OutlineStateDeps {
  /** Current `vditor.options.outline.enable`. */
  readEnabled: () => boolean
  /** Keep the live session's init options current so an unrelated re-init keeps the state. */
  remember: (open: boolean) => void
  api?: Pick<VsCodeApi, 'postMessage'>
}

/** Post `save-outline-open` when the USER toggles the panel. Returns a disposer. */
export function installOutlineState(
  wrapper: HTMLElement,
  deps: OutlineStateDeps,
): () => void {
  const { readEnabled, remember, api = vscode } = deps
  let last = readEnabled()
  const onClick = () => {
    const open = readEnabled()
    if (open === last) return
    last = open
    remember(open)
    api.postMessage({ command: 'save-outline-open', open })
  }
  wrapper.addEventListener('click', onClick)
  return () => wrapper.removeEventListener('click', onClick)
}
