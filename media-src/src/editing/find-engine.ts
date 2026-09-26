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

export interface MarkdownReplaceResult {
  changed: boolean
  markdown: string
  replacements: number
  caretOffset: number
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
  return {
    changed: markdown.slice(match.start, match.end) !== replacement,
    markdown:
      markdown.slice(0, match.start) + replacement + markdown.slice(match.end),
    replacements: 1,
    caretOffset: match.start + replacement.length,
  }
}

export function replaceAllMarkdownMatches(
  markdown: string,
  matches: readonly MarkdownMatch[],
  replacement: string,
): MarkdownReplaceResult {
  if (matches.length === 0)
    return { changed: false, markdown, replacements: 0, caretOffset: 0 }
  let output = ''
  let cursor = 0
  for (const match of matches) {
    output += markdown.slice(cursor, match.start) + replacement
    cursor = match.end
  }
  output += markdown.slice(cursor)
  return {
    changed: output !== markdown,
    markdown: output,
    replacements: matches.length,
    caretOffset: matches[0].start + replacement.length,
  }
}
