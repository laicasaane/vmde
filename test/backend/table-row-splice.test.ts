import { describe, expect, it } from 'vitest'
import {
  cellRoundTrip,
  cellsEqual,
  originalRowCellSpans,
  spliceChangedRow,
  splitRow,
} from '../../src/shared/table-row-splice'

// Stand-in for the Lute table round trip: trims each cell and pads the delimiter, which is all
// the cell helpers rely on.
const reserialize = (block: string): string | undefined => {
  const [row] = block.split('\n')
  return `| ${splitRow(row).join(' | ')} |\n| - |`
}

describe('splitRow', () => {
  it('splits and trims cells, ignoring a pipe inside a code span', () => {
    expect(splitRow('| a |  b | `x|y` |')).toEqual(['a', 'b', '`x|y`'])
  })
})

describe('originalRowCellSpans', () => {
  it('returns the content span of each cell', () => {
    const raw = '|  a | bb |'
    const spans = originalRowCellSpans(raw, ['a', 'bb'])
    expect(spans?.map((s) => raw.slice(s.contentStart, s.contentEnd))).toEqual([
      'a',
      'bb',
    ])
  })

  it('returns null when the cells do not line up', () => {
    expect(originalRowCellSpans('| a | b |', ['a'])).toBeNull()
    expect(originalRowCellSpans('   ', [])).toBeNull()
  })
})

describe('spliceChangedRow', () => {
  it('replaces only the changed cell and keeps the other bytes', () => {
    expect(
      spliceChangedRow('|  a   |  b  |', ['a', 'b'], ['a', 'z'], [false, true]),
    ).toBe('|  a   |  z  |')
  })

  it('returns null when the raw row has no provable spans', () => {
    expect(spliceChangedRow('| a | b |', ['a'], ['z'], [true])).toBeNull()
  })
})

describe('cellRoundTrip', () => {
  it('returns the reserialized cell and undefined when the reserializer declines', () => {
    expect(cellRoundTrip('  x ', reserialize)).toBe('x')
    expect(cellRoundTrip('x', () => undefined)).toBeUndefined()
  })
})

describe('cellsEqual', () => {
  it('is true for identical cells and for cells that reserialize alike', () => {
    expect(cellsEqual('a', 'a', () => undefined)).toBe(true)
    expect(cellsEqual(' a', 'a ', reserialize)).toBe(true)
  })

  it('is false for different cells and when the reserializer declines', () => {
    expect(cellsEqual('a', 'b', reserialize)).toBe(false)
    expect(cellsEqual('a', 'b', () => undefined)).toBe(false)
  })
})
