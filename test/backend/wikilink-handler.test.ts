import { beforeEach, describe, expect, it } from 'vitest'
import { MarkdownEditorProvider } from '../../src/app/extension'
import { _resetCacheMap } from '../../src/wiki/wiki-cache'
import { FileType, mock, Uri } from './vscode-mock'

const F = FileType.File
const D = FileType.Directory
const VIEW = 'vmde.editor'

// Task 636 — the wiki page scan is one workspace search, so the virtual tree is flattened into the
// file list the mock search runs over (directory entries only matter as path prefixes).
function mountFs(tree: Record<string, [string, number][]>) {
  mock.setWorkspaceFiles(
    Object.entries(tree).flatMap(([dir, entries]) =>
      entries
        .filter(([, type]) => type === FileType.File)
        .map(([name]) => `${dir}/${name}`),
    ),
  )
}

function openWiki(fsPath = '/ws/Home.md') {
  mock.setWorkspaceFolder('/ws')
  mock.setConfig({ enabled: true, root: '' })
  const context = mock.createExtensionContext()
  const document = mock.createTextDocument(fsPath, '# Home\n')
  const panel = mock.createWebviewPanel()
  // resolveCustomTextEditor is `async`, but for a conflict-free document (every test here) its
  // body completes synchronously before any `await` — the returned Promise resolves with no
  // observable async tail. `void` marks the discard deliberately (task 482, noFloatingPromises).
  void new MarkdownEditorProvider(context as any).resolveCustomTextEditor(
    document as any,
    panel as any,
  )
  return panel
}

function openWithCalls() {
  return mock.calls.executeCommand.filter(
    (c) => c.command === 'vscode.openWith',
  )
}

describe('message handler: open-wikilink', () => {
  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
  })

  it('opens a uniquely-resolved page in the custom editor', async () => {
    mountFs({
      '/ws': [
        ['Home.md', F],
        ['Other Page.md', F],
      ],
    })
    const panel = openWiki()
    await panel._receiveMessage({
      command: 'open-wikilink',
      target: 'Other Page',
    })
    expect(
      openWithCalls().some(
        (c) => c.args[0].fsPath === '/ws/Other Page.md' && c.args[1] === VIEW,
      ),
    ).toBe(true)
  })

  it('errors and opens nothing when wiki is disabled', async () => {
    mountFs({})
    mock.setWorkspaceFolder('/ws')
    mock.setConfig({ enabled: false })
    _resetCacheMap()
    const context = mock.createExtensionContext()
    const document = mock.createTextDocument('/ws/note.md', '# Note\n')
    const panel = mock.createWebviewPanel()
    ;new (await import('../../src/app/extension')).MarkdownEditorProvider(
      context as any,
    ).resolveCustomTextEditor(document as any, panel as any)
    await panel._receiveMessage({ command: 'open-wikilink', target: 'Home' })
    expect(mock.calls.showError.length).toBeGreaterThan(0)
    expect(openWithCalls()).toHaveLength(0)
  })

  it('errors on an empty/invalid target', async () => {
    mountFs({ '/ws': [['Home.md', F]] })
    const panel = openWiki()
    await panel._receiveMessage({ command: 'open-wikilink', target: '   ' })
    expect(mock.calls.showError.length).toBeGreaterThan(0)
    expect(openWithCalls()).toHaveLength(0)
  })

  it('creates a missing page (with a title heading) on confirm, then opens it', async () => {
    mountFs({ '/ws': [['Home.md', F]] })
    mock.setWarningResponse('Create Page')
    mock.setTrusted(true)
    const panel = openWiki()
    await panel._receiveMessage({
      command: 'open-wikilink',
      target: 'New Topic',
    })
    const write = mock.calls.fsWrites.find(
      (w) => w.uri.fsPath === '/ws/new-topic.md',
    )
    expect(write).toBeDefined()
    expect(Buffer.from(write!.content).toString()).toBe('# New Topic\n')
    expect(
      openWithCalls().some((c) => c.args[0].fsPath === '/ws/new-topic.md'),
    ).toBe(true)
  })

  it('creates nothing when the missing-page prompt is dismissed', async () => {
    mountFs({ '/ws': [['Home.md', F]] })
    mock.setWarningResponse(undefined)
    const panel = openWiki()
    await panel._receiveMessage({
      command: 'open-wikilink',
      target: 'New Topic',
    })
    expect(mock.calls.fsWrites).toHaveLength(0)
    expect(openWithCalls()).toHaveLength(0)
  })

  it('lets the user pick among ambiguous matches, then opens the choice', async () => {
    mountFs({
      '/ws': [
        ['Home.md', F],
        ['a', D],
        ['b', D],
      ],
      '/ws/a': [['Page.md', F]],
      '/ws/b': [['Page.md', F]],
    })
    mock.setQuickPickResponse({ uri: Uri.file('/ws/b/Page.md') })
    const panel = openWiki()
    await panel._receiveMessage({ command: 'open-wikilink', target: 'Page' })
    expect(
      openWithCalls().some((c) => c.args[0].fsPath === '/ws/b/Page.md'),
    ).toBe(true)
  })
})

describe('message handler: list-wiki-pages', () => {
  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
  })

  it('lists the wiki pages and opens the chosen one', async () => {
    mountFs({
      '/ws': [
        ['Home.md', F],
        ['Other.md', F],
      ],
    })
    mock.setQuickPickResponse({ uri: Uri.file('/ws/Other.md') })
    const panel = openWiki()
    await panel._receiveMessage({ command: 'list-wiki-pages' })
    expect(
      openWithCalls().some((c) => c.args[0].fsPath === '/ws/Other.md'),
    ).toBe(true)
  })

  it('opens nothing when wiki is disabled', async () => {
    mock.setWorkspaceFolder('/ws')
    mock.setConfig({ enabled: false })
    _resetCacheMap()
    const context = mock.createExtensionContext()
    const document = mock.createTextDocument('/ws/note.md', '# Note\n')
    const panel = mock.createWebviewPanel()
    ;new (await import('../../src/app/extension')).MarkdownEditorProvider(
      context as any,
    ).resolveCustomTextEditor(document as any, panel as any)
    await panel._receiveMessage({ command: 'list-wiki-pages' })
    expect(openWithCalls()).toHaveLength(0)
  })
})
