import { describe, expect, it } from 'vitest'
import {
  digitCount,
  estimateRowCount,
  groupRows,
  gutterColumns,
  maxSubNumber,
  planLabels,
  currentRowBand,
} from './sv-gutter-plan'

// Task 645: the pure planner behind the Split View source gutter. The column rule is the task
// record's contract: line numbers and sub-numbers are right-aligned, the `↳` mark sits at the left
// edge, and the gutter is the larger of digits(highest line) and 2 + digits(widest sub-number).
describe('digitCount', () => {
  it('counts the decimal digits of a positive integer, 1 for zero', () => {
    expect(digitCount(0)).toBe(1)
    expect(digitCount(1)).toBe(1)
    expect(digitCount(9)).toBe(1)
    expect(digitCount(10)).toBe(2)
    expect(digitCount(99)).toBe(2)
    expect(digitCount(100)).toBe(3)
    expect(digitCount(12345)).toBe(5)
  })
})

describe('gutterColumns', () => {
  it('uses the digits of the highest line number when no line wraps', () => {
    expect(gutterColumns(5, 0)).toBe(1)
    expect(gutterColumns(42, 0)).toBe(2)
    expect(gutterColumns(12345, 0)).toBe(5)
  })

  it('reproduces the three task examples for line numbers below 100', () => {
    expect(gutterColumns(43, 2)).toBe(3)
    expect(gutterColumns(43, 9)).toBe(3)
    expect(gutterColumns(43, 10)).toBe(4)
    expect(gutterColumns(43, 99)).toBe(4)
    expect(gutterColumns(43, 100)).toBe(5)
  })

  it('takes the larger of the two counts', () => {
    expect(gutterColumns(1000, 1)).toBe(4)
    expect(gutterColumns(1000, 100)).toBe(5)
    expect(gutterColumns(100000, 100)).toBe(6)
  })
})

describe('groupRows', () => {
  it('merges the rects of one visual row into a single row box', () => {
    expect(
      groupRows([
        { top: 37, bottom: 53 },
        { top: 37, bottom: 53 },
        { top: 37.4, bottom: 55 },
      ]),
    ).toEqual([{ top: 37, bottom: 55 }])
  })

  it('returns the rows sorted by top whatever the input order', () => {
    expect(
      groupRows([
        { top: 81, bottom: 97 },
        { top: 37, bottom: 53 },
        { top: 59, bottom: 75 },
        { top: 59, bottom: 75 },
      ]),
    ).toEqual([
      { top: 37, bottom: 53 },
      { top: 59, bottom: 75 },
      { top: 81, bottom: 97 },
    ])
  })

  it('splits rows whose tops differ by more than the tolerance and ignores empty rects', () => {
    expect(
      groupRows([
        { top: 37, bottom: 53 },
        { top: 38, bottom: 53 },
        { top: 38.5, bottom: 54 },
        { top: 60, bottom: 60 },
      ]),
    ).toEqual([
      { top: 37, bottom: 53 },
      { top: 38.5, bottom: 54 },
    ])
    expect(groupRows([])).toEqual([])
  })
})

describe('estimateRowCount', () => {
  it('divides the height of a line by the row pitch, at least 1', () => {
    expect(estimateRowCount(22, 22)).toBe(1)
    expect(estimateRowCount(66, 22)).toBe(3)
    expect(estimateRowCount(50, 22)).toBe(2)
    expect(estimateRowCount(0, 22)).toBe(1)
  })

  it('answers 1 for an unusable pitch or height', () => {
    expect(estimateRowCount(44, 0)).toBe(1)
    expect(estimateRowCount(44, -5)).toBe(1)
    expect(estimateRowCount(Number.NaN, 22)).toBe(1)
    expect(estimateRowCount(44, Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('maxSubNumber', () => {
  it('is the largest row count minus one, 0 when nothing wraps', () => {
    expect(maxSubNumber([])).toBe(0)
    expect(maxSubNumber([1, 1, 1])).toBe(0)
    expect(maxSubNumber([1, 4, 2])).toBe(3)
  })
})

describe('planLabels', () => {
  it('puts the line number on the first row and numbers each further row from 1', () => {
    const rows = [
      { top: 100, bottom: 116 },
      { top: 122, bottom: 138 },
      { top: 144, bottom: 160 },
    ]
    expect(planLabels([{ line: 42, rows }])).toEqual([
      { kind: 'line', text: '42', top: 100, height: 16 },
      { kind: 'sub', text: '1', top: 122, height: 16 },
      { kind: 'sub', text: '2', top: 144, height: 16 },
    ])
  })

  it('keeps the line order and skips a line without rows', () => {
    expect(
      planLabels([
        { line: 1, rows: [{ top: 10, bottom: 26 }] },
        { line: 2, rows: [] },
        { line: 3, rows: [{ top: 32, bottom: 48 }] },
      ]),
    ).toEqual([
      { kind: 'line', text: '1', top: 10, height: 16 },
      { kind: 'line', text: '3', top: 32, height: 16 },
    ])
  })
})

// The current-row highlight is a band painted inside the pane's scrolling content: its top is in
// content coordinates (the pane's scrollTop is added back) and its height is one row's line height.
describe('currentRowBand', () => {
  it('centres a line-height band on the caret rect, in content coordinates', () => {
    expect(currentRowBand({ top: 100, bottom: 116 }, 22, 50, 0)).toEqual({
      top: 47,
      height: 22,
    })
  })

  it('adds the scroll offset back and follows the row of a taller line height', () => {
    expect(currentRowBand({ top: 100, bottom: 116 }, 22, 50, 300)).toEqual({
      top: 347,
      height: 22,
    })
    expect(currentRowBand({ top: 200, bottom: 232 }, 44, 50, 0)).toEqual({
      top: 144,
      height: 44,
    })
  })

  it('answers null for an unusable rect or line height', () => {
    expect(currentRowBand({ top: Number.NaN, bottom: 10 }, 22, 0, 0)).toBeNull()
    expect(currentRowBand({ top: 10, bottom: 26 }, 0, 0, 0)).toBeNull()
    expect(currentRowBand({ top: 10, bottom: 26 }, Number.NaN, 0, 0)).toBeNull()
    expect(
      currentRowBand({ top: 10, bottom: 26 }, 22, 0, Number.NaN),
    ).toBeNull()
  })
})
