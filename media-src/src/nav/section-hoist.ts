import type Vditor from 'vditor'
import type { VsCodeApi } from '../../../src/shared/protocol'
import {
  blockModeElement,
  HOIST_HIDDEN_ATTR,
  HOIST_OUTLINE_HIDDEN_ATTR,
  HOIST_SCOPE_CHANGE_EVENT,
} from '../util/source-map'
export {
  HOIST_HIDDEN_ATTR,
  HOIST_OUTLINE_HIDDEN_ATTR,
  HOIST_SCOPE_CHANGE_EVENT,
} from '../util/source-map'
import {
  headingLabel,
  headingLevel,
  headingPathForIndex,
  sectionRangeForHeading,
  topLevelBlocks,
  type SectionRange,
} from './section-range'
import { guardComposition } from '../util/caret-gesture'

const STATE_KEY = 'vmdeSectionHoist'
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6'

interface StoredHoist {
  headingIndex: number
  headingId?: string
  headingText?: string
  headingLevel?: number
  scrollTop?: number
}

interface HoistState {
  [STATE_KEY]?: StoredHoist
  [key: string]: unknown
}

type StateApi = Pick<VsCodeApi, 'getState' | 'setState'>

export interface SectionHoistController {
  hoistHeading(headingIndex: number): void
  ensureHeadingVisible(headingIndex: number): void
  exit(): void
  /** Leave the view without restoring the pre-hoist scroll, so Find's own reveal wins. */
  exitForFind(): void
  isHoisted(): boolean
  dispose(): void
}

let activeController: SectionHoistController | undefined

export function ensureHoistTargetVisible(headingIndex: number): void {
  activeController?.ensureHeadingVisible(headingIndex)
}

/** Task 580 CP2-13 — every Find open (`vmde.find`, `vmde.findReplace`, a remapped key, the
 * palette) reaches the webview as `open-find-replace`. Find overlays and reveals matches in the
 * complete document, and hidden sections would leave matches without visible targets, so the
 * router exits a hoist before the widget opens. */
export function exitHoistForFind(): void {
  activeController?.exitForFind()
}

/** A source-line reveal can target any block, not just a heading. Exit a hoist only when that
 * concrete block is hidden; visible targets keep the user's current section scope intact. */
export function ensureHoistBlockVisible(block: Element): void {
  if (block.closest(`[${HOIST_HIDDEN_ATTR}]`)) activeController?.exit()
}

function editorSurfaces(vditor: Vditor): HTMLElement[] {
  const inner = (vditor as any)?.vditor
  return [inner?.ir?.element, inner?.wysiwyg?.element].filter(
    (surface): surface is HTMLElement => surface instanceof HTMLElement,
  )
}

function headingBlockIndexes(blocks: readonly HTMLElement[]): number[] {
  const indexes: number[] = []
  for (const [index, block] of blocks.entries()) {
    if (block.matches(HEADING_SELECTOR)) indexes.push(index)
  }
  return indexes
}

function hoistSurface(vditor: Vditor): HTMLElement | null {
  const inner = (vditor as any)?.vditor
  if (inner?.preview?.element?.style.display === 'block') return null
  return blockModeElement(vditor)
}

function stableHeadingId(id: string): string {
  return id.replace(/^(?:ir|wysiwyg)-/, '')
}

function storedHeadingOrdinal(
  blocks: readonly HTMLElement[],
  headingIndexes: readonly number[],
  stored: StoredHoist,
): number | undefined {
  if (stored.headingId) {
    const byId = headingIndexes.findIndex(
      (blockIndex) =>
        stableHeadingId(blocks[blockIndex].id) === stored.headingId,
    )
    if (byId >= 0) return byId
  }
  if (stored.headingText) {
    const matches = headingIndexes
      .map((blockIndex, headingIndex) => ({ blockIndex, headingIndex }))
      .filter(
        ({ blockIndex }) =>
          headingLabel(blocks[blockIndex]) === stored.headingText &&
          (stored.headingLevel === undefined ||
            headingLevel(blocks[blockIndex]) === stored.headingLevel),
      )
    if (matches.length === 1) return matches[0].headingIndex
  }
  return stored.headingId || stored.headingText
    ? undefined
    : stored.headingIndex
}

interface ActiveScope {
  kind: 'active'
  surface: HTMLElement
  blocks: HTMLElement[]
  headingIndexes: number[]
  headingIndex: number
  blockIndex: number
  range: SectionRange
}

type ScopeResolution = ActiveScope | { kind: 'inactive' } | { kind: 'invalid' }

function resolveScope(vditor: Vditor, stored: StoredHoist): ScopeResolution {
  const surface = hoistSurface(vditor)
  if (!surface) return { kind: 'inactive' }
  const blocks = topLevelBlocks(surface)
  const headingIndexes = headingBlockIndexes(blocks)
  const headingIndex = storedHeadingOrdinal(blocks, headingIndexes, stored)
  if (headingIndex === undefined) return { kind: 'invalid' }
  const blockIndex = headingIndexes[headingIndex]
  if (blockIndex === undefined) return { kind: 'invalid' }
  const range = sectionRangeForHeading(blocks, blockIndex)
  return range
    ? {
        kind: 'active',
        surface,
        blocks,
        headingIndexes,
        headingIndex,
        blockIndex,
        range,
      }
    : { kind: 'invalid' }
}

function applyBlockScope(scope: ActiveScope): void {
  const { surface, blocks, range } = scope
  for (const child of Array.from(surface.children)) {
    if (!(child instanceof HTMLElement)) continue
    const index = blocks.indexOf(child)
    child.toggleAttribute(
      HOIST_HIDDEN_ATTR,
      index < 0 || index < range.start || index >= range.end,
    )
  }
}

function applyOutlineScope(
  outline: HTMLElement | null,
  scope: ActiveScope,
): void {
  const items = Array.from(
    outline?.querySelectorAll<HTMLElement>('[data-target-id]') ?? [],
  )
  const visible: HTMLElement[] = []
  for (const [headingIndex, item] of items.entries()) {
    const blockIndex = scope.headingIndexes[headingIndex]
    const hidden =
      blockIndex === undefined ||
      blockIndex < scope.range.start ||
      blockIndex >= scope.range.end
    item.toggleAttribute(HOIST_OUTLINE_HIDDEN_ATTR, hidden)
    if (hidden) {
      item.setAttribute('aria-hidden', 'true')
      item.tabIndex = -1
    } else {
      item.removeAttribute('aria-hidden')
      visible.push(item)
    }
  }
  if (visible.length > 0 && !visible.some((item) => item.tabIndex === 0)) {
    visible[0].tabIndex = 0
  }
}

function clearScope(vditor: Vditor, outline: HTMLElement | null): void {
  for (const surface of editorSurfaces(vditor)) {
    for (const block of surface.querySelectorAll(`[${HOIST_HIDDEN_ATTR}]`)) {
      block.removeAttribute(HOIST_HIDDEN_ATTR)
    }
  }
  for (const item of outline?.querySelectorAll(
    `[${HOIST_OUTLINE_HIDDEN_ATTR}]`,
  ) ?? []) {
    item.removeAttribute(HOIST_OUTLINE_HIDDEN_ATTR)
    item.removeAttribute('aria-hidden')
  }
}

function savedState(api: StateApi): HoistState {
  const value = api.getState<HoistState>()
  return value && typeof value === 'object' ? value : {}
}

export function installSectionHoist(
  vditor: Vditor,
  stateApi: StateApi = vscode,
): SectionHoistController {
  activeController?.dispose()
  const inner = (vditor as any)?.vditor
  const outline = inner?.outline?.element as HTMLElement | null
  const editorRoot =
    blockModeElement(vditor)?.closest<HTMLElement>('.vditor') ??
    document.querySelector<HTMLElement>('.vditor')
  const content = editorRoot?.querySelector<HTMLElement>('.vditor-content')
  const outlineContent = outline?.querySelector<HTMLElement>(
    '.vditor-outline__content',
  )
  let stored = savedState(stateApi)[STATE_KEY]
  let breadcrumb: HTMLElement | null = null
  let contextMenu: HTMLElement | null = null
  let frame = 0
  let disposed = false
  let contextTrigger: HTMLElement | null = null
  let scopedSurface: HTMLElement | null = null

  const notifyScopeChange = (active: boolean): void => {
    document.dispatchEvent(
      new CustomEvent(HOIST_SCOPE_CHANGE_EVENT, { detail: { active } }),
    )
  }

  const seedUndoBaseline = (): void => {
    // Vditor debounces its initial undo snapshot. A fast hoist followed by typing can cancel that
    // timer, leaving the first edited state as stack entry #1 and therefore nothing to undo to.
    // Snapshot the untouched full DOM before view attributes land; addToUndoStack is idempotent
    // when Vditor already recorded the same state.
    inner?.undo?.addToUndoStack?.(inner)
  }

  const persist = (value?: StoredHoist): void => {
    const next = { ...savedState(stateApi) }
    if (value) next[STATE_KEY] = value
    else delete next[STATE_KEY]
    stateApi.setState(next)
  }

  const removeBreadcrumb = (): void => {
    breadcrumb?.remove()
    breadcrumb = null
  }

  const removeContextMenu = (focusTarget?: HTMLElement | null): void => {
    contextMenu?.remove()
    contextMenu = null
    contextTrigger = null
    focusTarget?.focus({ preventScroll: true })
  }

  const renderBreadcrumb = (
    blocks: readonly HTMLElement[],
    blockIndex: number,
  ): void => {
    const labels = headingPathForIndex(blocks, blockIndex).map(
      (entry) => entry.text,
    )
    removeBreadcrumb()
    if (!editorRoot || labels.length === 0) return
    const bar = document.createElement('nav')
    bar.className = 'vmde-section-breadcrumb'
    bar.setAttribute('aria-label', 'Hoisted section')
    const exitButton = document.createElement('button')
    exitButton.type = 'button'
    exitButton.className = 'vmde-section-breadcrumb__exit'
    exitButton.title = 'Exit section view'
    exitButton.textContent = ['Doc', ...labels].join(' › ')
    exitButton.addEventListener('click', () => controller.exit())
    bar.append(exitButton)
    const toolbar = editorRoot.querySelector('.vditor-toolbar')
    toolbar?.after(bar)
    if (!toolbar) editorRoot.prepend(bar)
    breadcrumb = bar
  }

  const apply = (): void => {
    if (disposed) return
    clearScope(vditor, outline)
    if (!stored) {
      removeBreadcrumb()
      return
    }
    const scope = resolveScope(vditor, stored)
    if (scope.kind === 'inactive') {
      scopedSurface = null
      removeBreadcrumb()
      notifyScopeChange(false)
      return
    }
    if (scope.kind === 'invalid') {
      scopedSurface = null
      stored = undefined
      persist()
      removeBreadcrumb()
      notifyScopeChange(false)
      return
    }
    applyBlockScope(scope)
    applyOutlineScope(outline, scope)
    scopedSurface = scope.surface
    if (stored.headingIndex !== scope.headingIndex) {
      stored.headingIndex = scope.headingIndex
      persist(stored)
    }
    renderBreadcrumb(scope.blocks, scope.blockIndex)
    notifyScopeChange(true)
  }

  const scheduleApply = (): void => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      apply()
    })
  }

  const headingIndexAtTarget = (target: EventTarget | null): number => {
    if (!(target instanceof Element)) return -1
    const outlineItem = target.closest<HTMLElement>('[data-target-id]')
    if (outlineItem && outline?.contains(outlineItem)) {
      return Array.from(
        outline.querySelectorAll<HTMLElement>('[data-target-id]'),
      ).indexOf(outlineItem)
    }
    const surface = blockModeElement(vditor)
    const heading = target.closest<HTMLElement>(HEADING_SELECTOR)
    if (!surface || !heading || !surface.contains(heading)) return -1
    return Array.from(
      surface.querySelectorAll<HTMLElement>(HEADING_SELECTOR),
    ).indexOf(heading)
  }

  const onContextMenu = (event: MouseEvent): void => {
    const headingIndex = headingIndexAtTarget(event.target)
    if (headingIndex < 0 || !editorRoot) return
    event.preventDefault()
    removeContextMenu()
    contextTrigger =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>(
            '[data-target-id], h1, h2, h3, h4, h5, h6',
          )
        : null
    const menu = document.createElement('div')
    menu.className = 'vmde-section-hoist-menu'
    menu.setAttribute('role', 'menu')
    menu.style.left = `${event.clientX}px`
    menu.style.top = `${event.clientY}px`
    const item = document.createElement('button')
    item.type = 'button'
    item.setAttribute('role', 'menuitem')
    item.textContent = 'Hoist section'
    item.addEventListener('click', () => {
      controller.hoistHeading(headingIndex)
      removeContextMenu()
      breadcrumb
        ?.querySelector<HTMLElement>('.vmde-section-breadcrumb__exit')
        ?.focus({ preventScroll: true })
    })
    menu.append(item)
    editorRoot.append(menu)
    contextMenu = menu
    item.focus()
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (contextMenu && !contextMenu.contains(event.target as Node)) {
      removeContextMenu()
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (guardComposition(event)) return
    if (event.key === 'Escape' && contextMenu) {
      removeContextMenu(contextTrigger)
      return
    }
  }

  const mutationObserver = new MutationObserver(() => {
    const surface = stored ? hoistSurface(vditor) : null
    // A mode switch builds a fresh IR/WYS surface. Reapply in this earlier-registered mutation
    // callback so render-cache's synchronous local paint and Vditor's deferred native pass see the
    // hidden attributes before doing work. Ordinary edits stay frame-coalesced on the same root.
    if (
      surface &&
      surface !== scopedSurface &&
      surface.querySelector(HEADING_SELECTOR)
    ) {
      apply()
      return
    }
    scheduleApply()
  })
  if (content)
    mutationObserver.observe(content, { childList: true, subtree: true })
  if (outlineContent) {
    mutationObserver.observe(outlineContent, { childList: true, subtree: true })
  }
  outline?.addEventListener('contextmenu', onContextMenu)
  content?.addEventListener('contextmenu', onContextMenu)
  editorRoot?.addEventListener('click', scheduleApply, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeyDown, true)

  const exitView = (restoreScroll: boolean): void => {
    const restore = stored
    stored = undefined
    scopedSurface = null
    clearScope(vditor, outline)
    removeBreadcrumb()
    removeContextMenu()
    persist()
    notifyScopeChange(false)
    const surface = hoistSurface(vditor)
    if (restoreScroll && surface && restore?.scrollTop !== undefined) {
      requestAnimationFrame(() => {
        surface.scrollTop = restore.scrollTop!
      })
    }
  }

  const controller: SectionHoistController = {
    hoistHeading(headingIndex) {
      const surface = hoistSurface(vditor)
      if (!surface || headingIndex < 0) return
      const headings = surface.querySelectorAll(HEADING_SELECTOR)
      if (!headings[headingIndex]) return
      seedUndoBaseline()
      const blocks = topLevelBlocks(surface)
      const blockIndex = headingBlockIndexes(blocks)[headingIndex]
      const heading = blockIndex === undefined ? undefined : blocks[blockIndex]
      if (!heading) return
      stored = {
        headingIndex,
        headingId: heading.id ? stableHeadingId(heading.id) : undefined,
        headingText: headingLabel(heading),
        headingLevel: headingLevel(heading) ?? undefined,
        scrollTop: surface.scrollTop,
      }
      persist(stored)
      apply()
      if (blockIndex !== undefined)
        surface.scrollTop = blocks[blockIndex].offsetTop
    },
    ensureHeadingVisible(headingIndex) {
      if (!stored || headingIndex < 0) return
      const scope = resolveScope(vditor, stored)
      if (scope.kind !== 'active') {
        exitView(false)
        return
      }
      const targetBlockIndex = scope.headingIndexes[headingIndex]
      if (
        targetBlockIndex === undefined ||
        targetBlockIndex < scope.range.start ||
        targetBlockIndex >= scope.range.end
      ) {
        exitView(false)
      }
    },
    exit: () => exitView(true),
    exitForFind() {
      if (stored) exitView(false)
    },
    isHoisted: () => stored !== undefined,
    dispose() {
      if (disposed) return
      disposed = true
      mutationObserver.disconnect()
      if (frame) cancelAnimationFrame(frame)
      outline?.removeEventListener('contextmenu', onContextMenu)
      content?.removeEventListener('contextmenu', onContextMenu)
      editorRoot?.removeEventListener('click', scheduleApply, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      clearScope(vditor, outline)
      removeBreadcrumb()
      removeContextMenu()
      if (activeController === controller) activeController = undefined
    },
  }

  activeController = controller
  if (stored) seedUndoBaseline()
  apply()
  return controller
}
