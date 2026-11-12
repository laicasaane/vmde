import type { MovableBlock, MovableKind } from '../../../src/shared/block-move'
import {
  originalRowCellSpans,
  splitRow,
} from '../../../src/shared/table-row-splice'
import { pairSourceGroups } from '../nav/unit-pairing'
import { offsetToPosition, type TextChange } from './change-set'
import type { ColumnAlign } from './unit-lute'

// Task 733 text model: the Markdown bytes of the IR document split into units that pair with DOM
// elements. The model is generic over the element type, holds no DOM type and imports no Lute: the
// host adapter (`UnitHost`) supplies HTML, canon and round-trip strings. This module owns build,
// pairing, proof and rebind; leaf sync (model-sync.ts) and structure windows (model-structure.ts)
// plug in through `setSyncImplementation`.

export type UnitKind = MovableKind | 'cell' | 'row'
type UnitProof = 'none' | 'proven' | 'opaque'
interface UnitForm {
  canon: string
  bytes: string
}

export interface Unit<E> {
  kind: UnitKind
  el: E | undefined // undefined: a row unit, or a unit whose element was removed
  members: E[] // all elements of this source block; [el] for a single element
  start: number
  end: number // content range in the model text; start === end for an empty unit
  startLine: number
  proof: UnitProof
  html: string | undefined // normalized HTML at the last sync or proof
  canon: string | undefined
  forms: UnitForm[] // exact-action form first, saved form last
  children: Unit<E>[] // table: row units; row: cell units; otherwise empty
  dirty: boolean
  explicit: boolean // Task 390 explicit edit pending: the next sync writes the canon
  changedAt: number // delta sequence that last changed this unit's bytes in the epoch; 0 when none
}

/** One top-level DOM unit as the adapter lists it. */
export interface HostUnit<E> {
  kind: MovableKind
  members: E[]
  rows?: E[][] // tables only
  align?: ColumnAlign[] // tables only
}

export interface UnitHost<E> {
  /** Top-level units in document order, lists expanded to their items, view-only elements left out. undefined: an element has no kind (section 3.2). */
  listUnits(): HostUnit<E>[] | undefined
  /** Normalized HTML: outerHTML of a block or item, innerHTML of a cell; wrap hints stripped. */
  html(kind: UnitKind, el: E): string
  /** Canon of a unit (section 2.3 functions on the live Lute). */
  serialize(kind: UnitKind, members: readonly E[]): string
  /** serialize(render(source)) for the kind; undefined when Lute is not ready. */
  roundTrip(kind: UnitKind, source: string): string | undefined
  /** Whole-list serialization for a structural list change, split into item sources; items of several DOM lists are serialized once per parent list; undefined when a split gives another item count than the DOM. */
  serializeList(items: readonly E[]): string[] | undefined
}

type OffReason =
  | 'mode'
  | 'not-mounted'
  | 'scan-declined'
  | 'pairing-failed'
  | 'unit-without-kind'
  | 'sync-error'
type FallbackReason =
  | 'model-off'
  | 'unproven-unit'
  | 'unit-without-kind'
  | 'unproven-selection'
  | 'oversize-unit'
  | 'awaiting-rebind'
  | 'too-many-changes'
  | 'sync-error'
export type SyncResult =
  | { kind: 'changes'; changes: TextChange[] } // ascending, against the text before the call; [] when nothing changed
  | { kind: 'fallback'; reason: FallbackReason }

export interface TextModel<E> {
  readonly state: 'off' | 'live'
  readonly offReason: OffReason | undefined // undefined while live
  readonly text: string
  readonly units: readonly Unit<E>[]
  build(text: string): void // scan, pair, shape-check tables; all proofs 'none'
  rebind(text: string): void // new text, same DOM; a unit whose bytes equal its bytes before the call keeps html, canon, proof and forms; dirty flags are kept
  turnOff(reason: OffReason): void
  unitOf(el: E): Unit<E> | undefined // leaf unit whose members or cells hold el
  prove(unit: Unit<E>): UnitProof // first rule that holds; stores html and canon
  markDirty(unit: Unit<E>): void
  markStructureDirty(scope: 'root' | Unit<E>): void // root, a table, or the list run of an item
  markExplicit(unit: Unit<E>): void // Task 390 explicit edit: the next sync writes the canon
  rememberBytes(canon: string, bytes: string): void // task 004: a block restored by Undo with this canon takes these bytes (its form); cleared with the forms
  rememberElement(el: E, kind: UnitKind, bytes: string): void // task 004: `rememberBytes` for the canon of `el`; a unit that already holds `el` takes the form at once
  sync(sequence?: number): SyncResult // section 3.5; applies the changes to text before returning; sets changedAt of changed units to sequence when given
  clearForms(keep?: (unit: Unit<E>) => boolean): void // a clean baseline was recorded; units for which keep is true keep their forms
  markPublishedWhole(): void // the DOM was published through the whole-text path: clear every dirty and structure flag; units that were dirty lose html, canon and proof
  hasDirty(): boolean
}

/** A block that was removed: its elements (still serializable) and its bytes. */
interface RemovedBlock<E> {
  kind: UnitKind
  members: E[]
  bytes: string
  /** Cheap key of a table: its lines and its columns, compared before any canon is taken. */
  lines: number
  columns: number
  /** Canon, once taken. */
  canon: string | undefined
}

/** The row of each cell unit (the unit tree has no parent links). */
export const rowOfCell = new WeakMap<object, object>()

/** Saved bytes of a canon (rule 3.5 step 1), in document order. */
export interface SavedEntry<E> {
  bytes: string
  owner: Unit<E> | undefined
}

/** Internal state of one model, for model-sync.ts and model-structure.ts (not part of the interface). */
export interface ModelInternals<E> {
  readonly host: UnitHost<E>
  readonly scan: (text: string) => MovableBlock[]
  text: string
  units: Unit<E>[]
  readonly structure: Set<'root' | Unit<E>>
  /** Units with `dirty` set: sync visits these only (P5), never the whole tree. */
  readonly dirty: Set<Unit<E>>
  /** Blocks that left the document since the last baseline; their canon is taken only when a new block of the kind needs saved bytes. */
  removed: RemovedBlock<E>[]
  readonly savedPushed: Set<Unit<E>>
  readonly listRouted: Set<Unit<E>>
  saved: Map<string, SavedEntry<E>[]> | undefined
  /** Bytes the history restore remembered by canon; they join the saved index (rule 3.5 step 1). */
  remembered: Array<{ canon: string; bytes: string }>
  /** Every member element to its leaf unit; a table element to the table; a cell to its cell unit, or to its span-less row. */
  readonly byElement: Map<E, Unit<E>>
  /** Host kind of every element of the last listing. */
  readonly hostKinds: Map<E, MovableKind>
  /** Recomputes `byElement` and `hostKinds` from the current units. */
  reindex(listing: readonly HostUnit<E>[] | undefined): void
  /** Turns the model off (structure windows that meet an element without a kind). */
  turnOff(reason: OffReason): void
}

/** Sync implementation seam: model-sync.ts registers itself here (Task 733 segment 003-E). */
export type SyncImplementation = <E>(
  internals: ModelInternals<E>,
  sequence: number | undefined,
) => SyncResult

let syncImplementation: SyncImplementation | undefined
export function setSyncImplementation(
  implementation: SyncImplementation | undefined,
): void {
  syncImplementation = implementation
}

const internalsByModel = new WeakMap<object, ModelInternals<never>>()
export function modelInternals<E>(model: TextModel<E>): ModelInternals<E> {
  const internals = internalsByModel.get(model)
  if (!internals) throw new TypeError('not a text model')
  return internals as unknown as ModelInternals<E>
}

const MARKER = /^(?:[-+*]|\d{1,9}[.)])/u
const ORDERED_MARKER = /^\d{1,9}[.)]/u
const DELIMITER_CELL = /^:?-+:?$/u

/** Leading list marker of a list item source. */
export function markerOf(source: string): string {
  return MARKER.exec(source)?.[0] ?? ''
}

/** Joined normalized HTML of a unit's members (a row's members are cells). */
export function unitHtml<E>(host: UnitHost<E>, unit: Unit<E>): string {
  const kind: UnitKind = unit.kind === 'row' ? 'cell' : unit.kind
  return unit.members.map((member) => host.html(kind, member)).join('\u0000')
}

function alignOf(cell: string): ColumnAlign {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (left) return 'left'
  return right ? 'right' : 'default'
}

export function newUnit<E>(
  kind: UnitKind,
  members: E[],
  start: number,
  end: number,
  startLine: number,
): Unit<E> {
  return {
    kind,
    el: members[0],
    members,
    start,
    end,
    startLine,
    proof: 'none',
    html: undefined,
    canon: undefined,
    forms: [],
    children: [],
    dirty: false,
    explicit: false,
    changedAt: 0,
  }
}

/** Table shape check of rule 3.3: lines against DOM rows, delimiter row against the DOM alignment. */
export function tableShapeMatches<E>(
  lines: string[],
  host: HostUnit<E>,
): boolean {
  const rows = host.rows
  if (!rows || lines.length !== rows.length + 1) return false
  const delimiter = splitRow(lines[1])
  if (
    delimiter.length === 0 ||
    !delimiter.every((cell) => DELIMITER_CELL.test(cell))
  )
    return false
  const align = host.align ?? []
  if (
    delimiter.length !== align.length ||
    delimiter.some((cell, i) => alignOf(cell) !== align[i])
  )
    return false
  return lines.every(
    (line, index) =>
      index === 1 ||
      splitRow(line).length === rows[index === 0 ? 0 : index - 1].length,
  )
}

/** Row and cell units of a table whose shape matched (handoff 6.2). */
export function tableChildren<E>(
  table: Unit<E>,
  lines: string[],
  host: HostUnit<E>,
): Unit<E>[] {
  const rows = host.rows as E[][]
  const children: Unit<E>[] = []
  let lineStart = table.start
  for (const [index, line] of lines.entries()) {
    const members = index === 1 ? [] : rows[index === 0 ? 0 : index - 1]
    children.push(
      buildRow(index, line, lineStart, table.startLine + index, members),
    )
    lineStart += line.length + 1
  }
  return children
}

/** One row unit of a table: line `index` (1 is the delimiter row), its cell units when the content spans can be proven. */
export function buildRow<E>(
  index: number,
  line: string,
  lineStart: number,
  startLine: number,
  members: readonly E[],
): Unit<E> {
  const row = newUnit<E>(
    'row',
    [...members],
    lineStart,
    lineStart + line.length,
    startLine,
  )
  row.el = undefined
  if (index !== 1) {
    const spans = originalRowCellSpans(line, splitRow(line))
    if (spans) {
      row.children = spans.map((span, j) =>
        newUnit<E>(
          'cell',
          [members[j]],
          lineStart + span.contentStart,
          lineStart + span.contentEnd,
          startLine,
        ),
      )
      for (const cell of row.children) rowOfCell.set(cell, row)
    }
  }
  return row
}

/** Index of a unit in an ordered unit list: binary search on the start, then identity among equal starts. */
export function indexOfUnit<E>(
  units: readonly Unit<E>[],
  unit: Unit<E>,
): number {
  let lo = 0
  let hi = units.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (units[mid].start < unit.start) lo = mid + 1
    else hi = mid
  }
  for (let at = lo; at < units.length && units[at].start === unit.start; at++) {
    if (units[at] === unit) return at
  }
  return units.indexOf(unit)
}

interface Layout<E> {
  units: Unit<E>[]
  listing: HostUnit<E>[]
}

/** Scan, list, pair and shape-check (handoff 6.3 steps 1 to 5): one `scan` and one `listUnits`, no Lute work. */
function layoutUnits<E>(
  host: UnitHost<E>,
  scan: (text: string) => MovableBlock[],
  text: string,
): Layout<E> | OffReason {
  if (text.trim() === '') return { units: [], listing: [] }
  const blocks = scan(text)
  if (blocks.length === 0) return 'scan-declined'
  const listing = host.listUnits()
  if (!listing) return 'unit-without-kind'
  const hostOf = new Map<E, HostUnit<E>>()
  for (const hostUnit of listing)
    for (const member of hostUnit.members) hostOf.set(member, hostUnit)
  const pairs = pairSourceGroups(
    blocks,
    [...hostOf.keys()],
    (element) => hostOf.get(element)?.kind ?? null,
  )
  if (!pairs) return 'pairing-failed'
  const units: Unit<E>[] = []
  let previous: { offset: number; line: number } | undefined
  for (const { block, members } of pairs) {
    const line = offsetToPosition(text, block.start, previous).line
    previous = { offset: block.start, line }
    const unit = newUnit<E>(block.kind, members, block.start, block.end, line)
    const hostUnit = hostOf.get(members[0])
    if (unit.kind === 'table' && hostUnit) {
      const lines = text.slice(block.start, block.end).split('\n')
      if (tableShapeMatches(lines, hostUnit))
        unit.children = tableChildren(unit, lines, hostUnit)
      else unit.proof = 'opaque'
    }
    units.push(unit)
  }
  return { units, listing }
}

const sameMembers = <E>(a: readonly E[], b: readonly E[]): boolean =>
  a.length === b.length && a.every((member, index) => member === b[index])

interface RebindContext<E> {
  internals: ModelInternals<E>
  oldText: string
  newText: string
  oldRouted: ReadonlySet<Unit<E>>
  oldSaved: ReadonlySet<Unit<E>>
  carried: Map<Unit<E>, Unit<E>>
}

/** Carries state from an old unit to the new unit that holds the same first element (rebind, handoff 6.5). */
function carryState<E>(
  old: Unit<E>,
  fresh: Unit<E>,
  context: RebindContext<E>,
): void {
  const { internals } = context
  context.carried.set(old, fresh)
  // Dirty flags and the pushed saved form follow the element even when the bytes changed.
  fresh.dirty = old.dirty
  if (fresh.dirty) internals.dirty.add(fresh)
  fresh.explicit = old.explicit
  fresh.changedAt = old.changedAt
  if (context.oldSaved.has(old)) internals.savedPushed.add(fresh)
  const sameBytes =
    old.kind === fresh.kind &&
    sameMembers(old.members, fresh.members) &&
    context.oldText.slice(old.start, old.end) ===
      context.newText.slice(fresh.start, fresh.end)
  if (sameBytes) {
    fresh.html = old.html
    fresh.canon = old.canon
    fresh.proof = old.proof
    fresh.forms = old.forms
    if (context.oldRouted.has(old)) internals.listRouted.add(fresh)
  }
  for (const [index, child] of fresh.children.entries()) {
    const oldChild = old.children[index]
    const sameOwner =
      oldChild !== undefined &&
      oldChild.kind === child.kind &&
      (child.kind === 'row'
        ? sameMembers(oldChild.members, child.members)
        : oldChild.el === child.el)
    if (sameOwner) carryState(oldChild, child, context)
  }
}

/** Maps the elements of a unit (and of its rows and cells) to their leaf units. */
export function indexUnit<E>(
  internals: ModelInternals<E>,
  unit: Unit<E>,
): void {
  const claim = (leaf: Unit<E>): void => {
    for (const member of leaf.members) internals.byElement.set(member, leaf)
  }
  claim(unit)
  for (const row of unit.children) {
    // A row without cell units is itself the leaf of its cell elements.
    if (row.children.length === 0) claim(row)
    for (const cell of row.children) claim(cell)
  }
}

/** Removes the elements of a unit (and of its rows and cells) from the element map. */
export function unindexUnit<E>(
  internals: ModelInternals<E>,
  unit: Unit<E>,
): void {
  for (const member of unit.members) internals.byElement.delete(member)
  for (const row of unit.children) {
    for (const member of row.members) internals.byElement.delete(member)
    for (const cell of row.children)
      for (const member of cell.members) internals.byElement.delete(member)
  }
}

function reindexUnits<E>(
  internals: ModelInternals<E>,
  listing: readonly HostUnit<E>[] | undefined,
): void {
  internals.byElement.clear()
  internals.hostKinds.clear()
  for (const hostUnit of listing ?? []) {
    for (const member of hostUnit.members)
      internals.hostKinds.set(member, hostUnit.kind)
  }
  const claim = (unit: Unit<E>): void => {
    for (const member of unit.members) internals.byElement.set(member, unit)
  }
  for (const unit of internals.units) {
    claim(unit)
    for (const row of unit.children) {
      // A row without cell units is itself the leaf of its cell elements.
      if (row.children.length === 0) claim(row)
      for (const cell of row.children) claim(cell)
    }
  }
}

function eachUnit<E>(
  units: readonly Unit<E>[],
  visit: (unit: Unit<E>) => void,
): void {
  for (const unit of units) {
    visit(unit)
    eachUnit(unit.children, visit)
  }
}

function proveCell<E>(
  host: UnitHost<E>,
  unit: Unit<E>,
  bytes: string,
): UnitProof {
  const canon = host.serialize('cell', [unit.members[0]])
  unit.html = unitHtml(host, unit)
  unit.canon = canon
  if (bytes === canon) return 'proven'
  const trip = host.roundTrip('cell', bytes)
  if (trip === undefined) return 'none'
  return trip === canon ? 'proven' : 'opaque'
}

// A row without provable cell spans is edited as a row: its cells' canons joined, or the cells
// of its source line matching those canons one by one.
function proveSpanlessRow<E>(
  host: UnitHost<E>,
  unit: Unit<E>,
  bytes: string,
): UnitProof {
  const canons = unit.members.map((member) => host.serialize('cell', [member]))
  unit.html = unitHtml(host, unit)
  unit.canon = `| ${canons.join(' | ')} |`
  if (bytes === unit.canon) return 'proven'
  const cells = splitRow(bytes)
  if (cells.length !== canons.length) return 'opaque'
  for (const [j, cell] of cells.entries()) {
    if (cell === canons[j]) continue
    const trip = host.roundTrip('cell', cell)
    if (trip === undefined) return 'none'
    if (trip !== canons[j]) return 'opaque'
  }
  return 'proven'
}

function proveBlock<E>(
  internals: ModelInternals<E>,
  unit: Unit<E>,
  bytes: string,
): UnitProof {
  const { host } = internals
  const kind = unit.kind as MovableKind
  unit.html = unitHtml(host, unit)
  const canon = host.serialize(kind, unit.members)
  unit.canon = canon
  if (bytes === canon) return 'proven'
  const trip = host.roundTrip(kind, bytes)
  if (trip === undefined) return 'none'
  if (trip === canon) return 'proven'
  if (
    kind === 'list-item' &&
    ORDERED_MARKER.test(markerOf(canon)) &&
    markerOf(canon) !== markerOf(bytes)
  ) {
    // The isolated item renumbers (`2. b` isolates as `1. b`): it is no leaf unit, but a list
    // structure change can still write it when the canon with its own marker equals its bytes.
    if (canon.replace(MARKER, markerOf(bytes)) === bytes)
      internals.listRouted.add(unit)
  }
  return 'opaque'
}

function proveRow<E>(
  internals: ModelInternals<E>,
  unit: Unit<E>,
  bytes: string,
): UnitProof {
  if (unit.members.length === 0) return 'proven'
  if (unit.children.length === 0)
    return proveSpanlessRow(internals.host, unit, bytes)
  const results = unit.children.map((cell) => proveUnit(internals, cell))
  if (results.includes('opaque')) return 'opaque'
  return results.includes('none') ? 'none' : 'proven'
}

/** First rule that holds (handoff 6.4); stores `html` and `canon`. */
function proveUnit<E>(internals: ModelInternals<E>, unit: Unit<E>): UnitProof {
  if (unit.proof !== 'none') return unit.proof
  const bytes = internals.text.slice(unit.start, unit.end)
  let proof: UnitProof
  if (
    unit.kind === 'html-group' &&
    unit.members.some(
      (member) => internals.hostKinds.get(member) === 'list-item',
    )
  ) {
    proof = 'opaque'
  } else if (unit.kind === 'table') {
    proof = unit.children.length > 0 ? 'proven' : 'opaque'
  } else if (unit.kind === 'row') {
    proof = proveRow(internals, unit, bytes)
  } else if (unit.kind === 'cell') {
    proof = proveCell(internals.host, unit, bytes)
  } else {
    proof = proveBlock(internals, unit, bytes)
  }
  unit.proof = proof
  return proof
}

function resetState<E>(internals: ModelInternals<E>): void {
  internals.units = []
  internals.structure.clear()
  internals.dirty.clear()
  internals.removed = []
  internals.savedPushed.clear()
  internals.listRouted.clear()
  internals.saved = undefined
  internals.remembered = []
  internals.byElement.clear()
  internals.hostKinds.clear()
}

/** Pairs again against the current DOM listing and carries state over (handoff 6.5); returns the off reason on failure. */
function rebindUnits<E>(
  internals: ModelInternals<E>,
  text: string,
): OffReason | undefined {
  const context: RebindContext<E> = {
    internals,
    oldText: internals.text,
    newText: text,
    oldRouted: new Set(internals.listRouted),
    oldSaved: new Set(internals.savedPushed),
    carried: new Map(),
  }
  const oldByElement = new Map(internals.byElement)
  const oldStructure = [...internals.structure]
  const oldSaved = internals.saved
  const layout = layoutUnits(internals.host, internals.scan, text)
  if (typeof layout === 'string') return layout
  internals.savedPushed.clear()
  internals.listRouted.clear()
  internals.dirty.clear()
  for (const fresh of layout.units) {
    const old = oldByElement.get(fresh.members[0])
    if (old) carryState(old, fresh, context)
  }
  internals.text = text
  internals.units = layout.units
  reindexUnits(internals, layout.listing)
  // A scope that no longer exists widens to the root; a saved form whose owner is gone loses its owner.
  internals.structure.clear()
  for (const scope of oldStructure) {
    internals.structure.add(
      scope === 'root' ? 'root' : (context.carried.get(scope) ?? 'root'),
    )
  }
  if (oldSaved) {
    internals.saved = new Map(
      [...oldSaved].map(([canon, entries]) => [
        canon,
        entries.map((entry) => ({
          bytes: entry.bytes,
          owner: entry.owner && context.carried.get(entry.owner),
        })),
      ]),
    )
  }
  return undefined
}

export function createTextModel<E>(
  host: UnitHost<E>,
  scan: (text: string) => MovableBlock[],
): TextModel<E> {
  let state: 'off' | 'live' = 'live'
  let offReason: OffReason | undefined
  const internals: ModelInternals<E> = {
    host,
    scan,
    text: '',
    units: [],
    structure: new Set(),
    dirty: new Set(),
    removed: [],
    savedPushed: new Set(),
    listRouted: new Set(),
    saved: undefined,
    remembered: [],
    byElement: new Map(),
    hostKinds: new Map(),
    reindex: (listing) => reindexUnits(internals, listing),
    turnOff: (reason) => goOff(reason),
  }
  const goOff = (reason: OffReason, text?: string): void => {
    state = 'off'
    offReason = reason
    resetState(internals)
    if (text !== undefined) internals.text = text
  }

  const model: TextModel<E> = {
    get state() {
      return state
    },
    get offReason() {
      return offReason
    },
    get text() {
      return internals.text
    },
    get units() {
      return internals.units
    },
    build(text) {
      resetState(internals)
      const layout = layoutUnits(host, scan, text)
      if (typeof layout === 'string') return goOff(layout, text)
      state = 'live'
      offReason = undefined
      internals.text = text
      internals.units = layout.units
      reindexUnits(internals, layout.listing)
    },
    rebind(text) {
      const reason = rebindUnits(internals, text)
      if (reason) return goOff(reason, text)
      state = 'live'
      offReason = undefined
    },
    turnOff(reason) {
      goOff(reason)
    },
    unitOf: (el) => internals.byElement.get(el),
    prove: (unit) => proveUnit(internals, unit),
    markDirty(unit) {
      unit.dirty = true
      internals.dirty.add(unit)
    },
    markStructureDirty(scope) {
      internals.structure.add(scope)
    },
    rememberBytes(canon, bytes) {
      // Bounded: an Undo restores a few units, and the list ends at the next baseline.
      // The newest bytes of a canon win: a Redo hands back what an Undo replaced.
      internals.remembered = internals.remembered.filter(
        (r) => r.canon !== canon,
      )
      if (internals.remembered.length >= 256) internals.remembered.shift()
      internals.remembered.push({ canon, bytes })
      // An index that is already built takes the entry now; one that is built later reads the list.
      internals.saved?.set(canon, [
        // An owner-less entry of this canon is stale now (the newest bytes win).
        ...(internals.saved.get(canon) ?? []).filter(
          (e) => e.owner !== undefined,
        ),
        { bytes, owner: undefined },
      ])
    },
    rememberElement(el, kind, bytes) {
      const canon = internals.host.serialize(kind, [el])
      // A cell is written for a table context: its form stays with its unit and out of the index.
      if (kind !== 'cell') model.rememberBytes(canon, bytes)
      const unit = internals.byElement.get(el)
      if (unit && !unit.forms.some((form) => form.canon === canon)) {
        unit.forms = [...unit.forms, { canon, bytes }]
      }
    },
    markExplicit(unit) {
      unit.explicit = true
      unit.dirty = true
      internals.dirty.add(unit)
    },
    sync(sequence) {
      if (state === 'off') return { kind: 'fallback', reason: 'model-off' }
      if (!syncImplementation) return { kind: 'fallback', reason: 'sync-error' }
      try {
        return syncImplementation(internals, sequence)
      } catch {
        return { kind: 'fallback', reason: 'sync-error' }
      }
    },
    clearForms(keep) {
      eachUnit(internals.units, (unit) => {
        if (keep?.(unit)) return
        unit.forms = []
        internals.savedPushed.delete(unit)
      })
      internals.saved = undefined
      internals.remembered = []
      internals.removed = []
    },
    markPublishedWhole() {
      for (const unit of internals.dirty) {
        unit.dirty = false
        unit.explicit = false
        unit.html = undefined
        unit.canon = undefined
        unit.proof = 'none'
        internals.listRouted.delete(unit)
      }
      internals.dirty.clear()
      internals.structure.clear()
    },
    hasDirty: () => internals.dirty.size > 0 || internals.structure.size > 0,
  }
  internalsByModel.set(model, internals as unknown as ModelInternals<never>)
  return model
}
