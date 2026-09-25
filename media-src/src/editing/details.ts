// `<details>/<summary>` edit-mode decorator (Task 257).
//
// Lute emits the opening HTML block, Markdown body blocks, and closing HTML block as siblings in
// IR/WYSIWYG. Pair those source blocks, add one serializer-invisible semantic toggle to the opening
// block, and project visual state through attributes on the existing siblings. No authored block is
// wrapped or moved.

import { observeScopedMutations } from '../util/mutation-impact'

const HTML_BLOCK = '[data-type="html-block"]'
const TOGGLE_CLASS = 'vmde-details__toggle'
const START_ATTR = 'data-vmde-details-start'
const END_ATTR = 'data-vmde-details-end'
const HIDDEN_ATTR = 'data-vmde-details-hidden'
const EDITING_ATTR = 'data-vmde-details-editing'
const OPEN_ATTR = 'data-vmde-details-open'
const RAW_HTML_ELEMENT = new Set(['script', 'pre', 'style', 'textarea'])

export interface DetailsBlockPair {
  start: HTMLElement
  end: HTMLElement
  summary: string
  defaultOpen: boolean
}

export interface DetailsController {
  refresh(): void
  apply(): void
  applyWithin(block: Element): void
  dispose(): void
}

interface OpenDetails {
  start: HTMLElement
  defaultOpen: boolean
}

export interface DetailsTag {
  kind: 'open' | 'close'
  attrs: string
  start: number
  end: number
}

interface ScannedHtmlTag {
  nextIndex: number
  details?: DetailsTag
}

function sourceOf(block: Element): string {
  return block.querySelector('pre code')?.textContent ?? ''
}

function editSurfaces(root: HTMLElement): HTMLElement[] {
  const selector = '.vditor-ir > .vditor-reset, .vditor-wysiwyg > .vditor-reset'
  const surfaces = root.matches('.vditor-reset') ? [root] : []
  surfaces.push(...Array.from(root.querySelectorAll<HTMLElement>(selector)))
  return surfaces
}

function detailsOpen(attrs: string): boolean {
  return /(?:^|[\t\n\f\r ])open(?:[\t\n\f\r ]*=|[\t\n\f\r ]|$)/iu.test(attrs)
}

function tagEnd(source: string, start: number): number {
  let quote = ''
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index]
    if (quote) {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '>') return index
  }
  return -1
}

function protectedEnd(source: string, start: number): number | null {
  const lower = source.toLowerCase()
  const delimited: Array<[string, string]> = [
    ['<!--', '-->'],
    ['<![cdata[', ']]>'],
    ['<?', '?>'],
  ]
  for (const [opening, closing] of delimited) {
    if (!lower.startsWith(opening, start)) continue
    const end = lower.indexOf(closing, start + opening.length)
    return end < 0 ? source.length : end + closing.length
  }
  if (lower.startsWith('<!', start)) {
    const end = tagEnd(source, start)
    return end < 0 ? source.length : end + 1
  }
  return null
}

function rawElementClose(lower: string, name: string, from: number): number {
  const marker = `</${name}`
  for (let index = lower.indexOf(marker, from); index >= 0; ) {
    const boundary = lower[index + marker.length]
    if (boundary === '>' || /[\t\n\f\r ]/u.test(boundary)) return index
    index = lower.indexOf(marker, index + marker.length)
  }
  return -1
}

function scanHtmlTag(
  source: string,
  lower: string,
  start: number,
): ScannedHtmlTag {
  const protectedUntil = protectedEnd(source, start)
  if (protectedUntil !== null) return { nextIndex: protectedUntil }
  const end = tagEnd(source, start)
  if (end < 0) return { nextIndex: source.length }
  const raw = source.slice(start, end + 1)
  const match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9-]*)([\s\S]*?)>$/u.exec(raw)
  if (!match) return { nextIndex: end + 1 }
  const closing = match[1] === '/'
  const name = match[2].toLowerCase()
  if (!closing && RAW_HTML_ELEMENT.has(name)) {
    const rawClose = rawElementClose(lower, name, end + 1)
    if (rawClose < 0) return { nextIndex: source.length }
    const rawEnd = tagEnd(source, rawClose)
    return { nextIndex: rawEnd < 0 ? source.length : rawEnd + 1 }
  }
  return {
    nextIndex: end + 1,
    ...(name === 'details'
      ? {
          details: {
            kind: closing ? 'close' : 'open',
            attrs: match[3],
            start,
            end: end + 1,
          },
        }
      : {}),
  }
}

function detailsTags(source: string): DetailsTag[] {
  const tags: DetailsTag[] = []
  const lower = source.toLowerCase()
  for (let index = 0; index < source.length; ) {
    const start = source.indexOf('<', index)
    if (start < 0) break
    const scanned = scanHtmlTag(source, lower, start)
    if (scanned.details) tags.push(scanned.details)
    index = scanned.nextIndex
  }
  return tags
}

export interface DetailsSelectionTransformInput {
  markdown: string
  startOffset: number
  endOffset: number
  resolved: boolean
}

export type DetailsSelectionTransformResult = {
  status: 'wrap' | 'unwrap' | 'disabled'
  markdown: string
  startOffset: number
  endOffset: number
}

export interface SourceDetailsPair {
  open: DetailsTag
  close: DetailsTag
  summaryEnd: number | null
}

function maskFencedMarkdown(markdown: string): string {
  let fence: { marker: string; length: number } | null = null
  return markdown.replace(/[^\r\n]*(?:\r\n|\n|\r|$)/gu, (line) => {
    const text = line.replace(/(?:\r\n|\n|\r)$/u, '')
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(text)?.[1]
    const protectedLine = Boolean(fence || marker)
    if (marker) {
      if (!fence) fence = { marker: marker[0], length: marker.length }
      else if (
        marker[0] === fence.marker &&
        marker.length >= fence.length &&
        text.slice(text.indexOf(marker) + marker.length).trim() === ''
      )
        fence = null
    }
    return protectedLine ? line.replace(/[^\r\n]/gu, ' ') : line
  })
}

/** Pair source `<details>` tags outside fenced code; unmatched tags stay in `tags` only. */
export function sourceDetailsPairs(markdown: string): {
  pairs: SourceDetailsPair[]
  tags: DetailsTag[]
} {
  const tags = detailsTags(maskFencedMarkdown(markdown))
  const stack: DetailsTag[] = []
  const pairs: SourceDetailsPair[] = []
  for (const tag of tags) {
    if (tag.kind === 'open') {
      stack.push(tag)
      continue
    }
    const open = stack.pop()
    if (!open) continue
    const between = markdown.slice(open.end, tag.start)
    const summary = /^[\t \r\n]*<summary\b[^>]*>[\s\S]*?<\/summary\s*>/iu.exec(
      between,
    )
    pairs.push({
      open,
      close: tag,
      summaryEnd: summary ? open.end + summary[0].length : null,
    })
  }
  return { pairs, tags }
}

function boundaryWhitespace(value: string, minimumBreaks: number): boolean {
  return (
    /^[\t \r\n]*$/u.test(value) &&
    (value.match(/\r\n|\n|\r/gu)?.length ?? 0) >= minimumBreaks
  )
}

function selectionHasBalancedDetails(
  tags: readonly DetailsTag[],
  start: number,
  end: number,
): boolean {
  let depth = 0
  for (const tag of tags) {
    if (tag.start < start || tag.end > end) continue
    depth += tag.kind === 'open' ? 1 : -1
    if (depth < 0) return false
  }
  return depth === 0
}

/** Status rules shared by the transform and the passive classifier (Task 574), so the admission
 * rules exist once. `immediate` is the innermost pair whose whole body is the selection. */
export function detailsSelectionStatus(
  markdown: string,
  tags: readonly DetailsTag[],
  pairs: readonly SourceDetailsPair[],
  startOffset: number,
  endOffset: number,
): { status: 'wrap' | 'unwrap' | 'disabled'; immediate?: SourceDetailsPair } {
  if (startOffset >= endOffset) return { status: 'disabled' }
  if (!selectionHasBalancedDetails(tags, startOffset, endOffset))
    return { status: 'disabled' }
  const immediate = pairs
    .filter(
      ({ open, close, summaryEnd }) =>
        summaryEnd !== null &&
        open.start <= startOffset &&
        close.end >= endOffset &&
        boundaryWhitespace(markdown.slice(summaryEnd, startOffset), 2) &&
        boundaryWhitespace(markdown.slice(endOffset, close.start), 1),
    )
    .sort((a, b) => b.open.start - a.open.start)[0]
  return immediate ? { status: 'unwrap', immediate } : { status: 'wrap' }
}

/** Exact source transform for Task 533 after a mode adapter resolved complete contiguous blocks. */
export function transformDetailsSelection({
  markdown,
  startOffset,
  endOffset,
  resolved,
}: DetailsSelectionTransformInput): DetailsSelectionTransformResult {
  const unchanged = (): DetailsSelectionTransformResult => ({
    status: 'disabled',
    markdown,
    startOffset,
    endOffset,
  })
  if (!resolved || startOffset >= endOffset) return unchanged()
  const { pairs, tags } = sourceDetailsPairs(markdown)
  const { status, immediate } = detailsSelectionStatus(
    markdown,
    tags,
    pairs,
    startOffset,
    endOffset,
  )
  if (status === 'disabled') return unchanged()
  const body = markdown.slice(startOffset, endOffset)
  if (immediate) {
    const next =
      markdown.slice(0, immediate.open.start) +
      body +
      markdown.slice(immediate.close.end)
    return {
      status: 'unwrap',
      markdown: next,
      startOffset: immediate.open.start,
      endOffset: immediate.open.start + body.length,
    }
  }

  const eol = markdown.includes('\r\n') ? '\r\n' : '\n'
  const prefix = `<details>${eol}<summary>Details</summary>${eol}${eol}`
  const suffix = `${body.endsWith(eol) ? eol : eol + eol}</details>`
  const next =
    markdown.slice(0, startOffset) +
    prefix +
    body +
    suffix +
    markdown.slice(endOffset)
  return {
    status: 'wrap',
    markdown: next,
    startOffset: startOffset + prefix.length,
    endOffset: startOffset + prefix.length + body.length,
  }
}

function sourceBetween(start: HTMLElement, end: HTMLElement): string {
  const source: string[] = []
  for (
    let block: Element | null = start;
    block;
    block = block.nextElementSibling
  ) {
    if (block.matches(HTML_BLOCK)) source.push(sourceOf(block))
    if (block === end) break
  }
  return source.join('\n')
}

function summaryText(start: HTMLElement, end: HTMLElement): string {
  const template = start.ownerDocument.createElement('template')
  template.innerHTML = sourceBetween(start, end)
  return (
    template.content.querySelector('details > summary')?.textContent?.trim() ||
    'Details'
  )
}

/** Pair opening and closing details HTML blocks within each live edit surface. */
export function pairDetailsBlocks(root: HTMLElement): DetailsBlockPair[] {
  const pairsByStart = new Map<HTMLElement, DetailsBlockPair>()
  for (const surface of editSurfaces(root)) {
    const stack: OpenDetails[] = []
    for (const block of Array.from(
      surface.querySelectorAll<HTMLElement>(`:scope > ${HTML_BLOCK}`),
    )) {
      const source = sourceOf(block)
      for (const tag of detailsTags(source)) {
        if (tag.kind === 'open') {
          stack.push({ start: block, defaultOpen: detailsOpen(tag.attrs) })
          continue
        }
        const opened = stack.pop()
        if (
          !opened ||
          opened.start === block ||
          opened.start.parentElement !== block.parentElement
        )
          continue
        // Lute coalesces consecutive nested openings into one HTML block. One DOM block cannot own
        // two independent buttons/states, so keep the later-popped outer pair for that shared start.
        pairsByStart.set(opened.start, {
          ...opened,
          end: block,
          summary: summaryText(opened.start, block),
        })
      }
    }
  }
  return Array.from(pairsByStart.values())
}

function siblingsBetween(pair: DetailsBlockPair): HTMLElement[] {
  const siblings: HTMLElement[] = []
  for (
    let block = pair.start.nextElementSibling as HTMLElement | null;
    block && block !== pair.end;
    block = block.nextElementSibling as HTMLElement | null
  )
    siblings.push(block)
  return siblings
}

function blockFallsWithin(pair: DetailsBlockPair, block: Element): boolean {
  return Boolean(
    pair.start.compareDocumentPosition(block) &
      Node.DOCUMENT_POSITION_FOLLOWING &&
      block.compareDocumentPosition(pair.end) &
        Node.DOCUMENT_POSITION_FOLLOWING,
  )
}

function buildOwnerIndex(
  root: HTMLElement,
  pairs: readonly DetailsBlockPair[],
): {
  ownersByBlock: WeakMap<Element, DetailsBlockPair[]>
  pairsByParent: WeakMap<Element, DetailsBlockPair[]>
} {
  const ownersByBlock = new WeakMap<Element, DetailsBlockPair[]>()
  const pairsByParent = new WeakMap<Element, DetailsBlockPair[]>()
  const addOwner = (block: Element, pair: DetailsBlockPair) => {
    const owners = ownersByBlock.get(block) ?? []
    owners.push(pair)
    ownersByBlock.set(block, owners)
  }
  for (const surface of editSurfaces(root))
    for (const block of Array.from(surface.children))
      ownersByBlock.set(block, [])
  for (const pair of pairs) {
    addOwner(pair.start, pair)
    addOwner(pair.end, pair)
    const parent = pair.start.parentElement
    if (parent) {
      const parentPairs = pairsByParent.get(parent) ?? []
      parentPairs.push(pair)
      pairsByParent.set(parent, parentPairs)
    }
    for (const block of siblingsBetween(pair)) addOwner(block, pair)
  }
  return { ownersByBlock, pairsByParent }
}

function topLevelEditBlock(root: HTMLElement, node: Node): Element | null {
  let element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const surface = element?.closest('.vditor-reset')
  if (!element || !surface || !root.contains(surface)) return null
  while (element.parentElement && element.parentElement !== surface)
    element = element.parentElement
  return element.parentElement === surface ? element : null
}

function clearProjection(elements: Iterable<HTMLElement>): void {
  for (const element of elements) {
    element.removeAttribute(START_ATTR)
    element.removeAttribute(END_ATTR)
    element.removeAttribute(HIDDEN_ATTR)
    element.removeAttribute(EDITING_ATTR)
    element.removeAttribute(OPEN_ATTR)
  }
}

function ensureToggle(pair: DetailsBlockPair): HTMLButtonElement {
  let button = pair.start.querySelector<HTMLButtonElement>(
    `:scope > .${TOGGLE_CLASS}`,
  )
  if (!button) {
    button = pair.start.ownerDocument.createElement('button')
    button.type = 'button'
    button.className = TOGGLE_CLASS
    button.dataset.render = '1'
    button.contentEditable = 'false'
    const chevron = pair.start.ownerDocument.createElement('span')
    chevron.className = 'vmde-details__chevron'
    chevron.setAttribute('aria-hidden', 'true')
    const label = pair.start.ownerDocument.createElement('span')
    label.className = 'vmde-details__label'
    button.append(chevron, label)
    pair.start.appendChild(button)
  }
  const label = button.querySelector<HTMLElement>('.vmde-details__label')
  if (label) label.textContent = pair.summary
  return button
}

function projectPair(
  pair: DetailsBlockPair,
  editing: DetailsBlockPair | null,
  open: boolean,
  projected: Set<HTMLElement>,
): void {
  projected.add(pair.start)
  projected.add(pair.end)
  pair.start.setAttribute(START_ATTR, '')
  pair.end.setAttribute(END_ATTR, '')
  pair.start.toggleAttribute(OPEN_ATTR, open)
  ensureToggle(pair).setAttribute('aria-expanded', String(open))
  if (pair === editing) {
    pair.start.setAttribute(EDITING_ATTR, '')
    pair.end.setAttribute(EDITING_ATTR, '')
    return
  }
  pair.end.setAttribute(HIDDEN_ATTR, '')
  if (!open)
    for (const block of siblingsBetween(pair)) {
      block.setAttribute(HIDDEN_ATTR, '')
      projected.add(block)
    }
}

function removeStaleToggles(
  root: HTMLElement,
  starts: ReadonlySet<HTMLElement>,
): void {
  for (const button of Array.from(
    root.querySelectorAll<HTMLElement>(`.${TOGGLE_CLASS}`),
  ))
    if (!button.parentElement || !starts.has(button.parentElement))
      button.remove()
}

function initializeOpenStates(
  pairs: readonly DetailsBlockPair[],
  states: WeakMap<HTMLElement, boolean>,
): void {
  for (const pair of pairs)
    if (!states.has(pair.start)) states.set(pair.start, pair.defaultOpen)
}

/** Create the synchronous controller used by unit tests and the production observer. */
export function createDetailsController(root: HTMLElement): DetailsController {
  const openState = new WeakMap<HTMLElement, boolean>()
  let pairs: DetailsBlockPair[] = []
  let editingStart: HTMLElement | null = null
  let disposed = false
  const projected = new Set<HTMLElement>()
  let ownersByBlock = new WeakMap<Element, DetailsBlockPair[]>()
  let pairsByParent = new WeakMap<Element, DetailsBlockPair[]>()

  const apply = () => {
    if (disposed) return
    clearProjection(projected)
    projected.clear()
    const editing = pairs.find((pair) => pair.start === editingStart) ?? null
    for (const pair of pairs)
      projectPair(
        pair,
        editing,
        openState.get(pair.start) ?? pair.defaultOpen,
        projected,
      )
  }

  const refresh = () => {
    if (disposed) return
    const next = pairDetailsBlocks(root)
    const starts = new Set(next.map((pair) => pair.start))
    removeStaleToggles(root, starts)
    pairs = next
    ;({ ownersByBlock, pairsByParent } = buildOwnerIndex(root, pairs))
    if (editingStart && !starts.has(editingStart)) editingStart = null
    initializeOpenStates(pairs, openState)
    apply()
  }

  const ownersForBlock = (block: Element | null): DetailsBlockPair[] => {
    if (!block) return []
    let owners = ownersByBlock.get(block)
    if (!owners) {
      owners = (pairsByParent.get(block.parentElement as Element) ?? []).filter(
        (pair) => blockFallsWithin(pair, block),
      )
      ownersByBlock.set(block, owners)
    }
    return owners
  }

  const applyWithin = (block: Element) => {
    const editing = pairs.find((pair) => pair.start === editingStart) ?? null
    const owners = ownersForBlock(block)
    if (owners.length === 0) return
    const element = block as HTMLElement
    element.removeAttribute(HIDDEN_ATTR)
    const hidden = owners.some(
      (pair) =>
        pair !== editing && !(openState.get(pair.start) ?? pair.defaultOpen),
    )
    if (hidden) {
      element.setAttribute(HIDDEN_ATTR, '')
      projected.add(element)
    }
  }

  const toggleButton = (button: HTMLButtonElement) => {
    const pair = pairs.find(
      (candidate) => candidate.start === button.parentElement,
    )
    if (!pair) return
    editingStart = null
    openState.set(pair.start, !(openState.get(pair.start) ?? pair.defaultOpen))
    apply()
  }
  const buttonFromEvent = (event: Event): HTMLButtonElement | null => {
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest<HTMLButtonElement>(`.${TOGGLE_CLASS}`)
    return button && root.contains(button) ? button : null
  }
  const onClick = (event: Event) => {
    const button = buttonFromEvent(event)
    if (button) toggleButton(button)
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const button = buttonFromEvent(event)
    if (!button) return
    event.preventDefault()
    event.stopImmediatePropagation()
    toggleButton(button)
  }
  const onSelectionChange = () => {
    const doc = root.ownerDocument
    const selection = doc.getSelection()
    const anchor = selection?.rangeCount ? selection.anchorNode : null
    const toggleFocused = doc.activeElement?.closest(`.${TOGGLE_CLASS}`)
    const block =
      anchor && root.contains(anchor) ? topLevelEditBlock(root, anchor) : null
    const next = !toggleFocused
      ? (ownersForBlock(block)[0]?.start ?? null)
      : null
    if (next === editingStart) return
    editingStart = next
    apply()
  }

  root.addEventListener('click', onClick)
  root.addEventListener('keydown', onKeydown, true)
  root.ownerDocument.addEventListener('selectionchange', onSelectionChange)
  refresh()
  return {
    refresh,
    apply,
    applyWithin,
    dispose() {
      if (disposed) return
      root.removeEventListener('click', onClick)
      root.removeEventListener('keydown', onKeydown, true)
      root.ownerDocument.removeEventListener(
        'selectionchange',
        onSelectionChange,
      )
      clearProjection(projected)
      projected.clear()
      for (const button of Array.from(
        root.querySelectorAll(`.${TOGGLE_CLASS}`),
      ))
        button.remove()
      pairs = []
      disposed = true
    },
  }
}

/** Keep details chrome attached across Vditor block spins and mode rebuilds. */
export function observeDetails(
  root: HTMLElement | null | undefined,
): () => void {
  if (!root) return () => undefined
  const controller = createDetailsController(root)
  const disposeObserver = observeScopedMutations(root, {
    full: () => controller.refresh(),
    within: (block) => {
      if (block.matches(HTML_BLOCK) || block.querySelector(HTML_BLOCK))
        controller.refresh()
      else controller.applyWithin(block)
    },
  })
  return () => {
    disposeObserver()
    controller.dispose()
  }
}
