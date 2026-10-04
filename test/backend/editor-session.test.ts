import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { EditorSession } from '../../src/app/extension'
import { WritebackController } from '../../src/writeback/writeback-controller'
import { HistoryCouplingController } from '../../src/writeback/history-coupling'
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
