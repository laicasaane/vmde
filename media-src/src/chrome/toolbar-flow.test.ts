import { describe, expect, it } from 'vitest'
import {
  type FlowControl,
  type FlowInput,
  planToolbarFlow,
} from './toolbar-flow'

const TAIL = ['preview', 'edit-mode', 'more']

// Compact fixture builder: "a:1" is control a in group 1; width defaults to 10.
function ctl(spec: string, width = 10): FlowControl {
  const [name, group] = spec.split(':')
  return { name, group: Number(group), width }
}

function input(
  specs: string[],
  rowWidths: number[],
  opts: { sep?: number; width?: number; tail?: string[] } = {},
): FlowInput {
  return {
    controls: specs.map((s) => ctl(s, opts.width ?? 10)),
    separatorWidth: opts.sep ?? 5,
    rowWidths,
    tail: opts.tail ?? [],
  }
}

// Wiki-on sequence from the task handoff: [name, group]; '|' marks a group boundary.
const SEQUENCE_ON =
  'undo redo | headings | bold italic underline strike inline-code | subscript superscript | link | list ordered-list check | outdent indent | quote callout details code math table line | upload emoji | insert-before insert-after | outline | navigate-back wiki-pages | edit-in-vscode preview edit-mode more'

function realistic(wiki: boolean): FlowInput {
  const controls: FlowControl[] = []
  let group = 0
  for (const token of SEQUENCE_ON.split(' ')) {
    if (token === '|') {
      group++
      continue
    }
    if (!wiki && (token === 'navigate-back' || token === 'wiki-pages')) continue
    controls.push({ name: token, group, width: 25 })
  }
  return { controls, separatorWidth: 17, rowWidths: [0, 0], tail: TAIL }
}

function flat(rows: string[][]): string[] {
  return rows.flat()
}

describe('planToolbarFlow', () => {
  // Acceptance: whole sequence fits one row -> one row, no separator surprises.
  it('places everything in one row when the whole sequence fits', () => {
    const plan = planToolbarFlow(
      input(
        ['a:1', 'b:1', 'c:2', 'preview:3', 'edit-mode:3', 'more:3'],
        [500, 500],
        { tail: TAIL },
      ),
    )
    expect(plan.rows).toEqual([
      ['a', 'b', '|', 'c', '|', 'preview', 'edit-mode', 'more'],
    ])
    expect(plan.more).toEqual([])
  })

  // Acceptance (A2): longest first-row prefix; row 2 starts with the next control.
  it('fills row 1 with the longest prefix and starts row 2 with the next control', () => {
    // 10 px controls, 5 px rule. Row 1 holds a b | c d = 10+10+5+10+10 = 45 (<=48); e does not fit.
    const plan = planToolbarFlow(
      input(
        [
          'a:1',
          'b:1',
          'c:2',
          'd:2',
          'e:2',
          'f:2',
          'preview:3',
          'edit-mode:3',
          'more:3',
        ],
        [48, 100],
        {
          tail: TAIL,
        },
      ),
    )
    expect(plan.rows).toEqual([
      ['a', 'b', '|', 'c', 'd'],
      ['e', 'f', '|', 'preview', 'edit-mode', 'more'],
    ])
    expect(plan.more).toEqual([])
  })

  // Acceptance (A3): collapsed one-row prefix plus tail, the rest in More in sequence order.
  it('collapsed: prefix plus tail, remaining body in More in sequence order', () => {
    // Tail 30 + rule 5 + prefix a b (20) = 55 <= 60; c does not fit.
    const plan = planToolbarFlow(
      input(
        [
          'a:1',
          'b:1',
          'c:1',
          'd:2',
          'e:2',
          'preview:3',
          'edit-mode:3',
          'more:3',
        ],
        [60],
        { tail: TAIL },
      ),
    )
    expect(plan.rows).toEqual([['a', 'b', '|', 'preview', 'edit-mode', 'more']])
    expect(plan.more).toEqual(['c', 'd', 'e'])
  })

  it('keeps the tail in the last row as one unit and never in More', () => {
    const plan = planToolbarFlow(
      input(
        ['a:1', 'b:1', 'c:1', 'd:1', 'preview:3', 'edit-mode:3', 'more:3'],
        [25, 70],
        { tail: TAIL },
      ),
    )
    expect(plan.rows).toEqual([
      ['a', 'b'],
      ['c', 'd', '|', 'preview', 'edit-mode', 'more'],
    ])
    expect(flat(plan.rows).slice(-3)).toEqual(TAIL)
    expect(plan.more).toEqual([])
  })

  // Rule 5: tail alone too wide -> still placed, all remaining body in More.
  it('places the tail even when it alone is too wide and moves the body to More', () => {
    const plan = planToolbarFlow(
      input(['a:1', 'b:1', 'preview:3', 'edit-mode:3', 'more:3'], [10], {
        tail: TAIL,
      }),
    )
    expect(plan.rows).toEqual([['preview', 'edit-mode', 'more']])
    expect(plan.more).toEqual(['a', 'b'])
  })

  // Rule 4: no empty first row.
  it('never leaves the first row empty', () => {
    const plan = planToolbarFlow(
      input(['a:1', 'b:1', 'preview:3', 'edit-mode:3', 'more:3'], [5, 5], {
        tail: TAIL,
      }),
    )
    expect(plan.rows).toEqual([['preview', 'edit-mode', 'more']])
    expect(plan.more).toEqual(['a', 'b'])
    expect(plan.rows.every((row) => row.length > 0)).toBe(true)
  })

  // Rule 2/3 (settled point 3): a rule never starts or ends a row and never touches More.
  it('never puts a separator at a row edge', () => {
    // Row 1 could end at b (group 1) but the next control c is group 2: no trailing rule.
    const plan = planToolbarFlow(
      input(
        ['a:1', 'b:1', 'c:2', 'd:2', 'preview:3', 'edit-mode:3', 'more:3'],
        [20, 100],
        { tail: TAIL },
      ),
    )
    for (const row of plan.rows) {
      expect(row[0]).not.toBe('|')
      expect(row[row.length - 1]).not.toBe('|')
    }
    expect(plan.rows[1][0]).toBe('c')
    expect(plan.more.includes('|')).toBe(false)
  })

  it('puts a rule before the tail only when the control before it is in another group', () => {
    const differ = planToolbarFlow(
      input(['a:1', 'b:2', 'preview:3', 'edit-mode:3', 'more:3'], [500], {
        tail: TAIL,
      }),
    )
    expect(differ.rows[0]).toEqual([
      'a',
      '|',
      'b',
      '|',
      'preview',
      'edit-mode',
      'more',
    ])
    const same = planToolbarFlow(
      input(['a:1', 'b:3', 'preview:3', 'edit-mode:3', 'more:3'], [500], {
        tail: TAIL,
      }),
    )
    expect(same.rows[0]).toEqual([
      'a',
      '|',
      'b',
      'preview',
      'edit-mode',
      'more',
    ])
  })

  it('does not reserve a rule before the tail when the tail is first in its row', () => {
    const plan = planToolbarFlow(
      input(['a:1', 'preview:3', 'edit-mode:3', 'more:3'], [30], {
        tail: TAIL,
      }),
    )
    expect(plan.rows).toEqual([['preview', 'edit-mode', 'more']])
    expect(plan.more).toEqual(['a'])
  })

  // A hidden control (absent from the input) must not leave a stray rule.
  it('leaves no stray separator when a control between two groups is absent', () => {
    // Group 2 is entirely hidden: a (g1) and c (g1) are adjacent and same group.
    const plan = planToolbarFlow(
      input(
        ['a:1', 'c:1', 'd:3', 'preview:4', 'edit-mode:4', 'more:4'],
        [500],
        { tail: TAIL },
      ),
    )
    expect(plan.rows[0]).toEqual([
      'a',
      'c',
      '|',
      'd',
      '|',
      'preview',
      'edit-mode',
      'more',
    ])
    expect(plan.rows[0].join('').includes('||')).toBe(false)
  })

  // Rule 6: exact boundary: sum <= floor(rowWidth), ceiled widths, deterministic.
  it('is deterministic at the exact boundary width', () => {
    const base = ['a:1', 'b:1', 'c:2', 'preview:3', 'edit-mode:3', 'more:3']
    // Total = 6 * 10 + 2 rules * 5 = 70.
    const fits = planToolbarFlow(input(base, [70], { tail: TAIL }))
    const fitsAgain = planToolbarFlow(input(base, [70], { tail: TAIL }))
    expect(fits).toEqual(fitsAgain)
    expect(fits.more).toEqual([])
    const tight = planToolbarFlow(input(base, [69], { tail: TAIL }))
    expect(tight.more.length).toBeGreaterThan(0)
  })

  it('floors the row width and ceils control widths', () => {
    const controls: FlowControl[] = [
      { name: 'a', group: 1, width: 9.2 },
      { name: 'preview', group: 1, width: 9.2 },
      { name: 'edit-mode', group: 1, width: 9.2 },
      { name: 'more', group: 1, width: 9.2 },
    ]
    // Ceiled: 4 * 10 = 40. Row 39.9 floors to 39: does not fit; 40.9 floors to 40: fits.
    const narrow = planToolbarFlow({
      controls,
      separatorWidth: 5,
      rowWidths: [39.9],
      tail: TAIL,
    })
    expect(narrow.more).toEqual(['a'])
    const exact = planToolbarFlow({
      controls,
      separatorWidth: 5,
      rowWidths: [40.9],
      tail: TAIL,
    })
    expect(exact.more).toEqual([])
  })

  it('places every control exactly once and keeps sequence order', () => {
    const plan = planToolbarFlow(
      input(
        [
          'a:1',
          'b:1',
          'c:2',
          'd:2',
          'e:3',
          'f:3',
          'preview:4',
          'edit-mode:4',
          'more:4',
        ],
        [35, 45],
        { tail: TAIL },
      ),
    )
    const names = [
      ...flat(plan.rows).filter((t) => t !== '|'),
      ...plan.more,
    ].sort()
    expect(names).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'edit-mode',
      'f',
      'more',
      'preview',
    ])
  })

  // Realistic sequences from the task handoff: 34 controls / 12 separators (wiki), 32 / 11 (no wiki).
  describe.each([
    ['wiki on', true, 34, 12],
    ['wiki off', false, 32, 11],
  ])('realistic sequence, %s', (_label, wiki, controlCount, separatorCount) => {
    it('has the documented control and separator counts', () => {
      const { controls } = realistic(wiki)
      let separators = 0
      for (let i = 1; i < controls.length; i++) {
        if (controls[i].group !== controls[i - 1].group) separators++
      }
      expect(controls.length).toBe(controlCount)
      expect(separators).toBe(separatorCount)
    })

    it('fits one row at exactly the full width and spills one control below it', () => {
      const base = realistic(wiki)
      const full = controlCount * 25 + separatorCount * 17
      const one = planToolbarFlow({ ...base, rowWidths: [full] })
      expect(one.rows.length).toBe(1)
      expect(one.more).toEqual([])
      expect(one.rows[0].filter((t) => t === '|').length).toBe(separatorCount)
      const spill = planToolbarFlow({ ...base, rowWidths: [full - 1] })
      expect(spill.more.length).toBeGreaterThan(0)
      expect(spill.rows[0].slice(-3)).toEqual(TAIL)
    })

    it('expanded two rows at 600 px: row 2 continues the sequence and ends with the tail', () => {
      const plan = planToolbarFlow({
        ...realistic(wiki),
        rowWidths: [600, 600],
      })
      expect(plan.rows.length).toBe(2)
      expect(plan.rows[1].slice(-3)).toEqual(TAIL)
      const body = flat(plan.rows).filter((t) => t !== '|')
      expect(body.length + plan.more.length).toBe(controlCount)
      // Row 1 is the leading sequence: it starts with undo and has no edge rule.
      expect(plan.rows[0][0]).toBe('undo')
      expect(plan.rows[0][plan.rows[0].length - 1]).not.toBe('|')
      expect(plan.rows[1][0]).not.toBe('|')
    })

    it('collapsed narrow row keeps undo first and the tail last', () => {
      const plan = planToolbarFlow({ ...realistic(wiki), rowWidths: [300] })
      expect(plan.rows.length).toBe(1)
      expect(plan.rows[0][0]).toBe('undo')
      expect(plan.rows[0].slice(-3)).toEqual(TAIL)
      expect(plan.more.length).toBeGreaterThan(0)
    })

    it('is deterministic for the same input', () => {
      const a = planToolbarFlow({ ...realistic(wiki), rowWidths: [533, 533] })
      const b = planToolbarFlow({ ...realistic(wiki), rowWidths: [533, 533] })
      expect(a).toEqual(b)
    })
  })
})
