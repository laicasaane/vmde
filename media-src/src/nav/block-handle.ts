import { countBlockActionDecline } from '../util/block-action-declines'
import {
  scanMovableBlocks,
  type BlockActionIntent,
  type MovableBlock,
} from '../../../src/shared/block-move'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { topLevelBlocks } from './section-range'
import {
  createSourceBlockIndex,
  type BlockHandleUnit,
  type SourceBlockIndex,
  type SourceBlockIndexHandle,
} from './source-block-index'
import {
  detachedRoot,
  domKind,
  domUnits,
  fragmentMatches,
  pairSourceGroups,
  type BlockProjection,
  type SourceDomPair,
} from './unit-pairing'

// Task 733: BlockProjection lives in unit-pairing.ts (a type import back into this module was a
// dependency-cruiser `no-circular` pair, as with BlockHandleUnit below). Re-exported so every
// importer of it from this module keeps working unchanged.
export type { BlockProjection }

// Task 576 feedback-path pass: BlockHandleUnit now lives in source-block-index.ts (this module's
// own value import of createSourceBlockIndex was the other half of a dependency-cruiser
// `no-circular` pair with source-block-index.ts's former `import type` of this type). Re-exported
// here so every existing importer of `BlockHandleUnit` from this module keeps working unchanged.
export type { BlockHandleUnit }

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
    domKind,
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
    const projectedPairs =
      projected && pairSourceGroups(source, projected, domKind)
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

function unitsOfPairs(pairs: SourceDomPair[]): BlockHandleUnit[] {
  return pairs.map(({ block, members }) => ({
    element: members[0],
    members,
    start: block.start,
    end: block.end,
    kind: block.kind,
    movable: block.kind !== 'front-matter',
  }))
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
  const pairs = pairSourceGroups(source, elements, domKind)
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
  const units = unitsOfPairs(pairs)
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

/**
 * Task 700: advisory units for passive UI state when the exact key was rejected. They pair the
 * rendered bytes with the live DOM and need no projection proof, so a multi-member block gives
 * `null`. They are never exact offsets, and they bypass `unitCache` on purpose: writing an entry
 * would evict the exact-keyed one, and the next block-handle read would repeat the projection
 * proof (a whole-document Lute call).
 */
export function resolveAdvisoryBlockHandleUnits(
  root: HTMLElement,
  renderedMarkdown: string,
): BlockHandleUnit[] | null {
  const elements = domUnits(root, true)
  if (!elements) return null
  const source = scanMovableBlocks(renderedMarkdown)
  if (!source.length) return null
  if (source.some((block) => (block.memberKinds?.length ?? 1) > 1)) return null
  const pairs = pairSourceGroups(source, elements, domKind)
  return pairs ? unitsOfPairs(pairs) : null
}

/**
 * Task 607: the exact text the offsets of one action were computed from. The block client acts on
 * the host's bytes, pulled after the action started; when those differ from `exact`, the old
 * offsets name nothing. `rederive` (keyboard move) rebuilds the action from the live caret on the
 * acquired bytes; without it the action declines.
 */
export interface BlockActionBasis {
  exact: string
  rederive?(pair: { exact: string; rendered: string }): BlockActionIntent | null
}

export interface BlockHandleActions {
  snapshot(): { exact: string; rendered: string } | null
  snapshotRevision(): object | undefined
  /** Task 607: settle typing and pull the host's bytes (never a rebased pair); `null` when no
   * proof of the live rendering exists. Only the keyboard move uses it, because a caret move has
   * no handle to wait for: without an owned exact source there are no units to plan on. */
  acquireExactAuthority?(): Promise<{ exact: string; rendered: string } | null>
  move(
    sourceStart: number,
    targetStart: number,
    placement: 'before' | 'after',
    basis: BlockActionBasis,
  ): void | Promise<void>
  delete(start: number, basis: BlockActionBasis): void | Promise<void>
  duplicate(start: number, basis: BlockActionBasis): void | Promise<void>
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

export type BlockMoveDirection = 'up' | 'down'

// The installed layer's caret move, or undefined before install and after dispose.
let moveCaretBlock: ((direction: BlockMoveDirection) => boolean) | undefined

/**
 * Task 580 — the `vmde.moveBlockUp` / `vmde.moveBlockDown` editor actions (VS Code's Move Line
 * Up/Down keys, Alt+Up / Alt+Down). Moves the block that holds the caret past its neighbour, as
 * the handle's drag does; a heading moves its whole section past the previous or next heading of
 * the same level. The dispatcher restores the command selection snapshot first, because macOS
 * Option+Up/Down moves the caret natively before the command arrives. Returns whether a move was
 * requested; Split View, a caret outside a movable block, and an edge block do nothing.
 */
export function moveBlockAtCaret(direction: BlockMoveDirection): boolean {
  return moveCaretBlock?.(direction) ?? false
}

function keyboardTarget(
  units: BlockHandleUnit[],
  index: number,
  direction: -1 | 1,
): BlockHandleUnit | undefined {
  const source = units[index]
  if (!source) return undefined
  if (source.kind !== 'heading') {
    const target = units[index + direction]
    return target?.movable ? target : undefined
  }
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
    // Front matter participates in pairing, but never exposes block actions.
    if (!unit?.movable) unit = null
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
      countBlockActionDecline('no-current-unit')
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
  // Task 607 decision 1: a hover whose entry has no units (no owned exact source yet) waits for the
  // next source revision, which the index announces when its background acquire succeeds. The
  // pointer may rest on the block meanwhile, so no further mousemove would end the display gap.
  let unitlessHover: { target: EventTarget | null; root: HTMLElement } | null =
    null
  const showHover = (
    entry: SourceBlockIndex | null,
    target: EventTarget | null,
    root: HTMLElement,
  ) => {
    unitlessHover = entry && entry.units === null ? { target, root } : null
    positionHandle(
      unitForTarget(entry ? entry.units : resolveFreshUnits(), target),
    )
  }
  // Task 733 (Q-61): a hover never pays a whole-document snapshot while typing is unpublished; an
  // entry with no units waits for the model's next change (the unitless-hover retry below).
  const HOVER_READ = { deferUnconfirmed: true } as const
  const hoverUnit = (target: EventTarget | null, root: HTMLElement) => {
    const warm = index.peek()
    if (warm) {
      showHover(warm, target, root)
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
      showHover(entry, target, root)
    }, HOVER_READ)
  }
  // The same liveness checks as a deferred hover: the target is still in the active root and no
  // menu, drag or native selection took over since.
  const retryUnitlessHover = () => {
    const waiting = unitlessHover
    unitlessHover = null
    const node = waiting?.target instanceof Node ? waiting.target : null
    if (
      !waiting ||
      active ||
      dragging ||
      !menu.hidden ||
      nativeSelecting ||
      !node?.isConnected ||
      getActiveRoot() !== waiting.root ||
      !waiting.root.contains(node)
    )
      return
    hoverUnit(waiting.target, waiting.root)
  }
  const stopUnitlessHoverRetry = index.onInvalidate((reason) => {
    if (reason === 'revision') retryUnitlessHover()
  })
  const hover = (event: MouseEvent) => {
    cancelDeferredHover?.()
    unitlessHover = null
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
  // Task 700 (b): a hover deferred at a click (held by the selection bubble) or a unitless hover
  // waiting for the 607 acquire outlives the pointer and the typing, then resolves after the first
  // edit and runs whole-document Lute proofs in the first-edit window. Trusted `beforeinput` in the
  // editor root (no existing user-input hook reaches this layer) and `mouseleave` of the editor end
  // both; the handle returns on the next real mousemove.
  const endPendingHover = () => {
    cancelDeferredHover?.()
    cancelDeferredHover = null
    unitlessHover = null
  }
  const onBeforeInput = (event: InputEvent) => {
    if (!event.isTrusted) return
    const root = getActiveRoot()
    if (root && event.target instanceof Node && root.contains(event.target))
      endPendingHover()
  }
  // `mouseleave` does not bubble: capture it on the document and match the editor root itself.
  const onEditorLeave = (event: MouseEvent) => {
    if (event.target === getActiveRoot()) endPendingHover()
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
    if (!unit?.movable) return null
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
    void actions.move(source.start, boundary.unit.start, boundary.placement, {
      exact: drag.exact,
    })
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
    if (event.key !== 'Escape') return
    dragging = null
    hideIndicator()
    hideMenu()
  }
  // The caret block and its neighbour on `snapshot`'s bytes, or null (no movable block, an edge).
  const planCaretMove = (
    direction: BlockMoveDirection,
    node: Node,
    snapshot: { exact: string; rendered: string },
  ) => {
    const current = resolveFreshUnits(snapshot)
    const index =
      current?.findIndex((unit) => unit.element.contains(node)) ?? -1
    const target =
      current && keyboardTarget(current, index, direction === 'up' ? -1 : 1)
    const source = current?.[index]
    return source?.movable && target ? { source, target } : null
  }
  const moveAtCaret = (
    direction: BlockMoveDirection,
    mayAcquire = true,
  ): boolean => {
    const root = getActiveRoot()
    const node = document.getSelection()?.anchorNode
    if (!node || !root?.contains(node)) return false
    const snapshot = actions.snapshot()
    if (!snapshot && mayAcquire && actions.acquireExactAuthority) {
      // Task 607: a trusted edit left no owned exact source, so no unit can be resolved. Pull the
      // host's bytes, then plan the move once on the units of those bytes; the caret must still
      // be in the same root, or the keyboard move declines.
      void actions.acquireExactAuthority().then((pair) => {
        if (pair && getActiveRoot() === root && root.contains(node))
          moveAtCaret(direction, false)
      })
      return true
    }
    const plan = snapshot && planCaretMove(direction, node, snapshot)
    if (!plan) return false
    clearUnsafeState()
    const placement = direction === 'up' ? 'before' : 'after'
    void actions.move(plan.source.start, plan.target.start, placement, {
      exact: snapshot.exact,
      // Task 607: the host bytes pulled for this move may differ from the ones planned on (an
      // unpublished edit, a rebased pair). The caret is the identity: plan again from it on the
      // acquired bytes, or decline when it left the block layer.
      rederive: (pair) => {
        const live = document.getSelection()?.anchorNode
        if (getActiveRoot() !== root || !live || !root.contains(live))
          return null
        const again = planCaretMove(direction, live, pair)
        return again
          ? {
              kind: 'move',
              sourceStart: again.source.start,
              targetStart: again.target.start,
              placement,
            }
          : null
      },
    })
    return true
  }
  moveCaretBlock = moveAtCaret
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
          ? [
              'front-matter',
              'math',
              'html',
              'html-group',
              'table',
              'thematic',
            ].includes(active.kind)
          : active.kind === 'heading'
    }
  }
  const runMenuAction = (
    displayed: BlockHandleUnit,
    action: string,
    snapshot: { exact: string; rendered: string },
  ) => {
    const source = resolveCurrentUnit(displayed, snapshot)
    if (!source?.movable) return
    if (
      action === 'turnInto' &&
      ![
        'front-matter',
        'math',
        'html',
        'html-group',
        'table',
        'thematic',
      ].includes(source.kind)
    ) {
      clearUnsafeState()
      void actions.turnInto(source.start, source.end)
    } else if (source.kind !== 'heading' && action === 'duplicate') {
      clearUnsafeState()
      void actions.duplicate(
        source.start,
        menuBasis(displayed, action, snapshot),
      )
    } else if (source.kind !== 'heading' && action === 'delete') {
      clearUnsafeState()
      void actions.delete(source.start, menuBasis(displayed, action, snapshot))
    }
  }
  // Task 733: the host's bytes pulled for the action may differ from the ones it was planned on
  // (an unpublished edit, a rebased pair). Without `rederive` that declines silently. The
  // displayed unit is the identity: match it again on the acquired bytes, or decline.
  const menuBasis = (
    displayed: BlockHandleUnit,
    action: 'duplicate' | 'delete',
    snapshot: { exact: string },
  ): BlockActionBasis => ({
    exact: snapshot.exact,
    rederive: (pair) => {
      const again = resolveCurrentUnit(displayed, pair)
      return again?.movable && again.kind !== 'heading'
        ? { kind: action, sourceStart: again.start }
        : null
    },
  })
  const onMenuClick = (event: MouseEvent) => {
    ensureOwner()
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '[data-action]',
    )?.dataset.action
    const displayed = active
    hideMenu()
    if (!displayed || !action) return
    const snapshot = actions.snapshot()
    if (snapshot) {
      runMenuAction(displayed, action, snapshot)
      return
    }
    // Task 733: the handle can show from model units while edit-sync owns no exact source (typing
    // clears it), so hover never asks the host. Pull the host's bytes now, as the keyboard move
    // does, and run the action once on them; `runMenuAction` re-matches the displayed unit by
    // identity, and declines when the bytes no longer describe it.
    void actions.acquireExactAuthority?.().then((pair) => {
      if (pair) runMenuAction(displayed, action, pair)
      else countBlockActionDecline('no-pair')
    })
  }
  document.addEventListener('pointerdown', onNativePointerDown, true)
  document.addEventListener('pointerup', finishNativeSelection, true)
  document.addEventListener('pointercancel', finishNativeSelection, true)
  window.addEventListener('blur', finishNativeSelection)
  document.addEventListener('mousemove', hover, true)
  document.addEventListener('beforeinput', onBeforeInput, true)
  document.addEventListener('mouseleave', onEditorLeave, true)
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
    if (moveCaretBlock === moveAtCaret) moveCaretBlock = undefined
    cancelDeferredHover?.()
    stopIndexInvalidation()
    stopUnitlessHoverRetry()
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
    document.removeEventListener('beforeinput', onBeforeInput, true)
    document.removeEventListener('mouseleave', onEditorLeave, true)
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
