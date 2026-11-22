// Task 733 / 036 (fix design 2.3): the three coordinate spaces of an exact history replay. `T` is the
// record's normalized target, `L` the logical text the host holds once every published operation is
// applied, and `R` the model text that mirrors the DOM. `R` differs from `L` only inside pending
// groups. The module is pure: the caller passes the current `R` string and applies every write itself.
//
// Layout: the text is a run of cells, gap 0, group 0, gap 1, group 1, ..., tail gap. A gap holds text
// that is the same in `R` and `L`; a pending group holds `expectedOld` in `R` and its target bytes in
// `L`. Two Fenwick trees keep the cell lengths in `R` and in `L`, so a position query and an update are
// O(log G). A rendered or dropped group's cells are merged into the next gap and read as zero.

/** The host limit of one delta's text (`S/writeback/delta-validate.ts`, `oldText` plus `text` of every change). */
export const DELTA_TEXT_LIMIT = 4_000_000

/** A group as the caller builds it: its range in `T` and its range in `R`, ascending and disjoint. */
export interface ReplayGroupInit {
  readonly tFrom: number
  readonly tTo: number
  readonly rFrom: number
  readonly rTo: number
}

/** A user change in `R` coordinates. */
interface RenderedChange {
  readonly rFrom: number
  readonly rTo: number
  readonly insert: string
}

/** A change translated to `L`, against the logical text before it (the operation the host applies). */
export interface LogicalChange {
  readonly lFrom: number
  readonly lTo: number
  readonly oldText: string
  readonly insert: string
}

/** An endpoint is strictly inside a pending group, or at a zero-width one: render that group first. */
type TranslateRefusal = 'inside-group' | 'zero-width'

/** One hunk set from `L` to a new target (a superseding move's hunks), in `L` and new-target offsets. */
export interface SupersedingHunks {
  readonly oldStarts: Int32Array
  readonly oldEnds: Int32Array
  readonly newStarts: Int32Array
  readonly newEnds: Int32Array
}

const PENDING = 0
const RENDERED = 1
const DROPPED = 2

class Fenwick {
  readonly tree: Float64Array
  constructor(readonly size: number) {
    this.tree = new Float64Array(size + 1)
  }
  add(cell: number, delta: number): void {
    for (let i = cell + 1; i <= this.size; i += i & -i) this.tree[i] += delta
  }
  /** Sum of cells [0, cell). */
  prefix(cell: number): number {
    let sum = 0
    for (let i = cell; i > 0; i -= i & -i) sum += this.tree[i]
    return sum
  }
  /** The cell that holds offset `p` (`prefix(c) <= p < prefix(c + 1)`); `size` when `p` is at or past the end. */
  find(p: number): number {
    let at = 0
    let rest = p
    let step = 1
    while (step * 2 <= this.size) step *= 2
    for (; step > 0; step >>= 1) {
      const next = at + step
      if (next <= this.size && this.tree[next] <= rest) {
        at = next
        rest -= this.tree[next]
      }
    }
    return at
  }
}

export interface ReplayTarget {
  /** `T`, kept by reference. */
  readonly target: string
  /** Number of groups the state was built with (rendered and dropped ones included). */
  readonly count: number
  /** Groups still pending. O(1). */
  pending(): number
  isPending(group: number): boolean
  /** Current range of a pending group in `R` (written into `out`, no allocation). */
  rangeR(group: number, out: { from: number; to: number }): void
  /** Current range of a pending group in `L`. */
  rangeL(group: number, out: { from: number; to: number }): void
  /** The group's immutable range in `T`. */
  rangeT(group: number, out: { from: number; to: number }): void
  /** `R` still holds the group's expected old bytes at its range (no allocation). */
  checkOld(rendered: string, group: number): boolean
  /** The caller wrote the group's target bytes into `R`: the group is text from now on. */
  markRendered(group: number): void
  /** `R` offset to `L`; a refusal when the offset is inside a pending group or at a zero-width one. */
  rToL(p: number): number | TranslateRefusal
  /** `L` offset to `R`; a refusal when the offset is inside a pending group. */
  lToR(l: number): number | TranslateRefusal
  /** `L.slice(lFrom, lTo)` built from `R` outside pending groups and `T` inside them. */
  logicalSlice(rendered: string, lFrom: number, lTo: number): string
  logicalLength(): number
  /**
   * A user change in `R` (before it is applied to `R`): translated to `L`, contained groups dropped, later
   * groups shifted by their own `R` and `L` deltas. `rendered` is `R` before the change.
   */
  applyChange(
    rendered: string,
    change: RenderedChange,
  ): LogicalChange | TranslateRefusal
  /** `L` equals `start`, compared piece by piece without building `L`. */
  logicalEquals(rendered: string, start: string): boolean
  /** Pending groups in render order: the one at or after `lCaret` first, then outward. */
  order(lCaret: number): Int32Array
}

const equalAt = (
  a: string,
  aFrom: number,
  b: string,
  bFrom: number,
  length: number,
): boolean => {
  for (let i = 0; i < length; i++)
    if (a.charCodeAt(aFrom + i) !== b.charCodeAt(bFrom + i)) return false
  return true
}

/**
 * Builds the state, or undefined when the groups are not ascending and disjoint or when the text outside
 * them has different lengths in `T` and `R` (the record does not describe this `R`).
 */
export function createReplayTarget(
  target: string,
  renderedLength: number,
  groups: readonly ReplayGroupInit[],
  rendered: string,
): ReplayTarget | undefined {
  const count = groups.length
  const cells = 2 * count + 1
  const r = new Fenwick(cells)
  const l = new Fenwick(cells)
  const tFrom = new Int32Array(count)
  const tTo = new Int32Array(count)
  const status = new Uint8Array(count)
  const expectedOld: string[] = new Array(count)
  let lastR = 0
  let lastT = 0
  for (let i = 0; i < count; i++) {
    const g = groups[i]
    if (
      g.rFrom < lastR ||
      g.tFrom < lastT ||
      g.rTo < g.rFrom ||
      g.tTo < g.tFrom ||
      g.rFrom - lastR !== g.tFrom - lastT
    )
      return undefined
    const gap = g.rFrom - lastR
    r.add(2 * i, gap)
    l.add(2 * i, gap)
    r.add(2 * i + 1, g.rTo - g.rFrom)
    l.add(2 * i + 1, g.tTo - g.tFrom)
    tFrom[i] = g.tFrom
    tTo[i] = g.tTo
    expectedOld[i] = rendered.slice(g.rFrom, g.rTo)
    lastR = g.rTo
    lastT = g.tTo
  }
  if (renderedLength - lastR !== target.length - lastT) return undefined
  r.add(2 * count, renderedLength - lastR)
  l.add(2 * count, renderedLength - lastR)
  let pendingCount = count

  const cellR = (c: number): number => r.prefix(c + 1) - r.prefix(c)
  const cellL = (c: number): number => l.prefix(c + 1) - l.prefix(c)
  const setCell = (c: number, rLength: number, lLength: number): void => {
    r.add(c, rLength - cellR(c))
    l.add(c, lLength - cellL(c))
  }
  /** Merges group `i` and the gap before it into the next gap. */
  const retire = (i: number, next: number): void => {
    const merged = cellR(2 * i) + cellR(2 * i + 1)
    const lMerged = cellL(2 * i) + cellL(2 * i + 1)
    if (merged !== lMerged) throw new RangeError('retired group is not text')
    setCell(2 * i, 0, 0)
    setCell(2 * i + 1, 0, 0)
    const gap = cellR(2 * i + 2)
    setCell(2 * i + 2, gap + merged, gap + merged)
    if (status[i] === PENDING) pendingCount--
    status[i] = next
  }

  /** A zero-width pending group whose `L` text is not empty sits at `R` offset `p` before cell `c`. */
  const zeroWidthAt = (c: number, p: number): boolean => {
    for (let k = c - 1; k >= 0 && r.prefix(k) === p; k--) {
      if (k % 2 === 1 && status[(k - 1) / 2] === PENDING && cellL(k) > 0)
        return true
    }
    return false
  }

  // `find` gives `cells` for an offset at the very end; the tail gap holds it.
  const cellOf = (tree: Fenwick, p: number): number =>
    Math.min(tree.find(p), cells - 1)

  const rToL = (p: number): number | TranslateRefusal => {
    const c = cellOf(r, p)
    const start = r.prefix(c)
    if (c % 2 === 1 && p > start) return 'inside-group'
    if (zeroWidthAt(c, p)) return 'zero-width'
    if (c % 2 === 1 && cellR(c) === 0 && cellL(c) > 0) return 'zero-width'
    return l.prefix(c) + (p - start)
  }

  const self: ReplayTarget = {
    target,
    count,
    pending: () => pendingCount,
    isPending: (group) => status[group] === PENDING,
    rangeR(group, out) {
      out.from = r.prefix(2 * group + 1)
      out.to = out.from + cellR(2 * group + 1)
    },
    rangeL(group, out) {
      out.from = l.prefix(2 * group + 1)
      out.to = out.from + cellL(2 * group + 1)
    },
    rangeT(group, out) {
      out.from = tFrom[group]
      out.to = tTo[group]
    },
    checkOld(text, group) {
      if (status[group] !== PENDING) return false
      const old = expectedOld[group]
      const from = r.prefix(2 * group + 1)
      return (
        cellR(2 * group + 1) === old.length &&
        equalAt(text, from, old, 0, old.length)
      )
    },
    markRendered(group) {
      if (status[group] !== PENDING) return
      setCell(2 * group + 1, cellL(2 * group + 1), cellL(2 * group + 1))
      retire(group, RENDERED)
    },
    rToL,
    lToR(p) {
      const c = cellOf(l, p)
      const start = l.prefix(c)
      if (c % 2 === 1 && p > start) return 'inside-group'
      return r.prefix(c) + (p - start)
    },
    logicalLength: () => l.prefix(cells),
    logicalSlice(text, lFrom, lTo) {
      let out = ''
      let pos = lFrom
      while (pos < lTo) {
        const c = l.find(pos)
        const start = l.prefix(c)
        const end = Math.min(lTo, start + cellL(c))
        if (end <= pos) break
        if (c % 2 === 1) {
          const g = (c - 1) / 2
          out += target.slice(tFrom[g] + pos - start, tFrom[g] + end - start)
        } else {
          const rStart = r.prefix(c)
          out += text.slice(rStart + pos - start, rStart + end - start)
        }
        pos = end
      }
      return out
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: translate both endpoints, collect the removed cells and merge the rest into one gap
    applyChange(text, change) {
      const { rFrom, rTo, insert } = change
      const lFrom = rToL(rFrom)
      if (typeof lFrom === 'string') return lFrom
      const lTo = rToL(rTo)
      if (typeof lTo === 'string') return lTo
      const oldText = self.logicalSlice(text, lFrom, lTo)
      // The gap cells that hold the endpoints (a group start counts as the end of the gap before it).
      let a = cellOf(r, rFrom)
      if (a % 2 === 1) a--
      let b = rTo === rFrom ? a : cellOf(r, rTo)
      if (b % 2 === 1) b--
      const offA = rFrom - r.prefix(a)
      const offB = rTo - r.prefix(b)
      if (a === b) {
        const length = cellR(a) - (rTo - rFrom) + insert.length
        setCell(a, length, length)
      } else {
        const length = offA + insert.length + (cellR(b) - offB)
        for (let c = a; c < b; c++) {
          if (c % 2 === 1) {
            const g = (c - 1) / 2
            if (status[g] === PENDING) {
              pendingCount--
              status[g] = DROPPED
            }
          }
          setCell(c, 0, 0)
        }
        setCell(b, length, length)
      }
      return { lFrom, lTo, oldText, insert }
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one walk over the cells compares gap text with R and group text with T
    logicalEquals(text, start) {
      if (self.logicalLength() !== start.length) return false
      let pos = 0
      for (let c = 0; c < cells; c++) {
        const length = cellL(c)
        if (length === 0) continue
        if (c % 2 === 1) {
          const g = (c - 1) / 2
          if (!equalAt(start, pos, target, tFrom[g], length)) return false
        } else if (!equalAt(start, pos, text, r.prefix(c), length)) return false
        pos += length
      }
      return true
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: find the caret group, then alternate up and down over pending groups
    order(lCaret) {
      const out = new Int32Array(pendingCount)
      const range = { from: 0, to: 0 }
      let first = count
      for (let i = 0; i < count; i++) {
        if (status[i] !== PENDING) continue
        self.rangeL(i, range)
        if (range.to >= lCaret) {
          first = i
          break
        }
      }
      let n = 0
      let up = first
      let down = first - 1
      while (n < out.length) {
        while (up < count && status[up] !== PENDING) up++
        if (up < count) out[n++] = up++
        while (down >= 0 && status[down] !== PENDING) down--
        if (down >= 0 && n < out.length) out[n++] = down--
      }
      return out
    },
  }
  return self
}

/**
 * Task 733 / 036 (fix design 2.3): the groups of a record, from its normalized hunks. For an Undo the
 * target is `before` and `R` holds `after`, so the hunk's new range is in `R` and its old range in `T`;
 * a Redo swaps them.
 */
export function groupsOfHunks(
  hunks: SupersedingHunks,
  side: 'before' | 'after',
): ReplayGroupInit[] {
  const toBefore = side === 'before'
  const count = hunks.oldStarts.length
  const groups: ReplayGroupInit[] = new Array(count)
  for (let i = 0; i < count; i++)
    groups[i] = toBefore
      ? {
          tFrom: hunks.oldStarts[i],
          tTo: hunks.oldEnds[i],
          rFrom: hunks.newStarts[i],
          rTo: hunks.newEnds[i],
        }
      : {
          tFrom: hunks.newStarts[i],
          tTo: hunks.newEnds[i],
          rFrom: hunks.oldStarts[i],
          rTo: hunks.oldEnds[i],
        }
  return groups
}

/**
 * Task 733 / 036 (fix design 2.6, Q-B): a superseding move with hunks from `L` (the current logical text)
 * to `next`. Each candidate range (an old pending group or a new hunk, merged where they touch in `L`)
 * becomes a pending group of the new state only where `R` differs from `next` there, so an Undo then Redo
 * with half the groups rendered leaves exactly the rendered half. Undefined when the ranges do not fit.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one sweep merges the two range lists in L coordinates and maps each cluster to R and to the new target
export function supersede(
  state: ReplayTarget,
  rendered: string,
  next: string,
  hunks: SupersedingHunks,
): ReplayTarget | undefined {
  const pending: number[] = []
  for (let i = 0; i < state.count; i++) if (state.isPending(i)) pending.push(i)
  const range = { from: 0, to: 0 }
  const rRange = { from: 0, to: 0 }
  const groups: ReplayGroupInit[] = []
  let a = 0
  let b = 0
  // Accumulated (L length - R length) of passed groups, and (new length - L length) of passed hunks.
  let shiftA = 0
  let shiftB = 0
  const hunkCount = hunks.oldStarts.length
  while (a < pending.length || b < hunkCount) {
    let aStart = Infinity
    if (a < pending.length) {
      state.rangeL(pending[a], range)
      aStart = range.from
    }
    const bStart = b < hunkCount ? hunks.oldStarts[b] : Infinity
    const lx = Math.min(aStart, bStart)
    let ly = lx
    const rx = lx - shiftA
    const tx = lx + shiftB
    for (;;) {
      if (a < pending.length) {
        state.rangeL(pending[a], range)
        if (range.from <= ly) {
          state.rangeR(pending[a], rRange)
          ly = Math.max(ly, range.to)
          shiftA += range.to - range.from - (rRange.to - rRange.from)
          a++
          continue
        }
      }
      if (b < hunkCount && hunks.oldStarts[b] <= ly) {
        ly = Math.max(ly, hunks.oldEnds[b])
        shiftB +=
          hunks.newEnds[b] -
          hunks.newStarts[b] -
          (hunks.oldEnds[b] - hunks.oldStarts[b])
        b++
        continue
      }
      break
    }
    const ry = ly - shiftA
    const ty = ly + shiftB
    if (ry - rx !== ty - tx || !equalAt(rendered, rx, next, tx, ry - rx))
      groups.push({ tFrom: tx, tTo: ty, rFrom: rx, rTo: ry })
  }
  return createReplayTarget(next, rendered.length, groups, rendered)
}

/** Task 733 / 036 (fix design 2.6, 4.4): a change set over the host's delta limit goes out as one whole post. */
export function exceedsDeltaLimit(changes: readonly LogicalChange[]): boolean {
  let total = 0
  for (const change of changes)
    total += change.oldText.length + change.insert.length
  return total > DELTA_TEXT_LIMIT
}
