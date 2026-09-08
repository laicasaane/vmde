import type Vditor from 'vditor'
const ROW = 'li > span[data-target-id]'

/** Delegated because Vditor rebuilds its outline rows after every editor change. */
export function installOutlineReorder(
  vditor: Vditor,
  apply: (
    sourceIndex: number,
    targetIndex: number,
    placement: 'before' | 'after',
  ) => void,
): () => void {
  const outline = (vditor as any)?.vditor?.outline?.element as
    | HTMLElement
    | undefined
  if (!outline) return () => undefined
  let sourceIndex = -1
  const rows = () => Array.from(outline.querySelectorAll<HTMLElement>(ROW))
  const clear = () =>
    outline
      .querySelectorAll<HTMLElement>('[data-vmde-outline-drop]')
      .forEach((el) => {
        el.removeAttribute('data-vmde-outline-drop')
      })
  const makeRowsDraggable = () => {
    for (const row of rows()) row.draggable = true
  }
  const start = (event: DragEvent) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(ROW)
    sourceIndex = row ? rows().indexOf(row) : -1
    if (sourceIndex < 0 || !event.dataTransfer) return
    event.dataTransfer.setData(
      'application/x-vmde-outline',
      String(sourceIndex),
    )
    event.dataTransfer.effectAllowed = 'move'
  }
  const over = (event: DragEvent) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(ROW)
    if (
      !row ||
      sourceIndex < 0 ||
      !event.dataTransfer?.types.includes('application/x-vmde-outline')
    )
      return
    event.preventDefault()
    clear()
    row.dataset.vmdeOutlineDrop =
      event.clientY <
      row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2
        ? 'before'
        : 'after'
  }
  const drop = (event: DragEvent) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(ROW)
    if (
      !row ||
      sourceIndex < 0 ||
      event.dataTransfer?.getData('application/x-vmde-outline') !==
        String(sourceIndex)
    )
      return
    event.preventDefault()
    const targetIndex = rows().indexOf(row)
    const placement = row.dataset.vmdeOutlineDrop
    clear()
    sourceIndex = -1
    if (targetIndex >= 0 && (placement === 'before' || placement === 'after'))
      apply(
        Number(event.dataTransfer?.getData('application/x-vmde-outline')),
        targetIndex,
        placement,
      )
  }
  const leave = (event: DragEvent) => {
    if (!outline.contains(event.relatedTarget as Node | null)) clear()
  }
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    sourceIndex = -1
    clear()
  }
  // Outline rows are Vditor-owned and replaced wholesale after every edit. Keep the transient
  // drag affordance on the replacement rows without putting non-source DOM in the edit surface.
  const observer = new MutationObserver(() => {
    sourceIndex = -1
    clear()
    makeRowsDraggable()
  })
  outline.addEventListener('dragstart', start)
  outline.addEventListener('dragover', over)
  outline.addEventListener('drop', drop)
  outline.addEventListener('dragend', clear)
  outline.addEventListener('dragleave', leave)
  outline.addEventListener('keydown', keydown)
  observer.observe(outline, { childList: true, subtree: true })
  makeRowsDraggable()
  return () => {
    outline.removeEventListener('dragstart', start)
    outline.removeEventListener('dragover', over)
    outline.removeEventListener('drop', drop)
    outline.removeEventListener('dragend', clear)
    outline.removeEventListener('dragleave', leave)
    outline.removeEventListener('keydown', keydown)
    observer.disconnect()
    clear()
  }
}
