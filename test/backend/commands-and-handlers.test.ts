import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { activate, MarkdownEditorProvider } from '../../src/app/extension'
import {
  FIND_COMMANDS,
  FORMAT_COMMANDS,
  registerEditorActionCommand,
} from '../../src/app/commands'
import { EDITOR_SHORTCUTS } from '../../src/shared/editor-shortcuts'
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

describe('commands: VMDE Find widget', () => {
  beforeEach(() => mock.reset())

  it.each([
    ['vmde.find', 'find'],
    ['vmde.findReplace', 'replace'],
  ] as const)('%s opens the widget in %s mode', async (id, mode) => {
    const command = activateAndGetCommand(id)
    const uri = Uri.file('/workspace/note.md')
    const panel = mock.createWebviewPanel()
    const entry = { uri, panel }
    MarkdownEditorProvider.activePanels.add(entry as never)
    mock.setActiveTab(new TabInputCustom(uri, VIEW_TYPE))
    try {
      await command()
      expect(mock.calls.postMessage).toContainEqual({
        command: 'open-find-replace',
        mode,
      })
    } finally {
      MarkdownEditorProvider.activePanels.delete(entry as never)
    }
  })

  it.each([
    ['vmde.findNext', 'next'],
    ['vmde.findPrevious', 'previous'],
    ['vmde.toggleFindCaseSensitive', 'toggle-case'],
    ['vmde.toggleFindWholeWord', 'toggle-whole-word'],
    ['vmde.replaceOne', 'replace-one'],
    ['vmde.replaceAll', 'replace-all'],
    ['vmde.closeFindWidget', 'close'],
  ] as const)('%s posts the %s action', async (id, action) => {
    const run = activateAndGetCommand(id)
    const uri = Uri.file('/workspace/note.md')
    const panel = mock.createWebviewPanel()
    const entry = { uri, panel }
    MarkdownEditorProvider.activePanels.add(entry as never)
    mock.setActiveTab(new TabInputCustom(uri, VIEW_TYPE))
    try {
      await run()
      expect(mock.calls.postMessage).toEqual([
        { command: 'find-widget-action', action },
      ])
    } finally {
      MarkdownEditorProvider.activePanels.delete(entry as never)
    }
  })

  it('registers every Find command contributed by the manifest', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    )
    const manifestIds = pkg.contributes.commands
      .map((entry: { command: string }) => entry.command)
      .filter(
        (id: string) =>
          id.startsWith('vmde.find') ||
          id.startsWith('vmde.replace') ||
          id.startsWith('vmde.toggleFind') ||
          id === 'vmde.closeFindWidget',
      )
    expect(new Set(manifestIds)).toEqual(
      new Set([
        'vmde.find',
        'vmde.findReplace',
        ...FIND_COMMANDS.map(({ command }) => command),
      ]),
    )
    activate(mock.createExtensionContext() as any)
    for (const id of manifestIds) {
      expect(mock.calls.registeredCommands.has(id), id).toBe(true)
    }
  })
})

describe('command: vmde.turnInto', () => {
  beforeEach(() => mock.reset())

  it('asks only the active VMDE webview for source-derived target options', async () => {
    const command = activateAndGetCommand('vmde.turnInto')
    const uri = Uri.file('/workspace/note.md')
    const panel = mock.createWebviewPanel()
    const entry = { uri, panel }
    MarkdownEditorProvider.activePanels.add(entry as never)
    mock.setActiveTab(new TabInputCustom(uri, VIEW_TYPE))
    try {
      await command()
      expect(mock.calls.postMessage).toContainEqual({
        command: 'request-block-transform-options',
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

// Task 580 CP2-9 — the 13 unbound table commands and their editor actions.
const TABLE_COMMANDS = [
  ['vmde.table.alignLeft', 'table-align-left'],
  ['vmde.table.alignCenter', 'table-align-center'],
  ['vmde.table.alignRight', 'table-align-right'],
  ['vmde.table.insertRowAbove', 'table-insert-row-above'],
  ['vmde.table.insertRowBelow', 'table-insert-row-below'],
  ['vmde.table.insertColumnLeft', 'table-insert-column-left'],
  ['vmde.table.insertColumnRight', 'table-insert-column-right'],
  ['vmde.table.deleteRow', 'table-delete-row'],
  ['vmde.table.deleteColumn', 'table-delete-column'],
  ['vmde.table.moveColumnLeft', 'table-move-column-left'],
  ['vmde.table.moveColumnRight', 'table-move-column-right'],
  ['vmde.table.moveRowUp', 'table-move-row-up'],
  ['vmde.table.moveRowDown', 'table-move-row-down'],
] as const

// Task 580 CP2-10 — the unbound heading, edit-mode and task commands that replace Vditor's chords.
const VDITOR_CHORD_COMMANDS = [
  ['vmde.format.heading1', 'heading-1'],
  ['vmde.format.heading2', 'heading-2'],
  ['vmde.format.heading3', 'heading-3'],
  ['vmde.format.heading4', 'heading-4'],
  ['vmde.format.heading5', 'heading-5'],
  ['vmde.format.heading6', 'heading-6'],
  ['vmde.switchToWysiwyg', 'switch-to-wysiwyg'],
  ['vmde.switchToInstantRendering', 'switch-to-ir'],
  ['vmde.switchToSplitView', 'switch-to-sv'],
  ['vmde.toggleTaskCheckbox', 'toggle-task-checkbox'],
] as const

// Task 580 CP2-4 / CP2-5 / CP2-6 / CP2-9 / CP2-10 — Fold, Unfold, Move Block Up/Down, Select All,
// Expand Selection, the table commands and the Vditor chord commands reach the webview as editor
// actions.
describe('commands: vmde.fold, vmde.unfold, vmde.moveBlockUp/Down, vmde.selectAll and vmde.expandSelection', () => {
  beforeEach(() => mock.reset())

  it.each([
    ['vmde.fold', 'fold'],
    ['vmde.unfold', 'unfold'],
    ['vmde.moveBlockUp', 'move-block-up'],
    ['vmde.moveBlockDown', 'move-block-down'],
    ['vmde.selectAll', 'select-all'],
    ['vmde.expandSelection', 'expand-selection'],
    ...TABLE_COMMANDS,
    ...VDITOR_CHORD_COMMANDS,
  ] as const)(
    '%s posts the %s editor action to the active VMDE panel',
    async (id, action) => {
      const command = activateAndGetCommand(id)
      const uri = Uri.file('/workspace/note.md')
      const panel = mock.createWebviewPanel()
      const entry = { uri, panel }
      MarkdownEditorProvider.activePanels.add(entry as never)
      mock.setActiveTab(new TabInputCustom(uri, VIEW_TYPE))
      try {
        await command()
        expect(mock.calls.postMessage).toEqual([
          { command: 'editor-action', action },
        ])
      } finally {
        MarkdownEditorProvider.activePanels.delete(entry as never)
      }
    },
  )
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

  it('reopens the uri in the default (text) editor when no VMDE panel shows it', async () => {
    const openText = activateAndGetCommand('vmde.openTextEditor')
    const uri = Uri.file('/workspace/note.md')
    await openText(uri)
    expect(mock.calls.executeCommand).toContainEqual({
      command: 'vscode.openWith',
      args: [uri, 'default'],
    })
  })

  // Task 580 CP2-8 — the command takes the old webview Ctrl+Alt+E behavior: with a VMDE panel it
  // asks the webview for the caret and selects that line in the source (the `edit-in-vscode` path).
  it('opens the source at the caret line when a VMDE panel shows the uri', async () => {
    const text = 'first line\nsecond line here\nthird line\n'
    resolveProvider('/workspace/note.md', text)
    mock.setCursorReply({ line: 1, lineText: 'second line here' })
    const openText = activateAndGetCommand('vmde.openTextEditor')
    await openText(Uri.file('/workspace/note.md'))

    expect(mock.calls.postMessage).toContainEqual(
      expect.objectContaining({ command: 'get-cursor-offset' }),
    )
    expect(openWithCalls()).toHaveLength(0)
    const editor = mock.calls.shownTextEditors.at(-1)
    expect(editor.selection.active.line).toBe(1)
    expect(editor.selection.active.character).toBe('second line here'.length)
    expect(editor.revealRange).toHaveBeenCalled()
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

  // Task 580 CP2-7 — the section variants post the same message with `section: true`.
  it.each([
    ['vmde.promoteHeading', -1, false],
    ['vmde.demoteHeading', 1, false],
    ['vmde.promoteHeadingSection', -1, true],
    ['vmde.demoteHeadingSection', 1, true],
  ] as const)(
    'forwards %s to the active visual editor',
    async (id, direction, section) => {
      const uri = Uri.file('/workspace/note.md')
      mock.setActiveTab(new TabInputCustom(uri, VIEW_TYPE))
      resolveProvider(uri.fsPath)

      await activateAndGetCommand(id)()

      expect(mock.calls.postMessage).toContainEqual({
        command: 'shift-heading-level',
        direction,
        section,
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
// (src/shared/format-hotkeys.ts) plus `HISTORY_FORMAT_COMMANDS` (undo/redo). Real webview
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

// Task 580 CP2-1 — the generic host half of an `editor-action` command; each conversion step wires
// its own commands with its binding and webview runner (Fold and Unfold since CP2-4, Move Block
// Up/Down since CP2-5, Select All and Expand Selection since CP2-6).
describe('commands: editor-action registration helper (Task 580)', () => {
  beforeEach(() => mock.reset())

  function registerProbe(panel: unknown) {
    const context = mock.createExtensionContext()
    registerEditorActionCommand(
      context as any,
      {
        debug: () => undefined,
        showError: () => undefined,
        revealCaretInSource: async () => undefined,
        findPanelForUri: () => (panel ? { panel: panel as never } : undefined),
      },
      'vmde.test.editorAction',
      'fold',
    )
    return {
      context,
      run: mock.calls.registeredCommands.get('vmde.test.editorAction')!,
    }
  }

  it('posts one editor-action message to the active VMDE panel', async () => {
    const uri = Uri.file('/workspace/note.md')
    mock.setActiveTab(new TabInputCustom(uri, VIEW_TYPE))
    const { context, run } = registerProbe(mock.createWebviewPanel())
    await run()
    expect(mock.calls.postMessage).toEqual([
      { command: 'editor-action', action: 'fold' },
    ])
    expect(context.subscriptions).toHaveLength(1)
  })

  it('is a silent no-op when no VMDE panel is showing the active document', async () => {
    const uri = Uri.file('/workspace/note.md')
    mock.setActiveTab(new TabInputCustom(uri, VIEW_TYPE))
    const { run } = registerProbe(undefined)
    await run()
    expect(mock.calls.postMessage).toHaveLength(0)
  })

  // Each conversion step moves its commands from the pending list to the registered list.
  it('registers only the converted editor-action commands at activation', () => {
    const context = mock.createExtensionContext()
    activate(context as any)
    const registered = [
      'vmde.fold',
      'vmde.unfold',
      'vmde.moveBlockUp',
      'vmde.moveBlockDown',
      'vmde.selectAll',
      'vmde.expandSelection',
      ...TABLE_COMMANDS.map(([command]) => command),
      ...VDITOR_CHORD_COMMANDS.map(([command]) => command),
    ]
    const pending = EDITOR_SHORTCUTS.filter(
      (row) => row.route !== 'host' && row.route.command === 'editor-action',
    )
      .map((row) => row.command)
      .filter((command) => !registered.includes(command))
    // CP2-10 converted the last editor-action rows of the shared table.
    expect(pending).toEqual([])
    for (const command of registered)
      expect(mock.calls.registeredCommands.has(command), command).toBe(true)
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
