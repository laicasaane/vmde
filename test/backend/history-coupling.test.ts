import { describe, expect, it, vi } from 'vitest'
import { HistoryCouplingController } from '../../src/writeback/history-coupling'

function harness(initial: string, equivalents: Record<string, string>) {
  let current = initial
  const applying: boolean[] = []
  const synced: string[] = []
  const execute = vi.fn(async (kind: 'undo' | 'redo') => {
    current = equivalents[`${kind}:${current}`] ?? current
  })
  const postUpdate = vi.fn(async () => undefined)
  const debug = vi.fn()
  const controller = new HistoryCouplingController({
    currentContent: () => current,
    equivalentToCurrent: (content) =>
      content === current || equivalents[`equivalent:${content}`] === current,
    execute,
    setApplying: (value) => applying.push(value),
    markSynced: (content) => synced.push(content),
    postUpdate,
    debug,
  })
  return {
    controller,
    execute,
    postUpdate,
    debug,
    applying,
    synced,
    current: () => current,
  }
}

describe('HistoryCouplingController', () => {
  it('rejects an invalid runtime command before it can reach VS Code', async () => {
    const h = harness('host edited', {})

    expect(
      await h.controller.handle({
        kind: 'workbench.action.files.save' as 'undo',
        before: 'host edited',
        after: 'host baseline',
      }),
    ).toBe(false)
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.debug).toHaveBeenCalledWith(
      'history coupling skipped: invalid native command',
      { kind: 'workbench.action.files.save' },
    )
  })

  it('executes one aligned native undo and consumes its later canonical webview echo', async () => {
    const h = harness('host edited', {
      'equivalent:web edited': 'host edited',
      'undo:host edited': 'host baseline',
      'equivalent:web baseline': 'host baseline',
    })

    expect(
      await h.controller.handle({
        kind: 'undo',
        before: 'web edited',
        after: 'web baseline',
      }),
    ).toBe(true)
    expect(h.execute).toHaveBeenCalledExactlyOnceWith('undo')
    expect(h.applying).toEqual([true, false])
    expect(h.synced).toEqual(['host baseline'])
    expect(await h.controller.consumeEdit('web baseline')).toBe(true)
    expect(h.postUpdate).not.toHaveBeenCalled()
  })

  it('skips native history when the host already matches the local result', async () => {
    const h = harness('host baseline', {
      'equivalent:web baseline': 'host baseline',
    })

    expect(
      await h.controller.handle({
        kind: 'undo',
        before: 'web edited',
        after: 'web baseline',
      }),
    ).toBe(true)
    expect(h.execute).not.toHaveBeenCalled()
    expect(await h.controller.consumeEdit('web baseline')).toBe(true)
  })

  it('executes native undo when exact host bytes are at the start despite semantic equivalence to the result', async () => {
    const afterFix = '3. first\n4. stale first\n\n4) second\n9) stale second\n'
    const afterAll = '3. first\n4. stale first\n\n4) second\n5) stale second\n'
    const h = harness(afterAll, {
      [`equivalent:${afterFix}`]: afterAll,
      [`undo:${afterAll}`]: afterFix,
    })

    expect(
      await h.controller.handle({
        kind: 'undo',
        before: afterAll,
        after: afterFix,
      }),
    ).toBe(true)
    expect(h.execute).toHaveBeenCalledExactlyOnceWith('undo')
    expect(h.current()).toBe(afterFix)
  })

  it('rejects a native no-op when exact source bytes needed to advance', async () => {
    const afterFix = '3. first\n4. stale first\n\n4) second\n9) stale second\n'
    const afterAll = '3. first\n4. stale first\n\n4) second\n5) stale second\n'
    const h = harness(afterAll, {
      [`equivalent:${afterFix}`]: afterAll,
    })

    expect(
      await h.controller.handle({
        kind: 'undo',
        before: afterAll,
        after: afterFix,
      }),
    ).toBe(false)
    expect(h.execute).toHaveBeenCalledExactlyOnceWith('undo')
    expect(h.current()).toBe(afterAll)
    expect(h.postUpdate).toHaveBeenCalledOnce()
    expect(h.synced).toEqual([])
  })

  it('executes native redo when exact host bytes are at the start despite semantic equivalence to the result', async () => {
    const afterFix = '3. first\n4. stale first\n\n4) second\n9) stale second\n'
    const afterAll = '3. first\n4. stale first\n\n4) second\n5) stale second\n'
    const h = harness(afterFix, {
      [`equivalent:${afterAll}`]: afterFix,
      [`redo:${afterFix}`]: afterAll,
    })

    expect(
      await h.controller.handle({
        kind: 'redo',
        before: afterFix,
        after: afterAll,
      }),
    ).toBe(true)
    expect(h.execute).toHaveBeenCalledExactlyOnceWith('redo')
    expect(h.current()).toBe(afterAll)
  })

  it('accepts the native result from a byte-aligned start when canonical comparison is unavailable', async () => {
    const h = harness('web edited', {
      'undo:web edited': 'host baseline bytes',
    })

    expect(
      await h.controller.handle({
        kind: 'undo',
        before: 'web edited',
        after: 'canonical baseline',
      }),
    ).toBe(true)
    expect(h.execute).toHaveBeenCalledExactlyOnceWith('undo')
    expect(await h.controller.consumeEdit('canonical baseline')).toBe(true)
  })

  it('does not touch native history when neither side aligns', async () => {
    const h = harness('external edit', {})

    expect(
      await h.controller.handle({
        kind: 'undo',
        before: 'web edited',
        after: 'web baseline',
      }),
    ).toBe(false)
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.debug).toHaveBeenCalledWith(
      'history coupling skipped: host does not match transition start',
      expect.any(Object),
    )
  })

  it('rolls back a native step whose result does not align and resyncs the webview', async () => {
    const h = harness('host edited', {
      'equivalent:web edited': 'host edited',
      'undo:host edited': 'unexpected older state',
      'redo:unexpected older state': 'host edited',
    })

    expect(
      await h.controller.handle({
        kind: 'undo',
        before: 'web edited',
        after: 'web baseline',
      }),
    ).toBe(false)
    expect(h.execute.mock.calls).toEqual([['undo'], ['redo']])
    expect(h.current()).toBe('host edited')
    expect(h.applying).toEqual([true, false, true, false])
    expect(h.postUpdate).toHaveBeenCalledOnce()
  })

  it('does not swallow a new edit coalesced after the expected history content', async () => {
    const h = harness('host baseline', {
      'equivalent:web baseline': 'host baseline',
    })
    await h.controller.handle({
      kind: 'undo',
      before: 'web edited',
      after: 'web baseline',
    })

    expect(await h.controller.consumeEdit('web baseline plus typing')).toBe(
      false,
    )
    expect(await h.controller.consumeEdit('web baseline')).toBe(false)
  })
})
