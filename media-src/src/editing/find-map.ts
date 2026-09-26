// Task 196 rework — map exact-source Find matches to DOM ranges lazily, one block at a time.
// IR/WYSIWYG: the shared source block index already pairs each movable block with its exact
// source span. A block is serialized once (a detached clone with sentinels at text boundaries,
// one small Lute call), then aligned to its exact slice. SV: one alignment of the exact source
// with the SV text. Every range is verified against the exact match text; anything else is
// unmappable and never approximated. The old whole-editor clone-and-serialize probe is gone.
import type {
  BlockHandleUnit,
  SourceBlockIndex,
} from '../nav/source-block-index'
import {
  currentBlockProjection,
  resolveBlockHandleUnits,
} from '../nav/block-handle'
import { alignText, type OffsetAlignment } from './find-align'
import type { MarkdownMatch } from './find-engine'
import type { FindSource } from './find-source'

interface SourcePoint {
  node: Text
  offset: number
}

export interface FindMapper {
  /** A DOM range whose text equals the exact match, or null when the match is not visible. */
  range(match: MarkdownMatch): Range | null
  /** Indexes of matches within `margin` px of the visible box, ascending. */
  visible(
    matches: readonly MarkdownMatch[],
    box: VisibleBox,
    margin: number,
  ): number[]
}

/** The editor's visible vertical extent in viewport coordinates. */
export interface VisibleBox {
  top: number
  bottom: number
}

function isSerializableFindText(node: Text): boolean {
  const parent = node.parentElement
  return !parent?.closest(
    '.vditor-ir__marker, .vditor-ir__preview [data-render], .vditor-copy, svg, textarea, wbr, [contenteditable="false"]',
  )
}

function isCodePointBoundary(text: string, offset: number): boolean {
  return !(
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1] ?? '') &&
    /[\uDC00-\uDFFF]/.test(text[offset] ?? '')
  )
}

function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node instanceof Text) nodes.push(node)
  return nodes
}

function verifiedRange(
  start: SourcePoint | undefined,
  end: SourcePoint | undefined,
  text: string,
): Range | null {
  if (!start || !end || !start.node.isConnected || !end.node.isConnected)
    return null
  try {
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    return range.toString() === text ? range : null
  } catch {
    return null
  }
}

function rangeInText(root: Node, start: number, end: number): Range | null {
  let offset = 0
  let first: SourcePoint | undefined
  for (const node of textNodes(root)) {
    const next = offset + node.data.length
    if (!first && start >= offset && start <= next)
      first = { node, offset: start - offset }
    if (end >= offset && end <= next)
      return verifiedRange(
        first,
        { node, offset: end - offset },
        (root.textContent ?? '').slice(start, end),
      )
    offset = next
  }
  return null
}

interface SourceRegion {
  start: number
  end: number
}

function fencedBodies(markdown: string): SourceRegion[] {
  const out: SourceRegion[] = []
  const pattern = /(^|\n) {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/g
  for (const open of markdown.matchAll(pattern)) {
    const marker = open[2]!
    const start = open.index! + open[0].length
    const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`, 'm')
    const found = close.exec(markdown.slice(start))
    if (found) out.push({ start, end: start + found.index })
  }
  return out
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: preserves exact GFM cell offsets while distinguishing escaped separators and delimiter rows.
function tableCellRegions(markdown: string): SourceRegion[] {
  const out: SourceRegion[] = []
  let offset = 0
  for (const line of markdown.split('\n')) {
    const delimiter =
      /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line)
    if (delimiter || !line.includes('|')) {
      offset += line.length + 1
      continue
    }
    let cellStart = line.startsWith('|') ? 1 : 0
    let escaped = false
    for (let index = cellStart; index <= line.length; index++) {
      const pipe = line[index] === '|' && !escaped
      if (pipe || index === line.length) {
        if (index === line.length && cellStart === line.length) break
        const raw = line.slice(cellStart, index)
        const leading = raw.length - raw.trimStart().length
        const trailing = raw.length - raw.trimEnd().length
        out.push({
          start: offset + cellStart + leading,
          end: offset + index - trailing,
        })
        cellStart = index + 1
      }
      escaped = line[index] === '\\' && !escaped
      if (line[index] !== '\\') escaped = false
    }
    offset += line.length + 1
  }
  return out
}

function fenceRange(
  element: HTMLElement,
  slice: string,
  start: number,
  end: number,
): Range | null {
  const codeBlocks = Array.from(
    element.querySelectorAll<HTMLElement>(
      '.vditor-ir__preview code, .vditor-wysiwyg__pre code',
    ),
  )
  for (const [index, body] of fencedBodies(slice).entries()) {
    if (start < body.start || end > body.end) continue
    const code = codeBlocks[index]
    if (code?.textContent === slice.slice(body.start, body.end))
      return rangeInText(code, start - body.start, end - body.start)
  }
  return null
}

function cellRange(
  element: HTMLElement,
  slice: string,
  start: number,
  end: number,
): Range | null {
  const cells = Array.from(element.querySelectorAll<HTMLElement>('td, th'))
  for (const [index, cell] of tableCellRegions(slice).entries()) {
    if (start < cell.start || end > cell.end) continue
    const target = cells[index]
    if (target?.textContent === slice.slice(cell.start, cell.end))
      return rangeInText(target, start - cell.start, end - cell.start)
  }
  return null
}

/** Fenced code and table cells show their source text in dedicated elements; match them by
 * region within this one block (formerly a whole-document scan per unmapped match). */
function regionRange(
  element: HTMLElement,
  slice: string,
  start: number,
  end: number,
): Range | null {
  const text = slice.slice(start, end)
  const range =
    fenceRange(element, slice, start, end) ??
    cellRange(element, slice, start, end)
  return range?.toString() === text ? range : null
}

interface BlockMap {
  rendered: string
  points: Map<number, SourcePoint>
  alignment: OffsetAlignment
}

function uniqueSentinel(...texts: string[]): string {
  let sentinel = ''
  while (texts.some((text) => text.includes(sentinel))) sentinel += ''
  return sentinel
}

/** A clone of `member` with a sentinel at every code-point boundary of each serializable text
 * node; `boundaries` receives the matching live DOM points in order. */
function markedClone(
  member: HTMLElement,
  sentinel: string,
  boundaries: SourcePoint[],
): HTMLElement {
  const clone = member.cloneNode(true) as HTMLElement
  const copies = textNodes(clone)
  for (const [index, original] of textNodes(member).entries()) {
    const copy = copies[index]
    if (!copy || !isSerializableFindText(original)) continue
    let marked = ''
    for (let offset = 0; offset <= original.data.length; offset++) {
      if (isCodePointBoundary(original.data, offset)) {
        boundaries.push({ node: original, offset })
        marked += sentinel
      }
      if (offset < original.data.length) marked += original.data[offset]
    }
    copy.data = marked
  }
  return clone
}

/** Marked clones of the unit's members; list items keep a copy of their list wrapper so Lute
 * serializes them as list items. */
function markedMembersHtml(
  members: readonly HTMLElement[],
  sentinel: string,
  boundaries: SourcePoint[],
): string {
  const pieces: string[] = []
  let list: HTMLElement | null = null
  let listOwner: HTMLElement | null = null
  const flush = () => {
    if (list) pieces.push(list.outerHTML)
    list = null
    listOwner = null
  }
  for (const member of members) {
    const clone = markedClone(member, sentinel, boundaries)
    const parent = member.parentElement
    if (
      member.tagName !== 'LI' ||
      !parent ||
      !/^(UL|OL)$/u.test(parent.tagName)
    ) {
      flush()
      pieces.push(clone.outerHTML)
      continue
    }
    if (listOwner !== parent) {
      flush()
      listOwner = parent
      list = parent.cloneNode(false) as HTMLElement
    }
    list?.append(clone)
  }
  flush()
  return pieces.join('')
}

function blockMap(unit: BlockHandleUnit, slice: string): BlockMap | null {
  const proof = currentBlockProjection()
  if (!proof) return null
  const boundaries: SourcePoint[] = []
  const sentinel = uniqueSentinel(
    slice,
    ...unit.members.map((member) => member.textContent ?? ''),
  )
  let serialized: string
  try {
    serialized = proof.serialize(
      markedMembersHtml(unit.members, sentinel, boundaries),
    )
  } catch {
    return null
  }
  const points = new Map<number, SourcePoint>()
  const pieces = serialized.split(sentinel)
  if (pieces.length - 1 !== boundaries.length) return null
  let rendered = ''
  for (const [index, piece] of pieces.entries()) {
    rendered += piece
    const point = boundaries[index]
    if (point && !points.has(rendered.length))
      points.set(rendered.length, point)
  }
  return { rendered, points, alignment: alignText(slice, rendered) }
}

const RENDERED_PLAN = Symbol('find rendered plan')
const BLOCK_MAPS = Symbol('find block maps')

/** Rendered-text blocks for one index entry plus the exact → rendered document alignment. */
interface RenderedPlan {
  units: BlockHandleUnit[]
  alignment: OffsetAlignment
}

/** Task 196 (feedback pass): the shared index resolves units against the EXACT bytes, which is
 * rejected when Vditor normalizes the document (the large fixture: exact 174,517 vs rendered
 * 181,855 bytes, so `entry.units` is null). Find maps through the entry's RENDERED text instead:
 * its blocks pair one-to-one with the live DOM (scan-and-pair first; the whole-document projection
 * proof only when grouped blocks need it), and one alignment carries exact offsets into it. */
function renderedPlan(entry: SourceBlockIndex): RenderedPlan {
  return entry.memo(RENDERED_PLAN, (value) => {
    const root = value.key.root
    const units =
      value.exact === value.rendered && value.units
        ? value.units
        : (resolveBlockHandleUnits(root, value.rendered, value.rendered) ??
          resolveBlockHandleUnits(
            root,
            value.rendered,
            value.rendered,
            currentBlockProjection(),
          ) ??
          [])
    return {
      units: [...units].sort(
        (left, right) => left.start - right.start || right.end - left.end,
      ),
      alignment: alignText(value.exact, value.rendered),
    }
  })
}

/** The smallest unit whose span contains `[start, end)` (nested list items win). */
function unitFor(
  units: readonly BlockHandleUnit[],
  match: { start: number; end: number },
): BlockHandleUnit | null {
  let low = 0
  let high = units.length - 1
  let last = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (units[middle].start <= match.start) {
      last = middle
      low = middle + 1
    } else high = middle - 1
  }
  let best: BlockHandleUnit | null = null
  for (let index = last; index >= 0 && last - index < 64; index--) {
    const unit = units[index]
    if (
      unit.end >= match.end &&
      (!best || unit.end - unit.start < best.end - best.start)
    )
      best = unit
  }
  return best
}

function inViewport(rect: DOMRect, box: VisibleBox, margin: number): boolean {
  return rect.bottom >= box.top - margin && rect.top <= box.bottom + margin
}
function indexedMapper(entry: SourceBlockIndex): FindMapper {
  const plan = renderedPlan(entry)
  const maps = entry.memo(
    BLOCK_MAPS,
    () => new Map<BlockHandleUnit, BlockMap | null>(),
  )
  const mapFor = (unit: BlockHandleUnit): BlockMap | null => {
    if (!maps.has(unit))
      maps.set(unit, blockMap(unit, entry.rendered.slice(unit.start, unit.end)))
    return maps.get(unit) ?? null
  }
  // The match's span in the rendered text: only through unchanged characters.
  const renderedSpan = (match: MarkdownMatch): [number, number] | null => {
    const start = plan.alignment.toRendered(match.start, 'start')
    const end = plan.alignment.toRendered(match.end, 'end')
    return start !== null &&
      end !== null &&
      entry.rendered.slice(start, end) ===
        entry.exact.slice(match.start, match.end)
      ? [start, end]
      : null
  }
  const ownerOf = (match: MarkdownMatch) => {
    const span = renderedSpan(match)
    const unit = span
      ? unitFor(plan.units, { start: span[0], end: span[1] })
      : null
    return span && unit ? { span, unit } : null
  }
  const unitsByMatch = new WeakMap<
    readonly MarkdownMatch[],
    Array<BlockHandleUnit | null>
  >()
  return {
    range: (match) => {
      const owner = ownerOf(match)
      if (!owner) return null
      const { span, unit } = owner
      const text = entry.exact.slice(match.start, match.end)
      const map = mapFor(unit)
      if (map) {
        const start = map.alignment.toRendered(span[0] - unit.start, 'start')
        const end = map.alignment.toRendered(span[1] - unit.start, 'end')
        const range =
          start !== null &&
          end !== null &&
          map.rendered.slice(start, end) === text
            ? verifiedRange(map.points.get(start), map.points.get(end), text)
            : null
        if (range) return range
      }
      return regionRange(
        unit.element,
        entry.rendered.slice(unit.start, unit.end),
        span[0] - unit.start,
        span[1] - unit.start,
      )
    },
    visible: (matches, box, margin) => {
      let owners = unitsByMatch.get(matches)
      if (!owners) {
        owners = matches.map((match) => ownerOf(match)?.unit ?? null)
        unitsByMatch.set(matches, owners)
      }
      const shownByUnit = new Map<BlockHandleUnit, boolean>()
      const out: number[] = []
      for (const [index, unit] of owners.entries()) {
        if (!unit) continue
        let shown = shownByUnit.get(unit)
        if (shown === undefined) {
          shown =
            unit.element.isConnected &&
            inViewport(unit.element.getBoundingClientRect(), box, margin)
          shownByUnit.set(unit, shown)
        }
        if (shown) out.push(index)
      }
      return out
    },
  }
}

function svMapper(source: FindSource): FindMapper {
  const nodes = textNodes(source.root)
  const starts = [0]
  for (const node of nodes) starts.push(starts.at(-1)! + node.data.length)
  const text = nodes.map((node) => node.data).join('')
  const alignment = alignText(source.exact, text)
  // The text node containing rendered `offset`; `end` prefers the node ending there.
  const point = (
    offset: number,
    bias: 'start' | 'end',
  ): SourcePoint | undefined => {
    let low = 0
    let high = nodes.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      const from = starts[middle]
      const to = starts[middle + 1]
      if (offset < from || (bias === 'end' && offset === from && middle > 0))
        high = middle - 1
      else if (
        offset > to ||
        (bias === 'start' && offset === to && middle < nodes.length - 1)
      )
        low = middle + 1
      else return { node: nodes[middle], offset: offset - from }
    }
    return undefined
  }
  const rendered = (match: MarkdownMatch): [number, number] | null => {
    const start = alignment.toRendered(match.start, 'start')
    const end = alignment.toRendered(match.end, 'end')
    return start !== null &&
      end !== null &&
      text.slice(start, end) === source.exact.slice(match.start, match.end)
      ? [start, end]
      : null
  }
  const range = (match: MarkdownMatch): Range | null => {
    const span = rendered(match)
    return span
      ? verifiedRange(
          point(span[0], 'start'),
          point(span[1], 'end'),
          source.exact.slice(match.start, match.end),
        )
      : null
  }
  return {
    range,
    // Matches ascend in source order, and so do their SV lines: binary-search the first match
    // at or below the top edge, then walk until one lies past the bottom edge.
    visible: (matches, box, margin) => {
      const rectOf = (index: number): DOMRect | null =>
        range(matches[index])?.getBoundingClientRect() ?? null
      let low = 0
      let high = matches.length - 1
      while (low < high) {
        const middle = (low + high) >> 1
        const rect = rectOf(middle)
        if (rect && rect.bottom < box.top - margin) low = middle + 1
        else high = middle
      }
      const out: number[] = []
      for (let index = low; index < matches.length; index++) {
        const rect = rectOf(index)
        if (!rect) continue
        if (rect.top > box.bottom + margin) break
        if (inViewport(rect, box, margin)) out.push(index)
      }
      return out
    },
  }
}

const UNMAPPED: FindMapper = { range: () => null, visible: () => [] }

const mappers = new WeakMap<object, FindMapper>()

/** One mapper per source identity; its block and alignment work is reused until the source
 * changes (a new index entry or SV snapshot). */
export function findMapperFor(source: FindSource): FindMapper {
  let mapper = mappers.get(source.key)
  if (!mapper) {
    // A visual mode without an index entry has no source-mapped blocks: its IR markers and
    // previews duplicate text, so a whole-surface alignment could land on the wrong copy.
    mapper = source.entry
      ? indexedMapper(source.entry)
      : source.mode === 'sv'
        ? svMapper(source)
        : UNMAPPED

    mappers.set(source.key, mapper)
  }
  return mapper
}
