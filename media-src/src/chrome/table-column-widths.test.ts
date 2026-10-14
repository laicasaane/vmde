import { describe, expect, it } from 'vitest'
import { allocateColumnWidths } from './table-column-widths'

const sum = (values: number[]): number =>
  values.reduce((total, value) => total + value, 0)

// Expected values are worked out by hand from the allocation contract:
//  1. iterative equal share: columns whose max fits the share take max, the share is recomputed;
//  2. sum(max) <= W: every column gets max plus slack in proportion to max;
//  3. long columns split the remainder in proportion to max, pinned at min (water-filling);
//  4. sum(min) > W: scale in proportion to min so the table fits W;
//  5. integer px by largest remainder (ties go to the lower column index), sum = floor(W).
describe('allocateColumnWidths', () => {
  it('mixed table: short columns keep max, two long columns split the remainder', () => {
    // Content-derived widths measured for a table with ID/status/date plus two prose columns.
    // Share 800/5 = 160: first three take max (66.05 + 81.88 + 108.38 = 256.31).
    // Remainder 543.69 split 977.88 : 917.78 = 280.46 and 263.23.
    // Floors 66, 81, 108, 280, 263 = 798; the two largest fractions (.88, .46) get the extra px.
    const widths = allocateColumnWidths({
      min: [53.72, 81.88, 67.69, 117.56, 117.03],
      max: [66.05, 81.88, 108.38, 977.88, 917.78],
      available: 800,
      minimum: 48,
    })
    expect(widths).toEqual([66, 82, 108, 281, 263])
  })

  it('all short: every column gets max plus slack in proportion to max', () => {
    // sum(max) = 423.36 < 800; width = max * 800 / 423.36 = 187.04, 213.57, 199.89, 199.51.
    // Floors sum to 798; largest fractions are .89 (index 2) and .57 (index 1).
    const widths = allocateColumnWidths({
      min: [72.08, 76.94, 82.69, 69.5],
      max: [98.98, 113.02, 105.78, 105.58],
      available: 800,
      minimum: 48,
    })
    expect(widths).toEqual([187, 214, 200, 199])
    expect(Math.max(...widths) / Math.min(...widths)).toBeLessThanOrEqual(1.15)
  })

  it('all long: remainder splits in proportion to max', () => {
    // Share 200: no max fits. 600 * 500/2000 = 150, 150, and 600 * 1000/2000 = 300.
    expect(
      allocateColumnWidths({
        min: [60, 60, 60],
        max: [500, 500, 1000],
        available: 600,
        minimum: 48,
      }),
    ).toEqual([150, 150, 300])
  })

  it('all long: a column below its min is pinned and the rest re-split', () => {
    // Proportional share of column 1 is 600 * 300/2300 = 78 < min 150, so it is pinned at 150.
    // The remaining 450 split 1000 : 1000 = 225 each.
    expect(
      allocateColumnWidths({
        min: [60, 150, 60],
        max: [1000, 300, 1000],
        available: 600,
        minimum: 48,
      }),
    ).toEqual([225, 150, 225])
  })

  it('sum(min) above available: scales in proportion to min with no overflow', () => {
    // min = max, sum 1552.75 > 800; width = min * 800 / 1552.75.
    // Floors sum to 796; the four largest fractions belong to indexes 6, 7, 1 and 5.
    const widths = allocateColumnWidths({
      min: [165.53, 189.55, 225.34, 210.11, 200.86, 179.72, 194.03, 187.61],
      max: [165.53, 189.55, 225.34, 210.11, 200.86, 179.72, 194.03, 187.61],
      available: 800,
      minimum: 48,
    })
    expect(widths).toEqual([85, 98, 116, 108, 103, 93, 100, 97])
    expect(sum(widths)).toBe(800)
  })

  it('single column fills the available width', () => {
    expect(
      allocateColumnWidths({
        min: [60],
        max: [900],
        available: 500,
        minimum: 48,
      }),
    ).toEqual([500])
    expect(
      allocateColumnWidths({
        min: [60],
        max: [200],
        available: 500,
        minimum: 48,
      }),
    ).toEqual([500])
    expect(
      allocateColumnWidths({
        min: [300],
        max: [300],
        available: 200,
        minimum: 48,
      }),
    ).toEqual([200])
  })

  it('applies the 48 px floor to min and max', () => {
    // Both columns are raised to 48; sum(max) = 96 = W, so each keeps 48.
    expect(
      allocateColumnWidths({
        min: [10, 20],
        max: [10, 20],
        available: 96,
        minimum: 48,
      }),
    ).toEqual([48, 48])
    // The short column is raised to 48; share 100 > 48, so it takes 48 and the long pair split 252.
    expect(
      allocateColumnWidths({
        min: [10, 10, 10],
        max: [20, 1000, 1000],
        available: 300,
        minimum: 48,
      }),
    ).toEqual([48, 126, 126])
  })

  it('rounds with largest remainder so the sum equals floor(available)', () => {
    // 200 / 3 = 66.67 each; floors 66 x3 = 198; the tie goes to the lower indexes.
    const widths = allocateColumnWidths({
      min: [50, 50, 50],
      max: [100, 100, 100],
      available: 200.9,
      minimum: 48,
    })
    expect(widths).toEqual([67, 67, 66])
    expect(sum(widths)).toBe(200)
  })

  it('iterative share: slack of one short column lets a second column avoid wrapping', () => {
    // Share 300/3 = 100: only the first column (max 40, raised to 48) fits, leaving 252.
    // Recomputed share 126: the second column (max 120) now fits too, leaving 132 for the third.
    // A single pass would have squeezed the second column to 100, below its max of 120.
    expect(
      allocateColumnWidths({
        min: [48, 60, 60],
        max: [40, 120, 500],
        available: 300,
        minimum: 48,
      }),
    ).toEqual([48, 120, 132])
  })
})
