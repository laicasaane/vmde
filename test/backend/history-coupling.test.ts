import { describe, expect, it, vi } from 'vitest'
import {
  HistoryCouplingController,
  MAX_NATIVE_STEPS,
  PUBLISHED_LIMIT,
} from '../../src/writeback/history-coupling'

interface ModelOptions {
  // Native history, oldest first; the document is at the last state.
  states: string[]
  // Webview content -> the host texts it is semantically equivalent to.
  equivalents?: Record<string, string | string[]>
  // 1-based execute call that throws before changing anything.
  failOn?: number
  // Inverse (redo) calls after the first call land on a foreign state.
  divergeInverse?: boolean
}

// A fake document with VS Code's linear native history: each host write is one stop, Undo and Redo
// move between whole-document states, and an empty stack makes the command a no-op.
function model(options: ModelOptions) {
  const undoStack = [...options.states]
  let current = undoStack.pop() as string
  const redoStack: string[] = []
  let calls = 0
  const execute = vi.fn(async (kind: 'undo' | 'redo') => {
    calls++
    if (options.failOn === calls) throw new Error('command failed')
    if (options.divergeInverse && calls > 1 && kind === 'redo') {
      current = 'foreign'
      return
    }
    if (kind === 'undo' && undoStack.length) {
      redoStack.push(current)
      current = undoStack.pop() as string
    } else if (kind === 'redo' && redoStack.length) {
      undoStack.push(current)
      current = redoStack.pop() as string
    }
  })
  const equivalent = (source: string, content: string) =>
    content === source ||
    [options.equivalents?.[content] ?? []].flat().includes(source)
  const applying: boolean[] = []
  const synced: string[] = []
  const postUpdate = vi.fn(async () => undefined)
  const debug = vi.fn()
  const controller = new HistoryCouplingController({
    currentContent: () => current,
    equivalentToCurrent: (content) => equivalent(current, content),
    equivalent: (source, content) => equivalent(source, content),
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
    // An external writer: a new native stop that clears Redo.
    write: (content: string) => {
      undoStack.push(current)
      redoStack.length = 0
      current = content
    },
    stacks: () => ({ undo: [...undoStack], redo: [...redoStack] }),
  }
}

const outcome = (m: ReturnType<typeof model>) =>
  m.debug.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined

describe('HistoryCouplingController', () => {
  it('rejects an invalid runtime command before it can reach VS Code', async () => {
    const m = model({ states: ['host edited'] })

    expect(
      await m.controller.handle({
        kind: 'workbench.action.files.save' as 'undo',
        before: 'host edited',
        after: 'host baseline',
      }),
    ).toBe(false)
    expect(m.execute).not.toHaveBeenCalled()
    expect(m.debug).toHaveBeenCalledWith(
      'history coupling skipped: invalid native command',
      { kind: 'workbench.action.files.save' },
    )
  })

  it('executes one aligned native undo and consumes its later canonical webview echo', async () => {
    const m = model({
      states: ['host baseline', 'host edited'],
      equivalents: {
        'web edited': 'host edited',
        'web baseline': 'host baseline',
      },
    })

    expect(
      await m.controller.handle({
        kind: 'undo',
        before: 'web edited',
        after: 'web baseline',
      }),
    ).toBe(true)
    expect(m.execute).toHaveBeenCalledExactlyOnceWith('undo')
    expect(m.applying).toEqual([true, false])
    expect(m.synced).toEqual(['host baseline'])
    expect(await m.controller.consumeEdit('web baseline', true)).toBe(true)
    expect(m.postUpdate).not.toHaveBeenCalled()
  })

  it('skips native history when the host already matches the local result', async () => {
    const m = model({
      states: ['host baseline'],
      equivalents: { 'web baseline': 'host baseline' },
    })

    expect(
      await m.controller.handle({
        kind: 'undo',
        before: 'web edited',
        after: 'web baseline',
      }),
    ).toBe(true)
    expect(m.execute).not.toHaveBeenCalled()
    expect(await m.controller.consumeEdit('web baseline', true)).toBe(true)
  })

  it('executes native undo when exact host bytes are at the start despite semantic equivalence to the result', async () => {
    const afterFix = '3. first\n4. stale first\n\n4) second\n9) stale second\n'
    const afterAll = '3. first\n4. stale first\n\n4) second\n5) stale second\n'
    const m = model({
      states: [afterFix, afterAll],
      equivalents: { [afterFix]: afterAll },
    })

    expect(
      await m.controller.handle({
        kind: 'undo',
        before: afterAll,
        after: afterFix,
      }),
    ).toBe(true)
    expect(m.execute).toHaveBeenCalledExactlyOnceWith('undo')
    expect(m.current()).toBe(afterFix)
  })

  it('rejects a native no-op when exact source bytes needed to advance', async () => {
    const afterFix = '3. first\n4. stale first\n\n4) second\n9) stale second\n'
    const afterAll = '3. first\n4. stale first\n\n4) second\n5) stale second\n'
    const m = model({
      states: [afterAll],
      equivalents: { [afterFix]: afterAll },
    })

    expect(
      await m.controller.handle({
        kind: 'undo',
        before: afterAll,
        after: afterFix,
      }),
    ).toBe(false)
    expect(m.execute).toHaveBeenCalledExactlyOnceWith('undo')
    expect(m.current()).toBe(afterAll)
    expect(m.postUpdate).toHaveBeenCalledOnce()
    expect(m.synced).toEqual([])
  })

  it('does not stop a source-only walk on a semantically equal intermediate stop', async () => {
    const afterFix = '1. a\n9. b\n'
    const middle = '1. a\n7. b\n'
    const afterAll = '1. a\n2. b\n'
    const m = model({
      states: [afterFix, middle, afterAll],
      equivalents: { [afterFix]: [afterAll, middle] },
    })

    expect(
      await m.controller.handle({
        kind: 'undo',
        before: afterAll,
        after: afterFix,
      }),
    ).toBe(true)
    expect(m.execute).toHaveBeenCalledTimes(2)
    expect(m.current()).toBe(afterFix)
  })

  it('executes native redo when exact host bytes are at the start despite semantic equivalence to the result', async () => {
    const afterFix = '3. first\n4. stale first\n\n4) second\n9) stale second\n'
    const afterAll = '3. first\n4. stale first\n\n4) second\n5) stale second\n'
    const m = model({
      states: [afterFix, afterAll],
      equivalents: { [afterAll]: afterFix },
    })
    await m.controller.handle({
      kind: 'undo',
      before: afterAll,
      after: afterFix,
    })

    expect(
      await m.controller.handle({
        kind: 'redo',
        before: afterFix,
        after: afterAll,
      }),
    ).toBe(true)
    expect(m.execute.mock.calls).toEqual([['undo'], ['redo']])
    expect(m.current()).toBe(afterAll)
  })

  it('does not touch native history when neither side aligns', async () => {
    const m = model({ states: ['web baseline', 'external edit'] })

    expect(
      await m.controller.handle({
        kind: 'undo',
        before: 'web edited',
        after: 'web baseline',
      }),
    ).toBe(false)
    expect(m.execute).not.toHaveBeenCalled()
    expect(m.debug).toHaveBeenCalledWith(
      'history coupling skipped: host does not match transition start',
      expect.any(Object),
    )
  })

  it('does not swallow a new edit coalesced after the expected history content', async () => {
    const m = model({
      states: ['host baseline'],
      equivalents: { 'web baseline': 'host baseline' },
    })
    await m.controller.handle({
      kind: 'undo',
      before: 'web edited',
      after: 'web baseline',
    })

    expect(
      await m.controller.consumeEdit('web baseline plus typing', true),
    ).toBe(false)
    expect(await m.controller.consumeEdit('web baseline', true)).toBe(false)
  })

  it('consumes duplicate plain Undo echoes and preserves exact bytes for a semantic native Redo', async () => {
    const exactBase = '-   item\r\n'
    const renderedBase = '* item\n'
    const exactEdited = '-   itemX\r\n'
    const renderedEdited = '* itemX\n'
    const m = model({
      states: [exactBase, exactEdited],
      equivalents: {
        [renderedEdited]: exactEdited,
        [renderedBase]: exactBase,
      },
    })
    expect(
      await m.controller.handle({
        kind: 'undo',
        before: renderedEdited,
        after: renderedBase,
      }),
    ).toBe(true)
    const syncsBeforeEchoes = m.synced.length
    expect(await m.controller.consumeEdit(renderedBase, true)).toBe(true)
    expect(await m.controller.consumeEdit(renderedBase, true)).toBe(true)
    expect(m.current()).toBe(exactBase)
    expect(m.synced.slice(syncsBeforeEchoes)).toEqual([exactBase, exactBase])

    expect(
      await m.controller.handle({
        kind: 'redo',
        before: renderedBase,
        after: renderedEdited,
      }),
    ).toBe(true)
    expect(m.current()).toBe(exactEdited)
    expect(m.execute.mock.calls).toEqual([['undo'], ['redo']])
  })

  it.each(['exact', 'explicit-block', 'rewrap'])(
    'does not consume a non-plain %s edit and clears the retained expectation',
    async () => {
      const m = model({
        states: ['host baseline'],
        equivalents: { 'web baseline': 'host baseline' },
      })
      await m.controller.handle({
        kind: 'undo',
        before: 'web edited',
        after: 'web baseline',
      })
      expect(await m.controller.consumeEdit('web baseline', false)).toBe(false)
      expect(await m.controller.consumeEdit('web baseline', true)).toBe(false)
    },
  )

  it('expires the retained echo when the host changes, even if those host bytes later return', async () => {
    const m = model({
      states: ['host baseline'],
      equivalents: { 'web baseline': 'host baseline' },
    })
    await m.controller.handle({
      kind: 'undo',
      before: 'web edited',
      after: 'web baseline',
    })
    expect(await m.controller.consumeEdit('web baseline', true)).toBe(true)
    m.write('external host edit')
    expect(await m.controller.consumeEdit('web baseline', true)).toBe(false)
    m.write('host baseline')
    expect(await m.controller.consumeEdit('web baseline', true)).toBe(false)
  })
})

// Task 602: one webview history step spanning several host writes.
describe('HistoryCouplingController native traversal', () => {
  it('walks two native stops for one webview step, in both directions', async () => {
    const m = model({ states: ['a', 'aX', 'aXQ'] })

    expect(
      await m.controller.handle({ kind: 'undo', before: 'aXQ', after: 'a' }),
    ).toBe(true)
    expect(m.current()).toBe('a')
    expect(m.execute.mock.calls).toEqual([['undo'], ['undo']])
    expect(outcome(m)).toMatchObject({ steps: 2, proof: 'exact' })
    expect(
      await m.controller.handle({ kind: 'redo', before: 'a', after: 'aXQ' }),
    ).toBe(true)
    expect(m.current()).toBe('aXQ')
    expect(m.execute).toHaveBeenCalledTimes(4)
    // The retained pair describes the final state and absorbs its duplicate plain echoes.
    expect(await m.controller.consumeEdit('aXQ', true)).toBe(true)
    expect(await m.controller.consumeEdit('aXQ', true)).toBe(true)
    expect(m.postUpdate).not.toHaveBeenCalled()
  })

  it('does not accept a one-step native result that stops short of the webview result', async () => {
    const m = model({ states: ['a', 'aX', 'aXQ'] })

    await m.controller.handle({ kind: 'undo', before: 'aXQ', after: 'a' })

    expect(m.current()).toBe('a')
    expect(m.current()).not.toBe('aX')
    // The pair names the real result, so a save flush of the webview text is an exact match.
    expect(await m.controller.consumeEdit('a', true)).toBe(true)
  })

  it('walks five host writes inside one webview step', async () => {
    const m = model({ states: ['a', 'a1', 'a12', 'a123', 'a1234', 'a12345'] })

    expect(
      await m.controller.handle({ kind: 'undo', before: 'a12345', after: 'a' }),
    ).toBe(true)
    expect(m.execute).toHaveBeenCalledTimes(5)
  })

  it('reaches a result exactly at the step limit', async () => {
    const states = Array.from(
      { length: MAX_NATIVE_STEPS + 1 },
      (_, index) => `s${index}`,
    )
    const m = model({ states })

    expect(
      await m.controller.handle({
        kind: 'undo',
        before: states.at(-1) as string,
        after: 's0',
      }),
    ).toBe(true)
    expect(m.execute).toHaveBeenCalledTimes(MAX_NATIVE_STEPS)
  })

  it('refuses past the step limit and rolls every verified step back', async () => {
    const states = Array.from(
      { length: MAX_NATIVE_STEPS + 3 },
      (_, index) => `s${index}`,
    )
    const top = states.at(-1) as string
    const m = model({ states })

    expect(
      await m.controller.handle({ kind: 'undo', before: top, after: 's0' }),
    ).toBe(false)
    expect(m.execute).toHaveBeenCalledTimes(2 * MAX_NATIVE_STEPS)
    expect(outcome(m)).toMatchObject({
      steps: MAX_NATIVE_STEPS,
      stop: 'bound',
      rollback: 'restored',
    })
    expect(m.current()).toBe(top)
    // The original branch survives: Redo is empty and the next native Undo reaches the stop below.
    expect(m.stacks().redo).toEqual([])
    expect(m.stacks().undo.at(-1)).toBe(states.at(-2))
    expect(m.postUpdate).toHaveBeenCalledOnce()
  })

  it('refuses an aligned start whose result is not in native history and restores the start', async () => {
    const m = model({ states: ['other0', 'other1', 'aXQ'] })

    expect(
      await m.controller.handle({ kind: 'undo', before: 'aXQ', after: 'a' }),
    ).toBe(false)
    expect(outcome(m)).toMatchObject({
      steps: 2,
      stop: 'no-progress',
      rollback: 'restored',
    })
    expect(m.execute.mock.calls).toEqual([
      ['undo'],
      ['undo'],
      ['undo'],
      ['redo'],
      ['redo'],
    ])
    expect(m.current()).toBe('aXQ')
    expect(m.synced).toEqual([])
  })

  it('makes no inverse call when the first native command changes nothing', async () => {
    const m = model({ states: ['aXQ'] })

    expect(
      await m.controller.handle({ kind: 'undo', before: 'aXQ', after: 'a' }),
    ).toBe(false)
    expect(m.execute).toHaveBeenCalledExactlyOnceWith('undo')
    expect(outcome(m)).toMatchObject({ steps: 0, stop: 'no-progress' })
  })

  it('stops when native history returns to a text it already visited', async () => {
    let current = 'b'
    const texts = ['a', 'b']
    const execute = vi.fn(async () => {
      current = texts[(texts.indexOf(current) + 1) % texts.length]
    })
    const debug = vi.fn()
    const controller = new HistoryCouplingController({
      currentContent: () => current,
      equivalentToCurrent: (content) => content === current,
      equivalent: (source, content) => content === source,
      execute,
      setApplying: () => undefined,
      markSynced: () => undefined,
      postUpdate: async () => undefined,
      debug,
    })

    expect(
      await controller.handle({ kind: 'undo', before: 'b', after: 'z' }),
    ).toBe(false)
    expect(debug.mock.calls.at(-1)?.[1]).toMatchObject({ stop: 'repeated' })
  })

  it('inverts only the completed steps when a native command fails', async () => {
    const m = model({ states: ['z', 'a', 'aX', 'aXQ'], failOn: 3 })

    expect(
      await m.controller.handle({ kind: 'undo', before: 'aXQ', after: 'q' }),
    ).toBe(false)
    expect(outcome(m)).toMatchObject({
      steps: 2,
      stop: 'command-failed',
      rollback: 'restored',
    })
    expect(m.current()).toBe('aXQ')
    expect(m.applying.filter(Boolean)).toHaveLength(
      m.applying.filter((value) => !value).length,
    )
  })

  it('stops mutating when an inverse step fails', async () => {
    const m = model({ states: ['z', 'a', 'aXQ'], failOn: 4 })

    expect(
      await m.controller.handle({ kind: 'undo', before: 'aXQ', after: 'q' }),
    ).toBe(false)
    expect(outcome(m)).toMatchObject({ rollback: 'command-failed' })
    expect(m.execute).toHaveBeenCalledTimes(4)
    expect(m.current()).toBe('z')
  })

  it('stops mutating when an inverse step lands on an unexpected text', async () => {
    const m = model({ states: ['z', 'a', 'aXQ'], divergeInverse: true })

    expect(
      await m.controller.handle({ kind: 'undo', before: 'aXQ', after: 'q' }),
    ).toBe(false)
    expect(outcome(m)).toMatchObject({ rollback: 'diverged' })
    expect(m.execute).toHaveBeenCalledTimes(4)
    expect(m.current()).toBe('foreign')
  })

  it('resyncs after a refusal: the pair is cleared, so the next plain echo is written', async () => {
    const m = model({ states: ['a'] })
    await m.controller.handle({ kind: 'undo', before: 'b', after: 'a' })
    expect(await m.controller.consumeEdit('a', true)).toBe(true)

    expect(
      await m.controller.handle({ kind: 'undo', before: 'a', after: 'q' }),
    ).toBe(false)
    expect(m.postUpdate).toHaveBeenCalledOnce()
    expect(await m.controller.consumeEdit('q', true)).toBe(false)
    expect(await m.controller.consumeEdit('a', true)).toBe(false)
  })

  it('compares EOL-insensitively and keeps the CRLF host bytes', async () => {
    const m = model({ states: ['a\r\n', 'aX\r\n', 'aXQ\r\n'] })

    expect(
      await m.controller.handle({
        kind: 'undo',
        before: 'aXQ\n',
        after: 'a\n',
      }),
    ).toBe(true)
    expect(m.current()).toBe('a\r\n')
    expect(m.synced).toEqual(['a\r\n'])
  })
})

describe('HistoryCouplingController host proofs', () => {
  const authored = '-   item\r\n'
  const rendered = '* item\n'
  const canonicalX = '* itemX\n'
  const canonicalXQ = '* itemXQ\n'

  it('proves a non-round-trip result through a published pair', async () => {
    const m = model({ states: ['host baseline bytes', 'web edited'] })
    m.controller.recordPublished('canonical baseline', 'host baseline bytes')

    expect(
      await m.controller.handle({
        kind: 'undo',
        before: 'web edited',
        after: 'canonical baseline',
      }),
    ).toBe(true)
    expect(m.current()).toBe('host baseline bytes')
    expect(outcome(m)).toMatchObject({ steps: 1, proof: 'published' })
  })

  it('refuses the same unproved native result instead of accepting it from an aligned start', async () => {
    const m = model({ states: ['host baseline bytes', 'web edited'] })

    expect(
      await m.controller.handle({
        kind: 'undo',
        before: 'web edited',
        after: 'canonical baseline',
      }),
    ).toBe(false)
    expect(m.current()).toBe('web edited')
    expect(await m.controller.consumeEdit('canonical baseline', true)).toBe(
      false,
    )
  })

  it('large document: the history base proves Undo to the authored bytes and the retained pair the Redo start', async () => {
    const m = model({ states: [authored, canonicalX, canonicalXQ] })
    m.controller.recordBase('ir', rendered, authored)
    m.controller.recordPublished(canonicalX, canonicalX)
    m.controller.recordPublished(canonicalXQ, canonicalXQ)

    // No semantic comparison (as above the whole-document cap).
    expect(
      await m.controller.handle({
        kind: 'undo',
        before: canonicalXQ,
        after: rendered,
      }),
    ).toBe(true)
    expect(m.current()).toBe(authored)
    expect(outcome(m)).toMatchObject({ steps: 2, proof: 'base' })
    expect(await m.controller.consumeEdit(rendered, true)).toBe(true)
    expect(
      await m.controller.handle({
        kind: 'redo',
        before: rendered,
        after: canonicalXQ,
      }),
    ).toBe(true)
    expect(m.current()).toBe(canonicalXQ)
    expect(m.execute).toHaveBeenCalledTimes(4)
  })

  it('refuses a large Undo whose target has no proof', async () => {
    const m = model({ states: [authored, canonicalX, canonicalXQ] })

    expect(
      await m.controller.handle({
        kind: 'undo',
        before: canonicalXQ,
        after: rendered,
      }),
    ).toBe(false)
    expect(m.current()).toBe(canonicalXQ)
  })

  it('forgets a history base recorded without a host text', async () => {
    const m = model({ states: [authored, canonicalXQ] })
    m.controller.recordBase('ir', rendered, authored)
    m.controller.recordBase('ir', rendered, undefined)

    expect(
      await m.controller.handle({
        kind: 'undo',
        before: canonicalXQ,
        after: rendered,
      }),
    ).toBe(false)
  })

  it('keeps one history base per mode', async () => {
    const m = model({ states: [authored, canonicalXQ] })
    m.controller.recordBase('ir', rendered, authored)
    m.controller.recordBase('sv', 'other', 'other host')

    expect(
      await m.controller.handle({
        kind: 'undo',
        before: canonicalXQ,
        after: rendered,
      }),
    ).toBe(true)
  })

  it('forgets published pairs and history bases after a change VMDE did not make', async () => {
    const m = model({ states: [authored, 'host X', canonicalXQ] })
    m.controller.recordBase('ir', rendered, authored)
    m.controller.recordPublished('view X', 'host X')
    m.controller.forgetHostMappings()

    expect(
      await m.controller.handle({
        kind: 'undo',
        before: canonicalXQ,
        after: 'view X',
      }),
    ).toBe(false)
    expect(
      await m.controller.handle({
        kind: 'undo',
        before: canonicalXQ,
        after: rendered,
      }),
    ).toBe(false)
    expect(m.current()).toBe(canonicalXQ)
  })

  it(`evicts the least recently used published pair past ${PUBLISHED_LIMIT}`, async () => {
    const m = model({ states: ['host old', 'host kept', 'top'] })
    m.controller.recordPublished('view old', 'host old')
    m.controller.recordPublished('view kept', 'host kept')
    for (let index = 0; index < PUBLISHED_LIMIT - 2; index++)
      m.controller.recordPublished(`view ${index}`, `host ${index}`)
    // Using an entry again keeps it; the next record evicts the least recently used one.
    m.controller.recordPublished('view old', 'host old')
    m.controller.recordPublished('view new', 'host new')

    expect(
      await m.controller.handle({
        kind: 'undo',
        before: 'top',
        after: 'view kept',
      }),
    ).toBe(false)
    expect(
      await m.controller.handle({
        kind: 'undo',
        before: 'top',
        after: 'view old',
      }),
    ).toBe(true)
    expect(m.current()).toBe('host old')
  })

  it('keeps every host text published for the same webview content', async () => {
    const m = model({ states: ['host A', 'host B', 'top'] })
    m.controller.recordPublished('view', 'host A')
    m.controller.recordPublished('view', 'host B')
    m.controller.recordPublished('view', 'host B')

    expect(
      await m.controller.handle({ kind: 'undo', before: 'top', after: 'view' }),
    ).toBe(true)
    expect(m.current()).toBe('host B')
  })
})
