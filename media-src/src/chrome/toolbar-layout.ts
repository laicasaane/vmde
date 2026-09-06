type ToolbarRow = '1' | '2'

const ROW_ONE = new Set([
  'headings',
  'bold',
  'italic',
  'strike',
  'link',
  'emoji',
  // Future syntax controls reserve placement only. Their tasks create the actions.
  'subscript',
  'superscript',
  'underline',
])

function toolbarRowFor(name: string): ToolbarRow {
  return ROW_ONE.has(name) ? '1' : '2'
}

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
  let previousRow: ToolbarRow | null = null
  let pendingDivider: HTMLElement | null = null

  for (const child of children) {
    const name = itemName(child)
    if (!name) {
      pendingDivider = child
      continue
    }
    const row = toolbarRowFor(name)
    // A divider only separates neighbours in the same row. A row boundary has no visual rule.
    if (pendingDivider && previousRow === row)
      rows[row === '1' ? 0 : 1].append(pendingDivider)
    pendingDivider = null
    rows[row === '1' ? 0 : 1].append(child)
    previousRow = row
  }
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
