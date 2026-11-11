// Task 733 (task 002): state for the Preview-only layout rules in main.css.
//
// What: sets `data-vmde-source-pane="hidden"` on `.vditor-content` while no source pane is visible
// (`.vditor-sv` absent, or its inline `display` is `none`), and removes it while one is.
// Why: main.css used `.vditor-content:not(:has(.vditor-sv))` and `:has(.vditor-sv[style*="display:
// none"])` to restyle the Preview pane. Those `:has()` rules re-matched the content root on every
// style change below it, which made each inserted element cost a document-wide style recalculation.
// How: Vditor's edit-mode and preview toggles (`toolbar/EditMode.ts`, `toolbar/Preview.ts`,
// `ui/setPreviewMode.ts`) only write `.vditor-sv`'s inline `style`, and `ui/initUI.ts` appends the
// element once. So one `childList` observer on `content` (no `subtree`) plus one `style` observer
// on the `.vditor-sv` element (no `subtree`, re-attached when the element is replaced) see every
// writer. The first value is written synchronously at install, before the first paint.

const SOURCE_PANE_ATTRIBUTE = 'data-vmde-source-pane'

function findSourcePane(content: HTMLElement): HTMLElement | null {
  for (const child of Array.from(content.children)) {
    if (child instanceof HTMLElement && child.classList.contains('vditor-sv'))
      return child
  }
  return null
}

/**
 * Keep `data-vmde-source-pane` on `content` in step with the visibility of its `.vditor-sv` child.
 * Calling it again on the same element replaces nothing: the caller disposes the first install.
 * Returns a function that disconnects both observers and leaves the attribute as it is.
 */
export function installSourcePaneState(content: HTMLElement): () => void {
  let pane: HTMLElement | null = null
  const styleObserver = new MutationObserver(() => sync())
  const childObserver = new MutationObserver(() => sync())

  function sync(): void {
    const current = findSourcePane(content)
    if (current !== pane) {
      styleObserver.disconnect()
      pane = current
      if (pane)
        styleObserver.observe(pane, {
          attributes: true,
          attributeFilter: ['style'],
        })
    }
    if (!pane || pane.style.display === 'none')
      content.setAttribute(SOURCE_PANE_ATTRIBUTE, 'hidden')
    else content.removeAttribute(SOURCE_PANE_ATTRIBUTE)
  }

  childObserver.observe(content, { childList: true })
  sync()
  return () => {
    childObserver.disconnect()
    styleObserver.disconnect()
  }
}
