import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EndOfLine, workspace } from 'vscode'
import { DeltaWriter } from '../../src/writeback/delta-writer'
import { SyncState } from '../../src/writeback/sync-state'
import { mock } from './vscode-mock'

// Task 733 — the host-side delta writer: guards, one WorkspaceEdit through the apply chain, the
// predicted text as pending content (echo), the epoch and the refusal latch.

const pos = (line: number, character: number) => ({ line, character })
const change = (
  sl: number,
  sc: number,
  el: number,
  ec: number,
  oldText: string,
  text: string,
) => ({ start: pos(sl, sc), end: pos(el, ec), oldText, text })

function setup(text = 'a\nb\nc', crlf = false, beforeTurn?: () => void) {
  const document = mock.createTextDocument('/w/d.md', text)
  if (crlf) document.eol = EndOfLine.CRLF
  const syncState = new SyncState(text)
  const log = vi.fn()
  const clock = { t: 1000 }
  const chainOrder: string[] = []
  const writer = new DeltaWriter({
    document: document as never,
    syncState,
    runOnApplyChain: async (fn) => {
      chainOrder.push('chain')
      beforeTurn?.()
      return fn()
    },
    applyEdit: (edit) => workspace.applyEdit(edit as never),
    now: () => clock.t,
    log,
  })
  const msg = (changes: unknown[], over: Record<string, unknown> = {}) => ({
    epoch: 0,
    sequence: 1,
    changes,
    ...over,
  })
  return { document, syncState, log, clock, writer, msg, chainOrder }
}

beforeEach(() => {
  mock.reset()
  vi.mocked(workspace.applyEdit).mockClear()
  mock.setRangedApplyEdit(true)
})

describe('DeltaWriter.apply', () => {
  it('stale epoch -> dropped, document unchanged, no applyEdit', async () => {
    const { writer, document, msg } = setup()
    const out = await writer.apply(
      msg([change(0, 0, 0, 1, 'a', 'X')], { epoch: 1 }),
    )
    expect(out).toEqual({ kind: 'dropped', why: 'epoch' })
    expect(document.getText()).toBe('a\nb\nc')
    expect(workspace.applyEdit).not.toHaveBeenCalled()
  })

  it('sequence gap -> resync sequence', async () => {
    const { writer, msg } = setup()
    expect(
      await writer.apply(msg([change(0, 0, 0, 1, 'a', 'X')], { sequence: 2 })),
    ).toEqual({ kind: 'resync', why: 'sequence' })
  })

  it('a validator refusal is the resync reason', async () => {
    const { writer, msg } = setup()
    expect(await writer.apply(msg([]))).toEqual({
      kind: 'resync',
      why: 'empty',
    })
  })

  it('oldText mismatch -> resync old-text, document unchanged', async () => {
    const { writer, document, msg } = setup()
    expect(await writer.apply(msg([change(0, 0, 0, 1, 'z', 'X')]))).toEqual({
      kind: 'resync',
      why: 'old-text',
    })
    expect(document.getText()).toBe('a\nb\nc')
  })

  it('applyEdit false -> resync apply-failed, pending cleared, sequence kept', async () => {
    const { writer, document, syncState, msg } = setup()
    mock.queueApplyEditResult(false)
    expect(await writer.apply(msg([change(0, 0, 0, 1, 'a', 'X')]))).toEqual({
      kind: 'resync',
      why: 'apply-failed',
    })
    expect(syncState.getPendingWebviewContent()).toBeUndefined()
    expect(writer.acceptedSequence).toBe(0)
    expect(syncState.isApplyingEdit()).toBe(false)
    expect(document.getText()).toBe('a\nb\nc')
  })

  it('applies, keeps the pending content equal to the document text', async () => {
    const { writer, document, syncState, msg } = setup()
    expect(await writer.apply(msg([change(1, 0, 1, 1, 'b', 'B\nB')]))).toEqual({
      kind: 'applied',
    })
    expect(document.getText()).toBe('a\nB\nB\nc')
    expect(syncState.getPendingWebviewContent()).toBe(document.getText())
    expect(syncState.isEcho(document.getText())).toBe(true)
    expect(syncState.isApplyingEdit()).toBe(false)
    expect(writer.acceptedSequence).toBe(1)
  })

  it('the change event of the write is an echo; a different text is not', async () => {
    const { writer, document, syncState, msg } = setup()
    const seen: boolean[] = []
    const sub = workspace.onDidChangeTextDocument(() => {
      seen.push(syncState.isEcho(document.getText()))
    })
    await writer.apply(msg([change(0, 0, 0, 1, 'a', 'X')]))
    sub.dispose()
    expect(seen).toEqual([true])
    expect(syncState.isEcho(`${document.getText()}!`)).toBe(false)
  })

  it('CRLF document with \\n texts -> applied, document stays CRLF, echo', async () => {
    const { writer, document, syncState, msg } = setup('a\r\nb\r\nc', true)
    expect(
      await writer.apply(
        msg([change(0, 1, 1, 0, '\n', ' '), change(2, 0, 2, 1, 'c', 'x\ny')]),
      ),
    ).toEqual({ kind: 'applied' })
    expect(document.getText()).toBe('a b\r\nx\r\ny')
    expect(syncState.isEcho(document.getText())).toBe(true)
  })

  it('a change on the last line without a final newline -> applied', async () => {
    const { writer, document, msg } = setup('a\nlast')
    expect(
      await writer.apply(msg([change(1, 0, 1, 4, 'last', 'end')])),
    ).toEqual({
      kind: 'applied',
    })
    expect(document.getText()).toBe('a\nend')
  })

  it('two deltas in order -> acceptedSequence 2', async () => {
    const { writer, msg } = setup()
    await writer.apply(msg([change(0, 0, 0, 1, 'a', 'X')]))
    await writer.apply(msg([change(0, 0, 0, 1, 'X', 'Y')], { sequence: 2 }))
    expect(writer.acceptedSequence).toBe(2)
  })

  it('one WorkspaceEdit with every range goes through the apply chain', async () => {
    const { writer, msg, chainOrder } = setup()
    await writer.apply(
      msg([change(0, 0, 0, 1, 'a', 'A'), change(2, 0, 2, 1, 'c', 'C')]),
    )
    expect(chainOrder).toEqual(['chain'])
    expect(workspace.applyEdit).toHaveBeenCalledTimes(1)
    const edit = (workspace.applyEdit as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(edit.replacements).toHaveLength(2)
  })

  it('a foreign change in flight -> applied, acceptedSequence not advanced, not an echo', async () => {
    const { writer, document, syncState, msg } = setup()
    // The foreign change lands during the write: it starts a new epoch and the text differs.
    const sub = workspace.onDidChangeTextDocument(() => {
      document.__setText(`${document.getText()}?`)
      writer.startEpoch()
    })
    expect(await writer.apply(msg([change(0, 0, 0, 1, 'a', 'X')]))).toEqual({
      kind: 'applied',
    })
    sub.dispose()
    expect(writer.acceptedSequence).toBe(0)
    expect(syncState.isEcho(document.getText())).toBe(false)
  })
})

describe('refusal limit', () => {
  it('the 6th refusal within 10 s -> dropped refusal-limit, also across startEpoch(), for 10 s (Q-11)', async () => {
    const { writer, clock, msg } = setup()
    const bad = () =>
      msg([change(0, 0, 0, 1, 'z', 'X')], { epoch: writer.epoch })
    for (let i = 0; i < 5; i++) {
      clock.t += 1000
      expect(await writer.apply(bad())).toEqual({
        kind: 'resync',
        why: 'old-text',
      })
      writer.startEpoch() // the session resynchronizes after every refusal
    }
    const good = () =>
      msg([change(0, 0, 0, 1, 'a', 'X')], { epoch: writer.epoch })
    expect(await writer.apply(good())).toEqual({
      kind: 'dropped',
      why: 'refusal-limit',
    })
    writer.startEpoch()
    expect(await writer.apply(good())).toEqual({
      kind: 'dropped',
      why: 'refusal-limit',
    })
    // 10 s after the latch was set (at the 5th refusal) deltas are accepted again.
    clock.t += 9_999
    expect(await writer.apply(good())).toEqual({
      kind: 'dropped',
      why: 'refusal-limit',
    })
    clock.t += 2
    expect(await writer.apply(good())).toEqual({ kind: 'applied' })
  })

  it('drops for a stale epoch do not count toward the limit', async () => {
    const { writer, clock, msg } = setup()
    for (let i = 0; i < 20; i++) {
      clock.t += 100
      expect(
        await writer.apply(msg([change(0, 0, 0, 1, 'a', 'X')], { epoch: 99 })),
      ).toEqual({ kind: 'dropped', why: 'epoch' })
    }
    expect(await writer.apply(msg([change(0, 0, 0, 1, 'a', 'X')]))).toEqual({
      kind: 'applied',
    })
  })

  it('refusals older than 10 s do not count', async () => {
    const { writer, clock, msg } = setup()
    const bad = () => msg([change(0, 0, 0, 1, 'z', 'X')])
    for (let i = 0; i < 8; i++) {
      clock.t += 3000
      expect(await writer.apply(bad())).toEqual({
        kind: 'resync',
        why: 'old-text',
      })
    }
  })

  it('startEpoch increments the sync-state epoch and resets the sequence', async () => {
    const { writer, syncState, msg } = setup()
    await writer.apply(msg([change(0, 0, 0, 1, 'a', 'X')]))
    expect(writer.startEpoch()).toBe(1)
    expect(syncState.getEpoch()).toBe(1)
    expect(writer.epoch).toBe(1)
    expect(writer.acceptedSequence).toBe(0)
  })
})

describe('logging (SR-5)', () => {
  it('logs the outcome fields and never a text', async () => {
    const { writer, log, msg } = setup('SECRET-1\nb')
    await writer.apply(msg([change(0, 0, 0, 8, 'SECRET-1', 'SECRET-2')]))
    await writer.apply(
      msg([change(0, 0, 0, 1, 'SECRET-2', 'x')], { sequence: 5 }),
    )
    await writer.apply(
      msg([change(0, 0, 0, 1, 'SECRET-1', 'x')], { epoch: 'SECRET-3' }),
    )
    await writer.apply(
      msg([{ ...change(0, 0, 0, 1, 'a', 'b'), oldText: 'SECRET-2\r' }]),
    )
    const dump = JSON.stringify(log.mock.calls)
    for (const secret of ['SECRET-1', 'SECRET-2', 'SECRET-3']) {
      expect(dump).not.toContain(secret)
    }
    expect(log).toHaveBeenCalledTimes(4)
    const allowed = new Set([
      'outcome',
      'why',
      'hostEpoch',
      'epoch',
      'sequence',
      'acceptedSequence',
      'changeCount',
      'oldLength',
      'textLength',
    ])
    for (const [name, details] of log.mock.calls) {
      expect(name).toBe('edit-delta')
      for (const key of Object.keys(details))
        expect(allowed.has(key)).toBe(true)
    }
    const [, applied] = log.mock.calls[0]
    expect(applied).toMatchObject({
      outcome: 'applied',
      changeCount: 1,
      oldLength: 8,
      textLength: 8,
    })
    expect(applied).not.toHaveProperty('why')
    expect(log.mock.calls[2][1]).toMatchObject({ epoch: null })
  })
})

describe('DeltaWriter robustness (review repair)', () => {
  it('applyEdit rejecting is a refused write: pending cleared, resync apply-failed', async () => {
    const { writer, syncState, msg } = setup()
    vi.mocked(workspace.applyEdit).mockRejectedValueOnce(new Error('boom'))
    expect(await writer.apply(msg([change(0, 0, 0, 1, 'a', 'X')]))).toEqual({
      kind: 'resync',
      why: 'apply-failed',
    })
    expect(syncState.getPendingWebviewContent()).toBeUndefined()
    expect(syncState.isApplyingEdit()).toBe(false)
    expect(writer.acceptedSequence).toBe(0)
  })

  it('a length mismatch is refused without reading the range text', async () => {
    const { writer, document, msg } = setup('a\nb\nc')
    const getText = vi.spyOn(document, 'getText')
    // Whole-document range, one-character oldText.
    expect(await writer.apply(msg([change(0, 0, 2, 1, 'a', 'X')]))).toEqual({
      kind: 'resync',
      why: 'old-text',
    })
    expect(
      getText.mock.calls.filter(([range]) => range !== undefined),
    ).toHaveLength(0)
  })

  it('the length bound counts a CRLF break as one character', async () => {
    const { writer, document, msg } = setup('a\r\nb\r\nc', true)
    const getText = vi.spyOn(document, 'getText')
    expect(await writer.apply(msg([change(0, 0, 1, 1, 'a\nb', 'X')]))).toEqual({
      kind: 'applied',
    })
    expect(
      getText.mock.calls.filter(([range]) => range !== undefined),
    ).toHaveLength(2)
    expect(document.getText()).toBe('X\r\nc')
  })

  it('an earlier turn that moved the epoch makes the write drop without writing', async () => {
    let writer: ReturnType<typeof setup>['writer'] | undefined
    const made = setup('a\nb\nc', false, () => writer?.startEpoch())
    writer = made.writer
    expect(
      await writer.apply(made.msg([change(0, 0, 0, 1, 'a', 'X')])),
    ).toEqual({
      kind: 'dropped',
      why: 'epoch',
    })
    expect(made.document.getText()).toBe('a\nb\nc')
    expect(workspace.applyEdit).not.toHaveBeenCalled()
  })

  it('an earlier turn that changed the text makes the write resync old-text without writing', async () => {
    const made = setup('a\nb\nc', false, () => {
      made.document.__setText('Z\nb\nc')
    })
    expect(
      await made.writer.apply(made.msg([change(0, 0, 0, 1, 'a', 'X')])),
    ).toEqual({
      kind: 'resync',
      why: 'old-text',
    })
    expect(made.document.getText()).toBe('Z\nb\nc')
    expect(workspace.applyEdit).not.toHaveBeenCalled()
  })
})

// Task 733 (task 004): `applyHistory(message, walker)` — the order of shared rules 3.6. The walker is a
// fake that stands for `HistoryCouplingController.walkToPredicted`; a fake that proves moves the
// document to the predicted text, as the native Undo it stands for would.
describe('DeltaWriter.applyHistory (task 004)', () => {
  type Walk = 'proven' | 'declined' | 'diverged'
  type HistoryWriter = {
    applyHistory(
      message: unknown,
      walker: {
        walkToPredicted(
          kind: 'undo' | 'redo',
          steps: number,
          predicted: string,
        ): Promise<Walk>
      },
    ): Promise<{ kind: string; why?: string }>
  }

  function historySetup(
    text = 'a\nb\nc',
    walk: Walk = 'declined',
    during?: (document: ReturnType<typeof setup>['document']) => void,
  ) {
    const made = setup(text)
    const walkToPredicted = vi.fn(
      async (_kind: 'undo' | 'redo', _steps: number, predicted: string) => {
        if (walk === 'proven') made.document.__setText(predicted)
        during?.(made.document)
        return walk
      },
    )
    const writer = made.writer as unknown as HistoryWriter
    const hmsg = (changes: unknown[], over: Record<string, unknown> = {}) =>
      made.msg(changes, { kind: 'undo', steps: 1, ...over })
    return {
      ...made,
      walkToPredicted,
      hmsg,
      apply: (message: unknown) =>
        writer.applyHistory(message, { walkToPredicted }),
    }
  }
  const edit = [change(1, 0, 1, 1, 'b', 'B')]

  it('stale epoch -> dropped, no native command, no write', async () => {
    const { apply, hmsg, walkToPredicted, document } = historySetup()
    expect(await apply(hmsg(edit, { epoch: 1 }))).toEqual({
      kind: 'dropped',
      why: 'epoch',
    })
    expect(walkToPredicted).not.toHaveBeenCalled()
    expect(workspace.applyEdit).not.toHaveBeenCalled()
    expect(document.getText()).toBe('a\nb\nc')
  })

  it('a bad kind or step count -> resync history-shape, no native command', async () => {
    const { apply, hmsg, walkToPredicted } = historySetup()
    expect(await apply(hmsg(edit, { kind: 'back' }))).toEqual({
      kind: 'resync',
      why: 'history-shape',
    })
    expect(await apply(hmsg(edit, { steps: -1 }))).toEqual({
      kind: 'resync',
      why: 'history-shape',
    })
    expect(walkToPredicted).not.toHaveBeenCalled()
  })

  it('a validator refusal is the resync reason', async () => {
    const { apply, hmsg, walkToPredicted } = historySetup()
    expect(await apply(hmsg([]))).toEqual({ kind: 'resync', why: 'empty' })
    expect(walkToPredicted).not.toHaveBeenCalled()
  })

  it('sequence gap -> resync sequence, no native command', async () => {
    const { apply, hmsg, walkToPredicted } = historySetup()
    expect(await apply(hmsg(edit, { sequence: 2 }))).toEqual({
      kind: 'resync',
      why: 'sequence',
    })
    expect(walkToPredicted).not.toHaveBeenCalled()
  })

  it('oldText mismatch -> resync old-text before any native command', async () => {
    const { apply, hmsg, walkToPredicted, document } = historySetup()
    expect(await apply(hmsg([change(1, 0, 1, 1, 'z', 'B')]))).toEqual({
      kind: 'resync',
      why: 'old-text',
    })
    expect(walkToPredicted).not.toHaveBeenCalled()
    expect(workspace.applyEdit).not.toHaveBeenCalled()
    expect(document.getText()).toBe('a\nb\nc')
  })

  it('proven -> accepted, the walker gets the predicted text, no forward write, sequence advances', async () => {
    const { apply, hmsg, walkToPredicted, document, writer } = historySetup(
      'a\nb\nc',
      'proven',
    )
    expect(await apply(hmsg(edit, { kind: 'redo', steps: 2 }))).toEqual({
      kind: 'applied',
    })
    expect(walkToPredicted).toHaveBeenCalledExactlyOnceWith(
      'redo',
      2,
      'a\nB\nc',
    )
    expect(workspace.applyEdit).not.toHaveBeenCalled()
    expect(document.getText()).toBe('a\nB\nc')
    expect(writer.acceptedSequence).toBe(1)
  })

  it('predicted text is normalized for a CRLF document', async () => {
    const made = setup('a\r\nb\r\nc', true)
    const walkToPredicted = vi.fn(async () => 'declined' as const)
    await (made.writer as unknown as HistoryWriter).applyHistory(
      made.msg(edit, { kind: 'undo', steps: 1 }),
      { walkToPredicted },
    )
    expect(walkToPredicted).toHaveBeenCalledWith('undo', 1, 'a\nB\nc')
  })

  it('declined -> re-reads the document and writes the changes forward as one WorkspaceEdit', async () => {
    const { apply, hmsg, document, syncState, writer } = historySetup(
      'a\nb\nc',
      'declined',
    )
    expect(
      await apply(
        hmsg([change(0, 0, 0, 1, 'a', 'A'), change(2, 0, 2, 1, 'c', 'C')]),
      ),
    ).toEqual({ kind: 'applied' })
    expect(workspace.applyEdit).toHaveBeenCalledTimes(1)
    expect(document.getText()).toBe('A\nb\nC')
    expect(syncState.getPendingWebviewContent()).toBe('A\nb\nC')
    expect(syncState.isEcho(document.getText())).toBe(true)
    expect(syncState.isApplyingEdit()).toBe(false)
    expect(writer.acceptedSequence).toBe(1)
  })

  it('declined with the document changed during the walk -> resync old-text, no write', async () => {
    const { apply, hmsg, document, writer } = historySetup(
      'a\nb\nc',
      'declined',
      (doc) => doc.__setText('a\nZ\nc'),
    )
    expect(await apply(hmsg(edit))).toEqual({
      kind: 'resync',
      why: 'old-text',
    })
    expect(workspace.applyEdit).not.toHaveBeenCalled()
    expect(document.getText()).toBe('a\nZ\nc')
    expect(writer.acceptedSequence).toBe(0)
  })

  it('declined and applyEdit false -> resync apply-failed, pending cleared, sequence kept', async () => {
    const { apply, hmsg, syncState, writer } = historySetup('a\nb\nc')
    mock.queueApplyEditResult(false)
    expect(await apply(hmsg(edit))).toEqual({
      kind: 'resync',
      why: 'apply-failed',
    })
    expect(syncState.getPendingWebviewContent()).toBeUndefined()
    expect(syncState.isApplyingEdit()).toBe(false)
    expect(writer.acceptedSequence).toBe(0)
  })

  it('diverged -> resync, no forward write, sequence kept', async () => {
    const { apply, hmsg, writer } = historySetup('a\nb\nc', 'diverged')
    expect(await apply(hmsg(edit))).toMatchObject({ kind: 'resync' })
    expect(workspace.applyEdit).not.toHaveBeenCalled()
    expect(writer.acceptedSequence).toBe(0)
  })

  it('an edit-delta and a history delta share the accepted sequence', async () => {
    const { apply, hmsg, writer, msg } = historySetup('a\nb\nc', 'proven')
    expect(await writer.apply(msg([change(0, 0, 0, 1, 'a', 'A')]))).toEqual({
      kind: 'applied',
    })
    expect(await apply(hmsg(edit, { sequence: 2 }))).toEqual({
      kind: 'applied',
    })
    expect(writer.acceptedSequence).toBe(2)
    expect(
      await writer.apply(msg([change(2, 0, 2, 1, 'c', 'C')], { sequence: 3 })),
    ).toEqual({
      kind: 'applied',
    })
  })

  it('refusals of both messages count toward the limit of 5 in 10 s', async () => {
    const { apply, hmsg, writer, msg, clock, walkToPredicted } = historySetup()
    const badEdit = () =>
      msg([change(0, 0, 0, 1, 'z', 'X')], { epoch: writer.epoch })
    const badHistory = () =>
      hmsg([change(0, 0, 0, 1, 'z', 'X')], { epoch: writer.epoch })
    for (const bad of [badEdit, badHistory, badEdit, badHistory, badEdit]) {
      clock.t += 1000
      const out =
        bad === badHistory ? await apply(bad()) : await writer.apply(bad())
      expect(out).toEqual({ kind: 'resync', why: 'old-text' })
      writer.startEpoch()
    }
    const good = () =>
      hmsg([change(0, 0, 0, 1, 'a', 'X')], { epoch: writer.epoch })
    expect(await apply(good())).toEqual({
      kind: 'dropped',
      why: 'refusal-limit',
    })
    expect(walkToPredicted).not.toHaveBeenCalled()
    clock.t += 10_001
    expect(await apply(good())).toEqual({ kind: 'applied' })
  })

  it('the epoch moves during a proven walk -> dropped epoch, sequence not advanced', async () => {
    const made = setup('a\nb\nc')
    const walkToPredicted = vi.fn(
      async (_kind: 'undo' | 'redo', _steps: number, predicted: string) => {
        made.document.__setText(predicted)
        made.writer.startEpoch()
        return 'proven' as const
      },
    )
    const out = await (made.writer as unknown as HistoryWriter).applyHistory(
      made.msg(edit, { kind: 'undo', steps: 1 }),
      { walkToPredicted },
    )
    expect(out).toEqual({ kind: 'dropped', why: 'epoch' })
    expect(made.writer.acceptedSequence).toBe(0)
  })

  it('a change at an astral-character edge -> resync surrogate-edge, no native command', async () => {
    const made = setup('a😀b')
    const walkToPredicted = vi.fn(async () => 'proven' as const)
    const out = await (made.writer as unknown as HistoryWriter).applyHistory(
      made.msg([change(0, 2, 0, 3, '\ude00', 'x')], { kind: 'undo', steps: 1 }),
      { walkToPredicted },
    )
    expect(out).toEqual({ kind: 'resync', why: 'surrogate-edge' })
    expect(walkToPredicted).not.toHaveBeenCalled()
  })

  it('history delta refusals alone reach the limit', async () => {
    const { apply, hmsg, writer, clock } = historySetup()
    for (let i = 0; i < 5; i++) {
      clock.t += 1000
      await apply(hmsg(edit, { epoch: writer.epoch, steps: -1 }))
      writer.startEpoch()
    }
    expect(
      await writer.apply({
        epoch: writer.epoch,
        sequence: 1,
        changes: [change(0, 0, 0, 1, 'a', 'X')],
      }),
    ).toEqual({ kind: 'dropped', why: 'refusal-limit' })
  })

  it('a history delta with steps 0 is refused as history-shape, with no native step', async () => {
    const { apply, hmsg, walkToPredicted } = historySetup()
    expect(await apply(hmsg(edit, { steps: 0 }))).toEqual({
      kind: 'resync',
      why: 'history-shape',
    })
    expect(walkToPredicted).not.toHaveBeenCalled()
  })

  describe('logging (SR-5)', () => {
    const WORD = 'zebrafish'
    const allowed = [
      'outcome',
      'why',
      'kind',
      'steps',
      'hostEpoch',
      'epoch',
      'sequence',
      'acceptedSequence',
      'changeCount',
      'oldLength',
      'textLength',
    ]

    it.each([
      ['proven', 'proven' as const, 1],
      ['declined', 'declined' as const, 1],
      ['refused', 'declined' as const, 0],
    ])('%s logs no document text', async (_name, walk, steps) => {
      const { apply, hmsg, log } = historySetup(`a\n${WORD}\nc`, walk)
      await apply(
        hmsg([change(1, 0, 1, WORD.length, WORD, `${WORD}x`)], { steps }),
      )
      expect(log).toHaveBeenCalled()
      for (const [message, details] of log.mock.calls) {
        expect(JSON.stringify([message, details])).not.toContain(WORD)
        expect(
          Object.keys(details as object).every((k) => allowed.includes(k)),
        ).toBe(true)
      }
      expect(log.mock.calls.at(-1)?.[0]).toBe('history-delta')
    })

    it('a refusal on a text mismatch logs lengths only', async () => {
      const { apply, hmsg, log } = historySetup(`a\n${WORD}\nc`)
      await apply(hmsg([change(1, 0, 1, 3, 'zzz', `${WORD}x`)]))
      const [, details] = log.mock.calls.at(-1) as [
        string,
        Record<string, unknown>,
      ]
      expect(details).toMatchObject({ outcome: 'resync', why: 'old-text' })
      expect(JSON.stringify(details)).not.toContain(WORD)
    })
  })
})
