function itemName(element: HTMLElement): string | null {
  return (
    element.querySelector(':scope > [data-type]')?.getAttribute('data-type') ??
    null
  )
}

/**
 * Vditor creates one flat toolbar, but overflow and keyboard traversal need stable row ownership.
 * Move its original wrappers into two containers; no action is cloned, so Vditor retains the same
 * handlers and `toolbar.elements` references it created during construction.
 *
 * Task 642: every control and divider is authored into row 1 in sequence order and row 2 starts
 * empty and hidden; the flow pass (toolbar-overflow.ts) distributes the controls by width, so the
 * authored row is the one sequence, not a fixed row split.
 */
export function ensureToolbarRows(toolbar: HTMLElement): HTMLElement[] {
  const existing = Array.from(toolbar.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      child.dataset.vmdeToolbarRow !== undefined,
  )
  if (existing.length === 2) return existing

  const rows = (['1', '2'] as const).map((id) => {
    const row = document.createElement('div')
    row.className = 'vmde-toolbar-row'
    row.dataset.vmdeToolbarRow = id
    return row
  })
  const children = Array.from(toolbar.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  )
  // Vditor still emits the outer toolbar wrapper for `toolbar: []`. Preserve that empty shell so
  // the hidden-toolbar setting stays collapsed instead of acquiring two visible 35px row bands.
  if (!children.some((child) => itemName(child))) return []
  rows[0].append(...children)
  // `hidden` is overridden by the row's `display: flex` unless the stylesheet re-asserts it
  // (vscode-chrome.css "Empty row 2"); the flow pass toggles it when a second row is needed.
  rows[1].hidden = true
  toolbar.replaceChildren(...rows)
  return rows
}

export function toolbarRows(toolbar: HTMLElement): HTMLElement[] {
  return Array.from(toolbar.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      child.dataset.vmdeToolbarRow !== undefined,
  )
}
