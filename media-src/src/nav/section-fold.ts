import type Vditor from 'vditor'
import { blockModeElement } from '../util/source-map'
import {
  headingLabel,
  headingLevel,
  sectionRangeForHeading,
  topLevelBlocks,
} from './section-range'
import { guardComposition } from '../util/caret-gesture'
import type { SectionFoldState } from '../../../src/shared/protocol'
import {
  classifyEditorMutations,
  type EditorMutationImpact,
  type HelperMutationPass,
  recordHelperMutationPass,
} from '../util/mutation-impact'
export type { SectionFoldState } from '../../../src/shared/protocol'

const FOLD_HIDDEN_ATTR = 'data-vmde-fold-hidden'
const FOLDED_ATTR = 'data-vmde-folded'
const FOLDABLE_ATTR = 'data-vmde-foldable'
const LIST_FOLDED_ATTR = 'data-vmde-list-folded'
const LIST_FOLDABLE_ATTR = 'data-vmde-list-foldable'
const STATE_KEY = 'vmdeSectionFolds'

interface HeadingFoldIdentity {
  id?: string
  text: string
  level: number
}

interface ListFoldIdentity {
  path: number[]
  text: string
}

export interface SectionFoldController {
  toggleHeading(headingIndex: number): boolean
  toggleListItem(item: HTMLElement): boolean
  toggleAt(node: Node): boolean
  ensureBlockVisible(block: Element): boolean
  state(): SectionFoldState
  apply(): void
  dispose(): void
}

interface ControllerOptions {
  initialState?: SectionFoldState
  persist?: (state: SectionFoldState) => void
}

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6'
const LIST_SELECTOR = 'ul, ol'

export interface HeadingFoldGutterRect {
  left: number
  top: number
  right: number
  bottom: number
}

const PSEUDO_BOX_PROPERTIES = [
  'width',
  'height',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
  'borderLeftWidth',
  'borderRightWidth',
  'borderTopWidth',
  'borderBottomWidth',
]

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one reader keeps marker and arrow validation identical.
function renderedHeadingPseudoBox(
  heading: HTMLElement,
  headingRect: DOMRect,
  pseudo: '::before' | '::after',
): HeadingFoldGutterRect | null | false {
  const style = getComputedStyle(heading, pseudo)
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.content === 'none' ||
    style.content === 'normal'
  )
    return null
  const read = (
    source: CSSStyleDeclaration,
    properties: string[],
    nonnegative = true,
  ) => {
    const values = properties.map((property) =>
      Number.parseFloat(
        (source as unknown as Record<string, string>)[property],
      ),
    )
    return values.every(
      (value) => Number.isFinite(value) && (!nonnegative || value >= 0),
    )
      ? values
      : null
  }
  const values = read(style, PSEUDO_BOX_PROPERTIES)
  if (!values) return false
  const [
    width,
    height,
    paddingLeft,
    paddingRight,
    paddingTop,
    paddingBottom,
    borderLeft,
    borderRight,
    borderTop,
    borderBottom,
  ] = values
  const outerWidth =
    style.boxSizing === 'border-box'
      ? width
      : width + paddingLeft + paddingRight + borderLeft + borderRight
  const outerHeight =
    style.boxSizing === 'border-box'
      ? height
      : height + paddingTop + paddingBottom + borderTop + borderBottom
  let left: number
  let top: number
  if (pseudo === '::after') {
    const origin = read(style, ['left', 'top'], false)
    if (!origin) return false
    left = headingRect.left + origin[0]
    top = headingRect.top + origin[1]
  } else {
    const insets = read(getComputedStyle(heading), PSEUDO_BOX_PROPERTIES)
    const margins = read(style, ['marginLeft', 'marginTop'], false)
    const offset =
      style.position === 'static'
        ? 0
        : style.position === 'relative' && style.top === 'auto'
          ? 0
          : style.position === 'relative'
            ? Number.parseFloat(style.top)
            : Number.NaN
    if (
      style.float !== 'left' ||
      !insets ||
      !margins ||
      !Number.isFinite(offset)
    )
      return false
    left = headingRect.left + insets[6] + insets[2] + margins[0]
    top = headingRect.top + insets[8] + insets[4] + margins[1] + offset
  }
  const box = { left, top, right: left + outerWidth, bottom: top + outerHeight }
  return Number.isFinite(box.left + box.top + box.right + box.bottom) &&
    box.right > box.left &&
    box.bottom > box.top
    ? box
    : false
}

function renderedHeadingFoldGutterRect(
  heading: HTMLElement,
): HeadingFoldGutterRect | null {
  const headingRect = heading.getBoundingClientRect()
  if (!Number.isFinite(headingRect.left + headingRect.top)) return null
  const arrow = renderedHeadingPseudoBox(heading, headingRect, '::after')
  if (!arrow) return null
  const marker = renderedHeadingPseudoBox(heading, headingRect, '::before')
  if (marker === false) return null
  if (!marker) return arrow
  return {
    left: Math.min(marker.left, arrow.left),
    top: Math.min(marker.top, arrow.top),
    right: Math.max(marker.right, arrow.right),
    bottom: Math.max(marker.bottom, arrow.bottom),
  }
}

export function headingFoldGutterHitTest(
  heading: HTMLElement,
  point: Pick<MouseEvent, 'clientX' | 'clientY'>,
  gutter = renderedHeadingFoldGutterRect(heading),
): boolean {
  if (
    !gutter ||
    !heading.matches(HEADING_SELECTOR) ||
    !heading.hasAttribute(FOLDABLE_ATTR) ||
    ![point.clientX, point.clientY].every(Number.isFinite)
  )
    return false
  return (
    point.clientX >= gutter.left &&
    point.clientX <= gutter.right &&
    point.clientY >= gutter.top &&
    point.clientY <= gutter.bottom
  )
}

export interface ListFoldGutterRect {
  left: number
  top: number
  right: number
  bottom: number
}

function renderedListFoldArrowRect(
  item: HTMLElement,
  itemRect: DOMRect,
): ListFoldGutterRect | null | false {
  const style = getComputedStyle(item, '::after')
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.content === 'none' ||
    style.content === 'normal' ||
    style.opacity === '0' ||
    style.pointerEvents === 'none'
  )
    return null
  const values = PSEUDO_BOX_PROPERTIES.map((property) =>
    Number.parseFloat((style as unknown as Record<string, string>)[property]),
  )
  if (!values.every((value) => Number.isFinite(value) && value >= 0))
    return false
  const [
    width,
    height,
    paddingLeft,
    paddingRight,
    paddingTop,
    paddingBottom,
    borderLeft,
    borderRight,
    borderTop,
    borderBottom,
  ] = values
  const origin = [style.left, style.top].map((value) =>
    Number.parseFloat(value),
  )
  if (
    style.position !== 'absolute' ||
    origin.some((value) => !Number.isFinite(value))
  )
    return false
  const outerWidth =
    style.boxSizing === 'border-box'
      ? width
      : width + paddingLeft + paddingRight + borderLeft + borderRight
  const outerHeight =
    style.boxSizing === 'border-box'
      ? height
      : height + paddingTop + paddingBottom + borderTop + borderBottom
  const [left, top] = origin
  const box = {
    left: itemRect.left + left,
    top: itemRect.top + top,
    right: itemRect.left + left + outerWidth,
    bottom: itemRect.top + top + outerHeight,
  }
  return Number.isFinite(box.left + box.top + box.right + box.bottom) &&
    box.right > box.left &&
    box.bottom > box.top &&
    box.right < itemRect.left
    ? box
    : false
}

function renderedListFoldMarkerRect(
  item: HTMLElement,
  itemRect: DOMRect,
  arrow: ListFoldGutterRect,
): ListFoldGutterRect | null | false {
  const markerStyle = getComputedStyle(item, '::marker')
  if (markerStyle.listStyleType === 'none') return null
  const markerWidth = Number.parseFloat(markerStyle.width)
  const markerLineHeight = Number.parseFloat(markerStyle.lineHeight)
  if (
    !Number.isFinite(markerWidth) ||
    markerWidth <= 0 ||
    !Number.isFinite(markerLineHeight) ||
    markerLineHeight <= 0
  )
    return false
  const right = Math.min(itemRect.left - 2, arrow.right)
  const marker = {
    left: right - markerWidth,
    top: itemRect.top,
    right,
    bottom: itemRect.top + markerLineHeight,
  }
  return [marker.left, marker.top, marker.right, marker.bottom].every(
    Number.isFinite,
  ) &&
    marker.right > marker.left &&
    marker.bottom > marker.top
    ? marker
    : false
}

const LIST_GLYPH_CENTER_VAR = '--vmde-list-fold-glyph-center-x'
const LIST_ARROW_TOP_VAR = '--vmde-list-fold-arrow-top'
let markerMeasureContext: CanvasRenderingContext2D | null | undefined

function listMarkerAdvance(
  item: HTMLElement,
  style: CSSStyleDeclaration,
): number | null {
  const label = item.getAttribute('data-marker')?.trim()
  if (!label) return null
  if (markerMeasureContext === undefined) {
    try {
      markerMeasureContext = document.createElement('canvas').getContext('2d')
    } catch {
      markerMeasureContext = null
    }
  }
  if (!markerMeasureContext) return null
  const base = getComputedStyle(item)
  markerMeasureContext.font = `${style.fontStyle || base.fontStyle} ${style.fontWeight || base.fontWeight} ${style.fontSize || base.fontSize} ${style.fontFamily || base.fontFamily}`
  const advance = markerMeasureContext.measureText(label).width
  return Number.isFinite(advance) && advance > 0 ? advance : null
}

function listSymbolMetrics(
  item: HTMLElement,
  itemRect: DOMRect,
): { centerX: number; bottom: number } | null {
  const checkbox = Array.from(
    item.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ).find((input) => input.closest('li') === item)
  if (checkbox) {
    const rect = checkbox.getBoundingClientRect()
    return [rect.left, rect.right, rect.bottom].every(Number.isFinite) &&
      rect.right > rect.left &&
      rect.bottom > itemRect.top
      ? { centerX: (rect.left + rect.right) / 2, bottom: rect.bottom }
      : null
  }
  const marker = getComputedStyle(item, '::marker')
  const width = Number.parseFloat(marker.width)
  const lineHeight = Number.parseFloat(marker.lineHeight)
  if (
    marker.listStyleType === 'none' ||
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(lineHeight) ||
    lineHeight <= 0
  )
    return null
  const ordered = item.parentElement?.tagName === 'OL'
  const visibleWidth = ordered
    ? Math.min(width, listMarkerAdvance(item, marker) ?? width)
    : width
  // Chromium's outside bullets center a glyph one half line box before text;
  // ordered markers occupy their computed width and paint their numeral at its start.
  return {
    centerX: ordered
      ? itemRect.left - width + visibleWidth / 2
      : itemRect.left - (lineHeight + width) / 2,
    bottom: itemRect.top + lineHeight,
  }
}

function alignListFoldGlyph(item: HTMLElement): void {
  const rect = item.getBoundingClientRect()
  const arrow = renderedListFoldArrowRect(item, rect)
  const symbol = arrow && listSymbolMetrics(item, rect)
  if (!symbol || !Number.isFinite(symbol.centerX + symbol.bottom)) {
    item.style.removeProperty(LIST_GLYPH_CENTER_VAR)
    item.style.removeProperty(LIST_ARROW_TOP_VAR)
    return
  }
  const center = `${symbol.centerX - rect.left}px`
  const top = `${symbol.bottom - rect.top}px`
  if (item.style.getPropertyValue(LIST_GLYPH_CENTER_VAR) !== center)
    item.style.setProperty(LIST_GLYPH_CENTER_VAR, center)
  if (item.style.getPropertyValue(LIST_ARROW_TOP_VAR) !== top)
    item.style.setProperty(LIST_ARROW_TOP_VAR, top)
}

function renderedListFoldGutterRect(
  item: HTMLElement,
): ListFoldGutterRect | null {
  if (
    item.tagName !== 'LI' ||
    !item.hasAttribute(LIST_FOLDABLE_ATTR) ||
    directLists(item).length === 0
  )
    return null
  const list = item.parentElement
  if (
    !list ||
    (list.tagName !== 'UL' && list.tagName !== 'OL') ||
    getComputedStyle(list).listStylePosition !== 'outside'
  )
    return null
  const itemRect = item.getBoundingClientRect()
  if (
    ![itemRect.left, itemRect.top, itemRect.right, itemRect.bottom].every(
      Number.isFinite,
    ) ||
    itemRect.right <= itemRect.left ||
    itemRect.bottom <= itemRect.top ||
    getComputedStyle(item).position !== 'relative'
  )
    return null
  const arrow = renderedListFoldArrowRect(item, itemRect)
  if (!arrow) return null
  const marker = renderedListFoldMarkerRect(item, itemRect, arrow)
  if (marker === false) return null

  // Native ::marker has no DOM rectangle. Its computed width and line-height place
  // the marker beside the LI content edge; unite that line with the CSS arrow box.
  return marker
    ? {
        left: Math.min(marker.left, arrow.left),
        top: Math.min(marker.top, arrow.top),
        right: Math.max(marker.right, arrow.right),
        bottom: Math.max(marker.bottom, arrow.bottom),
      }
    : arrow
}

export function listFoldGutterHitTest(
  item: HTMLElement,
  point: Pick<MouseEvent, 'clientX' | 'clientY'>,
  gutter = renderedListFoldGutterRect(item),
): boolean {
  if (
    !gutter ||
    item.tagName !== 'LI' ||
    !item.hasAttribute(LIST_FOLDABLE_ATTR) ||
    directLists(item).length === 0 ||
    ![point.clientX, point.clientY].every(Number.isFinite)
  )
    return false
  for (const checkbox of item.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  )) {
    if (checkbox.closest('li') !== item) continue
    const rect = checkbox.getBoundingClientRect()
    if (![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite))
      return false
    if (
      rect.right > rect.left &&
      rect.bottom > rect.top &&
      point.clientX >= rect.left &&
      point.clientX <= rect.right &&
      point.clientY >= rect.top &&
      point.clientY <= rect.bottom
    )
      return false
  }
  return (
    point.clientX >= gutter.left &&
    point.clientX <= gutter.right &&
    point.clientY >= gutter.top &&
    point.clientY <= gutter.bottom
  )
}

function foldMutationDecision(impact: EditorMutationImpact): {
  full: boolean
  listBlocks: HTMLElement[]
  pass: HelperMutationPass
} {
  const blocks = [...impact.blocks]
  const headingChanged = blocks.some(
    (block) =>
      block.matches(HEADING_SELECTOR) ||
      block.querySelector(HEADING_SELECTOR) !== null,
  )
  const listBlocks = blocks.filter(
    (block) =>
      block.matches(LIST_SELECTOR) || block.querySelector(LIST_SELECTOR),
  )
  const full =
    impact.full ||
    impact.modeRebuild ||
    impact.topLevelChanged ||
    headingChanged
  return {
    full,
    listBlocks,
    pass: full ? 'full' : listBlocks.length ? 'local' : 'skipped',
  }
}

const stableHeadingId = (id: string): string =>
  id.replace(/^(?:ir|wysiwyg)-/, '')

function headingIdentity(heading: HTMLElement): HeadingFoldIdentity {
  return {
    id: heading.id ? stableHeadingId(heading.id) : undefined,
    text: headingLabel(heading),
    level: headingLevel(heading) ?? 0,
  }
}

function sameHeading(a: HeadingFoldIdentity, b: HeadingFoldIdentity): boolean {
  return Boolean(
    (a.id && b.id && a.id === b.id) ||
      (a.text === b.text && a.level === b.level),
  )
}

function directLists(parent: Element): HTMLElement[] {
  return Array.from(parent.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      (child.tagName === 'UL' || child.tagName === 'OL'),
  )
}

function directItems(list: Element): HTMLElement[] {
  return Array.from(list.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.tagName === 'LI',
  )
}

function listItemText(item: HTMLElement): string {
  const clone = item.cloneNode(true) as HTMLElement
  for (const nested of clone.querySelectorAll(':scope > ul, :scope > ol'))
    nested.remove()
  return clone.textContent?.trim() ?? ''
}

function listItemPath(
  surface: HTMLElement,
  item: HTMLElement,
): number[] | null {
  const lineage: HTMLElement[] = []
  let walk: HTMLElement | null = item
  while (walk?.tagName === 'LI') {
    lineage.unshift(walk)
    walk = walk.parentElement?.closest('li') ?? null
  }
  const rootList = lineage[0]?.parentElement
  if (!rootList || rootList.parentElement !== surface) return null
  const rootIndex = directLists(surface).indexOf(rootList)
  if (rootIndex < 0) return null
  const path = [rootIndex]
  for (const entry of lineage) {
    const parentList = entry.parentElement
    if (!parentList) return null
    const index = directItems(parentList).indexOf(entry)
    if (index < 0) return null
    path.push(index)
  }
  return path
}

function resolveListPath(
  surface: HTMLElement,
  path: readonly number[],
): HTMLElement | null {
  const root = directLists(surface)[path[0] ?? -1]
  if (!root) return null
  let list: HTMLElement = root
  let item: HTMLElement | undefined
  for (let index = 1; index < path.length; index++) {
    item = directItems(list)[path[index]]
    if (!item) return null
    if (index < path.length - 1) {
      list = directLists(item)[0]
      if (!list) return null
    }
  }
  return item ?? null
}

function clearFoldAttributes(surface: HTMLElement): void {
  const selector = `[${FOLD_HIDDEN_ATTR}], [${FOLDED_ATTR}], [${FOLDABLE_ATTR}], [${LIST_FOLDED_ATTR}], [${LIST_FOLDABLE_ATTR}]`
  const elements = [
    ...(surface.matches(selector) ? [surface] : []),
    ...Array.from(surface.querySelectorAll<HTMLElement>(selector)),
  ]
  for (const element of elements) {
    element.removeAttribute(FOLD_HIDDEN_ATTR)
    element.removeAttribute(FOLDED_ATTR)
    element.removeAttribute(FOLDABLE_ATTR)
    element.removeAttribute(LIST_FOLDED_ATTR)
    element.removeAttribute(LIST_FOLDABLE_ATTR)
    delete element.dataset.vmdeFoldCount
  }
}

function clearListFoldAttributes(scope: HTMLElement): void {
  for (const element of scope.querySelectorAll<HTMLElement>(
    `[${LIST_FOLDED_ATTR}], [${LIST_FOLDABLE_ATTR}], [${FOLD_HIDDEN_ATTR}]`,
  )) {
    element.removeAttribute(LIST_FOLDED_ATTR)
    element.removeAttribute(LIST_FOLDABLE_ATTR)
    element.removeAttribute(FOLD_HIDDEN_ATTR)
    delete element.dataset.vmdeFoldCount
  }
}

function cloneState(state: SectionFoldState): SectionFoldState {
  return {
    headings: state.headings.map((heading) => ({ ...heading })),
    lists: state.lists.map((list) => ({ ...list, path: [...list.path] })),
  }
}

function applyHeadingFolds(
  editor: HTMLElement,
  foldedHeadings: readonly HeadingFoldIdentity[],
): void {
  const blocks = topLevelBlocks(editor)
  for (const heading of blocks.filter(
    (block) => headingLevel(block) !== null,
  )) {
    const blockIndex = blocks.indexOf(heading)
    const range = sectionRangeForHeading(blocks, blockIndex)
    if (!range || range.end <= range.start + 1) continue
    heading.setAttribute(FOLDABLE_ATTR, '1')
    const identity = headingIdentity(heading)
    if (!foldedHeadings.some((folded) => sameHeading(folded, identity)))
      continue
    heading.setAttribute(FOLDED_ATTR, '1')
    heading.dataset.vmdeFoldCount = String(range.end - range.start - 1)
    for (let index = range.start + 1; index < range.end; index++)
      blocks[index]?.setAttribute(FOLD_HIDDEN_ATTR, '1')
  }
}

function applyListFoldsWithin(
  editor: HTMLElement,
  scope: HTMLElement,
  foldedLists: readonly ListFoldIdentity[],
): void {
  for (const item of scope.querySelectorAll<HTMLElement>('li')) {
    if (directLists(item)[0]) {
      item.setAttribute(LIST_FOLDABLE_ATTR, '1')
      alignListFoldGlyph(item)
    }
  }
  for (const folded of foldedLists) {
    const item = resolveListPath(editor, folded.path)
    const nested = item ? directLists(item)[0] : undefined
    if (
      !item ||
      !scope.contains(item) ||
      !nested ||
      listItemText(item) !== folded.text
    )
      continue
    item.setAttribute(LIST_FOLDED_ATTR, '1')
    item.dataset.vmdeFoldCount = String(item.querySelectorAll('li').length)
    nested.setAttribute(FOLD_HIDDEN_ATTR, '1')
  }
}

function applyListFolds(
  editor: HTMLElement,
  foldedLists: readonly ListFoldIdentity[],
): void {
  applyListFoldsWithin(editor, editor, foldedLists)
}

function headingOwnerForHidden(
  editor: HTMLElement,
  hidden: HTMLElement,
): HTMLElement | undefined {
  const previous = hidden.previousElementSibling
  if (previous?.matches(`[${FOLDED_ATTR}]`)) return previous as HTMLElement
  const blocks = topLevelBlocks(editor)
  const targetIndex = blocks.indexOf(hidden)
  return Array.from(
    editor.querySelectorAll<HTMLElement>(`[${FOLDED_ATTR}]`),
  ).find((heading) => {
    const range = sectionRangeForHeading(blocks, blocks.indexOf(heading))
    return !!range && targetIndex > range.start && targetIndex < range.end
  })
}

export function createSectionFoldController(
  vditor: Vditor,
  options: ControllerOptions = {},
): SectionFoldController {
  const stored = cloneState(options.initialState ?? { headings: [], lists: [] })
  let disposed = false
  let applying = false
  let frame = 0
  let pendingFull = false
  const pendingListBlocks = new Set<HTMLElement>()
  const surface = () => blockModeElement(vditor)
  let glyphFrame = 0
  let observedSurface: HTMLElement | null = null
  const observedItems = new Set<HTMLElement>()
  const refreshGlyphs = () => {
    if (disposed) return
    const editor = surface()
    if (!editor) return
    for (const item of editor.querySelectorAll<HTMLElement>(
      `li[${LIST_FOLDABLE_ATTR}]`,
    ))
      alignListFoldGlyph(item)
  }
  const scheduleGlyphRefresh = () => {
    if (disposed || glyphFrame) return
    glyphFrame = requestAnimationFrame(() => {
      glyphFrame = 0
      refreshGlyphs()
    })
  }
  // Marker width can change after font loading, zoom or a split-pane resize even
  // when Vditor has not replaced a node. Observe each foldable LI as well as the surface.
  const glyphObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(scheduleGlyphRefresh)
      : null
  const observeGlyphs = (editor: HTMLElement) => {
    if (!glyphObserver) return
    if (observedSurface !== editor) {
      glyphObserver.disconnect()
      observedItems.clear()
      glyphObserver.observe(editor)
      observedSurface = editor
    }
    for (const item of observedItems) {
      if (
        item.isConnected &&
        editor.contains(item) &&
        item.hasAttribute(LIST_FOLDABLE_ATTR)
      )
        continue
      glyphObserver.unobserve(item)
      observedItems.delete(item)
    }
    for (const item of editor.querySelectorAll<HTMLElement>(
      `li[${LIST_FOLDABLE_ATTR}]`,
    )) {
      if (observedItems.has(item)) continue
      glyphObserver.observe(item)
      observedItems.add(item)
    }
  }
  window.addEventListener('resize', scheduleGlyphRefresh)
  document.fonts?.addEventListener?.('loadingdone', scheduleGlyphRefresh)

  const persist = () => options.persist?.(cloneState(stored))

  const apply = () => {
    if (disposed || applying) return
    const editor = surface()
    if (!editor) return
    applying = true
    try {
      clearFoldAttributes(editor)
      applyHeadingFolds(editor, stored.headings)
      applyListFolds(editor, stored.lists)
      observeGlyphs(editor)
    } finally {
      applying = false
    }
  }

  const scheduleApply = (records: MutationRecord[]) => {
    const impact = classifyEditorMutations(records)
    const decision = foldMutationDecision(impact)
    recordHelperMutationPass(
      'section-fold-surface',
      records,
      decision.pass,
      impact.blocks.size,
    )
    if (decision.pass === 'skipped') return
    if (decision.full) {
      pendingFull = true
      pendingListBlocks.clear()
    } else if (!pendingFull) {
      for (const block of decision.listBlocks) pendingListBlocks.add(block)
    }
    if (frame || disposed) return
    frame = requestAnimationFrame(() => {
      frame = 0
      const editor = surface()
      if (
        pendingFull ||
        !editor ||
        [...pendingListBlocks].some(
          (block) => !block.isConnected || !editor.contains(block),
        )
      ) {
        apply()
      } else if (!applying) {
        applying = true
        try {
          for (const block of pendingListBlocks) {
            // The top-level list itself may be hidden by a folded heading. Reconcile only list-owned
            // descendant attributes so local list work never steals that heading-owned visibility.
            clearListFoldAttributes(block)
            applyListFoldsWithin(editor, block, stored.lists)
          }
          observeGlyphs(editor)
        } finally {
          applying = false
        }
      }
      pendingFull = false
      pendingListBlocks.clear()
    })
  }

  const observer = new MutationObserver(scheduleApply)
  const initialSurface = surface()
  if (initialSurface)
    observer.observe(initialSurface, { childList: true, subtree: true })

  const controller: SectionFoldController = {
    toggleHeading(headingIndex) {
      const editor = surface()
      if (!editor) return false
      const blocks = topLevelBlocks(editor)
      const heading = blocks.filter((block) => headingLevel(block) !== null)[
        headingIndex
      ]
      if (!heading) return false
      const blockIndex = blocks.indexOf(heading)
      const range = sectionRangeForHeading(blocks, blockIndex)
      if (!range || range.end <= range.start + 1) return false
      const identity = headingIdentity(heading)
      const existing = stored.headings.findIndex((folded) =>
        sameHeading(folded, identity),
      )
      if (existing >= 0) stored.headings.splice(existing, 1)
      else stored.headings.push(identity)
      apply()
      persist()
      return true
    },
    toggleListItem(item) {
      const editor = surface()
      if (!editor?.contains(item) || directLists(item).length === 0)
        return false
      const path = listItemPath(editor, item)
      if (!path) return false
      const text = listItemText(item)
      const existing = stored.lists.findIndex(
        (folded) =>
          folded.text === text && folded.path.join('.') === path.join('.'),
      )
      if (existing >= 0) stored.lists.splice(existing, 1)
      else stored.lists.push({ path, text })
      apply()
      persist()
      return true
    },
    toggleAt(node) {
      const editor = surface()
      if (!editor?.contains(node)) return false
      const element =
        node.nodeType === Node.ELEMENT_NODE
          ? (node as Element)
          : node.parentElement
      const item = element?.closest<HTMLElement>('li')
      if (item && directLists(item).length > 0)
        return controller.toggleListItem(item)
      const heading = element?.closest<HTMLElement>('h1, h2, h3, h4, h5, h6')
      if (!heading) return false
      const headings = topLevelBlocks(editor).filter(
        (block) => headingLevel(block) !== null,
      )
      return controller.toggleHeading(headings.indexOf(heading))
    },
    ensureBlockVisible(block) {
      const editor = surface()
      if (!editor?.contains(block)) return false
      const hidden = block.closest<HTMLElement>(`[${FOLD_HIDDEN_ATTR}]`)
      if (!hidden) return false
      const ownerHeading = headingOwnerForHidden(editor, hidden)
      const ownerList = hidden.parentElement?.closest<HTMLElement>(
        `[${LIST_FOLDED_ATTR}]`,
      )
      let changed = false
      if (ownerHeading) {
        const identity = headingIdentity(ownerHeading)
        stored.headings = stored.headings.filter(
          (folded) => !sameHeading(folded, identity),
        )
        changed = true
      }
      if (ownerList) {
        const path = listItemPath(editor, ownerList)
        if (path) {
          stored.lists = stored.lists.filter(
            (folded) => folded.path.join('.') !== path.join('.'),
          )
          changed = true
        }
      }
      if (changed) {
        apply()
        persist()
      }
      return changed
    },
    state: () => cloneState(stored),
    apply,
    dispose() {
      if (disposed) return
      disposed = true
      observer.disconnect()
      glyphObserver?.disconnect()
      window.removeEventListener('resize', scheduleGlyphRefresh)
      document.fonts?.removeEventListener?.('loadingdone', scheduleGlyphRefresh)
      if (frame) cancelAnimationFrame(frame)
      if (glyphFrame) cancelAnimationFrame(glyphFrame)
      const editor = surface()
      if (editor) {
        clearFoldAttributes(editor)
        for (const item of editor.querySelectorAll<HTMLElement>('li')) {
          item.style.removeProperty(LIST_GLYPH_CENTER_VAR)
          item.style.removeProperty(LIST_ARROW_TOP_VAR)
        }
      }
    },
  }

  apply()
  return controller
}

let activeController: SectionFoldController | undefined

export function ensureFoldTargetVisible(block: Element): boolean {
  return activeController?.ensureBlockVisible(block) ?? false
}

export function toggleFoldAtCaret(): boolean {
  const selection = getSelection()
  const node = selection?.rangeCount ? selection.anchorNode : null
  return node ? (activeController?.toggleAt(node) ?? false) : false
}

export function sectionFoldShortcut(
  event: Pick<
    KeyboardEvent,
    'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'
  >,
): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    event.altKey &&
    event.code === 'BracketLeft'
  )
}

function listItemAtNativeMarker(
  list: HTMLElement,
  point: Pick<MouseEvent, 'clientX' | 'clientY'>,
): HTMLElement | null {
  return (
    directItems(list).find(
      (item) =>
        item.hasAttribute(LIST_FOLDABLE_ATTR) &&
        listFoldGutterHitTest(item, point),
    ) ?? null
  )
}

function foldableAtClick(
  target: HTMLElement,
  point: Pick<MouseEvent, 'clientX' | 'clientY'>,
): HTMLElement | null {
  const closest = target.closest<HTMLElement>(
    '[data-vmde-foldable], [data-vmde-list-foldable]',
  )
  const markerList =
    target.tagName === 'UL' || target.tagName === 'OL' ? target : null
  // Native outside ::marker clicks target the list. For nested lists, the closest foldable
  // ancestor is the owner LI, so choose only a direct child whose measured gutter contains it.
  if (markerList && (!closest || closest === markerList.parentElement))
    return listItemAtNativeMarker(markerList, point)
  return closest
}

export function installSectionFold(
  vditor: Vditor,
  initialState?: SectionFoldState,
  onPersist?: (state: SectionFoldState) => void,
): () => void {
  activeController?.dispose()
  const saved =
    initialState ??
    ((window.vscode?.getState?.() as Record<string, unknown> | undefined)?.[
      STATE_KEY
    ] as SectionFoldState | undefined)
  const persist = (state: SectionFoldState) => {
    const current =
      (window.vscode?.getState?.() as Record<string, unknown> | undefined) ?? {}
    window.vscode?.setState?.({ ...current, [STATE_KEY]: state })
    onPersist?.(state)
  }
  let controller = createSectionFoldController(vditor, {
    initialState: saved,
    persist,
  })
  activeController = controller
  const ensureVisible = (block: Element) => controller.ensureBlockVisible(block)
  ;(
    window as unknown as {
      __vmdeEnsureFoldTargetVisible?: (block: Element) => boolean
    }
  ).__vmdeEnsureFoldTargetVisible = ensureVisible

  let appFrame = 0
  let observedSurface = blockModeElement(vditor)
  const appObserver = new MutationObserver((records) => {
    // Vditor pre-creates mode roots and can reuse them, so an added `.vditor-reset` subtree is not a
    // complete mode signal. Compare the authoritative active surface identity; when it changes,
    // rebuild the controller so its own scoped observer follows the new IR/WYS root.
    const shouldApply = blockModeElement(vditor) !== observedSurface
    recordHelperMutationPass(
      'section-fold-app',
      records,
      shouldApply ? 'full' : 'skipped',
      0,
    )
    if (!shouldApply) return
    if (appFrame) return
    appFrame = requestAnimationFrame(() => {
      appFrame = 0
      const nextSurface = blockModeElement(vditor)
      if (!nextSurface || nextSurface === observedSurface) return
      const state = controller.state()
      controller.dispose()
      observedSurface = nextSurface
      controller = createSectionFoldController(vditor, {
        initialState: state,
        persist,
      })
      activeController = controller
    })
  })
  const app = document.getElementById('app')
  if (app) appObserver.observe(app, { childList: true, subtree: true })

  const onClick = (event: MouseEvent) => {
    const editor = blockModeElement(vditor)
    const target = event.target instanceof HTMLElement ? event.target : null
    if (!editor || !target || !editor.contains(target)) return
    const foldable = foldableAtClick(target, event)
    if (!foldable) return
    const hit = foldable.hasAttribute(FOLDABLE_ATTR)
      ? headingFoldGutterHitTest(foldable, event)
      : listFoldGutterHitTest(foldable, event)
    if (!hit || !controller.toggleAt(foldable)) return
    event.preventDefault()
    event.stopPropagation()
  }
  const onSelectionChange = () => {
    const selection = getSelection()
    const node = selection?.rangeCount ? selection.anchorNode : null
    const element =
      node?.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node?.parentElement
    const hidden = element?.closest(`[${FOLD_HIDDEN_ATTR}]`)
    if (hidden) controller.ensureBlockVisible(hidden)
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (guardComposition(event)) return
    if (sectionFoldShortcut(event) && toggleFoldAtCaret()) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }
  document.addEventListener('click', onClick, true)
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('keydown', onKeydown, true)
  return () => {
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('selectionchange', onSelectionChange)
    document.removeEventListener('keydown', onKeydown, true)
    appObserver.disconnect()
    if (appFrame) cancelAnimationFrame(appFrame)
    controller.dispose()
    if (activeController === controller) activeController = undefined
    const win = window as unknown as {
      __vmdeEnsureFoldTargetVisible?: (block: Element) => boolean
    }
    if (win.__vmdeEnsureFoldTargetVisible === ensureVisible)
      delete win.__vmdeEnsureFoldTargetVisible
  }
}
