import { describe, expect, it } from 'vitest'
import { planGithubInlineMath } from './math-insertion'

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
