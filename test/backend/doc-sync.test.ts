import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocSyncController } from '../../src/writeback/doc-sync'

// Task 405 — postUpdate()/schedulePostUpdate() extracted out of EditorSession, now backed
// by the (also-extracted) SyncState instead of three private fields. Behaviour must match
// the original exactly: the 'init' force-bypass, the already-synced dedup, and the 75ms
// debounce collapsing rapid edits into one post.
describe('DocSyncController', () => {
  let getText: () => string
  let postMessage: ReturnType<typeof vi.fn>
  let ctrl: DocSyncController

  beforeEach(() => {
    getText = () => 'hello world\n'
    postMessage = vi.fn()
    ctrl = new DocSyncController(
      { getDocument: () => ({ getText }) as any, postMessage },
      'hello world\n',
    )
  })

  it('postUpdate() posts an "update" with the document content', async () => {
    await ctrl.postUpdate()
    expect(postMessage).not.toHaveBeenCalled() // already synced to the constructor content
  })

  it('postUpdate() no-ops when the content already matches what was last synced', async () => {
    getText = () => 'hello world\r\n' // CRLF form of the same content
    await ctrl.postUpdate()
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('postUpdate() posts once the document actually changed, and updates lastSynced', async () => {
    getText = () => 'changed\n'
    await ctrl.postUpdate()
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'update', content: 'changed\n' }),
    )
    // A second call with the SAME content is now a no-op (lastSynced advanced).
    postMessage.mockClear()
    await ctrl.postUpdate()
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('postUpdate({type:"init"}) always posts, bypassing the dedup (the force flag)', async () => {
    await ctrl.postUpdate({ type: 'init', theme: 'dark' })
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'update',
        type: 'init',
        theme: 'dark',
        content: 'hello world\n',
      }),
    )
  })

  it('escapes table-cell span pipes in the posted content (table-code-pipes passthrough)', async () => {
    // The #1904 case: a `|` inside inline code in a table cell, over-splitting the row.
    getText = () => '| m | n |\n| - | - |\n| `a|b` | c |\n'
    await ctrl.postUpdate()
    const posted = postMessage.mock.calls[0][0]
    expect(posted.content).toBe('| m | n |\n| - | - |\n| `a\\|b` | c |\n')
  })

  it('attaches a seed derived from the exact normalized external-update content', async () => {
    const getIncrementalSeed = vi.fn((content: string) => ({
      markdown: `canonical:${content}`,
      source: {
        chars: content.length,
        lines: 4,
        blockHints: 700,
        listItems: 0,
        tableRows: 3,
        inlineRich: 1,
        fencedBlocks: 0,
      },
      reason: 'source-blocks' as const,
      hostMs: 1,
    }))
    ctrl = new DocSyncController(
      {
        getDocument: () => ({ getText }) as any,
        postMessage,
        getIncrementalSeed,
      },
      'hello world\n',
    )
    getText = () => '| m | n |\n| - | - |\n| `a|b` | c |\n'

    await ctrl.postUpdate()

    const normalized = '| m | n |\n| - | - |\n| `a\\|b` | c |\n'
    expect(getIncrementalSeed).toHaveBeenCalledWith(normalized)
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: normalized,
        incrementalSeed: expect.objectContaining({
          markdown: `canonical:${normalized}`,
        }),
      }),
    )
  })

  // Task 641 (fix 2): `init` no longer waits for the full-document host seed (about 1 s for a
  // 150 KB file); the seed follows in its own message, and a stale one is never posted.
  describe('deferred incremental seed (Task 641)', () => {
    const seedFor = (content: string) => ({
      markdown: `canonical:${content}`,
      source: {
        chars: content.length,
        lines: 4,
        blockHints: 700,
        listItems: 0,
        tableRows: 3,
        inlineRich: 1,
        fencedBlocks: 0,
      },
      reason: 'source-blocks' as const,
      hostMs: 1,
    })
    let getIncrementalSeed: ReturnType<typeof vi.fn>
    let order: string[]

    beforeEach(() => {
      vi.useFakeTimers()
      order = []
      getIncrementalSeed = vi.fn((content: string) => {
        order.push('seed computed')
        return seedFor(content)
      })
      postMessage.mockImplementation((message: any) =>
        order.push(
          message.command === 'update'
            ? `${message.type} posted`
            : message.command,
        ),
      )
      ctrl = new DocSyncController(
        {
          getDocument: () => ({ getText }) as any,
          postMessage,
          getIncrementalSeed,
        },
        'hello world\n',
      )
    })
    afterEach(() => vi.useRealTimers())

    it('posts init before the seed is computed, then the seed in its own message (acceptance: init first)', async () => {
      getText = () => '| m | n |\n| - | - |\n| `a|b` | c |\n'
      await ctrl.postUpdate({ type: 'init', deferIncrementalSeed: true })

      expect(order).toEqual(['init posted'])
      const init = postMessage.mock.calls[0][0]
      expect(init.incrementalSeed).toBeUndefined()
      expect(init).not.toHaveProperty('deferIncrementalSeed')

      await vi.runAllTimersAsync()
      const normalized = '| m | n |\n| - | - |\n| `a\\|b` | c |\n'
      expect(order).toEqual([
        'init posted',
        'seed computed',
        'incremental-seed',
      ])
      expect(postMessage).toHaveBeenLastCalledWith({
        command: 'incremental-seed',
        content: normalized,
        seed: expect.objectContaining({ markdown: `canonical:${normalized}` }),
      })
    })

    it('drops the seed when the document changed before it was computed (edge: stale seed)', async () => {
      await ctrl.postUpdate({ type: 'init', deferIncrementalSeed: true })
      getText = () => 'typed after init\n'

      await vi.runAllTimersAsync()
      expect(getIncrementalSeed).not.toHaveBeenCalled()
      expect(order).toEqual(['init posted'])
    })

    it('drops the seed when a newer update was posted, even if the text came back (edge: stale seed)', async () => {
      await ctrl.postUpdate({ type: 'init', deferIncrementalSeed: true })
      getText = () => 'external\n'
      await ctrl.postUpdate()
      getText = () => 'hello world\n'
      await ctrl.postUpdate()
      order.length = 0
      getIncrementalSeed.mockClear()

      await vi.runAllTimersAsync()
      expect(getIncrementalSeed).not.toHaveBeenCalled()
      expect(order).toEqual([])
    })

    it('posts nothing when the content is not eligible, and nothing after dispose', async () => {
      getIncrementalSeed.mockReturnValue(undefined)
      await ctrl.postUpdate({ type: 'init', deferIncrementalSeed: true })
      await vi.runAllTimersAsync()
      expect(order).toEqual(['init posted'])

      getIncrementalSeed.mockImplementation(seedFor)
      await ctrl.postUpdate({ type: 'init', deferIncrementalSeed: true })
      ctrl.disposeTimer()
      await vi.runAllTimersAsync()
      expect(order).toEqual(['init posted', 'init posted'])
    })
  })

  describe('schedulePostUpdate — debounce', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('collapses rapid calls into a single post after 75ms of quiet', async () => {
      getText = () => 'a\n'
      ctrl.schedulePostUpdate()
      getText = () => 'ab\n'
      ctrl.schedulePostUpdate() // re-arms — the first timer must be cleared, not both fire
      getText = () => 'abc\n'
      ctrl.schedulePostUpdate()
      await vi.advanceTimersByTimeAsync(75)
      expect(postMessage).toHaveBeenCalledTimes(1)
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'abc\n' }),
      )
    })

    it('cancels a pending ordinary update before an owned checkbox update', async () => {
      getText = () => '- [x] task\n'
      ctrl.schedulePostUpdate()
      ctrl.cancelScheduledUpdate()
      await ctrl.postUpdate({
        previewTaskCheckboxHistory: {
          requestId: 'toggle-1',
          before: '- [ ] task\n',
          after: '- [x] task\n',
        },
      })
      await vi.advanceTimersByTimeAsync(200)
      expect(postMessage).toHaveBeenCalledTimes(1)
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'update',
          content: '- [x] task\n',
          previewTaskCheckboxHistory: {
            requestId: 'toggle-1',
            before: '- [ ] task\n',
            after: '- [x] task\n',
            renderedAfter: '- [x] task\n',
          },
        }),
      )
    })

    it('disposeTimer() cancels a pending scheduled post', async () => {
      getText = () => 'changed\n'
      ctrl.schedulePostUpdate()
      ctrl.disposeTimer()
      await vi.advanceTimersByTimeAsync(200)
      expect(postMessage).not.toHaveBeenCalled()
    })
  })

  // Task 733 — the delta epoch rides on every update; a new epoch is always posted.
  describe('epoch (Task 733)', () => {
    const updates = () => postMessage.mock.calls.map(([m]) => m)

    it('carries epoch on every update, and no raw or afterSequence by default', async () => {
      getText = () => 'changed\n'
      await ctrl.postUpdate()
      expect(updates()[0]).toMatchObject({ command: 'update', epoch: 0 })
      expect('raw' in updates()[0]).toBe(false)
      expect('afterSequence' in updates()[0]).toBe(false)
    })

    it('posts the same text again after startEpoch, with epoch + 1; not without it', async () => {
      await ctrl.postUpdate()
      expect(postMessage).not.toHaveBeenCalled()
      ctrl.syncState.startEpoch()
      await ctrl.postUpdate()
      expect(updates()).toEqual([
        expect.objectContaining({ epoch: 1, content: 'hello world\n' }),
      ])
      postMessage.mockClear()
      await ctrl.postUpdate()
      expect(postMessage).not.toHaveBeenCalled()
    })

    it('puts afterSequence on the first update after the epoch ended, once', async () => {
      ctrl.noteEpochEnded(3)
      ctrl.noteEpochEnded(9) // a second start before the post: the webview applied the first epoch
      ctrl.syncState.startEpoch()
      await ctrl.postUpdate()
      expect(updates()[0]).toMatchObject({ epoch: 1, afterSequence: 3 })
      ctrl.syncState.startEpoch()
      await ctrl.postUpdate()
      expect('afterSequence' in updates()[1]).toBe(false)
    })

    it('adds raw only when escaping table code pipes changed the text', async () => {
      const raw = '| m | n |\n| - | - |\n| `a|b` | c |\n'
      getText = () => raw
      await ctrl.postUpdate()
      expect(updates()[0].raw).toBe(raw)
      expect(updates()[0].content).not.toBe(raw)
      getText = () => 'plain\n'
      await ctrl.postUpdate()
      expect('raw' in updates()[1]).toBe(false)
    })

    it('postRebind posts the document text and keeps a later update of it skipped', async () => {
      getText = () => 'host text\n'
      ctrl.syncState.startEpoch()
      ctrl.postRebind(0)
      ctrl.postRebind(2, 5)
      expect(updates()).toEqual([
        {
          command: 'rebind',
          epoch: 1,
          afterSequence: 0,
          content: 'host text\n',
        },
        {
          command: 'rebind',
          epoch: 1,
          afterSequence: 2,
          content: 'host text\n',
          editSequence: 5,
        },
      ])
      postMessage.mockClear()
      await ctrl.postUpdate()
      expect(postMessage).not.toHaveBeenCalled()
    })

    it('announceEpoch marks the epoch told, returns afterSequence once, and posts nothing', async () => {
      ctrl.noteEpochEnded(2)
      ctrl.syncState.startEpoch()
      expect(ctrl.announceEpoch()).toEqual({ epoch: 1, afterSequence: 2 })
      expect(postMessage).not.toHaveBeenCalled()
      // The same text at the told epoch is not posted again.
      await ctrl.postUpdate()
      expect(postMessage).not.toHaveBeenCalled()
      ctrl.syncState.startEpoch()
      expect(ctrl.announceEpoch()).toEqual({ epoch: 2 })
    })

    it('postBaseline and postRestoreBaseline carry the epoch', () => {
      ctrl.syncState.startEpoch()
      ctrl.postBaseline(4)
      ctrl.postRestoreBaseline(4, 'base\n')
      expect(updates()).toEqual([
        { command: 'baseline', epoch: 1, afterSequence: 4 },
        {
          command: 'restore-baseline',
          epoch: 1,
          afterSequence: 4,
          content: 'base\n',
        },
      ])
    })
  })
})
