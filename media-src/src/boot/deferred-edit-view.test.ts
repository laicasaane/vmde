// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Task 643 step 5 (RED): a Preview-first open does not build the edit view. The document text waits
// here until the user first leaves Preview; `ensureEditView` then builds the edit view once, and
// replays the checkbox toggles made meanwhile so each is still one native Undo step.
const h = vi.hoisted(() => ({
  streamRenderIR: vi.fn(),
  streamRenderSV: vi.fn(),
  replayDeferredCheckboxHistory: vi.fn(),
}))
vi.mock('../diagrams/stream-render', () => ({
  streamRenderIR: h.streamRenderIR,
  streamRenderSV: h.streamRenderSV,
  STREAM_MIN_CHARS: 700_000,
}))

import { sessionState } from './editor-session-state'
import {
  beginDeferredEditView,
  configureDeferredEditView,
  deferredEditViewPending,
  ensureEditView,
  queueDeferredCheckboxHistory,
  shouldOpenPreviewFirst,
  updateDeferredEditViewText,
} from './deferred-edit-view'

const entry = (before: string, after: string) => ({
  before,
  after,
  renderedAfter: after,
})

function liveEditor() {
  const setValue = vi.fn()
  ;(window as any).vditor = { setValue, vditor: { ir: {}, sv: {} } }
  const editSync = {
    invalidate: vi.fn(),
    startIncrementalSeed: vi.fn(),
    reseed: vi.fn(),
  }
  sessionState.editSync = editSync as never
  return { setValue, editSync }
}

beforeEach(() => {
  vi.clearAllMocks()
  configureDeferredEditView({ replay: h.replayDeferredCheckboxHistory })
  sessionState.deferredEditView = null
  sessionState.applyingExtensionUpdate = false
  sessionState.streaming = false
  sessionState.editSync = null
  ;(window as any).vditor = undefined
})

afterEach(() => {
  vi.useRealTimers()
})

describe('shouldOpenPreviewFirst', () => {
  it('opens Preview first for a preview rule or a remembered Preview, at any size', () => {
    expect(shouldOpenPreviewFirst({ defaultMode: 'preview' }, false)).toBe(true)
    expect(shouldOpenPreviewFirst({}, true)).toBe(true)
    expect(shouldOpenPreviewFirst(undefined, true)).toBe(true)
  })

  it('keeps an edit-mode open for every other case', () => {
    expect(shouldOpenPreviewFirst({}, false)).toBe(false)
    expect(shouldOpenPreviewFirst({ defaultMode: 'ir' }, false)).toBe(false)
    expect(shouldOpenPreviewFirst(undefined, false)).toBe(false)
  })
})

describe('the pending state', () => {
  it('is not pending until begun, then holds the text, mode and an empty history', () => {
    expect(deferredEditViewPending()).toBe(false)
    beginDeferredEditView('# text', 'sv')
    expect(deferredEditViewPending()).toBe(true)
    expect(sessionState.deferredEditView).toEqual({
      text: '# text',
      mode: 'sv',
      history: [],
    })
  })

  it('queues checkbox transactions in order', () => {
    beginDeferredEditView('a', 'ir')
    queueDeferredCheckboxHistory(entry('a', 'b'))
    queueDeferredCheckboxHistory(entry('b', 'c'))
    expect(sessionState.deferredEditView?.history).toEqual([
      entry('a', 'b'),
      entry('b', 'c'),
    ])
  })

  it('replaces the text and drops the queued history on an ordinary text update', () => {
    beginDeferredEditView('a', 'ir')
    queueDeferredCheckboxHistory(entry('a', 'b'))
    updateDeferredEditViewText('outside change')
    expect(sessionState.deferredEditView).toEqual({
      text: 'outside change',
      mode: 'ir',
      history: [],
    })
  })

  it('ignores queue and update calls when nothing is pending', () => {
    queueDeferredCheckboxHistory(entry('a', 'b'))
    updateDeferredEditViewText('x')
    expect(sessionState.deferredEditView).toBeNull()
  })
})

describe('ensureEditView', () => {
  it('resolves false and builds nothing when no edit view is pending', async () => {
    const { setValue } = liveEditor()
    await expect(ensureEditView()).resolves.toBe(false)
    expect(setValue).not.toHaveBeenCalled()
  })

  it('builds a small document with one setValue, under the extension-update guard', async () => {
    vi.useFakeTimers()
    const { setValue, editSync } = liveEditor()
    let guardDuringBuild = false
    setValue.mockImplementation(() => {
      guardDuringBuild = sessionState.applyingExtensionUpdate
    })
    beginDeferredEditView('# small document', 'ir')

    await expect(ensureEditView()).resolves.toBe(true)

    expect(setValue).toHaveBeenCalledExactlyOnceWith('# small document', true)
    expect(guardDuringBuild).toBe(true)
    expect(deferredEditViewPending()).toBe(false)
    expect(editSync.invalidate).toHaveBeenCalledTimes(1)
    expect(editSync.startIncrementalSeed).toHaveBeenCalledTimes(1)
    vi.runAllTimers()
    expect(sessionState.applyingExtensionUpdate).toBe(false)
  })

  it('builds only once, even when called again or concurrently', async () => {
    const { setValue } = liveEditor()
    beginDeferredEditView('text', 'ir')
    const first = ensureEditView()
    const second = ensureEditView()
    await expect(first).resolves.toBe(true)
    await second
    await expect(ensureEditView()).resolves.toBe(false)
    expect(setValue).toHaveBeenCalledTimes(1)
  })

  it('builds from the first queued "before" text, then replays each checkbox transaction in order', async () => {
    const { setValue } = liveEditor()
    const order: string[] = []
    setValue.mockImplementation((text: string) => order.push(`build:${text}`))
    h.replayDeferredCheckboxHistory.mockImplementation(
      (item: { after: string }) => order.push(`replay:${item.after}`),
    )
    beginDeferredEditView('- [x] one\n- [x] two\n', 'ir')
    queueDeferredCheckboxHistory(
      entry('- [ ] one\n- [ ] two\n', '- [x] one\n- [ ] two\n'),
    )
    queueDeferredCheckboxHistory(
      entry('- [x] one\n- [ ] two\n', '- [x] one\n- [x] two\n'),
    )

    await ensureEditView()

    expect(order).toEqual([
      'build:- [ ] one\n- [ ] two\n',
      'replay:- [x] one\n- [ ] two\n',
      'replay:- [x] one\n- [x] two\n',
    ])
  })

  it('streams a document above the edit-mode threshold into IR and releases the stream state', async () => {
    const element = document.createElement('div')
    ;(window as any).vditor = {
      setValue: vi.fn(),
      vditor: {
        ir: { element },
        sv: { element: document.createElement('div') },
      },
    }
    sessionState.editSync = {
      invalidate: vi.fn(),
      startIncrementalSeed: vi.fn(),
      reseed: vi.fn(),
    } as never
    let streamingDuringStream = false
    h.streamRenderIR.mockImplementation(
      async (_pub: unknown, _text: string, hooks: { onDone?: () => void }) => {
        streamingDuringStream = sessionState.streaming
        hooks.onDone?.()
      },
    )
    const huge = 'x'.repeat(700_001)
    beginDeferredEditView(huge, 'ir')

    await expect(ensureEditView()).resolves.toBe(true)

    expect(h.streamRenderIR).toHaveBeenCalledTimes(1)
    expect(h.streamRenderIR.mock.calls[0][1]).toBe(huge)
    expect(h.streamRenderSV).not.toHaveBeenCalled()
    expect((window as any).vditor.setValue).not.toHaveBeenCalled()
    expect(streamingDuringStream).toBe(true)
    expect(sessionState.streaming).toBe(false)
    expect(
      (sessionState.editSync as unknown as { startIncrementalSeed: unknown })
        .startIncrementalSeed,
    ).toHaveBeenCalledTimes(1)
  })

  it('streams a Split document into the source pane', async () => {
    ;(window as any).vditor = {
      setValue: vi.fn(),
      vditor: {
        ir: { element: document.createElement('div') },
        sv: { element: document.createElement('div') },
      },
    }
    h.streamRenderSV.mockImplementation(
      async (_pub: unknown, _text: string, hooks: { onDone?: () => void }) => {
        hooks.onDone?.()
      },
    )
    beginDeferredEditView('x'.repeat(700_001), 'sv')
    await ensureEditView()
    expect(h.streamRenderSV).toHaveBeenCalledTimes(1)
    expect(h.streamRenderIR).not.toHaveBeenCalled()
  })

  it('replays the checkbox history after a streamed build', async () => {
    ;(window as any).vditor = {
      setValue: vi.fn(),
      vditor: { ir: { element: document.createElement('div') }, sv: {} },
    }
    h.streamRenderIR.mockImplementation(
      async (_pub: unknown, _text: string, hooks: { onDone?: () => void }) => {
        hooks.onDone?.()
      },
    )
    const before = `- [ ] task\n${'x'.repeat(700_001)}`
    beginDeferredEditView(before.replace('[ ]', '[x]'), 'ir')
    queueDeferredCheckboxHistory(entry(before, before.replace('[ ]', '[x]')))
    await ensureEditView()
    expect(h.streamRenderIR.mock.calls[0][1]).toBe(before)
    expect(h.replayDeferredCheckboxHistory).toHaveBeenCalledTimes(1)
  })

  // Review R1 (findings 2 and 3): a failed stream must not leave a truncated, editable document with
  // sync live, and an outside change that arrived during the stream must not be lost.
  describe('a streamed build that fails', () => {
    function streamEditor() {
      const element = document.createElement('div')
      const setValue = vi.fn()
      ;(window as any).vditor = {
        setValue,
        vditor: { ir: { element }, sv: { element } },
      }
      sessionState.editSync = {
        invalidate: vi.fn(),
        startIncrementalSeed: vi.fn(),
        reseed: vi.fn(),
      } as never
      return { element, setValue }
    }
    const huge = 'x'.repeat(700_001)

    it('restores the whole document before the view is released, and resolves', async () => {
      const { element, setValue } = streamEditor()
      h.streamRenderIR.mockRejectedValue(new Error('stream failed'))
      beginDeferredEditView(huge, 'ir')
      await expect(ensureEditView()).resolves.toBe(true)
      expect(setValue).toHaveBeenCalledWith(huge)
      expect(sessionState.streaming).toBe(false)
      expect(element.getAttribute('contenteditable')).toBe('true')
    })

    it('keeps the partial view locked and sync suspended when the restore fails too', async () => {
      const { element, setValue } = streamEditor()
      h.streamRenderIR.mockRejectedValue(new Error('stream failed'))
      setValue.mockImplementation(() => {
        throw new Error('restore failed')
      })
      beginDeferredEditView(huge, 'ir')
      await expect(ensureEditView()).resolves.toBe(true)
      expect(sessionState.streaming).toBe(true)
      expect(element.getAttribute('contenteditable')).toBe('false')
      expect(sessionState.editSync?.startIncrementalSeed).not.toHaveBeenCalled()
    })
  })

  it('replays an outside change that arrived during a streamed build, after the checkbox history', async () => {
    const element = document.createElement('div')
    ;(window as any).vditor = {
      setValue: vi.fn(),
      vditor: { ir: { element }, sv: { element } },
    }
    sessionState.editSync = {
      invalidate: vi.fn(),
      startIncrementalSeed: vi.fn(),
      reseed: vi.fn(),
    } as never
    const order: string[] = []
    h.replayDeferredCheckboxHistory.mockImplementation(() =>
      order.push('checkbox'),
    )
    const posted = vi.spyOn(window, 'postMessage').mockImplementation(() => {
      order.push('update')
    })
    const update = { command: 'update', content: 'outside change' } as never
    h.streamRenderIR.mockImplementation(
      async (_pub: unknown, _text: string, hooks: { onDone?: () => void }) => {
        sessionState.deferredHostUpdate = update
        hooks.onDone?.()
      },
    )
    const before = `- [ ] task\n${'x'.repeat(700_001)}`
    beginDeferredEditView(before.replace('[ ]', '[x]'), 'ir')
    queueDeferredCheckboxHistory(entry(before, before.replace('[ ]', '[x]')))

    await ensureEditView()

    expect(posted).toHaveBeenCalledWith(update, '*')
    expect(sessionState.deferredHostUpdate).toBeNull()
    expect(order).toEqual(['checkbox', 'update'])
    posted.mockRestore()
  })

  // Review R2: the small path starts a fresh undo history (setValue(text, true)); a streamed build
  // must too, before any checkbox replay, or its stream-end undo entry survives as an Undo step.
  it('clears the undo history after a streamed build, before the checkbox replay', async () => {
    const order: string[] = []
    const element = document.createElement('div')
    ;(window as any).vditor = {
      setValue: vi.fn(),
      clearStack: vi.fn(() => order.push('clear')),
      vditor: { ir: { element }, sv: { element } },
    }
    sessionState.editSync = {
      invalidate: vi.fn(),
      startIncrementalSeed: vi.fn(),
      reseed: vi.fn(),
    } as never
    h.replayDeferredCheckboxHistory.mockImplementation(() =>
      order.push('replay'),
    )
    h.streamRenderIR.mockImplementation(
      async (_pub: unknown, _text: string, hooks: { onDone?: () => void }) => {
        order.push('stream')
        hooks.onDone?.()
      },
    )
    const before = `- [ ] task\n${'x'.repeat(700_001)}`
    beginDeferredEditView(before.replace('[ ]', '[x]'), 'ir')
    queueDeferredCheckboxHistory(entry(before, before.replace('[ ]', '[x]')))
    await ensureEditView()
    expect(order).toEqual(['stream', 'clear', 'replay'])
  })
})
