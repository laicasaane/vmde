import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type DeltaFallbackReason,
  type DeltaSessionPort,
  type DeltaSyncDeps,
  createDeltaSync,
  type PrepareResult,
} from './delta-sync'

// Task 733 (007-A): the delta publisher against a fake model-session port. The fake scripts the
// result of `prepareDelta` and records every call; nothing here touches a DOM, Lute or Vditor.

interface Form {
  dirty: boolean
  changedAt: number
}

function setup(
  initialText = 'line0\nline1\nline2\nline3 abcdef\n',
  extra: Partial<DeltaSyncDeps> = {},
) {
  const state = {
    epoch: 1 as number | undefined,
    awaiting: false,
    dirty: false,
    text: initialText as string | undefined,
    results: [] as PrepareResult[],
    prepared: [] as number[],
    composing: false,
    now: 1000,
    rebinds: [] as string[],
    wholeMarks: 0,
    keepCalls: [] as Array<(form: Form) => boolean>,
  }
  const session: DeltaSessionPort = {
    prepareDelta: (sequence) => {
      state.prepared.push(sequence)
      return state.results.shift() ?? { kind: 'nothing' }
    },
    epoch: () => state.epoch,
    awaiting: () => state.awaiting,
    hasDirty: () => state.dirty,
    modelText: () => state.text,
    rebind: (text) => {
      state.rebinds.push(text)
      state.text = text
    },
    markPublishedWhole: () => {
      state.wholeMarks += 1
    },
    clearForms: (keep) => {
      state.keepCalls.push(keep)
    },
  }
  const posted: unknown[] = []
  const wholes: DeltaFallbackReason[] = []
  const counted: DeltaFallbackReason[] = []
  const deps: DeltaSyncDeps = {
    session,
    postMessage: (message) => posted.push(message),
    publishWhole: (reason) => wholes.push(reason),
    countFallback: (reason) => counted.push(reason),
    isComposing: () => state.composing,
    now: () => state.now,
    ...extra,
  }
  return { state, posted, wholes, counted, sync: createDeltaSync(deps) }
}

const before = 'line0\nline1\nline2\nline3 abcdef\n'
// offset 10 is in line 1 ('line1' occupies 6..11), character 4
const typed = (from: number, insert: string, to = from) => ({
  from,
  to,
  insert,
})

describe('publish: changes', () => {
  it('posts one change with positions from offsetToPosition and sequences 1, 2, 3', () => {
    const t = setup()
    t.state.results.push(
      { kind: 'changes', before, changes: [typed(10, 'X')] },
      { kind: 'changes', before, changes: [typed(0, 'a')] },
      { kind: 'changes', before, changes: [typed(1, 'b')] },
    )
    expect(t.sync.publish('idle')).toBe('delta')
    expect(t.sync.publish('idle')).toBe('delta')
    expect(t.sync.publish('flush')).toBe('delta')
    expect(t.state.prepared).toEqual([1, 2, 3])
    expect(t.posted).toHaveLength(3)
    expect(t.posted[0]).toEqual({
      command: 'edit-delta',
      epoch: 1,
      sequence: 1,
      changes: [
        {
          start: { line: 1, character: 4 },
          end: { line: 1, character: 4 },
          oldText: '',
          text: 'X',
        },
      ],
    })
    expect((t.posted[2] as { sequence: number }).sequence).toBe(3)
  })

  it('takes oldText from the text before the call and keeps \\n', () => {
    const t = setup()
    t.state.results.push({
      kind: 'changes',
      before,
      changes: [typed(12, 'LINE', 17)],
    })
    t.sync.publish('idle')
    const change = (t.posted[0] as { changes: Array<Record<string, unknown>> })
      .changes[0]
    expect(change.oldText).toBe('line2')
    expect(change.text).toBe('LINE')
    expect(change.start).toEqual({ line: 2, character: 0 })
    expect(change.end).toEqual({ line: 2, character: 5 })
  })

  it('attaches perf when given', () => {
    const t = setup()
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    const perf = { id: 'p' } as never
    t.sync.publish('idle', perf)
    expect((t.posted[0] as { perf?: unknown }).perf).toBe(perf)
  })

  it('posts nothing for an empty change list and for a nothing result', () => {
    const t = setup()
    t.state.results.push(
      { kind: 'changes', before, changes: [] },
      { kind: 'nothing' },
    )
    expect(t.sync.publish('idle')).toBe('nothing')
    expect(t.sync.publish('flush')).toBe('nothing')
    expect(t.posted).toEqual([])
    expect(t.wholes).toEqual([])
  })

  it('drops a change whose text equals its oldText and posts nothing when none is left', () => {
    const t = setup()
    t.state.results.push(
      { kind: 'changes', before, changes: [typed(0, 'li', 2)] },
      {
        kind: 'changes',
        before,
        changes: [typed(0, 'li', 2), typed(10, 'X')],
      },
    )
    expect(t.sync.publish('idle')).toBe('nothing')
    expect(t.sync.publish('idle')).toBe('delta')
    const changes = (t.posted[0] as { changes: unknown[] }).changes
    expect(changes).toHaveLength(1)
    // The sequence of the first (empty) call was not consumed.
    expect((t.posted[0] as { sequence: number }).sequence).toBe(1)
  })

  it('widens a change that cuts a surrogate pair', () => {
    const text = 'a😀b\n'
    const t = setup(text)
    // Offset 2 is between the high and the low surrogate of the emoji (offsets 1 and 2).
    t.state.results.push({
      kind: 'changes',
      before: text,
      changes: [typed(2, 'X', 3)],
    })
    t.sync.publish('idle')
    const change = (t.posted[0] as { changes: Array<Record<string, unknown>> })
      .changes[0]
    expect(change.oldText).toBe('😀')
    expect(change.start).toEqual({ line: 0, character: 1 })
    expect(change.end).toEqual({ line: 0, character: 3 })
    expect(change.text).toBe('\ud83dX')
  })

  it('falls back with too-many-changes for 257 changes', () => {
    const t = setup('x'.repeat(1000))
    const changes = Array.from({ length: 257 }, (_, i) => typed(i * 3, 'y'))
    t.state.results.push({ kind: 'changes', before: 'x'.repeat(1000), changes })
    expect(t.sync.publish('idle')).toBe('fallback')
    expect(t.posted).toEqual([])
    expect(t.wholes).toEqual(['too-many-changes'])
    expect(t.counted).toEqual(['too-many-changes'])
    expect(t.state.wholeMarks).toBe(1)
  })

  it('accepts exactly 256 changes', () => {
    const t = setup('x'.repeat(1000))
    const changes = Array.from({ length: 256 }, (_, i) => typed(i * 3, 'y'))
    t.state.results.push({ kind: 'changes', before: 'x'.repeat(1000), changes })
    expect(t.sync.publish('idle')).toBe('delta')
  })

  it('falls back with too-many-changes above 4,000,000 characters', () => {
    const t = setup('x')
    t.state.results.push({
      kind: 'changes',
      before: 'x',
      changes: [typed(0, 'y'.repeat(4_000_001))],
    })
    expect(t.sync.publish('idle')).toBe('fallback')
    expect(t.wholes).toEqual(['too-many-changes'])
  })

  it('a model fallback publishes whole-text, counts it with its reason and marks the model', () => {
    const t = setup()
    t.state.results.push({ kind: 'fallback', reason: 'unproven-unit' })
    expect(t.sync.publish('idle')).toBe('fallback')
    expect(t.posted).toEqual([])
    expect(t.wholes).toEqual(['unproven-unit'])
    expect(t.counted).toEqual(['unproven-unit'])
    expect(t.state.wholeMarks).toBe(1)
  })

  it('does not consume a sequence for a fallback', () => {
    const t = setup()
    t.state.results.push(
      { kind: 'fallback', reason: 'unproven-unit' },
      { kind: 'changes', before, changes: [typed(0, 'a')] },
    )
    t.sync.publish('idle')
    t.sync.publish('idle')
    expect((t.posted[0] as { sequence: number }).sequence).toBe(1)
  })

  it('falls back with model-off when the session has no epoch', () => {
    const t = setup()
    t.state.epoch = undefined
    expect(t.sync.publish('idle')).toBe('fallback')
    expect(t.wholes).toEqual(['model-off'])
    expect(t.state.prepared).toEqual([])
  })
})

describe('publish: awaiting an answer', () => {
  it('posts nothing for idle and overdue and does not drain', () => {
    const t = setup()
    t.state.awaiting = true
    expect(t.sync.publish('idle')).toBe('nothing')
    expect(t.sync.publish('overdue')).toBe('nothing')
    expect(t.state.prepared).toEqual([])
    expect(t.posted).toEqual([])
    expect(t.wholes).toEqual([])
  })

  it('publishes whole-text with awaiting-rebind for flush and exact', () => {
    const t = setup()
    t.state.awaiting = true
    expect(t.sync.publish('flush')).toBe('fallback')
    expect(t.sync.publish('exact')).toBe('fallback')
    expect(t.wholes).toEqual(['awaiting-rebind', 'awaiting-rebind'])
    expect(t.counted).toEqual(['awaiting-rebind', 'awaiting-rebind'])
    expect(t.state.wholeMarks).toBe(2)
    expect(t.state.prepared).toEqual([])
  })

  it('posts a delta again once the session is no longer awaiting', () => {
    const t = setup()
    t.state.awaiting = true
    t.sync.publish('idle')
    t.state.awaiting = false
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    expect(t.sync.publish('idle')).toBe('delta')
  })
})

describe('publish: composition', () => {
  it('returns nothing without draining for every cause except flush', () => {
    const t = setup()
    t.state.composing = true
    expect(t.sync.publish('idle')).toBe('nothing')
    expect(t.sync.publish('overdue')).toBe('nothing')
    expect(t.sync.publish('exact')).toBe('nothing')
    expect(t.state.prepared).toEqual([])
  })

  it('flush publishes during a composition', () => {
    const t = setup()
    t.state.composing = true
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    expect(t.sync.publish('flush')).toBe('delta')
  })
})

describe('onUpdate and epochs', () => {
  it('a new epoch resets the sequence', () => {
    const t = setup()
    t.state.results.push(
      { kind: 'changes', before, changes: [typed(0, 'a')] },
      { kind: 'changes', before, changes: [typed(0, 'b')] },
      { kind: 'changes', before, changes: [typed(0, 'c')] },
    )
    t.sync.publish('idle')
    t.sync.publish('idle')
    t.sync.onUpdate({ epoch: 2, afterSequence: 2 })
    t.state.epoch = 2
    t.sync.publish('idle')
    expect(t.state.prepared).toEqual([1, 2, 1])
    expect((t.posted[2] as { epoch: number; sequence: number }).epoch).toBe(2)
  })

  it('an epoch adopted by the session alone (rebind) also resets the sequence', () => {
    const t = setup()
    t.state.results.push(
      { kind: 'changes', before, changes: [typed(0, 'a')] },
      { kind: 'changes', before, changes: [typed(0, 'b')] },
    )
    t.sync.publish('idle')
    t.state.epoch = 5
    t.sync.publish('idle')
    expect(t.state.prepared).toEqual([1, 1])
  })

  it('an update with the same epoch keeps the sequence', () => {
    const t = setup()
    t.state.results.push(
      { kind: 'changes', before, changes: [typed(0, 'a')] },
      { kind: 'changes', before, changes: [typed(0, 'b')] },
    )
    t.sync.publish('idle')
    t.sync.onUpdate({ epoch: 1 })
    t.sync.publish('idle')
    expect(t.state.prepared).toEqual([1, 2])
  })

  it('a missing update epoch reads as 0', () => {
    const t = setup()
    t.state.epoch = 0
    t.state.results.push(
      { kind: 'changes', before, changes: [typed(0, 'a')] },
      { kind: 'changes', before, changes: [typed(0, 'b')] },
    )
    t.sync.publish('idle')
    t.sync.onUpdate({})
    t.sync.publish('idle')
    expect(t.state.prepared).toEqual([1, 2])
  })

  it('a host-originated rebind with an unanswered delta makes the next changes whole-text', () => {
    const t = setup()
    t.state.results.push(
      { kind: 'changes', before, changes: [typed(0, 'a')] },
      { kind: 'changes', before, changes: [typed(0, 'b')] },
    )
    t.sync.publish('idle')
    t.sync.onRebind({ epoch: 2, afterSequence: 0, content: 'host\n' })
    t.state.epoch = 2
    expect(t.sync.publish('idle')).toBe('fallback')
    expect(t.wholes).toEqual(['host-write'])
    // The flag is consumed by that publication.
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'c')] })
    expect(t.sync.publish('idle')).toBe('delta')
  })

  it('a host-originated rebind with a dirty unit makes the next changes whole-text', () => {
    const t = setup()
    t.state.dirty = true
    t.sync.onRebind({ epoch: 3, afterSequence: 0, content: 'host\n' })
    t.state.epoch = 3
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    expect(t.sync.publish('idle')).toBe('fallback')
  })

  it('a host-originated rebind with nothing unanswered and nothing dirty keeps deltas', () => {
    const t = setup()
    t.sync.onRebind({ epoch: 3, afterSequence: 0, content: 'host\n' })
    t.state.epoch = 3
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    expect(t.sync.publish('idle')).toBe('delta')
  })

  it('a rebind that answers a whole-text edit changes nothing here', () => {
    const t = setup()
    t.state.results.push(
      { kind: 'changes', before, changes: [typed(0, 'a')] },
      { kind: 'changes', before, changes: [typed(0, 'b')] },
    )
    t.sync.publish('idle')
    t.sync.onRebind({
      epoch: 1,
      afterSequence: 1,
      content: 'host\n',
      editSequence: 7,
    })
    expect(t.sync.publish('idle')).toBe('delta')
    expect(t.state.prepared).toEqual([1, 2])
  })
})

describe('host-originated rebind (review M1, minor 1)', () => {
  it('forces a whole-text publication even when the model sees no change, and asks for a publication', () => {
    const requestPublication = vi.fn()
    const t = setup(undefined, { requestPublication })
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    t.sync.publish('idle')
    t.sync.onRebind({ epoch: 2, afterSequence: 0, content: 'host\n' })
    t.state.epoch = 2
    expect(requestPublication).toHaveBeenCalledOnce()
    // The model was rebound to the host bytes: it sees nothing to publish.
    t.state.results.push({ kind: 'changes', before, changes: [] })
    expect(t.sync.publish('flush')).toBe('fallback')
    expect(t.wholes).toEqual(['host-write'])
    expect(t.state.prepared).toEqual([1])
  })

  it('does not force a whole-text publication when the host text equals the model text', () => {
    const t = setup('same\n')
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    t.sync.publish('idle')
    t.sync.onRebind({ epoch: 2, afterSequence: 0, content: 'same\r\n' })
    t.state.epoch = 2
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'b')] })
    expect(t.sync.publish('idle')).toBe('delta')
  })

  it('does not force a whole-text publication when an acknowledged count covers the posted deltas', () => {
    const t = setup()
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    t.sync.publish('idle')
    t.sync.onRebind({
      epoch: 1,
      afterSequence: 1,
      content: 'x\n',
      editSequence: 3,
    })
    t.sync.onRebind({ epoch: 2, afterSequence: 0, content: 'host\n' })
    t.state.epoch = 2
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'b')] })
    expect(t.sync.publish('idle')).toBe('delta')
  })

  it('an update with a new epoch drops the flag', () => {
    const t = setup()
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    t.sync.publish('idle')
    t.sync.onRebind({ epoch: 2, afterSequence: 0, content: 'host\n' })
    t.sync.onUpdate({ epoch: 3 })
    t.state.epoch = 3
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'b')] })
    expect(t.sync.publish('idle')).toBe('delta')
  })
})

describe('position hint (review minor 2)', () => {
  it('starts the line count at the hint instead of offset 0', () => {
    const t = setup()
    // Offset 12 is line 2; the hint says offset 6 is line 1.
    t.state.results.push({
      kind: 'changes',
      before,
      changes: [typed(12, 'X')],
      hint: { offset: 6, line: 1 },
    })
    t.sync.publish('idle')
    const change = (t.posted[0] as { changes: Array<Record<string, unknown>> })
      .changes[0]
    expect(change.start).toEqual({ line: 2, character: 0 })
  })
})

describe('refusal limit (mirrors Q-11)', () => {
  function refuse(t: ReturnType<typeof setup>, epoch: number) {
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    expect(t.sync.publish('idle')).toBe('delta')
    // The host did not apply it: a new epoch whose afterSequence is below the last posted one.
    t.sync.onUpdate({ epoch, afterSequence: 0 })
    t.state.epoch = epoch
  }

  it('five refusals within 10 s keep every publication whole-text for 10 s', () => {
    const t = setup()
    for (let i = 0; i < 5; i += 1) {
      refuse(t, i + 2)
      t.state.now += 1000
    }
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    expect(t.sync.publish('idle')).toBe('fallback')
    expect(t.wholes).toEqual(['refusal-limit'])
    // The model result was not consumed: nothing was drained for the latched publication.
    expect(t.state.results).toHaveLength(1)
    t.state.now += 4000
    expect(t.sync.publish('flush')).toBe('fallback')
  })

  it('resumes deltas after the latch ends', () => {
    const t = setup()
    for (let i = 0; i < 5; i += 1) {
      refuse(t, i + 2)
      t.state.now += 100
    }
    t.state.now += 10_000
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    expect(t.sync.publish('idle')).toBe('delta')
  })

  it('four refusals do not latch', () => {
    const t = setup()
    for (let i = 0; i < 4; i += 1) {
      refuse(t, i + 2)
      t.state.now += 1000
    }
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    expect(t.sync.publish('idle')).toBe('delta')
  })

  it('refusals older than 10 s do not count', () => {
    const t = setup()
    for (let i = 0; i < 5; i += 1) {
      refuse(t, i + 2)
      t.state.now += 3000
    }
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    expect(t.sync.publish('idle')).toBe('delta')
  })

  it('an update that applied every posted delta is not a refusal', () => {
    const t = setup()
    for (let i = 0; i < 6; i += 1) {
      t.state.results.push({
        kind: 'changes',
        before,
        changes: [typed(0, 'a')],
      })
      t.sync.publish('idle')
      t.sync.onUpdate({ epoch: i + 2, afterSequence: 1 })
      t.state.epoch = i + 2
    }
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    expect(t.sync.publish('idle')).toBe('delta')
  })

  it('an update without afterSequence is not a refusal', () => {
    const t = setup()
    for (let i = 0; i < 6; i += 1) {
      t.state.results.push({
        kind: 'changes',
        before,
        changes: [typed(0, 'a')],
      })
      t.sync.publish('idle')
      t.sync.onUpdate({ epoch: i + 2 })
      t.state.epoch = i + 2
    }
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    expect(t.sync.publish('idle')).toBe('delta')
  })
})

describe('baseline', () => {
  it('clears every form when the epoch matches and nothing is pending', () => {
    const t = setup()
    t.sync.onBaseline({ epoch: 1, afterSequence: 0 })
    expect(t.state.keepCalls).toHaveLength(1)
    expect(t.state.keepCalls[0]({ dirty: false, changedAt: 0 })).toBe(false)
  })

  it('keeps the forms of a dirty unit and of units changed after afterSequence', () => {
    const t = setup()
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'a')] })
    t.sync.publish('idle')
    t.state.results.push({ kind: 'changes', before, changes: [typed(0, 'b')] })
    t.sync.publish('idle')
    // The host saved after delta 1 only.
    t.sync.onBaseline({ epoch: 1, afterSequence: 1 })
    const keep = t.state.keepCalls[0]
    expect(keep({ dirty: true, changedAt: 0 })).toBe(true)
    expect(keep({ dirty: false, changedAt: 2 })).toBe(true)
    expect(keep({ dirty: false, changedAt: 1 })).toBe(false)
    expect(keep({ dirty: false, changedAt: 0 })).toBe(false)
  })

  it('a baseline during typing keeps the dirty unit and clears the others', () => {
    const t = setup()
    t.state.dirty = true
    t.sync.onBaseline({ epoch: 1, afterSequence: 0 })
    const keep = t.state.keepCalls[0]
    expect(keep({ dirty: true, changedAt: 0 })).toBe(true)
    expect(keep({ dirty: false, changedAt: 0 })).toBe(false)
  })

  it('applies the conservative rule while awaiting an answer', () => {
    const t = setup()
    t.state.awaiting = true
    t.sync.onBaseline({ epoch: 1, afterSequence: 0 })
    const keep = t.state.keepCalls[0]
    expect(keep({ dirty: true, changedAt: 0 })).toBe(true)
    expect(keep({ dirty: false, changedAt: 0 })).toBe(false)
  })

  it('ignores a baseline of another epoch', () => {
    const t = setup()
    t.sync.onBaseline({ epoch: 9, afterSequence: 0 })
    t.sync.onBaseline({ epoch: 0, afterSequence: 0 })
    expect(t.state.keepCalls).toEqual([])
  })

  it('ignores a baseline while the session has no epoch', () => {
    const t = setup()
    t.state.epoch = undefined
    t.sync.onBaseline({ epoch: 1, afterSequence: 0 })
    expect(t.state.keepCalls).toEqual([])
  })
})

describe('restore-baseline', () => {
  const content = 'line0\nline1\nline2\nline3 abcdef\n'

  it('posts nothing when the texts are equal', () => {
    const t = setup()
    t.sync.onRestoreBaseline({ epoch: 1, afterSequence: 0, content })
    expect(t.posted).toEqual([])
    expect(t.state.rebinds).toEqual([])
  })

  it('posts one delta and rebinds the model when the texts differ', () => {
    const t = setup('line0\nline1 typed\nline2\nline3 abcdef\n')
    t.sync.onRestoreBaseline({ epoch: 1, afterSequence: 0, content })
    expect(t.posted).toEqual([
      {
        command: 'edit-delta',
        epoch: 1,
        sequence: 1,
        changes: [
          {
            start: { line: 1, character: 5 },
            end: { line: 1, character: 11 },
            oldText: ' typed',
            text: '',
          },
        ],
      },
    ])
    expect(t.state.rebinds).toEqual([content])
  })

  it('runs the bookkeeping that follows a posted delta', () => {
    const afterDelta = vi.fn()
    const t = setup('abc\n', { afterDelta })
    t.sync.onRestoreBaseline({ epoch: 1, afterSequence: 0, content: 'xyz\n' })
    expect(afterDelta).toHaveBeenCalledOnce()
    const none = setup('abc\n', { afterDelta })
    none.sync.onRestoreBaseline({
      epoch: 1,
      afterSequence: 0,
      content: 'abc\n',
    })
    expect(afterDelta).toHaveBeenCalledOnce()
  })

  it('normalizes CRLF in the content before use', () => {
    const t = setup('a\nb\n')
    t.sync.onRestoreBaseline({
      epoch: 1,
      afterSequence: 0,
      content: 'a\r\nb\r\n',
    })
    expect(t.posted).toEqual([])
  })

  it('uses lastPosted + 1 as the sequence', () => {
    const t = setup('abc\n')
    t.state.results.push({
      kind: 'changes',
      before: 'abc\n',
      changes: [typed(0, 'a')],
    })
    t.sync.publish('idle')
    t.sync.onRestoreBaseline({ epoch: 1, afterSequence: 1, content: 'xyz\n' })
    expect((t.posted[1] as { sequence: number }).sequence).toBe(2)
  })

  it('is ignored when afterSequence differs from the last posted sequence', () => {
    const t = setup('abc\n')
    t.sync.onRestoreBaseline({ epoch: 1, afterSequence: 4, content: 'xyz\n' })
    expect(t.posted).toEqual([])
    expect(t.state.rebinds).toEqual([])
  })

  it('is ignored for another epoch', () => {
    const t = setup('abc\n')
    t.sync.onRestoreBaseline({ epoch: 2, afterSequence: 0, content: 'xyz\n' })
    expect(t.posted).toEqual([])
  })

  it('is ignored while a unit is dirty', () => {
    const t = setup('abc\n')
    t.state.dirty = true
    t.sync.onRestoreBaseline({ epoch: 1, afterSequence: 0, content: 'xyz\n' })
    expect(t.posted).toEqual([])
  })

  it('is ignored while an answer is awaited', () => {
    const t = setup('abc\n')
    t.state.awaiting = true
    t.sync.onRestoreBaseline({ epoch: 1, afterSequence: 0, content: 'xyz\n' })
    expect(t.posted).toEqual([])
  })

  it('is ignored while the model has no text', () => {
    const t = setup('abc\n')
    t.state.text = undefined
    t.sync.onRestoreBaseline({ epoch: 1, afterSequence: 0, content: 'xyz\n' })
    expect(t.posted).toEqual([])
  })

  it('is ignored while a refusal latch holds', () => {
    const t = setup('abc\n')
    for (let i = 0; i < 5; i += 1) {
      t.state.results.push({
        kind: 'changes',
        before: 'abc\n',
        changes: [typed(0, 'a')],
      })
      t.sync.publish('idle')
      t.sync.onUpdate({ epoch: i + 2, afterSequence: 0 })
      t.state.epoch = i + 2
    }
    t.sync.onRestoreBaseline({
      epoch: 6,
      afterSequence: 0,
      content: 'xyz\n',
    })
    expect(t.posted).toHaveLength(5)
  })
})

describe('privacy (SR-5)', () => {
  it('passes no document text to the counting hook or the whole-text reason', () => {
    const t = setup('secret text\n')
    const spy = vi.fn()
    const counted: unknown[] = []
    t.counted.push = (...items) => {
      counted.push(...items)
      spy(...items)
      return counted.length
    }
    t.state.results.push({ kind: 'fallback', reason: 'unproven-unit' })
    t.sync.publish('idle')
    expect(JSON.stringify(counted)).not.toContain('secret')
  })
})

beforeEach(() => {
  vi.clearAllMocks()
})
