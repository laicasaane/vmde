import { ChangeSet, Text } from '@codemirror/state'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  applyChanges,
  mapOffset,
  offsetToPosition,
  singleSpanDiff,
  type TextChange,
  widenToCodePoints,
} from './change-set'

// Fixed seed: every property run is reproducible. `@codemirror/state` and `fast-check` are
// development dependencies used only here as an independent oracle; they never enter the bundle
// (test/backend/dev-dependency-bundle.test.ts).
const RUN = { seed: 733003, numRuns: 400 }

// Whole characters only: ASCII, a newline and two astral characters that share a high surrogate.
const unit = fc.constantFrom('a', 'b', 'c', '\n', '😀', '😁')
const textArb = fc.array(unit, { maxLength: 40 }).map((parts) => parts.join(''))
const insertArb = fc
  .array(unit, { maxLength: 4 })
  .map((parts) => parts.join(''))

/** Ascending, non-overlapping changes over a text of `length`; `minGap` separates neighbours. */
function changesArb(
  length: number,
  minGap: number,
): fc.Arbitrary<TextChange[]> {
  return fc
    .array(fc.record({ gap: fc.nat(6), span: fc.nat(6), insert: insertArb }), {
      maxLength: 6,
    })
    .map((specs) => {
      const changes: TextChange[] = []
      let cursor = 0
      for (const spec of specs) {
        const from = cursor + (changes.length > 0 ? minGap : 0) + spec.gap
        if (from > length) break
        const to = Math.min(length, from + spec.span)
        changes.push({ from, to, insert: spec.insert })
        cursor = to
      }
      return changes
    })
}

const textAndChanges = (minGap: number): fc.Arbitrary<[string, TextChange[]]> =>
  textArb.chain((text) =>
    changesArb(text.length, minGap).map((c): [string, TextChange[]] => [
      text,
      c,
    ]),
  )

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff
const insidePair = (text: string, edge: number): boolean =>
  edge > 0 &&
  edge < text.length &&
  isHigh(text.charCodeAt(edge - 1)) &&
  isLow(text.charCodeAt(edge))

describe('applyChanges', () => {
  it('equals the CodeMirror ChangeSet result', () => {
    fc.assert(
      fc.property(textAndChanges(0), ([text, changes]) => {
        const expected = ChangeSet.of(changes, text.length)
          .apply(Text.of(text.split('\n')))
          .toString()
        expect(applyChanges(text, changes)).toBe(expected)
      }),
      RUN,
    )
  })

  it('returns the text unchanged for no changes', () => {
    expect(applyChanges('abc', [])).toBe('abc')
  })

  it('throws RangeError for from > to', () => {
    expect(() => applyChanges('abc', [{ from: 2, to: 1, insert: '' }])).toThrow(
      RangeError,
    )
  })

  it('throws RangeError for a range outside the text', () => {
    expect(() => applyChanges('abc', [{ from: 1, to: 4, insert: '' }])).toThrow(
      RangeError,
    )
    expect(() =>
      applyChanges('abc', [{ from: -1, to: 1, insert: '' }]),
    ).toThrow(RangeError)
  })

  it('throws RangeError for descending order and for overlap', () => {
    expect(() =>
      applyChanges('abcdef', [
        { from: 3, to: 4, insert: '' },
        { from: 0, to: 1, insert: '' },
      ]),
    ).toThrow(RangeError)
    expect(() =>
      applyChanges('abcdef', [
        { from: 0, to: 3, insert: '' },
        { from: 2, to: 4, insert: '' },
      ]),
    ).toThrow(RangeError)
  })
})

describe('mapOffset', () => {
  it('equals ChangeDesc.mapPos with the same association', () => {
    fc.assert(
      fc.property(
        textAndChanges(1),
        fc.nat(60),
        fc.constantFrom<-1 | 1>(-1, 1),
        ([text, changes], raw, assoc) => {
          const offset = raw % (text.length + 1)
          const desc = ChangeSet.of(changes, text.length)
          expect(mapOffset(offset, changes, assoc)).toBe(
            desc.mapPos(offset, assoc),
          )
        },
      ),
      RUN,
    )
  })

  it('matches CodeMirror for insertions at one offset when the order is explicit', () => {
    const changes = [
      { from: 2, to: 2, insert: 'x' },
      { from: 2, to: 2, insert: 'yz' },
    ]
    const desc = ChangeSet.of(changes, 5)
    for (const assoc of [-1, 1] as const) {
      for (let offset = 0; offset <= 5; offset++) {
        expect(mapOffset(offset, changes, assoc), `${offset}/${assoc}`).toBe(
          desc.mapPos(offset, assoc),
        )
      }
    }
    // Hand table: both insertions sit at the offset, so assoc -1 stays before them and assoc 1 moves after both.
    expect(mapOffset(2, changes, -1)).toBe(2)
    expect(mapOffset(2, changes, 1)).toBe(5)
  })

  it('maps offsets around a replacement followed by an insertion at its end (hand table)', () => {
    const changes = [
      { from: 1, to: 3, insert: 'ab' },
      { from: 3, to: 3, insert: 'x' },
    ]
    expect(mapOffset(1, changes, -1)).toBe(1)
    expect(mapOffset(1, changes, 1)).toBe(1)
    expect(mapOffset(2, changes, -1)).toBe(1)
    expect(mapOffset(2, changes, 1)).toBe(3)
    expect(mapOffset(3, changes, -1)).toBe(3)
    expect(mapOffset(3, changes, 1)).toBe(4)
    expect(mapOffset(4, changes, 1)).toBe(5)
  })

  it('keeps an offset before or moves it after an insertion at the offset', () => {
    const changes = [{ from: 2, to: 2, insert: 'xy' }]
    expect(mapOffset(2, changes, -1)).toBe(2)
    expect(mapOffset(2, changes, 1)).toBe(4)
  })
})

describe('singleSpanDiff', () => {
  it('returns undefined for equal strings', () => {
    expect(singleSpanDiff('same', 'same')).toBeUndefined()
  })

  it('widens a split surrogate pair', () => {
    expect(singleSpanDiff('a😀b', 'a😁b')).toEqual({
      from: 1,
      to: 3,
      insert: '😁',
    })
  })

  it('rebuilds `after` and never cuts a surrogate pair', () => {
    fc.assert(
      fc.property(textArb, textArb, (before, after) => {
        const change = singleSpanDiff(before, after)
        if (before === after) {
          expect(change).toBeUndefined()
          return
        }
        expect(change).toBeDefined()
        const span = change as TextChange
        expect(applyChanges(before, [span])).toBe(after)
        expect(insidePair(before, span.from)).toBe(false)
        expect(insidePair(before, span.to)).toBe(false)
        if (span.insert.length > 0) {
          expect(isLow(span.insert.charCodeAt(0))).toBe(false)
          expect(isHigh(span.insert.charCodeAt(span.insert.length - 1))).toBe(
            false,
          )
        }
      }),
      RUN,
    )
  })
})

describe('widenToCodePoints', () => {
  it('leaves a change with whole-code-point edges unchanged', () => {
    const change = { from: 1, to: 3, insert: 'x' }
    expect(widenToCodePoints('a😀b', change)).toEqual(change)
  })

  it('moves both edges out of a pair and takes the halves into insert', () => {
    // Replaces the low half of the first pair and the high half of the second one: the kept
    // high half of the first pair and the kept low half of the second pair join the insert.
    expect(widenToCodePoints('😀😁', { from: 1, to: 3, insert: 'x' })).toEqual({
      from: 0,
      to: 4,
      insert: '\ud83dx\ude01',
    })
  })
})

describe('offsetToPosition', () => {
  it('equals Text.lineAt (line minus one, offset minus line start)', () => {
    fc.assert(
      fc.property(textArb, fc.nat(60), (text, raw) => {
        const offset = raw % (text.length + 1)
        const line = Text.of(text.split('\n')).lineAt(offset)
        expect(offsetToPosition(text, offset)).toEqual({
          line: line.number - 1,
          character: offset - line.from,
        })
      }),
      RUN,
    )
  })

  it('gives the same answer when counting from a known earlier position', () => {
    fc.assert(
      fc.property(textArb, fc.nat(60), fc.nat(60), (text, rawA, rawB) => {
        const a = rawA % (text.length + 1)
        const b = rawB % (text.length + 1)
        const [early, late] = a <= b ? [a, b] : [b, a]
        const from = { offset: early, line: offsetToPosition(text, early).line }
        expect(offsetToPosition(text, late, from)).toEqual(
          offsetToPosition(text, late),
        )
      }),
      RUN,
    )
  })
})
