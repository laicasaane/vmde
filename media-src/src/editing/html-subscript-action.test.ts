import { describe, expect, it } from 'vitest'
import { planHtmlSubscript } from './html-subscript-action'

function apply(
  source: string,
  splices: Array<{ start: number; end: number; text: string }>,
) {
  return [...splices]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (out, s) => out.slice(0, s.start) + s.text + out.slice(s.end),
      source,
    )
}

describe('HTML SUB action planner', () => {
  it('wraps an untouched range and preserves backward endpoint order', () => {
    const source = 'H**2**O'
    const result = planHtmlSubscript(source, 6, 1)
    expect(result.state).toBe('inactive')
    expect(apply(source, result.splices!)).toBe('H<sub>**2**</sub>O')
    expect(result.selection).toEqual({ anchor: 11, focus: 6 })
  })
  it('inserts an empty pair at a caret', () => {
    const result = planHtmlSubscript('HO', 1, 1)
    expect(apply('HO', result.splices!)).toBe('H<sub></sub>O')
    expect(result.selection).toEqual({ anchor: 6, focus: 6 })
  })
  it('removes exact attributed wrapper or body only', () => {
    const source = 'H<SUB title="x">**2** &amp;</SUB>O'
    const body = source.indexOf('**')
    for (const [start, end] of [
      [body, body + '**2** &amp;'.length],
      [1, source.length - 1],
    ]) {
      const result = planHtmlSubscript(source, start, end)
      expect(result.state).toBe('active')
      expect(apply(source, result.splices!)).toBe('H**2** &amp;O')
    }
  })
  it('accepts authored whitespace around tags and attributes without normalizing them', () => {
    const source = 'H<sub title = "x" >2</sub>O'
    const body = source.indexOf('2')
    const result = planHtmlSubscript(source, body, body + 1)
    expect(result.state).toBe('active')
    expect(apply(source, result.splices!)).toBe('H2O')
  })
  it('fails closed for partial, crossed, code, and escaped tag shapes', () => {
    for (const [source, start, end] of [
      ['H<sub>2</sub>O', 7, 8],
      ['<sub><em>x</sub></em>', 0, 20],
      ['`<sub>2</sub>`', 1, 2],
      ['\\<sub>2</sub>', 0, 1],
      ['<sub!>2</sub>', 0, '<sub!>2</sub>'.length],
      ['<sub x=>2</sub>', 0, '<sub x=>2</sub>'.length],
    ] as const) {
      expect(planHtmlSubscript(source, start, end).state).toBe('disabled')
    }
  })
  it('reports mixed for a boundary-crossing authored wrapper and disables caret in tag/code/math', () => {
    expect(planHtmlSubscript('H<sub>2</sub>O', 0, 7).state).toBe('mixed')
    for (const source of ['H<sub>2</sub>O', '`code`', '$math$']) {
      const at = source.indexOf('<') >= 0 ? source.indexOf('<') + 1 : 1
      expect(planHtmlSubscript(source, at, at).state).toBe('disabled')
    }
  })
  it('uses scanner spans for quoted attributes, protected runs, escapes, and partial bodies', () => {
    expect(
      planHtmlSubscript('H<sub title="a > b">x</sub>O', 17, 17).state,
    ).toBe('disabled')
    expect(planHtmlSubscript('``<sub>2</sub>``', 7, 8).state).toBe('disabled')
    expect(planHtmlSubscript('<sub>abc</sub>', 5, 6)).toEqual({
      state: 'active',
    })
    expect(planHtmlSubscript('<sub>abc</sub>', 7, 8)).toEqual({
      state: 'active',
    })
    expect(planHtmlSubscript('\\\\<sub>2</sub>', 7, 8).state).toBe('active')
    expect(planHtmlSubscript('\\$<sub>2</sub>', 7, 8).state).toBe('active')
  })

  it('rejects non-integer UTF-16 offsets', () => {
    expect(planHtmlSubscript('abc', 1.5, 2).state).toBe('disabled')
    expect(planHtmlSubscript('abc', Number.NaN, 2).state).toBe('disabled')
  })
})
