import { pairRenderedSpans } from '../nav/block-handle'
import {
  sameSourceBlockIndexKey,
  type SourceBlockIndex,
  type SourceBlockIndexHandle,
  type SourceBlockIndexKey,
} from '../nav/source-block-index'
import { alignText, type OffsetAlignment } from './find-align'
import {
  blockMapFor,
  blockMapOffset,
  renderedPlanFor,
  type RenderedPlan,
} from './find-map'

interface ProvenPoint {
  exact: number
  /** Index in Find's rendered plan; callers decide whether multiple units are allowed. */
  unit: number
  unitExact: [number, number]
  via: 'document' | 'block'
}

export type SelectionProof =
  | { status: 'unavailable' }
  | { status: 'unprovable'; roundTrip: boolean }
  | {
      status: 'proven'
      key: SourceBlockIndexKey
      exact: string
      rendered: string
      roundTrip: boolean
      start: ProvenPoint
      end: ProvenPoint
    }

interface ProofContext {
  entry: SourceBlockIndex
  root: HTMLElement
  plan: RenderedPlan
  roundTrip: boolean
}

const MEMBER_UNITS = Symbol('selection proof member units')
const EXACT_SPANS = Symbol('selection proof exact spans')
const BLOCK_ALIGNMENTS = Symbol('selection proof block alignments')

function unitIndexOf(context: ProofContext, node: Text): number | null {
  const { entry, root, plan } = context
  const members = entry.memo(MEMBER_UNITS, () => {
    const result = new Map<HTMLElement, number>()
    for (const [index, unit] of plan.units.entries())
      for (const member of unit.members) result.set(member, index)
    return result
  })
  let member = node.parentElement
  let child: HTMLElement | null = null
  while (member && member.parentElement !== root) {
    child = member
    member = member.parentElement
  }
  if (!member?.hasAttribute('data-block')) return null
  // Nested list text belongs to the top-level LI, matching Find's member grouping.
  if (member.tagName === 'UL' || member.tagName === 'OL')
    member = child?.tagName === 'LI' ? child : null
  return member ? (members.get(member) ?? null) : null
}

type Bias = 'caret' | 'start' | 'end'

function through(
  alignment: OffsetAlignment,
  offset: number,
  bias: Bias,
): number | null {
  if (bias !== 'caret') return alignment.toExact(offset, bias)
  const start = alignment.toExact(offset, 'start')
  const end = alignment.toExact(offset, 'end')
  // A deletion can put two exact boundaries at one rendered caret; never pick one arbitrarily.
  return start !== null && end !== null && start !== end ? null : (start ?? end)
}

function blockAlignment(
  context: ProofContext,
  index: number,
  span: [number, number],
): OffsetAlignment {
  const { entry, plan } = context
  const alignments = entry.memo(
    BLOCK_ALIGNMENTS,
    () => new Map<number, OffsetAlignment>(),
  )
  let alignment = alignments.get(index)
  if (!alignment) {
    const unit = plan.units[index]!
    alignment = alignText(
      entry.exact.slice(...span),
      entry.rendered.slice(unit.start, unit.end),
    )
    alignments.set(index, alignment)
  }
  return alignment
}

function exactSpan(
  { entry, plan, roundTrip }: ProofContext,
  index: number,
): [number, number] | undefined {
  const unit = plan.units[index]!
  return roundTrip
    ? [unit.start, unit.end]
    : entry.memo(EXACT_SPANS, () =>
        pairRenderedSpans(entry.exact, plan.units),
      )?.[index]
}

function isExactTextBoundary(source: string, offset: number): boolean {
  if (offset <= 0 || offset >= source.length) return true
  const before = source.charCodeAt(offset - 1)
  const after = source.charCodeAt(offset)
  // Rendered line endings and Unicode code points cannot supply a caret inside two source units.
  return !(
    (before === 13 && after === 10) ||
    (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
  )
}

function matchesExactBoundary(
  node: Text,
  offset: number,
  source: string,
  exact: number,
): boolean {
  // Sentinels give order, not character identity. Check the adjacent live text against the
  // exact source so a stale or reordered boundary cannot authorize an unrelated offset.
  if (offset < node.data.length && exact < source.length)
    return node.data[offset] === source[exact]
  return offset <= 0 || node.data[offset - 1] === source[exact - 1]
}

function provePoint(
  context: ProofContext,
  node: Node,
  offset: number,
  bias: Bias,
): ProvenPoint | null {
  const { entry, root, plan, roundTrip } = context
  // Element offsets include Markdown syntax boundaries (for example a table's pipe), so
  // moving them to nearby text would manufacture an exact-source position.
  if (!(node instanceof Text) || !node.isConnected || !root.contains(node))
    return null
  const index = unitIndexOf(context, node)
  if (index === null) return null
  const unit = plan.units[index]!
  const map = blockMapFor(entry, unit)
  const serialized = map && blockMapOffset(map, node, offset)
  if (!map || serialized === null) return null
  const local = through(map.alignment, serialized, bias)
  if (local === null || local < 0 || local > unit.end - unit.start) return null
  const span = exactSpan(context, index)
  if (!span) return null
  const rendered = unit.start + local
  let exact = roundTrip ? rendered : through(plan.alignment, rendered, bias)
  let via: ProvenPoint['via'] = 'document'
  if (exact === null) {
    // Large CRLF documents can exceed the document diff's bound. Structural pairing above
    // supplies the exact block slice for a smaller proof, without changing source authority.
    const fallback = through(blockAlignment(context, index, span), local, bias)
    if (fallback === null) return null
    exact = span[0] + fallback
    via = 'block'
  }
  if (
    exact < span[0] ||
    exact > span[1] ||
    !isExactTextBoundary(entry.exact, exact) ||
    !matchesExactBoundary(node, offset, entry.exact, exact)
  )
    return null
  return { exact, unit: index, unitExact: span, via }
}

/** Task 604: prove live text endpoints against one exact/rendered snapshot without live markers.
 * Unprovable round-trip selections may use a caller's legacy proof; unavailable state may not. */
export function proveSelectionSource(
  source: {
    index: SourceBlockIndexHandle
    snapshotPair(): { exact: string; rendered: string }
  },
  root: HTMLElement,
  range: Range,
): SelectionProof {
  const entry = source.index.peek() ?? source.index.read()
  if (!entry || entry.key.root !== root) return { status: 'unavailable' }
  const pair = source.snapshotPair()
  if (
    !sameSourceBlockIndexKey(entry.key, source.index.currentKey()) ||
    pair.exact !== entry.exact ||
    pair.rendered !== entry.rendered
  )
    return { status: 'unavailable' }
  const roundTrip = pair.exact === pair.rendered
  const context = { entry, root, plan: renderedPlanFor(entry), roundTrip }
  const start = provePoint(
    context,
    range.startContainer,
    range.startOffset,
    range.collapsed ? 'caret' : 'start',
  )
  const end = range.collapsed
    ? start
    : provePoint(context, range.endContainer, range.endOffset, 'end')
  if (!start || !end || start.exact > end.exact)
    return { status: 'unprovable', roundTrip }
  return {
    status: 'proven',
    key: entry.key,
    exact: pair.exact,
    rendered: pair.rendered,
    roundTrip,
    start,
    end,
  }
}
