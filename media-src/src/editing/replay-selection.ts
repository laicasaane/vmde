// Task 733 / 036 (fix design 2.3, 2.7): the selection rules of an exact history replay that need no
// replay state: the caret of a unit that a replay group renders, and the change an input makes when
// its intent was captured at the event. Pure; the replay engine owns the coordinate spaces and calls
// these with unit-local or rendered offsets.

import { windowChangeEndpoint } from './undo-restore-caret'

/** The hunks of one unit, old range in the unit's old source text and new range in its new one, ascending. */
export interface UnitHunks {
  readonly oldStarts: ArrayLike<number>
  readonly oldEnds: ArrayLike<number>
  readonly newStarts: ArrayLike<number>
  readonly newEnds: ArrayLike<number>
}

/** A live endpoint, as the unsliced restore computes it. */
type ReplayEndpoint = NonNullable<ReturnType<typeof windowChangeEndpoint>>

/** The counters the gate reads (`caret-fallback`, `caret-diff`; kinds and numbers only). */
export interface ReplayCaretCounts {
  caretFallback: number
  caretDiff: number
}

/**
 * The positional rule (2.7 rule 1): an offset of the old source text mapped through the hunks one by one.
 * Before a hunk it keeps its place, after a hunk it moves by that hunk's length change, and inside one
 * (or at a zero-width hunk) it lands at the hunk's new start for Undo and its new end for Redo. No text
 * is searched, so repeated text cannot move it. O(hunks), no allocation.
 */
export function mapThroughHunks(
  offset: number,
  hunks: UnitHunks,
  isRedo: boolean,
): number {
  const count = hunks.oldStarts.length
  let shift = 0
  for (let i = 0; i < count; i++) {
    const from = hunks.oldStarts[i]
    const to = hunks.oldEnds[i]
    if (offset < from || (offset === from && to > from)) return offset + shift
    if (offset > to || (offset === to && to > from)) {
      shift = hunks.newEnds[i] - to
      continue
    }
    return isRedo ? hunks.newEnds[i] : hunks.newStarts[i]
  }
  return offset + shift
}

/** The unit whose caret endpoint a rendered group moves, with its old and new rendered and source text. */
export interface RenderedUnitCaret {
  /**
   * The endpoint as an offset of the unit's old rendered text (equal to its source offset when the
   * rendered text is the source text).
   */
  readonly offset: number
  readonly oldRendered: string
  readonly oldSource: string
  readonly newRendered: string
  readonly newSource: string
  readonly hunks: UnitHunks
  readonly isRedo: boolean
  /** For the unsliced rule: the window's source text before the write and the elements it wrote. */
  readonly previousText: string
  readonly restored: readonly Element[]
  /**
   * The saved selection of the history step, when it is usable. The unsliced restore puts it back and
   * computes the change site (`windowChangeEndpoint`) only for a missing caret (`caretRequest`,
   * `E/unit-history.ts`), so the unsliced rule keeps it too.
   */
  readonly saved?: ReplayEndpoint
}

export type ReplayCaret =
  | { kind: 'positional'; offset: number }
  | { kind: 'unsliced'; endpoint: ReplayEndpoint | null }

/**
 * Task 733 / 036 (H2 fix design rev2, D1.2): the rendered offset `offset` of `oldText` in `newText` when
 * it lies outside the single difference of the two texts under both alignments (common prefix first,
 * then common suffix first) and both give the same result; -1 otherwise. Repeated text at the
 * difference makes the alignments disagree (`aa` to `a`), so such a caret is not guessed. A caret rule
 * only: the result is a rendered offset, never a Markdown byte offset. O(text), no allocation.
 */
function renderedDifferenceOffset(
  offset: number,
  oldText: string,
  newText: string,
): number {
  const shorter = Math.min(oldText.length, newText.length)
  const delta = newText.length - oldText.length
  let prefix = 0
  while (prefix < shorter && oldText[prefix] === newText[prefix]) prefix++
  let suffix = 0
  while (
    suffix < shorter &&
    oldText[oldText.length - 1 - suffix] ===
      newText[newText.length - 1 - suffix]
  )
    suffix++
  // Prefix first: the suffix is limited to what the prefix left; suffix first: the other way round.
  const prefixFirst = outsideDifference(
    offset,
    prefix,
    Math.min(suffix, shorter - prefix),
    oldText.length,
    delta,
  )
  const suffixFirst = outsideDifference(
    offset,
    Math.min(prefix, shorter - suffix),
    suffix,
    oldText.length,
    delta,
  )
  return prefixFirst >= 0 && prefixFirst === suffixFirst ? prefixFirst : -1
}

/** The mapped offset of a point in the common prefix or suffix of one alignment; -1 inside the difference. */
function outsideDifference(
  offset: number,
  prefix: number,
  suffix: number,
  oldLength: number,
  delta: number,
): number {
  if (offset <= prefix) return offset
  if (offset >= oldLength - suffix) return offset + delta
  return -1
}

/**
 * The caret of a unit a replay group renders (2.7). Rendered offsets are source offsets only when the
 * old and the new rendered text equal their source text; then the positional rule applies. Otherwise a
 * caret outside the rendered difference keeps its place by the rendered-difference rule (D1.2, counted
 * `caret-diff`); any other endpoint is the one today's whole restore gives for this window, counted
 * `caret-fallback`, so the behaviour equals the unsliced path by construction.
 */
export function replayUnitCaret(
  unit: RenderedUnitCaret,
  counts: ReplayCaretCounts,
): ReplayCaret {
  if (
    unit.oldRendered === unit.oldSource &&
    unit.newRendered === unit.newSource
  )
    return {
      kind: 'positional',
      offset: mapThroughHunks(unit.offset, unit.hunks, unit.isRedo),
    }
  const kept = renderedDifferenceOffset(
    unit.offset,
    unit.oldRendered,
    unit.newRendered,
  )
  if (kept >= 0) {
    counts.caretDiff++
    return { kind: 'positional', offset: kept }
  }
  counts.caretFallback++
  return {
    kind: 'unsliced',
    endpoint:
      unit.saved ??
      windowChangeEndpoint(unit.previousText, unit.restored, unit.isRedo),
  }
}

/** The range an input replaces, captured from the selection at the event, in rendered offsets. */
export interface InputIntent {
  readonly rFrom: number
  readonly rTo: number
}

/** A change in rendered offsets against the rendered text before the input. */
export interface RenderedInput {
  readonly rFrom: number
  readonly rTo: number
  readonly insert: string
}

/**
 * The change an input made, from its captured intent and the text the editor actually wrote (2.3 and the
 * second-opinion qualification on paste transforms). DOM sync shrinks a change to its single-span
 * difference (`diff`, against the old rendered text); over a pending group that loses the logical
 * change, so the change keeps the whole intent range and also covers whatever the editor wrote beyond
 * it (a paste transform, a re-serialized neighbour). `mutated` is false when the editor wrote nothing
 * (a cancelled paste): then there is no change. An insertion of exactly the displayed bytes is a
 * change of the intent range with unchanged rendered text. O(1) apart from the one slice of the result.
 */
export function committedInput(
  intent: InputIntent,
  oldLength: number,
  after: string,
  diff: RenderedInput | null,
  mutated: boolean,
): RenderedInput | null {
  if (!diff && !mutated) return null
  const rFrom = diff ? Math.min(intent.rFrom, diff.rFrom) : intent.rFrom
  const rTo = diff ? Math.max(intent.rTo, diff.rTo) : intent.rTo
  const delta = after.length - oldLength
  return { rFrom, rTo, insert: after.slice(rFrom, rTo + delta) }
}

/**
 * The input needs its intent captured before its default action (2.3): it can replace a range that a
 * pending group touches. A collapsed `beforeinput` and a plain key insert at the caret, which the
 * minimized difference describes exactly once the caret group is rendered.
 */
export function needsInputIntent(type: string, collapsed: boolean): boolean {
  if (type === 'paste' || type === 'drop' || type === 'cut') return true
  return !collapsed && (type === 'beforeinput' || type === 'compositionstart')
}
