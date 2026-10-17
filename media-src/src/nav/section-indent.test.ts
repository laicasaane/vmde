import { describe, expect, it } from 'vitest'
import {
  type IndentBlock,
  blockDepths,
  updateBlockDepths,
} from './section-indent'

const h = (headingLevel: number): IndentBlock => ({ headingLevel })
const p: IndentBlock = {}
const tail: IndentBlock = { tail: true }

describe('blockDepths (task 649 depth rule)', () => {
  it('maps levels 1-6 to depth level - 1 and content to its heading depth', () => {
    const blocks = [h(1), p, h(2), p, h(3), p, h(4), p, h(5), p, h(6), p]
    expect(blockDepths(blocks)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5])
  })

  it('keeps the absolute rule when levels are skipped', () => {
    expect(blockDepths([h(1), p, h(3), p])).toEqual([0, 0, 2, 2])
  })

  it('starts a document whose top heading is ## at one step', () => {
    expect(blockDepths([h(2), p, h(2), p, h(3)])).toEqual([1, 1, 1, 1, 2])
  })

  it('returns to a shallower depth at a later higher-level heading', () => {
    expect(blockDepths([h(1), h(3), p, h(2), p])).toEqual([0, 2, 2, 1, 1])
  })

  it('gives blocks before the first heading and front matter depth 0', () => {
    expect(blockDepths([p, p, h(3), p])).toEqual([0, 0, 2, 2])
    expect(blockDepths([{ kind: 'front-matter' }, p, h(2)])).toEqual([0, 0, 1])
  })

  it('starts no section for container headings the caller marks as non-headings', () => {
    // S3 must classify headings inside list, quote, callout, Details and HTML blocks as
    // non-headings (no headingLevel): they take the depth of the preceding top-level heading.
    expect(blockDepths([h(2), { kind: 'list' }, { kind: 'quote' }, p])).toEqual(
      [1, 1, 1, 1],
    )
  })

  it('gives trailing footnote and link-reference blocks depth 0', () => {
    expect(blockDepths([h(1), h(2), p, tail, tail])).toEqual([0, 1, 1, 0, 0])
  })

  it('caps the depth at 5', () => {
    expect(blockDepths([h(6)])).toEqual([5])
    expect(blockDepths([h(9), p])).toEqual([5, 5])
  })

  it('handles an empty list', () => {
    expect(blockDepths([])).toEqual([])
  })
})

describe('updateBlockDepths (local pass equals a full pass)', () => {
  const before: IndentBlock[] = [p, h(1), p, h(2), p, p, h(2), p, h(1), p, tail]

  function check(
    after: IndentBlock[],
    prior: number[],
    start: number,
    end: number,
  ) {
    const result = updateBlockDepths(after, prior, start, end)
    expect(result.depths).toEqual(blockDepths(after))
    return result
  }

  it('matches after inserting a heading', () => {
    const after = [...before.slice(0, 5), h(3), ...before.slice(5)]
    const prior = blockDepths(before)
    const stale = [...prior.slice(0, 5), 0, ...prior.slice(5)]
    const r = check(after, stale, 5, 6)
    // Recomputation stops at the next top-level heading (index 7).
    expect(r.to).toBe(7)
  })

  it('matches after removing a heading', () => {
    const after = [...before.slice(0, 3), ...before.slice(4)]
    const prior = blockDepths(before)
    const stale = [...prior.slice(0, 3), ...prior.slice(4)]
    const r = check(after, stale, 3, 3)
    expect(r.to).toBe(5)
  })

  it('matches after changing a heading level', () => {
    const after = before.slice()
    after[3] = h(4)
    const r = check(after, blockDepths(before), 3, 4)
    expect(r.from).toBe(3)
    expect(r.to).toBe(6)
  })

  it('matches after turning a paragraph into a heading and back', () => {
    const asHeading = before.slice()
    asHeading[9] = h(2)
    check(asHeading, blockDepths(before), 9, 10)
    const back = before.slice()
    check(back, blockDepths(asHeading), 9, 10)
  })

  it('does not change blocks outside the recomputed range', () => {
    const after = before.slice()
    after[3] = h(4)
    const stale = blockDepths(before)
    stale[0] = 99
    stale[8] = 77
    const r = updateBlockDepths(after, stale, 3, 4)
    expect(r.depths[0]).toBe(99)
    expect(r.depths[8]).toBe(77)
  })

  it('keeps tail blocks at depth 0 and the running depth across them', () => {
    const after = [h(2), tail, p]
    check(after, [1, 0, 0], 1, 2)
  })

  it('recomputes to the end when no heading follows', () => {
    const after = [h(1), p, p]
    const r = check(after, [0, 9, 9], 1, 2)
    expect(r.to).toBe(3)
  })
})
