import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { activate, EditorSession } from '../../src/app/extension'
import { WritebackController } from '../../src/writeback/writeback-controller'
import { HistoryCouplingController } from '../../src/writeback/history-coupling'
import {
  _resetCacheMap,
  getOrBuildCache,
  peekBuiltCache,
} from '../../src/wiki/wiki-cache'
import {
  configureWikiKeyStore,
  readStoredKeys,
} from '../../src/wiki/wiki-key-store'
import { lastWriteWinsFor } from '../../src/platform/last-write-wins'
import { createExtHostMemento } from './ext-host-memento'
import { mock } from './vscode-mock'

const seed = vi.hoisted(() => ({
  canonicalize: vi.fn(),
  prewarm: vi.fn(),
  configureCache: vi.fn(),
}))
vi.mock('../../src/lute/lute-host', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/lute/lute-host')>()
  // Task 641: observe activation's Lute load request while keeping its real behaviour.
  seed.prewarm.mockImplementation(original.prewarmLute)
  return {
    ...original,
    canonicalizeIrMarkdown: seed.canonicalize,
    prewarmLute: seed.prewarm,
    configureLuteCodeCache: seed.configureCache,
  }
})

// The whole point of the refactor: EditorSession is now an independently
// constructible unit. Give it a context, a document, a webview panel, and an HTML
// builder — no MarkdownEditorProvider, no real _getHtmlForWebview — and drive it.
// Task 657: the remembered-state helper keeps a verification timer per memento; stop every one a
// test used so a timer cannot write into a later test's shared mock state.
const usedStores = new Set<object>()
afterEach(() => {
  for (const store of usedStores) lastWriteWinsFor(store as never).dispose()
  usedStores.clear()
})

function makeSession(fsPath = '/ws/note.md', text = '# Hi\n\nbody\n') {
  mock.setWorkspaceFolder('/ws')
  const context = {
    ...mock.createExtensionContext(),
    extensionPath: process.cwd(),
    extensionUri: vscode.Uri.file(process.cwd()),
  }
  usedStores.add(context.globalState)
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

// Earlier tests leave their own applyEdit spies in place; apply the next `writes` replacements to
// `document` only, so no later test writes to this one.
function applyReplacements(
  document: ReturnType<typeof makeSession>['document'],
  writes: number,
) {
  const spy = vi.spyOn(vscode.workspace, 'applyEdit')
  for (let index = 0; index < writes; index++)
    spy.mockImplementationOnce(async (edit: any) => {
      for (const replacement of edit.replacements)
        document.__setText(replacement.content)
      return true
    })
}

function findWidgetContextValues(): unknown[] {
  return mock.calls.executeCommand
    .filter(
      ({ command, args }) =>
        command === 'setContext' && args[0] === 'vmde.findWidgetVisible',
    )
    .map(({ args }) => args[1])
}

function blockChoiceCancellations(): number[] {
  return mock.calls.postMessage
    .filter(
      (message: any) => message.command === 'cancel-block-transform-choice',
    )
    .map((message: any) => message.token)
}

describe('EditorSession (constructed directly)', () => {
  beforeEach(() => {
    mock.reset()
    seed.canonicalize.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('stores visibility per session and publishes only the active panel state', async () => {
    const first = makeSession('/ws/first.md')
    const second = makeSession('/ws/second.md')
    second.panel.active = false
    first.session.start()
    second.session.start()

    await first.panel._receiveMessage({
      command: 'find-widget-state',
      visible: true,
    })
    expect(findWidgetContextValues()).toEqual([true])
    await second.panel._receiveMessage({
      command: 'find-widget-state',
      visible: false,
    })
    expect(findWidgetContextValues()).toEqual([true])

    first.panel.active = false
    first.panel._fireViewStateChange()
    expect(findWidgetContextValues()).toEqual([true])
    second.panel.active = true
    second.panel._fireViewStateChange()
    expect(findWidgetContextValues()).toEqual([true, false])

    await second.panel._receiveMessage({
      command: 'find-widget-state',
      visible: true,
    })
    expect(findWidgetContextValues()).toEqual([true, false, true])
    second.panel.active = false
    first.panel.active = true
    first.panel._fireViewStateChange()
    expect(findWidgetContextValues()).toEqual([true, false, true, true])
  })

  it('clears visibility on ready and when the active panel is disposed', async () => {
    const { session, panel } = makeSession()
    session.start()
    await panel._receiveMessage({ command: 'find-widget-state', visible: true })
    await panel._receiveMessage({ command: 'ready' })
    expect(findWidgetContextValues()).toEqual([true, false])

    await panel._receiveMessage({ command: 'find-widget-state', visible: true })
    panel._fireDispose()
    expect(findWidgetContextValues()).toEqual([true, false, true, false])
  })

  it('does not clear the active context when an inactive panel is disposed', async () => {
    const { session, panel } = makeSession()
    panel.active = false
    session.start()
    await panel._receiveMessage({ command: 'find-widget-state', visible: true })
    panel._fireDispose()
    expect(findWidgetContextValues()).toEqual([])
  })

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

  it('applies one exact task-marker WorkspaceEdit and acknowledges it', async () => {
    const source = '- [ ] task\n'
    const { session, panel, document } = makeSession('/ws/task.md', source)
    session.start()
    const startOffset = source.indexOf('[ ]')
    const applied = vi
      .spyOn(vscode.workspace, 'applyEdit')
      .mockImplementation(async (edit: any) => {
        expect(edit.replacements).toHaveLength(1)
        const replacement = edit.replacements[0]
        const start = replacement.range.start.character
        const end = replacement.range.end.character
        document.__setText(
          source.slice(0, start) + replacement.content + source.slice(end),
        )
        return true
      })

    await panel._receiveMessage({
      command: 'toggle-preview-task-checkbox',
      requestId: 'task-toggle-1',
      source,
      startOffset,
      endOffset: startOffset + 3,
      marker: '[ ]',
      checked: true,
    })

    expect(applied).toHaveBeenCalledOnce()
    expect(applied.mock.calls[0]?.[0].replacements).toHaveLength(1)
    expect(applied.mock.calls[0]?.[0].replacements[0]).toMatchObject({
      content: '[x]',
      range: {
        start: { line: 0, character: startOffset },
        end: { line: 0, character: startOffset + 3 },
      },
    })
    expect(document.getText()).toBe('- [x] task\n')
    expect(mock.calls.postMessage).toContainEqual({
      command: 'preview-task-checkbox-outcome',
      requestId: 'task-toggle-1',
      status: 'applied',
      source: '- [x] task\n',
    })
  })

  it('posts a verified checkbox history update before its outcome, without a later ordinary update', async () => {
    vi.useFakeTimers()
    const source = '- [ ] task\n'
    const after = '- [x] task\n'
    const { session, panel, document } = makeSession(
      '/ws/task-history.md',
      source,
    )
    session.start()
    vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async () => {
      document.__setText(after)
      mock.fireDidChangeTextDocument(document)
      return true
    })

    await panel._receiveMessage({
      command: 'toggle-preview-task-checkbox',
      requestId: 'task-history-1',
      source,
      startOffset: 2,
      endOffset: 5,
      marker: '[ ]',
      checked: true,
    })
    await vi.advanceTimersByTimeAsync(200)

    const messages = mock.calls.postMessage.filter(
      (message: any) =>
        message.command === 'update' ||
        message.command === 'preview-task-checkbox-outcome',
    )
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      command: 'update',
      content: after,
      previewTaskCheckboxHistory: {
        requestId: 'task-history-1',
        before: source,
        after,
        renderedAfter: after,
      },
    })
    expect(messages[1]).toMatchObject({
      command: 'preview-task-checkbox-outcome',
      requestId: 'task-history-1',
      status: 'applied',
      source: after,
    })
  })

  it('does not report applied when WorkspaceEdit returns true without changing the document', async () => {
    const source = '- [ ] task\n'
    const { session, panel } = makeSession('/ws/task-noop.md', source)
    session.start()
    vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(true)

    await panel._receiveMessage({
      command: 'toggle-preview-task-checkbox',
      requestId: 'task-toggle-noop',
      source,
      startOffset: 2,
      endOffset: 5,
      marker: '[ ]',
      checked: true,
    })

    expect(mock.calls.postMessage).toContainEqual({
      command: 'preview-task-checkbox-outcome',
      requestId: 'task-toggle-noop',
      status: 'stale',
      source,
    })
  })

  it('rechecks document version and exact bytes immediately before WorkspaceEdit', async () => {
    const source = '- [ ] task\n'
    const newer = '- [ ] concurrent update\n'
    const { session, panel, document } = makeSession('/ws/task-race.md', source)
    session.start()
    const applied = vi.spyOn(vscode.workspace, 'applyEdit')
    applied.mockClear()
    const positionAt = document.positionAt.bind(document)
    let changed = false
    vi.spyOn(document, 'positionAt').mockImplementation((offset) => {
      const position = positionAt(offset)
      if (!changed) {
        changed = true
        document.__setText(newer)
      }
      return position
    })

    await panel._receiveMessage({
      command: 'toggle-preview-task-checkbox',
      requestId: 'task-toggle-race',
      source,
      startOffset: 2,
      endOffset: 5,
      marker: '[ ]',
      checked: true,
    })

    expect(applied).not.toHaveBeenCalled()
    expect(mock.calls.postMessage).toContainEqual({
      command: 'preview-task-checkbox-outcome',
      requestId: 'task-toggle-race',
      status: 'stale',
      source: newer,
    })
  })

  it('rejects stale snapshots and read-only filesystems without applying an edit', async () => {
    const source = '- [ ] task\n'
    const { session, panel, document } = makeSession('/ws/task.md', source)
    session.start()
    const applied = vi.spyOn(vscode.workspace, 'applyEdit')
    applied.mockClear()

    document.__setText('- [ ] externally changed task\n')
    await panel._receiveMessage({
      command: 'toggle-preview-task-checkbox',
      requestId: 'task-toggle-stale',
      source,
      startOffset: 2,
      endOffset: 5,
      marker: '[ ]',
      checked: true,
    })
    expect(applied).not.toHaveBeenCalled()
    expect(mock.calls.postMessage).toContainEqual({
      command: 'preview-task-checkbox-outcome',
      requestId: 'task-toggle-stale',
      status: 'stale',
      source: '- [ ] externally changed task\n',
    })

    mock.setWritableFileSystem('file', false)
    const readonlySource = document.getText()
    await panel._receiveMessage({
      command: 'toggle-preview-task-checkbox',
      requestId: 'task-toggle-readonly',
      source: readonlySource,
      startOffset: readonlySource.indexOf('[ ]'),
      endOffset: readonlySource.indexOf('[ ]') + 3,
      marker: '[ ]',
      checked: true,
    })
    expect(applied).not.toHaveBeenCalled()
    expect(mock.calls.postMessage).toContainEqual({
      command: 'preview-task-checkbox-outcome',
      requestId: 'task-toggle-readonly',
      status: 'disabled',
      source: '- [ ] externally changed task\n',
    })
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
    await panel._receiveMessage({
      command: 'copy-link-url',
      href: 'https://example.com/copied',
    })
    mock.fireDidSaveTextDocument(document)

    expect(mock.calls.clipboard).toContain('https://example.com/copied')
    expect(mock.calls.postMessage).toContainEqual({
      command: 'announce',
      message: 'Copied URL',
    })
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

  // Task 602: one webview step over two host writes walks native history to the webview result.
  it('walks native undo across two host writes that one webview step spans', async () => {
    const { session, panel, document } = makeSession(
      '/ws/history-walk.md',
      'base\n',
    )
    const texts = ['base\n']
    session.start()
    applyReplacements(document, 2)
    for (const content of ['baseX\n', 'baseXQ\n']) {
      await panel._receiveMessage({ command: 'edit', content })
      await (session as any).editMessageChain
      texts.push(document.getText())
    }
    expect(texts).toEqual(['base\n', 'baseX\n', 'baseXQ\n'])
    const redo: string[] = []
    mock.setExecuteCommandResponse((command) => {
      if (command !== 'undo' || texts.length < 2) return
      redo.push(texts.pop() as string)
      document.__setText(texts.at(-1) as string)
    })

    await panel._receiveMessage({
      command: 'history-transition',
      kind: 'undo',
      before: 'baseXQ\n',
      after: 'base\n',
    })

    expect(document.getText()).toBe('base\n')
    expect(
      mock.calls.executeCommand.filter(({ command }) => command === 'undo'),
    ).toHaveLength(2)
  })

  it('records the host text VMDE wrote for each published edit', async () => {
    const record = vi.spyOn(
      HistoryCouplingController.prototype,
      'recordPublished',
    )
    try {
      const { session, panel, document } = makeSession(
        '/ws/history-published.md',
        'base\n',
      )
      session.start()
      applyReplacements(document, 1)
      await panel._receiveMessage({ command: 'edit', content: 'baseX\n' })
      await (session as any).editMessageChain
      expect(document.getText()).toBe('baseX\n')
      expect(record).toHaveBeenCalledExactlyOnceWith(
        'baseX\n',
        document.getText(),
      )
    } finally {
      record.mockRestore()
    }
  })

  it('pairs a history base with the host text only while the webview holds it', async () => {
    vi.useFakeTimers()
    const recordBase = vi.spyOn(
      HistoryCouplingController.prototype,
      'recordBase',
    )
    const forget = vi.spyOn(
      HistoryCouplingController.prototype,
      'forgetHostMappings',
    )
    try {
      const { session, panel, document } = makeSession(
        '/ws/history-base.md',
        '-   item\n',
      )
      session.start()
      await panel._receiveMessage({
        command: 'history-base',
        mode: 'ir',
        content: '* item\n',
      })
      await (session as any).editMessageChain
      expect(recordBase).toHaveBeenLastCalledWith(
        'ir',
        '* item\n',
        '-   item\n',
      )

      // A dirty-state event (after a save) changes no text and keeps the mappings.
      mock.fireDidChangeTextDocument(document, { contentChanges: [] })
      expect(forget).not.toHaveBeenCalled()
      // An external change the webview has not received yet cannot be paired.
      document.__setText('-   item\n\nexternal\n')
      mock.fireDidChangeTextDocument(document)
      expect(forget).toHaveBeenCalledOnce()
      await panel._receiveMessage({
        command: 'history-base',
        mode: 'sv',
        content: '* item\n',
      })
      await (session as any).editMessageChain
      expect(recordBase).toHaveBeenLastCalledWith('sv', '* item\n', undefined)
    } finally {
      recordBase.mockRestore()
      forget.mockRestore()
    }
  })

  it.each([
    { label: 'plain', fields: {}, plain: true },
    {
      label: 'false flags',
      fields: { exact: false, explicitBlock: '', rewrapDocument: false },
      plain: true,
    },
    { label: 'exact', fields: { exact: true }, plain: false },
    {
      label: 'explicit block',
      fields: { explicitBlock: 'host baseline\n' },
      plain: false,
    },
    { label: 'rewrap', fields: { rewrapDocument: true }, plain: false },
  ])(
    'classifies a $label edit before history echo consumption',
    async ({ fields, plain }) => {
      const consume = vi
        .spyOn(HistoryCouplingController.prototype, 'consumeEdit')
        .mockResolvedValue(true)
      try {
        const { session, panel } = makeSession(
          '/ws/history-flags.md',
          'host baseline\n',
        )
        session.start()
        await panel._receiveMessage({
          command: 'edit',
          content: 'host baseline\n',
          ...fields,
        })
        expect(consume).toHaveBeenCalledExactlyOnceWith(
          'host baseline\n',
          plain,
        )
      } finally {
        consume.mockRestore()
      }
    },
  )

  it('asks once for lossy Turn Into consent and never applies a canceled choice', async () => {
    const { session, panel } = makeSession('/ws/turn.md', 'alpha\n')
    session.start()
    mock.setQuickPickResponse({ type: 'fence' })
    const options = {
      command: 'block-transform-options',
      token: 41,
      currentType: 'paragraph',
      targets: [
        {
          type: 'fence',
          status: 'confirm-required',
          losses: ['markdown-becomes-literal'],
        },
      ],
    }
    mock.setWarningResponse(undefined)
    await panel._receiveMessage(options)
    expect(mock.calls.showWarning).toHaveLength(1)
    expect(mock.calls.showWarning[0].message).toContain('literal')
    expect(blockChoiceCancellations()).toEqual([41])
    expect(mock.calls.postMessage).not.toContainEqual(
      expect.objectContaining({ command: 'apply-block-transform-choice' }),
    )
    mock.setWarningResponse('Turn Into')
    await panel._receiveMessage({
      ...options,
      token: 42,
      targets: [
        {
          type: 'fence',
          status: 'confirm-required',
          losses: ['markdown-becomes-literal', 'markdown-becomes-literal'],
        },
      ],
    })
    expect(mock.calls.showWarning.at(-1)?.message).toContain('in 2 blocks')
    expect(mock.calls.postMessage).toContainEqual({
      command: 'apply-block-transform-choice',
      token: 42,
      target: { type: 'fence' },
      confirmed: true,
    })
    expect(blockChoiceCancellations()).toEqual([41])
  })

  it.each([
    {
      label: 'inactive panel',
      active: false,
      currentType: 'paragraph',
      targets: [{ type: 'h2', status: 'changed', losses: [] }],
    },
    {
      label: 'invalid current type',
      active: true,
      currentType: 'invalid',
      targets: [{ type: 'h2', status: 'changed', losses: [] }],
    },
    {
      label: 'empty options',
      active: true,
      currentType: 'paragraph',
      targets: [],
    },
    {
      label: 'filtered options',
      active: true,
      currentType: 'paragraph',
      targets: [{ type: 'h2', status: 'unsupported', losses: [] }],
    },
  ])(
    'cancels one validated Turn Into token for $label',
    async ({ active, currentType, targets }) => {
      const { session, panel } = makeSession()
      session.start()
      panel.active = active
      await panel._receiveMessage({
        command: 'block-transform-options',
        token: 61,
        currentType,
        targets,
      })
      expect(blockChoiceCancellations()).toEqual([61])
      expect(mock.calls.showQuickPick).toHaveLength(0)
    },
  )

  it.each([
    { label: 'Escape or focus loss', response: undefined, status: 'changed' },
    {
      label: 'unoffered choice',
      response: { type: 'bullet' },
      status: 'changed',
    },
    { label: 'no-op choice', response: { type: 'h2' }, status: 'noop' },
  ])(
    'cancels one Turn Into token when the picker returns $label',
    async ({ response, status }) => {
      const { session, panel } = makeSession()
      session.start()
      mock.setQuickPickResponse(response)
      await panel._receiveMessage({
        command: 'block-transform-options',
        token: 62,
        currentType: 'paragraph',
        targets: [{ type: 'h2', status, losses: [] }],
      })
      expect(blockChoiceCancellations()).toEqual([62])
    },
  )

  it.each([
    {
      label: 'inactive panel',
      active: false,
      target: { type: 'h2' },
      status: 'changed',
      losses: [],
    },
    {
      label: 'invalid target',
      active: true,
      target: { type: 'invalid' },
      status: 'changed',
      losses: [],
    },
    {
      label: 'invalid status',
      active: true,
      target: { type: 'h2' },
      status: 'noop',
      losses: [],
    },
    {
      label: 'invalid language target',
      active: true,
      target: { type: 'h2' },
      status: 'edit-language',
      losses: [],
    },
    {
      label: 'invalid losses',
      active: true,
      target: { type: 'h2' },
      status: 'changed',
      losses: ['invalid'],
    },
    {
      label: 'malformed losses',
      active: true,
      target: { type: 'h2' },
      status: 'changed',
      losses: null,
    },
  ])(
    'cancels one validated Turn Into consent token for $label',
    async ({ active, target, status, losses }) => {
      const { session, panel } = makeSession()
      session.start()
      panel.active = active
      await panel._receiveMessage({
        command: 'block-transform-consent',
        token: 63,
        target,
        status,
        losses,
      })
      expect(blockChoiceCancellations()).toEqual([63])
      expect(mock.calls.postMessage).not.toContainEqual(
        expect.objectContaining({ command: 'apply-block-transform-choice' }),
      )
    },
  )

  it('does not post a cancel for a token that failed validation', async () => {
    const { session, panel } = makeSession()
    session.start()
    await panel._receiveMessage({
      command: 'block-transform-options',
      token: 0,
      currentType: 'paragraph',
      targets: [],
    })
    await panel._receiveMessage({
      command: 'block-transform-consent',
      token: -1,
      target: { type: 'h2' },
      status: 'changed',
      losses: [],
    })
    expect(blockChoiceCancellations()).toEqual([])
  })

  it('cancels the delegated picker choice once when language input is dismissed', async () => {
    const { session, panel } = makeSession()
    session.start()
    mock.setQuickPickResponse({ type: 'fence' })
    mock.setInputBoxResponse(undefined)
    await panel._receiveMessage({
      command: 'block-transform-options',
      token: 64,
      currentType: 'fence',
      fenceLanguage: 'js',
      targets: [{ type: 'fence', status: 'noop', losses: [] }],
    })
    expect(blockChoiceCancellations()).toEqual([64])
  })

  it('cancels a picker choice when the host document changes while it is open', async () => {
    const { session, panel, document } = makeSession(
      '/ws/turn-picker.md',
      'alpha\n',
    )
    session.start()
    let choose: ((value: { type: string }) => void) | undefined
    const showQuickPick = vi
      .spyOn(vscode.window, 'showQuickPick')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            choose = resolve as (value: { type: string }) => void
          }),
      )
    try {
      const pending = panel._receiveMessage({
        command: 'block-transform-options',
        token: 65,
        currentType: 'paragraph',
        targets: [{ type: 'h2', status: 'changed', losses: [] }],
      })
      await vi.waitFor(() => expect(choose).toBeDefined())
      document.__setText('external edit\n')
      choose!({ type: 'h2' })
      await pending
      expect(blockChoiceCancellations()).toEqual([65])
      expect(mock.calls.postMessage).not.toContainEqual(
        expect.objectContaining({ command: 'apply-block-transform-choice' }),
      )
    } finally {
      showQuickPick.mockRestore()
    }
  })

  it('edits a same-type code fence language through one native input and guarded choice', async () => {
    const { session, panel } = makeSession(
      '/ws/fence-language.md',
      '```js\nalpha\n```\n',
    )
    session.start()
    mock.setQuickPickResponse({ type: 'fence' })
    mock.setInputBoxResponse('ts')
    await panel._receiveMessage({
      command: 'block-transform-options',
      token: 52,
      currentType: 'fence',
      fenceLanguage: 'js',
      targets: [{ type: 'fence', status: 'noop', losses: [] }],
    })
    expect(mock.calls.showInputBox).toContainEqual(
      expect.objectContaining({ value: 'js' }),
    )
    expect(mock.calls.postMessage).toContainEqual({
      command: 'apply-block-transform-choice',
      token: 52,
      target: { type: 'fence', language: 'ts' },
      confirmed: false,
    })
  })

  it('shows Mixed without a current-type checkmark and keeps one chosen host route', async () => {
    const { session, panel } = makeSession(
      '/ws/mixed.md',
      '## title\n\nplain\n',
    )
    session.start()
    mock.setQuickPickResponse({ type: 'h2' })
    await panel._receiveMessage({
      command: 'block-transform-options',
      token: 53,
      currentType: 'mixed',
      targets: [{ type: 'h2', status: 'changed', losses: [] }],
    })
    expect(mock.calls.showQuickPick.at(-1)).toEqual([
      expect.objectContaining({ label: 'Heading 2' }),
    ])
    expect(mock.calls.postMessage).toContainEqual({
      command: 'apply-block-transform-choice',
      token: 53,
      target: { type: 'h2', language: undefined },
      confirmed: false,
    })
  })

  it('drops a Turn Into choice when the host document changes during warning consent', async () => {
    const { session, panel, document } = makeSession(
      '/ws/turn-stale.md',
      'alpha\n',
    )
    session.start()
    let consent: ((value: string) => void) | undefined
    vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(
      () =>
        new Promise((resolve) => {
          consent = resolve as (value: string) => void
        }),
    )
    const pending = panel._receiveMessage({
      command: 'block-transform-consent',
      token: 43,
      target: { type: 'fence' },
      status: 'confirm-required',
      losses: ['markdown-becomes-literal'],
    })
    await vi.waitFor(() => expect(consent).toBeDefined())
    document.__setText('external edit\n')
    consent!('Turn Into')
    await pending
    expect(blockChoiceCancellations()).toEqual([43])
    expect(mock.calls.postMessage).not.toContainEqual(
      expect.objectContaining({ command: 'apply-block-transform-choice' }),
    )
  })

  // Task 641 (fix 2): `init` is posted before the full-document seed is computed; the seed
  // follows in its own message. (Before Task 641 it rode inside `init` and held it back.)
  it('posts init before computing the seed and sends the seed in its own message after it', async () => {
    vi.useFakeTimers()
    const content = Array.from(
      { length: 700 },
      (_, index) => `paragraph ${index}`,
    ).join('\n\n')
    const order: string[] = []
    seed.canonicalize.mockImplementation(() => {
      order.push('seed computed')
      return 'CANONICAL\n'
    })
    const { session, panel } = makeSession('/ws/complex.md', content)
    panel.webview.postMessage.mockImplementation((message: any) => {
      mock.calls.postMessage.push(message)
      if (
        message.command === 'update' ||
        message.command === 'incremental-seed'
      )
        order.push(message.type ? `${message.type} posted` : message.command)
      return Promise.resolve(true)
    })
    session.start()
    await panel._receiveMessage({ command: 'ready' })
    const init = mock.calls.postMessage.find(
      (message: any) => message.command === 'update' && message.type === 'init',
    )

    expect(order).toEqual(['init posted'])
    expect(init.incrementalSeed).toBeUndefined()

    await vi.runOnlyPendingTimersAsync()
    expect(order).toEqual(['init posted', 'seed computed', 'incremental-seed'])
    expect(seed.canonicalize).toHaveBeenCalledTimes(1)
    const late = mock.calls.postMessage.find(
      (message: any) => message.command === 'incremental-seed',
    )
    expect(late.content).toBe(init.content)
    expect(late.seed).toMatchObject({
      markdown: 'CANONICAL\n',
      reason: 'source-blocks',
      source: { blockHints: 700 },
    })
  })

  // Task 641 (fix 2, edge case): a seed computed for an older document version is never posted.
  it('drops the deferred seed when the document changes before it is computed', async () => {
    vi.useFakeTimers()
    const content = Array.from(
      { length: 700 },
      (_, index) => `paragraph ${index}`,
    ).join('\n\n')
    seed.canonicalize.mockReturnValue('CANONICAL\n')
    const { session, panel, document } = makeSession(
      '/ws/complex-stale.md',
      content,
    )
    session.start()
    await panel._receiveMessage({ command: 'ready' })
    document.__setText(`${content}\n\nexternal paragraph`)

    await vi.runOnlyPendingTimersAsync()
    expect(seed.canonicalize).not.toHaveBeenCalled()
    expect(mock.calls.postMessage).not.toContainEqual(
      expect.objectContaining({ command: 'incremental-seed' }),
    )
  })

  // Task 641 (fix 4): activation asks for the host Lute load without running it inside activate,
  // and the editor resolve (inline init included) never runs a full-document Lute pass, so it
  // never pays a first Lute load either.
  it('starts the Lute load at activation and resolves an eligible editor without a fresh load', () => {
    const context = {
      ...mock.createExtensionContext(),
      extensionPath: process.cwd(),
      globalStorageUri: vscode.Uri.file('/global-storage/vmde'),
    }
    seed.prewarm.mockClear()
    seed.configureCache.mockClear()
    activate(context as any)
    expect(seed.prewarm).toHaveBeenCalledWith(process.cwd())
    // Task 641 fix 4: the code cache lives only in the extension's global storage.
    expect(seed.configureCache).toHaveBeenCalledTimes(1)
    expect(seed.configureCache.mock.calls[0][0]).toBe(
      context.globalStorageUri.fsPath,
    )
    expect(seed.configureCache.mock.invocationCallOrder[0]).toBeLessThan(
      seed.prewarm.mock.invocationCallOrder[0],
    )

    const content = Array.from(
      { length: 700 },
      (_, index) => `paragraph ${index}`,
    ).join('\n\n')
    const { session, panel } = makeSession('/ws/complex-inline.md', content)
    mock.setConfig({ enabled: false }) // not a wiki file, so the init is inlined into the HTML
    session.start()
    expect(panel.webview.html).toContain('id="app"')
    expect(seed.canonicalize).not.toHaveBeenCalled()
    const inline = JSON.parse(
      (session as any).inlineInitPayload(content) as string,
    )
    expect(inline.content).toBe(content)
    expect(inline.incrementalSeed).toBeUndefined()
    expect(seed.canonicalize).not.toHaveBeenCalled()
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

  // Task 631 F2 (Owner, 2026-10-15): "collapsing state of toolbar must be remembered through VSCode
  // sessions" and "All files receive the same toolbar collapsing state" - one host-owned value.
  describe('toolbar collapsed state (Task 631 F2)', () => {
    const collapsedPosts = (panel: ReturnType<typeof makeSession>['panel']) =>
      panel.webview.postMessage.mock.calls
        .map((call: unknown[]) => call[0] as { command: string })
        .filter((message) => message.command === 'toolbar-collapsed')
    const initOf = (panel: ReturnType<typeof makeSession>['panel']) =>
      panel.webview.postMessage.mock.calls
        .map((call: unknown[]) => call[0] as any)
        .find(
          (message) => message.command === 'update' && message.type === 'init',
        )

    it('puts the stored value into the initial state of the panel (reopened VS Code)', async () => {
      const { session, panel, context } = makeSession('/ws/a.md', 'a\n')
      await context.globalState.update('vmde.toolbarCollapsed', true)
      session.start()
      await panel._receiveMessage({ command: 'ready' })
      expect(initOf(panel).toolbarCollapsed).toBe(true)
      panel._fireDispose()
    })

    it('puts the stored value into the inlined first-paint payload as well', async () => {
      const { session, context, panel } = makeSession('/ws/a2.md', 'a\n')
      mock.setConfig({ enabled: false }) // a wiki file keeps the ready/init round trip instead
      await context.globalState.update('vmde.toolbarCollapsed', true)
      session.start()
      const payload = JSON.parse(
        (session as any).inlineInitPayload('a\n') as string,
      )
      expect(payload.toolbarCollapsed).toBe(true)
      await context.globalState.update('vmde.toolbarCollapsed', false)
      expect(
        JSON.parse((session as any).inlineInitPayload('a\n') as string)
          .toolbarCollapsed,
      ).toBe(false)
      panel._fireDispose()
    })

    it.each([
      ['absent', undefined],
      ['null', null],
      ['a string', 'true'],
      ['a number', 1],
      ['an object', { collapsed: true }],
    ])('opens expanded when the stored value is %s', async (_name, stored) => {
      const { session, panel, context } = makeSession('/ws/b.md', 'b\n')
      await context.globalState.update('vmde.toolbarCollapsed', stored)
      session.start()
      await panel._receiveMessage({ command: 'ready' })
      expect(initOf(panel).toolbarCollapsed).toBe(false)
      panel._fireDispose()
    })

    it('stores a toggle and tells the other ready editors but not the sender', async () => {
      const { session, panel, context } = makeSession('/ws/c1.md', 'c1\n')
      const { session: other, panel: otherPanel } = makeSession(
        '/ws/c2.md',
        'c2\n',
      )
      const { session: loading, panel: loadingPanel } = makeSession(
        '/ws/c3.md',
        'c3\n',
      )
      session.start()
      other.start()
      loading.start() // never sent `ready`: its init will read the stored value instead
      await panel._receiveMessage({ command: 'ready' })
      await otherPanel._receiveMessage({ command: 'ready' })

      await panel._receiveMessage({
        command: 'save-toolbar-collapsed',
        collapsed: true,
      })
      expect(context.globalState.get('vmde.toolbarCollapsed')).toBe(true)
      expect(collapsedPosts(otherPanel)).toEqual([
        { command: 'toolbar-collapsed', collapsed: true },
      ])
      expect(collapsedPosts(panel)).toEqual([])
      expect(collapsedPosts(loadingPanel)).toEqual([])

      await otherPanel._receiveMessage({
        command: 'save-toolbar-collapsed',
        collapsed: false,
      })
      expect(context.globalState.get('vmde.toolbarCollapsed')).toBe(false)
      expect(collapsedPosts(panel)).toEqual([
        { command: 'toolbar-collapsed', collapsed: false },
      ])
      expect(collapsedPosts(otherPanel)).toHaveLength(1)

      // The loading editor reads the toggled value when it becomes ready.
      await panel._receiveMessage({
        command: 'save-toolbar-collapsed',
        collapsed: true,
      })
      await loadingPanel._receiveMessage({ command: 'ready' })
      expect(initOf(loadingPanel).toolbarCollapsed).toBe(true)
      for (const p of [panel, otherPanel, loadingPanel]) p._fireDispose()
    })

    it('tells the other editors without waiting for the storage write to be acknowledged', async () => {
      const { session, panel, context } = makeSession('/ws/g1.md', 'g1\n')
      const { session: other, panel: otherPanel } = makeSession(
        '/ws/g2.md',
        'g2\n',
      )
      session.start()
      other.start()
      await panel._receiveMessage({ command: 'ready' })
      await otherPanel._receiveMessage({ command: 'ready' })
      // A write whose acknowledgement never arrives (VS Code settles it only after its own flush).
      vi.mocked(context.globalState.update).mockImplementationOnce(
        () => new Promise<void>(() => undefined),
      )

      void panel._receiveMessage({
        command: 'save-toolbar-collapsed',
        collapsed: true,
      })
      await Promise.resolve()

      expect(collapsedPosts(otherPanel)).toEqual([
        { command: 'toolbar-collapsed', collapsed: true },
      ])
      panel._fireDispose()
      otherPanel._fireDispose()
    })

    it('an editor whose webview is already disposed does not stop the others from following', async () => {
      const { session: stale, panel: stalePanel } = makeSession(
        '/ws/h0.md',
        'h0\n',
      )
      const { session, panel } = makeSession('/ws/h1.md', 'h1\n')
      const { session: other, panel: otherPanel } = makeSession(
        '/ws/h2.md',
        'h2\n',
      )
      // The stale entry registers first, so it comes first in the registry; its post throws the
      // way VS Code's does for a disposed webview.
      stale.start()
      session.start()
      other.start()
      await stalePanel._receiveMessage({ command: 'ready' })
      await panel._receiveMessage({ command: 'ready' })
      await otherPanel._receiveMessage({ command: 'ready' })
      stalePanel.webview.postMessage.mockImplementation(() => {
        throw new Error('Webview is disposed')
      })

      await panel._receiveMessage({
        command: 'save-toolbar-collapsed',
        collapsed: true,
      })

      expect(collapsedPosts(otherPanel)).toEqual([
        { command: 'toolbar-collapsed', collapsed: true },
      ])
      panel._fireDispose()
      otherPanel._fireDispose()
      stalePanel._fireDispose()
    })

    it('a different file opened after a toggle starts in the toggled state', async () => {
      const first = makeSession('/ws/d1.md', 'd1\n')
      first.session.start()
      await first.panel._receiveMessage({ command: 'ready' })
      await first.panel._receiveMessage({
        command: 'save-toolbar-collapsed',
        collapsed: true,
      })
      first.panel._fireDispose()

      const second = makeSession('/ws/sub/d2.md', 'd2\n')
      second.session.start()
      await second.panel._receiveMessage({ command: 'ready' })
      expect(initOf(second.panel).toolbarCollapsed).toBe(true)
      second.panel._fireDispose()
    })

    it('ignores a malformed toggle: nothing stored, nothing broadcast', async () => {
      const { session, panel, context } = makeSession('/ws/e1.md', 'e1\n')
      const { session: other, panel: otherPanel } = makeSession(
        '/ws/e2.md',
        'e2\n',
      )
      session.start()
      other.start()
      await panel._receiveMessage({ command: 'ready' })
      await otherPanel._receiveMessage({ command: 'ready' })
      await panel._receiveMessage({
        command: 'save-toolbar-collapsed',
        collapsed: 'yes',
      } as any)
      await panel._receiveMessage({ command: 'save-toolbar-collapsed' } as any)
      expect(context.globalState.get('vmde.toolbarCollapsed')).toBeUndefined()
      expect(collapsedPosts(otherPanel)).toEqual([])
      panel._fireDispose()
      otherPanel._fireDispose()
    })

    it('a closed editor stops receiving state messages', async () => {
      const { session, panel } = makeSession('/ws/f1.md', 'f1\n')
      const { session: other, panel: otherPanel } = makeSession(
        '/ws/f2.md',
        'f2\n',
      )
      session.start()
      other.start()
      await panel._receiveMessage({ command: 'ready' })
      await otherPanel._receiveMessage({ command: 'ready' })
      otherPanel._fireDispose()
      await panel._receiveMessage({
        command: 'save-toolbar-collapsed',
        collapsed: true,
      })
      expect(collapsedPosts(otherPanel)).toEqual([])
      panel._fireDispose()
    })
  })

  // Task 651 (acceptance 1, 3, 4): the Preview toggle is a profile-local flag read at editor open;
  // the host never pushes it to open editors.
  describe('remembered Preview state (Task 651)', () => {
    const initOf = (panel: ReturnType<typeof makeSession>['panel']) =>
      panel.webview.postMessage.mock.calls
        .map((call: unknown[]) => call[0] as any)
        .find(
          (message) => message.command === 'update' && message.type === 'init',
        )

    it('puts openInPreview into the init post when the stored flag is on and no mode applies', async () => {
      const { session, panel, context } = makeSession('/ws/p1.md', 'p\n')
      await context.globalState.update('vmde.previewOn', true)
      session.start()
      await panel._receiveMessage({ command: 'ready' })
      expect(initOf(panel).options.openInPreview).toBe(true)
      panel._fireDispose()
    })

    it('puts openInPreview into the inlined first-paint payload as well, and drops it when off', async () => {
      const { session, panel, context } = makeSession('/ws/p2.md', 'p\n')
      mock.setConfig({ enabled: false })
      await context.globalState.update('vmde.previewOn', true)
      session.start()
      expect(
        JSON.parse((session as any).inlineInitPayload('p\n') as string).options
          .openInPreview,
      ).toBe(true)
      await context.globalState.update('vmde.previewOn', false)
      const off = JSON.parse(
        (session as any).inlineInitPayload('p\n') as string,
      )
      expect('openInPreview' in off.options).toBe(false)
      panel._fireDispose()
    })

    it.each([
      ['absent', undefined],
      ['null', null],
      ['a string', 'true'],
      ['a number', 1],
      ['an object', { on: true }],
    ])('omits the flag when the stored value is %s', async (_name, stored) => {
      const { session, panel, context } = makeSession('/ws/p3.md', 'p\n')
      await context.globalState.update('vmde.previewOn', stored)
      session.start()
      await panel._receiveMessage({ command: 'ready' })
      expect('openInPreview' in initOf(panel).options).toBe(false)
      panel._fireDispose()
    })

    it.each(['ir', 'wysiwyg', 'sv', 'preview'])(
      'omits the flag when the setting is %s even with the flag stored on',
      async (setting) => {
        const { session, panel, context } = makeSession('/ws/p4.md', 'p\n')
        mock.setConfig({ 'editor.defaultMode': setting })
        await context.globalState.update('vmde.previewOn', true)
        session.start()
        await panel._receiveMessage({ command: 'ready' })
        expect('openInPreview' in initOf(panel).options).toBe(false)
        panel._fireDispose()
      },
    )

    it('omits the flag when a path rule matches, and a saved option cannot shadow it', async () => {
      const { session, panel, context } = makeSession('/ws/p5.md', 'p\n')
      mock.setConfig({
        'editor.defaultMode': 'remember',
        'editor.defaultModeByGlob': { '**/*.md': 'ir' },
      })
      await context.globalState.update('vmde.previewOn', true)
      session.start()
      await panel._receiveMessage({ command: 'ready' })
      expect('openInPreview' in initOf(panel).options).toBe(false)
      panel._fireDispose()

      const second = makeSession('/ws/p6.md', 'p\n')
      mock.setConfig({ 'editor.defaultModeByGlob': undefined })
      await second.context.globalState.update('vmde.previewOn', true)
      await second.context.globalState.update('vmde.options', {
        openInPreview: false,
      })
      second.session.start()
      await second.panel._receiveMessage({ command: 'ready' })
      expect(initOf(second.panel).options.openInPreview).toBe(true)
      second.panel._fireDispose()
    })

    it('stores a toggle, posts nothing to the sender or other editors, and a later file reads it', async () => {
      const { session, panel, context } = makeSession('/ws/p7.md', 'p7\n')
      const { session: other, panel: otherPanel } = makeSession(
        '/ws/p8.md',
        'p8\n',
      )
      session.start()
      other.start()
      await panel._receiveMessage({ command: 'ready' })
      await otherPanel._receiveMessage({ command: 'ready' })
      const senderBefore = panel.webview.postMessage.mock.calls.length
      const otherBefore = otherPanel.webview.postMessage.mock.calls.length

      await panel._receiveMessage({ command: 'save-preview-state', on: true })

      expect(context.globalState.get('vmde.previewOn')).toBe(true)
      expect(panel.webview.postMessage.mock.calls.length).toBe(senderBefore)
      expect(otherPanel.webview.postMessage.mock.calls.length).toBe(otherBefore)

      const later = makeSession('/ws/sub/p9.md', 'p9\n')
      later.session.start()
      await later.panel._receiveMessage({ command: 'ready' })
      expect(initOf(later.panel).options.openInPreview).toBe(true)

      await panel._receiveMessage({ command: 'save-preview-state', on: false })
      expect(context.globalState.get('vmde.previewOn')).toBe(false)
      for (const p of [panel, otherPanel, later.panel]) p._fireDispose()
    })

    it('ignores a malformed toggle: nothing stored', async () => {
      const { session, panel, context } = makeSession('/ws/p10.md', 'p\n')
      session.start()
      await panel._receiveMessage({ command: 'ready' })
      await panel._receiveMessage({
        command: 'save-preview-state',
        on: 'yes',
      } as any)
      await panel._receiveMessage({ command: 'save-preview-state' } as any)
      expect(context.globalState.get('vmde.previewOn')).toBeUndefined()
      panel._fireDispose()
    })
  })

  // Task 650 (acceptance: remembered Outline open state and width, host side): the open flag is a
  // profile-local boolean read at editor open; the width stays the synced key but only a positive
  // finite number is stored or used. Nothing is pushed to open editors.
  describe('remembered Outline state (Task 650)', () => {
    const initOf = (panel: ReturnType<typeof makeSession>['panel']) =>
      panel.webview.postMessage.mock.calls
        .map((call: unknown[]) => call[0] as any)
        .find(
          (message) => message.command === 'update' && message.type === 'init',
        )

    it.each([true, false])(
      'puts outlineOpen=%s into the init post and the inlined first-paint payload',
      async (stored) => {
        const { session, panel, context } = makeSession('/ws/o1.md', 'o\n')
        mock.setConfig({ enabled: false })
        await context.globalState.update('vmde.outlineOpen', stored)
        session.start()
        expect(
          JSON.parse((session as any).inlineInitPayload('o\n') as string)
            .options.outlineOpen,
        ).toBe(stored)
        await panel._receiveMessage({ command: 'ready' })
        expect(initOf(panel).options.outlineOpen).toBe(stored)
        panel._fireDispose()
      },
    )

    it.each([
      ['absent', undefined],
      ['null', null],
      ['a string', 'true'],
      ['a number', 1],
      ['an object', { open: true }],
    ])('omits outlineOpen when the stored value is %s', async (_n, stored) => {
      const { session, panel, context } = makeSession('/ws/o2.md', 'o\n')
      await context.globalState.update('vmde.outlineOpen', stored)
      session.start()
      await panel._receiveMessage({ command: 'ready' })
      expect('outlineOpen' in initOf(panel).options).toBe(false)
      panel._fireDispose()
    })

    it('stores a toggle, posts nothing to the sender or another editor, and a later file reads it', async () => {
      const { session, panel, context } = makeSession('/ws/o3.md', 'o3\n')
      const { session: other, panel: otherPanel } = makeSession(
        '/ws/o4.md',
        'o4\n',
      )
      session.start()
      other.start()
      await panel._receiveMessage({ command: 'ready' })
      await otherPanel._receiveMessage({ command: 'ready' })
      const senderBefore = panel.webview.postMessage.mock.calls.length
      const otherBefore = otherPanel.webview.postMessage.mock.calls.length

      await panel._receiveMessage({ command: 'save-outline-open', open: true })

      expect(context.globalState.get('vmde.outlineOpen')).toBe(true)
      expect(panel.webview.postMessage.mock.calls.length).toBe(senderBefore)
      expect(otherPanel.webview.postMessage.mock.calls.length).toBe(otherBefore)

      const later = makeSession('/ws/sub/o5.md', 'o5\n')
      later.session.start()
      await later.panel._receiveMessage({ command: 'ready' })
      expect(initOf(later.panel).options.outlineOpen).toBe(true)

      await panel._receiveMessage({ command: 'save-outline-open', open: false })
      expect(context.globalState.get('vmde.outlineOpen')).toBe(false)
      for (const p of [panel, otherPanel, later.panel]) p._fireDispose()
    })

    it('ignores a malformed save-outline-open: nothing stored', async () => {
      const { session, panel, context } = makeSession('/ws/o6.md', 'o\n')
      session.start()
      await panel._receiveMessage({ command: 'ready' })
      await panel._receiveMessage({
        command: 'save-outline-open',
        open: 'yes',
      } as any)
      await panel._receiveMessage({ command: 'save-outline-open' } as any)
      expect(context.globalState.get('vmde.outlineOpen')).toBeUndefined()
      panel._fireDispose()
    })

    it.each([
      ['negative', -5],
      ['zero', 0],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('stores no save-outline-width of %s', async (_n, width) => {
      const { session, panel, context } = makeSession('/ws/o7.md', 'o\n')
      session.start()
      await panel._receiveMessage({ command: 'ready' })
      await panel._receiveMessage({ command: 'save-outline-width', width })
      expect(context.globalState.get('vmde.outlineWidth')).toBeUndefined()
      panel._fireDispose()
    })

    it('still stores a positive finite save-outline-width', async () => {
      const { session, panel, context } = makeSession('/ws/o8.md', 'o\n')
      session.start()
      await panel._receiveMessage({ command: 'ready' })
      await panel._receiveMessage({ command: 'save-outline-width', width: 320 })
      expect(context.globalState.get('vmde.outlineWidth')).toBe(320)
      panel._fireDispose()
    })

    it.each([
      ['negative', -5],
      ['zero', 0],
      ['a string', '320'],
      ['NaN', Number.NaN],
    ])('omits a stored %s width from the init options', async (_n, stored) => {
      const { session, panel, context } = makeSession('/ws/o9.md', 'o\n')
      await context.globalState.update('vmde.outlineWidth', stored)
      session.start()
      await panel._receiveMessage({ command: 'ready' })
      expect('outlineWidth' in initOf(panel).options).toBe(false)
      panel._fireDispose()
    })

    it('still puts a valid stored width into the init options', async () => {
      const { session, panel, context } = makeSession('/ws/o10.md', 'o\n')
      await context.globalState.update('vmde.outlineWidth', 320)
      session.start()
      await panel._receiveMessage({ command: 'ready' })
      expect(initOf(panel).options.outlineWidth).toBe(320)
      panel._fireDispose()
    })

    it('clears the stored open flag when vmde.outline.defaultOpen changes', async () => {
      const { session, panel, context } = makeSession('/ws/o11.md', 'o\n')
      await context.globalState.update('vmde.outlineOpen', true)
      session.start()
      await panel._receiveMessage({ command: 'ready' })
      await mock.fireDidChangeConfiguration('vmde', [
        'vmde.outline.defaultOpen',
      ])
      expect(context.globalState.get('vmde.outlineOpen')).toBeUndefined()
      panel._fireDispose()
    })

    it('keeps the stored open flag on an unrelated vmde setting change, which still reaches the editor', async () => {
      const { session, panel, context } = makeSession('/ws/o12.md', 'o\n')
      await context.globalState.update('vmde.outlineOpen', true)
      session.start()
      await panel._receiveMessage({ command: 'ready' })
      const before = panel.webview.postMessage.mock.calls.length
      await mock.fireDidChangeConfiguration('vmde', ['vmde.outline.position'])
      expect(panel.webview.postMessage.mock.calls.length).toBeGreaterThan(
        before,
      )
      expect(context.globalState.get('vmde.outlineOpen')).toBe(true)
      panel._fireDispose()
    })
  })

  // Task 657: VS Code's global memento can lose the last of several quick writes when a stale storage
  // echo replaces its local object before the write is flushed. The fake steps that interleaving by
  // hand: write 1 is stored; write 2 is flushed but its echo has not come back; write 3 is made;
  // then the echo of write 2 lands. Every remembered-state key must still end on the last message.
  describe('rapid remembered-state writes keep the last value (Task 657)', () => {
    const initOf = (panel: ReturnType<typeof makeSession>['panel']) =>
      panel.webview.postMessage.mock.calls
        .map((call: unknown[]) => call[0] as any)
        .find(
          (message) => message.command === 'update' && message.type === 'init',
        )

    const rows = [
      {
        name: 'Preview toggle',
        command: 'save-preview-state',
        field: 'on',
        key: 'vmde.previewOn',
        values: [true, false, true] as unknown[],
        read: (init: any) => init.options.openInPreview,
        expected: true,
      },
      {
        name: 'toolbar collapse',
        command: 'save-toolbar-collapsed',
        field: 'collapsed',
        key: 'vmde.toolbarCollapsed',
        values: [true, false, true] as unknown[],
        read: (init: any) => init.toolbarCollapsed,
        expected: true,
      },
      {
        name: 'Outline open',
        command: 'save-outline-open',
        field: 'open',
        key: 'vmde.outlineOpen',
        values: [true, false, true] as unknown[],
        read: (init: any) => init.options.outlineOpen,
        expected: true,
      },
      {
        name: 'Outline width',
        command: 'save-outline-width',
        field: 'width',
        key: 'vmde.outlineWidth',
        values: [300, 400, 500] as unknown[],
        read: (init: any) => init.options.outlineWidth,
        expected: 500,
      },
      {
        name: 'saved editor options',
        command: 'save-options',
        field: 'options',
        key: 'vmde.options',
        values: [
          { mode: 'sv' },
          { mode: 'ir' },
          { mode: 'wysiwyg' },
        ] as unknown[],
        read: (init: any) => init.options.mode,
        expected: 'wysiwyg',
      },
    ]

    it.each(rows)(
      'stores the last $name when a stale echo lands before the last write is flushed',
      async ({ name, command, field, key, values, read, expected }) => {
        const { session, panel, context } = makeSession(
          `/ws/rw-${command}.md`,
          'rw\n',
        )
        const memento = createExtHostMemento()
        usedStores.add(memento)
        context.globalState = memento as any
        session.start()
        await panel._receiveMessage({ command: 'ready' })
        const send = (value: unknown) =>
          panel._receiveMessage({ command, [field]: value })

        const first = send(values[0])
        await memento.settle()
        await memento.drain()
        await first
        const second = send(values[1])
        await memento.settle()
        memento.flush()
        memento.main() // write 2 is stored; its echo is still on its way back
        const third = send(values[2])
        await memento.settle()
        memento.deliverEcho() // the echo of write 2 replaces the local object
        await memento.drain()
        await Promise.all([second, third])

        const last = values[2]
        expect(memento.mainValue[key], `${name} in storage`).toEqual(last)
        expect(memento.get(key), `${name} read back`).toEqual(last)

        // A session opened afterwards (Acceptance 2) reads the matching value.
        const later = makeSession(`/ws/rw-later-${command}.md`, 'later\n')
        later.context.globalState = memento as any
        later.session.start()
        await later.panel._receiveMessage({ command: 'ready' })
        expect(read(initOf(later.panel))).toEqual(expected)
        panel._fireDispose()
        later.panel._fireDispose()
      },
    )

    it('keeps the recorded emoji when a stale echo of the previous recents lands', async () => {
      const { session, panel, context } = makeSession('/ws/rw-emoji.md', 'e\n')
      const memento = createExtHostMemento()
      usedStores.add(memento)
      context.globalState = memento as any
      session.start()
      await panel._receiveMessage({ command: 'ready' })

      const first = panel._receiveMessage({
        command: 'record-emoji-recent',
        sequence: '😀',
      } as any)
      await memento.settle()
      await memento.drain()
      await first
      const afterFirst = memento.mainValue['vmde.emojiRecents']

      const second = panel._receiveMessage({
        command: 'record-emoji-recent',
        sequence: '🫩',
      } as any)
      await memento.settle()
      // Another window's older copy of the recents replaces the local object.
      memento.injectEcho({ 'vmde.emojiRecents': afterFirst })
      memento.deliverEcho()
      await memento.drain()
      await second

      const expected = { version: 1, sequences: ['🫩', '😀'] }
      expect(memento.mainValue['vmde.emojiRecents']).toEqual(expected)
      expect(memento.get('vmde.emojiRecents')).toEqual(expected)
      panel._fireDispose()
    })

    // The stored value can also be reverted AFTER the last acknowledgement: the main process
    // broadcasts the older value it held when its debounce fired. The helper's reads return the last
    // local write meanwhile, and a verification tick repairs the store.
    describe('a stale storage broadcast after the last acknowledgement', () => {
      beforeEach(() => {
        vi.useFakeTimers()
      })
      afterEach(() => {
        vi.useRealTimers()
      })

      const tick = async (memento: ReturnType<typeof createExtHostMemento>) => {
        await vi.advanceTimersByTimeAsync(250)
        await memento.drain()
      }

      const staleRows = [
        ...rows,
        {
          name: 'emoji recents',
          command: 'record-emoji-recent',
          field: 'sequence',
          key: 'vmde.emojiRecents',
          values: ['😀', '🫩', '👍'] as unknown[],
          read: (init: any) => init.emojiRecents,
          expected: { version: 1, sequences: ['👍', '🫩', '😀'] },
        },
      ]

      const scripted = async (row: (typeof staleRows)[number]) => {
        const { session, panel, context } = makeSession(
          `/ws/sb-${row.command}.md`,
          'sb\n',
        )
        const memento = createExtHostMemento()
        usedStores.add(memento)
        context.globalState = memento as any
        session.start()
        await panel._receiveMessage({ command: 'ready' })
        for (const value of row.values) {
          const sent = panel._receiveMessage({
            command: row.command,
            [row.field]: value,
          } as any)
          await memento.settle()
          await memento.drain()
          await sent
        }
        return { panel, memento }
      }

      const openLater = async (
        row: (typeof staleRows)[number],
        memento: ReturnType<typeof createExtHostMemento>,
      ) => {
        const later = makeSession(`/ws/sb-later-${row.command}.md`, 'later\n')
        later.context.globalState = memento as any
        later.session.start()
        await later.panel._receiveMessage({ command: 'ready' })
        return later
      }

      it.each(staleRows)(
        'E1 $name: a session opened right after the stale broadcast reads the last value',
        async (row) => {
          const { panel, memento } = await scripted(row)
          memento.deliverStaleEcho(1)
          const later = await openLater(row, memento)
          expect(row.read(initOf(later.panel))).toEqual(row.expected)
          panel._fireDispose()
          later.panel._fireDispose()
        },
      )

      it.each(staleRows)(
        'E2 $name: the next verification tick stores the last value again',
        async (row) => {
          const { panel, memento } = await scripted(row)
          const last = memento.get(row.key)
          memento.deliverStaleEcho(1)
          expect(memento.get(row.key)).not.toEqual(last)
          await tick(memento)
          expect(memento.get(row.key)).toEqual(last)
          expect(memento.mainValue[row.key]).toEqual(last)
          panel._fireDispose()
        },
      )

      it('E3 a stale copy re-flushed by another key is repaired on the next tick', async () => {
        const row = rows[0]
        const { panel, memento } = await scripted(row)
        memento.deliverStaleEcho(1)
        const outline = panel._receiveMessage({
          command: 'save-outline-open',
          open: true,
        })
        await memento.settle()
        await memento.drain()
        await outline
        expect(memento.mainValue['vmde.previewOn']).toBe(false)
        await tick(memento)
        expect(memento.mainValue['vmde.previewOn']).toBe(true)
        expect(memento.mainValue['vmde.outlineOpen']).toBe(true)
        panel._fireDispose()
      })

      it('E4 a saved-options change made by another window is accepted, not repaired', async () => {
        const row = rows[4]
        const { panel, memento } = await scripted(row)
        memento.injectEcho({ 'vmde.options': { mode: 'sv' }, other: 1 })
        memento.deliverEcho()
        // 'sv' was written earlier in this chain, so use a value that never was.
        memento.injectEcho({ 'vmde.options': { mode: 'elsewhere' } })
        memento.deliverEcho()
        const before = memento.calls.length
        await tick(memento)
        expect(memento.calls.length).toBe(before)
        const later = await openLater(row, memento)
        expect(initOf(later.panel).options.mode).toBe('elsewhere')
        panel._fireDispose()
        later.panel._fireDispose()
      })
    })

    it('tells the other ready editors of every toolbar toggle in message order, before any acknowledgement', async () => {
      const { session, panel, context } = makeSession('/ws/rw-t1.md', 't1\n')
      const { session: other, panel: otherPanel } = makeSession(
        '/ws/rw-t2.md',
        't2\n',
      )
      const memento = createExtHostMemento()
      usedStores.add(memento)
      context.globalState = memento as any
      session.start()
      other.start()
      await panel._receiveMessage({ command: 'ready' })
      await otherPanel._receiveMessage({ command: 'ready' })

      const sent = [true, false, true].map((collapsed) =>
        panel._receiveMessage({ command: 'save-toolbar-collapsed', collapsed }),
      )
      await memento.settle()
      const posted = () =>
        otherPanel.webview.postMessage.mock.calls
          .map((call: unknown[]) => call[0] as any)
          .filter((message) => message.command === 'toolbar-collapsed')
          .map((message) => message.collapsed)
      expect(posted()).toEqual([true, false, true]) // nothing was acknowledged yet
      await memento.drain()
      await Promise.all(sent)
      expect(memento.get('vmde.toolbarCollapsed')).toBe(true)
      panel._fireDispose()
      otherPanel._fireDispose()
    })

    it('ends with the Outline open flag cleared when a default change races a pending save', async () => {
      const { session, panel, context } = makeSession('/ws/rw-o1.md', 'o\n')
      const memento = createExtHostMemento()
      usedStores.add(memento)
      context.globalState = memento as any
      session.start()
      await panel._receiveMessage({ command: 'ready' })

      const saved = panel._receiveMessage({
        command: 'save-outline-open',
        open: true,
      })
      await memento.settle()
      memento.flush()
      memento.main() // the echo of `true` is still on its way back
      await mock.fireDidChangeConfiguration('vmde', [
        'vmde.outline.defaultOpen',
      ])
      memento.deliverEcho() // replaces the local object, discarding the unflushed clear
      await memento.drain()
      await saved

      expect(memento.get('vmde.outlineOpen')).toBeUndefined()
      expect(memento.mainValue).not.toHaveProperty('vmde.outlineOpen')
      panel._fireDispose()
    })
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

    // This panel's own posts: sessions from earlier tests stay subscribed, and their real-timer
    // diff callbacks can land in the shared call log while this test runs.
    const posted = () =>
      (panel.webview.postMessage as any).mock.calls.map(
        ([message]: [any]) => message,
      ) as any[]
    session.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(
      posted().filter((message) => message.command === 'diff-info'),
    ).toEqual([])

    await panel._receiveMessage({ command: 'ready' })
    expect(
      posted().filter(
        (message) =>
          message.command === 'update' || message.command === 'diff-info',
      ),
    ).toEqual([expect.objectContaining({ command: 'update', type: 'init' })])

    await vi.advanceTimersByTimeAsync(300)
    const lifecycleMessages = posted().filter(
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
    const spy = vi.spyOn(WritebackController.prototype, 'checkNoopOnWillSave')
    const { session, document } = makeSession('/ws/note.md', '# Hi\n\nbody\n')
    session.start()
    const captured = mock.fireWillSaveTextDocument(document)
    // Cold Lute (no real extensionPath in this unit environment) → isSemanticNoop can't decide →
    // checkNoopOnWillSave returns [] → the Task 434 listener never calls event.waitUntil. The one
    // thenable is Task 580's separate save flush (see the CP2-12 block below).
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.results[0]?.value).toEqual([])
    expect(captured.waits).toHaveLength(1)
    spy.mockRestore()
  })

  it('onWillSaveTextDocument for a DIFFERENT document is ignored (uri filter)', () => {
    const { session } = makeSession('/ws/note.md', '# Hi\n\nbody\n')
    session.start()
    const other = mock.createTextDocument('/ws/other.md', 'unrelated\n')
    expect(() => mock.fireWillSaveTextDocument(other)).not.toThrow()
    // No assertion beyond "didn't throw" is possible here — the uri filter's real effect (skipping
    // checkNoopOnWillSave entirely) has no other externally observable signal in this mock.
  })

  // Task 580 CP2-12 — the will-save flush replaces the webview's Ctrl/Cmd+S keydown watch. It is a
  // SEPARATE listener registered before Task 434's: it posts `flush-for-save`, waits for the
  // webview's `flush-for-save-done` and the edit queued before it, resolves by 1000 ms and never
  // rejects, so VS Code's listener penalty cannot reach Task 434's correction.
  describe('will-save flush (Task 580 CP2-12)', () => {
    const flushRequests = () =>
      mock.calls.postMessage.filter(
        (message: any) => message.command === 'flush-for-save',
      )
    const settled = (thenable: Thenable<unknown>) => {
      const state = {
        done: false,
        value: undefined as unknown,
        rejected: false,
      }
      Promise.resolve(thenable).then(
        (value) => {
          state.done = true
          state.value = value
        },
        () => {
          state.rejected = true
        },
      )
      return state
    }
    const ticks = async (count = 10) => {
      for (let i = 0; i < count; i++) await Promise.resolve()
    }

    it('runs before the Task 434 check, in its own listener', () => {
      const check = vi.spyOn(
        WritebackController.prototype,
        'checkNoopOnWillSave',
      )
      const { session, panel, document } = makeSession('/ws/order.md', 'a\n')
      session.start()
      const captured = mock.fireWillSaveTextDocument(document)
      const post = panel.webview.postMessage as ReturnType<typeof vi.fn>
      const requestCall = post.mock.calls.findIndex(
        ([message]: any[]) => message.command === 'flush-for-save',
      )
      expect(requestCall).toBeGreaterThanOrEqual(0)
      expect(post.mock.invocationCallOrder[requestCall]).toBeLessThan(
        check.mock.invocationCallOrder[0] as number,
      )
      // Two listeners: the flush's waitUntil comes first and carries no edits.
      expect(captured.waits).toHaveLength(1)
      check.mockRestore()
    })

    it('waits for the edit the flush posted before resolving', async () => {
      const { session, panel, document } = makeSession('/ws/flush.md', 'a\n')
      session.start()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      // Earlier tests in this file leave their own applyEdit spies in place, so apply the
      // replacement here rather than relying on the mock's default implementation.
      vi.spyOn(vscode.workspace, 'applyEdit').mockImplementationOnce(
        async (edit: any) => {
          await gate
          for (const replacement of edit.replacements)
            document.__setText(replacement.content)
          return true
        },
      )
      const captured = mock.fireWillSaveTextDocument(document)
      const [request] = flushRequests()
      expect(request.requestId).toEqual(expect.any(String))
      const flush = settled(captured.waits[0] as Thenable<unknown>)
      // Webview order: the flushed edit, then the reply.
      void panel._receiveMessage({ command: 'edit', content: 'a typed\n' })
      void panel._receiveMessage({
        command: 'flush-for-save-done',
        requestId: request.requestId,
      })
      await ticks(20)
      expect(flush.done).toBe(false)
      release()
      await captured.waits[0]
      expect(flush.done).toBe(true)
      expect(flush.value).toBeUndefined()
      expect(document.getText()).toBe('a typed\n')
    })

    it('resolves on a reply that posted no edit', async () => {
      const { session, panel, document } = makeSession('/ws/clean.md', 'a\n')
      session.start()
      const captured = mock.fireWillSaveTextDocument(document)
      const [request] = flushRequests()
      await panel._receiveMessage({
        command: 'flush-for-save-done',
        requestId: request.requestId,
      })
      await expect(captured.waits[0]).resolves.toBeUndefined()
      expect(mock.calls.appliedEdits).toHaveLength(0)
    })

    it('resolves at the 1000 ms limit without a reply and never rejects', async () => {
      vi.useFakeTimers()
      const { session, document } = makeSession('/ws/slow.md', 'a\n')
      session.start()
      const captured = mock.fireWillSaveTextDocument(document)
      const flush = settled(captured.waits[0] as Thenable<unknown>)
      await vi.advanceTimersByTimeAsync(999)
      expect(flush.done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(flush.done).toBe(true)
      expect(flush.rejected).toBe(false)
    })

    it('ignores a late reply and correlates each save by its own id', async () => {
      vi.useFakeTimers()
      const { session, panel, document } = makeSession('/ws/late.md', 'a\n')
      session.start()
      const first = mock.fireWillSaveTextDocument(document)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(first.waits[0]).resolves.toBeUndefined()
      const second = mock.fireWillSaveTextDocument(document)
      const [firstRequest, secondRequest] = flushRequests()
      expect(secondRequest.requestId).not.toBe(firstRequest.requestId)
      const flush = settled(second.waits[0] as Thenable<unknown>)
      // The late reply to the first save neither throws nor releases the second.
      await panel._receiveMessage({
        command: 'flush-for-save-done',
        requestId: firstRequest.requestId,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(flush.done).toBe(false)
      await panel._receiveMessage({
        command: 'flush-for-save-done',
        requestId: secondRequest.requestId,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(flush.done).toBe(true)
    })

    it('resolves at once when the webview is not live', async () => {
      const { session, panel, document } = makeSession('/ws/hidden.md', 'a\n')
      session.start()
      ;(
        panel.webview.postMessage as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce(false)
      const captured = mock.fireWillSaveTextDocument(document)
      await expect(captured.waits[0]).resolves.toBeUndefined()
    })

    it('resolves without rejecting when posting the request fails', async () => {
      const { session, panel, document } = makeSession('/ws/fail.md', 'a\n')
      session.start()
      ;(
        panel.webview.postMessage as ReturnType<typeof vi.fn>
      ).mockRejectedValueOnce(new Error('disposed'))
      const captured = mock.fireWillSaveTextDocument(document)
      await expect(captured.waits[0]).resolves.toBeUndefined()
    })

    it('does not flush a webview that has not received the latest document text', async () => {
      const { session, document } = makeSession('/ws/external.md', 'a\n')
      session.start()
      // A text-editor change still inside the host's update debounce: the webview DOM is stale,
      // so a flush from it would overwrite the newer text.
      document.__setText('a external\n')
      const captured = mock.fireWillSaveTextDocument(document)
      expect(flushRequests()).toHaveLength(0)
      await expect(captured.waits[0]).resolves.toBeUndefined()
    })

    it('ignores saves of other documents', () => {
      const { session } = makeSession('/ws/mine.md', 'a\n')
      session.start()
      const other = mock.createTextDocument('/ws/theirs.md', 'b\n')
      const captured = mock.fireWillSaveTextDocument(other)
      expect(flushRequests()).toHaveLength(0)
      expect(captured.waits).toHaveLength(0)
    })

    it('releases a waiting save when the panel is disposed', async () => {
      const { session, panel, document } = makeSession('/ws/closed.md', 'a\n')
      session.start()
      const captured = mock.fireWillSaveTextDocument(document)
      panel._fireDispose()
      await expect(captured.waits[0]).resolves.toBeUndefined()
    })
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

// Task 636 — `init` must not wait for the wiki page scan. A pending open carries the wiki context
// without keys; the keys follow in a `wiki-update` posted after `init`; a built cache puts them in
// `init` itself.
describe('EditorSession wiki keys at open (task 636)', () => {
  const WIKI_FILES = ['/ws/Home.md', '/ws/Other Page.md', '/ws/note.md']

  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
    seed.canonicalize.mockReset()
  })

  // Holds every page scan (workspace search or directory reads) until `release()`.
  function holdWikiScan() {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mock.setReadDirectory(async (uri) => {
      await gate
      return uri.fsPath === '/ws'
        ? [
            ['Home.md', 1],
            ['Other Page.md', 1],
            ['note.md', 1],
          ]
        : []
    })
    mock.setFindFiles(async () => {
      await gate
      return WIKI_FILES.map((fsPath) => vscode.Uri.file(fsPath))
    })
    return { release }
  }

  function mountWikiScan() {
    mock.setReadDirectory(async (uri) =>
      uri.fsPath === '/ws'
        ? [
            ['Home.md', 1],
            ['Other Page.md', 1],
            ['note.md', 1],
          ]
        : [],
    )
    mock.setWorkspaceFiles(WIKI_FILES)
  }

  const postedBy = (panel: ReturnType<typeof makeSession>['panel']) =>
    (panel.webview.postMessage as any).mock.calls.map(
      ([message]: [any]) => message,
    ) as any[]
  const initsOf = (messages: any[]) =>
    messages.filter((m) => m.command === 'update' && m.type === 'init')
  const wikiUpdatesOf = (messages: any[]) =>
    messages.filter((m) => m.command === 'wiki-update')
  const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))

  it('R1 posts init while the wiki scan never resolves', async () => {
    mock.setReadDirectory(() => new Promise(() => undefined))
    mock.setFindFiles(() => new Promise(() => undefined))
    const { session, panel } = makeSession()
    session.start()

    void panel._receiveMessage({ command: 'ready' })
    await vi
      .waitFor(() => expect(initsOf(postedBy(panel))).toHaveLength(1), {
        timeout: 400,
        interval: 20,
      })
      .catch(() => undefined)

    expect(initsOf(postedBy(panel))).toHaveLength(1)
  })

  it('R2 a pending init has the wiki context but no keys; wiki-update with the keys follows it', async () => {
    const scan = holdWikiScan()
    const { session, panel } = makeSession()
    session.start()

    void panel._receiveMessage({ command: 'ready' })
    await vi
      .waitFor(() => expect(initsOf(postedBy(panel))).toHaveLength(1), {
        timeout: 400,
        interval: 20,
      })
      .catch(() => undefined)
    const pending = initsOf(postedBy(panel))
    expect(pending).toHaveLength(1)
    expect(pending[0].wiki.enabled).toBe(true)
    expect(pending[0].wiki).not.toHaveProperty('pageKeys')
    expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(0)

    scan.release()
    await vi.waitFor(
      () => expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(1),
      { timeout: 1000, interval: 20 },
    )
    const messages = postedBy(panel)
    const update = wikiUpdatesOf(messages)[0]
    expect(update.pageKeys).toEqual(
      expect.arrayContaining(['home', 'other-page']),
    )
    expect(update.displayNames).toEqual(
      expect.arrayContaining(['Home', 'Other Page']),
    )
    expect(messages.indexOf(initsOf(messages)[0])).toBeLessThan(
      messages.indexOf(update),
    )
  })

  it('R3 a built cache puts the keys in init and posts no extra wiki-update', async () => {
    mountWikiScan()
    const built = await getOrBuildCache(vscode.Uri.file('/ws'))
    const { session, panel } = makeSession()
    session.start()

    await panel._receiveMessage({ command: 'ready' })
    await settle()

    const inits = initsOf(postedBy(panel))
    expect(inits).toHaveLength(1)
    expect(inits[0].wiki.pageKeys).toEqual(
      expect.arrayContaining(['home', 'other-page']),
    )
    expect(inits[0].wiki.displayNames).toEqual(
      expect.arrayContaining(['Home', 'Other Page']),
    )
    expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(0)
    built.dispose()
  })

  it('R4 dispose before the scan resolves posts no wiki-update, and a later watcher event posts nothing', async () => {
    const scan = holdWikiScan()
    const { session, panel } = makeSession()
    session.start()

    void panel._receiveMessage({ command: 'ready' })
    await settle(50)
    panel._fireDispose()
    const watchersBefore = mock.state.watchers.length
    scan.release()
    await settle()
    expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(0)

    for (const watcher of mock.state.watchers.slice(watchersBefore))
      watcher._fireCreate(vscode.Uri.file('/ws/Created After Dispose.md'))
    await settle()
    expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(0)
  })

  it('R7 wiki disabled: no scan and no wiki-update', async () => {
    mock.setConfig({ enabled: false })
    mountWikiScan()
    const directoryReads = { count: 0 }
    mock.setReadDirectory(async () => {
      directoryReads.count++
      return []
    })
    const { session, panel } = makeSession()
    session.start()

    await panel._receiveMessage({ command: 'ready' })
    await settle()

    const inits = initsOf(postedBy(panel))
    expect(inits).toHaveLength(1)
    expect(inits[0].wiki.enabled).toBe(false)
    expect(inits[0].wiki).not.toHaveProperty('pageKeys')
    expect(directoryReads.count).toBe(0)
    expect(mock.calls.findFiles).toHaveLength(0)
    expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(0)
  })
})

// Task 637 — a wiki setting change (`vmde.wiki.root` / `vmde.wiki.enabled`) re-plans the keys for
// the new context: once `init` is posted, a `wiki-update` follows the `config-changed` message.
describe('EditorSession wiki keys after a wiki setting change (task 637)', () => {
  const FILES = [
    '/ws/note.md',
    '/ws/alpha/Alpha Page.md',
    '/ws/gamma/Gamma Page.md',
  ]
  const ALPHA = vscode.Uri.file('/ws/alpha')
  const GAMMA = vscode.Uri.file('/ws/gamma')

  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
    seed.canonicalize.mockReset()
    mock.setWorkspaceFiles(FILES)
  })

  // Holds every page scan until `release()`; each scan lists the files below its search base.
  function holdScan() {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mock.setFindFiles(async (include: any) => {
      await gate
      const prefix = `${include.base.fsPath}/`
      return FILES.filter((f) => f.startsWith(prefix)).map((f) =>
        vscode.Uri.file(f),
      )
    })
    return { release }
  }

  const postedBy = (panel: ReturnType<typeof makeSession>['panel']) =>
    (panel.webview.postMessage as any).mock.calls.map(
      ([message]: [any]) => message,
    ) as any[]
  const initsOf = (messages: any[]) =>
    messages.filter((m) => m.command === 'update' && m.type === 'init')
  const wikiUpdatesOf = (messages: any[]) =>
    messages.filter((m) => m.command === 'wiki-update')
  const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))

  // Opens a ready session whose wiki root is `root` with a built cache (keys ride in `init`).
  async function openReady(root: string) {
    mock.setConfig({ enabled: true, root })
    const built = await getOrBuildCache(vscode.Uri.file(`/ws/${root}`))
    const opened = makeSession()
    opened.session.start()
    await opened.panel._receiveMessage({ command: 'ready' })
    await settle(50)
    expect(wikiUpdatesOf(postedBy(opened.panel))).toHaveLength(0)
    return { ...opened, built }
  }

  const changeSetting = async (values: Record<string, unknown>) => {
    mock.setConfig(values)
    await mock.fireDidChangeConfiguration('vmde')
  }

  it('C1 a root change posts exactly one wiki-update with the new root keys, after config-changed and after init', async () => {
    const { panel } = await openReady('alpha')
    const scan = holdScan()

    await changeSetting({ root: 'gamma' })
    scan.release()
    await vi.waitFor(
      () => expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(1),
      { timeout: 1000, interval: 20 },
    )
    await settle()

    const messages = postedBy(panel)
    const updates = wikiUpdatesOf(messages)
    expect(updates).toHaveLength(1)
    expect(updates[0].pageKeys).toEqual(expect.arrayContaining(['gamma-page']))
    expect(updates[0].pageKeys).not.toContain('alpha-page')
    expect(updates[0].displayNames).toEqual(['Gamma Page'])
    const update = messages.indexOf(updates[0])
    const configChanged = messages.findIndex(
      (m) => m.command === 'config-changed',
    )
    expect(configChanged).toBeGreaterThan(-1)
    expect(update).toBeGreaterThan(configChanged)
    expect(update).toBeGreaterThan(messages.indexOf(initsOf(messages)[0]))
  })

  it('C1 a built cache for the new root posts the wiki-update at once, without a new scan', async () => {
    const { panel } = await openReady('alpha')
    const gamma = await getOrBuildCache(GAMMA)
    const scansBefore = mock.calls.findFiles.length

    await changeSetting({ root: 'gamma' })

    await vi.waitFor(
      () => expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(1),
      { timeout: 200, interval: 5 },
    )
    expect(mock.calls.findFiles).toHaveLength(scansBefore)
    expect(wikiUpdatesOf(postedBy(panel))[0].pageKeys).toEqual(
      gamma.allPageKeys(),
    )
  })

  it('E1 a change of vmde.wiki.exclude posts exactly one wiki-update without the excluded page, after one new scan', async () => {
    mock.setWorkspaceFiles([
      '/ws/alpha/Alpha Page.md',
      '/ws/alpha/Draft.md',
      '/ws/gamma/Gamma Page.md',
    ])
    const { panel } = await openReady('alpha')
    const scansBefore = mock.calls.findFiles.length

    await changeSetting({ 'vmde.wiki.exclude': ['alpha/Draft.md'] })
    await vi.waitFor(
      () => expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(1),
      { timeout: 1000, interval: 20 },
    )
    await settle()

    const updates = wikiUpdatesOf(postedBy(panel))
    expect(updates).toHaveLength(1)
    expect(updates[0].pageKeys).toEqual(['alpha-page'])
    expect(updates[0].displayNames).toEqual(['Alpha Page'])
    expect(mock.calls.findFiles).toHaveLength(scansBefore + 1)
    // 637 contract C2 on the exclude path: the wiki-update follows the config-changed message.
    const messages = postedBy(panel)
    const configChanged = messages.findIndex(
      (m) => m.command === 'config-changed',
    )
    expect(configChanged).toBeGreaterThan(-1)
    expect(messages.indexOf(updates[0])).toBeGreaterThan(configChanged)
  })

  it('C3 disabling the wiki posts nothing and invalidates the old cache', async () => {
    const { panel } = await openReady('alpha')
    expect(peekBuiltCache(ALPHA)).toBeDefined()

    await changeSetting({ enabled: false })
    await settle()

    expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(0)
    expect(peekBuiltCache(ALPHA)).toBeUndefined()
  })

  it('C3 re-enabling the wiki delivers the keys', async () => {
    const { panel } = await openReady('alpha')
    await changeSetting({ enabled: false })
    await settle()
    expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(0)

    await changeSetting({ enabled: true })

    await vi.waitFor(
      () => expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(1),
      { timeout: 1000, interval: 20 },
    )
    expect(wikiUpdatesOf(postedBy(panel))[0].pageKeys).toEqual(
      expect.arrayContaining(['alpha-page']),
    )
  })

  it('C7 two quick changes deliver only the last root', async () => {
    const { panel } = await openReady('alpha')
    const scan = holdScan()

    await changeSetting({ root: '' })
    await changeSetting({ root: 'gamma' })
    scan.release()
    await vi.waitFor(
      () => expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(1),
      { timeout: 1000, interval: 20 },
    )
    await settle()

    const updates = wikiUpdatesOf(postedBy(panel))
    expect(updates).toHaveLength(1)
    expect(updates[0].pageKeys).toContain('gamma-page')
    expect(updates[0].pageKeys).not.toContain('note')
    expect(updates[0].pageKeys).not.toContain('alpha-page')
  })

  it('C1 a change before ready posts nothing', async () => {
    mock.setConfig({ enabled: true, root: 'alpha' })
    const { session, panel } = makeSession()
    session.start()

    await changeSetting({ root: 'gamma' })
    await settle()

    expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(0)
    expect(initsOf(postedBy(panel))).toHaveLength(0)
  })

  it('C7 dispose before the new scan resolves posts nothing', async () => {
    const { panel } = await openReady('alpha')
    const scan = holdScan()

    await changeSetting({ root: 'gamma' })
    panel._fireDispose()
    scan.release()
    await settle()

    expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(0)
  })

  it('C4 an unchanged effective root posts nothing and keeps the cache', async () => {
    const { panel, built } = await openReady('alpha')

    await changeSetting({ root: 'alpha' })
    await settle()

    expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(0)
    expect(peekBuiltCache(ALPHA)).toBe(built)
  })

  it('C1 the watcher callback works again after a config change', async () => {
    const { panel } = await openReady('alpha')
    await changeSetting({ root: 'gamma' })
    await vi.waitFor(
      () => expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(1),
      { timeout: 1000, interval: 20 },
    )

    for (const watcher of mock.state.watchers)
      if (!watcher.disposed)
        watcher._fireCreate(vscode.Uri.file('/ws/gamma/Created Later.md'))

    await vi.waitFor(
      () => expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(2),
      { timeout: 1000, interval: 20 },
    )
    expect(wikiUpdatesOf(postedBy(panel))[1].pageKeys).toContain(
      'created-later',
    )
  })
})

// Task 607 INV-B: an exact edit names the host text it was planned on (`before`) and is written
// only when the host still holds those bytes (line endings compared normalized). Otherwise the
// host writes nothing and tells the webview, so it can roll the action back.
describe('EditorSession exact edits carry a host guard (Task 607)', () => {
  const hostText = 'alpha\n\nbeta\n\ngamma\n'
  const exactEdit = 'alpha\n\n## beta\n\ngamma\n'

  beforeEach(() => {
    mock.reset()
    seed.canonicalize.mockReset()
  })

  async function postExactEdit(before: string | undefined, text = hostText) {
    const { session, panel, document } = makeSession('/ws/guard.md', text)
    session.start()
    applyReplacements(document, 1)
    await panel._receiveMessage({
      command: 'edit',
      content: exactEdit,
      exact: true,
      ...(before === undefined ? {} : { before }),
    })
    return { document }
  }

  it('writes an exact edit verbatim when `before` equals the host text', async () => {
    const { document } = await postExactEdit(hostText)
    expect(document.getText()).toBe(exactEdit)
  })

  it('treats line endings as equal when comparing `before`', async () => {
    const { document } = await postExactEdit(
      hostText,
      hostText.replace(/\n/g, '\r\n'),
    )
    expect(document.getText().replace(/\r\n/g, '\n')).toBe(exactEdit)
  })

  it('control: reports unchanged and posts no refusal when content equals the host text, with or without `before`', async () => {
    for (const eol of ['\n', '\r\n']) {
      mock.reset()
      const { session, panel, document } = makeSession(
        '/ws/replay.md',
        hostText.replace(/\n/g, eol),
      )
      session.start()
      await panel._receiveMessage({
        command: 'edit',
        content: hostText,
        exact: true,
      })
      expect(document.getText()).toBe(hostText.replace(/\n/g, eol))
      expect(mock.calls.postMessage).not.toContainEqual(
        expect.objectContaining({ command: 'exact-edit-refused' }),
      )
    }
  })

  it('refuses an exact edit whose `before` differs from the host text and writes nothing', async () => {
    const { document } = await postExactEdit('alpha\n\nbeta\n\ngamma CHANGED\n')
    expect(document.getText()).toBe(hostText)
  })

  it('refuses an exact edit that carries no `before`', async () => {
    const { document } = await postExactEdit(undefined)
    expect(document.getText()).toBe(hostText)
  })

  it('reports a refused exact edit back to the webview so it can roll the action back', async () => {
    await postExactEdit('alpha\n\nbeta\n\ngamma CHANGED\n')
    expect(mock.calls.postMessage).toContainEqual(
      expect.objectContaining({ command: 'exact-edit-refused' }),
    )
  })

  it('treats a non-string `before` as missing and refuses, echoing only a string requestId', async () => {
    for (const malformed of [
      { before: 42, requestId: 'bad-before' },
      { before: { text: hostText }, requestId: 7 },
    ]) {
      mock.reset()
      const { session, panel, document } = makeSession('/ws/shape.md', hostText)
      session.start()
      await panel._receiveMessage({
        command: 'edit',
        content: exactEdit,
        exact: true,
        ...malformed,
      } as any)
      await (session as any).editMessageChain
      expect(document.getText()).toBe(hostText)
      const refusals = mock.calls.postMessage.filter(
        (message: any) => message?.command === 'exact-edit-refused',
      )
      expect(refusals).toEqual([
        {
          command: 'exact-edit-refused',
          ...(typeof malformed.requestId === 'string'
            ? { requestId: malformed.requestId }
            : {}),
          content: hostText,
        },
      ])
    }
  })

  it('answers request-exact-authority after earlier queued edits with the host text', async () => {
    const { session, panel, document } = makeSession(
      '/ws/authority.md',
      hostText,
    )
    session.start()
    // Refused edits above leave queued one-shot writers that target their own documents.
    vi.spyOn(vscode.workspace, 'applyEdit').mockReset()
    applyReplacements(document, 1)
    const edited = 'alpha\n\nbetaX\n\ngamma\n'
    const edit = panel._receiveMessage({ command: 'edit', content: edited })
    const request = panel._receiveMessage({
      command: 'request-exact-authority',
      requestId: 'auth-1',
    })
    await Promise.all([edit, request])
    await (session as any).editMessageChain

    const replies = mock.calls.postMessage.filter(
      (message: any) => message?.command === 'exact-authority',
    )
    expect(document.getText()).toBe(edited)
    expect(replies).toEqual([
      { command: 'exact-authority', requestId: 'auth-1', content: edited },
    ])
  })

  it('writes a Rewrap Document exact post that names the host text it planned on', async () => {
    // Task 607: typing published as a plain edit leaves the host text as the only base; the
    // rewrap post names it as `before`, so the guard writes it.
    const { session, panel, document } = makeSession('/ws/rewrap.md', hostText)
    session.start()
    // Refused edits above leave queued one-shot writers that target their own documents.
    vi.spyOn(vscode.workspace, 'applyEdit').mockReset()
    applyReplacements(document, 2)
    const typed = 'alpha\n\nbeta typed\n\ngamma\n'
    await panel._receiveMessage({ command: 'edit', content: typed })
    await (session as any).editMessageChain
    const rewrapped = 'alpha\n\nbeta\ntyped\n\ngamma\n'
    await panel._receiveMessage({
      command: 'edit',
      content: rewrapped,
      exact: true,
      before: document.getText(),
      requestId: 'rewrap-1',
    })
    await (session as any).editMessageChain

    expect(document.getText()).toBe(rewrapped)
    expect(mock.calls.postMessage).not.toContainEqual(
      expect.objectContaining({ command: 'exact-edit-refused' }),
    )
  })

  describe('Move Block host guard', () => {
    const action = {
      kind: 'move',
      sourceStart: 0,
      targetStart: 7,
      placement: 'after',
    }

    it('control: prepares a move whose `before` equals the host text', async () => {
      const { session, panel } = makeSession('/ws/move.md', hostText)
      session.start()
      await panel._receiveMessage({
        command: 'request-block-action',
        requestId: 'move-ok',
        before: hostText,
        action,
      })
      expect(mock.calls.postMessage).toContainEqual(
        expect.objectContaining({
          command: 'prepare-block-action',
          requestId: 'move-ok',
          before: hostText,
        }),
      )
    })

    it('control: a real mismatch answers stale and changes nothing', async () => {
      const { session, panel, document } = makeSession('/ws/move.md', hostText)
      session.start()
      await panel._receiveMessage({
        command: 'request-block-action',
        requestId: 'move-stale',
        before: 'alpha\n\nbeta\n\ngamma CHANGED\n',
        action,
      })
      expect(mock.calls.postMessage).toContainEqual(
        expect.objectContaining({
          command: 'block-action-outcome',
          requestId: 'move-stale',
          status: 'stale',
        }),
      )
      expect(document.getText()).toBe(hostText)
    })
  })

  // Task 630: the host side of the webview outline reorder. The webview acquires the host text
  // first; a `before` mismatch on its side now declines with `cancel-outline-section-move`.
  describe('outline section move handshake', () => {
    const outlineText = '# A\n\nalpha\n\n# B\n\nbeta\n'
    const moved = '# B\n\nbeta\n\n# A\n\nalpha\n'
    const request = {
      command: 'request-outline-section-move' as const,
      requestId: 'outline-1',
      sourceIndex: 0,
      targetIndex: 1,
      placement: 'after' as const,
      rowLabels: ['A', 'B'],
    }
    const prepared = (id = 'outline-1') =>
      mock.calls.postMessage.find(
        (message: any) =>
          message?.command === 'prepare-outline-section-move' &&
          message.requestId === id,
      ) as any
    const apply = (binding: any) => ({
      command: 'apply-outline-section-move' as const,
      requestId: binding.requestId,
      uri: binding.uri,
      version: binding.version,
      before: binding.before,
      after: binding.after,
    })
    const outcomes = () =>
      mock.calls.postMessage.filter(
        (message: any) => message?.command === 'outline-section-move-outcome',
      ) as any[]

    it('prepares a move on the host text and writes it once the webview applies it', async () => {
      const { session, panel, document } = makeSession(
        '/ws/outline.md',
        outlineText,
      )
      session.start()
      vi.spyOn(vscode.workspace, 'applyEdit').mockReset()
      applyReplacements(document, 1)
      await panel._receiveMessage(request)
      const binding = prepared()
      expect(binding).toMatchObject({ before: outlineText, after: moved })
      await panel._receiveMessage(apply(binding))
      await (session as any).editMessageChain
      expect(document.getText()).toBe(moved)
      expect(outcomes()).toEqual([
        expect.objectContaining({
          requestId: 'outline-1',
          status: 'applied',
          content: moved,
        }),
      ])
    })

    it('a decline clears the binding: a later apply for that request is stale and writes nothing', async () => {
      const { session, panel, document } = makeSession(
        '/ws/outline.md',
        outlineText,
      )
      session.start()
      await panel._receiveMessage(request)
      const binding = prepared()
      expect((session as any).outlineMoves.size).toBe(1)
      await panel._receiveMessage({
        command: 'cancel-outline-section-move',
        requestId: 'outline-1',
      })
      expect((session as any).outlineMoves.size).toBe(0)
      await panel._receiveMessage(apply(binding))
      await (session as any).editMessageChain
      expect(document.getText()).toBe(outlineText)
      expect(outcomes()).toEqual([
        expect.objectContaining({ requestId: 'outline-1', status: 'stale' }),
      ])
    })

    it('a decline for an unknown request changes nothing', async () => {
      const { session, panel, document } = makeSession(
        '/ws/outline.md',
        outlineText,
      )
      session.start()
      await panel._receiveMessage({
        command: 'cancel-outline-section-move',
        requestId: 'never-sent',
      })
      expect(document.getText()).toBe(outlineText)
      expect(outcomes()).toEqual([])
    })

    it('a stale host (text changed after the plan) is refused with the host text and nothing is written', async () => {
      const { session, panel, document } = makeSession(
        '/ws/outline.md',
        outlineText,
      )
      session.start()
      const edit = vi.spyOn(vscode.workspace, 'applyEdit')
      edit.mockClear()
      await panel._receiveMessage(request)
      const binding = prepared()
      const changed = `${outlineText}tail\n`
      document.__setText(changed)
      await panel._receiveMessage(apply(binding))
      await (session as any).editMessageChain
      expect(document.getText()).toBe(changed)
      expect(edit).not.toHaveBeenCalled()
      expect(outcomes()).toEqual([
        expect.objectContaining({
          requestId: 'outline-1',
          status: 'stale',
          content: changed,
        }),
      ])
    })

    it('answers stale, with no binding, when the request labels disagree with the host text', async () => {
      const { session, panel } = makeSession('/ws/outline.md', outlineText)
      session.start()
      await panel._receiveMessage({ ...request, rowLabels: ['A', 'Other'] })
      expect(prepared()).toBeUndefined()
      expect((session as any).outlineMoves.size).toBe(0)
      expect(outcomes()).toEqual([
        expect.objectContaining({ requestId: 'outline-1', status: 'stale' }),
      ])
    })
  })
})

// Task 638 — a restart is a module reset (`_resetCacheMap`) over a workspace state that still holds
// the page list the previous run stored. `init` carries that list at once; the usual background scan
// revalidates it and posts a `wiki-update` only when it differs.
describe('EditorSession persisted wiki keys (task 638)', () => {
  const WIKI_FILES = ['/ws/Home.md', '/ws/Other Page.md', '/ws/note.md']
  const FRESH = {
    pageKeys: ['home', 'note', 'other-page'],
    displayNames: ['Home', 'Other Page', 'note'],
  }
  const STALE = {
    pageKeys: ['home', 'removed-page'],
    displayNames: ['Home', 'Removed Page'],
  }
  const ROOT = vscode.Uri.file('/ws')
  const entryKey = (root: string) => `vmde.wikiPages:file://${root}`
  const storedEntry = (
    root: string,
    keys: { pageKeys: string[]; displayNames: string[] },
  ) => ({
    version: 1,
    root: `file://${root}`,
    savedAt: 1_700_000_000_000,
    ...keys,
  })

  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
    seed.canonicalize.mockReset()
    mock.setWorkspaceFiles(WIKI_FILES)
    configureWikiKeyStore(mock.createExtensionContext().workspaceState as any)
  })

  afterEach(() => configureWikiKeyStore(undefined))

  // Holds every page scan until `release()`.
  function holdScan(files = WIKI_FILES) {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mock.setFindFiles(async (include: any) => {
      await gate
      const prefix = `${include.base.fsPath}/`
      return files
        .filter((f) => f.startsWith(prefix))
        .map((f) => vscode.Uri.file(f))
    })
    return { release }
  }

  const postedBy = (panel: ReturnType<typeof makeSession>['panel']) =>
    (panel.webview.postMessage as any).mock.calls.map(
      ([message]: [any]) => message,
    ) as any[]
  const initsOf = (messages: any[]) =>
    messages.filter((m) => m.command === 'update' && m.type === 'init')
  const wikiUpdatesOf = (messages: any[]) =>
    messages.filter((m) => m.command === 'wiki-update')
  const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))

  async function openWithStored(
    keys: { pageKeys: string[]; displayNames: string[] },
    scan?: ReturnType<typeof holdScan>,
  ) {
    mock.state.workspaceState[entryKey('/ws')] = storedEntry('/ws', keys)
    const opened = makeSession()
    opened.session.start()
    void opened.panel._receiveMessage({ command: 'ready' })
    await vi.waitFor(
      () => expect(initsOf(postedBy(opened.panel))).toHaveLength(1),
      { timeout: 1000, interval: 20 },
    )
    return { ...opened, scan }
  }

  it('A1 init carries the stored keys while the scan is still running, and nothing is pending', async () => {
    const scan = holdScan()
    const { panel } = await openWithStored(STALE, scan)

    const [init] = initsOf(postedBy(panel))
    expect(init.wiki.enabled).toBe(true)
    expect(init.wiki.pageKeys).toEqual(STALE.pageKeys)
    expect(init.wiki.displayNames).toEqual(STALE.displayNames)
    await settle(50)
    expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(0)
    scan.release()
    await settle()
  })

  it('A2 no wiki-update when the scan equals the stored list', async () => {
    const { panel } = await openWithStored(FRESH)

    await vi.waitFor(
      () => expect(mock.calls.findFiles.length).toBeGreaterThan(0),
      {
        timeout: 1000,
        interval: 20,
      },
    )
    await settle()

    expect(initsOf(postedBy(panel))[0].wiki.pageKeys).toEqual(FRESH.pageKeys)
    expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(0)
  })

  it('A2/A3 exactly one wiki-update after init when the scan differs, and the store then holds the new list', async () => {
    const { panel } = await openWithStored(STALE)

    await vi.waitFor(
      () => expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(1),
      { timeout: 1000, interval: 20 },
    )
    await settle()

    const messages = postedBy(panel)
    const updates = wikiUpdatesOf(messages)
    expect(updates).toHaveLength(1)
    expect(updates[0].pageKeys).toEqual(FRESH.pageKeys)
    expect(updates[0].displayNames).toEqual(FRESH.displayNames)
    expect(messages.indexOf(updates[0])).toBeGreaterThan(
      messages.indexOf(initsOf(messages)[0]),
    )
    expect(readStoredKeys(ROOT)).toEqual(FRESH)
    expect(mock.state.workspaceState[entryKey('/ws')]).toMatchObject({
      version: 1,
      root: 'file:///ws',
      ...FRESH,
    })
  })

  it('dispose before the revalidation resolves posts nothing, and the shared build still stores the new list', async () => {
    const scan = holdScan()
    const { panel } = await openWithStored(STALE, scan)

    panel._fireDispose()
    scan.release()
    await settle()

    expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(0)
    expect(readStoredKeys(ROOT)).toEqual(FRESH)
  })

  it('A4 a root change posts the new root stored list at once, revalidates it, and clears the old root entry', async () => {
    const files = [
      ...WIKI_FILES,
      '/ws/alpha/Alpha Page.md',
      '/ws/gamma/Gamma Page.md',
    ]
    mock.setConfig({ enabled: true, root: 'alpha' })
    mock.setWorkspaceFiles(files)
    await getOrBuildCache(vscode.Uri.file('/ws/alpha'))
    await settle(20)
    expect(mock.state.workspaceState[entryKey('/ws/alpha')]).toBeDefined()
    const { session, panel } = makeSession()
    session.start()
    await panel._receiveMessage({ command: 'ready' })
    await settle(50)
    expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(0)
    mock.state.workspaceState[entryKey('/ws/gamma')] = storedEntry(
      '/ws/gamma',
      {
        pageKeys: ['stale-gamma'],
        displayNames: ['Stale Gamma'],
      },
    )
    const scan = holdScan(files)

    mock.setConfig({ root: 'gamma' })
    await mock.fireDidChangeConfiguration('vmde')

    await vi.waitFor(
      () => expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(1),
      { timeout: 1000, interval: 20 },
    )
    expect(wikiUpdatesOf(postedBy(panel))[0].pageKeys).toEqual(['stale-gamma'])
    expect(mock.state.workspaceState[entryKey('/ws/alpha')]).toBeUndefined()

    scan.release()
    await vi.waitFor(
      () => expect(wikiUpdatesOf(postedBy(panel))).toHaveLength(2),
      { timeout: 1000, interval: 20 },
    )
    expect(wikiUpdatesOf(postedBy(panel))[1].pageKeys).toEqual(['gamma-page'])
    await settle(20)
    expect(readStoredKeys(vscode.Uri.file('/ws/gamma'))).toEqual({
      pageKeys: ['gamma-page'],
      displayNames: ['Gamma Page'],
    })
  })
})

// Task 638 — `activate` hands the extension's workspace state to the page-list store, and
// deactivation keeps what was stored.
describe('wiki page list store wiring (task 638)', () => {
  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
    mock.setWorkspaceFolder('/ws')
    mock.setWorkspaceFiles(['/ws/Home.md'])
  })

  afterEach(() => configureWikiKeyStore(undefined))

  it('A1/A2 a cache built after activate is stored in the context workspace state and survives deactivation', async () => {
    const context = mock.createExtensionContext()
    activate(context as any)

    await getOrBuildCache(vscode.Uri.file('/ws'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(
      context.workspaceState.get('vmde.wikiPages:file:///ws'),
    ).toMatchObject({
      version: 1,
      pageKeys: ['home'],
      displayNames: ['Home'],
    })

    for (const subscription of context.subscriptions) subscription.dispose()

    expect(
      context.workspaceState.get('vmde.wikiPages:file:///ws'),
    ).toMatchObject({
      pageKeys: ['home'],
    })
  })
})
