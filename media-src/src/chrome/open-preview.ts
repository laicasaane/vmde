// Task 282 — `vmde.editor.defaultMode: "preview"` boots the document read-only.
//
// "Preview" is NOT one of Vditor's three modes (ir/wysiwyg/sv); it is an overlay toggled by the
// toolbar's Preview button, which swaps the edit pane for the rendered pane and disables the editing
// toolbars. There is no constructor option for it and no public API to set it, so the only honest
// way to reach that state is to drive the same button the user would click — Vditor's own handler
// then does the pane swap, the toolbar disabling and the outline re-render, and nothing here has to
// duplicate (or drift from) that logic.
import type { VsCodeApi } from '../../../src/shared/protocol'
import { innerVditor } from '../util/inner-vditor'
import '../util/vscode-api'

const CURRENT_CLASS = 'vditor-menu--current'

// Set only while `openInPreview()` dispatches its own click (synchronous), so the Task 651 memory
// listener can tell a rule- or state-driven open from a user toggle and store only the latter.
let programmatic = false

export function previewButton(): HTMLElement | undefined {
  return innerVditor()?.toolbar?.elements?.preview?.children[0] as
    | HTMLElement
    | undefined
}

/** Whether the Preview overlay is up (Vditor marks the toolbar button `vditor-menu--current`). */
export function previewShowing(): boolean {
  return previewButton()?.classList.contains(CURRENT_CLASS) ?? false
}

export function openInPreview(): void {
  const btn = previewButton()
  if (!btn) return
  // Already showing the preview (a re-init that kept the state) — clicking again would toggle it
  // back OFF, which is the opposite of what the setting asks for.
  if (btn.classList.contains(CURRENT_CLASS)) return
  programmatic = true
  try {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  } finally {
    programmatic = false
  }
}

/**
 * Task 651: post the Preview state when the USER toggles it. Bound on the button itself after
 * Vditor's own handler (Vditor binds it at construction, this runs from finish-init), so it runs
 * second and reads the class Vditor just set. Nothing is posted for `openInPreview()`'s click or
 * for a click that left the class unchanged (a disabled button). Bound on the node, not cloned, so
 * a later toolbar relocation keeps it. Returns a disposer.
 */
export function installPreviewMemory(
  button: HTMLElement,
  api: Pick<VsCodeApi, 'postMessage'> = vscode,
): () => void {
  let last = button.classList.contains(CURRENT_CLASS)
  const onClick = () => {
    const on = button.classList.contains(CURRENT_CLASS)
    if (on === last) return
    last = on
    if (programmatic) return
    api.postMessage({ command: 'save-preview-state', on })
  }
  button.addEventListener('click', onClick)
  return () => button.removeEventListener('click', onClick)
}
