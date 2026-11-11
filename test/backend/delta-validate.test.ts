import { describe, expect, it } from 'vitest'
import {
  type DeltaDocument,
  type DeltaRefusal,
  validateDelta,
} from '../../src/writeback/delta-validate'

// Task 733 — host-side validation of an `edit-delta` message (SR-1, SR-6). The validator is pure: it
// reads the document only through `lineText` for the lines the ranges name.

const LINES = ['alpha', 'be😀ta', '', 'gamma', 'delta']

function docOf(lines: string[] = LINES): DeltaDocument & { read: number[] } {
  const read: number[] = []
  return {
    read,
    lineCount: lines.length,
    lineText(line: number) {
      read.push(line)
      return lines[line] ?? ''
    },
  }
}

const pos = (line: number, character: number) => ({ line, character })
const change = (
  sl: number,
  sc: number,
  el: number,
  ec: number,
  oldText: string,
  text: string,
) => ({ start: pos(sl, sc), end: pos(el, ec), oldText, text })

const base = { epoch: 0, sequence: 1 }
const run = (changes: unknown[], over: Record<string, unknown> = {}) =>
  validateDelta({ ...base, ...over, changes } as never, docOf())
const refusal = (changes: unknown[], over: Record<string, unknown> = {}) => {
  const r = run(changes, over)
  return r.ok ? 'ok' : r.refusal
}
const one = change(0, 0, 0, 1, 'a', 'A')

describe('validateDelta refusals (validation row 3)', () => {
  it('sequence 1.5 -> not-integer', () => {
    expect(refusal([one], { sequence: 1.5 })).toBe('not-integer')
  })
  it('0 changes -> empty', () => {
    expect(refusal([])).toBe('empty')
  })
  it('257 changes -> too-many-changes', () => {
    expect(refusal(Array.from({ length: 257 }, () => one))).toBe(
      'too-many-changes',
    )
  })
  it('lengths summing to 4,000,001 -> too-long', () => {
    const half = 'x'.repeat(2_000_000)
    expect(refusal([change(0, 0, 0, 1, half, `${half}y`)])).toBe('too-long')
    expect(refusal([change(0, 0, 0, 1, half, half)])).not.toBe('too-long')
  })
  it('character past the line end -> range', () => {
    expect(refusal([change(0, 0, 0, 6, 'alpha!', 'x')])).toBe('range')
  })
  it('second change starting before the first ends -> order', () => {
    expect(
      refusal([change(0, 0, 0, 3, 'alp', 'x'), change(0, 2, 0, 4, 'ph', 'y')]),
    ).toBe('order')
  })
  it('256 insertions at distinct positions are ok', () => {
    const lines = Array.from({ length: 256 }, () => 'x')
    const r = validateDelta(
      {
        ...base,
        changes: lines.map((_, i) => change(i, 0, i, 0, '', String(i))),
      } as never,
      docOf(lines),
    )
    expect(r.ok).toBe(true)
  })
  it('two empty ranges at the same position -> order (SR-1)', () => {
    expect(
      refusal([change(0, 2, 0, 2, '', 'x'), change(0, 2, 0, 2, '', 'y')]),
    ).toBe('order')
    expect(
      refusal([change(0, 2, 0, 2, '', 'x'), change(0, 3, 0, 3, '', 'y')]),
    ).toBe('ok')
  })
  it('an edge between the two code units of an emoji -> surrogate-edge', () => {
    // 'be😀ta': the emoji occupies code units 2 and 3
    expect(refusal([change(1, 3, 1, 4, '\ude00', 'x')])).toBe('surrogate-edge')
  })
  it('oldText === text -> noop-change', () => {
    expect(refusal([change(0, 0, 0, 1, 'a', 'a')])).toBe('noop-change')
  })
  it('text holding \\r -> change-shape', () => {
    expect(refusal([change(0, 0, 0, 1, 'a', 'x\r')])).toBe('change-shape')
  })
})

describe('validateDelta success and reads', () => {
  it('returns the 3 validated changes of a valid delta', () => {
    const result = run([
      change(0, 0, 0, 1, 'a', 'A'),
      change(0, 5, 1, 2, '\nbe', 'X\nY'),
      change(3, 5, 4, 0, '\n', ''),
    ])
    expect(result).toEqual({
      ok: true,
      changes: [
        change(0, 0, 0, 1, 'a', 'A'),
        change(0, 5, 1, 2, '\nbe', 'X\nY'),
        change(3, 5, 4, 0, '\n', ''),
      ],
    })
  })

  it('does not copy foreign fields into the validated changes', () => {
    const result = run([{ ...one, uri: 'file:///other.md' }], {
      uri: 'file:///other.md',
    })
    expect(result.ok && Object.keys(result.changes[0]).sort()).toEqual([
      'end',
      'oldText',
      'start',
      'text',
    ])
  })

  it('reads only the lines the ranges name', () => {
    const doc = docOf()
    const result = validateDelta(
      {
        ...base,
        changes: [change(0, 0, 0, 1, 'a', 'A'), change(3, 0, 3, 1, 'g', 'G')],
      },
      doc,
    )
    expect(result.ok).toBe(true)
    expect([...new Set(doc.read)].sort()).toEqual([0, 3])
  })

  it('reads no line when a check before the range check fails', () => {
    const doc = docOf()
    validateDelta({ ...base, changes: [change(0, 0, 0, 1, 'a', 'a\r')] }, doc)
    expect(doc.read).toEqual([])
  })
})

type Case = [string, unknown[], Record<string, unknown>, DeltaRefusal | 'ok']
const none = {}
const CASES: Case[] = [
  ['epoch string', [one], { epoch: '0' }, 'not-integer'],
  ['epoch negative', [one], { epoch: -1 }, 'not-integer'],
  ['epoch NaN', [one], { epoch: Number.NaN }, 'not-integer'],
  ['epoch unsafe', [one], { epoch: 2 ** 53 }, 'not-integer'],
  ['epoch undefined', [one], { epoch: undefined }, 'not-integer'],
  ['sequence 0', [one], { sequence: 0 }, 'not-integer'],
  ['sequence negative', [one], { sequence: -2 }, 'not-integer'],
  [
    'sequence Infinity',
    [one],
    { sequence: Number.POSITIVE_INFINITY },
    'not-integer',
  ],
  ['sequence null', [one], { sequence: null }, 'not-integer'],
  ['epoch large safe', [one], { epoch: 2 ** 53 - 1 }, 'ok'],
  ['change null', [null], none, 'change-shape'],
  ['change string', ['x'], none, 'change-shape'],
  ['start missing', [{ ...one, start: undefined }], none, 'change-shape'],
  ['end missing', [{ ...one, end: undefined }], none, 'change-shape'],
  ['line fractional', [{ ...one, start: pos(0.5, 0) }], none, 'change-shape'],
  [
    'character string',
    [{ ...one, end: { line: 0, character: '1' } }],
    none,
    'change-shape',
  ],
  ['oldText number', [{ ...one, oldText: 1 }], none, 'change-shape'],
  ['oldText holds \\r', [change(0, 0, 0, 1, 'a\r', 'A')], none, 'change-shape'],
  ['second change malformed', [one, null], none, 'change-shape'],
  ['line past count', [change(5, 0, 5, 0, '', 'x')], none, 'range'],
  ['end line past count', [change(4, 0, 5, 0, 'delta\n', 'x')], none, 'range'],
  ['line negative', [change(-1, 0, 0, 0, '', 'x')], none, 'range'],
  ['character negative', [change(0, -1, 0, 0, '', 'x')], none, 'range'],
  ['start after end same line', [change(0, 3, 0, 1, 'lp', 'x')], none, 'range'],
  ['start line after end line', [change(2, 0, 1, 0, '', 'x')], none, 'range'],
  ['end at line end ok', [change(0, 5, 0, 5, '', '!')], none, 'ok'],
  ['empty line insert ok', [change(2, 0, 2, 0, '', 'x')], none, 'ok'],
  ['empty line char 1', [change(2, 1, 2, 1, '', 'x')], none, 'range'],
  [
    'touching changes ok',
    [change(0, 0, 0, 2, 'al', 'A'), change(0, 2, 0, 3, 'p', 'P')],
    none,
    'ok',
  ],
  [
    'overlap on later line',
    [change(0, 0, 1, 1, 'alpha\nb', 'x'), change(1, 0, 1, 2, 'be', 'y')],
    none,
    'order',
  ],
  [
    'descending lines',
    [change(3, 0, 3, 1, 'g', 'G'), change(0, 0, 0, 1, 'a', 'A')],
    none,
    'order',
  ],
  ['same range twice', [one, one], none, 'order'],
  [
    'edge inside emoji (start)',
    [change(1, 3, 1, 5, '\ude00t', 'x')],
    none,
    'surrogate-edge',
  ],
  [
    'edge inside emoji (end)',
    [change(1, 0, 1, 3, 'be\ud83d', 'x')],
    none,
    'surrogate-edge',
  ],
  ['edge before emoji ok', [change(1, 0, 1, 2, 'be', 'x')], none, 'ok'],
  ['edge after emoji ok', [change(1, 4, 1, 6, 'ta', 'x')], none, 'ok'],
  ['range over whole emoji ok', [change(1, 2, 1, 4, '😀', 'x')], none, 'ok'],
  ['insert text with emoji ok', [change(0, 0, 0, 0, '', '😀')], none, 'ok'],
  ['empty old and new', [change(0, 0, 0, 0, '', '')], none, 'noop-change'],
]

describe('validateDelta table', () => {
  it('holds 39 cases', () => {
    expect(CASES).toHaveLength(39)
  })
  it.each(CASES)('%s', (_name, changes, over, expected) => {
    expect(refusal(changes, over)).toBe(expected)
  })
})
