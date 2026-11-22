import { describe, expect, it } from 'vitest'
import {
  createReplayTarget,
  DELTA_TEXT_LIMIT,
  exceedsDeltaLimit,
  groupsOfHunks,
  type LogicalChange,
  type ReplayTarget,
  supersede,
} from './replay-target'

// Task 733 / 036 (fix design 2.3, step B): the three coordinate spaces of the replay. These tests drive
// the pure state the way the session does: `R` is a plain string the test writes, and every rendered
// group and user change is applied to it by hand.

/** Applies one `R` change to the string (what the DOM sync does to the model text). */
const write = (text: string, from: number, to: number, insert: string) =>
  text.slice(0, from) + insert + text.slice(to)

/** Renders one group into `rendered` and returns the new `R`. */
function render(state: ReplayTarget, rendered: string, group: number): string {
  const r = { from: 0, to: 0 }
  const t = { from: 0, to: 0 }
  expect(state.checkOld(rendered, group)).toBe(true)
  state.rangeR(group, r)
  state.rangeT(group, t)
  const insert = state.target.slice(t.from, t.to)
  const next = write(rendered, r.from, r.to, insert)
  state.markRendered(group)
  return next
}

/** The host side of sequential operations: each applied against the text after the one before. */
const applyOps = (start: string, ops: readonly LogicalChange[]) => {
  let text = start
  for (const op of ops) {
    expect(text.slice(op.lFrom, op.lTo)).toBe(op.oldText)
    text = write(text, op.lFrom, op.lTo, op.insert)
  }
  return text
}

// The worked example of 2.3: R = "aXXbQQd", T = L = "aYbZd".
const example = () => {
  const rendered = 'aXXbQQd'
  const target = 'aYbZd'
  const state = createReplayTarget(
    target,
    rendered.length,
    [
      { tFrom: 1, tTo: 2, rFrom: 1, rTo: 3 },
      { tFrom: 3, tTo: 4, rFrom: 4, rTo: 6 },
    ],
    rendered,
  )
  if (!state) throw new Error('state')
  return { state, rendered, target }
}

describe('036 B replay target', () => {
  it('maps R to L outside groups and refuses an offset inside a pending group', () => {
    const { state, rendered } = example()
    expect(state.rToL(0)).toBe(0)
    expect(state.rToL(1)).toBe(1)
    expect(state.rToL(2)).toBe('inside-group')
    expect(state.rToL(3)).toBe(2)
    expect(state.rToL(4)).toBe(3)
    expect(state.rToL(6)).toBe(4)
    expect(state.rToL(7)).toBe(5)
    expect(state.logicalSlice(rendered, 0, 5)).toBe('aYbZd')
    expect(state.lToR(3)).toBe(4)
  })

  it('a spanning Delete shifts a later group by two different amounts and it renders Z', () => {
    const { state, rendered } = example()
    const op = state.applyChange(rendered, { rFrom: 0, rTo: 4, insert: '' })
    expect(op).toEqual({ lFrom: 0, lTo: 3, oldText: 'aYb', insert: '' })
    let r = write(rendered, 0, 4, '')
    expect(r).toBe('QQd')
    expect(state.isPending(0)).toBe(false)
    const rr = { from: 0, to: 0 }
    const ll = { from: 0, to: 0 }
    const tt = { from: 0, to: 0 }
    state.rangeR(1, rr)
    state.rangeL(1, ll)
    state.rangeT(1, tt)
    expect([rr.from, rr.to, ll.from, ll.to, tt.from, tt.to]).toEqual([
      0, 2, 0, 1, 3, 4,
    ])
    expect(state.logicalSlice(r, 0, state.logicalLength())).toBe('Zd')
    r = render(state, r, 1)
    expect(r).toBe('Zd')
    expect(state.pending()).toBe(0)
    expect(state.logicalSlice(r, 0, state.logicalLength())).toBe(r)
  })

  it('an insertion before a group (aXXb / aYb / !) shifts the group in both spaces', () => {
    const rendered = 'aXXb'
    const state = createReplayTarget(
      'aYb',
      rendered.length,
      [{ tFrom: 1, tTo: 2, rFrom: 1, rTo: 3 }],
      rendered,
    )
    if (!state) throw new Error('state')
    const op = state.applyChange(rendered, { rFrom: 0, rTo: 0, insert: '!' })
    expect(op).toEqual({ lFrom: 0, lTo: 0, oldText: '', insert: '!' })
    let r = write(rendered, 0, 0, '!')
    r = render(state, r, 0)
    expect(r).toBe('!aYb')
    expect(applyOps('aYb', [op as LogicalChange])).toBe(r)
  })

  it('sequential operations: ! at L 0 then ? at L 5 apply in order to the bytes of L', () => {
    const { state, rendered, target } = example()
    const ops: LogicalChange[] = []
    let r = rendered
    const first = state.applyChange(r, { rFrom: 0, rTo: 0, insert: '!' })
    ops.push(first as LogicalChange)
    r = write(r, 0, 0, '!')
    // L is now "!aYbZd"; offset 5 is between Z and d, which is R offset 7.
    const at = state.lToR(5)
    expect(at).toBe(7)
    const second = state.applyChange(r, {
      rFrom: at as number,
      rTo: at as number,
      insert: '?',
    })
    ops.push(second as LogicalChange)
    r = write(r, 7, 7, '?')
    expect(second).toMatchObject({ lFrom: 5, lTo: 5 })
    const logical = state.logicalSlice(r, 0, state.logicalLength())
    expect(logical).toBe('!aYbZ?d')
    expect(applyOps(target, ops)).toBe(logical)
    // Read against T instead of L_1, `?` would land one character early.
    expect(write(target, 5, 5, '?')).not.toBe(logical)
    r = render(state, r, 0)
    r = render(state, r, 1)
    expect(r).toBe(logical)
  })

  it('an edit inside an earlier user insertion stays in the gap', () => {
    const { state, rendered, target } = example()
    let r = write(rendered, 0, 0, 'hello')
    const ops = [
      state.applyChange(rendered, { rFrom: 0, rTo: 0, insert: 'hello' }),
    ] as LogicalChange[]
    ops.push(state.applyChange(r, { rFrom: 2, rTo: 4, insert: 'Y' }) as never)
    r = write(r, 2, 4, 'Y')
    expect(ops[1]).toEqual({ lFrom: 2, lTo: 4, oldText: 'll', insert: 'Y' })
    const logical = state.logicalSlice(r, 0, state.logicalLength())
    expect(logical).toBe('heYoaYbZd')
    expect(applyOps(target, ops)).toBe(logical)
  })

  it('a zero-width group (an Undo that re-inserts text) refuses a caret at it until it renders', () => {
    const rendered = 'ab'
    const state = createReplayTarget(
      'aXb',
      rendered.length,
      [{ tFrom: 1, tTo: 2, rFrom: 1, rTo: 1 }],
      rendered,
    )
    if (!state) throw new Error('state')
    expect(state.rToL(1)).toBe('zero-width')
    expect(state.applyChange(rendered, { rFrom: 1, rTo: 1, insert: '!' })).toBe(
      'zero-width',
    )
    const r = render(state, rendered, 0)
    expect(r).toBe('aXb')
    expect(state.rToL(2)).toBe(2)
  })

  it('a selection that contains a pending group is published with the target bytes as oldText', () => {
    // 2.3 captured intent: pasting exactly the displayed R bytes over g1 still changes L.
    const { state, rendered } = example()
    const op = state.applyChange(rendered, {
      rFrom: 0,
      rTo: 4,
      insert: 'aXXb',
    })
    expect(op).toEqual({ lFrom: 0, lTo: 3, oldText: 'aYb', insert: 'aXXb' })
    let r = write(rendered, 0, 4, 'aXXb')
    expect(r).toBe(rendered)
    expect(state.logicalSlice(r, 0, state.logicalLength())).toBe('aXXbZd')
    r = render(state, r, 1)
    expect(r).toBe('aXXbZd')
  })

  it('supersession is checked against L, not the model text, while half the groups are pending', () => {
    const { state, rendered, target } = example()
    const r = render(state, rendered, 0)
    expect(r).toBe('aYbQQd')
    expect(r).not.toBe(target)
    expect(state.logicalEquals(r, target)).toBe(true)
    expect(state.logicalEquals(r, 'aYbQQd')).toBe(false)
  })

  it('Undo then Redo with half rendered leaves exactly the rendered half pending', () => {
    // Record: before "aYbZd", after "aXXbQQd"; hunks old [1,2) [3,4) -> new [1,3) [4,6).
    const before = 'aYbZd'
    const after = 'aXXbQQd'
    const hunks = {
      oldStarts: Int32Array.of(1, 3),
      oldEnds: Int32Array.of(2, 4),
      newStarts: Int32Array.of(1, 4),
      newEnds: Int32Array.of(3, 6),
    }
    const undo = createReplayTarget(
      before,
      after.length,
      groupsOfHunks(hunks, 'before'),
      after,
    )
    if (!undo) throw new Error('state')
    const r = render(undo, after, 0)
    expect(undo.logicalEquals(r, before)).toBe(true)
    // The Redo's hunks run from L (= before) to after.
    const redo = supersede(undo, r, after, hunks)
    if (!redo) throw new Error('redo')
    expect(redo.pending()).toBe(1)
    const range = { from: 0, to: 0 }
    let pendingGroup = -1
    for (let i = 0; i < redo.count; i++) if (redo.isPending(i)) pendingGroup = i
    redo.rangeR(pendingGroup, range)
    expect(r.slice(range.from, range.to)).toBe('Y')
    const done = render(redo, r, pendingGroup)
    expect(done).toBe(after)
  })

  it('a group renders in order from the caret outward', () => {
    const rendered = 'aXbXcXdXe'
    const groups = [1, 3, 5, 7].map((at) => ({
      tFrom: at,
      tTo: at + 1,
      rFrom: at,
      rTo: at + 1,
    }))
    const state = createReplayTarget(
      'aYbYcYdYe',
      rendered.length,
      groups,
      rendered,
    )
    if (!state) throw new Error('state')
    expect(Array.from(state.order(5))).toEqual([2, 1, 3, 0])
    expect(Array.from(state.order(0))).toEqual([0, 1, 2, 3])
  })

  it('refuses groups whose outside text does not line up', () => {
    expect(
      createReplayTarget(
        'aYb',
        4,
        [{ tFrom: 1, tTo: 2, rFrom: 2, rTo: 3 }],
        'aXXb',
      ),
    ).toBeUndefined()
  })

  it('checkOld fails when R no longer holds the expected old bytes', () => {
    const { state, rendered } = example()
    expect(state.checkOld(write(rendered, 1, 3, 'XY'), 0)).toBe(false)
  })

  it('switches to a whole post above the 4,000,000-character delta limit', () => {
    const small: LogicalChange = { lFrom: 0, lTo: 0, oldText: '', insert: 'x' }
    expect(exceedsDeltaLimit([small])).toBe(false)
    const big: LogicalChange = {
      lFrom: 0,
      lTo: 0,
      oldText: 'a'.repeat(DELTA_TEXT_LIMIT / 2),
      insert: 'b'.repeat(DELTA_TEXT_LIMIT / 2 + 1),
    }
    expect(exceedsDeltaLimit([big])).toBe(true)
  })
})
