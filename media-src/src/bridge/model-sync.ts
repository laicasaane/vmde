import { restoreCodeSpanPipeForm } from '../../../src/shared/table-code-pipes'
import {
  originalRowCellSpans,
  spliceChangedRow,
  splitRow,
} from '../../../src/shared/table-row-splice'
import { applyChanges, singleSpanDiff, type TextChange } from './change-set'
import {
  indexOfUnit,
  type ModelInternals,
  markerOf,
  type SavedEntry,
  rowOfCell,
  type SyncResult,
  type Unit,
  unitHtml,
} from './text-model'

// Leaf sync of the text model (Task 733, handoff 6.7 steps 2 to 8 and 6.11): a dirty block, list
// item, cell or span-less row is serialized once and its bytes are replaced by the smallest single
// span. Structure scopes and list-routed items belong to the structure windows (model-structure.ts,
// segment 003-F): they reach `structureSync`, and without it the publication falls back.

/** The structure windows (003-F): called when a structure scope, a list-routed leaf or a list-path leaf change is pending. */
export type StructureSync = <E>(
  internals: ModelInternals<E>,
  sequence: number | undefined,
) => SyncResult
let structureSync: StructureSync | undefined
export function setStructureSync(
  implementation: StructureSync | undefined,
): void {
  structureSync = implementation
}

const ORDERED = /^\d{1,9}[.)]/u
const fallback = (reason: 'unproven-unit' | 'sync-error'): SyncResult => ({
  kind: 'fallback',
  reason,
})

interface Leaf<E> {
  unit: Unit<E>
  row?: Unit<E> // the row of a cell
}

/** Dirty leaves in document order: blocks, list items, cells, span-less rows. Visits the dirty set only (P5). */
function dirtyLeaves<E>(internals: ModelInternals<E>): Leaf<E>[] {
  const leaves: Leaf<E>[] = []
  for (const unit of internals.dirty) {
    if (unit.kind === 'cell') {
      leaves.push({ unit, row: rowOfCell.get(unit) as Unit<E> | undefined })
    } else if (unit.kind === 'row') {
      if (unit.children.length === 0 && unit.members.length > 0)
        leaves.push({ unit })
    } else if (unit.kind !== 'table' || unit.children.length === 0) {
      leaves.push({ unit })
    }
  }
  if (leaves.length < 2) return leaves
  return leaves.sort(
    (a, b) =>
      a.unit.start - b.unit.start ||
      indexOfUnit(internals.units, a.unit) -
        indexOfUnit(internals.units, b.unit),
  )
}

interface Planned<E> {
  unit: Unit<E>
  html: string
  canon: string
  newBytes: string | undefined // undefined: nothing changes in the text
  oldBytes: string
  /** Saved bytes of a block that left the document: taken (removed from the index) when the change is committed. */
  take?: { canon: string; entry: SavedEntry<unknown> }
}

interface Edit<E> {
  owner: Unit<E>
  change: TextChange
}

function canonOf<E>(internals: ModelInternals<E>, unit: Unit<E>): string {
  const { host } = internals
  if (unit.kind === 'cell') return host.serialize('cell', [unit.members[0]])
  if (unit.kind === 'row')
    return `| ${unit.members.map((m) => host.serialize('cell', [m])).join(' | ')} |`
  return host.serialize(unit.kind, unit.members)
}

/** The list path (rule 3.5 step 4): a blank line in the old or new canon, or a changed ordered marker. */
function needsListPath<E>(unit: Unit<E>, canon: string): boolean {
  if (unit.kind !== 'list-item') return false
  const old = unit.canon ?? ''
  if (old.includes('\n\n') || canon.includes('\n\n')) return true
  return ORDERED.test(markerOf(old)) && markerOf(old) !== markerOf(canon)
}

/** Bytes of a changed leaf: the saved form whose canon matches, else the canon (explicit edits skip the forms). */
function bytesFor<E>(unit: Unit<E>, canon: string, oldBytes: string): string {
  if (!unit.explicit) {
    const form = unit.forms.find((f) => f.canon === canon)
    if (form) return form.bytes
  }
  if (unit.kind === 'cell') return restoreCodeSpanPipeForm(oldBytes, canon)
  // Only list items: a block keeps the canon-writing rule of 8.4 and 8.5 (a closing `#` of a heading goes).
  if (unit.kind !== 'list-item' || unit.explicit || unit.canon === undefined)
    return canon
  return mapCanonChange(oldBytes, unit.canon, canon)
}

const TASK_MARK = /^(?:[-*+]|\d{1,9}[.)])[ \t]+\[/u

/**
 * The bytes of a changed leaf when its old bytes and its old canon differ only in canonical-form details
 * (a task item that Lute writes as `- [ ]  one` over the bytes `- [ ] one`): the change between the two
 * canons is applied to the old bytes, so the characters outside the changed span keep their bytes. The
 * mapping is exact when the changed span lies wholly in the part where bytes and canon are still equal
 * (counted from the start or from the end); any other layout is ambiguous and the canon is written.
 * A task mark that flips is written as `x` or a space, as the checkbox action does.
 */
function mapCanonChange(
  oldBytes: string,
  oldCanon: string,
  canon: string,
): string {
  if (oldBytes === oldCanon) return canon
  const diff = singleSpanDiff(oldCanon, canon)
  if (!diff) return oldBytes
  let insert = diff.insert
  const mark = TASK_MARK.exec(oldCanon)
  if (mark && diff.from === mark[0].length && diff.to === diff.from + 1) {
    insert = insert === ' ' ? ' ' : 'x'
    // The bytes hold the same prefix up to the mark: only the mark character changes.
    if (TASK_MARK.exec(oldBytes)?.[0].length === mark[0].length)
      return oldBytes.slice(0, diff.from) + insert + oldBytes.slice(diff.to)
  }
  let prefix = 0
  const shortest = Math.min(oldBytes.length, oldCanon.length)
  while (
    prefix < shortest &&
    oldBytes.charCodeAt(prefix) === oldCanon.charCodeAt(prefix)
  )
    prefix++
  if (diff.to <= prefix)
    return oldBytes.slice(0, diff.from) + insert + oldBytes.slice(diff.to)
  let suffix = 0
  while (
    suffix < shortest &&
    oldBytes.charCodeAt(oldBytes.length - 1 - suffix) ===
      oldCanon.charCodeAt(oldCanon.length - 1 - suffix)
  )
    suffix++
  const tail = oldCanon.length - diff.from
  if (tail <= suffix) {
    const fromBytes = oldBytes.length - tail
    const toBytes = oldBytes.length - (oldCanon.length - diff.to)
    return oldBytes.slice(0, fromBytes) + insert + oldBytes.slice(toBytes)
  }
  return canon
}

/** Replacement of an empty unit or of an emptied unit with its separator (handoff 6.12). */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the 6.12 table of replaced ranges, one branch per row
function separatorEdit<E>(
  internals: ModelInternals<E>,
  unit: Unit<E>,
  newBytes: string,
): TextChange | undefined {
  const { units } = internals
  const index = indexOfUnit(units, unit)
  let before: Unit<E> | undefined
  for (let at = index - 1; at >= 0 && !before; at--)
    if (units[at].start < units[at].end) before = units[at]
  let after: Unit<E> | undefined
  for (let at = index + 1; at < units.length && !after; at++)
    if (units[at].start < units[at].end) after = units[at]
  if (unit.start === unit.end) {
    if (newBytes === '') return undefined
    if (before)
      return { from: before.end, to: before.end, insert: `\n\n${newBytes}` }
    if (after)
      return { from: after.start, to: after.start, insert: `${newBytes}\n\n` }
    return { from: 0, to: 0, insert: newBytes }
  }
  if (newBytes !== '')
    return { from: unit.start, to: unit.end, insert: newBytes }
  if (before) return { from: before.end, to: unit.end, insert: '' }
  if (after) return { from: unit.start, to: after.start, insert: '' }
  return { from: unit.start, to: unit.end, insert: '' }
}

/** Shrinks a change to the smallest span against the old text; undefined when nothing differs. */
function shrink(text: string, change: TextChange): TextChange | undefined {
  const diff = singleSpanDiff(text.slice(change.from, change.to), change.insert)
  return (
    diff && {
      from: change.from + diff.from,
      to: change.from + diff.to,
      insert: diff.insert,
    }
  )
}

/** What a row looks like after its cell edits: new content spans, or the data of a span-less row (computed before anything is written). */
interface RowRebuild {
  spans: Array<{ contentStart: number; contentEnd: number }> | null
  html?: string
  canon?: string
}

interface Plan<E> {
  planned: Planned<E>[]
  edits: Edit<E>[]
  rowsToRebuild: Map<Unit<E>, RowRebuild>
  emptied: Set<Unit<E>>
  inserted: Set<Unit<E>>
  /** Saved entries already promised to a unit of this sync: an entry is taken once. */
  taken: Set<SavedEntry<unknown>>
}

/** Leaves that need the list path (rule 3.5 step 4). */
export interface Handover<E> {
  handover: Unit<E>[]
}
type Prepared<E> = Plan<E> | SyncResult | Handover<E>

// Cell edits of one row become one change per content span; a row whose splice check fails is rewritten.
function planRow<E>(
  internals: ModelInternals<E>,
  row: Unit<E>,
  cells: Array<{ cell: Unit<E>; newBytes: string }>,
  plan: Plan<E>,
): void {
  const line = internals.text.slice(row.start, row.end)
  const orig = splitRow(line)
  const next = [...orig]
  const changed = orig.map(() => false)
  for (const { cell, newBytes } of cells) {
    const index = row.children.indexOf(cell)
    next[index] = newBytes
    changed[index] = true
  }
  const spliced = spliceChangedRow(line, orig, next, changed)
  const spans = spliced === null ? null : originalRowCellSpans(line, orig)
  let newLine: string
  if (spans && spliced !== null) {
    newLine = spliced
    for (const { cell } of cells) {
      const index = row.children.indexOf(cell)
      const edit = shrink(internals.text, {
        from: row.start + spans[index].contentStart,
        to: row.start + spans[index].contentEnd,
        insert: next[index],
      })
      if (edit) plan.edits.push({ owner: cell, change: edit })
    }
  } else {
    newLine = `| ${next.join(' | ')} |`
    const edit = shrink(internals.text, {
      from: row.start,
      to: row.end,
      insert: newLine,
    })
    if (edit) plan.edits.push({ owner: row, change: edit })
  }
  // Everything the commit needs about the row is read now, so that a throwing adapter leaves the model unchanged.
  const newSpans = originalRowCellSpans(newLine, splitRow(newLine))
  if (newSpans && newSpans.length === row.children.length) {
    plan.rowsToRebuild.set(row, { spans: newSpans })
    return
  }
  const canonOfCell = (cell: Unit<E>): string | undefined =>
    plan.planned.find((p) => p.unit === cell)?.canon ?? cell.canon
  const canons = row.children.map(canonOfCell)
  const known = canons.every((canon) => canon !== undefined)
  plan.rowsToRebuild.set(row, {
    spans: null,
    html: unitHtml(internals.host, row),
    canon: known ? `| ${canons.join(' | ')} |` : undefined,
  })
}

// A span-less row is edited as a row: changed cells (by their HTML) take the restored source form,
// the others keep their source text.
function spanlessRowBytes<E>(
  unit: Unit<E>,
  oldBytes: string,
  canons: string[],
  html: string,
): string {
  const orig = splitRow(oldBytes)
  const oldParts = (unit.html ?? '').split('\u0000')
  const newParts = html.split('\u0000')
  if (orig.length !== canons.length) return `| ${canons.join(' | ')} |`
  const cells = orig.map((cell, j) =>
    oldParts[j] === newParts[j]
      ? cell
      : restoreCodeSpanPipeForm(cell, canons[j]),
  )
  return `| ${cells.join(' | ')} |`
}

/** Bytes of a changed leaf of kind row (span-less) or block, and the edit that writes them. */
function leafEdit<E>(
  internals: ModelInternals<E>,
  unit: Unit<E>,
  planned: Planned<E>,
  plan: Plan<E>,
): void {
  const newBytes = planned.newBytes as string
  if (unit.kind === 'row') {
    const edit = shrink(internals.text, {
      from: unit.start,
      to: unit.end,
      insert: newBytes,
    })
    if (edit) plan.edits.push({ owner: unit, change: edit })
    return
  }
  const target = separatorEdit(internals, unit, newBytes)
  let edit = target
  if (unit.start === unit.end) plan.inserted.add(unit)
  else if (newBytes === '') plan.emptied.add(unit)
  else edit = target && shrink(internals.text, target)
  if (edit) plan.edits.push({ owner: unit, change: edit })
}

/** One dirty leaf: a short cut, a fallback or a planned change. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: short cuts, proof, list path, forms and saved bytes of rule 3.5 step 2
function planLeaf<E>(
  internals: ModelInternals<E>,
  leaf: Leaf<E>,
  plan: Plan<E>,
  cellsByRow: Map<Unit<E>, Array<{ cell: Unit<E>; newBytes: string }>>,
): SyncResult | 'structure' | undefined {
  const { unit, row } = leaf
  const html = unitHtml(internals.host, unit)
  if (unit.html !== undefined && html === unit.html && !unit.explicit) {
    plan.planned.push({
      unit,
      html,
      canon: unit.canon ?? '',
      newBytes: undefined,
      oldBytes: '',
    })
    return undefined
  }
  if (unit.proof !== 'proven') return fallback('unproven-unit')
  const canon = canonOf(internals, unit)
  if (canon === unit.canon && !unit.explicit) {
    plan.planned.push({ unit, html, canon, newBytes: undefined, oldBytes: '' })
    return undefined
  }
  if (needsListPath(unit, canon)) return 'structure'
  const oldBytes = internals.text.slice(unit.start, unit.end)
  let newBytes =
    unit.kind === 'row'
      ? spanlessBytes(internals, unit, canon, oldBytes, html)
      : bytesFor(unit, canon, oldBytes)
  // A block typed again after it was deleted gets the bytes it had (rule 3.5 step 1): only a unit
  // without a saved form of its own takes them, and never for an explicit edit.
  let take: Planned<E>['take']
  if (
    unit.kind !== 'cell' &&
    unit.kind !== 'row' &&
    !unit.explicit &&
    !unit.forms.some((f) => f.canon === canon)
  ) {
    const entry = internals.saved
      ?.get(canon)
      ?.find(
        (e) =>
          e.owner === undefined && !plan.taken.has(e as SavedEntry<unknown>),
      )
    if (entry) {
      newBytes = entry.bytes
      take = { canon, entry: entry as SavedEntry<unknown> }
      plan.taken.add(entry as SavedEntry<unknown>)
    }
  }
  const planned = { unit, html, canon, newBytes, oldBytes, take }
  plan.planned.push(planned)
  if (unit.kind === 'cell' && row) {
    cellsByRow.set(row, [
      ...(cellsByRow.get(row) ?? []),
      { cell: unit, newBytes },
    ])
  } else {
    leafEdit(internals, unit, planned, plan)
  }
  return undefined
}

function spanlessBytes<E>(
  internals: ModelInternals<E>,
  unit: Unit<E>,
  canon: string,
  oldBytes: string,
  html: string,
): string {
  const form = unit.forms.find((f) => f.canon === canon)
  if (form) return form.bytes
  const canons = unit.members.map((m) => internals.host.serialize('cell', [m]))
  return spanlessRowBytes(unit, oldBytes, canons, html)
}

function prepare<E>(
  internals: ModelInternals<E>,
  leaves: Leaf<E>[],
): Prepared<E> {
  const plan: Plan<E> = {
    planned: [],
    edits: [],
    rowsToRebuild: new Map(),
    emptied: new Set(),
    inserted: new Set(),
    taken: new Set(),
  }
  const cellsByRow = new Map<
    Unit<E>,
    Array<{ cell: Unit<E>; newBytes: string }>
  >()
  const handovers: Unit<E>[] = []
  for (const leaf of leaves) {
    if (internals.listRouted.has(leaf.unit)) {
      handovers.push(leaf.unit)
      continue
    }
    const outcome = planLeaf(internals, leaf, plan, cellsByRow)
    if (outcome === 'structure') handovers.push(leaf.unit)
    else if (outcome) return outcome
  }
  if (handovers.length > 0) return { handover: handovers }
  for (const [row, cells] of cellsByRow) planRow(internals, row, cells, plan)
  return plan
}

/** Net newline count of a change. */
const newlineDelta = (text: string, change: TextChange): number =>
  (change.insert.match(/\n/gu)?.length ?? 0) -
  (text.slice(change.from, change.to).match(/\n/gu)?.length ?? 0)

/** Cell units of a row take their content spans from the new line; a row without spans becomes a span-less row. Reads nothing from the host. */
function rebuildCells<E>(row: Unit<E>, rebuild: RowRebuild): void {
  if (rebuild.spans) {
    for (const [index, cell] of row.children.entries()) {
      cell.start = row.start + rebuild.spans[index].contentStart
      cell.end = row.start + rebuild.spans[index].contentEnd
    }
    return
  }
  row.children = []
  row.html = rebuild.html
  row.canon = rebuild.canon
  row.proof = rebuild.canon === undefined ? 'none' : 'proven'
}

/** Prefix sums over the sorted edits: cost of placing a unit is a binary search, never a pass over the edits (P5). */
class EditIndex {
  readonly tos: number[] = []
  readonly endKeys: number[] = []
  readonly cum: number[] = [0]
  readonly nl: number[] = [0]

  constructor(
    oldText: string,
    readonly edits: readonly { change: TextChange }[],
  ) {
    for (const { change } of edits) {
      this.tos.push(change.to)
      // A zero-length edit at a unit's end belongs to its neighbour: it sorts after a replacement ending there.
      this.endKeys.push(change.to + (change.from === change.to ? 0.5 : 0))
      this.cum.push(
        this.cum[this.cum.length - 1] +
          change.insert.length -
          (change.to - change.from),
      )
      this.nl.push(this.nl[this.nl.length - 1] + newlineDelta(oldText, change))
    }
  }

  private static count(keys: readonly number[], x: number): number {
    let lo = 0
    let hi = keys.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (keys[mid] <= x) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Edits with `to <= pos`: they end at or before a unit starting at `pos`. */
  beforeStart(pos: number): number {
    return EditIndex.count(this.tos, pos)
  }

  /** Edits that end inside or before a unit ending at `pos` (a zero-length edit at `pos` is the next unit's). */
  beforeEnd(pos: number): number {
    return EditIndex.count(this.endKeys, pos)
  }
}

interface Range {
  start: number
  end: number
  startLine: number
}

/** New range of a unit that owns edits: its first own edit places it among the edits before it (handoff 6.7 step 8). */
function ownedRange<E>(
  unit: Unit<E>,
  planned: Planned<E> | undefined,
  index: EditIndex,
  plan: Plan<E>,
  owned: readonly number[],
  oldText: string,
): Range {
  const first = owned[0]
  const last = owned[owned.length - 1]
  const change = index.edits[first].change
  const line = unit.startLine + index.nl[first]
  if (planned?.newBytes !== undefined && plan.inserted.has(unit)) {
    // Every earlier edit counts, same-offset insertions in plan order.
    const lead = change.insert.slice(
      0,
      change.insert.length - planned.newBytes.length,
    )
    const start = change.from + index.cum[first] + lead.length
    return {
      start,
      end: start + planned.newBytes.length,
      startLine: line + (lead.match(/\n/gu)?.length ?? 0),
    }
  }
  if (planned?.newBytes !== undefined && plan.emptied.has(unit)) {
    // The unit now sits where the removed separator began.
    const start = change.from + index.cum[first]
    const gone =
      oldText.slice(change.from, unit.start).match(/\n/gu)?.length ?? 0
    return { start, end: start, startLine: line - gone }
  }
  const start = unit.start + index.cum[first]
  return { start, end: unit.end + index.cum[last + 1], startLine: line }
}

function placeNode<E>(
  unit: Unit<E>,
  index: EditIndex,
  plan: Plan<E>,
  plannedOf: ReadonlyMap<Unit<E>, Planned<E>>,
  ownedOf: ReadonlyMap<Unit<E>, number[]>,
  oldText: string,
): void {
  const owned = ownedOf.get(unit)
  if (owned) {
    // Units that own an edit are few; their range is built as an object.
    const range = ownedRange(
      unit,
      plannedOf.get(unit),
      index,
      plan,
      owned,
      oldText,
    )
    for (const child of unit.children)
      placeNode(child, index, plan, plannedOf, ownedOf, oldText)
    unit.start = range.start
    unit.end = range.end
    unit.startLine = range.startLine
    return
  }
  // The shift loop: numbers only, no allocation per unit and no host call.
  const before = index.beforeStart(unit.start)
  const shift = index.cum[before]
  const lines = index.nl[before]
  for (const child of unit.children)
    placeNode(child, index, plan, plannedOf, ownedOf, oldText)
  unit.end +=
    unit.start === unit.end ? shift : index.cum[index.beforeEnd(unit.end)]
  unit.start += shift
  unit.startLine += lines
}

function settle<E>(
  internals: ModelInternals<E>,
  planned: Planned<E>,
  sequence: number | undefined,
): void {
  const { unit } = planned
  if (planned.newBytes !== undefined) {
    // First change after a baseline: remember the bytes that carried the old canon, so that
    // returning to that canon restores them (handoff 6.7 step 5).
    if (!internals.savedPushed.has(unit) && unit.canon !== undefined) {
      unit.forms = [
        ...unit.forms,
        { canon: unit.canon, bytes: planned.oldBytes },
      ]
      internals.savedPushed.add(unit)
    }
    if (sequence !== undefined) unit.changedAt = sequence
  }
  if (planned.take) {
    const entries = internals.saved?.get(planned.take.canon)
    const at = entries?.indexOf(planned.take.entry as SavedEntry<E>) ?? -1
    if (at >= 0) entries?.splice(at, 1)
  }
  unit.html = planned.html
  unit.canon = planned.canon
  unit.dirty = false
  unit.explicit = false
  internals.dirty.delete(unit)
}

/** First top-level unit whose end reaches `from`: every earlier unit lies before the first change. */
function firstAffected<E>(units: readonly Unit<E>[], from: number): number {
  let lo = 0
  let hi = units.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (units[mid].end < from) lo = mid + 1
    else hi = mid
  }
  return lo
}

function commit<E>(
  internals: ModelInternals<E>,
  plan: Plan<E>,
  sequence: number | undefined,
): TextChange[] {
  const oldText = internals.text
  const edits = [...plan.edits].sort(
    (a, b) => a.change.from - b.change.from || a.change.to - b.change.to,
  )
  const changes = edits.map((e) => e.change)
  const newText = applyChanges(oldText, changes)
  const index = new EditIndex(oldText, edits)
  const ownedOf = new Map<Unit<E>, number[]>()
  for (const [k, edit] of edits.entries())
    ownedOf.set(edit.owner, [...(ownedOf.get(edit.owner) ?? []), k])
  const plannedOf = new Map(plan.planned.map((p) => [p.unit, p]))

  internals.text = newText
  // Units before the first change keep their ranges; the others are placed against the edit index.
  if (edits.length > 0) {
    const { units } = internals
    for (
      let at = firstAffected(units, edits[0].change.from);
      at < units.length;
      at++
    ) {
      placeNode(units[at], index, plan, plannedOf, ownedOf, oldText)
    }
  }
  for (const planned of plan.planned) settle(internals, planned, sequence)
  for (const [row, rebuild] of plan.rowsToRebuild) rebuildCells(row, rebuild)
  internals.structure.clear()
  return changes
}

function handover<E>(
  internals: ModelInternals<E>,
  sequence: number | undefined,
): SyncResult {
  return structureSync
    ? structureSync(internals, sequence)
    : fallback('sync-error')
}

/** The leaf part of a sync: dirty blocks, items, cells and rows; leaves that need the list path are returned, not written. */
export function leafStage<E>(
  internals: ModelInternals<E>,
  sequence: number | undefined,
): SyncResult | Handover<E> {
  try {
    const plan = prepare(internals, dirtyLeaves(internals))
    if ('handover' in plan || 'reason' in plan) return plan
    if ('kind' in plan) return plan
    return { kind: 'changes', changes: commit(internals, plan, sequence) }
  } catch {
    return fallback('sync-error')
  }
}

/** Leaf sync (handoff 6.7). Builds the whole plan first and mutates the model only in `commit`. */
export function syncLeaves<E>(
  internals: ModelInternals<E>,
  sequence: number | undefined,
): SyncResult {
  if (
    internals.structure.size > 0 ||
    dirtyLeaves(internals).some((leaf) => internals.listRouted.has(leaf.unit))
  ) {
    return handover(internals, sequence)
  }
  const result = leafStage(internals, sequence)
  return 'handover' in result ? handover(internals, sequence) : result
}
