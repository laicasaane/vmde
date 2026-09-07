import { describe, expect, it } from 'vitest'
import { planGithubFencedMath, planGithubInlineMath } from './math-insertion'

describe('planGithubInlineMath', () => {
  it('wraps selected bytes without changing surrounding source', () => {
    expect(planGithubInlineMath('before x^2 after', 7, 10)).toEqual({
      markdown: 'before $`x^2`$ after',
      anchor: 9,
      focus: 12,
    })
  })

  it('creates an exact empty pair with its caret between the backticks', () => {
    expect(planGithubInlineMath('before after', 7, 7)).toEqual({
      markdown: 'before $``$after',
      anchor: 9,
      focus: 9,
    })
  })

  it('rejects multiline, code, and existing math selections', () => {
    expect(planGithubInlineMath('a\nb', 0, 3)).toBeNull()
    expect(planGithubInlineMath('`code`', 1, 5)).toBeNull()
    expect(planGithubInlineMath('$x$', 1, 2)).toBeNull()
  })

  it('retains escaped TeX dollars while rejecting unescaped delimiter dollars', () => {
    expect(planGithubInlineMath('before \\$', 7, 9)).toEqual({
      markdown: 'before $`\\$`$',
      anchor: 9,
      focus: 11,
    })
    expect(planGithubInlineMath('before $x$', 7, 9)).toBeNull()
  })
})

describe('planGithubFencedMath', () => {
  it('wraps selected expression lines in a math fence without changing surrounding lines', () => {
    expect(planGithubFencedMath('before\nx^2\nafter\n', 7, 10)).toEqual({
      markdown: 'before\n```math\nx^2\n```\nafter\n',
      caret: 15,
    })
  })

  it('uses a fence longer than any backtick run in the selected body', () => {
    expect(planGithubFencedMath('a\n````\nb\n', 2, 6)).toEqual({
      markdown: 'a\n`````math\n````\n`````\nb\n',
      caret: 12,
    })
  })

  it('keeps a quoted list item structurally inside its container', () => {
    expect(planGithubFencedMath('> - x^2\n', 4, 7)).toEqual({
      markdown: '> - ```math\n>   x^2\n>   ```\n',
      caret: 16,
    })
  })

  it('inserts an empty fenced body at a collapsed caret with the source line ending', () => {
    expect(planGithubFencedMath('before\r\nafter', 6, 6)).toEqual({
      markdown: 'before\r\n```math\r\n\r\n```\r\nafter',
      caret: 17,
    })
  })

  it('rejects invalid offsets and selection spanning incompatible containers', () => {
    expect(planGithubFencedMath('x', -1, 0)).toBeNull()
    expect(planGithubFencedMath('> alpha\nplain\n', 2, 12)).toBeNull()
  })
})
