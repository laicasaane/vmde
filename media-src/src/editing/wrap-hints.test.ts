import { describe, expect, it } from 'vitest'
import {
  applyMinLastPiece,
  DEFAULT_MIN_LAST_PIECE,
  mayBeTooWide,
  planWrapBreaks,
  wrapBreakPositions,
} from './wrap-hints'

// Task 640 S2a. Expected values are worked out by hand from the Owner decisions (2026-10-15) and the
// "Part 1 revision" contract in tasks/done/640-long-word-wrap-break-priority.md, never from the code:
//  OD3  "Break after it": priority 1 is after the last character of an ASCII punctuation run,
//       brackets included; quotes and the backtick are not separators; never inside a run.
//  OD4  "Allow piece up to N characters ... default is 3": a break whose tail to the word end is
//       at most N graphemes (separators count) is dropped.
//  OD5  "No acronym splitting": priority 3 is a lowercase letter followed by an uppercase letter only.
//  Rev. 3  priority 2 is a letter/digit boundary in either direction, never inside a digit run.
// Positions are UTF-16 code-unit offsets into the word (what Text.splitText takes) and are always
// grapheme boundaries.

// The Owner example path, 76 code units:
//   `../` 0-3, `EncosyTower.` 3-15, `Tests.` 15-21, `EditorMode/` 21-32, `EncosyTower.` 32-44,
//   `PageFlows/` 44-54, `PageFlowTestDoubles.` 54-74, `cs` 74-76.
const OWNER_PATH =
  '../EncosyTower.Tests.EditorMode/EncosyTower.PageFlows/PageFlowTestDoubles.cs'

// 10 px per UTF-16 code unit: a piece of k characters is 10 * k px wide, so a limit of 10 * c px
// holds c characters.
const tenPerChar = (piece: string): number => piece.length * 10

describe('wrapBreakPositions', () => {
  it('OD3 priority 1: breaks after the last character of a punctuation run, never inside it', () => {
    // `../` is one run (0-2) followed by `E`: a break only after it, none at 1 or 2.
    expect(wrapBreakPositions('../EncosyTower', 1)).toEqual([3])
    // `::` stays whole: a, `::` (1-2), b -> one position after the run.
    expect(wrapBreakPositions('a::b', 1)).toEqual([3])
    // `()` is one run and ends the word: no position (never at the word end).
    expect(wrapBreakPositions('foo()', 1)).toEqual([])
    // `>(` is one run: `a>(b` has a single position after `(`.
    expect(wrapBreakPositions('a>(b', 1)).toEqual([3])
  })

  it('OD3 priority 1: the Owner path breaks after every separator run (before the final-piece rule)', () => {
    expect(wrapBreakPositions(OWNER_PATH, 1)).toEqual([
      3, 15, 21, 32, 44, 54, 74,
    ])
  })

  it('OD3 priority 1: Option<IPageOwnershipTracker> breaks after `<` and not before it', () => {
    // `Option<` is 7 code units; the closing `>` is at the word end, so it adds no position.
    expect(wrapBreakPositions('Option<IPageOwnershipTracker>', 1)).toEqual([7])
  })

  it('OD3 priority 1: an opening bracket is an ordinary separator (Foo(bar) breaks after `(`)', () => {
    expect(wrapBreakPositions('Foo(bar)', 1)).toEqual([4])
  })

  it('OD3 priority 1: quotes and the backtick are not separators', () => {
    // No ASCII punctuation from the set, so no position at all.
    expect(wrapBreakPositions('say"hello"it\'s`x`', 1)).toEqual([])
    // A quote after a separator only ends the run: the break is after `.`, before the quote.
    expect(wrapBreakPositions('a."b', 1)).toEqual([2])
  })

  it('priority 1 uses every listed separator character', () => {
    // One run of exactly one separator between `a` and `b` for each member of the contract set.
    const set = '/\\.,;:_-|=&?#!@~+*%$^()[]{}<>'
    for (const ch of set) {
      expect(wrapBreakPositions(`a${ch}b`, 1), `separator ${ch}`).toEqual([2])
    }
  })

  it('priority 1 has no position at the word start or end', () => {
    expect(wrapBreakPositions('.cs', 1)).toEqual([1])
    expect(wrapBreakPositions('///', 1)).toEqual([])
    expect(wrapBreakPositions('abc.', 1)).toEqual([])
  })

  it('Rev. 3 priority 2: both sides of a digit run, never inside it', () => {
    // v(0) 2026(1-4) Release(5-11) 10(12-13)
    expect(wrapBreakPositions('v2026Release10', 2)).toEqual([1, 5, 12])
    // URP(0-2) 17(3-4) Compat(5-10)
    expect(wrapBreakPositions('URP17Compat', 2)).toEqual([3, 5])
    // LitPass(0-6) 2(7) D(8)
    expect(wrapBreakPositions('LitPass2D', 2)).toEqual([7, 8])
    expect(wrapBreakPositions('12345', 2)).toEqual([])
  })

  it('OD5 priority 3: only a lowercase letter followed by an uppercase letter', () => {
    // Table | List
    expect(wrapBreakPositions('TableList', 3)).toEqual([5])
    expect(wrapBreakPositions('fooBarBaz', 3)).toEqual([3, 6])
  })

  it('OD5 no acronym splitting: HTMLParser gets no priority 3 position', () => {
    expect(wrapBreakPositions('HTMLParser', 3)).toEqual([])
    // p(6) -> R(7) is the only lowercase-to-uppercase edge; X|M|L|H and L|... are uppercase pairs.
    expect(wrapBreakPositions('XMLHttpRequest', 3)).toEqual([7])
    // The lowercase-to-uppercase edge before an acronym still counts (e|H at 5); H|T|M|L|N do not.
    expect(wrapBreakPositions('parseHTMLNow', 3)).toEqual([5])
  })

  it('tiers do not leak into each other', () => {
    const word = 'a/B1cD'
    // a / B 1 c D: P1 after `/` (2); P2 at B|1? both upper letter and digit: 3 and 1|c at 4; P3 c|D at 5.
    expect(wrapBreakPositions(word, 1)).toEqual([2])
    expect(wrapBreakPositions(word, 2)).toEqual([3, 4])
    expect(wrapBreakPositions(word, 3)).toEqual([5])
  })

  it('never returns the word start or end, and is empty for a word without boundaries', () => {
    expect(wrapBreakPositions('', 1)).toEqual([])
    expect(wrapBreakPositions('a', 2)).toEqual([])
    for (const tier of [1, 2, 3] as const) {
      for (const p of wrapBreakPositions(`${OWNER_PATH}A1b`, tier)) {
        expect(p).toBeGreaterThan(0)
        expect(p).toBeLessThan(OWNER_PATH.length + 3)
      }
    }
  })

  it('CJK-only text gets no position in any tier', () => {
    for (const tier of [1, 2, 3] as const) {
      expect(wrapBreakPositions('日本語のテキスト', tier)).toEqual([])
    }
  })

  it('mixed CJK and ASCII still breaks after ASCII separators', () => {
    // 日本語(0-2) /(3) File.cs: after `/` at 4, after `.` at 9.
    expect(wrapBreakPositions('日本語/File.cs', 1)).toEqual([4, 9])
  })

  it('never splits inside an emoji ZWJ sequence: offsets are code units on grapheme boundaries', () => {
    // a(0) /(1) family man-ZWJ-woman-ZWJ-girl-ZWJ-boy (2-12, 11 code units) /(13) b(14)
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'
    expect(family.length).toBe(11)
    const word = `a/${family}/b`
    expect(wrapBreakPositions(word, 1)).toEqual([2, 14])
    for (const tier of [2, 3] as const)
      expect(wrapBreakPositions(word, tier)).toEqual([])
  })

  it('never breaks before a combining mark: a separator with a mark is not a separator', () => {
    // `/` + U+0301 is one grapheme, so there is no boundary between them and no separator run.
    expect(wrapBreakPositions('a/́b', 1)).toEqual([])
  })

  it('classifies a grapheme by its base letter: a + combining mark followed by uppercase', () => {
    // a(0) U+0301(1) B(2): the boundary at 2 follows the grapheme "á" (lowercase base).
    expect(wrapBreakPositions('áB', 3)).toEqual([2])
    // digit after a letter with a mark: priority 2 at the grapheme boundary.
    expect(wrapBreakPositions('á1', 2)).toEqual([2])
  })

  it('handles surrogate-pair letters as one character (code-unit offsets)', () => {
    // a(0) MATHEMATICAL BOLD CAPITAL A (1-2, uppercase) b(3)
    expect(wrapBreakPositions('a\u{1D400}b', 3)).toEqual([1])
  })
})

describe('applyMinLastPiece', () => {
  it('OD4 drops a break whose tail is at most N graphemes, separators counted', () => {
    // `cs` is 2 graphemes: the break at 74 goes for N = 3 (and for N = 2), stays for N = 1.
    const p1 = wrapBreakPositions(OWNER_PATH, 1)
    expect(applyMinLastPiece(OWNER_PATH, p1, 3)).toEqual([
      3, 15, 21, 32, 44, 54,
    ])
    expect(applyMinLastPiece(OWNER_PATH, p1, 2)).toEqual([
      3, 15, 21, 32, 44, 54,
    ])
    expect(applyMinLastPiece(OWNER_PATH, p1, 1)).toEqual([
      3, 15, 21, 32, 44, 54, 74,
    ])
  })

  it('OD4 N = 0 drops nothing', () => {
    const p1 = wrapBreakPositions(OWNER_PATH, 1)
    expect(applyMinLastPiece(OWNER_PATH, p1, 0)).toEqual(p1)
  })

  it('OD4 the boundary is inclusive: a tail of exactly N graphemes is dropped', () => {
    // src/fooBarBaz: P1 at 4 (tail `fooBarBaz` = 9 graphemes), P3 at 7 (tail 6) and 10 (tail `Baz` = 3).
    const word = 'src/fooBarBaz'
    const all = [4, 7, 10]
    expect(applyMinLastPiece(word, all, 3)).toEqual([4, 7])
    expect(applyMinLastPiece(word, all, 2)).toEqual([4, 7, 10])
    expect(applyMinLastPiece(word, all, 6)).toEqual([4])
    expect(applyMinLastPiece(word, all, 8)).toEqual([4])
    expect(applyMinLastPiece(word, all, 9)).toEqual([])
  })

  it('OD4 edge N = 20: every break within the last 20 graphemes goes', () => {
    expect(applyMinLastPiece('src/fooBarBaz', [4, 7, 10], 20)).toEqual([])
    // The Owner path is 76 graphemes: only the breaks with a tail above 20 stay (offsets up to 54).
    const p1 = wrapBreakPositions(OWNER_PATH, 1)
    expect(applyMinLastPiece(OWNER_PATH, p1, 20)).toEqual([
      3, 15, 21, 32, 44, 54,
    ])
    expect(applyMinLastPiece(OWNER_PATH, p1, 22)).toEqual([3, 15, 21, 32, 44])
  })

  it('OD4 counts graphemes, not code units: an emoji sequence is one', () => {
    // a/ then three single-grapheme emoji (2 code units each): tail at 2 is 3 graphemes.
    const word = 'a/\u{1F600}\u{1F600}\u{1F600}'
    expect(applyMinLastPiece(word, [2], 3)).toEqual([])
    expect(applyMinLastPiece(word, [2], 2)).toEqual([2])
  })

  it('exposes the default of 3', () => {
    expect(DEFAULT_MIN_LAST_PIECE).toBe(3)
  })
})

describe('planWrapBreaks', () => {
  it('a word that fits gets no hints, with one measurement', () => {
    const calls: string[] = []
    const plan = planWrapBreaks(
      OWNER_PATH,
      (piece) => {
        calls.push(piece)
        return tenPerChar(piece)
      },
      760,
    )
    expect(plan).toEqual([])
    expect(calls).toEqual([OWNER_PATH])
  })

  it('passes each measured piece with its offsets in the word, so a caller can measure in place', () => {
    const calls: Array<[string, number, number]> = []
    planWrapBreaks(
      'src/fooBarBaz',
      (piece, start, end) => {
        calls.push([piece, start, end])
        return tenPerChar(piece)
      },
      40,
      0,
    )
    // The whole word, then the two priority-1 pieces, then the priority-3 pieces of `fooBarBaz`.
    expect(calls[0]).toEqual(['src/fooBarBaz', 0, 13])
    expect(calls).toContainEqual(['src/', 0, 4])
    expect(calls).toContainEqual(['fooBarBaz', 4, 13])
    for (const [piece, start, end] of calls)
      expect('src/fooBarBaz'.slice(start, end)).toBe(piece)
  })

  it('a word exactly as wide as the line fits', () => {
    // abc/defg: 8 characters, one priority-1 position at 4 whose tail `defg` (4) is above N = 3.
    expect(planWrapBreaks('abc/defg', tenPerChar, 80)).toEqual([])
    expect(planWrapBreaks('abc/defg', tenPerChar, 79)).toEqual([4])
  })

  it('empty and single-grapheme words get none', () => {
    expect(planWrapBreaks('', tenPerChar, 0)).toEqual([])
    expect(planWrapBreaks('W', tenPerChar, 5)).toEqual([])
  })

  it('Owner path, 25-char line: priority 1 only, because every priority-1 piece fits', () => {
    // N = 3 default: no break before `cs`; the last piece `PageFlowTestDoubles.cs` is 22 <= 25.
    expect(planWrapBreaks(OWNER_PATH, tenPerChar, 250)).toEqual([
      3, 15, 21, 32, 44, 54,
    ])
  })

  it('Owner path, 20-char line: priority 3 only inside the merged last piece', () => {
    // The merged last piece `PageFlowTestDoubles.cs` (22) is too wide: its priority-3 positions
    // Page|Flow (58), Flow|Test (62), Test|Doubles (66) are added. No other piece is too wide
    // (the widest is `EncosyTower.` = 12 <= 20).
    expect(planWrapBreaks(OWNER_PATH, tenPerChar, 200)).toEqual([
      3, 15, 21, 32, 44, 54, 58, 62, 66,
    ])
  })

  it('Owner path, 11-char line: priority 3 inside each piece wider than 11, none elsewhere', () => {
    // `EncosyTower.` (12) at 3-15 and 32-44 splits at y|T (9 and 38); `EditorMode/` (11) fits and keeps
    // no priority-3 position; the last piece splits at 58, 62, 66.
    expect(planWrapBreaks(OWNER_PATH, tenPerChar, 110)).toEqual([
      3, 9, 15, 21, 32, 38, 44, 54, 58, 62, 66,
    ])
  })

  it('Owner path, 6-char line: every piece wider than 6 gets its priority-3 positions', () => {
    // EditorMode/ (11): r|M at 27. PageFlows/ (10): e|F at 48. EncosyTower. twice: 9 and 38.
    expect(planWrapBreaks(OWNER_PATH, tenPerChar, 60)).toEqual([
      3, 9, 15, 21, 27, 32, 38, 44, 48, 54, 58, 62, 66,
    ])
  })

  it('OD4 Owner path with N = 3 keeps `cs` with the previous piece; N = 0 splits it off', () => {
    expect(planWrapBreaks(OWNER_PATH, tenPerChar, 250, 3)).not.toContain(74)
    expect(planWrapBreaks(OWNER_PATH, tenPerChar, 250, 0)).toEqual([
      3, 15, 21, 32, 44, 54, 74,
    ])
    // The default argument is N = 3.
    expect(planWrapBreaks(OWNER_PATH, tenPerChar, 250)).toEqual(
      planWrapBreaks(OWNER_PATH, tenPerChar, 250, DEFAULT_MIN_LAST_PIECE),
    )
  })

  it('OD4 N = 0 with a 20-char line: the last piece is `cs` and the priority-3 tier is unchanged', () => {
    // `PageFlowTestDoubles.` (20) fits, so no priority 3 is needed with the old split.
    expect(planWrapBreaks(OWNER_PATH, tenPerChar, 200, 0)).toEqual([
      3, 15, 21, 32, 44, 54, 74,
    ])
  })

  it('OD4 the merged last piece is measured again and its lower tiers obey N', () => {
    // src/fooBarBaz, 4-char line: P1 [4]; `fooBarBaz` (9) is too wide; its P3 positions are 7 and
    // 10, and 10 leaves `Baz` (3) so N = 3 drops it. N = 0 keeps both.
    expect(planWrapBreaks('src/fooBarBaz', tenPerChar, 40, 3)).toEqual([4, 7])
    expect(planWrapBreaks('src/fooBarBaz', tenPerChar, 40, 0)).toEqual([
      4, 7, 10,
    ])
  })

  it('OD4 N = 20 keeps a word whole when every break is within 20 graphemes of the end', () => {
    expect(planWrapBreaks('src/fooBarBaz', tenPerChar, 40, 20)).toEqual([])
    // Boundaries just around the first break (tail of 9 graphemes).
    expect(planWrapBreaks('src/fooBarBaz', tenPerChar, 40, 9)).toEqual([])
    expect(planWrapBreaks('src/fooBarBaz', tenPerChar, 40, 8)).toEqual([4])
  })

  it('Rev. 3 priority 2 only inside a priority-1 piece that is still too wide', () => {
    // lib/ (0-3) URP17Compat/ (4-15) readme.md (16-24); P1 [4, 16, 23], 23 dropped for N = 3.
    // 10-char line: `URP17Compat/` (12) is too wide -> P2 at 7 and 9; `Compat/` (7) fits, so no P3.
    // `lib/` and `readme.md` get nothing.
    const word = 'lib/URP17Compat/readme.md'
    expect(planWrapBreaks(word, tenPerChar, 100)).toEqual([4, 7, 9, 16])
    // 12-char line: every P1 piece fits, so no P2 positions at all.
    expect(planWrapBreaks(word, tenPerChar, 120)).toEqual([4, 16])
  })

  it('Rev. 3 priority 3 only inside a priority-2 piece that is still too wide', () => {
    // URP(0-2) 17(3-4) CompatLayer(5-15); no P1.
    const word = 'URP17CompatLayer'
    // 6-char line: P2 at 3 and 5, then `CompatLayer` (11) is too wide -> P3 at t|L (11).
    expect(planWrapBreaks(word, tenPerChar, 60)).toEqual([3, 5, 11])
    // 12-char line: `CompatLayer` (11) fits, so P2 stops there.
    expect(planWrapBreaks(word, tenPerChar, 120)).toEqual([3, 5])
    // 16-char line: the word fits.
    expect(planWrapBreaks(word, tenPerChar, 160)).toEqual([])
  })

  it('Rev. 3 digits: v2026Release10 puts priority 2 around digit runs, N applies to the last', () => {
    // v(0) 2026(1-4) Release(5-11) 10(12-13): positions 1, 5, 12; the tail at 12 is `10` (2).
    expect(planWrapBreaks('v2026Release10', tenPerChar, 100, 0)).toEqual([
      1, 5, 12,
    ])
    expect(planWrapBreaks('v2026Release10', tenPerChar, 100, 3)).toEqual([1, 5])
  })

  it('OD5 HTMLParser: no priority 3, so the plan is empty at any width (last resort only)', () => {
    for (const limit of [10, 30, 60, 90]) {
      expect(planWrapBreaks('HTMLParser', tenPerChar, limit, 0)).toEqual([])
    }
  })

  it('a long run without any boundary gets an empty plan (last resort applies)', () => {
    expect(planWrapBreaks('a'.repeat(60), tenPerChar, 100)).toEqual([])
  })

  it('emoji and combining marks are never split', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'
    const word = `a/${family}/b`
    const plan = planWrapBreaks(word, tenPerChar, 10, 0)
    expect(plan).toEqual([2, 14])
    // Every position is a grapheme boundary (independent oracle: the platform segmenter).
    const starts = new Set<number>(
      [
        ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
          word,
        ),
      ].map((s) => s.index),
    )
    for (const p of plan) expect(starts.has(p)).toBe(true)
    expect(planWrapBreaks('a/́b', tenPerChar, 10, 0)).toEqual([])
  })

  it('decides "too wide" from the injected width function, not from a character count', () => {
    // iiiiiiiiii (0-9) Table/ (10-15) List (16-19). P1 is [16]; its tail `List` (4) is above N = 3.
    // Uniform 10 px per character: the first piece `iiiiiiiiiiTable/` is 160 px, too wide for a
    // 100 px line, so priority 3 adds i|T (10).
    expect(planWrapBreaks('iiiiiiiiiiTable/List', tenPerChar, 100)).toEqual([
      10, 16,
    ])
    // Proportional: `i` is 2 px, every other character 10 px. The same piece is 10 * 2 + 6 * 10 =
    // 80 px and fits, so only priority 1 remains (the whole word is 120 px, still too wide).
    const proportional = (piece: string): number =>
      [...piece].reduce((total, ch) => total + (ch === 'i' ? 2 : 10), 0)
    expect(planWrapBreaks('iiiiiiiiiiTable/List', proportional, 100)).toEqual([
      16,
    ])
  })
})

describe('mayBeTooWide', () => {
  it('rejects by length with the 1.5 em bound: 33 characters at 14 px fit a 700 px line', () => {
    // 1.5 * 14 = 21 px per character: 33 * 21 = 693 <= 700, 34 * 21 = 714 > 700.
    expect(mayBeTooWide(33, 700, 14)).toBe(false)
    expect(mayBeTooWide(34, 700, 14)).toBe(true)
  })

  it('a word exactly as wide as the bound is not a candidate', () => {
    expect(mayBeTooWide(50, 1050, 14)).toBe(false)
    expect(mayBeTooWide(50, 1049, 14)).toBe(true)
  })

  it('S1 probe 4: the 1.5 em bound passes a 61-character path at 14 px, the monospace bound does not', () => {
    // 61 * 21 = 1281 > 700 (loose bound passes it); with the measured advance 8.4 px (0.6 em):
    // 61 * 8.4 = 512.4 <= 700, so it is rejected before any layout read.
    expect(mayBeTooWide(61, 700, 14)).toBe(true)
    expect(mayBeTooWide(61, 700, 14, 8.4)).toBe(false)
  })

  it('S1 probe 4: the monospace bound flips exactly where length * advance crosses the line width', () => {
    // 700 / 8 = 87.5: 87 characters fit, 88 do not.
    expect(mayBeTooWide(87, 700, 14, 8)).toBe(false)
    expect(mayBeTooWide(88, 700, 14, 8)).toBe(true)
  })

  it('an empty word is never a candidate, a non-positive line makes any word one', () => {
    expect(mayBeTooWide(0, 700, 14)).toBe(false)
    expect(mayBeTooWide(0, 0, 14, 8)).toBe(false)
    expect(mayBeTooWide(1, 0, 14)).toBe(true)
  })
})
