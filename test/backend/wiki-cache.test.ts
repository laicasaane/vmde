import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import {
  WikiCache,
  _resetCacheMap,
  extractWikiTargets,
  getOrBuildCache,
  invalidateCache,
} from '../../src/wiki/wiki-cache'
import { normalizeWikiLookupKey } from '../../src/shared/wiki-core'
import { FileType, mock, Uri } from './vscode-mock'

const F = FileType.File
const D = FileType.Directory

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

describe('WikiCache', () => {
  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
  })

  it('indexes files and resolves by basename key', async () => {
    mountFs({
      '/ws/wiki': [
        ['Home.md', F],
        ['My Page.md', F],
      ],
    })
    const cache = await WikiCache.build(Uri.file('/ws/wiki'))
    expect(cache.has('home')).toBe(true)
    expect(cache.has('my-page')).toBe(true)
    expect(cache.has('nonexistent')).toBe(false)
    cache.dispose()
  })

  it('resolves by relative path key for nested files', async () => {
    mountFs({
      '/ws/wiki': [['sub', D]],
      '/ws/wiki/sub': [['Deep Page.md', F]],
    })
    const cache = await WikiCache.build(Uri.file('/ws/wiki'))
    expect(cache.has('sub/deep-page')).toBe(true)
    expect(cache.has('deep-page')).toBe(true)
    expect(cache.resolve('deep-page')).toHaveLength(1)
    expect(cache.resolve('deep-page')[0].fsPath).toBe(
      '/ws/wiki/sub/Deep Page.md',
    )
    cache.dispose()
  })

  it('returns multiple matches for ambiguous basename', async () => {
    mountFs({
      '/ws/wiki': [
        ['a', D],
        ['b', D],
      ],
      '/ws/wiki/a': [['Page.md', F]],
      '/ws/wiki/b': [['Page.md', F]],
    })
    const cache = await WikiCache.build(Uri.file('/ws/wiki'))
    const matches = cache.resolve('page')
    expect(matches).toHaveLength(2)
    cache.dispose()
  })

  it('allPageKeys returns sorted deduplicated keys', async () => {
    mountFs({
      '/ws/wiki': [
        ['Alpha.md', F],
        ['sub', D],
      ],
      '/ws/wiki/sub': [['Beta.md', F]],
    })
    const cache = await WikiCache.build(Uri.file('/ws/wiki'))
    const keys = cache.allPageKeys()
    expect(keys).toContain('alpha')
    expect(keys).toContain('beta')
    expect(keys).toContain('sub/beta')
    expect(keys).toEqual([...keys].sort())
    cache.dispose()
  })

  it('allDisplayNames returns original-cased basenames without extension', async () => {
    mountFs({
      '/ws/wiki': [
        ['Home.md', F],
        ['Getting Started.md', F],
        ['sub', D],
      ],
      '/ws/wiki/sub': [['Deep Page.md', F]],
    })
    const cache = await WikiCache.build(Uri.file('/ws/wiki'))
    const names = cache.allDisplayNames()
    expect(names).toContain('Home')
    expect(names).toContain('Getting Started')
    expect(names).toContain('Deep Page')
    // No extension, no lowercasing, no slugification
    expect(names).not.toContain('home')
    expect(names).not.toContain('getting-started')
    cache.dispose()
  })

  it('path-qualifies display names for duplicate basenames', async () => {
    mountFs({
      '/ws/wiki': [
        ['Home.md', F], // unique basename → stays bare
        ['a', D],
        ['b', D],
      ],
      '/ws/wiki/a': [['Page.md', F]], // Page.md exists in two dirs
      '/ws/wiki/b': [['Page.md', F]],
    })
    const cache = await WikiCache.build(Uri.file('/ws/wiki'))
    const names = cache.allDisplayNames()
    // Unique basename: bare
    expect(names).toContain('Home')
    // Duplicate basename: path-qualified, NOT a bare "Page"
    expect(names).toContain('a/Page')
    expect(names).toContain('b/Page')
    expect(names).not.toContain('Page')
    // Each qualified name resolves to exactly one file
    expect(cache.resolve(normalizeWikiLookupKey('a/Page'))).toHaveLength(1)
    expect(cache.resolve(normalizeWikiLookupKey('b/Page'))).toHaveLength(1)
    cache.dispose()
  })

  it('every display name normalizes to a key present in allPageKeys', async () => {
    // Guards the hint↔missing-check contract: a page offered in the autocomplete
    // (display name) must resolve to a known key, or its chip renders as a broken
    // (red) link even though the page exists.
    mountFs({
      '/ws/wiki': [
        ['Home.md', F],
        ['Getting Started.md', F],
        ['C++ Notes.md', F],
        ['sub', D],
        ['other', D],
      ],
      // Deep Page is unique; Dup exists in two dirs (path-qualified display names)
      '/ws/wiki/sub': [
        ['Deep Page.md', F],
        ['Dup.md', F],
      ],
      '/ws/wiki/other': [['Dup.md', F]],
    })
    const cache = await WikiCache.build(Uri.file('/ws/wiki'))
    const keys = new Set(cache.allPageKeys())
    const names = cache.allDisplayNames()
    expect(names).toContain('sub/Dup')
    expect(names).toContain('other/Dup')
    for (const name of names) {
      expect(keys.has(normalizeWikiLookupKey(name))).toBe(true)
    }
    cache.dispose()
  })

  it('allFiles returns unique sorted files', async () => {
    mountFs({
      '/ws/wiki': [
        ['A.md', F],
        ['B.md', F],
      ],
    })
    const cache = await WikiCache.build(Uri.file('/ws/wiki'))
    const files = cache.allFiles()
    expect(files).toHaveLength(2)
    expect(files[0].fsPath).toBe('/ws/wiki/A.md')
    expect(files[1].fsPath).toBe('/ws/wiki/B.md')
    cache.dispose()
  })
})

describe('getOrBuildCache — singleton per root', () => {
  const searchCount = () => mock.calls.findFiles.length

  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
    mock.setWorkspaceFiles(['/ws/wiki/A.md', '/ws/wiki/B.md'])
  })

  it('builds cache on first call and reuses on second', async () => {
    const c1 = await getOrBuildCache(Uri.file('/ws/wiki'))
    const after1 = searchCount()
    const c2 = await getOrBuildCache(Uri.file('/ws/wiki'))
    const after2 = searchCount()

    expect(c1).toBe(c2)
    expect(after1).toBe(1)
    expect(after2).toBe(1) // no additional scan
    c1.dispose()
  })

  it('concurrent calls share the same build promise', async () => {
    const [c1, c2] = await Promise.all([
      getOrBuildCache(Uri.file('/ws/wiki')),
      getOrBuildCache(Uri.file('/ws/wiki')),
    ])
    expect(c1).toBe(c2)
    expect(searchCount()).toBe(1)
    c1.dispose()
  })
})

describe('invalidateCache — clears a specific root', () => {
  const searchCount = () => mock.calls.findFiles.length

  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
    mock.setWorkspaceFiles(['/ws/A.md', '/ws/docs/B.md'])
  })

  it('forces a rebuild on the next getOrBuildCache call', async () => {
    const c1 = await getOrBuildCache(Uri.file('/ws'))
    const afterBuild = searchCount()
    expect(c1.has('a')).toBe(true)

    invalidateCache(Uri.file('/ws'))

    const c2 = await getOrBuildCache(Uri.file('/ws'))
    expect(c2).not.toBe(c1) // new instance
    expect(searchCount()).toBe(afterBuild + 1) // one re-scan
    c2.dispose()
  })

  it('does not affect caches for other roots', async () => {
    // Build the /ws cache so the invalidateCache('/ws') below has something to drop;
    // the instance itself isn't asserted here (the /ws/docs cache is what matters).
    await getOrBuildCache(Uri.file('/ws'))
    const c2 = await getOrBuildCache(Uri.file('/ws/docs'))
    const afterBuild = searchCount()

    invalidateCache(Uri.file('/ws'))

    // /ws/docs cache still valid
    const c2Again = await getOrBuildCache(Uri.file('/ws/docs'))
    expect(c2Again).toBe(c2)
    expect(searchCount()).toBe(afterBuild) // no re-scan for docs
    c2.dispose()
  })

  it('is safe to call on a root that has no cache', () => {
    expect(() => invalidateCache(Uri.file('/nonexistent'))).not.toThrow()
  })
})

describe('extractWikiTargets', () => {
  it('extracts normalized keys from wiki link syntax', () => {
    const md = 'See [[My Page]] and [[sub/Other|label]] here.'
    const keys = extractWikiTargets(md)
    expect(keys).toContain('my-page')
    expect(keys).toContain('sub/other')
    expect(keys).toHaveLength(2)
  })

  it('deduplicates repeated targets', () => {
    const md = '[[Page]] and [[Page]] again'
    expect(extractWikiTargets(md)).toHaveLength(1)
  })

  it('returns empty for text without wiki links', () => {
    expect(extractWikiTargets('just plain text')).toHaveLength(0)
  })

  it('skips invalid targets that normalize to empty', () => {
    expect(extractWikiTargets('[[]]')).toHaveLength(0)
    expect(extractWikiTargets('[[  ]]')).toHaveLength(0)
  })
})

describe('watcher integration', () => {
  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
  })

  it('adds a new file to the cache on watcher create event', async () => {
    mountFs({ '/ws/wiki': [['A.md', F]] })
    const onChange = vi.fn()
    const cache = await WikiCache.build(Uri.file('/ws/wiki'), onChange)

    expect(cache.has('a')).toBe(true)
    expect(cache.has('new-page')).toBe(false)

    const watcher = mock.calls.fileSystemWatchers[0]
    watcher._fireCreate(Uri.file('/ws/wiki/New Page.md'))

    expect(cache.has('new-page')).toBe(true)
    expect(cache.resolve('new-page')[0].fsPath).toBe('/ws/wiki/New Page.md')

    // onChange is debounced — wait for it
    await new Promise((r) => setTimeout(r, 80))
    expect(onChange).toHaveBeenCalled()
    cache.dispose()
  })

  it('notifies EVERY consumer of the shared singleton, not just the first (185/3h)', async () => {
    mountFs({ '/ws/wiki': [['A.md', F]] })
    const first = vi.fn()
    const second = vi.fn()
    const root = Uri.file('/ws/wiki')
    const cache = await getOrBuildCache(root, first)
    // A second editor on the same wiki root gets the SAME cache — its onChange
    // used to be silently dropped.
    const same = await getOrBuildCache(root, second)
    expect(same).toBe(cache)

    const watcher = mock.calls.fileSystemWatchers[0]
    watcher._fireCreate(Uri.file('/ws/wiki/New Page.md'))
    await new Promise((r) => setTimeout(r, 80)) // debounce
    expect(first).toHaveBeenCalled()
    expect(second).toHaveBeenCalled()

    // unsubscribing one listener must not silence the other
    const third = vi.fn()
    const un = cache.addChangeListener(third)
    un()
    watcher._fireCreate(Uri.file('/ws/wiki/Another.md'))
    await new Promise((r) => setTimeout(r, 80))
    expect(third).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(2)
    cache.dispose()
  })

  it('removes a file from the cache on watcher delete event', async () => {
    mountFs({
      '/ws/wiki': [
        ['A.md', F],
        ['B.md', F],
      ],
    })
    const cache = await WikiCache.build(Uri.file('/ws/wiki'))
    expect(cache.has('a')).toBe(true)

    const watcher = mock.calls.fileSystemWatchers[0]
    watcher._fireDelete(Uri.file('/ws/wiki/A.md'))

    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(true)
    cache.dispose()
  })
})

// Task 636 — the cache scan is one workspace search, honours the exclude settings, and a build
// that was invalidated while it ran must not become the stored cache.
// Task 637 — the watcher must agree with the page search: it adds no key for a file the search
// excludes (node_modules, files.exclude) and its pattern covers the extension spellings the search
// accepts.
describe('watcher agrees with the page search (task 637)', () => {
  const debounce = () => new Promise((resolve) => setTimeout(resolve, 150))

  // Test-local glob matcher: `**/`, `*`, `{a,b}` alternation and `[mM]` classes.
  function globMatches(glob: string, relativePath: string): boolean {
    const tokens: Array<[string, string]> = [
      ['**/', '(?:.*/)?'],
      ['*', '[^/]*'],
      ['{', '(?:'],
      ['}', ')'],
      [',', '|'],
      ['[', '['],
      [']', ']'],
    ]
    let source = ''
    for (let rest = glob; rest; ) {
      const token = tokens.find(([glyph]) => rest.startsWith(glyph))
      source += token ? token[1] : rest[0].replace(/[.+^$()|\\?]/g, '\\$&')
      rest = rest.slice(token ? token[0].length : 1)
    }
    return new RegExp(`^${source}$`).test(relativePath)
  }

  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
    mock.setWorkspaceFolder('/ws')
    mountFs({ '/ws/wiki': [['Home.md', F]] })
  })

  it('a created page is indexed (control)', async () => {
    const cache = await WikiCache.build(Uri.file('/ws/wiki'))
    mock.calls.fileSystemWatchers[0]._fireCreate(Uri.file('/ws/wiki/Fresh.md'))
    expect(cache.has('fresh')).toBe(true)
    cache.dispose()
  })

  it('a created file under node_modules adds no key', async () => {
    const cache = await WikiCache.build(Uri.file('/ws/wiki'))
    const watcher = mock.calls.fileSystemWatchers[0]
    watcher._fireCreate(Uri.file('/ws/wiki/node_modules/pkg/Readme.md'))
    watcher._fireCreate(Uri.file('/ws/wiki/Kept.md'))
    await debounce()
    expect(cache.has('readme')).toBe(false)
    expect(cache.has('pkg/readme')).toBe(false)
    expect(cache.has('kept')).toBe(true)
    cache.dispose()
  })

  it('a created file under a files.exclude glob adds no key', async () => {
    mock.setConfig({ exclude: { '**/drafts/**': true } })
    const cache = await WikiCache.build(Uri.file('/ws/wiki'))
    const watcher = mock.calls.fileSystemWatchers[0]
    watcher._fireCreate(Uri.file('/ws/wiki/drafts/Secret.md'))
    watcher._fireCreate(Uri.file('/ws/wiki/Kept.md'))
    await debounce()
    expect(cache.has('secret')).toBe(false)
    expect(cache.has('kept')).toBe(true)
    cache.dispose()
  })

  it('an invalid files.exclude glob matches nothing, a valid one still excludes, and the watcher does not throw', async () => {
    mock.setConfig({ exclude: { '{a,b': true, '**/drafts/**': true } })
    const cache = await WikiCache.build(Uri.file('/ws/wiki'))
    const watcher = mock.calls.fileSystemWatchers[0]
    expect(() => {
      watcher._fireCreate(Uri.file('/ws/wiki/drafts/Secret.md'))
      watcher._fireCreate(Uri.file('/ws/wiki/Kept.md'))
    }).not.toThrow()
    await debounce()
    expect(cache.has('secret')).toBe(false)
    expect(cache.has('kept')).toBe(true)
    cache.dispose()
  })

  it('the watcher pattern covers an upper-case extension', async () => {
    const cache = await WikiCache.build(Uri.file('/ws/wiki'))
    const calls = vi.mocked(vscode.workspace.createFileSystemWatcher).mock.calls
    const pattern = calls[calls.length - 1][0] as { pattern: string }
    expect(globMatches(pattern.pattern, 'Page.md')).toBe(true)
    expect(globMatches(pattern.pattern, 'sub/Notes.markdown')).toBe(true)
    expect(globMatches(pattern.pattern, 'Page.MD')).toBe(true)
    expect(globMatches(pattern.pattern, 'sub/Notes.Markdown')).toBe(true)
    expect(globMatches(pattern.pattern, 'Page.txt')).toBe(false)
    cache.dispose()
  })
})

describe('wiki scan through workspace.findFiles (task 636)', () => {
  const root = () => Uri.file('/ws/wiki')

  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
  })

  function countDirectoryReads() {
    const reads = { count: 0 }
    mock.setReadDirectory(async () => {
      reads.count++
      return []
    })
    return reads
  }

  it('builds the cache with one search under the root for Markdown files and reads no directory', async () => {
    const reads = countDirectoryReads()
    mock.setWorkspaceFiles([
      '/ws/wiki/Home.md',
      '/ws/wiki/sub/Deep Page.markdown',
      '/ws/wiki/notes.txt',
      '/ws/other/Elsewhere.md',
    ])
    const cache = await WikiCache.build(root())

    expect(mock.calls.findFiles).toHaveLength(1)
    const { include } = mock.calls.findFiles[0]
    const base = (include as { base: { fsPath?: string } | string }).base
    expect(typeof base === 'string' ? base : base.fsPath).toBe('/ws/wiki')
    const pattern = (include as { pattern: string }).pattern
    expect(pattern).toContain('md')
    expect(pattern).toContain('markdown')
    expect(reads.count).toBe(0)
    expect(cache.allPageKeys()).toEqual(
      expect.arrayContaining(['home', 'deep-page', 'sub/deep-page']),
    )
    expect(cache.has('elsewhere')).toBe(false)
    expect(cache.has('notes')).toBe(false)
    cache.dispose()
  })

  it('keeps pages whose extension is upper- or mixed-case, as the old directory walk did', async () => {
    countDirectoryReads()
    mock.setWorkspaceFiles([
      '/ws/wiki/Page.MD',
      '/ws/wiki/sub/Notes.Markdown',
      '/ws/wiki/plain.md',
      '/ws/wiki/Skipped.TXT',
    ])
    const cache = await WikiCache.build(root())

    expect(cache.has('page')).toBe(true)
    expect(cache.has('notes')).toBe(true)
    expect(cache.has('sub/notes')).toBe(true)
    expect(cache.has('plain')).toBe(true)
    expect(cache.has('skipped')).toBe(false)
    cache.dispose()
  })

  it('skips node_modules and files.exclude matches but keeps ordinary pages', async () => {
    countDirectoryReads()
    mock.setConfig({ exclude: { '**/private/**': true } })
    mock.setWorkspaceFiles([
      '/ws/wiki/Ordinary.md',
      '/ws/wiki/docs/Guide.md',
      '/ws/wiki/node_modules/pkg/Readme.md',
      '/ws/wiki/private/Secret.md',
    ])
    const cache = await WikiCache.build(root())

    expect(cache.has('ordinary')).toBe(true)
    expect(cache.has('guide')).toBe(true)
    // A page under node_modules is not a wiki page.
    expect(cache.has('readme')).toBe(false)
    expect(cache.has('node-modules/pkg/readme')).toBe(false)
    // A page matching a files.exclude glob is not a wiki page.
    expect(cache.has('secret')).toBe(false)
    cache.dispose()
  })

  it('does not store a build that was invalidated while it ran', async () => {
    const scans = { count: 0 }
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mock.setReadDirectory(async () => {
      scans.count++
      await gate
      return []
    })
    mock.setFindFiles(async () => {
      scans.count++
      await gate
      return [Uri.file('/ws/wiki/Home.md')]
    })

    const first = getOrBuildCache(root())
    invalidateCache(root())
    release()
    await first
    const scansAfterFirst = scans.count
    expect(scansAfterFirst).toBeGreaterThan(0)

    const second = await getOrBuildCache(root())
    // The invalidated build is not the stored cache, so asking again scans again.
    expect(scans.count).toBeGreaterThan(scansAfterFirst)
    second.dispose()
  })
  it('a waiter on a build invalidated mid-scan follows the replacement build, not a disposed empty cache', async () => {
    let scans = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mock.setFindFiles(async () => {
      scans++
      // Only the first (invalidated) scan is held; the replacement scan finishes at once.
      if (scans === 1) await gate
      return [Uri.file('/ws/wiki/Home.md')]
    })

    const waiter = getOrBuildCache(root())
    invalidateCache(root())
    const replacement = getOrBuildCache(root())
    release()
    const [waited, rebuilt] = await Promise.all([waiter, replacement])

    expect(waited).toBe(rebuilt)
    expect(waited.has('home')).toBe(true)
    expect(await getOrBuildCache(root())).toBe(rebuilt)
    expect(scans).toBe(2)
    rebuilt.dispose()
  })

  it('a waiter on a build invalidated before any replacement still gets the pages, and nothing is stored', async () => {
    let scans = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mock.setFindFiles(async () => {
      scans++
      if (scans === 1) await gate
      return [Uri.file('/ws/wiki/Home.md')]
    })

    const waiter = getOrBuildCache(root())
    invalidateCache(root())
    release()
    const waited = await waiter

    expect(waited.has('home')).toBe(true)
    const next = await getOrBuildCache(root())
    expect(next).not.toBe(waited)
    expect(scans).toBe(3)
    next.dispose()
  })

  describe('files.exclude against a wiki root below the workspace folder', () => {
    const PAGES = [
      '/ws/docs/Keep.md',
      '/ws/docs/drafts/Draft.md',
      '/ws/docs/sub/tmp/Scratch.md',
    ]

    async function pageKeysUnder(rootPath: string, exclude: object) {
      mock.setWorkspaceFolder('/ws')
      mock.setConfig({ exclude })
      mock.setWorkspaceFiles([...PAGES, '/ws/drafts/Outside.md'])
      const cache = await WikiCache.build(Uri.file(rootPath))
      const keys = cache.allPageKeys()
      cache.dispose()
      return keys
    }

    it('root = workspace folder: keys apply as written', async () => {
      const keys = await pageKeysUnder('/ws', { 'docs/drafts/**': true })
      expect(keys).toContain('keep')
      expect(keys).not.toContain('draft')
      expect(keys).toContain('outside')
    })

    it('root = docs: a key written from the workspace folder excludes inside the root', async () => {
      const keys = await pageKeysUnder('/ws/docs', { 'docs/drafts/**': true })
      expect(keys).toContain('keep')
      expect(keys).not.toContain('draft')
    })

    it('root = docs: a key naming a folder outside the root does not exclude a same-named folder inside it', async () => {
      const keys = await pageKeysUnder('/ws/docs', { 'drafts/**': true })
      expect(keys).toContain('draft')
    })

    it('root = docs: a **/ key still excludes at any depth', async () => {
      const keys = await pageKeysUnder('/ws/docs', { '**/tmp/**': true })
      expect(keys).toContain('keep')
      expect(keys).not.toContain('scratch')
    })
  })
})
