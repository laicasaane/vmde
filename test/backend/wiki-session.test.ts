import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listWikiPages, WikiSession } from '../../src/wiki/wiki-session'
import { _resetCacheMap } from '../../src/wiki/wiki-cache'
import { FileType, mock, Uri } from './vscode-mock'

// Task 405 — the per-session wiki context (this.wiki / this.lastWikiRoot in
// EditorSession) + onListWikiPages, extracted into their own unit. Behaviour mirrored
// exactly from onReady()/the config-change listener/onListWikiPages: the enabled flag +
// rootLabel come from getWikiDocumentContext, the init payload adds pageKeys/displayNames
// ONLY when a wiki root actually resolves, and lastWikiRoot is set unconditionally (even
// to undefined) so a later config change knows whether there's a cache to invalidate.

const F = FileType.File

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

describe('WikiSession', () => {
  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
    mock.setWorkspaceFolder('/ws')
  })

  it('a non-wiki document: context is disabled, no pageKeys/displayNames, nothing pending', async () => {
    mock.setConfig({ enabled: false })
    const session = new WikiSession(Uri.file('/ws/note.md'))
    expect(session.context.enabled).toBe(false)
    const plan = session.planInit(Uri.file('/ws/note.md'), () => {
      /* post no-op — these tests only assert on the returned plan */
    })
    expect(plan.payload).toEqual({ enabled: false })
    expect(plan.pending).toBeUndefined()
  })

  it('a wiki document: the init has no keys while the scan runs; the pending build delivers pageKeys + displayNames from the shared cache', async () => {
    mock.setConfig({ enabled: true, root: '' })
    mountFs({
      '/ws': [
        ['Home.md', F],
        ['Other.md', F],
      ],
    })
    const session = new WikiSession(Uri.file('/ws/Home.md'))
    expect(session.context.enabled).toBe(true)
    const plan = session.planInit(Uri.file('/ws/Home.md'), () => {
      /* post no-op — these tests only assert on the returned plan */
    })
    expect(plan.payload.enabled).toBe(true)
    expect(plan.payload).not.toHaveProperty('pageKeys')
    expect(plan.pending).toBeDefined()

    const delivered: Array<{ pageKeys: string[]; displayNames: string[] }> = []
    await session.deliverPending(plan, (keys) => delivered.push(keys))
    expect(delivered).toHaveLength(1)
    expect(delivered[0].pageKeys).toEqual(
      expect.arrayContaining(['home', 'other']),
    )
    expect(delivered[0].displayNames).toEqual(
      expect.arrayContaining(['Home', 'Other']),
    )

    // Once the cache is built, the next init carries the keys itself and nothing is pending.
    const builtPlan = session.planInit(Uri.file('/ws/Home.md'), () => {
      /* post no-op */
    })
    expect(builtPlan.payload.pageKeys).toEqual(
      expect.arrayContaining(['home', 'other']),
    )
    expect(builtPlan.pending).toBeUndefined()
  })

  it('onConfigChanged invalidates the previous root cache and recomputes context', async () => {
    mock.setConfig({ enabled: true, root: '' })
    mountFs({ '/ws': [['Home.md', F]] })
    const session = new WikiSession(Uri.file('/ws/Home.md'))
    const plan = session.planInit(Uri.file('/ws/Home.md'), () => {
      /* post no-op — these tests only assert on the returned plan */
    })
    await plan.pending

    // Disable wiki via config, then let the session pick that up.
    mock.setConfig({ enabled: false })
    session.onConfigChanged(Uri.file('/ws/Home.md'))
    expect(session.context.enabled).toBe(false)
  })

  it('a config change or dispose after the plan drops its pending delivery', async () => {
    mock.setConfig({ enabled: true, root: '' })
    mountFs({ '/ws': [['Home.md', F]] })
    const uri = Uri.file('/ws/Home.md')
    const session = new WikiSession(uri)
    const post = vi.fn()

    const first = session.planInit(uri, () => undefined)
    session.onConfigChanged(uri)
    await session.deliverPending(first, post)

    const second = session.planInit(uri, () => undefined)
    session.dispose()
    await session.deliverPending(second, post)

    expect(post).not.toHaveBeenCalled()
  })
})

describe('listWikiPages', () => {
  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
    mock.setWorkspaceFolder('/ws')
    mock.setConfig({ enabled: true, root: '' })
  })

  it('lists pages and opens the picked one', async () => {
    mountFs({
      '/ws': [
        ['Home.md', F],
        ['Other.md', F],
      ],
    })
    mock.setQuickPickResponse({ uri: Uri.file('/ws/Other.md') })
    await listWikiPages(Uri.file('/ws/Home.md'))
    expect(
      mock.calls.executeCommand.some(
        (c) =>
          c.command === 'vscode.openWith' &&
          c.args[0].fsPath === '/ws/Other.md',
      ),
    ).toBe(true)
  })

  it('does nothing when there is no wiki root', async () => {
    mock.setConfig({ enabled: false })
    await listWikiPages(Uri.file('/ws/note.md'))
    expect(mock.calls.executeCommand).toHaveLength(0)
  })

  it('opens nothing when the quick pick is dismissed', async () => {
    mountFs({ '/ws': [['Home.md', F]] })
    mock.setQuickPickResponse(undefined)
    await listWikiPages(Uri.file('/ws/Home.md'))
    expect(mock.calls.executeCommand).toHaveLength(0)
  })
})
