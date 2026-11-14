import type { MovableBlock } from '../../../src/shared/block-move'
import { splitRow } from '../../../src/shared/table-row-splice'
import { applyChanges, offsetToPosition, type TextChange } from './change-set'
import {
  type ApplyPlan,
  type ApplyPlanResult,
  buildRow,
  type HostUnit,
  indexUnit,
  type ModelInternals,
  newUnit,
  setApplyImplementation,
  tableChildren,
  tableShapeMatches,
  type Unit,
  unindexUnit,
  unitHtml,
} from './text-model'

// Task 733 / 010 (shared rules 3.7): planning and committing an apply, the text-driven counterpart of
// the DOM-driven root window of model-structure.ts. `plan` rescans only a window of the text around
// the changes (design 9 step 2) and never the whole document; `commit` replaces the window's units
// with the rendered ones. Both are pure model work: the DOM adapter renders between them.

/** The host limit of one `edit-delta` (delta-sync.ts), so a planned change is always postable. */
const APPLY_MAX_CHANGES = 256
/** Characters of new block source an apply renders at most (the oversize bound, Q-79 OQ-9). */
const APPLY_SOURCE_LIMIT = 20_000
/** Characters of old text one rescan reads at most, so a window that never closes falls back early. */
const APPLY_SCAN_LIMIT = 4 * APPLY_SOURCE_LIMIT

// A reference definition, a footnote definition or a table of contents changes how other blocks
// render (Lute resolves them document-wide), so a window that holds one cannot be rendered alone.
const REFERENCE_DEFINITION = /^ {0,3}\[(?:[^\]\\\n]|\\.)+\]:/mu
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^[^\]\n]+\]:/mu
const TABLE_OF_CONTENTS = /^ {0,3}\[toc\][ \t]*$/imu
// The scanner reads a `---` first line as front matter, so a window must not start on one (only
// offset 0 of the document may hold front matter).
const DASH_LINE = /^---[ \t]*(?:\r?\n|$)/u

type Fallback = Extract<ApplyPlanResult<never>, { kind: 'fallback' }>
const fallback = (reason: Fallback['reason']): Fallback => ({
  kind: 'fallback',
  reason,
})
const TOO_MANY = fallback('too-many-changes')
const DIRTY = fallback('dirty-overlap')
const DEPENDENT = fallback('dependent-construct')
const WITHOUT_KIND = fallback('window-without-kind')
const OVERSIZE = fallback('oversize-unit')

interface NewBlock {
  readonly kind: MovableBlock['kind']
  readonly start: number // in the new text
  readonly end: number
}
interface BlockInfo {
  readonly kind: 'blocks'
  /** Old window: units[i0] to units[end - 1]. */
  readonly i0: number
  readonly end: number
  /** Window units kept at the front and at the back. */
  readonly p: number
  readonly s: number
  readonly blocks: readonly NewBlock[]
}
interface RowInfo {
  readonly kind: 'rows'
  readonly lines: readonly string[] // new line of each planned row
}
// What commit needs besides the plan's public fields, keyed by the plan object.
const infos = new WeakMap<object, BlockInfo | RowInfo>()

/** Index of the last unit whose start is at or before `offset`; -1 when none. */
function atOrBefore<E>(units: readonly Unit<E>[], offset: number): number {
  let lo = 0
  let hi = units.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (units[mid].start <= offset) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/** `text.slice(from, to)` with the changes applied; every change lies inside the range. */
function applyWithin(
  text: string,
  from: number,
  to: number,
  changes: readonly TextChange[],
): string {
  let out = ''
  let cursor = from
  for (const change of changes) {
    out += text.slice(cursor, change.from) + change.insert
    cursor = change.to
  }
  return out + text.slice(cursor, to)
}

function countLines(text: string, from = 0, to = text.length): number {
  let count = 0
  for (let at = text.indexOf('\n', from); at !== -1 && at < to; ) {
    count++
    at = text.indexOf('\n', at + 1)
  }
  return count
}

function isDirty<E>(unit: Unit<E>): boolean {
  if (unit.dirty) return true
  for (const child of unit.children) if (isDirty(child)) return true
  return false
}

const lengthOf = (changes: readonly TextChange[]): number => {
  let delta = 0
  for (const change of changes)
    delta += change.insert.length - (change.to - change.from)
  return delta
}

/** Same-shape table rule (handoff 1.4): every change edits body row lines of one table in place. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the same-shape table rule (handoff 1.4) checks each change, row and column count in one pass
function planRows<E>(
  internals: ModelInternals<E>,
  changes: readonly TextChange[],
): ApplyPlanResult<E> | undefined {
  const { units, text } = internals
  const first = changes[0].from
  const last = changes[changes.length - 1].to
  const table = units[atOrBefore(units, first)]
  if (
    table?.kind !== 'table' ||
    table.children.length < 2 ||
    first < table.start ||
    last > table.end
  )
    return undefined
  const rows = table.children
  const columns = splitRow(text.slice(rows[0].start, rows[0].end)).length
  const planned: number[] = []
  const lines: string[] = []
  let at = 0
  while (at < changes.length) {
    const change = changes[at]
    const r = atOrBefore(rows, change.from)
    // A change at the start of a row line touches the line break before it in the same way.
    if (r < 2 || change.to > rows[r].end) return undefined
    let next = at
    while (
      next < changes.length &&
      changes[next].from >= rows[r].start &&
      changes[next].to <= rows[r].end
    ) {
      const c = changes[next]
      if (c.insert.includes('\n') || text.slice(c.from, c.to).includes('\n'))
        return undefined
      next++
    }
    if (next === at) return undefined
    const row = rows[r]
    if (isDirty(row)) return DIRTY
    const line = applyWithin(text, row.start, row.end, changes.slice(at, next))
    if (splitRow(line).length !== columns) return undefined
    planned.push(r)
    lines.push(line)
    at = next
  }
  const header = text.slice(rows[0].start, rows[0].end)
  const delimiter = text.slice(rows[1].start, rows[1].end)
  const sources = lines.map((line) => ({
    kind: 'table' as const,
    source: `${header}\n${delimiter}\n${line}`,
  }))
  let total = 0
  for (const source of sources) total += source.source.length
  if (total > APPLY_SOURCE_LIMIT) return OVERSIZE
  const plan: ApplyPlan<E> = {
    changes,
    window: { from: table.start, to: table.end },
    removed: [],
    sources,
    tableRows: [{ table, rows: planned }],
  }
  infos.set(plan, { kind: 'rows', lines })
  return { kind: 'plan', plan }
}

const sameBlock = <E>(
  oldText: string,
  unit: Unit<E>,
  newSlice: string,
  block: NewBlock,
  ws: number,
): boolean =>
  unit.kind === block.kind &&
  unit.end - unit.start === block.end - block.start &&
  oldText.slice(unit.start, unit.end) ===
    newSlice.slice(block.start - ws, block.end - ws)

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the window rule of handoff 1.2 (look-behind, list runs, look-ahead, rescan until the boundaries meet, reuse) is one decision sequence
function planApply<E>(
  internals: ModelInternals<E>,
  changes: readonly TextChange[],
): ApplyPlanResult<E> {
  if (changes.length === 0)
    return {
      kind: 'plan',
      plan: { changes, window: { from: 0, to: 0 }, removed: [], sources: [] },
    }
  if (changes.length > APPLY_MAX_CHANGES) return TOO_MANY
  // A structure change of typing cannot be bounded to a window (handoff 1.3).
  if (internals.structure.size > 0) return DIRTY
  const { units, text } = internals
  if (units.length === 0) return WITHOUT_KIND
  const rows = planRows(internals, changes)
  if (rows) return rows
  const first = changes[0].from
  const last = changes[changes.length - 1].to
  const delta = lengthOf(changes)

  // Look behind one unit (lazy continuation, setext underline), over a whole list run, and off a
  // `---` line the slice scan would read as front matter.
  let i0 = Math.max(0, atOrBefore(units, first))
  if (i0 > 0) i0--
  while (
    i0 > 0 &&
    ((units[i0].kind === 'list-item' && units[i0 - 1].kind === 'list-item') ||
      DASH_LINE.test(text.slice(units[i0].start, units[i0].start + 8)))
  )
    i0--
  const ws = Math.min(units[i0].start, first)
  let k = Math.max(i0, atOrBefore(units, last))
  for (;;) {
    while (
      k + 1 < units.length &&
      units[k].kind === 'list-item' &&
      units[k + 1].kind === 'list-item'
    )
      k++
    const j = k + 1
    const lookAhead = j < units.length ? units[j] : undefined
    const oldEnd = lookAhead ? lookAhead.end : text.length
    if (oldEnd - ws > APPLY_SCAN_LIMIT) return OVERSIZE
    const newSlice = applyWithin(text, ws, oldEnd, changes)
    if (
      REFERENCE_DEFINITION.test(newSlice) ||
      FOOTNOTE_DEFINITION.test(newSlice) ||
      TABLE_OF_CONTENTS.test(newSlice)
    )
      return DEPENDENT
    const scanned = internals.scan(newSlice)
    if (scanned.length === 0) {
      if (lookAhead) {
        k = grow(units, ws, oldEnd, j)
        continue
      }
      return WITHOUT_KIND
    }
    if (ws > 0 && scanned[0].kind === 'front-matter') return WITHOUT_KIND
    const tail = scanned[scanned.length - 1]
    if (lookAhead) {
      const before = scanned[scanned.length - 2]
      const meets =
        tail.kind === lookAhead.kind &&
        ws + tail.start === lookAhead.start + delta &&
        ws + tail.end === lookAhead.end + delta &&
        // A new item that joins the look-ahead item's list changes that list's DOM.
        !(
          tail.kind === 'list-item' &&
          before?.kind === 'list-item' &&
          before.listRun === tail.listRun
        )
      if (!meets) {
        k = grow(units, ws, oldEnd, j)
        continue
      }
    }
    // A loose list renders its items with paragraphs, which a lone item render does not give; a run
    // whose looseness changes re-renders items that reuse by bytes would keep (010-R F3).
    if (
      looseItems(newSlice, scanned) ||
      looseUnits(text, units, i0, lookAhead ? j + 1 : units.length)
    )
      return WITHOUT_KIND
    const blocks: NewBlock[] = scanned.map((block) => ({
      kind: block.kind,
      start: ws + block.start,
      end: ws + block.end,
    }))
    const end = lookAhead ? j + 1 : units.length
    const oldLength = end - i0
    const shortest = Math.min(oldLength, blocks.length)
    let p = 0
    while (
      p < shortest &&
      sameBlock(text, units[i0 + p], newSlice, blocks[p], ws)
    )
      p++
    let s = 0
    while (
      s < shortest - p &&
      sameBlock(
        text,
        units[end - 1 - s],
        newSlice,
        blocks[blocks.length - 1 - s],
        ws,
      )
    )
      s++
    // A new block needs an old element to stand in for: re-render a neighbour.
    if (oldLength - p - s === 0 && blocks.length - p - s > 0) {
      if (p > 0) p--
      else if (s > 0) s--
      else return WITHOUT_KIND
    }
    const removed = units.slice(i0 + p, end - s)
    for (const unit of removed) if (isDirty(unit)) return DIRTY
    const sources = blocks.slice(p, blocks.length - s).map((block) => ({
      kind: block.kind,
      source: newSlice.slice(block.start - ws, block.end - ws),
    }))
    let total = 0
    for (const source of sources) total += source.source.length
    if (total > APPLY_SOURCE_LIMIT) return OVERSIZE
    const plan: ApplyPlan<E> = {
      changes,
      window: { from: ws, to: oldEnd },
      removed,
      sources,
    }
    infos.set(plan, { kind: 'blocks', i0, end, p, s, blocks })
    return { kind: 'plan', plan }
  }
}

/**
 * The next end unit of a window that did not close: the window grows geometrically (010-R F2), so a
 * change that opens a fence in a large document costs a few scans, then falls back on the bound.
 */
function grow<E>(
  units: readonly Unit<E>[],
  ws: number,
  oldEnd: number,
  j: number,
): number {
  const target = ws + 2 * Math.max(oldEnd - ws, 1)
  return Math.max(j, Math.min(units.length - 1, atOrBefore(units, target)))
}

/** A list item with a blank line inside it, or two items of one run with a blank line between them. */
function looseItems(slice: string, blocks: readonly MovableBlock[]): boolean {
  for (const [at, block] of blocks.entries()) {
    if (block.kind !== 'list-item') continue
    if (slice.slice(block.start, block.end).includes('\n\n')) return true
    const next = blocks[at + 1]
    if (
      next?.kind === 'list-item' &&
      next.listRun === block.listRun &&
      slice.slice(block.end, next.start).includes('\n\n')
    )
      return true
  }
  return false
}

/** `looseItems` for the old window's units (neighbouring items, whatever their run). */
function looseUnits<E>(
  text: string,
  units: readonly Unit<E>[],
  from: number,
  to: number,
): boolean {
  for (let at = from; at < to; at++) {
    const unit = units[at]
    if (unit.kind !== 'list-item') continue
    if (text.slice(unit.start, unit.end).includes('\n\n')) return true
    const next = units[at + 1]
    if (
      at + 1 < to &&
      next.kind === 'list-item' &&
      text.slice(unit.end, next.start).includes('\n\n')
    )
      return true
  }
  return false
}

/** Moves a unit and its rows and cells by `delta` characters and `lines` lines. */
function moveUnit<E>(unit: Unit<E>, delta: number, lines: number): void {
  if (delta === 0 && lines === 0) return
  unit.start += delta
  unit.end += delta
  unit.startLine += lines
  for (const child of unit.children) moveUnit(child, delta, lines)
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: kept and new window units are placed, proven and indexed in one pass over the new blocks
function commitBlocks<E>(
  internals: ModelInternals<E>,
  info: BlockInfo,
  rendered: readonly HostUnit<E>[],
  newText: string,
  lineDelta: number,
): void {
  const { units, host } = internals
  const oldText = internals.text
  const window: Unit<E>[] = []
  const before = units[info.i0 - 1]
  let known = before
    ? { offset: before.start, line: before.startLine }
    : undefined
  let next = 0
  const backFrom = info.blocks.length - info.s
  for (const [n, block] of info.blocks.entries()) {
    const line = offsetToPosition(newText, block.start, known).line
    known = { offset: block.start, line }
    if (n < info.p || n >= backFrom) {
      const kept =
        n < info.p
          ? units[info.i0 + n]
          : units[info.end - (info.blocks.length - n)]
      moveUnit(kept, block.start - kept.start, line - kept.startLine)
      window.push(kept)
      continue
    }
    const listed = rendered[next++]
    const unit = newUnit<E>(
      block.kind,
      [...listed.members],
      block.start,
      block.end,
      line,
    )
    if (block.kind === 'table') {
      const lines = newText.slice(block.start, block.end).split('\n')
      if (tableShapeMatches(lines, listed))
        unit.children = tableChildren(unit, lines, listed)
      unit.proof = unit.children.length > 0 ? 'proven' : 'opaque'
    } else {
      // Rendered from these bytes by the live Lute: proven by construction.
      unit.html = unitHtml(host, unit)
      unit.canon = host.serialize(block.kind, unit.members)
      unit.proof = 'proven'
    }
    window.push(unit)
  }
  for (const unit of units.slice(info.i0 + info.p, info.end - info.s)) {
    unindexUnit(internals, unit)
    for (const member of unit.members) internals.hostKinds.delete(member)
    internals.dirty.delete(unit)
  }
  for (const [n, unit] of window.entries()) {
    if (n < info.p || n >= backFrom) continue
    indexUnit(internals, unit)
    for (const member of unit.members)
      internals.hostKinds.set(member, unit.kind as MovableBlock['kind'])
  }
  const suffix = units.slice(info.end)
  const delta = newText.length - oldText.length
  for (const unit of suffix) moveUnit(unit, delta, lineDelta)
  internals.units = [...units.slice(0, info.i0), ...window, ...suffix]
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each planned row is unindexed, rebuilt, indexed and shifted in one pass
function commitRows<E>(
  internals: ModelInternals<E>,
  plan: ApplyPlan<E>,
  info: RowInfo,
  rendered: readonly HostUnit<E>[],
  newText: string,
): void {
  const target = plan.tableRows?.[0]
  if (!target) return
  const { table } = target
  const rows = table.children
  let total = 0
  for (const [n, r] of target.rows.entries()) {
    const old = rows[r]
    const line = info.lines[n]
    const listed = rendered[n]
    for (const member of old.members) internals.byElement.delete(member)
    for (const cell of old.children)
      for (const member of cell.members) internals.byElement.delete(member)
    const fresh = buildRow<E>(
      r,
      line,
      old.start,
      old.startLine,
      listed.rows?.[0] ?? [],
    )
    rows[r] = fresh
    if (fresh.children.length === 0)
      for (const member of fresh.members) internals.byElement.set(member, fresh)
    for (const cell of fresh.children)
      for (const member of cell.members) internals.byElement.set(member, cell)
    const rowDelta = line.length - (old.end - old.start)
    for (let after = r + 1; after < rows.length; after++)
      moveUnit(rows[after], rowDelta, 0)
    table.end += rowDelta
    total += rowDelta
  }
  table.html = undefined
  const index = internals.units.indexOf(table)
  for (const unit of internals.units.slice(index + 1)) moveUnit(unit, total, 0)
  if (newText.length - internals.text.length !== total)
    throw new RangeError('row apply length mismatch')
}

function commitApply<E>(
  internals: ModelInternals<E>,
  plan: ApplyPlan<E>,
  rendered: readonly HostUnit<E>[],
): void {
  const info = infos.get(plan)
  if (!info) return
  infos.delete(plan)
  if (rendered.length !== plan.sources.length)
    throw new RangeError('rendered units do not match the plan sources')
  const oldText = internals.text
  const newText = applyChanges(oldText, plan.changes)
  let lineDelta = 0
  for (const change of plan.changes)
    lineDelta +=
      countLines(change.insert) - countLines(oldText, change.from, change.to)
  if (info.kind === 'rows') commitRows(internals, plan, info, rendered, newText)
  else commitBlocks(internals, info, rendered, newText, lineDelta)
  internals.text = newText
  // The apply's own DOM writes are the only structure marks since the plan (it refuses a pending one).
  internals.structure.clear()
}

/** Registers the apply with the text model (idempotent; the DOM adapter calls it). */
export function installApplyText(): void {
  setApplyImplementation({ plan: planApply, commit: commitApply })
}
