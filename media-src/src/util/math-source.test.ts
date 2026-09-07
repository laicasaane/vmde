import { describe, expect, it } from 'vitest'
import { normalizeGithubInlineMathSource } from './math-source'

describe('normalizeGithubInlineMathSource', () => {
  it('removes one outer GitHub backtick pair from inline math render input', () => {
    expect(normalizeGithubInlineMathSource('`x^2`', true)).toBe('x^2')
  })

  it('preserves the source when the node is not inline math', () => {
    expect(normalizeGithubInlineMathSource('`x^2`', false)).toBe('`x^2`')
  })

  it('removes only one outer pair without rewriting the expression interior', () => {
    expect(normalizeGithubInlineMathSource('```a_b```', true)).toBe('``a_b``')
    expect(normalizeGithubInlineMathSource('`\\frac{a}{b} \\$`', true)).toBe(
      '\\frac{a}{b} \\$',
    )
  })

  it('leaves unmatched backticks unchanged', () => {
    expect(normalizeGithubInlineMathSource('`x', true)).toBe('`x')
    expect(normalizeGithubInlineMathSource('x`', true)).toBe('x`')
  })
})
