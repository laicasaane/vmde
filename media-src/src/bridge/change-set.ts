// Pure change arithmetic of the text model (no DOM, no Lute). Offsets are UTF-16 code units.

/** One replacement. Offsets are UTF-16 code units in the text before the change. */
export interface TextChange {
  from: number
  to: number
  insert: string
}

export interface LinePosition {
  line: number
  character: number
}

/** Changes are ascending and do not overlap; otherwise RangeError. */
export function applyChanges(
  text: string,
  changes: readonly TextChange[],
): string {
  let out = ''
  let cursor = 0
  for (const change of changes) {
    if (change.from > change.to)
      throw new RangeError(
        `change from ${change.from} is after to ${change.to}`,
      )
    if (change.from < 0 || change.to > text.length) {
      throw new RangeError(
        `change ${change.from}-${change.to} is outside the text of length ${text.length}`,
      )
    }
    if (change.from < cursor) {
      throw new RangeError(
        `change at ${change.from} is out of order or overlaps the previous change`,
      )
    }
    out += text.slice(cursor, change.from) + change.insert
    cursor = change.to
  }
  return out + text.slice(cursor)
}

/** Position of `offset` after the changes. assoc -1 stays before an insertion at `offset`, 1 moves after it. */
export function mapOffset(
  offset: number,
  changes: readonly TextChange[],
  assoc: -1 | 1,
): number {
  let delta = 0
  for (const change of changes) {
    if (change.from > offset) break
    const length = change.to - change.from
    // Same rule as CodeMirror's ChangeDesc.mapPos: an offset inside or at the start of a replaced
    // range maps to the range start (or after the insertion for assoc 1 when strictly inside),
    // and a pure insertion at `offset` is passed only for assoc 1.
    if (
      change.to > offset ||
      (change.to === offset && assoc < 0 && length === 0)
    ) {
      return offset === change.from || assoc < 0
        ? change.from + delta
        : change.from + delta + change.insert.length
    }
    delta += change.insert.length - length
  }
  return offset + delta
}

const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean =>
  code >= 0xdc00 && code <= 0xdfff

/** Moves an edge that falls inside a surrogate pair of `text` to the pair's edge and takes the half into `insert`. */
export function widenToCodePoints(
  text: string,
  change: TextChange,
): TextChange {
  let { from, to, insert } = change
  if (
    from > 0 &&
    from < text.length &&
    isHighSurrogate(text.charCodeAt(from - 1)) &&
    isLowSurrogate(text.charCodeAt(from))
  ) {
    insert = text[from - 1] + insert
    from -= 1
  }
  if (
    to > 0 &&
    to < text.length &&
    isHighSurrogate(text.charCodeAt(to - 1)) &&
    isLowSurrogate(text.charCodeAt(to))
  ) {
    insert += text[to]
    to += 1
  }
  return { from, to, insert }
}

/** The smallest single replacement that turns `before` into `after`; undefined when they are equal. Never cuts a surrogate pair. */
export function singleSpanDiff(
  before: string,
  after: string,
): TextChange | undefined {
  if (before === after) return undefined
  const shortest = Math.min(before.length, after.length)
  let prefix = 0
  while (
    prefix < shortest &&
    before.charCodeAt(prefix) === after.charCodeAt(prefix)
  )
    prefix++
  // The suffix may not reach into the prefix.
  let suffix = 0
  while (
    suffix < shortest - prefix &&
    before.charCodeAt(before.length - 1 - suffix) ===
      after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++
  }
  return widenToCodePoints(before, {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  })
}

/** Line and UTF-16 character of `offset`; `from` is an optional known earlier position to count from. */
export function offsetToPosition(
  text: string,
  offset: number,
  from?: { offset: number; line: number },
): LinePosition {
  let line = 0
  let cursor = 0
  if (from && from.offset <= offset) {
    line = from.line
    cursor = from.offset
  }
  for (
    let next = text.indexOf('\n', cursor);
    next !== -1 && next < offset;
    next = text.indexOf('\n', next + 1)
  ) {
    line++
  }
  const lineStart = offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1
  return { line, character: offset - lineStart }
}
