import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { listWikiPages, WikiSession } from '../../src/wiki/wiki-session'
import {
  _resetCacheMap,
  getOrBuildCache,
  peekBuiltCache,
} from '../../src/wiki/wiki-cache'
import {
  configureWikiKeyStore,
  readStoredKeys,
} from '../../src/wiki/wiki-key-store'
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

// Task 637 — a config change only invalidates what actually changed (C4): the effective root or the
// enabled state. Another editor on the same root keeps its fresh cache and watcher subscription.
describe('WikiSession config change invalidation (task 637)', () => {
  const uri = Uri.file('/ws/Home.md')

  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
    mock.setWorkspaceFolder('/ws')
    mountFs({
      '/ws': [['Home.md', F]],
      '/ws/alpha': [['Alpha.md', F]],
    })
  })

  async function planBuilt(session: WikiSession, onChanged = () => undefined) {
    const plan = session.planInit(uri, onChanged)
    await plan.pending
    return session.planInit(uri, onChanged)
  }

  it('C4 an unchanged effective root keeps the built cache', async () => {
    mock.setConfig({ enabled: true, root: '' })
    const session = new WikiSession(uri)
    await planBuilt(session)
    const built = peekBuiltCache(Uri.file('/ws'))
    expect(built).toBeDefined()

    session.onConfigChanged(uri)

    expect(peekBuiltCache(Uri.file('/ws'))).toBe(built)
  })

  it('C4 an unchanged effective root keeps the watcher subscription', async () => {
    mock.setConfig({ enabled: true, root: '' })
    const session = new WikiSession(uri)
    const onChanged = vi.fn()
    await planBuilt(session, onChanged)

    session.onConfigChanged(uri)
    for (const watcher of mock.state.watchers)
      watcher._fireCreate(Uri.file('/ws/Fresh.md'))
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('C4 one session changing nothing leaves another session on the same root with its cache', async () => {
    mock.setConfig({ enabled: true, root: '' })
    const first = new WikiSession(uri)
    const second = new WikiSession(uri)
    await planBuilt(first)
    await planBuilt(second)
    const built = peekBuiltCache(Uri.file('/ws'))

    first.onConfigChanged(uri)

    expect(peekBuiltCache(Uri.file('/ws'))).toBe(built)
    expect(built).toBeDefined()
  })

  it('C4 a root change invalidates the old root cache and leaves another root cache alone', async () => {
    mock.setConfig({ enabled: true, root: '' })
    const session = new WikiSession(uri)
    await planBuilt(session)
    const other = await getOrBuildCache(Uri.file('/ws/alpha'))
    expect(peekBuiltCache(Uri.file('/ws'))).toBeDefined()

    mock.setConfig({ root: 'alpha' })
    session.onConfigChanged(uri)

    expect(peekBuiltCache(Uri.file('/ws'))).toBeUndefined()
    expect(peekBuiltCache(Uri.file('/ws/alpha'))).toBe(other)
  })

  it('C3 disabling invalidates the old root cache', async () => {
    mock.setConfig({ enabled: true, root: '' })
    const session = new WikiSession(uri)
    await planBuilt(session)

    mock.setConfig({ enabled: false })
    session.onConfigChanged(uri)

    expect(peekBuiltCache(Uri.file('/ws'))).toBeUndefined()
    expect(session.context.enabled).toBe(false)
  })
})

// Task 638 — a stored page list is served in `init` while the usual background scan revalidates it.
// The webview gets a `wiki-update` only when the scan differs from what `init` carried.
describe('WikiSession persisted page list (task 638)', () => {
  const uri = Uri.file('/ws/Home.md')
  const ENTRY_KEY = 'vmde.wikiPages:file:///ws'
  const noop = () => undefined
  const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
  let workspaceState: ReturnType<
    typeof mock.createExtensionContext
  >['workspaceState']

  const entry = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    root: 'file:///ws',
    savedAt: 1_700_000_000_000,
    pageKeys: ['home'],
    displayNames: ['Home'],
    ...overrides,
  })
  const seed = (value: unknown, key = ENTRY_KEY) => {
    mock.state.workspaceState[key] = value
  }
  const writesOf = (key = ENTRY_KEY) =>
    (workspaceState.update as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([k, value]) => k === key && value !== undefined,
    )

  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
    mock.setWorkspaceFolder('/ws')
    mock.setConfig({ enabled: true, root: '' })
    workspaceState = mock.createExtensionContext().workspaceState
    configureWikiKeyStore(workspaceState as any)
  })

  afterEach(() => configureWikiKeyStore(undefined))

  async function deliver(
    session: WikiSession,
    plan: ReturnType<WikiSession['planInit']>,
  ) {
    const delivered: Array<{ pageKeys: string[]; displayNames: string[] }> = []
    await session.deliverPending(plan, (keys) => delivered.push(keys))
    return delivered
  }

  it('A1 a stored list with no built cache is the init payload, and the scan is still pending', () => {
    seed(
      entry({
        pageKeys: ['home', 'old-page'],
        displayNames: ['Home', 'Old Page'],
      }),
    )
    mountFs({ '/ws': [['Home.md', F]] })

    const plan = new WikiSession(uri).planInit(uri, noop)

    expect(plan.payload.enabled).toBe(true)
    expect(plan.payload.pageKeys).toEqual(['home', 'old-page'])
    expect(plan.payload.displayNames).toEqual(['Home', 'Old Page'])
    expect(plan.pending).toBeDefined()
  })

  it('A2 revalidation posts nothing when the scan equals the stored list', async () => {
    seed(
      entry({ pageKeys: ['home', 'other'], displayNames: ['Home', 'Other'] }),
    )
    mountFs({
      '/ws': [
        ['Home.md', F],
        ['Other.md', F],
      ],
    })
    const session = new WikiSession(uri)

    const delivered = await deliver(session, session.planInit(uri, noop))

    expect(delivered).toEqual([])
  })

  it.each([
    [
      'a page added while closed',
      [
        ['Home.md', F],
        ['Added.md', F],
      ] as [string, number][],
      { pageKeys: ['added', 'home'], displayNames: ['Added', 'Home'] },
    ],
    [
      'a page removed while closed',
      [['Home.md', F]] as [string, number][],
      { pageKeys: ['home'], displayNames: ['Home'] },
    ],
    [
      'a page renamed while closed',
      [
        ['Home.md', F],
        ['Renamed.md', F],
      ] as [string, number][],
      { pageKeys: ['home', 'renamed'], displayNames: ['Home', 'Renamed'] },
    ],
  ])(
    'A2/A3 %s: one post with the scanned list, and the store holds it',
    async (_label, files, fresh) => {
      seed(
        entry({ pageKeys: ['home', 'other'], displayNames: ['Home', 'Other'] }),
      )
      mountFs({ '/ws': files })
      const session = new WikiSession(uri)

      const delivered = await deliver(session, session.planInit(uri, noop))
      await settle()

      expect(delivered).toEqual([fresh])
      expect(readStoredKeys(Uri.file('/ws'))).toEqual(fresh)
    },
  )

  it('A3 only the display names differing still posts (same basename in two folders)', async () => {
    seed(
      entry({
        pageKeys: ['a/page', 'b/page', 'page'],
        displayNames: ['Page'],
      }),
    )
    mountFs({
      '/ws/a': [['Page.md', F]],
      '/ws/b': [['Page.md', F]],
    })
    const session = new WikiSession(uri)

    const delivered = await deliver(session, session.planInit(uri, noop))

    expect(delivered).toEqual([
      {
        pageKeys: ['a/page', 'b/page', 'page'],
        displayNames: ['a/Page', 'b/Page'],
      },
    ])
  })

  it('a built cache wins over the stored list', async () => {
    mountFs({ '/ws': [['Home.md', F]] })
    await getOrBuildCache(Uri.file('/ws'))
    seed(entry({ pageKeys: ['stale'], displayNames: ['Stale'] }))

    const plan = new WikiSession(uri).planInit(uri, noop)

    expect(plan.payload.pageKeys).toEqual(['home'])
    expect(plan.pending).toBeUndefined()
  })

  it.each([
    ['unreadable', 'not an object'],
    ['old-schema', entry({ version: 0 })],
    ['wrong-root', entry({ root: 'file:///other' })],
    [
      'oversize',
      entry({ pageKeys: Array.from({ length: 20_001 }, (_, i) => `k${i}`) }),
    ],
  ])(
    "A5 an %s stored value gives today's init without keys and a pending scan",
    (_label, value) => {
      seed(value)
      mountFs({ '/ws': [['Home.md', F]] })

      const plan = new WikiSession(uri).planInit(uri, noop)

      expect(plan.payload).not.toHaveProperty('pageKeys')
      expect(plan.pending).toBeDefined()
    },
  )

  it('A5 an ignored stored value is replaced by the scanned list', async () => {
    seed(entry({ version: 2 }))
    mountFs({ '/ws': [['Home.md', F]] })
    const session = new WikiSession(uri)

    const delivered = await deliver(session, session.planInit(uri, noop))
    await settle()

    expect(delivered).toHaveLength(1)
    expect(readStoredKeys(Uri.file('/ws'))).toEqual({
      pageKeys: ['home'],
      displayNames: ['Home'],
    })
  })

  it('a disabled wiki reads nothing and carries no keys', () => {
    seed(entry())
    mock.setConfig({ enabled: false })
    const get = workspaceState.get as unknown as ReturnType<typeof vi.fn>
    const spy = vi.fn(get)
    configureWikiKeyStore({ ...workspaceState, get: spy } as any)

    const plan = new WikiSession(uri).planInit(uri, noop)

    expect(plan.payload).toEqual({ enabled: false })
    expect(plan.pending).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })

  it('A4 a root change deletes the old root entry and keeps the new root entry', async () => {
    seed(entry())
    seed(
      entry({
        root: 'file:///ws/alpha',
        pageKeys: ['alpha'],
        displayNames: ['Alpha'],
      }),
      'vmde.wikiPages:file:///ws/alpha',
    )
    mountFs({ '/ws': [['Home.md', F]], '/ws/alpha': [['Alpha.md', F]] })
    const session = new WikiSession(uri)
    session.planInit(uri, noop)

    mock.setConfig({ root: 'alpha' })
    session.onConfigChanged(uri)
    await settle()

    expect(mock.state.workspaceState[ENTRY_KEY]).toBeUndefined()
    expect(readStoredKeys(Uri.file('/ws/alpha'))?.pageKeys).toEqual(['alpha'])
    // The re-plan for the new root serves the new root's stored list.
    const replan = session.planInit(uri, noop)
    expect(replan.payload.pageKeys).toEqual(['alpha'])
  })

  it('A4 disabling the wiki deletes the entry of the root that was in use', async () => {
    seed(entry())
    mountFs({ '/ws': [['Home.md', F]] })
    const session = new WikiSession(uri)
    session.planInit(uri, noop)

    mock.setConfig({ enabled: false })
    session.onConfigChanged(uri)
    await settle()

    expect(mock.state.workspaceState[ENTRY_KEY]).toBeUndefined()
  })

  it('C4 an unchanged effective root keeps the entry', async () => {
    seed(entry())
    mountFs({ '/ws': [['Home.md', F]] })
    const session = new WikiSession(uri)
    session.planInit(uri, noop)

    session.onConfigChanged(uri)
    await settle()

    expect(readStoredKeys(Uri.file('/ws'))).toBeDefined()
  })

  it('C4 two sessions on one root serve the same stored list, share one scan and cause one write', async () => {
    seed(
      entry({ pageKeys: ['home', 'stale'], displayNames: ['Home', 'Stale'] }),
    )
    mountFs({ '/ws': [['Home.md', F]] })
    const first = new WikiSession(uri)
    const second = new WikiSession(uri)

    const firstPlan = first.planInit(uri, noop)
    const secondPlan = second.planInit(uri, noop)
    const [a, b] = await Promise.all([
      deliver(first, firstPlan),
      deliver(second, secondPlan),
    ])
    await settle()

    expect(firstPlan.payload.pageKeys).toEqual(['home', 'stale'])
    expect(secondPlan.payload.pageKeys).toEqual(['home', 'stale'])
    const fresh = { pageKeys: ['home'], displayNames: ['Home'] }
    expect(a).toEqual([fresh])
    expect(b).toEqual([fresh])
    expect(mock.calls.findFiles).toHaveLength(1)
    expect(writesOf()).toHaveLength(1)
  })

  it('a config change after a served plan drops the old delivery and stores nothing from the superseded build', async () => {
    seed(
      entry({ pageKeys: ['home', 'stale'], displayNames: ['Home', 'Stale'] }),
    )
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mock.setFindFiles(async () => {
      await gate
      return [vscode.Uri.file('/ws/Home.md')]
    })
    const session = new WikiSession(uri)
    const plan = session.planInit(uri, noop)
    const post = vi.fn()
    const delivery = session.deliverPending(plan, post)

    mock.setConfig({ root: 'alpha' })
    session.onConfigChanged(uri)
    release()
    await delivery
    await settle()

    expect(post).not.toHaveBeenCalled()
    expect(mock.state.workspaceState[ENTRY_KEY]).toBeUndefined()
  })

  it('dispose while revalidating posts nothing, and the shared build still stores its result', async () => {
    seed(
      entry({ pageKeys: ['home', 'stale'], displayNames: ['Home', 'Stale'] }),
    )
    mountFs({ '/ws': [['Home.md', F]] })
    const session = new WikiSession(uri)
    const post = vi.fn()
    const plan = session.planInit(uri, noop)
    const delivery = session.deliverPending(plan, post)

    session.dispose()
    await delivery
    await plan.pending
    await settle()

    expect(post).not.toHaveBeenCalled()
    expect(readStoredKeys(Uri.file('/ws'))).toEqual({
      pageKeys: ['home'],
      displayNames: ['Home'],
    })
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
