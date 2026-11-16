import type Vditor from 'vditor'
import { blockModeElement } from '../util/source-map'
import {
  headingLabel,
  headingLevel,
  sectionRangeForHeading,
  topLevelBlocks,
} from './section-range'
import type { SectionFoldState } from '../../../src/shared/protocol'
import { RAW_HEADING_ATTR } from './preview-raw-headings'
import { deferWhilePaused } from '../util/observe-coalesce'
import {
  classifyEditorMutations,
  type EditorMutationImpact,
  forEachChangeScope,
  type HelperMutationPass,
  liveFeedOf,
  recordHelperMutationPass,
  recordsOutsideFeed,
  writeQuietly,
} from '../util/mutation-impact'
import {
  type BackgroundJob,
  type BackgroundScheduler,
  backgroundSchedulerOf,
} from '../util/background-budget'
import { onUnitFeed, type UnitsChange } from '../util/unit-changes'
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
  /** Collapse the heading section or list item at `node`; false when it is already collapsed. */
  foldAt(node: Node): boolean
  /** Expand the heading section or list item at `node`; false when it is already expanded. */
  unfoldAt(node: Node): boolean
  ensureBlockVisible(block: Element): boolean
  /** Task 724: the stored front-matter fold; undefined when this document has none stored. */
  frontMatterFolded(): boolean | undefined
  /** Task 724: store the front-matter fold with the heading and list folds; persists on a change. */
  setFrontMatterFolded(folded: boolean): void
  state(): SectionFoldState
  apply(): void
  dispose(): void
}

// The state a fold command asks for: `toggle` flips it, `fold`/`unfold` set it one way only.
type FoldRequest = 'toggle' | 'fold' | 'unfold'

function wantsFolded(request: FoldRequest, folded: boolean): boolean {
  if (request === 'toggle') return !folded
  return request === 'fold'
}

interface ControllerOptions {
  initialState?: SectionFoldState
  persist?: (state: SectionFoldState) => void
  /** The surface to fold; the IR/WYSIWYG editor by default. installSectionFold passes foldSurface. */
  surface?: () => HTMLElement | null
  /** Task 733: the scheduler of the `fold-apply` and `fold-glyphs` jobs; the window's by default. */
  scheduler?: BackgroundScheduler
}

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6'
const LIST_SELECTOR = 'ul, ol'

/** Task 721: the surface the folds apply to. Full Preview over an IR or WYSIWYG document gets the
 * same folds, read-only, from the same state; otherwise the IR/WYSIWYG editor does. Vditor's
 * `setEditMode` resets the Preview pane to `display: none` on every IR/WYSIWYG entry, so `block`
 * there means full Preview, never Split; Split (sv) keeps no folds, as before. */
export function foldSurface(vditor: Vditor): HTMLElement | null {
  const inner = (vditor as any)?.vditor
  const mode = inner?.currentMode
  const preview = inner?.preview
  if (
    (mode === 'ir' || mode === 'wysiwyg') &&
    preview?.element?.style.display === 'block' &&
    preview.previewElement instanceof HTMLElement
  )
    return preview.previewElement
  return blockModeElement(vditor)
}

function isPreviewSurface(surface: HTMLElement): boolean {
  return surface.parentElement?.classList.contains('vditor-preview') === true
}

// Lute's Preview HTML carries no `data-block`, so every element child of the Preview pane is a
// top-level block there.
function foldBlocks(surface: HTMLElement): HTMLElement[] {
  if (!isPreviewSurface(surface)) return topLevelBlocks(surface)
  return Array.from(surface.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  )
}

// A raw HTML heading is an HTML block in IR and WYSIWYG; the Preview source mask marks its rendered
// element (Task 713), so it neither folds nor ends a section there either.
function foldLevel(block: HTMLElement): number | null {
  return block.hasAttribute(RAW_HEADING_ATTR) ? null : headingLevel(block)
}

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

function markerContext(
  item: HTMLElement,
  style: CSSStyleDeclaration,
): CanvasRenderingContext2D | null {
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
  return markerMeasureContext
}

function listMarkerAdvance(
  item: HTMLElement,
  style: CSSStyleDeclaration,
): number | null {
  const label = item.getAttribute('data-marker')?.trim()
  if (!label) return null
  const advance = markerContext(item, style)?.measureText(label).width
  return advance !== undefined && Number.isFinite(advance) && advance > 0
    ? advance
    : null
}

const SYMBOL_MARKERS = new Set(['disc', 'circle', 'square'])

/** Distance from the item's content edge back to the centre of a disc, circle, or square marker,
 * or null when the marker font's ascent cannot be measured.
 *
 * Task 722: Chromium paints these markers as shapes sized from the marker font's integer ascent A,
 * not as text centred in a line box (Blink `ListMarker::InlineMarginsForOutside` and
 * `RelativeSymbolMarkerRect`): the outside marker box starts ⌊2A/3⌋ + 8 px before the content edge
 * and the shape is a ⌊(⌊2A/3⌋ + 1) / 2⌋ px square drawn 1 px into that box. The earlier half-line
 * model matched only near 14 px and put the triangle up to 5 px off the bullet at larger sizes. */
function symbolMarkerCenterOffset(
  item: HTMLElement,
  style: CSSStyleDeclaration,
): number | null {
  const ascent = markerContext(item, style)?.measureText(
    'x',
  ).fontBoundingBoxAscent
  if (ascent === undefined || !Number.isFinite(ascent) || ascent <= 0)
    return null
  const offset = Math.floor((Math.round(ascent) * 2) / 3)
  const size = Math.floor((offset + 1) / 2)
  return offset + 7 - size / 2
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
  const bottom = itemRect.top + lineHeight
  const symbolOffset = SYMBOL_MARKERS.has(marker.listStyleType)
    ? symbolMarkerCenterOffset(item, marker)
    : null
  if (symbolOffset !== null)
    return { centerX: itemRect.left - symbolOffset, bottom }
  const ordered = item.parentElement?.tagName === 'OL'
  const visibleWidth = ordered
    ? Math.min(width, listMarkerAdvance(item, marker) ?? width)
    : width
  // Ordered markers occupy their computed width and paint their numeral at its start. Without a
  // measurable font, a bullet falls back to the centre of a line-height square before the text.
  return {
    centerX: ordered
      ? itemRect.left - width + visibleWidth / 2
      : itemRect.left - (lineHeight + width) / 2,
    bottom,
  }
}

interface ListGlyphPosition {
  center: string
  top: string
}

/** Read where the list item's native symbol sits (layout reads only, no writes), or null when the
 * item has no measurable arrow and symbol (hidden, no marker, malformed pseudo box). */
function measureListFoldGlyph(item: HTMLElement): ListGlyphPosition | null {
  const rect = item.getBoundingClientRect()
  const arrow = renderedListFoldArrowRect(item, rect)
  const symbol = arrow && listSymbolMetrics(item, rect)
  if (!symbol || !Number.isFinite(symbol.centerX + symbol.bottom)) return null
  return {
    center: `${symbol.centerX - rect.left}px`,
    top: `${symbol.bottom - rect.top}px`,
  }
}

function writeListFoldGlyph(
  item: HTMLElement,
  position: ListGlyphPosition | null,
): void {
  if (!position) {
    item.style.removeProperty(LIST_GLYPH_CENTER_VAR)
    item.style.removeProperty(LIST_ARROW_TOP_VAR)
    return
  }
  if (item.style.getPropertyValue(LIST_GLYPH_CENTER_VAR) !== position.center)
    item.style.setProperty(LIST_GLYPH_CENTER_VAR, position.center)
  if (item.style.getPropertyValue(LIST_ARROW_TOP_VAR) !== position.top)
    item.style.setProperty(LIST_ARROW_TOP_VAR, position.top)
}

function alignListFoldGlyph(item: HTMLElement): void {
  writeListFoldGlyph(item, measureListFoldGlyph(item))
}

/** Align a batch with every layout read first and every style write after, so the first write
 * cannot force a layout for each remaining item (Task 641: one forced layout per item cost about
 * half a second on a 150 KB file). */
function alignListFoldGlyphs(items: readonly HTMLElement[]): void {
  const positions = items.map(measureListFoldGlyph)
  items.forEach((item, index) => {
    writeListFoldGlyph(item, positions[index])
  })
}

// Task 641: the glyph centre is style-only polish for items on screen, so it is measured after the
// first paint (an idle period) and only for items near the viewport; the CSS fallback centre
// stands in until then. An item scrolled into the margin is measured when the observer reports it.
const GLYPH_NEAR_MARGIN_PX = 600

/** The innermost ancestor that scrolls and clips the editor, or null when the document scrolls. An
 * intersection observer's margin widens only its root, never a clipping ancestor, so the root must
 * be that scroller for "near" to include the margin. */
function glyphScrollRoot(editor: HTMLElement): HTMLElement | null {
  for (
    let element: HTMLElement | null = editor;
    element &&
    element !== document.body &&
    element !== document.documentElement;
    element = element.parentElement
  ) {
    const overflow = getComputedStyle(element).overflowY
    if (
      (overflow === 'auto' || overflow === 'scroll') &&
      element.scrollHeight > element.clientHeight
    )
      return element
  }
  return null
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
    level: foldLevel(heading) ?? 0,
  }
}

function sameHeading(a: HeadingFoldIdentity, b: HeadingFoldIdentity): boolean {
  return Boolean(
    (a.id && b.id && a.id === b.id) ||
      (a.text === b.text && a.level === b.level),
  )
}

/** `sameHeading` against each stored fold, reading the heading text only when an id does not decide
 * and a fold of the same level exists (Task 733: a heading change refolds every top-level heading). */
function matchesStoredFold(
  heading: HTMLElement,
  foldedHeadings: readonly HeadingFoldIdentity[],
): boolean {
  const id = heading.id ? stableHeadingId(heading.id) : undefined
  const level = foldLevel(heading) ?? 0
  let text: string | undefined
  for (const folded of foldedHeadings) {
    if (id && folded.id && folded.id === id) return true
    if (folded.level !== level) continue
    text ??= headingLabel(heading)
    if (folded.text === text) return true
  }
  return false
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

// Task 721: the text identity of a list item is the same in every surface. IR shows inline markers
// (`**`, link brackets) and rendered previews as text that WYSIWYG and Preview do not have, and
// Preview HTML keeps the source line breaks, so markers and previews are dropped and white space is
// collapsed.
function listItemText(item: HTMLElement): string {
  const clone = item.cloneNode(true) as HTMLElement
  for (const skipped of clone.querySelectorAll(
    ':scope > ul, :scope > ol, .vditor-ir__marker, .vditor-ir__preview, [data-render]',
  ))
    skipped.remove()
  return clone.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

// The text earlier versions stored: the raw IR text. A fold saved by one still matches its item.
function legacyListItemText(item: HTMLElement): string {
  const clone = item.cloneNode(true) as HTMLElement
  for (const nested of clone.querySelectorAll(':scope > ul, :scope > ol'))
    nested.remove()
  return clone.textContent?.trim() ?? ''
}

function listTextMatches(item: HTMLElement, text: string): boolean {
  return listItemText(item) === text || legacyListItemText(item) === text
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
  const elements = [
    ...(surface.matches(FOLD_SELECTOR) ? [surface] : []),
    ...Array.from(surface.querySelectorAll<HTMLElement>(FOLD_SELECTOR)),
  ]
  // Fold state is view-only: quiet, so the unit-DOM shadow model sees no edit.
  writeQuietly(() => {
    for (const element of elements) clearFold(element)
  })
}

function cloneState(state: SectionFoldState): SectionFoldState {
  const clone: SectionFoldState = {
    headings: state.headings.map((heading) => ({ ...heading })),
    lists: state.lists.map((list) => ({ ...list, path: [...list.path] })),
  }
  // Task 724: the optional front-matter field rides along, so a heading or list change keeps it.
  if (typeof state.frontMatterFolded === 'boolean')
    clone.frontMatterFolded = state.frontMatterFolded
  return clone
}

function applyHeadingFolds(
  editor: HTMLElement,
  foldedHeadings: readonly HeadingFoldIdentity[],
): void {
  const blocks = foldBlocks(editor)
  // Task 721: one pass by index, and no identity read without a stored fold. A large streamed
  // Preview is folded in one task at the stream's end, with thousands of headings. The fold
  // attributes are view-only: the whole pass is one quiet write.
  writeQuietly(() => foldHeadings(blocks, foldedHeadings))
}

function foldHeadings(
  blocks: readonly HTMLElement[],
  foldedHeadings: readonly HeadingFoldIdentity[],
): void {
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const heading = blocks[blockIndex]
    if (foldLevel(heading) === null) continue
    const range = sectionRangeForHeading(blocks, blockIndex, foldLevel)
    if (!range || range.end <= range.start + 1) continue
    heading.setAttribute(FOLDABLE_ATTR, '1')
    if (foldedHeadings.length === 0) continue
    if (!matchesStoredFold(heading, foldedHeadings)) continue
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
  onFoldable: (item: HTMLElement) => void,
): void {
  // View-only fold state: one quiet write for the pass.
  writeQuietly(() => {
    for (const item of scope.querySelectorAll<HTMLElement>('li')) {
      if (directLists(item)[0]) {
        item.setAttribute(LIST_FOLDABLE_ATTR, '1')
        onFoldable(item)
      }
    }
    applyStoredListFolds(editor, scope, foldedLists)
  })
}

/** The stored list folds whose item is inside `scope` (callers write quietly). */
function applyStoredListFolds(
  editor: HTMLElement,
  scope: HTMLElement,
  foldedLists: readonly ListFoldIdentity[],
): void {
  for (const folded of foldedLists) {
    const item = resolveListPath(editor, folded.path)
    const nested = item ? firstDirectList(item) : undefined
    if (
      !item ||
      !scope.contains(item) ||
      !nested ||
      !listTextMatches(item, folded.text)
    )
      continue
    item.setAttribute(LIST_FOLDED_ATTR, '1')
    item.dataset.vmdeFoldCount = String(item.querySelectorAll('li').length)
    nested.setAttribute(FOLD_HIDDEN_ATTR, '1')
  }
}

/** The first direct `ul`/`ol` child of `item`, without allocating. */
function firstDirectList(item: Element): HTMLElement | undefined {
  for (
    let child = item.firstElementChild;
    child;
    child = child.nextElementSibling
  )
    if (child.tagName === 'UL' || child.tagName === 'OL')
      return child as HTMLElement
  return undefined
}

/** Removes the list-owned fold attributes of one element (callers write quietly). */
function clearListFold(element: HTMLElement): void {
  element.removeAttribute(LIST_FOLDED_ATTR)
  element.removeAttribute(LIST_FOLDABLE_ATTR)
  element.removeAttribute(FOLD_HIDDEN_ATTR)
  delete element.dataset.vmdeFoldCount
}

/** The top-level element under `root` that holds `element`, or null when it is outside `root`. */
function topUnder(root: HTMLElement, element: Element): HTMLElement | null {
  let el: Element | null = element
  while (el && el.parentElement !== root) el = el.parentElement
  return el as HTMLElement | null
}

const NO_RECORDS: readonly MutationRecord[] = []

const FOLD_SELECTOR = `[${FOLD_HIDDEN_ATTR}], [${FOLDED_ATTR}], [${FOLDABLE_ATTR}], [${LIST_FOLDED_ATTR}], [${LIST_FOLDABLE_ATTR}]`

/** Removes every fold attribute of one element (callers write quietly). */
function clearFold(element: HTMLElement): void {
  element.removeAttribute(FOLDED_ATTR)
  element.removeAttribute(FOLDABLE_ATTR)
  clearListFold(element)
}

function applyListFolds(
  editor: HTMLElement,
  foldedLists: readonly ListFoldIdentity[],
  onFoldable: (item: HTMLElement) => void,
): void {
  applyListFoldsWithin(editor, editor, foldedLists, onFoldable)
}

function headingOwnerForHidden(
  editor: HTMLElement,
  hidden: HTMLElement,
): HTMLElement | undefined {
  const previous = hidden.previousElementSibling
  if (previous?.matches(`[${FOLDED_ATTR}]`)) return previous as HTMLElement
  const blocks = foldBlocks(editor)
  const targetIndex = blocks.indexOf(hidden)
  return Array.from(
    editor.querySelectorAll<HTMLElement>(`[${FOLDED_ATTR}]`),
  ).find((heading) => {
    const range = sectionRangeForHeading(
      blocks,
      blocks.indexOf(heading),
      foldLevel,
    )
    return !!range && targetIndex > range.start && targetIndex < range.end
  })
}

// Task 721 repair: the whole-document fold pass over a Preview pane runs in bounded slices, one per
// animation frame, so a large streamed Preview (1200 sections in the 800 KB stream fixture) never
// spends one long task folding it, and each frame restyles only the slice it marked. A slice only
// writes attributes (no layout reads), and only the ones that differ, so nothing forces a layout.
const PREVIEW_PASS_BLOCKS = 150
const PREVIEW_PASS_ITEMS = 300

function setFlag(element: HTMLElement, name: string, on: boolean): void {
  if (element.hasAttribute(name) === on) return
  if (on) element.setAttribute(name, '1')
  else element.removeAttribute(name)
}

function setFoldCount(element: HTMLElement, count: number | null): void {
  const value = count === null ? undefined : String(count)
  if (element.dataset.vmdeFoldCount === value) return
  if (value === undefined) delete element.dataset.vmdeFoldCount
  else element.dataset.vmdeFoldCount = value
}

/** Reconcile one top-level block of a Preview pass. `hiddenUntil` is the block index up to which an
 *  earlier folded heading of this pass hides blocks; the new bound is returned. */
function reconcileHeadingBlock(
  blocks: readonly HTMLElement[],
  index: number,
  foldedHeadings: readonly HeadingFoldIdentity[],
  hiddenUntil: number,
): number {
  const block = blocks[index]
  setFlag(block, FOLD_HIDDEN_ATTR, index < hiddenUntil)
  const range =
    foldLevel(block) === null
      ? null
      : sectionRangeForHeading(blocks, index, foldLevel)
  const foldable = !!range && range.end > range.start + 1
  setFlag(block, FOLDABLE_ATTR, foldable)
  const folded =
    foldable &&
    foldedHeadings.length > 0 &&
    foldedHeadings.some((stored) => sameHeading(stored, headingIdentity(block)))
  setFlag(block, FOLDED_ATTR, folded)
  setFoldCount(block, folded && range ? range.end - range.start - 1 : null)
  return folded && range ? Math.max(hiddenUntil, range.end) : hiddenUntil
}

/** Reconcile one list item of a Preview pass against the folded items resolved at its start. */
function reconcileListItem(
  item: HTMLElement,
  foldedItems: ReadonlySet<HTMLElement>,
  onFoldable: (item: HTMLElement) => void,
): void {
  const nested = directLists(item)
  const folded = nested.length > 0 && foldedItems.has(item)
  setFlag(item, LIST_FOLDABLE_ATTR, nested.length > 0)
  setFlag(item, LIST_FOLDED_ATTR, folded)
  setFoldCount(item, folded ? item.querySelectorAll('li').length : null)
  nested.forEach((list, index) => {
    setFlag(list, FOLD_HIDDEN_ATTR, folded && index === 0)
  })
  if (nested.length > 0) onFoldable(item)
}

function resolveFoldedListItems(
  surface: HTMLElement,
  foldedLists: readonly ListFoldIdentity[],
): Set<HTMLElement> {
  const items = new Set<HTMLElement>()
  for (const folded of foldedLists) {
    const item = resolveListPath(surface, folded.path)
    if (item && directLists(item)[0] && listTextMatches(item, folded.text))
      items.add(item)
  }
  return items
}

interface PreviewPassCursor {
  blocks: HTMLElement[]
  items: HTMLElement[]
  foldedItems: Set<HTMLElement>
  block: number
  item: number
  hiddenUntil: number
}

/** Reconcile the next slice of a Preview pass (top-level blocks first, then list items); true when
 *  the pass is complete. */
function advancePreviewPass(
  cursor: PreviewPassCursor,
  foldedHeadings: readonly HeadingFoldIdentity[],
  onFoldable: (item: HTMLElement) => void,
): boolean {
  const blockEnd = Math.min(
    cursor.blocks.length,
    cursor.block + PREVIEW_PASS_BLOCKS,
  )
  // Each slice is one quiet write: the flags it sets are view-only.
  writeQuietly(() => {
    for (; cursor.block < blockEnd; cursor.block++)
      cursor.hiddenUntil = reconcileHeadingBlock(
        cursor.blocks,
        cursor.block,
        foldedHeadings,
        cursor.hiddenUntil,
      )
  })
  if (cursor.block < cursor.blocks.length) return false
  const itemEnd = Math.min(
    cursor.items.length,
    cursor.item + PREVIEW_PASS_ITEMS,
  )
  writeQuietly(() => {
    for (; cursor.item < itemEnd; cursor.item++)
      reconcileListItem(
        cursor.items[cursor.item],
        cursor.foldedItems,
        onFoldable,
      )
  })
  return cursor.item >= cursor.items.length
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
  // Task 733: a whole feed change (the sliced `fold-apply` job) and a feed heading change (a pass
  // over the top-level blocks), beside the list blocks to reconcile.
  let pendingWhole = false
  let pendingHeadings = false
  const pendingListBlocks = new Set<HTMLElement>()
  const surface = options.surface ?? (() => blockModeElement(vditor))
  const scheduler = options.scheduler ?? backgroundSchedulerOf(window)
  let glyphFrame = 0
  let observedSurface: HTMLElement | null = null
  const observedItems = new Set<HTMLElement>()
  // Task 641: items whose glyph must be measured again, the items the viewport observer last
  // reported near the viewport, and the items it watches. Nothing is measured until the first
  // idle period (`glyphsLive`); an environment without the observer treats every item as near.
  const dirtyGlyphs = new Set<HTMLElement>()
  const nearGlyphs = new Set<HTMLElement>()
  const watchedGlyphs = new Set<HTMLElement>()
  let glyphsLive = false
  // True while the `fold-glyphs` job owns the dirty items: marking one schedules no frame flush.
  let glyphJobQueued = false
  let nearObserver: IntersectionObserver | null = null
  const observesNearness = typeof IntersectionObserver === 'function'
  const flushGlyphs = () => {
    if (disposed || !glyphsLive) return
    const batch: HTMLElement[] = []
    for (const item of dirtyGlyphs) {
      if (!item.isConnected || !item.hasAttribute(LIST_FOLDABLE_ATTR)) {
        dirtyGlyphs.delete(item)
        continue
      }
      if (observesNearness && !nearGlyphs.has(item)) continue
      dirtyGlyphs.delete(item)
      batch.push(item)
    }
    alignListFoldGlyphs(batch)
  }
  let flushFrame = 0
  const scheduleGlyphFlush = () => {
    if (disposed || flushFrame) return
    flushFrame = requestAnimationFrame(() => {
      flushFrame = 0
      flushGlyphs()
    })
  }
  const markGlyphDirty = (item: HTMLElement) => {
    dirtyGlyphs.add(item)
    if (glyphsLive && !glyphJobQueued) scheduleGlyphFlush()
  }
  const refreshGlyphs = () => {
    if (disposed) return
    const editor = surface()
    if (!editor) return
    for (const item of editor.querySelectorAll<HTMLElement>(
      `li[${LIST_FOLDABLE_ATTR}]`,
    ))
      dirtyGlyphs.add(item)
    flushGlyphs()
  }
  const scheduleGlyphRefresh = () => {
    if (disposed || glyphFrame) return
    glyphFrame = requestAnimationFrame(() => {
      glyphFrame = 0
      refreshGlyphs()
    })
  }
  const onNearChange = (entries: IntersectionObserverEntry[]) => {
    let reached = false
    for (const entry of entries) {
      const item = entry.target as HTMLElement
      if (entry.isIntersecting) {
        nearGlyphs.add(item)
        reached = reached || dirtyGlyphs.has(item)
      } else nearGlyphs.delete(item)
    }
    if (reached) flushGlyphs()
  }
  const watchGlyphs = (editor: HTMLElement, items: Iterable<HTMLElement>) => {
    if (!glyphsLive || !observesNearness) return
    nearObserver ??= new IntersectionObserver(onNearChange, {
      root: glyphScrollRoot(editor),
      rootMargin: `${GLYPH_NEAR_MARGIN_PX}px`,
    })
    for (const item of items) {
      if (watchedGlyphs.has(item)) continue
      nearObserver.observe(item)
      watchedGlyphs.add(item)
    }
    for (const item of watchedGlyphs) {
      if (
        item.isConnected &&
        editor.contains(item) &&
        item.hasAttribute(LIST_FOLDABLE_ATTR)
      )
        continue
      nearObserver.unobserve(item)
      watchedGlyphs.delete(item)
      nearGlyphs.delete(item)
    }
  }
  // The first idle period after the controller exists: the editor has painted, so the viewport
  // observer starts and the items near the viewport are measured.
  const startGlyphs = () => {
    glyphsLive = true
    const editor = surface()
    if (!editor) return
    const items = editor.querySelectorAll<HTMLElement>(
      `li[${LIST_FOLDABLE_ATTR}]`,
    )
    watchGlyphs(editor, items)
    if (!observesNearness) for (const item of items) markGlyphDirty(item)
  }
  // Task 733 (D-13 design 1.1): the idle glyph work is the `fold-glyphs` job. Its first step starts
  // the glyphs; every step measures dirty near items until the slice is spent (all reads), then
  // writes their positions (one forced layout per step at most). The two arrays are reused.
  const glyphBatch: HTMLElement[] = []
  const glyphPositions: Array<ListGlyphPosition | null> = []
  // Measures dirty near items into the reused batch until the slice is spent; true when some are left.
  const measureDirtyGlyphs = (budget: { spent(): boolean }): boolean => {
    for (const item of dirtyGlyphs) {
      if (budget.spent()) return true
      const gone = !item.isConnected || !item.hasAttribute(LIST_FOLDABLE_ATTR)
      if (!gone && observesNearness && !nearGlyphs.has(item)) continue
      dirtyGlyphs.delete(item)
      if (gone) continue
      glyphBatch.push(item)
      glyphPositions.push(measureListFoldGlyph(item))
    }
    return false
  }
  const glyphJob: BackgroundJob = {
    name: 'fold-glyphs',
    lane: 'idle',
    step(budget) {
      if (disposed) {
        glyphJobQueued = false
        return false
      }
      if (!glyphsLive) startGlyphs()
      const left = measureDirtyGlyphs(budget)
      for (let index = 0; index < glyphBatch.length; index++)
        writeListFoldGlyph(glyphBatch[index], glyphPositions[index])
      glyphBatch.length = 0
      glyphPositions.length = 0
      glyphJobQueued = left
      return left
    },
  }
  glyphJobQueued = true
  scheduler.post(glyphJob)
  // Marker width can change after font loading, zoom or a split-pane resize even
  // when Vditor has not replaced a node. Observe each foldable LI as well as the surface.
  const glyphObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(scheduleGlyphRefresh)
      : null
  // `items`: the foldable items when the caller already holds them (the sliced whole pass); otherwise
  // they are queried.
  const observeGlyphs = (
    editor: HTMLElement,
    items: Iterable<HTMLElement> = editor.querySelectorAll<HTMLElement>(
      `li[${LIST_FOLDABLE_ATTR}]`,
    ),
  ) => {
    if (observedSurface !== editor) {
      nearObserver?.disconnect()
      nearObserver = null
      watchedGlyphs.clear()
      nearGlyphs.clear()
      glyphObserver?.disconnect()
      observedItems.clear()
      glyphObserver?.observe(editor)
      observedSurface = editor
    }
    watchGlyphs(editor, items)
    if (!glyphObserver) return
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
    for (const item of items) watchGlyph(item)
  }
  // One foldable item of a scoped list pass: observed for resize and nearness. Items that left the
  // document are released by the next whole pass.
  const watchGlyph = (item: HTMLElement) => {
    if (glyphObserver && !observedItems.has(item)) {
      glyphObserver.observe(item)
      observedItems.add(item)
    }
    if (nearObserver && !watchedGlyphs.has(item)) {
      nearObserver.observe(item)
      watchedGlyphs.add(item)
    }
  }
  window.addEventListener('resize', scheduleGlyphRefresh)
  document.fonts?.addEventListener?.('loadingdone', scheduleGlyphRefresh)

  const persist = () => options.persist?.(cloneState(stored))

  // Task 721 repair: the sliced Preview pass (see PREVIEW_PASS_BLOCKS). A newer pass, a synchronous
  // apply (a fold toggle) or dispose cancels the running one through the generation number.
  let passGeneration = 0
  let passFrame = 0
  const cancelPreviewPass = () => {
    passGeneration++
    if (passFrame) cancelAnimationFrame(passFrame)
    passFrame = 0
  }
  // The first slice runs at once; the rest follow one per frame.
  const startPreviewPass = (editor: HTMLElement) => {
    cancelPreviewPass()
    const generation = passGeneration
    const cursor: PreviewPassCursor = {
      blocks: foldBlocks(editor),
      items: Array.from(editor.querySelectorAll<HTMLElement>('li')),
      foldedItems: resolveFoldedListItems(editor, stored.lists),
      block: 0,
      item: 0,
      hiddenUntil: 0,
    }
    const slice = () => {
      passFrame = 0
      if (disposed || generation !== passGeneration || surface() !== editor)
        return
      applying = true
      let done = false
      try {
        done = advancePreviewPass(cursor, stored.headings, markGlyphDirty)
      } finally {
        applying = false
      }
      if (done) observeGlyphs(editor)
      else passFrame = requestAnimationFrame(slice)
    }
    slice()
  }

  // Task 733 (D-13 design 1.1): the whole pass of a whole feed change is the `fold-apply` job, in
  // frame slices: collect the fold attributes (one query), clear them, fold the headings, mark the
  // foldable items, apply the stored list folds, then watch the glyphs. A step reads the surface
  // again (R-1): a new surface restarts the pass.
  let applyPhase = 0
  let applyEditor: HTMLElement | null = null
  let applyList: HTMLElement[] = []
  let applyIndex = 0
  const applyFoldable: HTMLElement[] = []
  // Visits the collected elements from the cursor until the slice is spent; true when all are done.
  const visitList = (
    budget: { spent(): boolean },
    visit: (element: HTMLElement) => void,
  ): boolean => {
    while (applyIndex < applyList.length && !budget.spent())
      visit(applyList[applyIndex++])
    return applyIndex >= applyList.length
  }
  const collect = (editor: HTMLElement, selector: string) => {
    applyList = Array.from(editor.querySelectorAll<HTMLElement>(selector))
    applyIndex = 0
  }
  const markFoldable = (item: HTMLElement) => {
    if (!item.isConnected || !firstDirectList(item)) return
    item.setAttribute(LIST_FOLDABLE_ATTR, '1')
    markGlyphDirty(item)
    applyFoldable.push(item)
  }
  // Phase n runs `applyPhases[n - 1]`, which returns true when the phase is done.
  const applyPhases: Array<
    (editor: HTMLElement, budget: { spent(): boolean }) => boolean
  > = [
    (editor) => {
      collect(editor, FOLD_SELECTOR)
      return true
    },
    (_editor, budget) => visitList(budget, clearFold),
    (editor) => {
      foldHeadings(foldBlocks(editor), stored.headings)
      return true
    },
    (editor) => {
      collect(editor, 'li')
      applyFoldable.length = 0
      return true
    },
    (_editor, budget) => visitList(budget, markFoldable),
    (editor) => {
      applyStoredListFolds(editor, editor, stored.lists)
      return true
    },
    (editor) => {
      observeGlyphs(editor, applyFoldable)
      applyList = []
      applyFoldable.length = 0
      return true
    },
  ]
  const applyStep = (editor: HTMLElement, budget: { spent(): boolean }) => {
    if (!applyPhases[applyPhase - 1](editor, budget)) return
    applyPhase = applyPhase >= applyPhases.length ? 0 : applyPhase + 1
  }
  const applyJob: BackgroundJob = {
    name: 'fold-apply',
    lane: 'frame',
    step(budget) {
      const editor = surface()
      if (disposed || !editor || applyPhase === 0) return false
      if (editor !== applyEditor) {
        applyEditor = editor
        applyPhase = 1
      }
      applying = true
      try {
        // Fold state is view-only: quiet, so the unit-DOM shadow model sees no edit.
        writeQuietly(() => {
          while (applyPhase !== 0 && !budget.spent()) applyStep(editor, budget)
        })
      } finally {
        applying = false
      }
      return applyPhase !== 0
    },
  }
  const startApplyJob = () => {
    applyPhase = 1
    applyEditor = null
    scheduler.post(applyJob)
  }
  const cancelApplyJob = () => {
    applyPhase = 0
    applyList = []
    applyFoldable.length = 0
    scheduler.cancel(applyJob)
  }

  const apply = () => {
    if (disposed || applying) return
    const editor = surface()
    if (!editor) return
    cancelPreviewPass()
    cancelApplyJob()
    applying = true
    try {
      clearFoldAttributes(editor)
      applyHeadingFolds(editor, stored.headings)
      applyListFolds(editor, stored.lists, markGlyphDirty)
      observeGlyphs(editor)
    } finally {
      applying = false
    }
  }

  const schedulePreviewPass = (records: MutationRecord[]) => {
    // Task 721: a Preview render replaces or morphs whole blocks, none of them a `data-block` the
    // edit-surface classifier can scope to, so any Preview change re-folds the whole pane.
    recordHelperMutationPass('section-fold-surface', records, 'full', 0)
    // Repair 2: the first slice runs in this observer callback, a microtask before any timer task
    // or paint. Rendered blocks left unfolded for a frame let a reading-position save anchor on a
    // block about to be hidden, and the restore on the next open unfolded its section
    // (ensureFoldTargetVisible) and stored that. A streaming render pauses the decorating
    // observers; the pass then starts at the stream's end, still in bounded slices.
    if (!deferWhilePaused(restartPreviewPass)) restartPreviewPass()
  }

  const scheduleApply = (batch: MutationRecord[]) => {
    // Task 733 (D-13 binding rule 6): the live feed delivers the changes inside its root.
    const observed = surface()
    const records = observed ? recordsOutsideFeed(observed, batch) : batch
    if (records.length === 0) {
      // The feed delivers these records; its change records the pass (`recordFeedPass`).
      recordHelperMutationPass('section-fold-surface', batch, 'skipped', 0)
      return
    }
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
    scheduleFlush()
  }

  const scheduleFlush = () => {
    if (frame || disposed) return
    frame = requestAnimationFrame(() => {
      frame = 0
      flushPending()
    })
  }

  // Task 733 (D-13 binding rules 1 to 4): a feed change names what to reconcile. A whole change runs
  // the sliced whole pass; a list scope or a structural list reconciles that list; a heading (or a
  // spun block, which can start or end a section) refolds the top-level blocks. Nothing else in a
  // non-whole change can move a fold, and nothing reads the root.
  const noteTop = (top: HTMLElement) => {
    if (top.tagName === 'UL' || top.tagName === 'OL') pendingListBlocks.add(top)
    else if (foldLevel(top) !== null) pendingHeadings = true
  }
  const noteScoped = (change: UnitsChange, editor: HTMLElement) => {
    for (const top of change.structural)
      if (top.parentElement === editor) noteTop(top)
    forEachChangeScope(change, (element) => {
      const top = topUnder(editor, element)
      if (top) noteTop(top)
    })
  }
  // The top-level block count at the last feed change. A spun block of the same count (a paragraph
  // respun by typing) moves no section; a changed count (an Enter split, a merge) can.
  let topCount = -1
  const onFeedChange = (change: UnitsChange, editor: HTMLElement) => {
    const count = editor.childElementCount
    const moved = topCount >= 0 && count !== topCount
    topCount = count
    if (change.whole) {
      pendingWhole = true
      pendingHeadings = false
      pendingListBlocks.clear()
    } else if (!pendingWhole && !pendingFull) {
      if (moved) pendingHeadings = true
      noteScoped(change, editor)
    }
    recordFeedPass()
    if (pendingWhole || pendingHeadings || pendingListBlocks.size > 0)
      scheduleFlush()
  }
  // Task 733 (run 1, R-2): the feed path keeps the observable pass statistics of the observer path
  // (`section-fold-surface`, end-to-end runs only): a whole change or a heading refold is a full
  // pass over the surface's sections, a list reconcile is local, anything else is skipped.
  const recordFeedPass = () =>
    recordHelperMutationPass(
      'section-fold-surface',
      NO_RECORDS,
      pendingWhole || pendingHeadings
        ? 'full'
        : pendingListBlocks.size > 0
          ? 'local'
          : 'skipped',
      pendingListBlocks.size,
    )
  const offFeed = onUnitFeed(window, (change, feed) => {
    const editor = surface()
    if (
      disposed ||
      !editor ||
      !feed.isLive() ||
      !editor.contains(feed.root) ||
      isPreviewSurface(editor)
    )
      return
    onFeedChange(change, editor)
  })

  // The top-level blocks of a feed heading change: heading-owned attributes cleared and refolded.
  const refoldHeadings = (editor: HTMLElement) => {
    const blocks = foldBlocks(editor)
    writeQuietly(() => {
      for (const block of blocks) {
        block.removeAttribute(FOLDED_ATTR)
        block.removeAttribute(FOLDABLE_ATTR)
        block.removeAttribute(FOLD_HIDDEN_ATTR)
        if (block.tagName !== 'UL' && block.tagName !== 'OL')
          delete block.dataset.vmdeFoldCount
      }
      foldHeadings(blocks, stored.headings)
    })
  }

  // One list of a scoped change: one query of the list, its list-owned attributes cleared, its
  // foldable items marked and watched, and the stored folds inside it applied.
  const reconcileList = (editor: HTMLElement, block: HTMLElement) => {
    writeQuietly(() => {
      for (const element of block.querySelectorAll<HTMLElement>('li, ul, ol')) {
        clearListFold(element)
        if (element.tagName !== 'LI' || !firstDirectList(element)) continue
        element.setAttribute(LIST_FOLDABLE_ATTR, '1')
        markGlyphDirty(element)
        watchGlyph(element)
      }
      applyStoredListFolds(editor, block, stored.lists)
    })
  }

  // One function, so a paused-observer deferral queues it once.
  function restartPreviewPass(): void {
    if (disposed) return
    const editor = surface()
    if (editor && isPreviewSurface(editor)) startPreviewPass(editor)
  }

  // A live feed replaces a pending block that left the document by the scopes of a later change
  // (rule 4); without one, a replaced block still means the whole pass.
  function replacedWithoutFeed(editor: HTMLElement, live: boolean): boolean {
    if (live) return false
    for (const block of pendingListBlocks)
      if (!block.isConnected || !editor.contains(block)) return true
    return false
  }

  // The scoped work of a frame: the heading refold and the pending lists.
  function flushScoped(editor: HTMLElement, live: boolean): void {
    applying = true
    try {
      if (pendingHeadings) refoldHeadings(editor)
      for (const block of pendingListBlocks) {
        // The top-level list itself may be hidden by a folded heading. Reconcile only list-owned
        // descendant attributes so local list work never steals that heading-owned visibility.
        if (block.isConnected && editor.contains(block))
          reconcileList(editor, block)
      }
      if (!live) observeGlyphs(editor)
    } finally {
      applying = false
    }
  }

  // The pending edit-surface work of the frame scheduled above.
  function flushPending(): void {
    if (disposed) return
    const editor = surface()
    const live = editor ? liveFeedOf(editor) !== undefined : false
    if (pendingFull || !editor || replacedWithoutFeed(editor, live)) apply()
    else if (pendingWhole) startApplyJob()
    else if (!applying) flushScoped(editor, live)
    pendingFull = false
    pendingWhole = false
    pendingHeadings = false
    pendingListBlocks.clear()
  }

  const observer = new MutationObserver((records) => {
    const observed = surface()
    if (observed && isPreviewSurface(observed)) schedulePreviewPass(records)
    else scheduleApply(records)
  })
  const initialSurface = surface()
  if (initialSurface)
    observer.observe(initialSurface, { childList: true, subtree: true })

  const setHeadingFold = (
    headingIndex: number,
    request: FoldRequest,
  ): boolean => {
    const editor = surface()
    if (!editor) return false
    const blocks = foldBlocks(editor)
    const heading = blocks.filter((block) => foldLevel(block) !== null)[
      headingIndex
    ]
    if (!heading) return false
    const blockIndex = blocks.indexOf(heading)
    const range = sectionRangeForHeading(blocks, blockIndex, foldLevel)
    if (!range || range.end <= range.start + 1) return false
    const identity = headingIdentity(heading)
    const existing = stored.headings.findIndex((folded) =>
      sameHeading(folded, identity),
    )
    const folded = existing >= 0
    if (wantsFolded(request, folded) === folded) return false
    if (folded) stored.headings.splice(existing, 1)
    else stored.headings.push(identity)
    apply()
    persist()
    return true
  }

  const setListItemFold = (
    item: HTMLElement,
    request: FoldRequest,
  ): boolean => {
    const editor = surface()
    if (!editor?.contains(item) || directLists(item).length === 0) return false
    const path = listItemPath(editor, item)
    if (!path) return false
    const text = listItemText(item)
    const existing = stored.lists.findIndex(
      (folded) =>
        listTextMatches(item, folded.text) &&
        folded.path.join('.') === path.join('.'),
    )
    const folded = existing >= 0
    if (wantsFolded(request, folded) === folded) return false
    if (folded) stored.lists.splice(existing, 1)
    else stored.lists.push({ path, text })
    apply()
    // The toggled item is on screen and the user is looking at its arrow: measure it now.
    dirtyGlyphs.delete(item)
    alignListFoldGlyph(item)
    persist()
    return true
  }

  // The fold target at a node: the list item whose own content holds it when that item owns a
  // nested list, otherwise the heading it sits in. Both keep the caret visible when collapsed,
  // because only the item's nested list or the heading's following blocks are hidden.
  const setFoldAt = (node: Node, request: FoldRequest): boolean => {
    const editor = surface()
    if (!editor?.contains(node)) return false
    const element =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement
    const item = element?.closest<HTMLElement>('li')
    if (item && directLists(item).length > 0)
      return setListItemFold(item, request)
    const heading = element?.closest<HTMLElement>('h1, h2, h3, h4, h5, h6')
    if (!heading) return false
    const headings = foldBlocks(editor).filter(
      (block) => foldLevel(block) !== null,
    )
    return setHeadingFold(headings.indexOf(heading), request)
  }

  const controller: SectionFoldController = {
    toggleHeading: (headingIndex) => setHeadingFold(headingIndex, 'toggle'),
    toggleListItem: (item) => setListItemFold(item, 'toggle'),
    toggleAt: (node) => setFoldAt(node, 'toggle'),
    foldAt: (node) => setFoldAt(node, 'fold'),
    unfoldAt: (node) => setFoldAt(node, 'unfold'),
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
    frontMatterFolded: () => stored.frontMatterFolded,
    setFrontMatterFolded(folded: boolean) {
      if (stored.frontMatterFolded === folded) return
      stored.frontMatterFolded = folded
      persist()
    },
    state: () => cloneState(stored),
    apply,
    dispose() {
      if (disposed) return
      disposed = true
      observer.disconnect()
      offFeed()
      glyphObserver?.disconnect()
      nearObserver?.disconnect()
      scheduler.cancel(glyphJob)
      glyphJobQueued = false
      cancelApplyJob()
      dirtyGlyphs.clear()
      nearGlyphs.clear()
      watchedGlyphs.clear()
      window.removeEventListener('resize', scheduleGlyphRefresh)
      document.fonts?.removeEventListener?.('loadingdone', scheduleGlyphRefresh)
      if (frame) cancelAnimationFrame(frame)
      if (glyphFrame) cancelAnimationFrame(glyphFrame)
      if (flushFrame) cancelAnimationFrame(flushFrame)
      cancelPreviewPass()
      // Clean the surface this controller observed, not the one that replaces it: a Preview toggle
      // disposes the edit-surface controller after the Preview pane became the fold surface.
      const editor = initialSurface ?? surface()
      if (editor) {
        clearFoldAttributes(editor)
        for (const item of editor.querySelectorAll<HTMLElement>('li')) {
          item.style.removeProperty(LIST_GLYPH_CENTER_VAR)
          item.style.removeProperty(LIST_ARROW_TOP_VAR)
        }
      }
    },
  }

  // The first slice runs now, so a small Preview is folded before it paints; a large one continues
  // over the next frames.
  if (initialSurface && isPreviewSurface(initialSurface))
    startPreviewPass(initialSurface)
  else apply()
  return controller
}

let activeController: SectionFoldController | undefined

/** Task 724: the front-matter fold of the open document; undefined when none is stored. */
export function storedFrontMatterFold(): boolean | undefined {
  return activeController?.frontMatterFolded()
}

/** Task 724: store the front-matter fold in the document's one fold state. */
export function storeFrontMatterFold(folded: boolean): void {
  activeController?.setFrontMatterFolded(folded)
}

export function ensureFoldTargetVisible(block: Element): boolean {
  return activeController?.ensureBlockVisible(block) ?? false
}

function caretNode(): Node | null {
  const selection = getSelection()
  return selection?.rangeCount ? selection.anchorNode : null
}

export function toggleFoldAtCaret(): boolean {
  const node = caretNode()
  return node ? (activeController?.toggleAt(node) ?? false) : false
}

// Task 580 — the `vmde.fold` / `vmde.unfold` editor actions (boot/main.ts registers them with the
// dispatcher). Like VS Code's editor.fold and editor.unfold they act in one direction only, so a
// repeated Fold leaves the collapsed target collapsed instead of toggling it open again.
export function foldAtCaret(): boolean {
  const node = caretNode()
  return node ? (activeController?.foldAt(node) ?? false) : false
}

export function unfoldAtCaret(): boolean {
  const node = caretNode()
  return node ? (activeController?.unfoldAt(node) ?? false) : false
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
  const surface = () => foldSurface(vditor)
  let controller = createSectionFoldController(vditor, {
    initialState: saved,
    persist,
    surface,
  })
  activeController = controller
  const ensureVisible = (block: Element) => controller.ensureBlockVisible(block)
  ;(
    window as unknown as {
      __vmdeEnsureFoldTargetVisible?: (block: Element) => boolean
    }
  ).__vmdeEnsureFoldTargetVisible = ensureVisible

  let appFrame = 0
  let observedSurface = surface()
  const followSurface = (records: MutationRecord[]) => {
    // Vditor pre-creates mode roots and can reuse them, so an added `.vditor-reset` subtree is not a
    // complete mode signal. Compare the authoritative active surface identity; when it changes,
    // rebuild the controller so its own scoped observer follows the new IR/WYS/Preview root.
    const shouldApply = surface() !== observedSurface
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
      const nextSurface = surface()
      if (!nextSurface || nextSurface === observedSurface) return
      const state = controller.state()
      controller.dispose()
      observedSurface = nextSurface
      controller = createSectionFoldController(vditor, {
        initialState: state,
        persist,
        surface,
      })
      activeController = controller
    })
  }
  const appObserver = new MutationObserver(followSurface)
  const app = document.getElementById('app')
  if (app) appObserver.observe(app, { childList: true, subtree: true })
  // Task 721: turning Preview on or off only changes the Preview pane's inline `display`, which the
  // child-list observer above cannot see; one fold state follows the switch in both directions.
  const previewPane = (vditor as any)?.vditor?.preview?.element
  if (previewPane instanceof HTMLElement)
    appObserver.observe(previewPane, {
      attributes: true,
      attributeFilter: ['style'],
    })

  const onClick = (event: MouseEvent) => {
    const editor = surface()
    const target = event.target instanceof HTMLElement ? event.target : null
    if (!editor || !target || !editor.contains(target)) return
    const foldable = foldableAtClick(target, event)
    if (!foldable) return
    // Task 641: a click can land before the idle measurement; the hit box needs this item's own.
    if (foldable.hasAttribute(LIST_FOLDABLE_ATTR)) alignListFoldGlyph(foldable)
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
  document.addEventListener('click', onClick, true)
  document.addEventListener('selectionchange', onSelectionChange)
  return () => {
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('selectionchange', onSelectionChange)
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
