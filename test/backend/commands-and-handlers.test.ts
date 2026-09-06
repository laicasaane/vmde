import { describe, it, expect, beforeEach } from 'vitest'
import { activate, MarkdownEditorProvider } from '../../src/app/extension'
import { FORMAT_COMMANDS } from '../../src/app/commands'
import {
  mock,
  Uri,
  TabInputTextDiff,
  TabInputText,
  TabInputCustom,
  ViewColumn,
} from './vscode-mock'

const VIEW_TYPE = 'vmde.editor'
const FORMER_COMMAND_PREFIX = `${['v', 'markd'].join('')}.`

function activateAndGetCommand(id: string) {
  const context = mock.createExtensionContext()
  activate(context as any)
  return mock.calls.registeredCommands.get(id)!
}

function openWithCalls() {
  return mock.calls.executeCommand.filter(
    (c) => c.command === 'vscode.openWith',
  )
}

describe('command: vmde.findReplace', () => {
  beforeEach(() => mock.reset())

  it('opens the custom widget in the active VMDE panel', async () => {
    const command = activateAndGetCommand('vmde.findReplace')
    const uri = Uri.file('/workspace/note.md')
    const panel = mock.createWebviewPanel()
    const entry = { uri, panel }
    MarkdownEditorProvider.activePanels.add(entry as never)
    mock.setActiveTab(new TabInputCustom(uri, VIEW_TYPE))
    try {
      await command()
      expect(mock.calls.postMessage).toContainEqual({
        command: 'open-find-replace',
      })
    } finally {
      MarkdownEditorProvider.activePanels.delete(entry as never)
    }
  })
})

describe('command: vmde.toggleSectionFold', () => {
  beforeEach(() => mock.reset())

  it('forwards to the active VMDE panel', async () => {
    const command = activateAndGetCommand('vmde.toggleSectionFold')
    const uri = Uri.file('/workspace/note.md')
    const panel = mock.createWebviewPanel()
    const entry = { uri, panel }
    MarkdownEditorProvider.activePanels.add(entry as never)
    mock.setActiveTab(new TabInputCustom(uri, VIEW_TYPE))
    try {
      await command()
      expect(mock.calls.postMessage).toContainEqual({
        command: 'toggle-section-fold',
      })
    } finally {
      MarkdownEditorProvider.activePanels.delete(entry as never)
    }
  })
})

describe('command: vmde.openEditor', () => {
  beforeEach(() => mock.reset())

  it('opens an explicit markdown uri with the custom editor', async () => {
    const open = activateAndGetCommand('vmde.openEditor')
    const uri = Uri.file('/workspace/note.md')
    await open(uri)
    expect(openWithCalls()).toContainEqual({
      command: 'vscode.openWith',
      args: [uri, VIEW_TYPE],
    })
  })

  it('falls back to the active text editor when no uri is passed', async () => {
    const open = activateAndGetCommand('vmde.openEditor')
    mock.setActiveTextEditor(Uri.file('/workspace/active.md'))
    await open()
    expect(openWithCalls().at(-1)?.args[0].fsPath).toBe('/workspace/active.md')
  })

  it('posts the active source line after a new custom-editor panel registers', async () => {
    const open = activateAndGetCommand('vmde.openEditor')
    const uri = Uri.file('/workspace/active.md')
    const panel = mock.createWebviewPanel()
    const entry = { uri, panel }
    mock.setActiveTextEditor(uri, 37)
    mock.setExecuteCommandResponse((command) => {
      if (command === 'vscode.openWith')
        MarkdownEditorProvider.activePanels.add(entry as never)
    })
    try {
      await open()
      expect(mock.calls.postMessage).toContainEqual({
        command: 'reveal-line',
        line: 37,
        lineText: '',
      })
    } finally {
      MarkdownEditorProvider.activePanels.delete(entry as never)
    }
  })

  it('errors when no markdown target can be found', async () => {
    const open = activateAndGetCommand('vmde.openEditor')
    await open()
    expect(openWithCalls()).toHaveLength(0)
    expect(mock.calls.showError.join(' ')).toContain(
      'Cannot find markdown file',
    )
  })

  it('rejects non-markdown files', async () => {
    const open = activateAndGetCommand('vmde.openEditor')
    await open(Uri.file('/workspace/notes.txt'))
    expect(openWithCalls()).toHaveLength(0)
    expect(mock.calls.showError.join(' ')).toContain('local markdown files')
  })

  it('refuses to open inside a diff editor', async () => {
    const open = activateAndGetCommand('vmde.openEditor')
    const uri = Uri.file('/workspace/note.md')
    mock.setActiveTab(new TabInputTextDiff(uri, Uri.file('/workspace/old.md')))
    await open(uri)
    expect(openWithCalls()).toHaveLength(0)
    expect(mock.calls.showError.join(' ')).toContain('diff editors')
  })
})

describe('command: vmde.openEditor — tab dedup (task 36)', () => {
  beforeEach(() => mock.reset())

  it('reveals an existing VMDE tab in its column instead of duplicating', async () => {
    const open = activateAndGetCommand('vmde.openEditor')
    const uri = Uri.file('/workspace/note.md')
    mock.setTabGroups([
      {
        viewColumn: 1,
        inputs: [new TabInputText(Uri.file('/workspace/other.md'))],
      },
      { viewColumn: 2, inputs: [new TabInputCustom(uri, VIEW_TYPE)] },
    ])
    await open(uri)
    expect(openWithCalls()).toContainEqual({
      command: 'vscode.openWith',
      args: [uri, VIEW_TYPE, { viewColumn: 2 }],
    })
  })

  it('posts a live reveal-line when returning from source to an existing VMDE tab', async () => {
    const open = activateAndGetCommand('vmde.openEditor')
    const uri = Uri.file('/workspace/note.md')
    const panel = mock.createWebviewPanel()
    const entry = { uri, panel }
    MarkdownEditorProvider.activePanels.add(entry as never)
    mock.setActiveTextEditor(uri, 22)
    mock.setTabGroups([
      { viewColumn: 2, inputs: [new TabInputCustom(uri, VIEW_TYPE)] },
    ])
    try {
      await open(uri)
      expect(mock.calls.postMessage).toContainEqual({
        command: 'reveal-line',
        line: 22,
        lineText: '',
      })
    } finally {
      MarkdownEditorProvider.activePanels.delete(entry as never)
    }
  })

  it('opens normally when only a text (not VMDE) tab exists for the file', async () => {
    const open = activateAndGetCommand('vmde.openEditor')
    const uri = Uri.file('/workspace/note.md')
    mock.setTabGroups([{ viewColumn: 1, inputs: [new TabInputText(uri)] }])
    await open(uri)
    expect(openWithCalls()).toContainEqual({
      command: 'vscode.openWith',
      args: [uri, VIEW_TYPE],
    })
  })
})

describe('command: vmde.openSourceToSide (task 36)', () => {
  beforeEach(() => mock.reset())

  it('opens the source in the adjacent column when no source tab exists', async () => {
    const open = activateAndGetCommand('vmde.openSourceToSide')
    const uri = Uri.file('/workspace/note.md')
    await open(uri)
    expect(openWithCalls()).toContainEqual({
      command: 'vscode.openWith',
      args: [uri, 'default', { viewColumn: ViewColumn.Beside }],
    })
  })

  it('focuses an existing source tab in its own column (no duplicate)', async () => {
    const open = activateAndGetCommand('vmde.openSourceToSide')
    const uri = Uri.file('/workspace/note.md')
    mock.setTabGroups([
      { viewColumn: 1, inputs: [new TabInputCustom(uri, VIEW_TYPE)] },
      { viewColumn: 2, inputs: [new TabInputText(uri)] },
    ])
    await open(uri)
    expect(openWithCalls()).toContainEqual({
      command: 'vscode.openWith',
      args: [uri, 'default', { viewColumn: 2 }],
    })
  })

  it('rejects non-markdown files', async () => {
    const open = activateAndGetCommand('vmde.openSourceToSide')
    await open(Uri.file('/workspace/notes.txt'))
    expect(openWithCalls()).toHaveLength(0)
    expect(mock.calls.showError.join(' ')).toContain('local markdown files')
  })
})

describe('command: vmde.openInSplit', () => {
  beforeEach(() => mock.reset())

  it('opens the visual editor beside the current view', async () => {
    const open = activateAndGetCommand('vmde.openInSplit')
    const uri = Uri.file('/workspace/note.md')
    await open(uri)
    expect(openWithCalls()).toContainEqual({
      command: 'vscode.openWith',
      args: [uri, VIEW_TYPE, ViewColumn.Beside],
    })
  })

  it('falls back to the active text editor when no uri is passed', async () => {
    const open = activateAndGetCommand('vmde.openInSplit')
    mock.setActiveTextEditor(Uri.file('/workspace/active.md'))
    await open()
    const call = openWithCalls().at(-1)
    expect(call?.args[0].fsPath).toBe('/workspace/active.md')
    expect(call?.args[2]).toBe(ViewColumn.Beside)
  })

  it('rejects non-markdown files', async () => {
    const open = activateAndGetCommand('vmde.openInSplit')
    await open(Uri.file('/workspace/notes.txt'))
    expect(openWithCalls()).toHaveLength(0)
    expect(mock.calls.showError.join(' ')).toContain('local markdown files')
  })

  it('refuses to open inside a diff editor', async () => {
    const open = activateAndGetCommand('vmde.openInSplit')
    const uri = Uri.file('/workspace/note.md')
    mock.setActiveTab(new TabInputTextDiff(uri, Uri.file('/workspace/old.md')))
    await open(uri)
    expect(openWithCalls()).toHaveLength(0)
    expect(mock.calls.showError.join(' ')).toContain('diff editors')
  })
})

describe('command: vmde.openTextEditor', () => {
  beforeEach(() => mock.reset())

  it('reopens the uri in the default (text) editor', async () => {
    const openText = activateAndGetCommand('vmde.openTextEditor')
    const uri = Uri.file('/workspace/note.md')
    await openText(uri)
    expect(mock.calls.executeCommand).toContainEqual({
      command: 'vscode.openWith',
      args: [uri, 'default'],
    })
  })
})

describe('command: vmde.openSettings', () => {
  beforeEach(() => mock.reset())

  it('opens the Settings UI filtered to this extension', async () => {
    const openSettings = activateAndGetCommand('vmde.openSettings')
    await openSettings()
    expect(mock.calls.executeCommand).toContainEqual({
      command: 'workbench.action.openSettings',
      args: ['@ext:Laicasaane.vmde'],
    })
  })
})

describe('command: vmde.rewrap (task 273)', () => {
  beforeEach(() => mock.reset())

  it('forwards one rewrap-selection message to the active visual editor', async () => {
    const uri = Uri.file('/workspace/note.md')
    mock.setActiveTab(new TabInputCustom(uri, VIEW_TYPE))
    resolveProvider(uri.fsPath)

    const rewrap = activateAndGetCommand('vmde.rewrap')
    await rewrap()

    expect(mock.calls.postMessage).toContainEqual({
      command: 'rewrap-selection',
    })
  })
})

describe('commands: heading level shift (task 254)', () => {
  beforeEach(() => mock.reset())

  it.each([
    ['vmde.promoteHeading', -1],
    ['vmde.demoteHeading', 1],
  ] as const)(
    'forwards %s to the active visual editor',
    async (id, direction) => {
      const uri = Uri.file('/workspace/note.md')
      mock.setActiveTab(new TabInputCustom(uri, VIEW_TYPE))
      resolveProvider(uri.fsPath)

      await activateAndGetCommand(id)()

      expect(mock.calls.postMessage).toContainEqual({
        command: 'shift-heading-level',
        direction,
        section: false,
      })
    },
  )
})

describe('command: vmde.rewrapDocument (task 520)', () => {
  beforeEach(() => mock.reset())

  it('forwards one whole-document rewrap message to the active visual editor', async () => {
    const uri = Uri.file('/workspace/note.md')
    mock.setActiveTab(new TabInputCustom(uri, VIEW_TYPE))
    resolveProvider(uri.fsPath)

    const rewrap = activateAndGetCommand('vmde.rewrapDocument')
    await rewrap()

    expect(
      mock.calls.postMessage.filter(
        (message) => message.command === 'prepare-rewrap-document',
      ),
    ).toEqual([{ command: 'prepare-rewrap-document' }])
  })

  it('prefers the active custom tab when the last text editor also has a panel', async () => {
    const staleUri = Uri.file('/workspace/stale-target-520.md')
    const activeUri = Uri.file('/workspace/active-target-520.md')
    const stale = resolveProvider(staleUri.fsPath)
    const active = resolveProvider(activeUri.fsPath)
    mock.setActiveTextEditor(staleUri)
    mock.setActiveTab(new TabInputCustom(activeUri, VIEW_TYPE))
    stale.panel.webview.postMessage.mockClear()
    active.panel.webview.postMessage.mockClear()

    await activateAndGetCommand('vmde.rewrapDocument')()

    expect(stale.panel.webview.postMessage).not.toHaveBeenCalled()
    expect(active.panel.webview.postMessage).toHaveBeenCalledWith({
      command: 'prepare-rewrap-document',
    })
  })

  it('returns authoritative host bytes only after a live edit is applied', async () => {
    const { document, panel } = resolveProvider(
      '/workspace/note.md',
      'host before\n',
    )
    panel.webview.postMessage.mockClear()

    await panel._receiveMessage({
      command: 'edit',
      content: 'live unsynced edit\n',
      rewrapDocument: true,
    })

    expect(document.getText()).toBe('live unsynced edit\n')
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      command: 'rewrap-document',
      content: 'live unsynced edit\n',
    })
  })

  it('returns host bytes directly when the webview has no user edit to flush', async () => {
    const { panel } = resolveProvider('/workspace/note.md', 'host exact\n')
    panel.webview.postMessage.mockClear()

    await panel._receiveMessage({ command: 'request-rewrap-document' })

    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      command: 'rewrap-document',
      content: 'host exact\n',
    })
  })
})

function resolveProvider(fsPath = '/workspace/note.md', text = '# doc\n') {
  mock.setWorkspaceFolder('/workspace')
  const context = mock.createExtensionContext()
  const document = mock.createTextDocument(fsPath, text)
  const panel = mock.createWebviewPanel()
  // resolveCustomTextEditor is `async`, but for a conflict-free document (every test here) its
  // body completes synchronously before any `await` — the returned Promise resolves with no
  // observable async tail. `void` marks the discard deliberately (task 482, noFloatingPromises).
  void new MarkdownEditorProvider(context as any).resolveCustomTextEditor(
    document as any,
    panel as any,
  )
  return { document, panel }
}

// Task 505 — the `vmde.format.*` commands, now DERIVED from the shared `FORMAT_HOTKEYS` table
// (src/shared/format-hotkeys.ts) plus `UNBOUND_FORMAT_COMMANDS` (undo/redo). Real webview
// behaviour (no double-fire, native-execCommand guard, headings panel) is proven in
// test/vscode-e2e/format-hotkeys.spec.ts; this pins the host-side routing: each command resolves
// the active panel and posts the right `trigger-toolbar-hotkey` name, exactly once.
describe('commands: vmde.format.* (FORMAT_COMMANDS table)', () => {
  beforeEach(() => mock.reset())

  it('posts trigger-toolbar-hotkey with the matching toolbar name for a sample of commands', async () => {
    const uri = Uri.file('/workspace/note.md')
    mock.setActiveTab(new TabInputCustom(uri, VIEW_TYPE))
    resolveProvider(uri.fsPath)

    const samples: [string, string][] = [
      ['vmde.format.bold', 'bold'],
      ['vmde.format.headings', 'headings'],
      ['vmde.format.orderedList', 'ordered-list'],
      ['vmde.format.inlineCode', 'inline-code'],
      ['vmde.format.undo', 'undo'],
    ]
    for (const [command, toolbarName] of samples) {
      const run = activateAndGetCommand(command)
      await run()
      expect(mock.calls.postMessage).toContainEqual({
        command: 'trigger-toolbar-hotkey',
        name: toolbarName,
      })
    }
  })

  it('registers all 14 FORMAT_COMMANDS entries as real VS Code commands (12 keyed + undo/redo unbound)', () => {
    const context = mock.createExtensionContext()
    activate(context as any)
    for (const { command } of FORMAT_COMMANDS) {
      expect(
        mock.calls.registeredCommands.has(command),
        `${command} was not registered`,
      ).toBe(true)
    }
    expect(FORMAT_COMMANDS).toHaveLength(14)
  })

  it('registers no command under the deprecated namespace', () => {
    const context = mock.createExtensionContext()
    activate(context as any)
    expect(
      [...mock.calls.registeredCommands.keys()].filter((command) =>
        command.startsWith(FORMER_COMMAND_PREFIX),
      ),
    ).toEqual([])
  })

  it('is a silent no-op when no markdown panel can be resolved', async () => {
    const run = activateAndGetCommand('vmde.format.bold')
    await run()
    expect(mock.calls.postMessage).toHaveLength(0)
  })
})

describe('message handler: upload', () => {
  beforeEach(() => mock.reset())

  it('writes the decoded files under the assets folder and reports back', async () => {
    const { panel } = resolveProvider('/workspace/note.md')
    await panel._receiveMessage({
      command: 'upload',
      files: [{ base64: 'aGk=', name: 'img.png' }], // "hi"
    })

    expect(
      mock.calls.fsDirsCreated.some((u) => u.fsPath === '/workspace/assets'),
    ).toBe(true)

    expect(mock.calls.fsWrites).toHaveLength(1)
    expect(mock.calls.fsWrites[0].uri.fsPath).toBe('/workspace/assets/img.png')
    expect(Buffer.from(mock.calls.fsWrites[0].content).toString('utf8')).toBe(
      'hi',
    )

    expect(mock.calls.postMessage).toContainEqual({
      command: 'uploaded',
      files: ['assets/img.png'],
    })
  })

  it('refuses to write and warns when the workspace is untrusted', async () => {
    mock.setTrusted(false)
    const { panel } = resolveProvider('/workspace/note.md')
    await panel._receiveMessage({
      command: 'upload',
      files: [{ base64: 'aGk=', name: 'img.png' }],
    })
    expect(mock.calls.fsWrites).toHaveLength(0)
    expect(mock.calls.showWarning.length).toBeGreaterThan(0)
  })
})

describe('message handler: open-settings', () => {
  beforeEach(() => mock.reset())

  it('runs the openSettings command (toolbar gear → settings)', async () => {
    const { panel } = resolveProvider()
    await panel._receiveMessage({ command: 'open-settings' })
    expect(mock.calls.executeCommand).toContainEqual({
      command: 'vmde.openSettings',
      args: [],
    })
  })
})

describe('message handler: open-link', () => {
  beforeEach(() => mock.reset())

  it('opens an http(s) link in the external browser (env.openExternal)', async () => {
    const { panel } = resolveProvider()
    await panel._receiveMessage({
      command: 'open-link',
      href: 'https://example.com/page',
    })
    // external URLs go to the system browser, NOT vscode.open
    expect(mock.calls.openExternal.map((u) => u.toString())).toContain(
      'https://example.com/page',
    )
    expect(
      mock.calls.executeCommand.find((c) => c.command === 'vscode.open'),
    ).toBeUndefined()
  })

  it('resolves a relative link against the document directory', async () => {
    const { panel } = resolveProvider('/workspace/note.md')
    await panel._receiveMessage({ command: 'open-link', href: 'docs/page.md' })
    const call = mock.calls.executeCommand.find(
      (c) => c.command === 'vscode.open',
    )
    expect(call).toBeDefined()
    expect(call!.args[0].fsPath).toBe('/workspace/docs/page.md')
  })
})
