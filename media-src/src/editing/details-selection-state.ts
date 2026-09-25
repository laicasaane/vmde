// Passive Details button state (Task 574). The button used to map every selection change through
// live text markers and a whole-document serialization. This reads the shared per-revision source
// block index instead: a Range endpoint maps to its block unit, then to a rendered source line by
// counting the unit's DOM line breaks, and the shared resolver/classifier decide the status. Any
// case whose offsets cannot be derived without guessing returns 'unknown'; the controller then runs
// the exact capture once per settled selection. The result is advisory display state only: the
// Details action always captures and validates its source again.

import { pairRenderedSpans, type BlockHandleUnit } from '../nav/block-handle'
import type { SourceBlockIndex } from '../nav/source-block-index'
import {
  buildDetailsSourceIndex,
  classifyDetailsSelection,
  detailsLineAt,
  resolveDetailsBlockRangeIn,
  type DetailsSourceIndex,
} from './details-source'

export type DetailsSelectionState = 'disabled' | 'wrap' | 'unwrap' | 'unknown'

/** DOM line texts of one unit, or null when they cannot be matched to its rendered lines. */
type UnitLines = string[] | null

interface DetailsStateData {
  details: DetailsSourceIndex
  spans: Array<[number, number]> | null
  unitByMember: Map<HTMLElement, number>
  unitLines: Map<number, UnitLines>
}

interface Endpoint {
  unit: number
  /** Line breaks in the unit's DOM text before the boundary. */
  line: number
  /** DOM characters between the last line break and the boundary. */
  column: number
  /** The text at or after the boundary, with the boundary's offset in it. */
  following: { text: Text; offset: number } | null
}

const DATA_SLOT = Symbol('details-selection-state')

function buildData(entry: SourceBlockIndex): DetailsStateData {
  const unitByMember = new Map<HTMLElement, number>()
  for (const [index, unit] of (entry.units ?? []).entries())
    for (const member of unit.members) unitByMember.set(member, index)
  return {
    details: buildDetailsSourceIndex(entry.rendered),
    spans: entry.units ? pairRenderedSpans(entry.rendered, entry.units) : null,
    unitByMember,
    unitLines: new Map(),
  }
}

// Rendered previews (`data-render`) and injected chrome are invisible to Lute, so they are not
// source text either.
function sourceTextWalker(root: Node): TreeWalker {
  return root.ownerDocument!.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_ACCEPT
        const render = (node as Element).getAttribute('data-render')
        return render === '1' || render === '2'
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT
      },
    },
  )
}

// Vditor pads inline code and caret positions with zero-width spaces; Lute drops them on output.
const sourceText = (value: string): string => value.replace(/\u200b/gu, '')

/** A text node contributes its characters; `<br>` is one rendered line break. */
function* sourcePieces(unit: BlockHandleUnit): Generator<Node> {
  for (const member of unit.members) {
    const walker = sourceTextWalker(member)
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (
        node.nodeType === Node.TEXT_NODE ||
        (node as Element).tagName === 'BR'
      )
        yield node
  }
}

function linesOfUnit(unit: BlockHandleUnit): string[] {
  const lines = ['']
  for (const node of sourcePieces(unit)) {
    if (node.nodeType !== Node.TEXT_NODE) {
      lines.push('')
      continue
    }
    const parts = sourceText((node as Text).data).split('\n')
    lines[lines.length - 1] += parts[0]
    for (const part of parts.slice(1)) lines.push(part)
  }
  return lines
}

function unitLines(
  data: DetailsStateData,
  entry: SourceBlockIndex,
  unitIndex: number,
): UnitLines {
  if (data.unitLines.has(unitIndex))
    return data.unitLines.get(unitIndex) ?? null
  const unit = entry.units![unitIndex]
  const span = data.spans![unitIndex]
  const lines = linesOfUnit(unit)
  const renderedBreaks =
    entry.rendered.slice(span[0], span[1]).match(/\r\n|\n|\r/gu)?.length ?? 0
  // Hard breaks, loose list paragraphs, nested lists and marker-only lines break this equality;
  // those units cannot be mapped line-by-line without guessing.
  const matched = lines.length === renderedBreaks + 1 ? lines : null
  data.unitLines.set(unitIndex, matched)
  return matched
}

function unitOf(data: DetailsStateData, root: HTMLElement, node: Node): number {
  for (
    let current: Node | null = node;
    current && current !== root;
    current = current.parentNode
  ) {
    const unit = data.unitByMember.get(current as HTMLElement)
    if (unit !== undefined) return unit
  }
  return -1
}

/** Count DOM line breaks and the column before one boundary point inside a unit. */
function positionInUnit(
  unit: BlockHandleUnit,
  container: Node,
  offset: number,
): Omit<Endpoint, 'unit'> {
  const boundary = container.ownerDocument!.createRange()
  boundary.setStart(container, offset)
  let line = 0
  let column = 0
  for (const node of sourcePieces(unit)) {
    if (node.nodeType !== Node.TEXT_NODE) {
      const parent = node.parentNode!
      const after = Array.prototype.indexOf.call(parent.childNodes, node) + 1
      if (boundary.comparePoint(parent, after) > 0)
        return { line, column, following: null }
      line++
      column = 0
      continue
    }
    const text = node as Text
    if (text !== container && boundary.comparePoint(text, 0) >= 0)
      return { line, column, following: { text, offset: 0 } }
    const before = sourceText(
      text === container ? text.data.slice(0, offset) : text.data,
    )
    const breaks = before.split('\n')
    line += breaks.length - 1
    column = breaks.length > 1 ? breaks.at(-1)!.length : column + before.length
    if (text === container) return { line, column, following: { text, offset } }
  }
  return { line, column, following: null }
}

function coversUnit(range: Range, unit: BlockHandleUnit): boolean {
  const last = unit.members.at(-1)!
  const contents = range.startContainer.ownerDocument!.createRange()
  contents.selectNodeContents(unit.members[0])
  contents.setEnd(last, last.childNodes.length)
  return (
    range.compareBoundaryPoints(Range.START_TO_START, contents) <= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, contents) >= 0
  )
}

const LINE_ROLE_TABLE = /\|/u

interface MappedOffset {
  offset: number
  /** False when inline markup hides source characters, so only the line is certain. */
  exact: boolean
}

/**
 * Rendered source offset for one endpoint of a non-atomic unit, or null when it cannot be derived.
 * Only the line matters to the resolver, except that an end boundary at the very start of a line
 * belongs to the previous line (`lineForOffset(end - 1)`); that needs the line's source prefix
 * (list/quote markers) that the DOM omits.
 */
const BLOCK_TEXT_PARENT = new Set([
  'P',
  'LI',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
])
const BLOCK_PREFIX = /^(?:\s*(?:[-+*]|\d+[.)])\s+|\s*>\s?|#{1,6}\s+)+$/u

/**
 * Exact offset for an end boundary at the start of a DOM line whose inline markup hides source
 * characters. The marker path inserts at the boundary, so the offset is the line start plus any
 * list/quote/heading prefix, provided the next text is directly inside the block (not inside
 * inline markup, whose source delimiters would come first).
 */
function lineStartOffset(
  sourceLine: { text: string; start: number },
  following: Endpoint['following'],
): MappedOffset | null {
  if (
    !following ||
    !BLOCK_TEXT_PARENT.has(following.text.parentElement?.tagName ?? '')
  )
    return null
  const lead = sourceText(following.text.data.slice(following.offset)).split(
    '\n',
  )[0]
  if (!lead) return null
  const at = sourceLine.text.indexOf(lead)
  if (at === 0) return { offset: sourceLine.start, exact: true }
  return at > 0 && BLOCK_PREFIX.test(sourceLine.text.slice(0, at))
    ? { offset: sourceLine.start + at, exact: true }
    : null
}

function lineOffset(
  data: DetailsStateData,
  entry: SourceBlockIndex,
  unitIndex: number,
  position: Omit<Endpoint, 'unit'>,
  edge: 'start' | 'end',
): MappedOffset | null {
  const lines = unitLines(data, entry, unitIndex)
  if (!lines) return null
  const { details } = data
  const span = data.spans![unitIndex]
  const sourceLine =
    details.lines[detailsLineAt(details, span[0]) + position.line]
  const domLine = lines[position.line]
  if (!sourceLine || domLine === undefined) return null
  // A pipe makes the resolver treat the line as a table row, where the exact column matters.
  if (LINE_ROLE_TABLE.test(sourceLine.text)) return null
  const length = sourceLine.end - sourceLine.start
  if (length === 0) return null
  // WYSIWYG hides inline markers, so the DOM line is not the source line; the line is still right,
  // but the column is only approximate.
  if (!domLine || !sourceLine.text.endsWith(domLine))
    return position.column === 0 && edge === 'end'
      ? lineStartOffset(sourceLine, position.following)
      : {
          offset: sourceLine.start + Math.min(position.column, length),
          exact: false,
        }
  const prefix = length - domLine.length
  const column = Math.min(prefix + position.column, length)
  return { offset: sourceLine.start + column, exact: true }
}

function endpointOffset(
  data: DetailsStateData,
  entry: SourceBlockIndex,
  range: Range,
  endpoint: Endpoint,
  edge: 'start' | 'end',
): MappedOffset | 'disabled' | null {
  const unit = entry.units![endpoint.unit]
  const span = data.spans![endpoint.unit]
  if (unit.kind === 'html' || unit.kind === 'html-group') return null
  if (unit.kind === 'fence' || unit.kind === 'table') {
    // A fully covered fence or table uses its whole span.
    if (coversUnit(range, unit))
      return { offset: edge === 'start' ? span[0] : span[1], exact: true }
    // At the unit's first or last DOM text position the source side is not derivable: IR shows
    // fence markers as text while WYSIWYG hides them, so the same DOM point can lie inside or
    // outside the fence source.
    const lines = linesOfUnit(unit)
    const atOuterEdge =
      (endpoint.line === 0 && endpoint.column === 0) ||
      (endpoint.line === lines.length - 1 &&
        endpoint.column === lines.at(-1)!.length)
    // Strictly inside, it is a partial fence or table, which the resolver rejects.
    return atOuterEdge ? null : 'disabled'
  }
  if (
    data.details.fences.some(([open, close]) => {
      const lines = data.details.lines
      return lines[open].start < span[1] && lines[close].end > span[0]
    })
  )
    return null
  return lineOffset(data, entry, endpoint.unit, endpoint, edge)
}

function readEndpoint(
  data: DetailsStateData,
  root: HTMLElement,
  entry: SourceBlockIndex,
  container: Node,
  offset: number,
): Endpoint | null {
  // Element-container boundaries (the root between blocks, or a block's own start/end) are where
  // the exact marker capture itself fails; native drags and Shift+Arrow produce text positions.
  // A boundary inside IR's editable `# ` heading marker likewise changes how Lute serializes the
  // heading. The exact capture decides these cases.
  if (
    container.nodeType !== Node.TEXT_NODE ||
    container.parentElement?.closest('[data-type="heading-marker"]')
  )
    return null
  const unit = unitOf(data, root, container)
  if (unit < 0) return null
  return { unit, ...positionInUnit(entry.units![unit], container, offset) }
}

/** Rendered source offsets for a Range, or the state that ends mapping early. */
function sourceOffsets(
  entry: SourceBlockIndex,
  data: DetailsStateData,
  range: Range,
): [number, number] | 'disabled' | 'unknown' {
  const root = entry.key.root
  const start = readEndpoint(
    data,
    root,
    entry,
    range.startContainer,
    range.startOffset,
  )
  const end = readEndpoint(
    data,
    root,
    entry,
    range.endContainer,
    range.endOffset,
  )
  if (!start || !end) return 'unknown'
  const startOffset = endpointOffset(data, entry, range, start, 'start')
  const endOffset = endpointOffset(data, entry, range, end, 'end')
  if (startOffset === 'disabled' || endOffset === 'disabled') return 'disabled'
  if (startOffset === null || endOffset === null) return 'unknown'
  // The marker path rejects an empty source range; only exact columns can prove one is empty.
  if (startOffset.offset === endOffset.offset)
    return startOffset.exact && endOffset.exact ? 'disabled' : 'unknown'
  if (startOffset.offset > endOffset.offset) return 'unknown'
  return [startOffset.offset, endOffset.offset]
}

/** Advisory Details state for a live Range from the warm source index; never serializes. */
export function readDetailsSelectionState(
  entry: SourceBlockIndex,
  range: Range,
): DetailsSelectionState {
  const root = entry.key.root
  if (
    range.collapsed ||
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    return 'disabled'
  if (!entry.units) return 'unknown'
  const data = entry.memo(DATA_SLOT, buildData)
  if (!data.spans) return 'unknown'
  const offsets = sourceOffsets(entry, data, range)
  if (typeof offsets === 'string') return offsets
  const resolved = resolveDetailsBlockRangeIn(data.details, ...offsets)
  return resolved
    ? classifyDetailsSelection(
        data.details,
        resolved.startOffset,
        resolved.endOffset,
      )
    : 'disabled'
}
