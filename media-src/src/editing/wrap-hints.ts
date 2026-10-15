/**
 * Task 640 S2a — pure wrap-hint planner for words that are too wide for their line.
 *
 * The browser cannot rank line-break opportunities, so the editor chooses which opportunities exist
 * by inserting zero-width hints at planned positions. This module only decides WHERE; it reads no
 * layout and writes no DOM. Positions are UTF-16 code-unit offsets into the word (what
 * `Text.splitText` takes) and always fall on grapheme boundaries.
 *
 * Priorities (Owner decisions 2026-10-15, see tasks/640-long-word-wrap-break-priority.md):
 *  1. after the last character of a run of ASCII punctuation, brackets included (never inside a run;
 *     quotes and the backtick are not separators);
 *  2. on both sides of a digit run (a letter/digit boundary in either direction, never inside a run);
 *  3. between a lowercase letter and the uppercase letter that follows it (no acronym splitting).
 * A final piece of at most `minLastPiece` graphemes is never split off the end of the word.
 */

/** Default of `vmde.editor.wrapHints.minLastPiece`. */
export const DEFAULT_MIN_LAST_PIECE = 3

export type WrapTier = 1 | 2 | 3

/** Width in px of a piece of the word, supplied by the caller (Range rects in the engine). */
export type MeasurePiece = (piece: string) => number

// ASCII punctuation that separates parts of a word. Quotes (" ') and the backtick are left out on
// purpose: they delimit text, they are not break points inside a path or an identifier.
const SEPARATORS = new Set('/\\.,;:_-|=&?#!@~+*%$^()[]{}<>')

const LETTER = /^\p{L}/u
const DIGIT = /^\p{Nd}/u
const LOWER = /^\p{Ll}/u
const UPPER = /^\p{Lu}/u

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

interface Grapheme {
  /** UTF-16 offset of the grapheme in the word. */
  index: number
  /** A single separator character (a separator followed by a combining mark is not one). */
  separator: boolean
  /** Character class of the base (first) code point. */
  letter: boolean
  digit: boolean
  lower: boolean
  upper: boolean
}

function segment(word: string): Grapheme[] {
  const result: Grapheme[] = []
  for (const { segment: text, index } of segmenter.segment(word)) {
    result.push({
      index,
      // A multi-unit grapheme starting with `/` is `/` plus a mark: no boundary may fall inside it,
      // so it is not a separator run.
      separator: text.length === 1 && SEPARATORS.has(text),
      letter: LETTER.test(text),
      digit: DIGIT.test(text),
      lower: LOWER.test(text),
      upper: UPPER.test(text),
    })
  }
  return result
}

/** Does a break between `prev` and `next` belong to `tier`? */
function isBreak(tier: WrapTier, prev: Grapheme, next: Grapheme): boolean {
  switch (tier) {
    case 1:
      return prev.separator && !next.separator
    case 2:
      return (prev.letter && next.digit) || (prev.digit && next.letter)
    case 3:
      return prev.lower && next.upper
  }
}

/** Positions of one tier, with the graphemes after the break counted for the final-piece rule. */
interface Candidate {
  position: number
  /** Graphemes from the position to the end of the word. */
  tail: number
}

function candidates(
  graphemes: readonly Grapheme[],
  tier: WrapTier,
): Candidate[] {
  const result: Candidate[] = []
  for (let i = 1; i < graphemes.length; i += 1) {
    if (isBreak(tier, graphemes[i - 1], graphemes[i])) {
      result.push({ position: graphemes[i].index, tail: graphemes.length - i })
    }
  }
  return result
}

/**
 * Break positions of one priority tier in ascending order: never at the word start or end, never
 * inside a grapheme. Raw positions: the final-piece rule is applied separately.
 */
export function wrapBreakPositions(word: string, tier: WrapTier): number[] {
  return candidates(segment(word), tier).map((candidate) => candidate.position)
}

/**
 * The final-piece rule: drop every position whose tail to the end of the word is at most
 * `minLastPiece` graphemes (separators count). 0 drops nothing.
 */
export function applyMinLastPiece(
  word: string,
  positions: readonly number[],
  minLastPiece: number,
): number[] {
  if (minLastPiece <= 0) return [...positions]
  return positions.filter((position) => {
    let tail = 0
    for (const _ of segmenter.segment(word.slice(position))) tail += 1
    return tail > minLastPiece
  })
}

/**
 * One tier of the plan: the eligible `positions` that fall inside a piece of `cuts` still wider
 * than `limit`. Pieces are the spans between consecutive cuts (and the word ends).
 */
function positionsInWidePieces(
  word: string,
  cuts: readonly number[],
  positions: readonly number[],
  measure: MeasurePiece,
  limit: number,
): number[] {
  const bounds = [0, ...cuts, word.length]
  const added: number[] = []
  for (let i = 1; i < bounds.length; i += 1) {
    const start = bounds[i - 1]
    const end = bounds[i]
    if (measure(word.slice(start, end)) <= limit) continue
    for (const position of positions) {
      if (position > start && position < end) added.push(position)
    }
  }
  return added
}

/**
 * Hint positions for a word, tier by tier. Nothing when the word fits `limit`; priority 1
 * everywhere otherwise; priority 2 inside the pieces that are still wider than `limit`; then
 * priority 3 inside the pieces of that result that are still too wide. What no tier can split is
 * left to the browser's break-anywhere fallback. The final-piece rule filters every tier, so a
 * merged last piece is measured as it will be rendered. A piece fits when its width is `<= limit`.
 */
export function planWrapBreaks(
  word: string,
  measure: MeasurePiece,
  limit: number,
  minLastPiece: number = DEFAULT_MIN_LAST_PIECE,
): number[] {
  if (measure(word) <= limit) return []
  const graphemes = segment(word)
  let cuts: number[] = []
  for (const tier of [1, 2, 3] as const) {
    const eligible = candidates(graphemes, tier)
      .filter((candidate) => candidate.tail > minLastPiece)
      .map((candidate) => candidate.position)
    const added = positionsInWidePieces(word, cuts, eligible, measure, limit)
    cuts = [...cuts, ...added].sort((a, b) => a - b)
  }
  return cuts
}

/**
 * Cheap length pre-filter: can a word of `length` code points be wider than `lineWidth`? It does
 * not read layout. By default no glyph is assumed wider than 1.5 em. For a monospace font pass the
 * measured advance (px, cached per font key): the bound becomes `length * advance`, which rejects
 * ordinary paths at 14 px that the 1.5 em bound passes. Pass it only for words made of characters
 * the font really has (a fallback font can draw a wider glyph than the monospace advance).
 */
export function mayBeTooWide(
  length: number,
  lineWidth: number,
  fontSize: number,
  monospaceAdvance?: number,
): boolean {
  if (length <= 0) return false
  return length * (monospaceAdvance ?? 1.5 * fontSize) > lineWidth
}
