import {
  scanMovableBlocks,
  type MovableKind,
} from '../../../src/shared/block-move'
import { topLevelBlocks } from './section-range'

export interface BlockHandleUnit {
  element: HTMLElement
  start: number
  end: number
  kind: MovableKind
  movable: boolean
}

function domKind(element: HTMLElement): MovableKind | null {
  if (element.tagName === 'LI') return 'list-item'
  if (/^H[1-6]$/u.test(element.tagName)) return 'heading'
  if (element.tagName === 'P') return 'paragraph'
  if (element.tagName === 'BLOCKQUOTE') return 'quote'
  if (element.tagName === 'HR') return 'thematic'
  if (element.tagName === 'TABLE') return 'table'
  if (element.matches('[data-type="code-block"]')) return 'fence'
  if (element.querySelector(':scope > table')) return 'table'
  return null
}

function domUnits(root: HTMLElement): HTMLElement[] {
  const units: HTMLElement[] = []
  for (const block of topLevelBlocks(root)) {
    if (block.tagName === 'UL' || block.tagName === 'OL') {
      units.push(
        ...Array.from(block.children).filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement && child.tagName === 'LI',
        ),
      )
    } else {
      units.push(block)
    }
  }
  return units
}

/** An ordinal is usable only when exact and rendered source and every DOM block kind agree. */
export function resolveBlockHandleUnits(
  root: HTMLElement,
  exactMarkdown: string,
  renderedMarkdown: string,
): BlockHandleUnit[] | null {
  if (exactMarkdown !== renderedMarkdown) return null
  const source = scanMovableBlocks(exactMarkdown)
  const elements = domUnits(root)
  if (!source.length || source.length !== elements.length) return null
  const units: BlockHandleUnit[] = []
  for (let index = 0; index < source.length; index++) {
    const block = source[index]
    const element = elements[index]
    if (domKind(element) !== block.kind) return null
    units.push({
      element,
      start: block.start,
      end: block.end,
      kind: block.kind,
      movable: block.kind !== 'heading',
    })
  }
  return units
}

export interface BlockHandleActions {
  snapshot(): { exact: string; rendered: string } | null
  move(
    sourceStart: number,
    targetStart: number,
    placement: 'before' | 'after',
  ): void | Promise<void>
  delete(start: number): void | Promise<void>
  duplicate(start: number): void | Promise<void>
  turnInto(start: number, end: number): void | Promise<void>
}

const BLOCK_DRAG_MIME = 'application/x-vmde-block'

function isMoveChord(event: KeyboardEvent): boolean {
  return (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.isComposing &&
    (event.key === 'ArrowUp' || event.key === 'ArrowDown')
  )
}

/** One external handle, menu and indicator for whichever visual editor mode is active. */
export function installBlockHandleLayer(
  getActiveRoot: () => HTMLElement | null,
  actions: BlockHandleActions,
): () => void {
  const layer = document.createElement('div')
  layer.className = 'vmde-block-layer'
  const handle = document.createElement('button')
  handle.type = 'button'
  handle.className = 'vmde-block-handle'
  handle.textContent = '⋮⋮'
  handle.setAttribute('aria-label', 'Block actions')
  handle.draggable = true
  handle.hidden = true
  const indicator = document.createElement('div')
  indicator.className = 'vmde-block-drop-indicator'
  indicator.hidden = true
  const menu = document.createElement('div')
  menu.className = 'vmde-block-handle-menu'
  menu.setAttribute('role', 'menu')
  menu.hidden = true
  for (const [action, label] of [
    ['turnInto', 'Turn Into…'],
    ['duplicate', 'Duplicate Block'],
    ['delete', 'Delete Block'],
  ] as const) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.action = action
    button.textContent = label
    button.setAttribute('role', 'menuitem')
    menu.append(button)
  }
  layer.append(handle, indicator, menu)
  document.body.append(layer)
  let active: BlockHandleUnit | null = null
  let dragging: { start: number; exact: string } | null = null

  const units = (): BlockHandleUnit[] | null => {
    const root = getActiveRoot()
    const snapshot = actions.snapshot()
    if (
      !root?.isConnected ||
      !snapshot ||
      root.getAttribute('contenteditable') === 'false'
    )
      return null
    return resolveBlockHandleUnits(root, snapshot.exact, snapshot.rendered)
  }
  const unitAt = (target: EventTarget | null): BlockHandleUnit | null => {
    const node = target instanceof Node ? target : null
    return units()?.find((unit) => node && unit.element.contains(node)) ?? null
  }
  const hideIndicator = () => {
    indicator.hidden = true
  }
  const hideMenu = () => {
    menu.hidden = true
  }
  const positionHandle = (unit: BlockHandleUnit | null) => {
    active = unit
    if (!unit) {
      handle.hidden = true
      hideMenu()
      return
    }
    const rect = unit.element.getBoundingClientRect()
    // Task 565's heading-fold pseudo-target occupies the 36px immediately before a
    // heading. Keep the handle farther left with a visible gap instead of stealing it.
    handle.style.left = `${rect.left - 50}px`
    handle.style.top = `${rect.top + 2}px`
    handle.hidden = rect.width <= 0 || rect.height <= 0 || rect.left < 50
    handle.setAttribute('aria-disabled', unit.movable ? 'false' : 'true')
    menu.style.left = `${rect.left - 50}px`
    menu.style.top = `${rect.top + 26}px`
  }
  const hover = (event: MouseEvent) => {
    if (dragging || !menu.hidden || layer.contains(event.target as Node)) return
    const root = getActiveRoot()
    if (!root?.contains(event.target as Node)) return
    positionHandle(unitAt(event.target))
  }
  const showBoundary = (
    unit: BlockHandleUnit,
    placement: 'before' | 'after',
  ) => {
    const rect = unit.element.getBoundingClientRect()
    indicator.style.left = `${rect.left}px`
    indicator.style.width = `${rect.width}px`
    indicator.style.top = `${placement === 'before' ? rect.top : rect.bottom}px`
    indicator.hidden = false
  }
  const boundaryAt = (
    event: DragEvent,
  ): { unit: BlockHandleUnit; placement: 'before' | 'after' } | null => {
    const unit = unitAt(event.target)
    if (!unit) return null
    const rect = unit.element.getBoundingClientRect()
    return {
      unit,
      placement:
        event.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
    }
  }
  const onDragOver = (event: DragEvent) => {
    const dataTypes = Array.from(event.dataTransfer?.types ?? [])
    const internal = dataTypes.includes(BLOCK_DRAG_MIME) || dragging !== null
    if (internal) {
      // A stale or unsupported handle target must never fall through to Vditor's
      // native content/text drop path. Files and ordinary text drags stay outside this gate.
      event.preventDefault()
      event.stopImmediatePropagation()
      const root = getActiveRoot()
      const boundary = root?.contains(event.target as Node)
        ? boundaryAt(event)
        : null
      if (boundary) showBoundary(boundary.unit, boundary.placement)
      else hideIndicator()
      return
    }
    if (!dataTypes.includes('Files')) return
    const root = getActiveRoot()
    if (!root?.contains(event.target as Node)) return
    const boundary = boundaryAt(event)
    if (boundary) showBoundary(boundary.unit, boundary.placement)
  }
  const onDrop = (event: DragEvent) => {
    const dataTypes = Array.from(event.dataTransfer?.types ?? [])
    const internal = dataTypes.includes(BLOCK_DRAG_MIME) || dragging !== null
    const boundary = internal ? boundaryAt(event) : null
    const snapshot = internal ? actions.snapshot() : null
    if (internal) {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (
        dragging &&
        boundary &&
        snapshot?.exact === dragging.exact &&
        event.dataTransfer?.getData(BLOCK_DRAG_MIME) === String(dragging.start)
      )
        void actions.move(
          dragging.start,
          boundary.unit.start,
          boundary.placement,
        )
    }
    dragging = null
    hideIndicator()
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      dragging = null
      hideIndicator()
      hideMenu()
      return
    }
    if (!isMoveChord(event)) return
    const root = getActiveRoot()
    if (!root?.contains(event.target as Node)) return
    const node = document.getSelection()?.anchorNode
    const current = units()
    const index =
      current?.findIndex((unit) => node && unit.element.contains(node)) ?? -1
    const target = current?.[index + (event.key === 'ArrowUp' ? -1 : 1)]
    const source = current?.[index]
    if (!source?.movable || !target) return
    event.preventDefault()
    void actions.move(
      source.start,
      target.start,
      event.key === 'ArrowUp' ? 'before' : 'after',
    )
  }
  const onHandleDragStart = (event: DragEvent) => {
    const snapshot = actions.snapshot()
    if (!active?.movable || !snapshot || !event.dataTransfer) {
      event.preventDefault()
      return
    }
    dragging = { start: active.start, exact: snapshot.exact }
    event.dataTransfer.setData(BLOCK_DRAG_MIME, String(active.start))
    event.dataTransfer.effectAllowed = 'move'
    hideMenu()
    event.stopPropagation()
  }
  const onHandleClick = () => {
    if (!active) return
    menu.hidden = !menu.hidden
    for (const button of Array.from(
      menu.querySelectorAll<HTMLButtonElement>('button'),
    )) {
      button.disabled = !active.movable && button.dataset.action !== 'turnInto'
    }
  }
  const onMenuClick = (event: MouseEvent) => {
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '[data-action]',
    )?.dataset.action
    const source = active
    hideMenu()
    if (!source || !action) return
    if (action === 'turnInto') void actions.turnInto(source.start, source.end)
    else if (source.movable && action === 'duplicate')
      void actions.duplicate(source.start)
    else if (source.movable && action === 'delete')
      void actions.delete(source.start)
  }
  const observer = new MutationObserver(() => {
    if (active && !active.element.isConnected) positionHandle(null)
    dragging = null
    hideIndicator()
    hideMenu()
  })
  const initialRoot = getActiveRoot()
  if (initialRoot)
    observer.observe(initialRoot, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    })
  document.addEventListener('mousemove', hover, true)
  document.addEventListener('dragover', onDragOver, true)
  document.addEventListener('drop', onDrop, true)
  document.addEventListener('keydown', onKeydown, true)
  handle.addEventListener('dragstart', onHandleDragStart)
  const onHandleDragEnd = () => {
    dragging = null
    hideIndicator()
  }
  handle.addEventListener('dragend', onHandleDragEnd)
  handle.addEventListener('click', onHandleClick)
  menu.addEventListener('click', onMenuClick)
  return () => {
    observer.disconnect()
    document.removeEventListener('mousemove', hover, true)
    document.removeEventListener('dragover', onDragOver, true)
    document.removeEventListener('drop', onDrop, true)
    document.removeEventListener('keydown', onKeydown, true)
    handle.removeEventListener('dragstart', onHandleDragStart)
    handle.removeEventListener('dragend', onHandleDragEnd)
    handle.removeEventListener('click', onHandleClick)
    menu.removeEventListener('click', onMenuClick)
    layer.remove()
  }
}
