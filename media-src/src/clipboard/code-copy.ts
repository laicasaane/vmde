import type { WebviewMessage } from '../../../src/shared/protocol'

const COPY_BUTTON_SELECTOR = '[data-vmde-copy-code="true"]'

export function codeCopyText(textarea: HTMLTextAreaElement): string {
  // Vditor has already removed line-number nodes before it creates this textarea.
  // Keep its non-breaking-space normalisation, then remove editor-only zero-width breaks.
  return textarea.value.replace(/\u200B/g, '')
}

export function installCodeCopy(
  // `Window & typeof globalThis`, not bare `Window`: the instanceof guard below reads the
  // constructor (`target.HTMLTextAreaElement`) off the window, and that lives on the global scope
  // half of the type — with a bare `Window` the typecheck fails (TS2339).
  target: Window & typeof globalThis,
  post: (message: Extract<WebviewMessage, { command: 'copy-code' }>) => void,
): () => void {
  const buttonOf = (event: Event): Element | null =>
    (event.target as Element | null)?.closest(COPY_BUTTON_SELECTOR) ?? null

  // Why: the native mousedown default puts the caret inside the code preview. In IR that makes
  // `installIrMarkerReveal` expand the block, and the CSS hides the preview (and this button)
  // before `mouseup`, so the click is retargeted and the copy is lost. Preventing the default of a
  // primary press keeps the caret, focus and selection where they were. Right and middle buttons
  // keep their defaults, so the context menu still works. Consumed in the capture phase so it is
  // decided before any editor listener runs; `pointerdown` is left alone for its other observers.
  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || !buttonOf(event)) return
    event.preventDefault()
  }

  // Why capture: Vditor's IR root click handler expands the clicked block and moves the caret.
  // It runs before a document-level bubble listener, so the copy click must be consumed first.
  const onClick = (event: MouseEvent): void => {
    const button = buttonOf(event)
    if (!button) return
    const textarea = button.parentElement?.querySelector('textarea')
    if (!(textarea instanceof target.HTMLTextAreaElement)) return
    event.preventDefault()
    event.stopPropagation()
    post({ command: 'copy-code', content: codeCopyText(textarea) })
  }

  target.document.addEventListener('mousedown', onMouseDown, true)
  target.document.addEventListener('click', onClick, true)
  return () => {
    target.document.removeEventListener('mousedown', onMouseDown, true)
    target.document.removeEventListener('click', onClick, true)
  }
}
