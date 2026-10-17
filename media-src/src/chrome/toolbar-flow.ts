/**
 * Pure toolbar flow planner: decides which controls sit in which toolbar row and which move into
 * More. It has no DOM access; the overflow pass measures widths, calls this, and applies the plan.
 */

export interface FlowControl {
  name: string
  group: number
  width: number
}

export interface FlowInput {
  /** Visible controls in sequence order, tail included; hidden ones left out; no toggle. */
  controls: readonly FlowControl[]
  /** Rule width plus both margins, in the current state. */
  separatorWidth: number
  /** Expanded: [w, w]; collapsed: [w]; w already excludes the toggle column. */
  rowWidths: readonly number[]
  /** Names kept together as the last unit of the last used row, e.g. preview, edit-mode, more. */
  tail: readonly string[]
}

export interface FlowPlan {
  /** Control names with '|' tokens where a rule is shown; empty rows are dropped. */
  rows: string[][]
  /** Controls in More, in sequence order. */
  more: string[]
}

const SEPARATOR = '|'

/** Control widths are compared ceiled so a fractional width never lets a row overflow by a pixel. */
function ceilWidth(control: FlowControl): number {
  return Math.ceil(control.width)
}

interface Layout {
  body: FlowControl[]
  tailControls: FlowControl[]
  tailWidth: number
  tailGroup: number
  separatorWidth: number
}

function splitControls(input: FlowInput): Layout {
  const tailNames = new Set(input.tail)
  const byName = new Map<string, FlowControl>()
  const body: FlowControl[] = []
  for (const control of input.controls) {
    if (tailNames.has(control.name)) byName.set(control.name, control)
    else body.push(control)
  }
  const tailControls: FlowControl[] = []
  for (const name of input.tail) {
    const control = byName.get(name)
    if (control) tailControls.push(control)
  }
  // Tail width including the rules between its own controls (rule 2).
  let tailWidth = 0
  for (let i = 0; i < tailControls.length; i++) {
    tailWidth +=
      ceilWidth(tailControls[i]) +
      ruleBetween(tailControls, i, input.separatorWidth)
  }
  const tailGroup = tailControls.length > 0 ? tailControls[0].group : 0
  return {
    body,
    tailControls,
    tailWidth,
    tailGroup,
    separatorWidth: input.separatorWidth,
  }
}

/** Rule width between list[i - 1] and list[i]; 0 for the first entry or a shared group. */
function ruleBetween(
  list: readonly FlowControl[],
  i: number,
  separatorWidth: number,
): number {
  return i > 0 && list[i].group !== list[i - 1].group ? separatorWidth : 0
}

/** Width added by body[k] when the row's current run starts at body[from]. */
function step(l: Layout, k: number, from: number): number {
  return (
    ceilWidth(l.body[k]) +
    (k > from ? ruleBetween(l.body, k, l.separatorWidth) : 0)
  )
}

/** Width of the rule between body[k] and the tail, or 0 when they share a group. */
function tailJoin(l: Layout, k: number): number {
  return l.body[k].group !== l.tailGroup ? l.separatorWidth : 0
}

function appendBody(l: Layout, row: string[], from: number, to: number): void {
  for (let k = from; k < to; k++) {
    if (k > from && ruleBetween(l.body, k, 1) > 0) row.push(SEPARATOR)
    row.push(l.body[k].name)
  }
}

/** Appends the tail; `end` is the body index just past the placed prefix (rule only if it exists). */
function appendTail(l: Layout, row: string[], from: number, end: number): void {
  if (
    end > from &&
    l.body[end - 1].group !== l.tailGroup &&
    l.tailControls.length > 0
  ) {
    row.push(SEPARATOR)
  }
  for (let i = 0; i < l.tailControls.length; i++) {
    if (ruleBetween(l.tailControls, i, 1) > 0) row.push(SEPARATOR)
    row.push(l.tailControls[i].name)
  }
}

/** Longest body prefix from `from` that fits `cap` on its own (rule 4). Returns [count, width]. */
function longestPrefix(l: Layout, from: number, cap: number): [number, number] {
  let sum = 0
  let count = 0
  let width = 0
  for (let k = from; k < l.body.length; k++) {
    sum += step(l, k, from)
    if (sum > cap) break
    count = k + 1 - from
    width = sum
  }
  return [count, width]
}

/**
 * Last-row rule: longest prefix (at most `limit` controls) that fits together with the tail and the
 * rule before it. A longer prefix can fit again when its last control shares the tail's group, so
 * every length up to the limit is tried.
 */
function longestPrefixWithTail(
  l: Layout,
  from: number,
  limit: number,
  cap: number,
): number {
  let best = 0
  let sum = 0
  for (let k = from; k < from + limit; k++) {
    sum += step(l, k, from)
    if (sum + tailJoin(l, k) + l.tailWidth <= cap) best = k + 1 - from
  }
  return best
}

export function planToolbarFlow(input: FlowInput): FlowPlan {
  const l = splitControls(input)
  const rowWidths = input.rowWidths.length > 0 ? input.rowWidths : [0]
  const rows: string[][] = []
  let next = 0

  for (let r = 0; r < rowWidths.length; r++) {
    const cap = Math.floor(rowWidths[r])
    const [prefix, width] = longestPrefix(l, next, cap)
    const rest = l.body.length - next

    // Rules 3 and 5: the whole remaining body plus the tail fits this row.
    const join = rest > 0 ? tailJoin(l, l.body.length - 1) : 0
    if (prefix === rest && width + join + l.tailWidth <= cap) {
      const row: string[] = []
      appendBody(l, row, next, l.body.length)
      appendTail(l, row, next, l.body.length)
      rows.push(row)
      next = l.body.length
      break
    }

    if (r < rowWidths.length - 1 && prefix > 0) {
      const row: string[] = []
      appendBody(l, row, next, next + prefix)
      rows.push(row)
      next += prefix
      continue
    }

    // Last-row rule; it also applies to a non-last row that cannot hold the next body control.
    const withTail = longestPrefixWithTail(l, next, prefix, cap)
    const row: string[] = []
    appendBody(l, row, next, next + withTail)
    appendTail(l, row, next, next + withTail)
    rows.push(row)
    next += withTail
    break
  }

  // Whatever the loop did not place goes to More, in sequence order.
  const more = l.body.slice(next).map((control) => control.name)
  return { rows, more }
}
