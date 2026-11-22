// @vitest-environment jsdom
//
// Task 733 / 036 (fix design 2.3, 2.7): the caret of a unit a replay group renders, and the change an
// input makes from its captured intent.
import { describe, expect, it } from 'vitest'
import {
  committedInput,
  mapThroughHunks,
  needsInputIntent,
  replayUnitCaret,
  type UnitHunks,
} from './replay-selection'
import { windowChangeEndpoint } from './undo-restore-caret'

const hunks = (...ranges: [number, number, number, number][]): UnitHunks => ({
  oldStarts: ranges.map((r) => r[0]),
  oldEnds: ranges.map((r) => r[1]),
  newStarts: ranges.map((r) => r[2]),
  newEnds: ranges.map((r) => r[3]),
})

const paragraph = (text: string): HTMLElement => {
  const p = document.createElement('p')
  p.textContent = text
  document.body.appendChild(p)
  return p
}

describe('replay caret, positional rule (2.7 rule 1)', () => {
  // Test (a): equal rendered strings do not prove caret identity.
  it('maps a caret between two `a` by the hunk that deleted one of them', () => {
    const counts = { caretFallback: 0, caretDiff: 0 }
    const first = replayUnitCaret(
      {
        offset: 1,
        oldRendered: 'aa',
        oldSource: 'aa',
        newRendered: 'a',
        newSource: 'a',
        hunks: hunks([0, 1, 0, 0]),
        isRedo: false,
        previousText: 'aa',
        restored: [],
      },
      counts,
    )
    const second = replayUnitCaret(
      {
        offset: 1,
        oldRendered: 'aa',
        oldSource: 'aa',
        newRendered: 'a',
        newSource: 'a',
        hunks: hunks([1, 2, 1, 1]),
        isRedo: false,
        previousText: 'aa',
        restored: [],
      },
      counts,
    )
    // Deleting the first `a` puts the caret before the kept one, deleting the second after it.
    expect(first).toEqual({ kind: 'positional', offset: 0 })
    expect(second).toEqual({ kind: 'positional', offset: 1 })
    expect(counts.caretFallback).toBe(0)
  })

  // Test (b): repeated text around the caret.
  it('keeps the caret after `x` in `ZZZZ x ZZZZ` restored to `ncjw x ncjw`', () => {
    const counts = { caretFallback: 0, caretDiff: 0 }
    const caret = replayUnitCaret(
      {
        offset: 6,
        oldRendered: 'ZZZZ x ZZZZ',
        oldSource: 'ZZZZ x ZZZZ',
        newRendered: 'ncjw x ncjw',
        newSource: 'ncjw x ncjw',
        hunks: hunks([0, 4, 0, 4], [7, 11, 7, 11]),
        isRedo: false,
        previousText: 'ZZZZ x ZZZZ',
        restored: [],
      },
      counts,
    )
    expect(caret).toEqual({ kind: 'positional', offset: 6 })
    expect(counts.caretFallback).toBe(0)
  })

  it('moves by each passed hunk and lands at the start (Undo) or end (Redo) inside one', () => {
    const set = hunks([2, 4, 2, 7], [8, 8, 11, 14])
    expect(mapThroughHunks(1, set, false)).toBe(1)
    expect(mapThroughHunks(2, set, false)).toBe(2)
    expect(mapThroughHunks(3, set, false)).toBe(2)
    expect(mapThroughHunks(3, set, true)).toBe(7)
    expect(mapThroughHunks(4, set, false)).toBe(7)
    expect(mapThroughHunks(6, set, false)).toBe(9)
    // A zero-width hunk (an Undo that re-inserts text) at the caret.
    expect(mapThroughHunks(8, set, false)).toBe(11)
    expect(mapThroughHunks(8, set, true)).toBe(14)
    expect(mapThroughHunks(9, set, false)).toBe(15)
  })
})

describe('replay caret, unsliced rule (2.7 rule 2)', () => {
  // Test (c): the rendered text differs from the source (an escaped character), with repeated old text.
  it('takes the endpoint of the unsliced path and counts `caret-fallback`', () => {
    const restored = paragraph('b*b*')
    const counts = { caretFallback: 0, caretDiff: 0 }
    const caret = replayUnitCaret(
      {
        offset: 2,
        oldRendered: 'a*a*',
        oldSource: 'a\\*a\\*',
        newRendered: 'b*b*',
        newSource: 'b\\*b\\*',
        hunks: hunks([0, 1, 0, 1], [3, 4, 3, 4]),
        isRedo: false,
        previousText: 'a*a*',
        restored: [restored],
      },
      counts,
    )
    const unsliced = windowChangeEndpoint('a*a*', [restored], false)
    expect(unsliced).not.toBeNull()
    expect(caret).toEqual({ kind: 'unsliced', endpoint: unsliced })
    expect(counts.caretFallback).toBe(1)
  })

  it('keeps a usable saved selection, as the unsliced path does for a step with a caret', () => {
    const restored = paragraph('b*b*')
    const saved = { node: restored.firstChild as Node, offset: 3 }
    const counts = { caretFallback: 0, caretDiff: 0 }
    const caret = replayUnitCaret(
      {
        offset: 2,
        oldRendered: 'a*a*',
        oldSource: 'a\\*a\\*',
        newRendered: 'b*b*',
        newSource: 'b\\*b\\*',
        hunks: hunks([0, 1, 0, 1]),
        isRedo: true,
        previousText: 'a*a*',
        restored: [restored],
        saved,
      },
      counts,
    )
    expect(caret).toEqual({ kind: 'unsliced', endpoint: saved })
    expect(counts.caretFallback).toBe(1)
  })
})

// Task 733 / 036 (H2 fix design rev2, D1.2): a unit whose rendered text is not its source keeps a caret
// that lies outside the rendered difference under both alignments; it never yields a byte offset.
describe('replay caret, rendered-difference rule (D1.2)', () => {
  const listItem = (
    offset: number,
    oldRendered: string,
    newRendered: string,
  ) => {
    const counts = { caretFallback: 0, caretDiff: 0 }
    const caret = replayUnitCaret(
      {
        offset,
        oldRendered,
        oldSource: `- ${oldRendered}`,
        newRendered,
        newSource: `- ${newRendered}`,
        hunks: hunks([4, 8, 4, 8]),
        isRedo: false,
        previousText: `- ${oldRendered}`,
        restored: [paragraph(newRendered)],
      },
      counts,
    )
    return { caret, counts }
  }

  it('keeps a list item caret after `b` in `a ZZZZ b` restored to `a ncjw b`, counted `caret-diff`', () => {
    const { caret, counts } = listItem(8, 'a ZZZZ b', 'a ncjw b')
    expect(caret).toEqual({ kind: 'positional', offset: 8 })
    expect(counts).toEqual({ caretFallback: 0, caretDiff: 1 })
  })

  it('keeps a caret before the difference and moves one after it by the length change', () => {
    expect(listItem(1, 'a ZZZZ b', 'a ncjw b').caret).toEqual({
      kind: 'positional',
      offset: 1,
    })
    expect(listItem(8, 'a ZZZZZZ b', 'a ncjw b').caret).toEqual({
      kind: 'positional',
      offset: 6,
    })
  })

  it('falls back for a caret inside the difference', () => {
    const { caret, counts } = listItem(4, 'a ZZZZ b', 'a ncjw b')
    expect(caret.kind).toBe('unsliced')
    expect(counts).toEqual({ caretFallback: 1, caretDiff: 0 })
  })

  it('falls back when the two alignments disagree: `aa` to `a` and `abcabc` to `abc`', () => {
    for (const [offset, oldRendered, newRendered] of [
      [1, 'aa', 'a'],
      [3, 'abcabc', 'abc'],
    ] as const) {
      const { caret, counts } = listItem(offset, oldRendered, newRendered)
      expect(caret.kind).toBe('unsliced')
      expect(counts).toEqual({ caretFallback: 1, caretDiff: 0 })
    }
  })
})

describe('captured input intent (2.3)', () => {
  // The step B example: `R = "aXXbQQd"`, a paste of the displayed bytes `aXXb` over `[0,4)`.
  it('keeps the intent range when the paste writes exactly the displayed bytes', () => {
    const r = 'aXXbQQd'
    expect(
      committedInput({ rFrom: 0, rTo: 4 }, r.length, r, null, true),
    ).toEqual({ rFrom: 0, rTo: 4, insert: 'aXXb' })
  })

  it('commits the text the editor inserted, including a paste transform', () => {
    // `R = "aXXbQQd"`, intent `[1,3)`; the transform wrote `| a |` and the sync reports a shorter span.
    const after = 'a| a |bQQd'
    const diff = { rFrom: 1, rTo: 3, insert: '| a |' }
    expect(committedInput({ rFrom: 1, rTo: 3 }, 7, after, diff, true)).toEqual({
      rFrom: 1,
      rTo: 3,
      insert: '| a |',
    })
    // The minimized span lies inside the intent: the intent range is kept.
    const inside = 'aXYbQQd'
    expect(
      committedInput(
        { rFrom: 0, rTo: 4 },
        7,
        inside,
        { rFrom: 2, rTo: 3, insert: 'Y' },
        true,
      ),
    ).toEqual({ rFrom: 0, rTo: 4, insert: 'aXYb' })
    // The editor also rewrote a neighbour past the intent: the change covers both.
    const wider = 'aZbQQe'
    expect(
      committedInput(
        { rFrom: 1, rTo: 3 },
        7,
        wider,
        { rFrom: 1, rTo: 7, insert: 'ZbQQe' },
        true,
      ),
    ).toEqual({ rFrom: 1, rTo: 7, insert: 'ZbQQe' })
  })

  it('makes no change when the editor wrote nothing (a cancelled paste)', () => {
    expect(
      committedInput({ rFrom: 0, rTo: 4 }, 7, 'aXXbQQd', null, false),
    ).toBeNull()
  })

  it('captures the intent of paste, drop, Cut, and typing or IME over a selection', () => {
    expect(needsInputIntent('paste', true)).toBe(true)
    expect(needsInputIntent('drop', true)).toBe(true)
    expect(needsInputIntent('cut', false)).toBe(true)
    expect(needsInputIntent('beforeinput', false)).toBe(true)
    expect(needsInputIntent('compositionstart', false)).toBe(true)
    expect(needsInputIntent('beforeinput', true)).toBe(false)
    expect(needsInputIntent('keydown', false)).toBe(false)
  })
})
