import { tableRowPipeOffsets } from '../../../src/shared/table-code-pipes'
import { splitRow } from '../../../src/shared/table-row-splice'
import {
  applyChanges,
  offsetToPosition,
  singleSpanDiff,
  type TextChange,
} from './change-set'
import {
  leafStage,
  setStructureSync,
  type StructureSync,
  syncLeaves,
} from './model-sync'
import {
  type HostUnit,
  type ModelInternals,
  markerOf,
  indexOfUnit,
  indexUnit,
  newUnit,
  type SavedEntry,
  setSyncImplementation,
  unindexUnit,
  type SyncResult,
  buildRow,
  rowOfCell,
  tableChildren,
  tableShapeMatches,
  type Unit,
  unitHtml,
} from './text-model'
import { delimiterLine } from './unit-lute'

// Structure windows of the text model (Task 733, handoff 6.8 to 6.10, 6.12): the root window by
// element identity, table rows and columns, and the list run. Every stage builds its result first
// and writes the model only at its end; a failed sync restores the state captured at the start.

const fallback = (reason: 'sync-error' | 'unit-without-kind'): SyncResult => ({
  kind: 'fallback',
  reason,
})

type Ctx<E> = ModelInternals<E>

// ---- Undo journal: a failed sync leaves every unit exactly as it was. ----
//
// A stage records the first state of each unit it is about to change (copy on write), the set
// changes and the index changes. Nothing is copied up front, so the cost follows the changed units (P5).

class Journal {
  private readonly undo: Array<() => void> = []
  private readonly seen = new Set<object>()

  /** Remembers the fields of a unit before its first change. */
  unit<E>(unit: Unit<E>): void {
    if (this.seen.has(unit)) return
    this.seen.add(unit)
    const copy = { ...unit }
    this.undo.push(() => Object.assign(unit, copy))
  }

  run(undo: () => void): void {
    this.undo.push(undo)
  }

  rollback(): void {
    for (let at = this.undo.length - 1; at >= 0; at--) this.undo[at]()
  }
}

let journal: Journal | undefined

const touch = <E>(unit: Unit<E>): void => journal?.unit(unit)

function setAdd<T>(set: Set<T>, value: T): void {
  if (set.has(value)) return
  set.add(value)
  journal?.run(() => set.delete(value))
}

function setDelete<T>(set: Set<T>, value: T): void {
  if (!set.delete(value)) return
  journal?.run(() => set.add(value))
}

function walk<E>(
  units: readonly Unit<E>[],
  visit: (unit: Unit<E>) => void,
): void {
  for (const unit of units) {
    visit(unit)
    walk(unit.children, visit)
  }
}

// ---- Saved-bytes index (rule 3.5 step 1). ----

/** Entries come from `proven` units only: the bytes of an unproven or opaque unit are never reused (P4). */
function ensureSaved<E>(i: Ctx<E>): Map<string, SavedEntry<E>[]> {
  if (i.saved) return i.saved
  const saved = new Map<string, SavedEntry<E>[]>()
  for (const unit of i.units) {
    if (unit.canon === undefined || unit.proof !== 'proven') continue
    const bytes =
      unit.forms.find((f) => f.canon === unit.canon)?.bytes ??
      i.text.slice(unit.start, unit.end)
    saved.set(unit.canon, [
      ...(saved.get(unit.canon) ?? []),
      { bytes, owner: unit },
    ])
  }
  // Bytes a history restore remembered (task 004): owner-less, like the bytes of a removed block.
  for (const { canon, bytes } of i.remembered) {
    saved.set(canon, [...(saved.get(canon) ?? []), { bytes, owner: undefined }])
  }
  i.saved = saved
  journal?.run(() => {
    i.saved = undefined
  })
  return saved
}

/**
 * Bytes for a new block of `kind` with this canon: the first owner-less saved entry, else a removed
 * block of the kind whose canon (taken now, once) is the same. Removed blocks are not serialized when
 * they leave the document (P5): their canon is taken only when a new block of the kind needs bytes.
 */
function takeSaved<E>(
  i: Ctx<E>,
  canon: string,
  kind: Unit<E>['kind'],
  shape?: { lines: number; columns: number },
): string | undefined {
  const entries = ensureSaved(i).get(canon)
  const index = entries?.findIndex((entry) => entry.owner === undefined) ?? -1
  if (entries && index >= 0) {
    const [entry] = entries.splice(index, 1)
    journal?.run(() => entries.splice(index, 0, entry))
    return entry.bytes
  }
  for (const [at, block] of i.removed.entries()) {
    if (block.kind !== kind) continue
    // Only a candidate with the same lines and columns is serialized (P5).
    if (
      shape &&
      (block.lines !== shape.lines || block.columns !== shape.columns)
    )
      continue
    block.canon ??= i.host.serialize(block.kind, block.members)
    if (block.canon !== canon) continue
    const before = i.removed
    i.removed = i.removed.filter((_, k) => k !== at)
    journal?.run(() => {
      i.removed = before
    })
    return block.bytes
  }
  return undefined
}

function releaseSaved<E>(i: Ctx<E>, removed: ReadonlySet<Unit<E>>): void {
  if (!i.saved) return
  for (const entries of i.saved.values()) {
    for (const entry of entries) {
      if (!entry.owner || !removed.has(entry.owner)) continue
      const owner = entry.owner
      entry.owner = undefined
      journal?.run(() => {
        entry.owner = owner
      })
    }
  }
}

const REMOVED_LIMIT = 32

/** A removed table is kept as it was (elements and bytes), without a canon: the canon is taken when a paste needs it. */
function rememberRemoved<E>(i: Ctx<E>, unit: Unit<E>): void {
  if (
    unit.kind !== 'table' ||
    unit.children.length === 0 ||
    unit.proof !== 'proven' ||
    unit.canon !== undefined
  )
    return
  const before = i.removed
  i.removed = [
    ...i.removed,
    {
      kind: unit.kind,
      members: [...unit.members],
      bytes: i.text.slice(unit.start, unit.end),
      lines: unit.children.length,
      columns: unit.children[0].members.length,
      canon: undefined,
    },
  ].slice(-REMOVED_LIMIT)
  journal?.run(() => {
    i.removed = before
  })
}

// ---- Helpers. ----

const hasContent = <E>(unit: Unit<E>): boolean => unit.start < unit.end

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

const lineCount = (text: string): number => text.split('\n').length - 1

function flagDirty<E>(i: Ctx<E>, unit: Unit<E>): void {
  touch(unit)
  unit.dirty = true
  setAdd(i.dirty, unit)
}

/** Moves units after `index` by a text delta and a line delta. */
function shiftAfter<E>(
  units: readonly Unit<E>[],
  delta: number,
  lines: number,
): void {
  for (const unit of units) {
    walk([unit], (u) => {
      u.start += delta
      u.end += delta
      u.startLine += lines
    })
  }
}

interface Entry<E> {
  unit: Unit<E> | undefined
  el: E | undefined // the new element of a unit to create
  kind: Unit<E>['kind']
  bytes: string
  oldIndex: number // index in the old units, -1 for a new unit
  item: boolean
}

// ---- Root window (handoff 6.8) with the list rules (6.10). ----

interface RootResult<E> {
  changes: TextChange[]
  tables: Array<{ table: Unit<E>; host: HostUnit<E> }>
}

interface Window<E> {
  u0: number
  u1: number
  newEls: E[]
  /** The host units of the window, so that no map over the whole listing is built (P5). */
  hosts: HostUnit<E>[]
}

/** Host units that hold the elements `from` to `to` of the listing. */
function hostsBetween<E>(
  listing: readonly HostUnit<E>[],
  from: number,
  to: number,
): HostUnit<E>[] {
  const out: HostUnit<E>[] = []
  let count = 0
  for (const h of listing) {
    const next = count + h.members.length
    if (next > from && count < to) out.push(h)
    if (count >= to) break
    count = next
  }
  return out
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: window by identity with list-run widening and forced runs (handoff 6.8 step 2, 6.10 step 1)
function computeWindow<E>(
  i: Ctx<E>,
  listing: readonly HostUnit<E>[],
  forced: ReadonlySet<Unit<E>>,
): Window<E> | undefined {
  const { units } = i
  const oldEls: E[] = []
  const unitOfOld: number[] = []
  const firstOf: number[] = []
  units.forEach((unit, index) => {
    firstOf.push(oldEls.length)
    for (const member of unit.members) {
      oldEls.push(member)
      unitOfOld.push(index)
    }
  })
  const newEls = listing.flatMap((h) => h.members)
  const shortest = Math.min(oldEls.length, newEls.length)
  let p = 0
  while (p < shortest && oldEls[p] === newEls[p]) p++
  let s = 0
  while (
    s < shortest - p &&
    oldEls[oldEls.length - 1 - s] === newEls[newEls.length - 1 - s]
  )
    s++
  // Whole old units only.
  while (p > 0 && p < oldEls.length && unitOfOld[p - 1] === unitOfOld[p]) p--
  while (
    s > 0 &&
    s < oldEls.length &&
    unitOfOld[oldEls.length - s - 1] === unitOfOld[oldEls.length - s]
  )
    s--
  let u0 = p < oldEls.length ? unitOfOld[p] : units.length
  let u1 = s > 0 ? unitOfOld[oldEls.length - s] : units.length
  if (u1 < u0) u1 = u0
  for (const unit of forced) {
    const index = units.indexOf(unit)
    if (index >= 0) {
      u0 = Math.min(u0, index)
      u1 = Math.max(u1, index + 1)
    }
  }
  const elementStart = (index: number): number =>
    index < units.length ? firstOf[index] : oldEls.length
  const windowHasItem = (a: number, b: number): boolean =>
    units.slice(a, b).some((u) => u.kind === 'list-item') ||
    hostsBetween(
      listing,
      elementStart(a),
      newEls.length - (oldEls.length - elementStart(b)),
    ).some((h) => h.kind === 'list-item')
  if (windowHasItem(u0, u1)) {
    // The run stops where the marker style changes: that is where one list ends and the next begins
    // (Q-68 (2), Q-87; adjacent lists of one style would be one list).
    while (u0 > 0 && continuesRun(i, units[u0 - 1], units[u0])) u0--
    while (u1 < units.length && continuesRun(i, units[u1], units[u1 - 1])) u1++
  }
  const prefix = elementStart(u0)
  const suffix = oldEls.length - elementStart(u1)
  if (newEls.length - suffix < prefix) return undefined
  return {
    u0,
    u1,
    newEls: newEls.slice(prefix, newEls.length - suffix),
    hosts: hostsBetween(listing, prefix, newEls.length - suffix),
  }
}

/** The marker style of an item source: the bullet character, or `ordered` and the delimiter. */
function markerStyle(source: string): string {
  const marker = markerOf(source)
  return /^\d/u.test(marker) ? `ordered${marker.slice(-1)}` : marker
}

/**
 * `candidate` (a unit next to the window) joins the window's list run: it is a list item, and when its
 * window-side neighbour is a list item too, both have one marker style. A style change is where one list
 * ends and the next begins.
 */
function continuesRun<E>(
  i: Ctx<E>,
  candidate: Unit<E>,
  inside: Unit<E> | undefined,
): boolean {
  if (candidate.kind !== 'list-item') return false
  if (!inside || inside.kind !== 'list-item') return true
  // A marker is at most 9 digits and a delimiter: a bounded read, not the item's text (F-4).
  const head = (u: Unit<E>): string =>
    i.text.slice(u.start, Math.min(u.end, u.start + 11))
  return markerStyle(head(candidate)) === markerStyle(head(inside))
}

/** Separator rule of rule 3.5 step 1 and 6.10 step 4 between two neighbouring entries. */
function separator<E>(
  i: Ctx<E>,
  previous: Entry<E>,
  entry: Entry<E>,
  run: { used: string | undefined; first: string | undefined },
): string {
  if (
    previous.oldIndex >= 0 &&
    entry.oldIndex === previous.oldIndex + 1 &&
    previous.unit &&
    entry.unit
  ) {
    const sep = i.text.slice(previous.unit.end, entry.unit.start)
    if (previous.item && entry.item) run.used = sep
    return sep
  }
  if (previous.item && entry.item) return run.used ?? run.first ?? '\n'
  return '\n\n'
}

/** Unit for a new element (rule c): canon from the live Lute, bytes from the saved index or the canon. */
function createUnit<E>(i: Ctx<E>, entry: Entry<E>): Unit<E> {
  const el = entry.el as E
  const unit = newUnit<E>(entry.kind, [el], 0, 0, 0)
  unit.html = i.host.html(entry.kind as never, el)
  unit.canon = i.host.serialize(entry.kind, [el])
  unit.proof = 'proven'
  return unit
}

// ---- Item-level list structure (Task 733 / 011, shared rules 3.8). ----

const ORDERED_NUMBER = /^(\d{1,9})(?=[.)])/u
const ORDERED_MARKER_PREFIX = /^\d{1,9}[.)]/u
const LOOSE_ITEM_HTML = /^<li\b[^>]*>\s*<p\b/u

/** The number of an ordered item source, or undefined for a bullet item. */
function orderedNumber(source: string): number | undefined {
  const match = ORDERED_NUMBER.exec(source)
  return match ? Number(match[1]) : undefined
}

const bothOrdered = (a: string, b: string): boolean =>
  ORDERED_NUMBER.test(a) && ORDERED_NUMBER.test(b)

/** An ordered item source with its number replaced; the delimiter and the rest of the bytes stay. */
const withNumber = (source: string, number: number): string =>
  source.replace(ORDERED_NUMBER, String(number))

/**
 * The tight single-list form of the item path: every old item of the window joins the next with one
 * newline and holds no blank line, and no new item starts with a paragraph (loose form). The window
 * holds one list run (`sameListRun`). Bounded reads only: no slice of the items' text (F-4).
 */
function tightRun<E>(
  i: Ctx<E>,
  itemEntries: readonly Entry<E>[],
  olds: ReadonlyArray<Unit<E> | undefined>,
  oldItems: readonly Unit<E>[],
): boolean {
  const { text } = i
  for (let k = 0; k < oldItems.length; k++) {
    const unit = oldItems[k]
    const blank = text.indexOf('\n\n', unit.start)
    if (blank !== -1 && blank < unit.end) return false
    const next = oldItems[k + 1]
    if (next && (next.start !== unit.end + 1 || text[unit.end] !== '\n'))
      return false
  }
  for (let j = 0; j < itemEntries.length; j++) {
    if (olds[j] !== undefined) continue
    const html = i.host.html('list-item', itemEntries[j].el as never)
    if (LOOSE_ITEM_HTML.test(html)) return false
  }
  return true
}

/**
 * Task 733 / 012-11: pairs the new item elements no old unit holds by identity with old items of equal
 * stored HTML, from both ends of each gap between identity anchors (in place in `olds`). Returns the
 * paired old units, or false when the anchors are out of the old order.
 */
function pairByHtml<E>(
  i: Ctx<E>,
  itemEntries: readonly Entry<E>[],
  olds: Array<Unit<E> | undefined>,
  oldItems: readonly Unit<E>[],
): Set<Unit<E>> | false {
  const paired = new Set<Unit<E>>()
  let p = 0
  let j0 = 0
  for (let j = 0; j <= itemEntries.length; j++) {
    const anchor = j < itemEntries.length ? olds[j] : undefined
    if (j < itemEntries.length && anchor === undefined) continue
    const q =
      anchor === undefined ? oldItems.length : oldItems.indexOf(anchor, p)
    if (q === -1) return false
    pairGap(i, itemEntries, olds, oldItems, { j0, j, p, q }, paired)
    p = q + 1
    j0 = j + 1
  }
  return paired
}

/** One gap of `pairByHtml`: new entries [j0, j) against old items [p, q), matched from both ends. */
function pairGap<E>(
  i: Ctx<E>,
  itemEntries: readonly Entry<E>[],
  olds: Array<Unit<E> | undefined>,
  oldItems: readonly Unit<E>[],
  gap: { j0: number; j: number; p: number; q: number },
  paired: Set<Unit<E>>,
): void {
  const same = (k: number, old: Unit<E>): boolean =>
    old.html !== undefined &&
    old.html === i.host.html('list-item', itemEntries[k].el as never)
  const pair = (k: number, old: Unit<E>): void => {
    olds[k] = old
    paired.add(old)
  }
  let a = gap.j0
  let b = gap.p
  while (a < gap.j && b < gap.q && same(a, oldItems[b]))
    pair(a++, oldItems[b++])
  let c = gap.j - 1
  let d = gap.q - 1
  while (c >= a && d >= b && same(c, oldItems[d])) pair(c--, oldItems[d--])
}

/**
 * Shared rules 3.8: Enter or Delete that adds or removes items of one tight list, decided by element
 * identity without a whole-list serialization. Unchanged items keep their bytes; a new item takes its
 * canon (one `serializeListItemHtml`); an ordered list numbers each item from the one before it in
 * JavaScript (the canon of an item alone starts with `1.`). A bullet item edited in place keeps its
 * old bytes here and stays dirty for the leaf stage. Task 733 / 012-11: in a bullet list, the new
 * elements between items kept by identity are paired with old items of equal HTML from both ends of
 * each gap (a history restore writes new elements, a split replaces one item by two); the paired items
 * keep their bytes, the rest take their canon and the old items left over are removed. Ordered
 * removals and replacements, loose lists, a list that keeps no item, a new item with another marker
 * (another list) and items out of order return false: the whole-list path decides them.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one pass over the items with the numbering of 3.8
function itemLevelEntries<E>(
  i: Ctx<E>,
  itemEntries: readonly Entry<E>[],
  oldItems: readonly Unit<E>[],
  oldOf: ReadonlyMap<E, Unit<E>>,
  winIndex: ReadonlyMap<Unit<E>, number>,
  used: Set<Unit<E>>,
): boolean {
  if (oldItems.length === 0) return false
  const olds: Array<Unit<E> | undefined> = []
  let kept = 0
  for (const entry of itemEntries) {
    const old = oldOf.get(entry.el as E)
    olds.push(old)
    if (old) kept++
  }
  const firstOld = i.text.slice(oldItems[0].start, oldItems[0].end)
  const ordered = orderedNumber(firstOld) !== undefined
  const byHtml = ordered
    ? undefined
    : pairByHtml(i, itemEntries, olds, oldItems)
  if (byHtml === false) return false
  kept += byHtml?.size ?? 0
  const added = itemEntries.length - kept
  const removed = oldItems.length - kept
  if (kept === 0) return false
  // Identity alone that changes nothing, and an ordered list with both inserts and removals, take the
  // whole-list path; a bullet list with both is decided item by item (012-11).
  if (added === 0 && removed === 0 && (byHtml?.size ?? 0) === 0) return false
  if (ordered && added > 0 === removed > 0) return false
  if (!tightRun(i, itemEntries, olds, oldItems)) return false
  // F-1: the whole marker comes from the list; the canon of an item alone writes `1.` for `1)`.
  const delimiter = ordered ? markerOf(firstOld).slice(-1) : ''
  const numbered = (source: string, number: number): string =>
    source.replace(ORDERED_MARKER_PREFIX, `${number}${delimiter}`)
  // Ordered removals keep the whole-list path (Q-87 Q-H); an insert before the first item needs the
  // list's own start.
  if (ordered && (removed > 0 || olds[0] === undefined)) return false
  const { host } = i
  const plans: Array<{
    bytes: string
    old: Unit<E> | undefined
    created?: Unit<E>
  }> = []
  let number = 0
  for (const [j, entry] of itemEntries.entries()) {
    const old = olds[j]
    const oldBytes = old ? i.text.slice(old.start, old.end) : undefined
    number =
      j === 0 && oldBytes !== undefined
        ? (orderedNumber(oldBytes) ?? 0)
        : number + 1
    if (old && oldBytes !== undefined && !(ordered && old.dirty)) {
      plans.push({
        old,
        bytes: ordered ? numbered(oldBytes, number) : oldBytes,
      })
      continue
    }
    // An empty item alone serializes to nothing; in its list Lute writes the bare marker (`-`, `6.`).
    const canon =
      host.serialize('list-item', [entry.el as E]) ||
      (ordered ? withNumber(markerOf(firstOld), 1) : markerOf(firstOld))
    const remembered =
      old === undefined && i.remembered.length > 0
        ? i.remembered.find((r) => r.canon === canon)?.bytes
        : undefined
    // A new bullet item with another marker belongs to another list: the list path decides it (012-11).
    if (!ordered && removed > 0 && markerOf(canon) !== markerOf(firstOld))
      return false
    const bytes = remembered ?? (ordered ? numbered(canon, number) : canon)
    // A new bullet item is proven here (its bytes are its canon), so typing into it before the next
    // idle proof takes the leaf path instead of a fallback.
    const created =
      old === undefined && !ordered
        ? newUnit<E>('list-item', [entry.el as E], 0, 0, 0)
        : undefined
    if (created) {
      created.html = host.html('list-item', entry.el as E)
      created.canon = canon
      created.proof = bytes === canon ? 'proven' : 'none'
    }
    plans.push({ old, bytes, created })
  }
  for (const [j, entry] of itemEntries.entries()) {
    const { old, bytes, created } = plans[j]
    entry.bytes = bytes
    if (created) entry.unit = created
    if (!old) continue
    touch(old)
    used.add(old)
    unindexUnit(i, old)
    old.members = [entry.el as E]
    old.el = entry.el
    entry.unit = old
    entry.oldIndex = winIndex.get(old) as number
    if (byHtml?.has(old) && old.dirty) {
      // Its new element holds the HTML its bytes stand for: nothing is left for the leaf stage.
      old.dirty = false
      setDelete(i.dirty, old)
    }
    if (ordered && old.dirty) {
      // Its bytes are written here from its canon: the leaf stage has nothing left to do.
      old.proof = 'none'
      old.html = undefined
      old.canon = undefined
      old.dirty = false
      setDelete(i.dirty, old)
      old.explicit = false
      old.forms = []
      setDelete(i.listRouted, old)
    }
  }
  return true
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: root window entries: reuse by identity, by HTML, list items, saved bytes (handoff 6.8 step 4)
function rootStage<E>(
  i: Ctx<E>,
  listing: HostUnit<E>[],
  forced: Set<Unit<E>>,
  sequence: number | undefined,
): RootResult<E> | SyncResult {
  const window = computeWindow(i, listing, forced)
  if (!window) return fallback('sync-error')
  const { host } = i
  const { units } = i
  const hostOf = new Map<E, HostUnit<E>>()
  for (const h of window.hosts)
    for (const member of h.members) hostOf.set(member, h)
  const oldWin = units.slice(window.u0, window.u1)
  const winIndex = new Map(oldWin.map((u, k) => [u, window.u0 + k]))
  const tables: RootResult<E>['tables'] = []

  // One old unit and one new element of its kind: rebind it (spin replacement, table rebuilt by the DOM).
  const only =
    oldWin.length === 1 &&
    oldWin[0].members.length === 1 &&
    window.newEls.length === 1
      ? oldWin[0]
      : undefined
  const onlyHost = only && hostOf.get(window.newEls[0])
  // A block a history restore put back with remembered bytes (task 004) takes the general path, which
  // reads the saved index; the rebind below would derive the bytes again (a table row by row).
  // Task 733 / 012-5: a fenced code block's serialize here takes the text path of
  // `serializeBlockHtml` (no Lute call), so this check costs no whole-block Lute call.
  const remembered =
    only !== undefined &&
    onlyHost !== undefined &&
    i.remembered.length > 0 &&
    i.remembered.some(
      (r) => r.canon === host.serialize(onlyHost.kind, [window.newEls[0] as E]),
    )
  if (
    only &&
    onlyHost &&
    onlyHost.kind === only.kind &&
    only.kind !== 'list-item' &&
    !remembered
  ) {
    rebindOne(i, only, onlyHost, tables)
    refreshKinds(i, listing)
    return { changes: [], tables }
  }

  const oldOf = new Map<E, Unit<E>>()
  for (const unit of oldWin)
    for (const member of unit.members) oldOf.set(member, unit)
  const used = new Set<Unit<E>>()
  const entries: Entry<E>[] = []
  const itemEntries: Entry<E>[] = []

  // Pass 1: reuse by identity (a) and by equal stored HTML (b); list items are decided later.
  for (let at = 0; at < window.newEls.length; ) {
    const el = window.newEls[at]
    const kind = hostOf.get(el)?.kind
    if (!kind) return fallback('unit-without-kind')
    const old = oldOf.get(el)
    if (kind === 'list-item') {
      const entry: Entry<E> = {
        unit: undefined,
        el,
        kind,
        bytes: '',
        oldIndex: -1,
        item: true,
      }
      entries.push(entry)
      itemEntries.push(entry)
      at++
      continue
    }
    const sameGroup =
      old &&
      !used.has(old) &&
      old.members.every((member, k) => window.newEls[at + k] === member)
    if (old && sameGroup && old.kind !== 'list-item') {
      used.add(old)
      entries.push({
        unit: old,
        el: undefined,
        kind: old.kind,
        bytes: i.text.slice(old.start, old.end),
        oldIndex: winIndex.get(old) as number,
        item: false,
      })
      at += old.members.length
      continue
    }
    const html = host.html(kind as never, el)
    const twin = oldWin.find(
      (u) =>
        !used.has(u) &&
        u.kind === kind &&
        u.members.length === 1 &&
        u.html !== undefined &&
        u.html === html,
    )
    if (twin) {
      used.add(twin)
      touch(twin)
      unindexUnit(i, twin)
      twin.members = [el]
      twin.el = el
      entries.push({
        unit: twin,
        el: undefined,
        kind,
        bytes: i.text.slice(twin.start, twin.end),
        oldIndex: winIndex.get(twin) as number,
        item: false,
      })
    } else {
      entries.push({
        unit: undefined,
        el,
        kind,
        bytes: '',
        oldIndex: -1,
        item: false,
      })
    }
    at++
  }

  // List items (6.10): one whole-list serialization, old bytes kept where nothing changed.
  const oldItems = oldWin.filter((u) => u.kind === 'list-item')
  if (
    itemEntries.length > 0 &&
    !itemLevelEntries(i, itemEntries, oldItems, oldOf, winIndex, used)
  ) {
    const sources = host.serializeList(itemEntries.map((e) => e.el as E))
    if (!sources) return fallback('sync-error')
    const claimed = new Set<Unit<E>>()
    const byIdentity = itemEntries.map((e) => oldOf.get(e.el as E))
    for (const old of byIdentity) if (old) claimed.add(old)
    const spare = oldItems.filter((u) => !claimed.has(u))
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one list item: keep the old bytes or take the whole-list source (handoff 6.10 step 3)
    itemEntries.forEach((entry, j) => {
      const old = byIdentity[j] ?? spare.shift()
      const source = sources[j]
      const oldBytes = old ? i.text.slice(old.start, old.end) : undefined
      const html = host.html('list-item', entry.el as E)
      const sameMarker =
        oldBytes !== undefined && markerOf(source) === markerOf(oldBytes)
      // Q-68 (2): the same element, not edited, keeps its bytes even when it was never proven; only a
      // changed ordered number is rewritten (Q-87 Q-F).
      const unchanged =
        old !== undefined &&
        old === byIdentity[j] &&
        !old.dirty &&
        oldBytes !== undefined &&
        (sameMarker ||
          (bothOrdered(source, oldBytes) &&
            markerOf(source).slice(-1) === markerOf(oldBytes).slice(-1)))
      const keep =
        old !== undefined &&
        oldBytes !== undefined &&
        ((!old.dirty &&
          old.html !== undefined &&
          old.html === html &&
          sameMarker) ||
          source === oldBytes ||
          (source === old.canon && sameMarker) ||
          unchanged)
      // Bytes a history restore remembered for the canon of this item (task 004): an Undo of a list
      // whose items Lute would number or space differently gives the original bytes back, even for an
      // item whose current bytes already equal its list source. The lookup costs one Lute call per
      // item and only runs after a restore.
      const itemCanon =
        i.remembered.length > 0
          ? host.serialize('list-item', [entry.el as E])
          : undefined
      const remembered =
        itemCanon === undefined
          ? undefined
          : i.remembered.find((r) => r.canon === itemCanon)?.bytes
      if (old) touch(old)
      if (old && keep && remembered === undefined) {
        used.add(old)
        unindexUnit(i, old)
        old.members = [entry.el as E]
        old.el = entry.el
        entry.unit = old
        entry.bytes = sameMarker
          ? (oldBytes as string)
          : withNumber(oldBytes as string, orderedNumber(source) ?? 1)
        entry.oldIndex = winIndex.get(old) as number
        // A no-op write (its list source equals its bytes): nothing is left for the leaf stage, which
        // would hand a list-routed item back here until `sync-error` (011 DR2).
        if (old.dirty && source === oldBytes) {
          old.dirty = false
          setDelete(i.dirty, old)
        }
      } else {
        entry.bytes = remembered ?? source
        if (old) {
          used.add(old)
          unindexUnit(i, old)
          old.members = [entry.el as E]
          old.el = entry.el
          old.proof = 'none'
          old.html = undefined
          old.canon = undefined
          old.dirty = false
          setDelete(i.dirty, old)
          old.explicit = false
          old.forms = []
          // A loose item alone serializes tight, so it can never be proven alone: its next edit takes
          // the list path again instead of a whole-text fallback (011 DR1).
          if (LOOSE_ITEM_HTML.test(html)) setAdd(i.listRouted, old)
          else setDelete(i.listRouted, old)
          entry.unit = old
          entry.oldIndex = -1
        }
      }
    })
    // The unit that replaced `old` keeps its identity, the bytes are new.
    for (const entry of itemEntries)
      if (!entry.unit) entry.bytes = entry.bytes || ''
  }

  // Pass 2: removed units release their saved entries, then new units take saved bytes.
  const removed = new Set(oldWin.filter((u) => !used.has(u)))
  // The index is filled before any unit leaves, so that its bytes can come back (rule 3.5 step 1).
  ensureSaved(i)
  for (const unit of removed) {
    if (hasContent(unit)) rememberRemoved(i, unit)
  }
  releaseSaved(i, removed)
  for (const unit of removed) {
    setDelete(i.savedPushed, unit)
    setDelete(i.listRouted, unit)
    if (i.dirty.size > 0) walk([unit], (u) => setDelete(i.dirty, u))
    unindexUnit(i, unit)
  }
  for (const entry of entries) {
    if (entry.unit && entry.item === false) continue
    if (entry.item && (entry.unit || entry.bytes !== '')) {
      if (!entry.unit) {
        entry.unit = createItemUnit(entry)
        if (LOOSE_ITEM_HTML.test(i.host.html('list-item', entry.el as E)))
          setAdd(i.listRouted, entry.unit)
      }
      continue
    }
    const created = createUnit(i, entry)
    entry.unit = created
    const rows = hostOf.get(entry.el as E)?.rows
    entry.bytes =
      takeSaved(
        i,
        created.canon as string,
        entry.kind,
        rows && { lines: rows.length + 1, columns: rows[0]?.length ?? 0 },
      ) ?? (created.canon as string)
  }

  return applyWindow(
    i,
    listing,
    window,
    hostOf,
    entries,
    oldWin,
    tables,
    sequence,
  )
}

function createItemUnit<E>(entry: Entry<E>): Unit<E> {
  const unit = newUnit<E>('list-item', [entry.el as E], 0, 0, 0)
  return unit
}

function rebindOne<E>(
  i: Ctx<E>,
  unit: Unit<E>,
  host: HostUnit<E>,
  tables: RootResult<E>['tables'],
): void {
  const el = host.members[0]
  touch(unit)
  unindexUnit(i, unit)
  if (unit.kind === 'table') {
    const rows = host.rows ?? []
    // The alignment is not in the cell HTML: a changed delimiter row sends the table to the table stage.
    const delimiter = unit.children[1]
    const sameAlign =
      delimiter !== undefined &&
      alignKey(splitRow(i.text.slice(delimiter.start, delimiter.end))) ===
        hostAlignKey(host.align ?? [])
    const sameShape =
      sameAlign &&
      rows.length === unit.children.length - 1 &&
      unit.children.every(
        (row, index) =>
          index === 1 ||
          row.members.length === rows[index === 0 ? 0 : index - 1].length,
      )
    unit.members = [el]
    unit.el = el
    if (!sameShape) {
      tables.push({ table: unit, host })
      return
    }
    unit.children.forEach((row, index) => {
      if (index === 1) return
      const cells = rows[index === 0 ? 0 : index - 1]
      touch(row)
      row.members = [...cells]
      for (const [j, cell] of row.children.entries())
        rebindCell(i, cell, cells[j])
      if (row.children.length === 0 && unitHtml(i.host, row) !== row.html)
        flagDirty(i, row)
    })
    indexUnit(i, unit)
    return
  }
  const before = unit.html
  unit.members = [el]
  unit.el = el
  indexUnit(i, unit)
  if (before === undefined || unitHtml(i.host, unit) !== before)
    flagDirty(i, unit)
}

function rebindCell<E>(i: Ctx<E>, cell: Unit<E>, el: E): void {
  touch(cell)
  cell.members = [el]
  cell.el = el
  if (cell.html === undefined || i.host.html('cell', el) !== cell.html)
    flagDirty(i, cell)
}

// ---- Window application: join, positions, replacement range (6.12). ----

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: window join, replaced range and unit positions are one rule table (handoff 6.12)
function applyWindow<E>(
  i: Ctx<E>,
  listing: HostUnit<E>[],
  window: Window<E>,
  hostOf: ReadonlyMap<E, HostUnit<E>>,
  entries: Entry<E>[],
  oldWin: Unit<E>[],
  tables: RootResult<E>['tables'],
  sequence: number | undefined,
): RootResult<E> {
  const oldText = i.text
  const oldUnits = i.units
  const prefixUnits = oldUnits.slice(0, window.u0)
  const suffixUnits = oldUnits.slice(window.u1)
  const run = {
    used: undefined as string | undefined,
    first: undefined as string | undefined,
  }
  const firstItems = oldWin.filter((u) => u.kind === 'list-item')
  if (firstItems.length > 1)
    run.first = oldText.slice(firstItems[0].end, firstItems[1].start)

  let joined = ''
  const offsets: number[] = []
  let previous: Entry<E> | undefined
  for (const entry of entries) {
    if (entry.bytes === '') {
      offsets.push(joined.length)
      continue
    }
    if (previous) joined += separator(i, previous, entry, run)
    offsets.push(joined.length)
    joined += entry.bytes
    previous = entry
  }

  let before: Unit<E> | undefined
  for (let at = prefixUnits.length - 1; at >= 0 && !before; at--)
    if (hasContent(prefixUnits[at])) before = prefixUnits[at]
  const after = suffixUnits.find(hasContent)
  const winContent = oldWin.filter(hasContent)
  const oldFrom = winContent[0]?.start
  const oldTo = winContent.length
    ? winContent[winContent.length - 1].end
    : undefined
  let raw: TextChange | undefined
  let base: number
  if (joined === '') {
    if (oldFrom !== undefined && oldTo !== undefined) {
      raw = before
        ? { from: before.end, to: oldTo, insert: '' }
        : { from: oldFrom, to: after ? after.start : oldTo, insert: '' }
    }
    base = before ? before.end : after ? after.start : 0
  } else if (oldFrom === undefined || oldTo === undefined) {
    if (before) {
      raw = { from: before.end, to: before.end, insert: `\n\n${joined}` }
      base = before.end + 2
    } else if (after) {
      raw = { from: after.start, to: after.start, insert: `${joined}\n\n` }
      base = after.start
    } else {
      raw = { from: 0, to: 0, insert: joined }
      base = 0
    }
  } else {
    raw = { from: oldFrom, to: oldTo, insert: joined }
    base = oldFrom
  }

  const newText = raw ? applyChanges(oldText, [raw]) : oldText
  const delta = raw ? raw.insert.length - (raw.to - raw.from) : 0
  const lineDelta = raw
    ? lineCount(raw.insert) - lineCount(oldText.slice(raw.from, raw.to))
    : 0
  const anchor = prefixUnits.length
    ? prefixUnits[prefixUnits.length - 1]
    : undefined
  let known = anchor
    ? { offset: anchor.start, line: anchor.startLine }
    : undefined
  const newUnits: Unit<E>[] = []
  for (const [index, entry] of entries.entries()) {
    const unit = entry.unit as Unit<E>
    touch(unit)
    // The bytes the unit held before this window, read before its range moves (N2).
    const oldBytes =
      entry.oldIndex >= 0 ? oldText.slice(unit.start, unit.end) : ''
    const start = base + offsets[index]
    unit.start = start
    unit.end = start + entry.bytes.length
    const line = offsetToPosition(newText, start, known)
    unit.startLine = line.line
    known = { offset: start, line: line.line }
    if (
      sequence !== undefined &&
      (entry.oldIndex < 0 || entry.bytes !== oldBytes)
    )
      unit.changedAt = sequence
    if (unit.kind === 'table' && entry.oldIndex < 0)
      buildTable(unit, hostOf.get(unit.members[0]), newText)
    newUnits.push(unit)
  }
  if (delta !== 0 || lineDelta !== 0) {
    shiftAfter(suffixUnits, delta, lineDelta)
    journal?.run(() => shiftAfter(suffixUnits, -delta, -lineDelta))
  }
  i.text = newText
  i.units = [...prefixUnits, ...newUnits, ...suffixUnits]
  journal?.run(() => {
    i.text = oldText
    i.units = oldUnits
  })
  for (const entry of entries) indexUnit(i, entry.unit as Unit<E>)
  refreshKinds(i, listing)
  return {
    changes: raw
      ? ([shrink(oldText, raw)].filter(Boolean) as TextChange[])
      : [],
    tables,
  }
}

/** Host kind of every element of the last listing (one pass over the top-level units). */
function refreshKinds<E>(i: Ctx<E>, listing: readonly HostUnit<E>[]): void {
  i.hostKinds.clear()
  for (const h of listing)
    for (const member of h.members) i.hostKinds.set(member, h.kind)
}

/** Row and cell units of a table created in a window; a shape mismatch makes it one opaque unit. */
function buildTable<E>(
  unit: Unit<E>,
  hostUnit: HostUnit<E> | undefined,
  text: string,
): void {
  if (!hostUnit) return
  const lines = text.slice(unit.start, unit.end).split('\n')
  if (tableShapeMatches(lines, hostUnit))
    unit.children = tableChildren(unit, lines, hostUnit)
  else unit.proof = 'opaque'
}

// ---- Table structure (handoff 6.9). ----

function colAdjust<E>(
  i: Ctx<E>,
  line: string,
  oldMembers: readonly E[],
  newCells: readonly E[],
): string {
  const oldSet = new Set(oldMembers)
  const newSet = new Set(newCells)
  const rewritten = (): string =>
    `| ${newCells.map((el) => i.host.serialize('cell', [el])).join(' | ')} |`
  let out = line
  const removedAt = oldMembers
    .map((m, k) => (newSet.has(m) ? -1 : k))
    .filter((k) => k >= 0)
  for (const k of removedAt.reverse()) {
    const pipes = tableRowPipeOffsets(out)
    if (pipes.length < k + 2 || pipes[0] !== 0) return rewritten()
    out = out.slice(0, pipes[k] + 1) + out.slice(pipes[k + 1] + 1)
  }
  newCells.forEach((cell, k) => {
    if (oldSet.has(cell)) return
    const pipes = tableRowPipeOffsets(out)
    if (pipes.length <= k || pipes[0] !== 0) {
      out = rewritten()
      return
    }
    out = `${out.slice(0, pipes[k] + 1)} ${i.host.serialize('cell', [cell])} |${out.slice(pipes[k] + 1)}`
  })
  const cells = splitRow(out)
  return cells.length === newCells.length ? out : rewritten()
}

function alignKey(cells: readonly string[]): string {
  return cells
    .map((c) => `${c.startsWith(':') ? 'l' : ''}${c.endsWith(':') ? 'r' : ''}`)
    .join(',')
}

const hostAlignKey = (align: readonly string[]): string =>
  align
    .map((a) =>
      a === 'left' ? 'l' : a === 'right' ? 'r' : a === 'center' ? 'lr' : '',
    )
    .join(',')

/** Longest increasing run of old indexes; the rows in it keep their place. */
function stayingRows(matched: Array<number | undefined>): Set<number> {
  const tails: number[] = []
  const prev: number[] = new Array(matched.length).fill(-1)
  const tailIdx: number[] = []
  matched.forEach((old, k) => {
    if (old === undefined) return
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < old) lo = mid + 1
      else hi = mid
    }
    tails[lo] = old
    tailIdx[lo] = k
    prev[k] = lo > 0 ? tailIdx[lo - 1] : -1
  })
  const stay = new Set<number>()
  for (
    let k = tailIdx.length ? tailIdx[tailIdx.length - 1] : -1;
    k >= 0;
    k = prev[k]
  )
    stay.add(k)
  return stay
}

/** Stored HTML of an old row: its cells' HTML joined, or the HTML of a span-less row. */
function oldRowHtml<E>(row: Unit<E>): string | undefined {
  if (row.children.length === 0) return row.html
  const parts = row.children.map((cell) => cell.html)
  return parts.every((part) => part !== undefined)
    ? parts.join('\u0000')
    : undefined
}

/** Old content row of a new row that holds a cell of that row; content row k sits at child k + 1 (the delimiter row is child 1). */
function matchByIdentity<E>(
  i: Ctx<E>,
  cells: readonly E[],
  k: number,
  rowIndex: ReadonlyMap<Unit<E>, number>,
): number | undefined {
  const found = cells[0] === undefined ? undefined : i.byElement.get(cells[0])
  const row =
    found === undefined
      ? undefined
      : found.kind === 'row'
        ? found
        : (rowOfCell.get(found) as Unit<E> | undefined)
  const child = row === undefined ? undefined : rowIndex.get(row)
  if (child === undefined) return undefined
  if (k === 0) return child === 0 ? 0 : undefined
  return child >= 2 ? child - 1 : undefined
}

/** Old content row of each new row: by the identity of a cell, else by equal HTML among the rows that left (handoff 6.9 step 4). */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: identity match, duplicate guard and HTML match of handoff 6.9 step 4
function matchRows<E>(
  i: Ctx<E>,
  rows: readonly (readonly E[])[],
  tableRows: readonly Unit<E>[],
): Array<number | undefined> {
  const rowIndex = new Map(tableRows.map((row, k) => [row, k]))
  const matched: Array<number | undefined> = rows.map((cells, k) =>
    matchByIdentity(i, cells, k, rowIndex),
  )
  const seen = new Set<number>()
  for (const [k, old] of matched.entries()) {
    if (old === undefined) continue
    if (seen.has(old)) matched[k] = undefined
    else seen.add(old)
  }
  let byHtml: Map<string, number[]> | undefined
  for (const [k, cells] of rows.entries()) {
    if (k === 0 || matched[k] !== undefined) continue
    if (!byHtml) {
      byHtml = new Map()
      for (let content = 1; content < tableRows.length - 1; content++) {
        if (seen.has(content)) continue
        const html = oldRowHtml(tableRows[content + 1])
        if (html !== undefined)
          byHtml.set(html, [...(byHtml.get(html) ?? []), content])
      }
    }
    const queue = byHtml.get(
      cells.map((el) => i.host.html('cell', el)).join('\u0000'),
    )
    if (queue?.length) matched[k] = queue.shift()
  }
  return matched
}

interface NewRow<E> {
  cells: readonly E[]
  old: number | undefined // old content row
  text: string | undefined // undefined: the old line is kept
  stay: boolean
}

/** Carries the state of an old cell to the new cell of the same element (handoff 6.9 step 5). */
function carryCell<E>(
  i: Ctx<E>,
  cell: Unit<E>,
  oldText: string,
  newText: string,
  sequence: number | undefined,
): void {
  const found = i.byElement.get(cell.members[0])
  const old = found?.kind === 'cell' ? found : undefined
  if (old) {
    cell.dirty = old.dirty
    if (old.dirty) setAdd(i.dirty, cell)
    cell.explicit = old.explicit
    cell.changedAt = old.changedAt
    if (i.savedPushed.has(old)) setAdd(i.savedPushed, cell)
    if (
      oldText.slice(old.start, old.end) === newText.slice(cell.start, cell.end)
    ) {
      cell.html = old.html
      cell.canon = old.canon
      cell.proof = old.proof
      cell.forms = old.forms
    }
    return
  }
  cell.proof = 'proven'
  cell.html = i.host.html('cell', cell.members[0])
  cell.canon = newText.slice(cell.start, cell.end)
  if (sequence !== undefined) cell.changedAt = sequence
}

interface RowMove<E> {
  row: Unit<E>
  delta: number
  lines: number
}

/** Moves a reused row and its cells; the move is journaled as one numeric shift, not as a copy per unit. */
function moveRow<E>(
  row: Unit<E>,
  start: number,
  startLine: number,
  moves: RowMove<E>[],
): void {
  const delta = start - row.start
  const lines = startLine - row.startLine
  if (delta === 0 && lines === 0) return
  shiftRow(row, delta, lines)
  moves.push({ row, delta, lines })
}

function shiftRow<E>(row: Unit<E>, delta: number, lines: number): void {
  row.start += delta
  row.end += delta
  row.startLine += lines
  for (const cell of row.children) {
    cell.start += delta
    cell.end += delta
    cell.startLine += lines
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: table rows: matching, moves, columns and delimiter in one pass over the rows (handoff 6.9)
function tableStage<E>(
  i: Ctx<E>,
  table: Unit<E>,
  hostUnit: HostUnit<E>,
  sequence: number | undefined,
): TextChange[] | SyncResult {
  const rows = hostUnit.rows
  const old = table.children
  if (!rows || rows.length === 0 || old.length < 2)
    return fallback('sync-error')
  const oldText = i.text
  const lineText = (child: number): string =>
    oldText.slice(old[child].start, old[child].end)
  const childOf = (content: number): number => (content === 0 ? 0 : content + 1)
  const oldCols = old[0].members.length
  const newCols = rows[0].length
  const delimiterOld = lineText(1)
  const delimiterNew =
    oldCols !== newCols ||
    alignKey(splitRow(delimiterOld)) !== hostAlignKey(hostUnit.align ?? [])
      ? delimiterLine(hostUnit.align ?? [])
      : delimiterOld

  const matched = matchRows(i, rows, old)
  const stay = stayingRows(matched.map((m, k) => (k === 0 ? undefined : m)))
  const plan: NewRow<E>[] = rows.map((cells, k) => {
    const from = matched[k]
    const kept = k === 0 ? from === 0 : stay.has(k)
    if (from === undefined) {
      const text = `| ${cells.map((el) => i.host.serialize('cell', [el])).join(' | ')} |`
      return { cells, old: undefined, text, stay: false }
    }
    const text =
      oldCols === newCols
        ? undefined
        : colAdjust(
            i,
            lineText(childOf(from)),
            old[childOf(from)].members,
            cells,
          )
    return { cells, old: from, text, stay: kept }
  })
  // The shape of every line that is written: cell count of the DOM row.
  for (const row of plan) {
    if (
      row.text !== undefined &&
      splitRow(row.text).length !== row.cells.length
    )
      return fallback('sync-error')
  }

  const changes: TextChange[] = []
  const push = (change: TextChange | undefined): void => {
    if (change) changes.push(change)
  }
  const replaceLine = (child: number, text: string): void =>
    push(
      shrink(oldText, {
        from: old[child].start,
        to: old[child].end,
        insert: text,
      }),
    )
  if (!plan[0].stay || plan[0].text !== undefined)
    replaceLine(0, plan[0].text ?? lineText(0))
  if (delimiterNew !== delimiterOld) replaceLine(1, delimiterNew)

  // Old data rows that stay in place; the others leave (removed and moved rows).
  const keptOld = new Set<number>()
  for (const [k, row] of plan.entries())
    if (k > 0 && row.stay && row.old !== undefined) keptOld.add(row.old)
  for (let content = 1; content < old.length - 1; ) {
    if (keptOld.has(content)) {
      content++
      continue
    }
    let last = content
    while (last + 1 < old.length - 1 && !keptOld.has(last + 1)) last++
    push({
      from: old[childOf(content) - 1].end,
      to: old[childOf(last)].end,
      insert: '',
    })
    content = last + 1
  }
  // Inserted rows (new and moved) follow the row that stays before them.
  let anchor = 1
  let pending = ''
  const flush = (): void => {
    if (pending)
      push({ from: old[anchor].end, to: old[anchor].end, insert: pending })
    pending = ''
  }
  for (const [k, row] of plan.entries()) {
    if (k === 0) continue
    if (row.stay && row.old !== undefined) {
      flush()
      anchor = childOf(row.old)
      if (row.text !== undefined) replaceLine(anchor, row.text)
    } else {
      pending += `\n${row.text ?? lineText(childOf(row.old as number))}`
    }
  }
  flush()
  changes.sort((a, b) => a.from - b.from || a.to - b.to)
  const newText = applyChanges(oldText, changes)

  // New row units: reused rows move, the others are built from their line; positions run along the table.
  touch(table)
  const children: Unit<E>[] = []
  let pos = table.start
  let line = table.startLine
  const place = (unit: Unit<E>): void => {
    children.push(unit)
    pos = unit.end + 1
    line += 1
  }
  const fresh = (
    index: number,
    text: string,
    members: readonly E[],
  ): Unit<E> => {
    const unit = buildRow(index, text, pos, line, members)
    if (sequence !== undefined) unit.changedAt = sequence
    return unit
  }
  const moves: RowMove<E>[] = []
  const reuse = (unit: Unit<E>): Unit<E> => {
    moveRow(unit, pos, line, moves)
    return unit
  }
  const built: Array<{ row: Unit<E>; old: number | undefined }> = []
  const row0 = plan[0]
  if (row0.stay && row0.text === undefined) place(reuse(old[0]))
  else {
    const unit = fresh(0, row0.text ?? lineText(0), row0.cells)
    built.push({ row: unit, old: row0.old })
    place(unit)
  }
  if (delimiterNew === delimiterOld) place(reuse(old[1]))
  else place(fresh(1, delimiterNew, []))
  for (const [k, row] of plan.entries()) {
    if (k === 0) continue
    if (row.stay && row.old !== undefined && row.text === undefined) {
      place(reuse(old[childOf(row.old)]))
      continue
    }
    const text = row.text ?? lineText(childOf(row.old as number))
    const unit = fresh(k + 1, text, row.cells)
    built.push({ row: unit, old: row.old })
    place(unit)
  }
  journal?.run(() => {
    for (const { row, delta, lines } of moves) shiftRow(row, -delta, -lines)
  })
  for (const { row } of built)
    for (const cell of row.children)
      carryCell(i, cell, oldText, newText, sequence)

  // Rows that left the table.
  const reused = new Set(children)
  for (const row of old) {
    if (reused.has(row)) continue
    for (const unit of row.children) {
      setDelete(i.dirty, unit)
      setDelete(i.savedPushed, unit)
    }
    unindexRow(i, row)
  }
  const oldEnd = table.end
  const oldLines = table.startLine
  table.children = children
  table.end = pos - 1
  for (const { row } of built) indexRow(i, row)
  const delta = table.end - oldEnd
  const lineDelta = line - oldLines - old.length
  const at = indexOfUnit(i.units, table)
  const suffix = at >= 0 ? i.units.slice(at + 1) : []
  if (delta !== 0 || lineDelta !== 0) {
    shiftAfter(suffix, delta, lineDelta)
    journal?.run(() => shiftAfter(suffix, -delta, -lineDelta))
  }
  const before = i.text
  i.text = newText
  journal?.run(() => {
    i.text = before
  })
  return changes
}

function unindexRow<E>(i: Ctx<E>, row: Unit<E>): void {
  for (const member of row.members) i.byElement.delete(member)
  for (const cell of row.children)
    for (const member of cell.members) i.byElement.delete(member)
}

function indexRow<E>(i: Ctx<E>, row: Unit<E>): void {
  const claim = (unit: Unit<E>): void => {
    for (const member of unit.members) i.byElement.set(member, unit)
  }
  if (row.children.length === 0) claim(row)
  for (const cell of row.children) claim(cell)
}

// ---- The structure sync. ----

function dirtyLeafUnits<E>(i: Ctx<E>): Unit<E>[] {
  return [...i.dirty]
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: stages of one publication in the order of handoff 6.7
function runStages<E>(
  i: Ctx<E>,
  listing: HostUnit<E>[],
  sequence: number | undefined,
): SyncResult {
  const before = i.text
  const forced = new Set<Unit<E>>()
  for (const scope of i.structure)
    if (scope !== 'root' && scope.kind === 'list-item') forced.add(scope)
  for (const unit of dirtyLeafUnits(i))
    if (i.listRouted.has(unit)) forced.add(unit)
  const stages: TextChange[][] = []

  const root = rootStage(i, listing, forced, sequence)
  if ('kind' in root) return root
  stages.push(root.changes)

  const tableScopes = [...i.structure].filter(
    (s): s is Unit<E> => s !== 'root' && s.kind === 'table',
  )
  const pending = new Map<Unit<E>, HostUnit<E>>()
  for (const { table, host } of root.tables) pending.set(table, host)
  const hostByElement =
    tableScopes.length > 0
      ? new Map(listing.map((h) => [h.members[0], h]))
      : undefined
  for (const table of tableScopes) {
    const host = hostByElement?.get(table.members[0])
    if (host && i.units[indexOfUnit(i.units, table)] === table)
      pending.set(table, host)
  }
  for (const [table, host] of pending) {
    const result = tableStage(i, table, host, sequence)
    if ('kind' in result) return result
    stages.push(result)
  }

  for (let round = 0; round < 3; round++) {
    const leaves = leafStage(i, sequence)
    if (!('handover' in leaves)) {
      if (leaves.kind === 'fallback') return leaves
      stages.push(leaves.changes)
      break
    }
    if (round === 2) return fallback('sync-error')
    for (const unit of leaves.handover) forced.add(unit)
    const again = rootStage(i, i.host.listUnits() ?? listing, forced, sequence)
    if ('kind' in again) return again
    stages.push(again.changes)
  }

  i.structure.clear()
  const nonEmpty = stages.filter((s) => s.length > 0)
  if (nonEmpty.length <= 1)
    return { kind: 'changes', changes: nonEmpty[0] ?? [] }
  const span = singleSpanDiff(before, i.text)
  return { kind: 'changes', changes: span ? [span] : [] }
}

const structureSyncImpl: StructureSync = (i, sequence) => {
  const listing = i.host.listUnits()
  if (!listing) {
    i.turnOff('unit-without-kind')
    return fallback('unit-without-kind')
  }
  const text = i.text
  const units = i.units
  const structure = [...i.structure]
  const log = new Journal()
  journal = log
  const rollBack = (): void => {
    log.rollback()
    i.text = text
    i.units = units
    i.structure.clear()
    for (const scope of structure) i.structure.add(scope)
    i.reindex(listing)
  }
  try {
    const result = runStages(i, listing, sequence)
    if (result.kind === 'fallback') rollBack()
    return result
  } catch {
    rollBack()
    return fallback('sync-error')
  } finally {
    journal = undefined
  }
}

/**
 * Registers leaf sync (`model-sync.ts`) and structure windows (`model-structure.ts`) with the text
 * model. Idempotent; the webview calls it once at start-up. A model without it answers every sync
 * with a `sync-error` fallback.
 */
export function installModelSync(): void {
  setSyncImplementation(syncLeaves)
  setStructureSync(structureSyncImpl)
}
