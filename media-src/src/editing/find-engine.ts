// Task 196 — literal Markdown find/replace engine. Pure string functions over exact source bytes;
// moved out of selection-scope.ts (which re-exports them) so the Task 196 rework's source and
// mapping modules can import it without a cycle.
import { markdownBlockRanges } from '../util/source-map'

export interface MarkdownFindOptions {
  caseSensitive: boolean
  wholeWord: boolean
}

export interface MarkdownMatch {
  start: number
  end: number
  line: number
  blockIndex: number | null
}

/**
 * Task 733 / 036 (fix design 2.2): the replacements Replace applied, in raw offsets of the plan source:
 * `insert` replaced each `[starts[i], ends[i])`, ascending and non-overlapping. The expected old text of
 * hunk `i` is the plan source's `slice(starts[i], ends[i])`; the record keeps that source by reference,
 * so no old text is copied.
 */
export interface ReplaceHunks {
  starts: Int32Array
  ends: Int32Array
  insert: string
}

export interface MarkdownReplaceResult {
  changed: boolean
  markdown: string
  replacements: number
  caretOffset: number
  /** Absent when nothing was replaced. */
  hunks?: ReplaceHunks
}

/**
 * Task 733 / 036 (fix design 2.2): the hunks in normalized (LF) text, which the model compares. `before`
 * and `after` are the normalized Undo and Redo targets; a text without `\r` is the raw string itself,
 * and offsets of a source without `\r` are the raw arrays. `incremental` is false when a hunk endpoint
 * splits `\r\n` on either side or a hunk fails its check; such a record cannot replay hunk by hunk.
 */
export interface NormalizedReplaceHunks {
  incremental: boolean
  before: string
  after: string
  insert: string
  oldStarts: Int32Array
  oldEnds: Int32Array
  newStarts: Int32Array
  newEnds: Int32Array
}

const FIND_WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u

function isWholeWord(markdown: string, start: number, end: number): boolean {
  const beforeStart =
    start > 1 &&
    /[\uDC00-\uDFFF]/.test(markdown[start - 1] ?? '') &&
    /[\uD800-\uDBFF]/.test(markdown[start - 2] ?? '')
      ? start - 2
      : start - 1
  const before =
    start > 0
      ? String.fromCodePoint(markdown.codePointAt(beforeStart)!)
      : undefined
  const after =
    end < markdown.length
      ? String.fromCodePoint(markdown.codePointAt(end)!)
      : undefined
  return !(
    (before !== undefined && FIND_WORD_CHAR.test(before)) ||
    (after !== undefined && FIND_WORD_CHAR.test(after))
  )
}

/** Lowercase each candidate only after it is sliced at the original UTF-16 offsets. Turkish
 * dotted I expands under lowercasing, so lowering the entire document shifts later matches. */
function findCaseFold(value: string): string {
  return value.toLocaleLowerCase().replaceAll('̇', '')
}

// Code units whose lowercase depends on their neighbours (Final_Sigma; Turkish/Lithuanian I, J
// and I-ogonek rules) or that are half of a surrogate pair. A standalone fold cannot rule them out.
function contextualFold(unit: number): boolean {
  return (
    (unit >= 0xd800 && unit <= 0xdfff) ||
    unit === 0x3a3 ||
    unit === 0x3c2 ||
    unit === 0x3c3 ||
    unit === 0x49 ||
    unit === 0x4a ||
    unit === 0x12e
  )
}

/** Task 196: a case-insensitive candidate can only start where the first code unit's own fold is a
 * prefix of the folded needle (or is empty, or is context-dependent). This skips the per-index
 * slice-and-fold for almost every offset; each surviving candidate still runs the exact check. */
function candidateFilter(needle: string): (unit: number) => boolean {
  const known = new Map<number, boolean>()
  return (unit) => {
    let allowed = known.get(unit)
    if (allowed === undefined) {
      const folded = findCaseFold(String.fromCharCode(unit))
      allowed =
        contextualFold(unit) || folded === '' || needle.startsWith(folded)
      known.set(unit, allowed)
    }
    return allowed
  }
}

function nextCandidate(
  markdown: string,
  query: string,
  needle: string,
  from: number,
  caseSensitive: boolean,
  mayStart: (unit: number) => boolean,
): number {
  if (caseSensitive) return markdown.indexOf(query, from)
  const last = markdown.length - query.length
  for (let index = from; index <= last; index++) {
    if (!mayStart(markdown.charCodeAt(index))) continue
    if (findCaseFold(markdown.slice(index, index + query.length)) === needle)
      return index
  }
  return -1
}

/** Line and block index for ascending offsets in one forward pass (the per-match whole-document
 * rescans made large documents quadratic). */
function sourcePositions(markdown: string) {
  let lineOffset = 0
  let line = 0
  let ranges: ReturnType<typeof markdownBlockRanges> | undefined
  let rangeIndex = 0
  return (offset: number): { line: number; blockIndex: number | null } => {
    for (; lineOffset < offset; lineOffset++)
      if (markdown.charCodeAt(lineOffset) === 10) line++
    ranges ??= markdownBlockRanges(markdown)
    while (rangeIndex < ranges.length && ranges[rangeIndex].endLine < line)
      rangeIndex++
    const range = ranges[rangeIndex]
    return {
      line,
      blockIndex: range && line >= range.startLine ? rangeIndex : null,
    }
  }
}

export function findMarkdownMatches(
  markdown: string,
  query: string,
  options: MarkdownFindOptions,
): MarkdownMatch[] {
  if (!query) return []
  const needle = options.caseSensitive ? query : findCaseFold(query)
  const mayStart = candidateFilter(needle)
  const position = sourcePositions(markdown)
  const matches: MarkdownMatch[] = []
  let from = 0
  while (from <= markdown.length - query.length) {
    const start = nextCandidate(
      markdown,
      query,
      needle,
      from,
      options.caseSensitive,
      mayStart,
    )
    if (start < 0) break
    const end = start + query.length
    if (!options.wholeWord || isWholeWord(markdown, start, end))
      matches.push({ start, end, ...position(start) })
    from = Math.max(end, start + 1)
  }
  return matches
}

export function replaceMarkdownMatch(
  markdown: string,
  match: MarkdownMatch,
  replacement: string,
): MarkdownReplaceResult {
  if (match.start < 0 || match.end < match.start || match.end > markdown.length)
    return {
      changed: false,
      markdown,
      replacements: 0,
      caretOffset: Math.max(0, match.start),
    }
  const offsets = new Int32Array(2)
  offsets[0] = match.start
  offsets[1] = match.end
  return {
    changed: markdown.slice(match.start, match.end) !== replacement,
    markdown:
      markdown.slice(0, match.start) + replacement + markdown.slice(match.end),
    replacements: 1,
    caretOffset: match.start + replacement.length,
    hunks: {
      starts: offsets.subarray(0, 1),
      ends: offsets.subarray(1),
      insert: replacement,
    },
  }
}

export function replaceAllMarkdownMatches(
  markdown: string,
  matches: readonly MarkdownMatch[],
  replacement: string,
): MarkdownReplaceResult {
  if (matches.length === 0)
    return { changed: false, markdown, replacements: 0, caretOffset: 0 }
  // Task 733 / 036: one buffer holds both offset arrays, so Replace All allocates its hunks once.
  const count = matches.length
  const offsets = new Int32Array(count * 2)
  let output = ''
  let cursor = 0
  for (let index = 0; index < count; index++) {
    const match = matches[index]
    output += markdown.slice(cursor, match.start) + replacement
    offsets[index] = match.start
    offsets[count + index] = match.end
    cursor = match.end
  }
  output += markdown.slice(cursor)
  return {
    changed: output !== markdown,
    markdown: output,
    replacements: count,
    caretOffset: matches[0].start + replacement.length,
    hunks: {
      starts: offsets.subarray(0, count),
      ends: offsets.subarray(count),
      insert: replacement,
    },
  }
}

// The model's line-ending normalization (`B/model-session.ts`): CRLF and a lone CR both become LF.
const normalizeEol = (text: string): string => text.replace(/\r\n?/g, '\n')

/** The index of the next `\r\n` at or after `from`, or -1. */
function nextCrlf(text: string, from: number): number {
  let index = text.indexOf('\r', from)
  while (index >= 0 && text.charCodeAt(index + 1) !== 10)
    index = text.indexOf('\r', index + 1)
  return index
}

/**
 * Maps ascending raw offsets (`starts[i] <= ends[i] <= starts[i + 1]`) to normalized offsets in one
 * forward pass: each `\r\n` before an offset removes one code unit; a lone CR keeps its length. Returns
 * false when an offset falls between `\r` and `\n`.
 */
function normalizeOffsets(
  text: string,
  starts: Int32Array,
  ends: Int32Array,
  outStarts: Int32Array,
  outEnds: Int32Array,
): boolean {
  let removed = 0
  let next = nextCrlf(text, 0)
  let whole = true
  const map = (offset: number): number => {
    while (next >= 0 && next < offset) {
      if (next + 1 === offset) whole = false
      removed++
      next = nextCrlf(text, next + 2)
    }
    return offset - removed
  }
  for (let index = 0; index < starts.length; index++) {
    outStarts[index] = map(starts[index])
    outEnds[index] = map(ends[index])
  }
  return whole
}

/**
 * Task 733 / 036 (fix design 2.2): the idle check of a Replace record. Computes each hunk's range in
 * `after`, the normalized offsets and targets, and checks every hunk: normalized `after` at its new
 * range equals the normalized `insert`, and normalized `before` at its old range equals its normalized
 * old text. Runs off the edit path (idle, or once at the Undo or Redo key); it allocates its arrays once.
 */
export function normalizeReplaceHunks(
  before: string,
  after: string,
  hunks: ReplaceHunks,
): NormalizedReplaceHunks {
  const { starts, ends, insert } = hunks
  const count = starts.length
  const rawNew = new Int32Array(count * 2)
  const rawNewStarts = rawNew.subarray(0, count)
  const rawNewEnds = rawNew.subarray(count)
  let shift = 0
  for (let index = 0; index < count; index++) {
    rawNewStarts[index] = starts[index] + shift
    rawNewEnds[index] = rawNewStarts[index] + insert.length
    shift += insert.length - (ends[index] - starts[index])
  }
  let incremental = after.length === before.length + shift
  const beforeCr = before.indexOf('\r') >= 0
  const afterCr = after.indexOf('\r') >= 0
  const normalBefore = beforeCr ? normalizeEol(before) : before
  const normalAfter = afterCr ? normalizeEol(after) : after
  const normalInsert = insert.indexOf('\r') >= 0 ? normalizeEol(insert) : insert
  let oldStarts = starts
  let oldEnds = ends
  if (beforeCr) {
    const offsets = new Int32Array(count * 2)
    oldStarts = offsets.subarray(0, count)
    oldEnds = offsets.subarray(count)
    incremental =
      normalizeOffsets(before, starts, ends, oldStarts, oldEnds) && incremental
  }
  let newStarts = rawNewStarts
  let newEnds = rawNewEnds
  if (afterCr) {
    const offsets = new Int32Array(count * 2)
    newStarts = offsets.subarray(0, count)
    newEnds = offsets.subarray(count)
    incremental =
      normalizeOffsets(after, rawNewStarts, rawNewEnds, newStarts, newEnds) &&
      incremental
  }
  for (let index = 0; incremental && index < count; index++) {
    if (
      normalAfter.slice(newStarts[index], newEnds[index]) !== normalInsert ||
      (beforeCr &&
        normalBefore.slice(oldStarts[index], oldEnds[index]) !==
          normalizeEol(before.slice(starts[index], ends[index])))
    )
      incremental = false
  }
  return {
    incremental,
    before: normalBefore,
    after: normalAfter,
    insert: normalInsert,
    oldStarts,
    oldEnds,
    newStarts,
    newEnds,
  }
}
