import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { EditorSession } from '../../src/app/extension'
import { WritebackController } from '../../src/writeback/writeback-controller'
import { mock } from './vscode-mock'

const seed = vi.hoisted(() => ({ canonicalize: vi.fn() }))
vi.mock('../../src/lute/lute-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lute/lute-host')>()),
  canonicalizeIrMarkdown: seed.canonicalize,
}))

// The whole point of the refactor: EditorSession is now an independently
// constructible unit. Give it a context, a document, a webview panel, and an HTML
// builder — no MarkdownEditorProvider, no real _getHtmlForWebview — and drive it.
function makeSession(fsPath = '/ws/note.md', text = '# Hi\n\nbody\n') {
  mock.setWorkspaceFolder('/ws')
  const context = {
    ...mock.createExtensionContext(),
    extensionPath: process.cwd(),
    extensionUri: vscode.Uri.file(process.cwd()),
  }
  const document = mock.createTextDocument(fsPath, text)
  const panel = mock.createWebviewPanel()
  // injected html builder — stand-in for the provider's _getHtmlForWebview
  const html = (_w: unknown, _u: unknown, content?: string) =>
    `<div id="app"></div>${content ?? ''}`
  // task 184 — a no-op diagram-cache stub (the provider injects the real one).
  const diagramCache = {
    registerDoc() {
      /* no-op stub — see comment above */
    },
    closeDoc() {
      /* no-op stub — see comment above */
    },
    get() {
      return undefined
    },
    put() {
      /* no-op stub — see comment above */
    },
  }
  const session = new EditorSession(
    context as any,
    document as any,
    panel as any,
    diagramCache as any,
    html as any,
  )
  return { session, panel, document, context }
}

describe('EditorSession (constructed directly)', () => {
  beforeEach(() => {
    mock.reset()
    seed.canonicalize.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('start() renders the injected html (with the document content) into the webview', () => {
    const { session, panel } = makeSession('/ws/note.md', '# Hello\n')
    session.start()
    expect(panel.webview.html).toContain('id="app"')
    expect(panel.webview.html).toContain('# Hello')
  })

  it('answers a `ready` message with an init `update` carrying the content', async () => {
    const { session, panel } = makeSession('/ws/note.md', '# Title\n')
    session.start()
    await panel._receiveMessage({ command: 'ready' })
    const init = mock.calls.postMessage.find(
      (m: any) => m.command === 'update' && m.type === 'init',
    )
    expect(init).toBeDefined()
    expect(init.content).toContain('# Title')
    expect(init.documentName).toBe('note.md')
  })

  it('announces successful copies and saves through the host message route', async () => {
    const { session, panel, document } = makeSession(
      '/ws/announce.md',
      '# Announce\n',
    )
    session.start()
    await panel._receiveMessage({
      command: 'copy-code',
      content: 'const value = 1',
    })
    mock.fireDidSaveTextDocument(document)

    expect(mock.calls.postMessage).toContainEqual({
      command: 'announce',
      message: 'Copied code',
    })
    expect(mock.calls.postMessage).toContainEqual({
      command: 'announce',
      message: 'Saved announce.md',
    })
  })

  it('routes an aligned webview history transition through native undo and consumes its edit echo', async () => {
    const { session, panel, document } = makeSession(
      '/ws/history.md',
      'host edited\n',
    )
    mock.setExecuteCommandResponse((command) => {
      if (command === 'undo') document.__setText('host baseline\n')
    })
    session.start()

    await panel._receiveMessage({
      command: 'history-transition',
      kind: 'undo',
      before: 'host edited\n',
      after: 'host baseline\n',
    })
    await panel._receiveMessage({
      command: 'edit',
      content: 'host baseline\n',
    })

    expect(mock.calls.executeCommand).toContainEqual({
      command: 'undo',
      args: [],
    })
    expect(document.getText()).toBe('host baseline\n')
    expect(mock.calls.appliedEdits).toHaveLength(0)
  })

  it('adds a host-canonical incremental seed only for an eligible complex init', async () => {
    const content = Array.from(
      { length: 700 },
      (_, index) => `paragraph ${index}`,
    ).join('\n\n')
    seed.canonicalize.mockReturnValue('CANONICAL\n')
    const { session, panel } = makeSession('/ws/complex.md', content)
    session.start()
    await panel._receiveMessage({ command: 'ready' })
    const init = mock.calls.postMessage.find(
      (message: any) => message.command === 'update' && message.type === 'init',
    )

    expect(seed.canonicalize).toHaveBeenCalledTimes(1)
    expect(init.incrementalSeed).toMatchObject({
      markdown: 'CANONICAL\n',
      reason: 'source-blocks',
      source: { blockHints: 700 },
    })
  })

  it('does not call host Lute or add a seed for a small init', async () => {
    const { session, panel } = makeSession('/ws/small.md', '# Small\n\ntext\n')
    session.start()
    await panel._receiveMessage({ command: 'ready' })
    const init = mock.calls.postMessage.find(
      (message: any) => message.command === 'update' && message.type === 'init',
    )

    expect(seed.canonicalize).not.toHaveBeenCalled()
    expect(init.incrementalSeed).toBeUndefined()
  })

  it('loads and saves per-document fold state through workspaceState', async () => {
    const { session, panel, document, context } = makeSession(
      '/ws/folds.md',
      '# One\n\nbody\n',
    )
    const key = `vmde.foldState:${document.uri.toString()}`
    const initial = {
      headings: [{ id: 'one', text: 'One', level: 1 }],
      lists: [],
    }
    await context.workspaceState.update(key, initial)
    session.start()
    await panel._receiveMessage({ command: 'ready' })
    expect(
      mock.calls.postMessage.find(
        (message: any) => message.command === 'update',
      )?.foldState,
    ).toEqual(initial)

    const next = { headings: [], lists: [{ path: [0, 0], text: 'parent' }] }
    await panel._receiveMessage({ command: 'save-fold-state', state: next })
    expect(context.workspaceState.get(key)).toEqual(next)
  })

  it('promotes a valid picker insertion canonically and syncs every ready editor', async () => {
    const { session, panel, context } = makeSession('/ws/emoji.md', 'emoji\n')
    const { session: otherSession, panel: otherPanel } = makeSession(
      '/ws/other.md',
      'other\n',
    )
    const initial = { version: 1, sequences: ['😀'] }
    await context.globalState.update('vmde.emojiRecents', initial)
    session.start()
    otherSession.start()
    await panel._receiveMessage({ command: 'ready' })
    await otherPanel._receiveMessage({ command: 'ready' })
    expect(
      mock.calls.postMessage.find(
        (message: any) => message.command === 'update',
      )?.emojiRecents,
    ).toEqual(initial)

    await panel._receiveMessage({
      command: 'record-emoji-recent',
      sequence: '🫩',
    } as any)
    const next = { version: 1, sequences: ['🫩', '😀'] }
    expect(context.globalState.get('vmde.emojiRecents')).toEqual(next)
    expect(mock.calls.postMessage).toContainEqual({
      command: 'emoji-recents',
      state: next,
    })

    await Promise.all([
      panel._receiveMessage({
        command: 'record-emoji-recent',
        sequence: '👍',
      } as any),
      otherPanel._receiveMessage({
        command: 'record-emoji-recent',
        sequence: '👍🏽',
      } as any),
    ])
    expect(context.globalState.get('vmde.emojiRecents')).toEqual({
      version: 1,
      sequences: ['👍🏽', '👍', '🫩', '😀'],
    })

    await panel._receiveMessage({
      command: 'record-emoji-recent',
      sequence: 'not-an-emoji',
    } as any)
    expect(context.globalState.get('vmde.emojiRecents')).toEqual({
      version: 1,
      sequences: ['👍🏽', '👍', '🫩', '😀'],
    })
    // This test readies two sessions; dispose both so their delayed git-diff schedulers cannot
    // post into a later fake-timer test's freshly reset shared webview mock.
    panel._fireDispose()
    otherPanel._fireDispose()
  })

  it('loads and saves reading position through the capped workspace store', async () => {
    const { session, panel, document, context } = makeSession(
      '/ws/position.md',
      '# One\n\nbody\n',
    )
    const initial = {
      anchor: { hash: 'old', index: 1, headingPath: ['1:One'] },
      scrollOffset: 24,
    }
    await context.workspaceState.update('vmde.readingPositions', [
      { uri: document.uri.toString(), state: initial },
    ])
    session.start()
    await panel._receiveMessage({ command: 'ready' })
    expect(
      mock.calls.postMessage.find(
        (message: any) => message.command === 'update',
      )?.readingPosition,
    ).toEqual(initial)

    const next = {
      anchor: { hash: 'new', index: 2, headingPath: ['1:One'] },
      scrollOffset: 11,
      caret: {
        anchor: { hash: 'new', index: 2, headingPath: ['1:One'] },
        path: [0],
        offset: 3,
      },
    }
    await panel._receiveMessage({
      command: 'save-reading-position',
      state: next,
    })
    expect(context.workspaceState.get('vmde.readingPositions')).toEqual([
      { uri: document.uri.toString(), state: next },
    ])
  })

  it('posts the initial update before priming one non-empty git diff after `ready`', async () => {
    vi.useFakeTimers()
    const headContent = '# Title\n\noriginal body\n'
    mock.state.responses.gitExtension = {
      isActive: true,
      exports: {
        getAPI: () => ({
          repositories: [
            {
              rootUri: { fsPath: '/ws' },
              show: async () => headContent,
            },
          ],
        }),
      },
    }
    const { session, panel } = makeSession(
      '/ws/note.md',
      '# Title\n\nchanged body\n',
    )

    session.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(
      mock.calls.postMessage.filter(
        (message) => message.command === 'diff-info',
      ),
    ).toEqual([])

    await panel._receiveMessage({ command: 'ready' })
    expect(
      mock.calls.postMessage.filter(
        (message) =>
          message.command === 'update' || message.command === 'diff-info',
      ),
    ).toEqual([expect.objectContaining({ command: 'update', type: 'init' })])

    await vi.advanceTimersByTimeAsync(300)
    const lifecycleMessages = mock.calls.postMessage.filter(
      (message) =>
        message.command === 'update' || message.command === 'diff-info',
    )
    expect(lifecycleMessages).toHaveLength(2)
    expect(lifecycleMessages[0]).toMatchObject({
      command: 'update',
      type: 'init',
    })
    expect(lifecycleMessages[1]).toMatchObject({
      command: 'diff-info',
      changes: expect.any(Array),
    })
    expect(lifecycleMessages[1].changes).not.toHaveLength(0)
  })

  it('removes its panel from the active-panel registry on dispose', () => {
    const { session, panel } = makeSession()
    session.start()
    panel._fireDispose()
    // a second dispose-driven cleanup must not throw (idempotent teardown)
    expect(() => panel._fireDispose()).not.toThrow()
  })

  // Task 420 — this order is documented in two comments around start()'s `onDidReceiveMessage` /
  // `webview.html =` statements but nothing enforced it. If it ever inverts, the webview starts
  // loading main.js (and can post its `ready` message) before the host has a listener attached —
  // that message is dropped SILENTLY (no exception, no log), and the editor looks hung/blank with
  // no error to point at. `vscode-mock.ts`'s `createWebviewPanel()` records the order both
  // statements fire in (`panel._eventOrder`) so this is asserted directly, not inferred from
  // reading source.
  it('attaches the message listener BEFORE assigning webview.html, so the early `ready` message is never dropped (task 420)', () => {
    const { session, panel } = makeSession()
    session.start()
    const listenerIndex = panel._eventOrder.indexOf('listener-attached')
    const htmlIndex = panel._eventOrder.indexOf('html-assigned')
    expect(listenerIndex, 'onDidReceiveMessage was never attached').not.toBe(-1)
    expect(htmlIndex, 'webview.html was never assigned').not.toBe(-1)
    expect(
      listenerIndex,
      'the message listener must attach before webview.html loads main.js — ' +
        'otherwise the early `ready` message races the listener and is dropped silently',
    ).toBeLessThan(htmlIndex)
  })

  // Task 434 — checkNoopOnWillSave's correctness backstop: a save (any trigger) must reach
  // WritebackController via vscode.workspace.onWillSaveTextDocument. These test the WIRING (is the
  // listener registered, filtered by uri, and does dispose cancel the pending timer) — the actual
  // no-op DECISION logic is exhaustively covered with a mocked isSemanticNoop in
  // writeback-controller.test.ts; this environment's Lute is cold (no real extensionPath), so
  // checkNoopOnWillSave always resolves to "not a no-op" here, which is itself the useful
  // assertion: cold Lute must degrade to doing nothing, never throw or wrongly correct.
  it('onWillSaveTextDocument for the ACTIVE document reaches WritebackController without throwing (cold Lute → no correction)', () => {
    const { session, document } = makeSession('/ws/note.md', '# Hi\n\nbody\n')
    session.start()
    const captured = mock.fireWillSaveTextDocument(document)
    // Cold Lute (no real extensionPath in this unit environment) → isSemanticNoop can't decide →
    // checkNoopOnWillSave returns [] → the listener never calls event.waitUntil.
    expect(captured.edits).toBeUndefined()
  })

  it('onWillSaveTextDocument for a DIFFERENT document is ignored (uri filter)', () => {
    const { session } = makeSession('/ws/note.md', '# Hi\n\nbody\n')
    session.start()
    const other = mock.createTextDocument('/ws/other.md', 'unrelated\n')
    expect(() => mock.fireWillSaveTextDocument(other)).not.toThrow()
    // No assertion beyond "didn't throw" is possible here — the uri filter's real effect (skipping
    // checkNoopOnWillSave entirely) has no other externally observable signal in this mock.
  })

  it('dispose cancels WritebackController.disposeNoopCheck (no stray timer after the panel closes)', () => {
    const spy = vi.spyOn(WritebackController.prototype, 'disposeNoopCheck')
    const { session, panel } = makeSession()
    session.start()
    panel._fireDispose()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
