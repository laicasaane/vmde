import {
  scanMovableBlocks,
  type MovableKind,
  type MovableBlock,
} from '../../../src/shared/block-move'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { topLevelBlocks } from './section-range'
import {
  createSourceBlockIndex,
  type BlockHandleUnit,
  type SourceBlockIndexHandle,
} from './source-block-index'

// Task 576 feedback-path pass: BlockHandleUnit now lives in source-block-index.ts (this module's
// own value import of createSourceBlockIndex was the other half of a dependency-cruiser
// `no-circular` pair with source-block-index.ts's former `import type` of this type). Re-exported
// here so every existing importer of `BlockHandleUnit` from this module keeps working unchanged.
export type { BlockHandleUnit }

function domKind(element: HTMLElement): MovableKind | null {
  if (element.tagName === 'LI') return 'list-item'
  if (/^H[1-6]$/u.test(element.tagName)) return 'heading'
  if (element.tagName === 'P') return 'paragraph'
  if (element.tagName === 'BLOCKQUOTE') return 'quote'
  if (element.tagName === 'HR') return 'thematic'
  if (element.tagName === 'TABLE') return 'table'
  if (element.matches('[data-type="code-block"]')) return 'fence'
  if (element.matches('[data-type="html-block"]')) return 'html'
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

function listFoldTargetLeft(item: HTMLElement, rect: DOMRect): number {
  if (item.tagName !== 'LI') return rect.left - 38
  const arrow = getComputedStyle(item, '::after')
  const arrowLeft = Number.parseFloat(arrow.left)
  const arrowWidth = Number.parseFloat(arrow.width)
  if (
    !Number.isFinite(arrowLeft) ||
    !Number.isFinite(arrowWidth) ||
    arrowWidth <= 0
  )
    return rect.left - 38
  let targetLeft = rect.left + arrowLeft
  const marker = getComputedStyle(item, '::marker')
  const markerWidth = Number.parseFloat(marker.width)
  if (
    marker.listStyleType !== 'none' &&
    Number.isFinite(markerWidth) &&
    markerWidth > 0
  ) {
    const markerRight = Math.min(
      rect.left - 2,
      rect.left + arrowLeft + arrowWidth,
    )
    targetLeft = Math.min(targetLeft, markerRight - markerWidth)
  }
  return targetLeft
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
  })
  unitCache.set(root, { ...value, observer })
}

function invalidateUnitProof(root: HTMLElement): void {
  unitCache.get(root)?.observer.disconnect()
  unitCache.delete(root)
}

interface SourceDomPair {
  block: MovableBlock
  members: HTMLElement[]
}

function pairSourceGroups(
  source: readonly MovableBlock[],
  elements: HTMLElement[],
): SourceDomPair[] | null {
  const pairs: SourceDomPair[] = []
  let cursor = 0
  for (const block of source) {
    const expected = block.memberKinds ?? [block.kind]
    const members = elements.slice(cursor, cursor + expected.length)
    if (
      members.length !== expected.length ||
      members.some((element, index) => domKind(element) !== expected[index])
    )
      return null
    pairs.push({ block, members })
    cursor += expected.length
  }
  return cursor === elements.length ? pairs : null
}

/** Rendered-Markdown spans for resolved units (Task 574). Unit offsets are exact-byte offsets, while
 * Details state works in rendered coordinates; rescan the rendered bytes and accept the spans only
 * when they pair one-to-one with the same member groups. No Lute work. */
export function pairRenderedSpans(
  rendered: string,
  units: readonly BlockHandleUnit[],
): Array<[number, number]> | null {
  const pairs = pairSourceGroups(
    scanMovableBlocks(rendered),
    units.flatMap((unit) => unit.members),
  )
  if (!pairs || pairs.length !== units.length) return null
  const spans: Array<[number, number]> = []
  for (const [index, pair] of pairs.entries()) {
    const members = units[index].members
    if (
      pair.members.length !== members.length ||
      pair.members.some((member, position) => member !== members[position])
    )
      return null
    spans.push([pair.block.start, pair.block.end])
  }
  return spans
}

function canonicalMembers(
  members: HTMLElement[],
  proof: BlockProjection,
): string {
  if (members.length === 1) return canonicalUnit(members[0], proof)
  const pieces: string[] = []
  let listRoot: HTMLElement | null = null
  let listOwner: HTMLElement | null = null
  const flushList = () => {
    if (listRoot) pieces.push(listRoot.outerHTML)
    listRoot = null
    listOwner = null
  }
  for (const member of members) {
    if (
      member.tagName === 'LI' &&
      member.parentElement &&
      (member.parentElement.tagName === 'UL' ||
        member.parentElement.tagName === 'OL')
    ) {
      if (listOwner !== member.parentElement) {
        flushList()
        listOwner = member.parentElement
        listRoot = listOwner.cloneNode(false) as HTMLElement
      }
      listRoot?.append(member.cloneNode(true))
    } else {
      flushList()
      pieces.push(member.outerHTML)
    }
  }
  flushList()
  return proof.serialize(pieces.join(''))
}

function fragmentMatches(
  pair: SourceDomPair,
  detachedMembers: HTMLElement[],
  liveMembers: HTMLElement[],
  exactMarkdown: string,
  proof: BlockProjection,
): boolean {
  const { block } = pair
  const sourceFragment = exactMarkdown.slice(block.start, block.sectionEnd)
  // A lone `---` at byte zero is front matter to Lute; a preceding paragraph
  // gives the verified thematic break its original non-front-matter context.
  const input =
    block.kind === 'thematic'
      ? `VMDE proof context\n\n${sourceFragment}`
      : sourceFragment
  const fragment = detachedRoot(proof.render(input))
  const units = domUnits(fragment, false)
  if (!units) return false
  const candidate =
    block.kind === 'thematic' &&
    units.length === 2 &&
    domKind(units[0]) === 'paragraph'
      ? units.slice(1)
      : units
  if (!pairSourceGroups([block], candidate)) return false
  const fragmentMd = canonicalMembers(candidate, proof)
  const detachedMd = canonicalMembers(detachedMembers, proof)
  const liveMd = canonicalMembers(liveMembers, proof)
  return fragmentMd === detachedMd && detachedMd === liveMd
}

function projectionMatches(
  root: HTMLElement,
  source: MovableBlock[],
  live: SourceDomPair[],
  exactMarkdown: string,
  renderedMarkdown: string,
  proof: BlockProjection,
): boolean {
  try {
    const html = proof.render(exactMarkdown)
    if (proof.serialize(html) !== renderedMarkdown) return false
    const detached = detachedRoot(html)
    const projected = domUnits(detached, false)
    const projectedPairs = projected && pairSourceGroups(source, projected)
    if (!projectedPairs) return false
    const liveShape = rootShape(root).filter(
      (_, index, all) =>
        index !== all.length - 1 ||
        !root.lastElementChild?.hasAttribute('data-vmde-trailing'),
    )
    if (JSON.stringify(liveShape) !== JSON.stringify(rootShape(detached)))
      return false
    return live.every((pair, index) =>
      fragmentMatches(
        pair,
        projectedPairs[index].members,
        pair.members,
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
  if (!source.length) return null
  const pairs = pairSourceGroups(source, elements)
  if (!pairs) return null
  if (
    (exactMarkdown !== renderedMarkdown ||
      source.some((block) => (block.memberKinds?.length ?? 1) > 1)) &&
    (!proof ||
      !projectionMatches(
        root,
        source,
        pairs,
        exactMarkdown,
        renderedMarkdown,
        proof,
      ))
  )
    return null
  const units = pairs.map(({ block, members }) => ({
    element: members[0],
    members,
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
  snapshotRevision(): object | undefined
  move(
    sourceStart: number,
    targetStart: number,
    placement: 'before' | 'after',
  ): void | Promise<void>
  delete(start: number): void | Promise<void>
  duplicate(start: number): void | Promise<void>
  turnInto(start: number, end: number): void | Promise<void>
}

function sameUnitIdentity(
  left: BlockHandleUnit,
  right: BlockHandleUnit,
): boolean {
  return (
    left.element === right.element &&
    left.kind === right.kind &&
    left.members.length === right.members.length &&
    left.members.every((member, index) => member === right.members[index])
  )
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
  sharedIndex?: SourceBlockIndexHandle,
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
  let dragging: { unit: BlockHandleUnit; start: number; exact: string } | null =
    null
  let nativeSelecting = false
  let nativeSelectionRoot: HTMLElement | null = null
  let nativeSelectionOwner: InnerVditor | null = null
  let nativeSelectionMode: InnerVditor['currentMode'] | null = null

  const hideIndicator = () => {
    indicator.hidden = true
  }
  const index =
    sharedIndex ??
    createSourceBlockIndex({
      getActiveRoot,
      projection: currentBlockProjection,
      snapshotPair: () => actions.snapshot(),
      snapshotRevision: () => actions.snapshotRevision(),
      resolveUnits: (root, exact, rendered) =>
        resolveBlockHandleUnits(
          root,
          exact,
          rendered,
          currentBlockProjection(),
        ),
    })
  const indexRoots = new Set<HTMLElement>()
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
    // The Task 565 heading and Task 569 list-fold targets use the 36px before a block.
    // When a narrow pane has no left gutter, use the far right edge instead.
    const rightFallback = rect.left < 50
    // Leave a 2px lane before the computed fold target, including wide native list markers.
    const left = rightFallback
      ? rect.right - 12
      : listFoldTargetLeft(unit.element, rect) - 14
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
  const clearUnsafeState = () => {
    positionHandle(null)
    dragging = null
    hideIndicator()
  }
  const onIndexInvalidate = (
    reason: 'dom' | 'revision' | 'authority',
    root: HTMLElement | null,
  ): void => {
    if (reason === 'authority') {
      clearUnsafeState()
      return
    }
    if (reason !== 'dom') return
    if (root) {
      indexRoots.add(root)
      invalidateUnitProof(root)
    }
    // A connected target remains a display candidate; every action re-proves it from fresh source.
    if (
      active &&
      (!active.element.isConnected || !root?.contains(active.element))
    )
      clearUnsafeState()
    else if (
      dragging &&
      (!dragging.unit.element.isConnected ||
        !root?.contains(dragging.unit.element))
    ) {
      dragging = null
      hideMenu()
      hideIndicator()
    }
  }
  const stopIndexInvalidation = index.onInvalidate(onIndexInvalidate)
  const resolveFreshUnits = (
    snapshot?: { exact: string; rendered: string } | null,
  ): BlockHandleUnit[] | null => {
    const root = getActiveRoot()
    if (!root?.isConnected || root.getAttribute('contenteditable') === 'false')
      return null
    const source = snapshot === undefined ? actions.snapshot() : snapshot
    if (!source) return null
    return resolveBlockHandleUnits(
      root,
      source.exact,
      source.rendered,
      currentBlockProjection(),
    )
  }
  // Presentation reads share the per-revision source index. Without a cacheable key (no
  // projection or revision authority), resolve uncached exactly as before the index existed.
  const units = (): BlockHandleUnit[] | null => {
    const entry = index.read()
    return entry ? entry.units : resolveFreshUnits()
  }
  const unitForTarget = (
    current: BlockHandleUnit[] | null,
    target: EventTarget | null,
  ): BlockHandleUnit | null => {
    const node = target instanceof Node ? target : null
    return current?.find((unit) => node && unit.element.contains(node)) ?? null
  }
  const unitAt = (target: EventTarget | null): BlockHandleUnit | null =>
    unitForTarget(units(), target)
  const resolveCurrentUnit = (
    source: BlockHandleUnit | null,
    snapshot?: { exact: string; rendered: string } | null,
  ): BlockHandleUnit | null => {
    if (!source) return null
    const current = resolveFreshUnits(snapshot)
    const matches =
      current?.filter((unit) => sameUnitIdentity(source, unit)) ?? []
    if (matches.length !== 1) {
      clearUnsafeState()
      return null
    }
    return matches[0]
  }
  const ensureOwner = () => {
    const root = getActiveRoot()
    if (
      active &&
      (!active.element.isConnected || !root?.contains(active.element))
    ) {
      clearUnsafeState()
    }
  }
  const clearNativeSelection = () => {
    nativeSelecting = false
    nativeSelectionRoot = null
    nativeSelectionOwner = null
    nativeSelectionMode = null
  }
  const onNativePointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || event.isPrimary === false) return
    const root = getActiveRoot()
    if (
      !root?.isConnected ||
      root.getAttribute('contenteditable') === 'false' ||
      !root.contains(event.target as Node)
    )
      return
    const owner = innerVditor()
    nativeSelecting = true
    nativeSelectionRoot = root
    nativeSelectionOwner = owner ?? null
    nativeSelectionMode = owner?.currentMode ?? null
    positionHandle(null)
    hideIndicator()
  }
  const finishNativeSelection = () => {
    if (!nativeSelecting) return
    clearNativeSelection()
    positionHandle(null)
    hideIndicator()
  }
  /** True while a native text-selection gesture must keep block-hover work suppressed. */
  const nativeSelectionSuppressesHover = (
    event: MouseEvent,
    root: HTMLElement,
  ): boolean => {
    const owner = innerVditor() ?? null
    if (
      nativeSelecting &&
      (nativeSelectionRoot !== root ||
        nativeSelectionOwner !== owner ||
        nativeSelectionMode !== (owner?.currentMode ?? null))
    )
      clearNativeSelection()
    // A release outside the webview can skip both pointerup and blur, which would leave
    // nativeSelecting set and the handle hidden until the next click. A move without the primary
    // button proves the gesture ended, so release it and continue with the ordinary hover.
    if (nativeSelecting && (event.buttons & 1) === 0) finishNativeSelection()
    // Native text drags mutate selection ranges. Avoid unit lookup/projection while the primary
    // pointer is held; event.buttons also covers moves whose pointerdown was outside our document.
    return nativeSelecting || (event.buttons & 1) !== 0
  }
  let cancelDeferredHover: (() => void) | null = null
  const hoverUnit = (target: EventTarget | null, root: HTMLElement) => {
    const warm = index.peek()
    if (warm) {
      positionHandle(unitForTarget(warm.units, target))
      return
    }
    // Task 577: Chromium's own mousemove right after a selection's pointerup reached this cold
    // build before the selection bubble's first frame. The index runs it at once unless the
    // bubble holds builds; a held lookup resumes only for this still-current hover.
    cancelDeferredHover = index.readWhenReady((entry) => {
      cancelDeferredHover = null
      const node = target instanceof Node ? target : null
      if (
        dragging ||
        !menu.hidden ||
        nativeSelecting ||
        !node?.isConnected ||
        getActiveRoot() !== root ||
        !root.contains(node)
      )
        return
      positionHandle(
        unitForTarget(entry ? entry.units : resolveFreshUnits(), target),
      )
    })
  }
  const hover = (event: MouseEvent) => {
    cancelDeferredHover?.()
    ensureOwner()
    if (dragging || !menu.hidden || layer.contains(event.target as Node)) return
    const root = getActiveRoot()
    if (!root?.contains(event.target as Node)) return
    if (nativeSelectionSuppressesHover(event, root)) {
      positionHandle(null)
      return
    }
    hoverUnit(event.target, root)
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
    currentUnits?: BlockHandleUnit[] | null,
  ): { unit: BlockHandleUnit; placement: 'before' | 'after' } | null => {
    const unit =
      currentUnits === undefined
        ? unitAt(event.target)
        : unitForTarget(currentUnits, event.target)
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
  const completeInternalDrop = (
    event: DragEvent,
    snapshot: { exact: string; rendered: string } | null,
    current: BlockHandleUnit[] | null,
    boundary: { unit: BlockHandleUnit; placement: 'before' | 'after' } | null,
  ): void => {
    const drag = dragging
    if (!drag) return
    const sources = current?.filter((unit) => sameUnitIdentity(drag.unit, unit))
    const matchingTransfer =
      event.dataTransfer?.getData(BLOCK_DRAG_MIME) === String(drag.start)
    if (
      !boundary ||
      sources?.length !== 1 ||
      snapshot?.exact !== drag.exact ||
      !matchingTransfer
    ) {
      clearUnsafeState()
      return
    }
    const source = sources[0]
    clearUnsafeState()
    void actions.move(source.start, boundary.unit.start, boundary.placement)
  }
  const onDrop = (event: DragEvent) => {
    ensureOwner()
    const dataTypes = Array.from(event.dataTransfer?.types ?? [])
    const internal = dataTypes.includes(BLOCK_DRAG_MIME) || dragging !== null
    if (internal) {
      event.preventDefault()
      event.stopImmediatePropagation()
      const snapshot = actions.snapshot()
      const current = resolveFreshUnits(snapshot)
      const root = getActiveRoot()
      const boundary = root?.contains(event.target as Node)
        ? boundaryAt(event, current)
        : null
      completeInternalDrop(event, snapshot, current, boundary)
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
    const current = resolveFreshUnits()
    const index =
      current?.findIndex((unit) => node && unit.element.contains(node)) ?? -1
    const target =
      current &&
      keyboardTarget(current, index, event.key === 'ArrowUp' ? -1 : 1)
    const source = current?.[index]
    if (!source?.movable || !target) return
    event.preventDefault()
    clearUnsafeState()
    void actions.move(
      source.start,
      target.start,
      event.key === 'ArrowUp' ? 'before' : 'after',
    )
  }
  const onHandleDragStart = (event: DragEvent) => {
    ensureOwner()
    const displayed = active
    if (!displayed?.movable || !event.dataTransfer) {
      event.preventDefault()
      return
    }
    const snapshot = actions.snapshot()
    const source = resolveCurrentUnit(displayed, snapshot)
    if (!source?.movable || !snapshot) {
      event.preventDefault()
      return
    }
    dragging = { unit: source, start: source.start, exact: snapshot.exact }
    event.dataTransfer.setData(BLOCK_DRAG_MIME, String(source.start))
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
        button.dataset.action === 'turnInto'
          ? ['html', 'html-group', 'table', 'thematic'].includes(active.kind)
          : active.kind === 'heading'
    }
  }
  const onMenuClick = (event: MouseEvent) => {
    ensureOwner()
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '[data-action]',
    )?.dataset.action
    const displayed = active
    hideMenu()
    if (!displayed || !action) return
    const snapshot = actions.snapshot()
    const source = resolveCurrentUnit(displayed, snapshot)
    if (!source) return
    if (
      action === 'turnInto' &&
      !['html', 'html-group', 'table', 'thematic'].includes(source.kind)
    ) {
      clearUnsafeState()
      void actions.turnInto(source.start, source.end)
    } else if (source.kind !== 'heading' && action === 'duplicate') {
      clearUnsafeState()
      void actions.duplicate(source.start)
    } else if (source.kind !== 'heading' && action === 'delete') {
      clearUnsafeState()
      void actions.delete(source.start)
    }
  }
  document.addEventListener('pointerdown', onNativePointerDown, true)
  document.addEventListener('pointerup', finishNativeSelection, true)
  document.addEventListener('pointercancel', finishNativeSelection, true)
  window.addEventListener('blur', finishNativeSelection)
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
    cancelDeferredHover?.()
    stopIndexInvalidation()
    // A shared index belongs to its creator; only the layer's own default index is disposed here.
    if (!sharedIndex) index.dispose()
    const rootsToClear = new Set([...ownedRoots, ...indexRoots])
    const activeRoot = getActiveRoot()
    if (activeRoot) rootsToClear.add(activeRoot)
    for (const root of rootsToClear) invalidateUnitProof(root)
    clearNativeSelection()
    document.removeEventListener('pointerdown', onNativePointerDown, true)
    document.removeEventListener('pointerup', finishNativeSelection, true)
    document.removeEventListener('pointercancel', finishNativeSelection, true)
    window.removeEventListener('blur', finishNativeSelection)
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
