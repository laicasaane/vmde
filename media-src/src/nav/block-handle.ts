import {
  scanMovableBlocks,
  type MovableKind,
} from '../../../src/shared/block-move'
import { innerVditor } from '../util/inner-vditor'
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

function domUnits(
  root: HTMLElement,
  allowTrailing: boolean,
): HTMLElement[] | null {
  const blocks = topLevelBlocks(root)
  const last = blocks.at(-1)
  if (last?.hasAttribute('data-vmde-trailing')) {
    if (
      !allowTrailing ||
      last.tagName !== 'P' ||
      last.children.length ||
      !/^[\u200b\s]*$/u.test(last.textContent ?? '')
    )
      return null
    blocks.pop()
  }
  if (blocks.some((block) => block.hasAttribute('data-vmde-trailing')))
    return null
  const units: HTMLElement[] = []
  for (const block of blocks) {
    if (block.tagName === 'UL' || block.tagName === 'OL') {
      units.push(
        ...Array.from(block.children).filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement && child.tagName === 'LI',
        ),
      )
      if (Array.from(block.children).some((child) => child.tagName !== 'LI'))
        return null
    } else {
      units.push(block)
    }
  }
  return units
}

export interface BlockProjection {
  owner: object
  mode: 'ir' | 'wysiwyg'
  render(markdown: string): string
  serialize(html: string): string
}

/** Use the same live Lute and mode as Vditor, but render into a detached root. */
export function currentBlockProjection(): BlockProjection | null {
  const inner = innerVditor()
  const lute = inner?.lute
  const mode = inner?.currentMode
  if (
    !lute ||
    (mode !== 'ir' && mode !== 'wysiwyg') ||
    typeof lute.Md2VditorIRDOM !== 'function' ||
    typeof lute.Md2VditorDOM !== 'function'
  )
    return null
  const renderIr = lute.Md2VditorIRDOM.bind(lute)
  const renderWys = lute.Md2VditorDOM.bind(lute)
  return {
    owner: lute,
    mode,
    render: (markdown) =>
      mode === 'ir' ? renderIr(markdown) : renderWys(markdown),
    serialize: (html) =>
      mode === 'ir' ? lute.VditorIRDOM2Md(html) : lute.VditorDOM2Md(html),
  }
}

function detachedRoot(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

function canonicalUnit(unit: HTMLElement, proof: BlockProjection): string {
  if (unit.tagName !== 'LI') return proof.serialize(unit.outerHTML)
  const list = unit.parentElement
  if (!list || (list.tagName !== 'UL' && list.tagName !== 'OL')) return ''
  const isolated = list.cloneNode(false) as HTMLElement
  isolated.append(unit.cloneNode(true))
  return proof.serialize(isolated.outerHTML)
}

function rootShape(root: HTMLElement): string[] {
  return topLevelBlocks(root).map((block) =>
    block.tagName === 'UL' || block.tagName === 'OL'
      ? `${block.tagName}:${Array.from(block.children).filter((child) => child.tagName === 'LI').length}`
      : block.tagName,
  )
}

interface CacheEntry {
  exact: string
  rendered: string
  owner?: object
  mode?: string
  elements: HTMLElement[]
  units: BlockHandleUnit[]
  observer: MutationObserver
}
const unitCache = new WeakMap<HTMLElement, CacheEntry>()

function cacheUnits(
  root: HTMLElement,
  value: Omit<CacheEntry, 'observer'>,
): void {
  unitCache.get(root)?.observer.disconnect()
  const observer = new MutationObserver(() => {
    if (unitCache.get(root)?.observer === observer) unitCache.delete(root)
    observer.disconnect()
  })
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'data-type',
      'data-block',
      'data-render',
      'contenteditable',
      'data-vmde-trailing',
      'data-marker',
    ],
  })
  unitCache.set(root, { ...value, observer })
}

function fragmentMatches(
  block: ReturnType<typeof scanMovableBlocks>[number],
  detachedUnit: HTMLElement,
  liveUnit: HTMLElement,
  exactMarkdown: string,
  proof: BlockProjection,
): boolean {
  const sourceFragment = exactMarkdown.slice(block.start, block.sectionEnd)
  // A lone `---` at byte zero is front matter to Lute; the verified full
  // document gives a thematic break its preceding paragraph context.
  const input =
    block.kind === 'thematic'
      ? `VMDE proof context\n\n${sourceFragment}`
      : sourceFragment
  const fragment = detachedRoot(proof.render(input))
  const units = domUnits(fragment, false)
  const candidate =
    block.kind === 'thematic' &&
    units?.length === 2 &&
    domKind(units[0]) === 'paragraph'
      ? units[1]
      : units?.[0]
  if (
    !candidate ||
    units?.length !== (block.kind === 'thematic' ? 2 : 1) ||
    domKind(candidate) !== block.kind
  )
    return false
  const fragmentMd = canonicalUnit(candidate, proof)
  const detachedMd = canonicalUnit(detachedUnit, proof)
  const liveMd = canonicalUnit(liveUnit, proof)
  return fragmentMd === detachedMd && detachedMd === liveMd
}

function projectionMatches(
  root: HTMLElement,
  source: ReturnType<typeof scanMovableBlocks>,
  live: HTMLElement[],
  exactMarkdown: string,
  renderedMarkdown: string,
  proof: BlockProjection,
): boolean {
  try {
    const html = proof.render(exactMarkdown)
    if (proof.serialize(html) !== renderedMarkdown) return false
    const detached = detachedRoot(html)
    const projected = domUnits(detached, false)
    if (
      !projected ||
      projected.length !== source.length ||
      projected.some((unit, index) => domKind(unit) !== source[index].kind)
    )
      return false
    const liveShape = rootShape(root).filter(
      (_, index, all) =>
        index !== all.length - 1 ||
        !root.lastElementChild?.hasAttribute('data-vmde-trailing'),
    )
    if (JSON.stringify(liveShape) !== JSON.stringify(rootShape(detached)))
      return false
    return source.every((block, index) =>
      fragmentMatches(
        block,
        projected[index],
        live[index],
        exactMarkdown,
        proof,
      ),
    )
  } catch {
    return false
  }
}

/** Map only exact source spans whose detached projection and live DOM agree. */
export function resolveBlockHandleUnits(
  root: HTMLElement,
  exactMarkdown: string,
  renderedMarkdown: string,
  proof?: BlockProjection | null,
): BlockHandleUnit[] | null {
  const elements = domUnits(root, true)
  if (!elements) return null
  let cached = unitCache.get(root)
  if (cached?.observer.takeRecords().length) {
    cached.observer.disconnect()
    unitCache.delete(root)
    cached = undefined
  }
  if (
    cached &&
    cached.exact === exactMarkdown &&
    cached.rendered === renderedMarkdown &&
    cached.owner === proof?.owner &&
    cached.mode === proof?.mode &&
    cached.elements.length === elements.length &&
    cached.elements.every(
      (element, index) => element === elements[index] && element.isConnected,
    )
  )
    return cached.units
  if (proof) {
    try {
      if (proof.serialize(root.innerHTML) !== renderedMarkdown) return null
    } catch {
      return null
    }
  }
  const source = scanMovableBlocks(exactMarkdown)
  if (!source.length || source.length !== elements.length) return null
  if (source.some((block, index) => domKind(elements[index]) !== block.kind))
    return null
  if (
    exactMarkdown !== renderedMarkdown &&
    (!proof ||
      !projectionMatches(
        root,
        source,
        elements,
        exactMarkdown,
        renderedMarkdown,
        proof,
      ))
  )
    return null
  const units = source.map((block, index) => ({
    element: elements[index],
    start: block.start,
    end: block.end,
    kind: block.kind,
    movable: true,
  }))
  cacheUnits(root, {
    exact: exactMarkdown,
    rendered: renderedMarkdown,
    owner: proof?.owner,
    mode: proof?.mode,
    elements,
    units,
  })
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

function keyboardTarget(
  units: BlockHandleUnit[],
  index: number,
  direction: -1 | 1,
): BlockHandleUnit | undefined {
  const source = units[index]
  if (!source) return undefined
  if (source.kind !== 'heading') return units[index + direction]
  const candidates =
    direction < 0 ? units.slice(0, index).reverse() : units.slice(index + 1)
  return candidates.find(
    (unit) =>
      unit.kind === 'heading' &&
      unit.element.tagName === source.element.tagName,
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
  const owner = innerVditor()
  const ownedRoots = [owner?.ir?.element, owner?.wysiwyg?.element].filter(
    (element): element is HTMLElement => Boolean(element),
  )
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
    return resolveBlockHandleUnits(
      root,
      snapshot.exact,
      snapshot.rendered,
      currentBlockProjection(),
    )
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
    // Task 565's fold hit area occupies the 36px before a heading. When a narrow
    // pane has no left gutter, use the block's far right edge instead of covering it.
    const rightFallback = rect.left < 50
    const left = rightFallback ? rect.right - 12 : rect.left - 50
    handle.style.left = `${left}px`
    handle.style.top = `${rect.top + 2}px`
    handle.hidden =
      rect.width <= 0 ||
      rect.height <= 0 ||
      left < 0 ||
      left + 12 > window.innerWidth
    handle.setAttribute('aria-disabled', unit.movable ? 'false' : 'true')
    menu.style.left = `${rightFallback ? Math.max(0, rect.right - 160) : left}px`
    menu.style.top = `${rect.top + 26}px`
  }
  const ensureOwner = () => {
    const root = getActiveRoot()
    if (
      active &&
      (!active.element.isConnected || !root?.contains(active.element))
    ) {
      positionHandle(null)
      dragging = null
      hideIndicator()
    }
  }
  const hover = (event: MouseEvent) => {
    ensureOwner()
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
    ensureOwner()
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
    ensureOwner()
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
    const target =
      current &&
      keyboardTarget(current, index, event.key === 'ArrowUp' ? -1 : 1)
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
    ensureOwner()
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
    ensureOwner()
    if (!active) return
    menu.hidden = !menu.hidden
    for (const button of Array.from(
      menu.querySelectorAll<HTMLButtonElement>('button'),
    )) {
      button.disabled =
        active.kind === 'heading' && button.dataset.action !== 'turnInto'
    }
  }
  const onMenuClick = (event: MouseEvent) => {
    ensureOwner()
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '[data-action]',
    )?.dataset.action
    const source = active
    hideMenu()
    if (!source || !action) return
    if (action === 'turnInto') void actions.turnInto(source.start, source.end)
    else if (source.kind !== 'heading' && action === 'duplicate')
      void actions.duplicate(source.start)
    else if (source.kind !== 'heading' && action === 'delete')
      void actions.delete(source.start)
  }
  const observer = new MutationObserver(ensureOwner)
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
    for (const root of ownedRoots) {
      unitCache.get(root)?.observer.disconnect()
      unitCache.delete(root)
    }
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
